import { test } from "node:test";
import assert from "node:assert/strict";

import { register as registerDiscovery } from "../src/tools/discovery.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        resolvePath: (p) => p,
        request: async (call) => {
          calls.push(call);
          const r = responses
            ? responses[i++] ?? responses[responses.length - 1]
            : {
                ok: true,
                status: 200,
                headers: { get: () => "text/plain" },
                text: async () => "",
              };
          return r;
        },
      },
      name: "FAKE",
      profile: { user: "TESTER" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

function textResponse(body, ok = true, status = 200) {
  return { ok, status, headers: { get: () => "text/plain" }, text: async () => body };
}

test("adt_grep_source: invalid regex → friendly error, no requests", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({ pattern: "(", objects: [{ name: "X", type: "class" }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /invalid regex/i);
  assert.equal(calls.length, 0);
});

test("adt_grep_source: no scope → error", async () => {
  const { ctx } = makeCtx();
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({ pattern: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /exactly one scope/i);
});

test("adt_grep_source: more than one scope → error", async () => {
  const { ctx } = makeCtx();
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "x",
    package: "ZP",
    objects: [{ name: "X", type: "class" }],
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /exactly one scope/i);
});

test("adt_grep_source: objects scope returns line-numbered matches (case-insensitive default)", async () => {
  const src = "CLASS zcl_a DEFINITION.\n  METHODS go.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD go.\n    SELECT * FROM mara INTO TABLE @lt.\n  ENDMETHOD.\nENDCLASS.";
  const { ctx, calls } = makeCtx({ responses: [textResponse(src)] });
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "select \\* from",
    objects: [{ name: "ZCL_A", type: "class" }],
  });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.matchCount, 1);
  assert.equal(out.matches[0].line, 6);
  assert.equal(out.matches[0].object, "ZCL_A");
  assert.equal(out.flags, "i");
  // class source path resolved correctly
  assert.equal(calls[0].path, "/sap/bc/adt/oo/classes/zcl_a/source/main");
});

test("adt_grep_source: maxMatches truncates and flags reason", async () => {
  const src = "foo\nfoo\nfoo\nfoo";
  const { ctx } = makeCtx({ responses: [textResponse(src)] });
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "foo",
    objects: [{ name: "ZP", type: "program" }],
    maxMatches: 2,
  });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.matchCount, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.truncationReason, "maxMatches");
});

test("adt_grep_source: explicit objects trust the caller — a table IS fetched (its DDL source)", async () => {
  // package/transport scopes auto-skip non-source types; an explicit objects[]
  // list trusts the caller, so TABL resolves to its /source/main and is grepped.
  const { ctx, calls } = makeCtx({ responses: [textResponse("define table mara {\n  matnr;\n}")] });
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "matnr",
    objects: [{ name: "MARA", type: "table" }],
  });
  const out = JSON.parse(r.content[0].text);
  assert.ok(!r.isError);
  assert.equal(calls[0].path, "/sap/bc/adt/ddic/tables/mara/source/main");
  assert.equal(out.matchCount, 1);
});

test("adt_grep_source: explicit object with unresolvable type is skipped with reason", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "x",
    objects: [{ name: "FOO", type: "nonsense_type" }],
  });
  const out = JSON.parse(r.content[0].text);
  assert.ok(!r.isError);
  assert.equal(out.objectsSkipped, 1);
  assert.equal(calls.length, 0);
});

test("adt_grep_source: failed fetch is surfaced under errors, not a hard failure", async () => {
  const { ctx } = makeCtx({ responses: [textResponse("boom", false, 500)] });
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({
    pattern: "x",
    objects: [{ name: "ZP", type: "program" }],
  });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.matchCount, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /HTTP 500/);
});

test("adt_grep_source: transport scope fetches refs then greps source-bearing only", async () => {
  const trBody =
    '<tm:request xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_t" adtcore:type="CLAS/OC" adtcore:name="ZCL_T"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/ddic/tables/ztab" adtcore:type="TABL/DT" adtcore:name="ZTAB"/>' +
    "</tm:request>";
  const { ctx, calls } = makeCtx({
    responses: [
      textResponse(trBody), // transport fetch
      textResponse("CLASS zcl_t DEFINITION.\n  DATA foo.\nENDCLASS."), // class source
    ],
  });
  const h = registerDiscovery(ctx);
  const r = await h.adt_grep_source({ pattern: "data", transport: "e4dk900123" });
  const out = JSON.parse(r.content[0].text);
  assert.match(calls[0].path, /transportrequests\/E4DK900123/);
  assert.equal(out.objectsScanned, 1); // only the class, table skipped
  assert.equal(out.objectsSkipped, 1);
  assert.equal(out.matchCount, 1);
  assert.equal(out.matches[0].object, "ZCL_T");
});
