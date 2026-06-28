import { test } from "node:test";
import assert from "node:assert/strict";

import { register, parseAtcFindings } from "../src/tools/quality.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          return responses ? responses[i++] ?? responses[responses.length - 1] : {
            ok: true,
            status: 200,
            headers: { get: () => "application/xml" },
            text: async () => "",
          };
        },
      },
      name: "FAKE",
      profile: { user: "TESTER" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

const resp = (body, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: () => "text/plain" },
  text: async () => body,
});

const WORKLIST_XML =
  '<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist" xmlns:atcfinding="http://www.sap.com/adt/atc/finding">' +
  '<atcfinding atcfinding:priority="1" atcfinding:checkId="C1" atcfinding:checkTitle="SLIN" atcfinding:messageId="0248" atcfinding:messageTitle="No exception handling" atcfinding:location="/sap/bc/adt/oo/classes/zcl_a/source/main#start=17"/>' +
  '<atcfinding atcfinding:priority="2" atcfinding:checkId="C1" atcfinding:messageId="0261" atcfinding:messageTitle="LOOP slow"/>' +
  '<atcfinding atcfinding:priority="2" atcfinding:checkId="C2" atcfinding:messageId="0908" atcfinding:messageTitle="No reads"/>' +
  "</atcworklist:worklist>";

test("parseAtcFindings: parses findings, skips xmlns declarations and empty container", () => {
  const f = parseAtcFindings(WORKLIST_XML);
  assert.equal(f.length, 3);
  assert.equal(f[0].priority, "1");
  assert.equal(f[0].checkTitle, "SLIN");
  // namespace declaration must not leak in as an attribute
  assert.equal(f[0].atcfinding, undefined);
});

test("adt_run_atc_package: full worklist flow with explicit checkVariant", async () => {
  const { ctx, calls } = makeCtx({
    responses: [
      resp("WL_ID_123"), // create worklist
      resp("<atc:run/>"), // run
      resp(WORKLIST_XML), // fetch results
    ],
  });
  const h = register(ctx);
  const r = await h.adt_run_atc_package({ package: "/FGLR/FLEET", checkVariant: "ZFIT" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.worklistId, "WL_ID_123");
  assert.equal(out.checkVariant, "ZFIT");
  assert.equal(out.findingCount, 3);
  assert.deepEqual(out.byPriority, { 1: 1, 2: 2 });
  // worklist created with the variant
  assert.equal(calls[0].query.checkVariant, "ZFIT");
  // run posted with worklistId and an object set referencing the package
  assert.equal(calls[1].query.worklistId, "WL_ID_123");
  assert.match(calls[1].body, /sap\/bc\/adt\/packages\/%2ffglr%2ffleet/i);
  // results fetched with the ATC worklist mime
  assert.equal(calls[2].accept, "application/atc.worklist.v1+xml");
});

test("adt_run_atc_package: omitted checkVariant → reads system default from customizing", async () => {
  const customizing =
    '<atc:customizing><properties><property name="systemCheckVariant" value="ZSYS_DEF"/></properties></atc:customizing>';
  const { ctx, calls } = makeCtx({
    responses: [resp(customizing), resp("WL1"), resp("<run/>"), resp(WORKLIST_XML)],
  });
  const h = register(ctx);
  const r = await h.adt_run_atc_package({ package: "ZP" });
  const out = JSON.parse(r.content[0].text);
  assert.match(calls[0].path, /atc\/customizing/);
  assert.equal(out.checkVariant, "ZSYS_DEF");
  assert.equal(calls[1].query.checkVariant, "ZSYS_DEF");
});

test("adt_run_atc_package: worklist-create failure is surfaced with stage", async () => {
  const { ctx } = makeCtx({ responses: [resp("nope", false, 500)] });
  const h = register(ctx);
  const r = await h.adt_run_atc_package({ package: "ZP", checkVariant: "ZFIT" });
  assert.equal(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.stage, "create-worklist");
});

test("adt_run_atc_transport: resolves transport objects then runs ATC", async () => {
  const trBody =
    '<tm:request xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:type="CLAS/OC" adtcore:name="ZCL_A"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zr" adtcore:type="PROG/P" adtcore:name="ZR"/>' +
    "</tm:request>";
  const { ctx, calls } = makeCtx({
    responses: [resp(trBody), resp("WL2"), resp("<run/>"), resp(WORKLIST_XML)],
  });
  const h = register(ctx);
  const r = await h.adt_run_atc_transport({ transport: "e4dk900123", checkVariant: "ZFIT" });
  const out = JSON.parse(r.content[0].text);
  assert.match(calls[0].path, /transportrequests\/E4DK900123/);
  assert.equal(out.objectCount, 2);
  assert.equal(out.findingCount, 3);
  // both object uris included in the run body
  assert.match(calls[2].body, /classes\/zcl_a/);
  assert.match(calls[2].body, /programs\/programs\/zr/);
});

test("adt_run_atc_transport: empty transport → no run, friendly note", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp("<tm:request/>")] });
  const h = register(ctx);
  const r = await h.adt_run_atc_transport({ transport: "E4DK1", checkVariant: "ZFIT" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.objectCount, 0);
  assert.match(out.note, /nothing to check/i);
  assert.equal(calls.length, 1); // only the transport fetch
});

test("adt_run_atc: missing objects array → clean error, no crash (#40)", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  // Caller used the singular get_source shape; objects is undefined.
  const r = await h.adt_run_atc({ object: "ZCDS_X", type: "cds", firstLine: 1 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /objects.*required/i);
  assert.equal(calls.length, 0); // never reached the wire
});

test("adt_run_unit_tests: missing objects array → clean error (#40)", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_run_unit_tests({ object: "ZCL_X", type: "class" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /objects.*required/i);
  assert.equal(calls.length, 0);
});
