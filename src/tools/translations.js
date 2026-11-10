import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName, chunk, inList } from "../data-preview.js";
import { sapLanguage, isoLanguage } from "../value-help.js";
import { pivot, languagesOf, completeness, latestVersions, renderLongTexts } from "../translations.js";
import { SYSTEM_HINT } from "./_shared.js";

// One message class: up to 1000 messages × a few dozen languages.
const TEXT_ROWS_CAP = 20000;

export const tools = [
  {
    name: "adt_translations",
    description:
      "Texts of an object in every language it is maintained in, and the languages each text is missing in (SE63 lite). `messageClass` (optionally one `number`): short texts from T100, the class description, and message long texts (DOKHL/DOKTL). `class`: class description and component (method, attribute, event…) descriptions, plus the class documentation. `dataElement`: short description, heading and short/medium/long field labels, plus the documentation. `domain`: short description and fixed-value texts. Long texts come back as plain text rendered from SAPscript. Pass `languages` to check against a fixed set (e.g. ['EN', 'TR']); otherwise every language found counts as expected. Read-only (Data Preview SELECTs; needs NetWeaver 7.55+ / S/4HANA). Text symbols / selection texts of programs and classes live in the text pool, which is not table-readable, and are not covered.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        messageClass: { type: "string", description: "Message class (SE91), e.g. 'SV'." },
        number: { type: "string", description: "Message number within `messageClass`, e.g. '175'." },
        class: { type: "string", description: "Global class or interface name." },
        dataElement: { type: "string", description: "Data element name." },
        domain: { type: "string", description: "Domain name." },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Languages to check — ISO ('EN', 'TR') or SAP keys. Only these are read and reported missing. Default: every language found.",
        },
        longTexts: {
          type: "boolean",
          description: "Include long texts / documentation. Default true, except for a whole message class (false — set it to read every message's long text). Domains have none.",
        },
      },
    },
  },
];

function fail(sys, r, stage) {
  return errorResult(sys, r.status, r.body, r.contentType, { stage });
}

// Read DOKHL headers + DOKTL lines for documentation objects of one ID and
// render the newest version per language. `objects` are exact DOKHL-OBJECT
// values; `like` reads by prefix instead (message classes), then `keep` filters.
async function readLongTexts(client, id, { objects, like, keep }, langFilter) {
  const headerQuery = like
    ? `SELECT object, langu, dokversion FROM dokhl WHERE id = '${id}' AND object LIKE '${like}%'${langFilter("langu")}`
    : `SELECT object, langu, dokversion FROM dokhl WHERE id = '${id}' AND object IN (${inList(objects)})${langFilter("langu")}`;
  const h = await runFreestyle(client, headerQuery, TEXT_ROWS_CAP);
  if (!h.ok) return { fail: h, stage: "dokhl" };
  const headers = keep ? h.rows.filter((r) => keep(r.OBJECT)) : h.rows;
  if (headers.length === 0) return { rows: [] };
  const latest = latestVersions(headers);
  const lines = [];
  for (const names of chunk([...new Set(headers.map((r) => r.OBJECT))], 20)) {
    const t = await runFreestyle(
      client,
      `SELECT object, langu, dokversion, line, dokformat, doktext FROM doktl WHERE id = '${id}' AND object IN (${inList(names)})${langFilter("langu")}`,
      TEXT_ROWS_CAP
    );
    if (!t.ok) return { fail: t, stage: "doktl" };
    lines.push(...t.rows);
  }
  return { rows: renderLongTexts(lines, latest), truncated: h.totalRows > h.rows.length };
}

