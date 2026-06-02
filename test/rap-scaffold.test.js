import { test } from "node:test";
import assert from "node:assert/strict";

import { register, generateRapStack } from "../src/tools/rap.js";

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
            text: async () => "<ok/>",
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
  headers: { get: () => "application/xml" },
  text: async () => body,
});

test("generateRapStack: produces 5 artifacts in dependency order with derived names", () => {
  const plan = generateRapStack({ name: "TRAVEL", dataSource: "ZTRAVEL", package: "ZP", keyFields: ["travel_id"] });
  assert.deepEqual(
    plan.map((a) => a.type),
    ["ddls", "bdef", "class", "srvd", "srvb"],
  );
  assert.equal(plan[0].name, "ZI_TRAVEL");
  assert.equal(plan[2].name, "ZBP_I_TRAVEL");
  assert.equal(plan[3].name, "ZSD_TRAVEL");
  assert.equal(plan[4].name, "ZSB_TRAVEL");
  // service binding is plan-only
  assert.equal(plan[4].planOnly, true);
});

test("generateRapStack: CDS source exposes key + camelCase aliases and selects from dataSource", () => {
  const plan = generateRapStack({ name: "TRAVEL", dataSource: "ZTRAVEL", package: "ZP", keyFields: ["travel_id"], fields: ["agency_id"] });
  const cds = plan[0].source;
  assert.match(cds, /define root view entity ZI_TRAVEL/);
  assert.match(cds, /as select from ZTRAVEL/);
  assert.match(cds, /key travel_id as travelId/);
  assert.match(cds, /agency_id as agencyId/);
});

test("generateRapStack: respects explicit name overrides", () => {
  const plan = generateRapStack({
    name: "X",
    dataSource: "ZT",
    package: "ZP",
    viewName: "ZC_CUSTOM",
    implClass: "ZBP_CUSTOM",
    serviceDef: "ZSD_CUSTOM",
    serviceBinding: "ZSB_CUSTOM",
  });
  assert.equal(plan[0].name, "ZC_CUSTOM");
  assert.equal(plan[2].name, "ZBP_CUSTOM");
  assert.equal(plan[3].name, "ZSD_CUSTOM");
  assert.equal(plan[4].name, "ZSB_CUSTOM");
});

test("adt_rap_scaffold: dryRun is the default — returns plan, makes NO requests", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_rap_scaffold({ name: "TRAVEL", dataSource: "ZTRAVEL", package: "ZP" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.dryRun, true);
  assert.equal(out.artifacts.length, 5);
  assert.equal(calls.length, 0);
});

test("adt_rap_scaffold: missing required args → friendly error", async () => {
  const { ctx } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_rap_scaffold({ name: "TRAVEL" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /required/i);
});

test("adt_rap_scaffold: dryRun:false halts the chain on first create failure", async () => {
  // First artifact (CDS) create POST fails → chain stops, no later artifacts attempted.
  const { ctx } = makeCtx({ responses: [resp("create rejected", false, 403)] });
  const h = register(ctx);
  const r = await h.adt_rap_scaffold({
    name: "TRAVEL",
    dataSource: "ZTRAVEL",
    package: "ZP",
    transport: "E4DK900123",
    dryRun: false,
  });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.ok, false);
  assert.equal(out.results[0].stage, "create");
  assert.equal(out.results.length, 1); // halted after the first failure
});
