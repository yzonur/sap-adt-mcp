import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName } from "../data-preview.js";
import { sourceUri, baseType } from "../object-uris.js";
import { sapLanguage } from "../value-help.js";
import {
  groupSu24,
  groupStartAuth,
  objectTexts,
  parseAuthorityChecks,
  summarizeChecks,
} from "../auth-check.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// SU24 rows per application: tens of objects, a few hundred field values.
const SU24_MAX_ROWS = 5000;
const SCANNABLE = new Set(["PROG", "INCL", "CLAS", "INTF"]);

export const tools = [
  {
    name: "adt_auth_check",
    description:
      "Authorization objects an application needs. For a `transaction` or an RFC-enabled `function`: the SU24 proposal (USOBX_C check indicators + USOBT_C field values, with object texts) and, for transactions, the start authorization from SE93 (TSTCA). For a function, program, include, class or interface (`object` + `type`) it also scans the source for AUTHORITY-CHECK statements and lists each object, its checked fields and the lines. Read-only (Data Preview SELECTs; needs NetWeaver 7.55+ / S/4HANA). The source scan is static: a class is read from its main and local-implementations includes, a program from its main source only (INCLUDEs are not followed), and checks inside called function modules or methods are not traced.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        transaction: { type: "string", description: "Transaction code, e.g. 'SE38'." },
        function: { type: "string", description: "Function module name — SU24 data (type RF) plus a source scan." },
        object: { type: "string", description: "ABAP object to scan for AUTHORITY-CHECK (with `type`)." },
        type: { type: "string", description: `${OBJECT_TYPE_HINT} Only source-bearing types (program, include, class, interface) can be scanned.` },
        language: {
          type: "string",
          description: "Language of the object texts — ISO ('EN', 'TR') or SAP key. Defaults to the system profile's language, else English.",
        },
      },
    },
  },
];

function fail(sys, r, stage) {
  return errorResult(sys, r.status, r.body, r.contentType, { stage });
}

// Function group of a function module from TFDIR-PNAME ('SAPLSU_USER' →
// 'SU_USER', '/NS/SAPLGRP' → '/NS/GRP').
export function groupFromMainProgram(pname) {
  const m = /^(\/[^/]+\/)?SAPL(.+)$/.exec(pname ?? "");
  return m ? `${m[1] ?? ""}${m[2]}` : null;
}

async function readSource(client, path) {
  const res = await client.request({ path, accept: "text/plain" });
  const text = await res.text();
  return res.ok ? { ok: true, text } : { ok: false, status: res.status, body: text, contentType: res.headers.get("content-type") };
}

async function su24(client, name, type, language) {
  const x = await runFreestyle(
    client,
    `SELECT object, okflag FROM usobx_c WHERE name = '${name}' AND type = '${type}'`,
    SU24_MAX_ROWS
  );
  if (!x.ok) return { fail: x, stage: "usobx_c" };
  const t = await runFreestyle(
    client,
    `SELECT object, field, low, high FROM usobt_c WHERE name = '${name}' AND type = '${type}'`,
    SU24_MAX_ROWS
  );
  if (!t.ok) return { fail: t, stage: "usobt_c" };
  const names = [...new Set([...x.rows, ...t.rows].map((r) => sqlName(r.OBJECT ?? "", 10)).filter(Boolean))];
  let texts = new Map();
  if (names.length > 0) {
    const tx = await runFreestyle(
      client,
      `SELECT object, langu, ttext FROM tobjt WHERE object IN (${names.map((n) => `'${n}'`).join(", ")}) AND langu IN ('${language}', 'E')`,
      names.length * 2
    );
    if (tx.ok) texts = objectTexts(tx.rows, language);
  }
  return { objects: groupSu24(x.rows, t.rows, texts) };
}