export function register({ getClient }) {
  return {
    adt_translations: async (args) => {
      const modes = ["messageClass", "class", "dataElement", "domain"].filter((k) => args[k] != null);
      if (modes.length !== 1) {
        return textResult("adt_translations: pass exactly one of `messageClass`, `class`, `dataElement`, or `domain`.", true);
      }
      const mode = modes[0];
      const name = sqlName(args[mode], mode === "messageClass" ? 20 : 30);
      if (!name) return textResult(`adt_translations: \`${mode}\` must be a repository name.`, true);
      if (args.number != null && mode !== "messageClass") {
        return textResult("adt_translations: `number` only goes with `messageClass`.", true);
      }
      let number = null;
      if (args.number != null) {
        if (!/^\d{1,3}$/.test(String(args.number).trim())) {
          return textResult("adt_translations: `number` is a message number of up to three digits.", true);
        }
        number = String(args.number).trim().padStart(3, "0");
      }
      if (args.languages != null && !Array.isArray(args.languages)) {
        return textResult("adt_translations: `languages` is an array, e.g. ['EN', 'TR'].", true);
      }
      const sapLangs = [...new Set((args.languages ?? []).map((l) => sapLanguage(l)))];
      const requested = sapLangs.map(isoLanguage);
      const langFilter = (col) => (sapLangs.length > 0 ? ` AND ${col} IN (${inList(sapLangs)})` : "");
      // Domains carry no documentation of their own; a whole message class's
      // long texts are opt-in because they can run to thousands of lines.
      const wantLong = mode !== "domain" && (args.longTexts ?? !(mode === "messageClass" && !number));

      const { client, name: sys } = getClient(args.system);
      let texts = [];
      let longTexts = [];
      let truncated = false;
      const read = async (query, stage) => {
        const r = await runFreestyle(client, query, TEXT_ROWS_CAP);
        if (r.ok && r.totalRows > r.rows.length) truncated = true;
        return r.ok ? r : { fail: r, stage };
      };

      if (mode === "messageClass") {
        const head = await read(`SELECT arbgb FROM t100a WHERE arbgb = '${name}'`, "t100a");
        if (head.fail) return fail(sys, head.fail, head.stage);
        if (!head.rows[0]) return textResult(`adt_translations: no message class ${name} in T100A.`, true);
        const desc = await read(`SELECT sprsl, stext FROM t100t WHERE arbgb = '${name}'${langFilter("sprsl")}`, "t100t");
        if (desc.fail) return fail(sys, desc.fail, desc.stage);
        const msgs = await read(
          `SELECT sprsl, msgnr, text FROM t100 WHERE arbgb = '${name}'${number ? ` AND msgnr = '${number}'` : ""}${langFilter("sprsl")}`,
          "t100"
        );
        if (msgs.fail) return fail(sys, msgs.fail, msgs.stage);
        texts = [
          ...(number ? [] : pivot(desc.rows, { keyOf: () => "description", langOf: (r) => r.SPRSL, valueOf: (r) => r.STEXT })),
          ...pivot(
            [...msgs.rows].sort((a, b) => a.MSGNR.localeCompare(b.MSGNR)),
            { keyOf: (r) => r.MSGNR, langOf: (r) => r.SPRSL, valueOf: (r) => r.TEXT }
          ),
        ];
        if (number && texts.length === 0) {
          return textResult(`adt_translations: no message ${name} ${number} in T100.`, true);
        }
        if (wantLong) {
          // DOKHL-OBJECT of a message is the class name directly followed by
          // the number ('SV175'). '_' is a LIKE wildcard, so filter exactly.
          const exact = new RegExp(`^${name.replace(/[/]/g, "\\/")}\\d{3}$`);
          const lt = await readLongTexts(
            client,
            "NA",
            number ? { objects: [`${name}${number}`] } : { like: name, keep: (o) => exact.test(o) },
            langFilter
          );
          if (lt.fail) return fail(sys, lt.fail, lt.stage);
          if (lt.truncated) truncated = true;
          longTexts = pivot(lt.rows, {
            keyOf: (r) => r.OBJECT.slice(name.length),
            langOf: (r) => r.LANGU,
            valueOf: (r) => r.TEXT,
          });
        }
      } else if (mode === "class") {
        const head = await read(`SELECT clsname FROM seoclass WHERE clsname = '${name}'`, "seoclass");
        if (head.fail) return fail(sys, head.fail, head.stage);
        if (!head.rows[0]) return textResult(`adt_translations: no global class or interface ${name} in SEOCLASS.`, true);
        const desc = await read(`SELECT langu, descript FROM seoclasstx WHERE clsname = '${name}'${langFilter("langu")}`, "seoclasstx");
        if (desc.fail) return fail(sys, desc.fail, desc.stage);
        const comps = await read(
          `SELECT cmpname, langu, descript FROM seocompotx WHERE clsname = '${name}'${langFilter("langu")}`,
          "seocompotx"
        );
        if (comps.fail) return fail(sys, comps.fail, comps.stage);
        texts = [
          ...pivot(desc.rows, { keyOf: () => "description", langOf: (r) => r.LANGU, valueOf: (r) => r.DESCRIPT }),
          ...pivot(
            [...comps.rows].sort((a, b) => a.CMPNAME.localeCompare(b.CMPNAME)),
            { keyOf: (r) => r.CMPNAME, langOf: (r) => r.LANGU, valueOf: (r) => r.DESCRIPT }
          ),
        ];
        if (wantLong) {
          const lt = await readLongTexts(client, "CL", { objects: [name] }, langFilter);
          if (lt.fail) return fail(sys, lt.fail, lt.stage);
          longTexts = pivot(lt.rows, { keyOf: () => "documentation", langOf: (r) => r.LANGU, valueOf: (r) => r.TEXT });
        }
      } else if (mode === "dataElement") {
        const r = await read(
          `SELECT ddlanguage, ddtext, reptext, scrtext_s, scrtext_m, scrtext_l FROM dd04t WHERE rollname = '${name}' AND as4local = 'A'${langFilter("ddlanguage")}`,
          "dd04t"
        );
        if (r.fail) return fail(sys, r.fail, r.stage);
        if (r.rows.length === 0 && sapLangs.length === 0) {
          return textResult(`adt_translations: no texts for data element ${name} in DD04T.`, true);
        }
        const labels = { DDTEXT: "description", REPTEXT: "heading", SCRTEXT_S: "short label", SCRTEXT_M: "medium label", SCRTEXT_L: "long label" };
        for (const [col, key] of Object.entries(labels)) {
          texts.push(...pivot(r.rows, { keyOf: () => key, langOf: (x) => x.DDLANGUAGE, valueOf: (x) => x[col] }));
        }
        if (wantLong) {
          const lt = await readLongTexts(client, "DE", { objects: [name] }, langFilter);
          if (lt.fail) return fail(sys, lt.fail, lt.stage);
          longTexts = pivot(lt.rows, { keyOf: () => "documentation", langOf: (x) => x.LANGU, valueOf: (x) => x.TEXT });
        }
      } else {
        const d = await read(
          `SELECT ddlanguage, ddtext FROM dd01t WHERE domname = '${name}' AND as4local = 'A'${langFilter("ddlanguage")}`,
          "dd01t"
        );
        if (d.fail) return fail(sys, d.fail, d.stage);
        const v = await read(
          `SELECT valpos, domvalue_l, ddlanguage, ddtext FROM dd07t WHERE domname = '${name}' AND as4local = 'A'${langFilter("ddlanguage")}`,
          "dd07t"
        );
        if (v.fail) return fail(sys, v.fail, v.stage);
        if (d.rows.length === 0 && v.rows.length === 0 && sapLangs.length === 0) {
          return textResult(`adt_translations: no texts for domain ${name} in DD01T / DD07T.`, true);
        }
        texts = [
          ...pivot(d.rows, { keyOf: () => "description", langOf: (r) => r.DDLANGUAGE, valueOf: (r) => r.DDTEXT }),
          ...pivot(
            [...v.rows].sort((a, b) => String(a.VALPOS).localeCompare(String(b.VALPOS))),
            { keyOf: (r) => `value ${r.DOMVALUE_L}`, langOf: (r) => r.DDLANGUAGE, valueOf: (r) => r.DDTEXT }
          ),
        ];
      }

      const languages = languagesOf([...texts, ...longTexts], requested);
      const t = completeness(texts, languages);
      const l = completeness(longTexts, languages);
      return jsonResult({
        system: sys,
        [mode]: name,
        ...(number ? { number } : {}),
        languages,
        summary: t.summary,
        texts: t.entries,
        ...(wantLong ? { longTextSummary: l.summary, longTexts: l.entries } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    },
  };
}
