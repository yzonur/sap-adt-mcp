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
    descriptors.push({
      name: def.name,
      label: item.label,
      cat: item.cat,
      description: def.description ?? "",
      schema: def.inputSchema ?? { type: "object", properties: {}, required: [] },
    });
  }
  const meta = {
    version,
    systems: Object.keys(config.systems),
    defaultSystem: config.defaultSystem ?? null,
    readOnly: Boolean(config.readOnly),
    tools: descriptors,
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

function fieldFor(key, prop, required){
  const wrap = document.createElement("div"); wrap.className="field";
  const lab = document.createElement("label");
  lab.innerHTML = key + (required?' <span class="req">*</span>':'') ;
  if(prop.description){ lab.title = prop.description; }
  wrap.appendChild(lab);
  let input;
  const t = prop.type;
  if(t==="boolean"){
    input=document.createElement("input"); input.type="checkbox";
    input.style.width="auto";
  } else if(t==="integer"||t==="number"){
    input=document.createElement("input"); input.type="number";
    if(prop.minimum!=null) input.min=prop.minimum;
    if(prop.maximum!=null) input.max=prop.maximum;
  } else if(t==="array"||t==="object"){
    input=document.createElement("textarea");
    input.placeholder="JSON, örn: "+(t==="array"?'[{"name":"...","type":"..."}]':'{}');
  } else if(Array.isArray(prop.enum)){
    input=document.createElement("select");
    const blank=document.createElement("option"); blank.value=""; blank.textContent="(varsayılan)";
    input.appendChild(blank);
    for(const v of prop.enum){ const o=document.createElement("option"); o.value=v; o.textContent=v; input.appendChild(o); }
  } else {
    input=document.createElement("input"); input.type="text";
  }
  input.dataset.key=key; input.dataset.jtype=t||"string";
  if(prop.description) input.title=prop.description;
  wrap.appendChild(input);
  return wrap;
}

function collect(card){
  const args={};
  for(const el of card.querySelectorAll("[data-key]")){
    const k=el.dataset.key, t=el.dataset.jtype;
    if(el.type==="checkbox"){ if(el.checked) args[k]=true; continue; }
    const raw=el.value.trim();
    if(raw==="") continue;
    if(t==="integer"){ args[k]=parseInt(raw,10); }
    else if(t==="number"){ args[k]=Number(raw); }
    else if(t==="array"||t==="object"){
      try { args[k]=JSON.parse(raw); } catch(e){ throw new Error(k+": geçersiz JSON"); }
    }
    else args[k]=raw;
  }
  return args;
}

function buildCard(tool, getSystem){
  const card=document.createElement("section"); card.className="card";
  const cat=document.createElement("div"); cat.className="cat"; cat.textContent=tool.cat; card.appendChild(cat);
  const h=document.createElement("h3"); h.textContent=tool.label; card.appendChild(h);
  const d=document.createElement("div"); d.className="desc"; d.textContent=tool.description; card.appendChild(d);

  const props=tool.schema.properties||{};
  const req=new Set(tool.schema.required||[]);
  for(const key of Object.keys(props)){
    if(key==="system") continue; // handled by the global system selector
    card.appendChild(fieldFor(key, props[key], req.has(key)));
  }
  const btn=document.createElement("button"); btn.className="run"; btn.textContent="Çalıştır"; card.appendChild(btn);
  const out=document.createElement("pre"); out.className="out"; card.appendChild(out);

  btn.addEventListener("click", async ()=>{
    let args;
    try { args=collect(card); } catch(e){ out.className="out err"; out.textContent=e.message; return; }
    const sys=getSystem();
    if(sys) args.system=sys;
    btn.disabled=true; const old=btn.textContent; btn.textContent="Çalışıyor…";
    out.className="out"; out.textContent="";
    try {
      const res=await call(tool.name, args);
      out.className="out"+(res.isError?" err":"");
      out.textContent=res.text||"(boş yanıt)";
    } catch(e){ out.className="out err"; out.textContent=String(e.message||e); }
    finally { btn.disabled=false; btn.textContent=old; }
  });
  return card;
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
  $("#ver").textContent="v"+meta.version;
  if(meta.readOnly) $("#globalro").style.display="";
  const sel=$("#system");
  for(const s of meta.systems){ const o=document.createElement("option"); o.value=s; o.textContent=s; sel.appendChild(o); }
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