export function register({ getClient }) {
  return {
    adt_auth_check: async (args) => {
      const modes = [args.transaction != null, args.function != null, args.object != null].filter(Boolean).length;
      if (modes !== 1) {
        return textResult("adt_auth_check: pass exactly one of `transaction`, `function`, or `object` + `type`.", true);
      }

      const { client, name: sys, profile } = getClient(args.system);
      const language = sapLanguage(args.language ?? profile?.language);

      if (args.transaction != null) {
        const tcode = sqlName(args.transaction, 20);
        if (!tcode) return textResult("adt_auth_check: `transaction` must be a transaction code (letters, digits, '_' and '/').", true);
        const tc = await runFreestyle(client, `SELECT tcode, pgmna FROM tstc WHERE tcode = '${tcode}'`, 1);
        if (!tc.ok) return fail(sys, tc, "tstc");
        if (!tc.rows[0]) return textResult(`adt_auth_check: no transaction ${tcode} in TSTC.`, true);
        const start = await runFreestyle(client, `SELECT objct, field, value FROM tstca WHERE tcode = '${tcode}'`, 100);
        if (!start.ok) return fail(sys, start, "tstca");
        const s = await su24(client, tcode, "TR", language);
        if (s.fail) return fail(sys, s.fail, s.stage);
        return jsonResult({
          system: sys,
          transaction: tcode,
          program: tc.rows[0].PGMNA || undefined,
          startAuthorization: [{ object: "S_TCODE", fields: { TCD: tcode } }, ...groupStartAuth(start.rows)],
          su24: s.objects,
          ...(s.objects.length === 0 ? { note: "No SU24 data for this transaction — run SU24 / SU22 or trace it with STAUTHTRACE." } : {}),
        });
      }

      let target;
      if (args.function != null) {
        const fm = sqlName(args.function);
        if (!fm) return textResult("adt_auth_check: `function` must be a function module name.", true);
        const f = await runFreestyle(client, `SELECT funcname, pname FROM tfdir WHERE funcname = '${fm}'`, 1);
        if (!f.ok) return fail(sys, f, "tfdir");
        if (!f.rows[0]) return textResult(`adt_auth_check: no function module ${fm} in TFDIR.`, true);
        target = { kind: "FUGR/FF", name: fm, group: groupFromMainProgram(f.rows[0].PNAME) };
      } else {
        if (args.type == null) return textResult("adt_auth_check: `object` needs `type`.", true);
        let kind;
        try {
          kind = baseType(args.type);
        } catch (err) {
          return textResult(`adt_auth_check: ${err.message}`, true);
        }
        if (!SCANNABLE.has(kind)) {
          return textResult(
            "adt_auth_check: `object` scanning supports program, include, class and interface — use `function` for a function module.",
            true
          );
        }
        const name = sqlName(args.object);
        if (!name) return textResult("adt_auth_check: `object` must be an ABAP object name.", true);
        target = { kind, name };
      }

      const paths = [sourceUri({ type: target.kind, name: target.name, group: target.group })];
      if (target.kind === "CLAS") paths.push(sourceUri({ type: "CLAS", name: target.name, include: "implementations" }));
      const checks = [];
      const scanned = [];
      for (const [i, path] of paths.entries()) {
        const src = await readSource(client, path);
        if (!src.ok) {
          // The main source must exist; a missing local-implementations include
          // (a class with no local classes) is normal.
          if (i === 0) return errorResult(sys, src.status, src.body, src.contentType, { stage: "source" });
          continue;
        }
        const include = i === 0 ? "main" : "implementations";
        scanned.push(include);
        for (const c of parseAuthorityChecks(src.text)) checks.push({ include, ...c });
      }
      const summary = summarizeChecks(checks);

      let su24Objects;
      if (target.kind === "FUGR/FF") {
        const s = await su24(client, target.name, "RF", language);
        if (s.fail) return fail(sys, s.fail, s.stage);
        su24Objects = s.objects;
      }

      return jsonResult({
        system: sys,
        object: target.name,
        type: target.kind,
        ...(target.group ? { group: target.group } : {}),
        ...(su24Objects ? { su24: su24Objects } : {}),
        sourceChecks: {
          scanned,
          objects: summary.objects,
          ...(summary.dynamic.length > 0 ? { dynamic: summary.dynamic } : {}),
          statements: checks,
        },
        ...(checks.length === 0 && (!su24Objects || su24Objects.length === 0)
          ? { note: "No AUTHORITY-CHECK in the scanned source. Checks may still run in called function modules, methods or INCLUDEs — STAUTHTRACE shows them at runtime." }
          : {}),
      });
    },
  };
}
