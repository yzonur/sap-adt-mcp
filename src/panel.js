import http from "node:http";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Local, read-only HTTP control panel.
//
// It lives INSIDE the MCP process and reuses the exact same tool handlers the
// MCP exposes. That gives the "only works while the session is open" property
// for free: Claude spawns this process when it connects the MCP and kills it
// when the session ends, taking the HTTP listener down with it. Nothing else
// keeps it alive.
//
// Safety: bound to 127.0.0.1, gated by a per-boot random token, and — most
// importantly — the allowlist below contains ONLY read-only tools. A button
// can never write to SAP because no write tool is reachable from here.
// ---------------------------------------------------------------------------

// Curated read-only set. `name` must match a registered tool; the input form
// for each is rendered from that tool's real inputSchema, so it stays in sync.
const PANEL_TOOLS = [
  { name: "adt_list_systems", label: "Sistemleri Listele", cat: "Bağlantı" },
  { name: "adt_ping", label: "Ping / Bağlantı Testi", cat: "Bağlantı" },
  { name: "adt_search_objects", label: "Obje Ara (isim)", cat: "Keşif" },
  { name: "adt_grep_source", label: "Kaynak İçinde Ara (grep)", cat: "Keşif" },
  { name: "adt_browse_package", label: "Paket İçeriği", cat: "Keşif" },
  { name: "adt_where_used", label: "Nerede Kullanılıyor", cat: "Keşif" },
  { name: "adt_get_source", label: "Kaynak Kodu Getir", cat: "Kaynak" },
  { name: "adt_read_table", label: "Tablo Oku (SELECT)", cat: "Veri" },
  { name: "adt_run_atc", label: "ATC Çalıştır", cat: "Kalite" },
  { name: "adt_list_inactive_objects", label: "Aktif Olmayan Objeler", cat: "Yaşam döngüsü" }, // prettier-ignore
  { name: "adt_list_transports", label: "Transport'ları Listele", cat: "Transport" },
  { name: "adt_list_dumps", label: "Dump'ları Listele (ST22)", cat: "Runtime" },
  { name: "adt_get_dump", label: "Dump Detayı", cat: "Runtime" },
];

// --- Friendly form layer (panel-only) ---------------------------------------
// The MCP inputSchemas are written for an agent: terse keys, ADT type codes,
// regex. The panel re-presents them for a human. None of this touches the
// agent-facing schemas — it's an overlay shipped in /meta and consumed by the
// page. Per field: { label, help, advanced (collapse), default, placeholder,
// options:[{value,label}] (renders a dropdown) }. Object-type dropdowns use the
// tools' own friendly aliases (normalizeType accepts them), so they stay correct.
const OBJECT_TYPE_OPTIONS = [
  { value: "", label: "(seçiniz)" },
  { value: "class", label: "Sınıf (CLAS)" },
  { value: "program", label: "Program (PROG)" },
  { value: "interface", label: "Arayüz (INTF)" },
  { value: "function", label: "Fonksiyon modülü (FUGR/FF)" },
  { value: "functiongroup", label: "Fonksiyon grubu (FUGR)" },
  { value: "include", label: "Include (INCL)" },
  { value: "table", label: "Tablo (TABL)" },
  { value: "structure", label: "Yapı / Structure (TABL)" },
  { value: "dataelement", label: "Veri elemanı (DTEL)" },
  { value: "domain", label: "Domain (DOMA)" },
  { value: "cds", label: "CDS View (DDLS)" },
];

// objectType filter on quick-search wants the ADT node-type code, not an alias.
const SEARCH_TYPE_OPTIONS = [
  { value: "", label: "Tümü" },
  { value: "CLAS/OC", label: "Sınıf" },
  { value: "PROG/P", label: "Program" },
  { value: "INTF/OI", label: "Arayüz" },
  { value: "FUGR/F", label: "Fonksiyon grubu" },
  { value: "TABL/DT", label: "Tablo" },
  { value: "DTEL/DE", label: "Veri elemanı" },
  { value: "DOMA/DD", label: "Domain" },
  { value: "DDLS/DF", label: "CDS View" },
];

const CLASS_INCLUDE_OPTIONS = [
  { value: "", label: "main (varsayılan)" },
  { value: "definitions", label: "definitions" },
  { value: "implementations", label: "implementations" },
  { value: "macros", label: "macros" },
  { value: "testclasses", label: "testclasses" },
];

// intro: a friendly, non-technical one-liner per tool (replaces the agent-facing
// description on the card). fields: per-field overlay.
const TOOL_HINTS = {
  adt_list_systems: { intro: "Tanımlı SAP sistemlerini ve varsayılanı gösterir." },
  adt_ping: { intro: "Seçili sisteme bağlantıyı ve oturumu test eder." },
  adt_search_objects: {
    intro: "Repository'de isme göre obje arar. İsmin bir kısmını ve '*' joker karakterini kullanın.",
    fields: {
      query: { label: "Aranacak isim", placeholder: "örn: ZCL_MUSTERI*", help: "'*' joker karakter olarak kullanılabilir." },
      objectType: { label: "Obje türü", options: SEARCH_TYPE_OPTIONS, help: "Belirli bir türle sınırla; boş = tümü." },
      maxResults: { label: "Kaç sonuç", default: 50, advanced: true },
    },
  },
  adt_grep_source: {
    intro: "Kaynak kod İÇİNDE metin arar (isimde değil). Bir paket, transport ya da obje listesi seçin.",
    fields: {
      pattern: { label: "Aranan metin", placeholder: "örn: CALL FUNCTION", help: "Düz metin yazın; ileri düzey için regex (Gelişmiş)." },
      package: { label: "Paket", placeholder: "örn: ZFLEET" },
      transport: { label: "Transport", advanced: true, placeholder: "örn: E4DK900123" },
      objects: { label: "Obje listesi (JSON)", advanced: true },
      recursive: { label: "Alt paketlere de in", advanced: true },
      flags: { label: "Regex flag'leri", advanced: true, help: "Boş = harf duyarsız ('i'). '' yazıp kapatamazsınız; teknik." },
      prefix: { label: "Alt paket öneki", advanced: true },
      maxPackages: { label: "Maks. paket", advanced: true },
      maxObjects: { label: "Maks. obje", advanced: true },
      maxMatches: { label: "Maks. eşleşme", advanced: true },
    },
  },
  adt_browse_package: {
    intro: "Bir paketin doğrudan içeriğini (tek seviye) listeler.",
    fields: { package: { label: "Paket", placeholder: "örn: ZLOCAL" } },
  },
  adt_where_used: {
    intro: "Bir objenin nerelerde kullanıldığını listeler.",
    fields: {
      object: { label: "Obje adı", placeholder: "örn: ZCL_MUSTERI" },
      type: { label: "Obje türü", options: OBJECT_TYPE_OPTIONS },
      group: { label: "Fonksiyon grubu", advanced: true, help: "Sadece FM/FUGR include için." },
    },
  },
  adt_get_source: {
    intro: "Bir objenin kaynak kodunu getirir.",
    fields: {
      object: { label: "Obje adı", placeholder: "örn: ZCL_MUSTERI" },
      type: { label: "Obje türü", options: OBJECT_TYPE_OPTIONS },
      include: { label: "Sınıf include'u", options: CLASS_INCLUDE_OPTIONS, advanced: true },
      group: { label: "Fonksiyon grubu", advanced: true },
      onlyMethod: { label: "Sadece bu metod", advanced: true, placeholder: "örn: CONSTRUCTOR" },
      firstLine: { label: "İlk satır", advanced: true },
      lastLine: { label: "Son satır", advanced: true },
    },
  },
  adt_read_table: {
    intro: "Veritabanına salt-okunur SELECT çalıştırır (sadece SELECT).",
    fields: {
      query: { label: "SELECT sorgusu", placeholder: "SELECT matnr, matkl FROM mara WHERE matnr LIKE 'M%'" },
      maxRows: { label: "Maks. satır", default: 100, advanced: true },
    },
  },
  adt_run_atc: {
    intro: "Seçili objelerde ABAP Test Cockpit (ATC) kontrolü çalıştırır.",
    fields: {
      objects: { label: "Objeler (JSON liste)", placeholder: '[{"name":"ZCL_X","type":"class"}]', help: 'Her öğe { "name": "...", "type": "..." }.' },
      checkVariant: { label: "Kontrol varyantı", advanced: true, help: "Boş = DEFAULT." },
    },
  },
  adt_list_inactive_objects: {
    intro: "Düzenlenmiş ama henüz aktive edilmemiş objeleri listeler.",
  },
  adt_list_transports: {
    intro: "Görünür transport isteklerini listeler.",
    fields: {
      user: { label: "Kullanıcı (sahibi)", placeholder: "boş = bağlantı kullanıcısı" },
      status: {
        label: "Durum",
        options: [
          { value: "", label: "Değiştirilebilir (varsayılan)" },
          { value: "modifiable", label: "Değiştirilebilir" },
          { value: "released", label: "Serbest bırakılmış" },
          { value: "all", label: "Tümü" },
        ],
      },
      targets: { label: "Hedef sistemler", advanced: true },
    },
  },
  adt_list_dumps: {
    intro: "ST22 kısa dökümlerini (short dumps) listeler.",
    fields: {
      user: { label: "Kullanıcı", placeholder: "örn: OYILMAZ" },
      from: { label: "Başlangıç tarihi", placeholder: "YYYYMMDD, örn: 20260513" },
      to: { label: "Bitiş tarihi", placeholder: "YYYYMMDD", advanced: true },
      host: { label: "Sunucu (host)", advanced: true },
      maxResults: { label: "Kaç sonuç", default: 20, advanced: true },
    },
  },
  adt_get_dump: {
    intro: "Tek bir kısa dökümün detayını id ile getirir.",
    fields: {
      dumpId: { label: "Dump id", help: "adt_list_dumps çıktısındaki id." },
      chapters: { label: "Bölümler (JSON liste)", advanced: true },
      full: { label: "Ham metni de ekle", advanced: true, help: "Büyük (100KB+)." },
    },
  },
};

// Turkish column/field labels for the result tables. Unknowns are humanized.
const COLUMN_LABELS = {
  name: "İsim",
  type: "Tür",
  description: "Açıklama",
  object: "Obje",
  line: "Satır",
  text: "Metin",
  uri: "URI",
  package: "Paket",
  host: "Host",
  user: "Kullanıcı",
  client: "Mandant",
  readOnly: "Salt-okunur",
  isDefault: "Varsayılan",
  priority: "Öncelik",
  checkTitle: "Kontrol",
  messageTitle: "Mesaj",
  message: "Mesaj",
  timestamp: "Zaman",
  program: "Program",
  runtimeError: "Hata",
  id: "Id",
  hits: "Eşleşme",
  status: "Durum",
};

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Reject anything whose Host header isn't loopback — cheap DNS-rebinding guard.
function hostIsLoopback(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Flatten an MCP tool result ({ content:[{text}], isError }) to { text, isError }.
function flattenResult(out) {
  const text = (out?.content ?? [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, isError: Boolean(out?.isError) };
}

// Build the static "view" (allowlist + descriptors + meta + html) from the live
// registry. Done once; the token is per-listen, not part of the view.
function buildView({ tools, handlers, config, version }) {
  const allow = new Map(PANEL_TOOLS.map((t) => [t.name, t]));
  const descriptors = [];
  for (const item of PANEL_TOOLS) {
    const def = tools.find((t) => t.name === item.name);
    if (!def || typeof handlers[item.name] !== "function") continue; // tool not present
    const hint = TOOL_HINTS[item.name] ?? {};
    descriptors.push({
      name: def.name,
      label: item.label,
      cat: item.cat,
      description: def.description ?? "",
      intro: hint.intro ?? null,
      fields: hint.fields ?? {},
      schema: def.inputSchema ?? { type: "object", properties: {}, required: [] },
    });
  }
  const meta = {
    version,
    systems: Object.keys(config.systems),
    defaultSystem: config.defaultSystem ?? null,
    readOnly: Boolean(config.readOnly),
    tools: descriptors,
    columnLabels: COLUMN_LABELS,
  };
  return { allow, meta, html: renderHtml() };
}

function makeServer({ allow, meta, html, handlers, token }) {
  return http.createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");

      // The page itself is harmless without the token (every data call needs it),
      // so serve it on GET / regardless. The JS reads the token from its own URL.
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Everything below requires the token.
      const supplied =
        req.headers["x-panel-token"] || url.searchParams.get("t") || "";
      if (!timingSafeEqualStr(supplied, token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad or missing token" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/meta") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(meta));
        return;
      }

      if (req.method === "POST" && url.pathname === "/call") {
        const body = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        const name = payload?.name;
        const args = payload?.args ?? {};
        if (!allow.has(name) || typeof handlers[name] !== "function") {
          // Hard wall: only curated read-only tools are reachable.
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `tool not allowed: ${name}` }));
          return;
        }
        try {
          const out = await handlers[name](args);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(flattenResult(out)));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ text: `Error: ${err.message}`, isError: true })
          );
        }
        return;
      }

      res.writeHead(404).end("not found");
    } catch (err) {
      try {
        res.writeHead(500).end(String(err?.message ?? err));
      } catch {
        /* response already sent */
      }
    }
  });
}

// --- Singleton lifecycle -----------------------------------------------------
// The panel is a process-wide singleton: server.js wires the live registry in
// once via configurePanel(), and the adt_open_panel / adt_close_panel tools (or
// boot auto-start) flip it on and off. Only one listener ever exists.
let configured = null; // { handlers, config, log, view }
let running = null; // { server, token, url }

export function configurePanel({ tools, handlers, config, version, log }) {
  configured = {
    handlers,
    config,
    log: typeof log === "function" ? log : () => {},
    view: buildView({ tools, handlers, config, version }),
  };
}

export function isPanelConfigured() {
  return Boolean(configured);
}

export function isPanelRunning() {
  return Boolean(running);
}

export function getPanelUrl() {
  return running?.url ?? null;
}

// Start the listener if it isn't already up. Resolves with the tokenized URL.
export function ensurePanelStarted() {
  if (!configured) {
    return Promise.reject(new Error("panel not configured"));
  }
  if (running) {
    return Promise.resolve({ url: running.url, alreadyRunning: true });
  }
  const { handlers, config, log, view } = configured;
  const token = crypto.randomBytes(24).toString("hex");
  const server = makeServer({ ...view, handlers, token });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      log(`error: ${err.message}`, true);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      server.on("error", (err) => log(`error: ${err.message}`, true));
      server.on("close", () => {
        if (running?.server === server) running = null;
      });
      const { port } = server.address();
      const url = `http://${config.panel.host}:${port}/?t=${token}`;
      running = { server, token, url };
      log(`ready (read-only) → ${url}`);
      resolve({ url, alreadyRunning: false });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.panel.port, config.panel.host);
  });
}

// Stop the listener. Returns the URL that was being served, or null if it wasn't up.
export function stopPanel() {
  if (!running) return null;
  const { server, url } = running;
  running = null;
  server.close();
  return url;
}

// Convenience used by boot auto-start and tests: configure + start in one call.
// Returns { server, getUrl } once listening (test-friendly shape preserved).
export function startPanel(opts) {
  configurePanel(opts);
  const { handlers, config, view } = configured;
  const token = crypto.randomBytes(24).toString("hex");
  const server = makeServer({ ...view, handlers, token });
  server.on("error", (err) => configured.log(`error: ${err.message}`, true));
  server.on("close", () => {
    if (running?.server === server) running = null;
  });
  server.listen(config.panel.port, config.panel.host, () => {
    const { port } = server.address();
    const url = `http://${config.panel.host}:${port}/?t=${token}`;
    running = { server, token, url };
    configured.log(`ready (read-only) → ${url}`);
  });
  return {
    server,
    getUrl: () => {
      const addr = server.address();
      return addr
        ? `http://${config.panel.host}:${addr.port}/?t=${token}`
        : null;
    },
  };
}

// --- The served page (single self-contained document) -----------------------
function renderHtml() {
  // Token comes from this page's own ?t=… ; meta + forms are fetched at load.
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SAP ADT — Kontrol Paneli</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f1116; color:#e6e8ee; }
  header { padding:14px 20px; border-bottom:1px solid #222633; display:flex; gap:14px;
    align-items:center; position:sticky; top:0; background:#0f1116; z-index:5; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; background:#1b2030; color:#9aa3b8; }
  .pill.ro { background:#13361f; color:#5fd38a; }
  .pill.warn { background:#3a2417; color:#e0a06a; }
  label.sysrow { margin-left:auto; font-size:12px; color:#9aa3b8; display:flex; gap:6px; align-items:center; }
  select, input, textarea { background:#161a24; color:#e6e8ee; border:1px solid #2a3142;
    border-radius:6px; padding:6px 8px; font:inherit; }
  textarea { width:100%; min-height:54px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  main { padding:18px 20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .card { background:#141822; border:1px solid #232838; border-radius:10px; padding:14px; }
  .card h3 { margin:0 0 2px; font-size:14px; }
  .cat { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#717a90; }
  .desc { color:#8b93a7; font-size:11px; margin:4px 0 10px; max-height:48px; overflow:auto; }
  .field { margin-bottom:8px; }
  .field label { display:block; font-size:11px; color:#9aa3b8; margin-bottom:3px; }
  .field label .req { color:#e0716a; }
  .field input, .field textarea { width:100%; }
  button.run { background:#2f6df6; color:#fff; border:none; border-radius:7px; padding:8px 14px;
    font:inherit; font-weight:600; cursor:pointer; }
  button.run:hover { background:#4079f8; }
  button.run:disabled { opacity:.5; cursor:default; }
  pre.out { margin:10px 0 0; background:#0b0d13; border:1px solid #202635;
    border-radius:7px; padding:10px; max-height:340px; overflow:auto; white-space:pre-wrap;
    word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }
  pre.out.err { border-color:#5a2a2a; color:#f0a3a3; }
  pre.out:empty { display:none; }
  .muted { color:#717a90; }
  #boot { padding:40px 20px; color:#8b93a7; }
  /* friendly form */
  .field .help { display:block; color:#717a90; font-size:10.5px; margin-top:3px; }
  details.adv { margin:4px 0 8px; border-top:1px dashed #2a3142; padding-top:6px; }
  details.adv > summary { cursor:pointer; color:#8b93a7; font-size:11px; list-style:none; user-select:none; }
  details.adv > summary::before { content:"▸ "; }
  details.adv[open] > summary::before { content:"▾ "; }
  /* rendered results */
  .res { margin-top:10px; }
  .res:empty { display:none; }
  .summary { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .chip { font-size:10.5px; padding:2px 8px; border-radius:999px; background:#1b2030; color:#aeb6c9; }
  .chip b { color:#e6e8ee; font-weight:600; }
  .chip.ok { background:#13361f; color:#5fd38a; }
  .chip.bad { background:#3a1d1d; color:#f0a3a3; }
  .errbox { background:#2a1414; border:1px solid #5a2a2a; border-radius:7px; padding:10px;
    color:#f0a3a3; font-size:12px; }
  .errbox .st { font-weight:600; color:#ffd0d0; }
  .blk { margin:8px 0; }
  .blk > .blktitle { font-size:11px; color:#9aa3b8; margin-bottom:4px; text-transform:uppercase; letter-spacing:.05em; }
  table.grid { width:100%; border-collapse:collapse; font-size:11.5px; display:block; overflow:auto; max-height:360px; }
  table.grid th, table.grid td { border:1px solid #232838; padding:4px 7px; text-align:left;
    vertical-align:top; white-space:pre-wrap; word-break:break-word; max-width:340px; }
  table.grid th { background:#171c28; color:#9aa3b8; position:sticky; top:0; font-weight:600; }
  table.grid tr:nth-child(even) td { background:#10131b; }
  .code { background:#0b0d13; border:1px solid #202635; border-radius:7px; padding:10px;
    max-height:340px; overflow:auto; white-space:pre-wrap; word-break:break-word;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:#cdd3e0; }
  .chapter { margin:8px 0; }
  .chapter > .chtitle { font-size:11.5px; color:#cda; font-weight:600; margin-bottom:3px; }
  details.raw { margin-top:10px; }
  details.raw > summary { cursor:pointer; color:#717a90; font-size:11px; }
  details.raw pre { margin:6px 0 0; background:#0b0d13; border:1px solid #202635; border-radius:7px;
    padding:10px; max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:#8b93a7; }
</style>
</head>
<body>
<header>
  <h1>SAP ADT — Kontrol Paneli</h1>
  <span class="pill ro">read-only</span>
  <span id="ver" class="pill"></span>
  <span id="globalro" class="pill warn" style="display:none">sistem global read-only</span>
  <label class="sysrow">Sistem:
    <select id="system"></select>
  </label>
</header>
<div id="boot">Yükleniyor… <span class="muted">(MCP process'i ile aynı ömürde — session kapanınca bu sayfa ölür)</span></div>
<main id="cards" style="display:none"></main>
<script>
const TOKEN = new URLSearchParams(location.search).get("t") || "";
const $ = (s,el=document)=>el.querySelector(s);

async function call(name, args){
  const r = await fetch("/call", {
    method:"POST",
    headers:{ "content-type":"application/json", "x-panel-token":TOKEN },
    body: JSON.stringify({ name, args })
  });
  if(!r.ok){ return { text:"HTTP "+r.status+" — "+(await r.text()), isError:true }; }
  return r.json();
}

let COLUMN_LABELS = {};
const CODE_KEYS = new Set(["source","result","raw","rawtext","metadataxml","runresponse","resultxml"]);

function humanize(k){
  return String(k).replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[_-]+/g," ")
    .replace(/^./,c=>c.toUpperCase());
}
function labelFor(k){ return COLUMN_LABELS[k] || humanize(k); }
function el(tag, cls, txt){ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
function short(v, n){ const s=String(v); return s.length>n ? s.slice(0,n)+"…" : s; }
function isPlainObject(v){ return v && typeof v==="object" && !Array.isArray(v); }

// ----- friendly form ---------------------------------------------------------
function fieldFor(key, prop, required, hint){
  hint=hint||{};
  const wrap=el("div","field");
  const lab=el("label",null,hint.label||key);
  if(required){ const s=el("span","req"," *"); lab.appendChild(s); }
  wrap.appendChild(lab);
  let input;
  const t=prop.type;
  const options = hint.options || (Array.isArray(prop.enum) ? prop.enum.map(v=>({value:v,label:v})) : null);
  if(options){
    input=document.createElement("select");
    if(!hint.options){ const b=el("option",null,"(varsayılan)"); b.value=""; input.appendChild(b); }
    for(const o of options){ const op=el("option",null,o.label); op.value=o.value; input.appendChild(op); }
  } else if(t==="boolean"){
    input=document.createElement("input"); input.type="checkbox"; input.style.width="auto";
  } else if(t==="integer"||t==="number"){
    input=document.createElement("input"); input.type="number";
    if(prop.minimum!=null) input.min=prop.minimum;
    if(prop.maximum!=null) input.max=prop.maximum;
  } else if(t==="array"||t==="object"){
    input=document.createElement("textarea");
    input.placeholder=hint.placeholder || ("JSON, örn: "+(t==="array"?'[{"name":"...","type":"..."}]':'{}'));
  } else {
    input=document.createElement("input"); input.type="text";
    if(hint.placeholder) input.placeholder=hint.placeholder;
  }
  input.dataset.key=key; input.dataset.jtype=t||"string";
  if(hint.default!=null){ if(input.type==="checkbox") input.checked=!!hint.default; else input.value=String(hint.default); }
  const tip=hint.help||prop.description; if(tip) input.title=tip;
  wrap.appendChild(input);
  if(hint.help){ wrap.appendChild(el("span","help",hint.help)); }
  return wrap;
}

function collect(card){
  const args={};
  for(const node of card.querySelectorAll("[data-key]")){
    const k=node.dataset.key, t=node.dataset.jtype;
    if(node.type==="checkbox"){ if(node.checked) args[k]=true; continue; }
    const raw=node.value.trim();
    if(raw==="") continue;
    if(t==="integer"){ args[k]=parseInt(raw,10); }
    else if(t==="number"){ args[k]=Number(raw); }
    else if(t==="array"||t==="object"){
      try { args[k]=JSON.parse(raw); } catch(e){ throw new Error((k)+": geçersiz JSON"); }
    }
    else args[k]=raw;
  }
  return args;
}

function buildCard(tool, getSystem){
  const card=el("section","card");
  card.appendChild(el("div","cat",tool.cat));
  card.appendChild(el("h3",null,tool.label));
  card.appendChild(el("div","desc",tool.intro||tool.description));

  const props=tool.schema.properties||{};
  const req=new Set(tool.schema.required||[]);
  const hints=tool.fields||{};
  const adv=el("details","adv"); adv.appendChild(el("summary",null,"Gelişmiş ayarlar"));
  let advCount=0;
  for(const key of Object.keys(props)){
    if(key==="system") continue; // global system selector handles it
    const hint=hints[key]||{};
    const f=fieldFor(key, props[key], req.has(key), hint);
    if(hint.advanced){ adv.appendChild(f); advCount++; } else card.appendChild(f);
  }
  if(advCount>0) card.appendChild(adv);

  const btn=el("button","run","Çalıştır"); card.appendChild(btn);
  const out=el("div","res"); card.appendChild(out);

  btn.addEventListener("click", async ()=>{
    let args;
    try { args=collect(card); } catch(e){ showError(out, e.message); return; }
    const sys=getSystem(); if(sys) args.system=sys;
    btn.disabled=true; const old=btn.textContent; btn.textContent="Çalışıyor…";
    out.textContent="";
    try {
      const res=await call(tool.name, args);
      renderResult(out, tool.name, res);
    } catch(e){ showError(out, String(e.message||e)); }
    finally { btn.disabled=false; btn.textContent=old; }
  });
  return card;
}

// ----- result rendering ------------------------------------------------------
function showError(out, msg){ out.innerHTML=""; const b=el("div","errbox"); b.appendChild(el("span","st","Hata")); b.appendChild(document.createTextNode(" — "+msg)); out.appendChild(b); }

function renderResult(out, tool, res){
  out.innerHTML="";
  const raw=(res&&res.text)||"";
  let data;
  try { data=JSON.parse(raw); }
  catch(e){ out.appendChild(el("div","code",raw||"(boş yanıt)")); return; }

  if((res&&res.isError) || (isPlainObject(data)&&data.ok===false)){
    renderErrorObject(out, data);
    appendRaw(out, data);
    return;
  }
  if(!isPlainObject(data)){ out.appendChild(el("div","code",raw)); return; }
  renderObject(out, data);
  appendRaw(out, data);
}

function renderErrorObject(out, data){
  const b=el("div","errbox");
  const err=data.error||{};
  const msg = err.message || err.localizedMessage || (typeof err==="string"?err:null)
    || err.raw || data.parseError || "İstek başarısız.";
  const st = data.status!=null ? ("HTTP "+data.status) : "Hata";
  b.appendChild(el("span","st",st));
  b.appendChild(document.createTextNode(" — "+short(msg, 1200)));
  out.appendChild(b);
}

function renderObject(out, data){
  const scalars=[], tables=[], scalarArrays=[], maps=[], codes=[];
  for(const [k,v] of Object.entries(data)){
    if(v==null) continue;
    const lk=k.toLowerCase();
    if(CODE_KEYS.has(lk) || (typeof v==="string" && (v.indexOf("\\n")>=0 || v.length>160))){ codes.push([k,v]); }
    else if(Array.isArray(v)){
      if(v.length && isPlainObject(v[0])) tables.push([k,v]);
      else if(v.length) scalarArrays.push([k,v]);
    }
    else if(isPlainObject(v)) maps.push([k,v]);
    else scalars.push([k,v]); // string/number/boolean
  }

  if(scalars.length){
    const s=el("div","summary");
    for(const [k,v] of scalars){
      const c=el("span","chip"+(typeof v==="boolean"?(v?" ok":" bad"):""));
      const b=el("b",null,labelFor(k)+": ");
      c.appendChild(b);
      c.appendChild(document.createTextNode(typeof v==="boolean"?(v?"evet":"hayır"):short(v,80)));
      s.appendChild(c);
    }
    out.appendChild(s);
  }

  for(const [k,arr] of tables){ out.appendChild(blockTitle(labelFor(k)+" ("+arr.length+")")); out.appendChild(makeTable(arr)); }

  for(const [k,arr] of scalarArrays){
    const blk=el("div","blk"); blk.appendChild(el("div","blktitle",labelFor(k)+" ("+arr.length+")"));
    blk.appendChild(el("div","code", arr.map(x=>String(x)).join(", "))); out.appendChild(blk);
  }

  for(const [k,obj] of maps){
    const vals=Object.values(obj);
    if(vals.length && vals.every(x=>typeof x==="string")){
      // chapter-style sections (e.g. dump chapters)
      const blk=el("div","blk"); blk.appendChild(el("div","blktitle",labelFor(k)));
      for(const [sk,sv] of Object.entries(obj)){
        const ch=el("div","chapter"); ch.appendChild(el("div","chtitle",labelFor(sk)));
        ch.appendChild(el("div","code",short(sv,8000))); blk.appendChild(ch);
      }
      out.appendChild(blk);
    } else if(vals.length && vals.every(x=>typeof x==="number")){
      // histogram (e.g. byPriority)
      const blk=el("div","blk"); blk.appendChild(el("div","blktitle",labelFor(k)));
      const s=el("div","summary");
      for(const [sk,sv] of Object.entries(obj)){ const c=el("span","chip"); c.appendChild(el("b",null,labelFor(sk)+": ")); c.appendChild(document.createTextNode(String(sv))); s.appendChild(c); }
      blk.appendChild(s); out.appendChild(blk);
    } else {
      const d=el("details","raw"); d.appendChild(el("summary",null,labelFor(k)));
      d.appendChild(el("pre",null,JSON.stringify(obj,null,2))); out.appendChild(d);
    }
  }

  for(const [k,v] of codes){
    const blk=el("div","blk"); blk.appendChild(el("div","blktitle",labelFor(k)));
    blk.appendChild(el("div","code",short(v,20000))); out.appendChild(blk);
  }

  if(!scalars.length && !tables.length && !scalarArrays.length && !maps.length && !codes.length){
    out.appendChild(el("div","code","(boş yanıt)"));
  }
}

function blockTitle(t){ return el("div","blktitle",t); }

function makeTable(rows){
  const cols=[]; const seen=new Set();
  for(const r of rows){ for(const k of Object.keys(r)){ if(!seen.has(k)){ seen.add(k); cols.push(k); } } }
  const table=el("table","grid");
  const thead=document.createElement("thead"); const htr=document.createElement("tr");
  for(const c of cols) htr.appendChild(el("th",null,labelFor(c)));
  thead.appendChild(htr); table.appendChild(thead);
  const tbody=document.createElement("tbody");
  for(const r of rows){
    const tr=document.createElement("tr");
    for(const c of cols){
      const v=r[c];
      const cell = v==null ? "" : (typeof v==="object" ? JSON.stringify(v) : String(v));
      tr.appendChild(el("td",null,short(cell,300)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function appendRaw(out, data){
  const d=el("details","raw"); d.appendChild(el("summary",null,"Ham JSON"));
  d.appendChild(el("pre",null,JSON.stringify(data,null,2)));
  out.appendChild(d);
}

(async function init(){
  let meta;
  try {
    const r=await fetch("/meta",{headers:{"x-panel-token":TOKEN}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    meta=await r.json();
  } catch(e){
    $("#boot").textContent="Panel'e bağlanılamadı: "+e.message+" — token geçersiz ya da session kapandı.";
    return;
  }
  COLUMN_LABELS = meta.columnLabels || {};
  $("#ver").textContent="v"+meta.version;
  if(meta.readOnly) $("#globalro").style.display="";
  const sel=$("#system");
  for(const s of meta.systems){ const o=el("option",null,s); o.value=s; sel.appendChild(o); }
  if(meta.defaultSystem) sel.value=meta.defaultSystem;
  const getSystem=()=>sel.value||"";

  const cards=$("#cards");
  for(const tool of meta.tools){ cards.appendChild(buildCard(tool, getSystem)); }
  $("#boot").style.display="none";
  cards.style.display="";
})();
</script>
</body>
</html>`;
}
