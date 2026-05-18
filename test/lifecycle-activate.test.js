import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/lifecycle.js";

function makeCtx() {
  const calls = [];
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          return {
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

test("adt_activate defaults: method=activate, preauditRequested=true, no extra flags", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
  });
  const call = calls[0];
  assert.equal(call.path, "/sap/bc/adt/activation");
  assert.deepEqual(call.query, {
    method: "activate",
    preauditRequested: "true",
  });
});

test("adt_activate forwards processRedoneOOSourceVersionOnly as isProcessRedoneOOSourceVerOnly", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    processRedoneOOSourceVersionOnly: true,
  });
  assert.equal(calls[0].query.isProcessRedoneOOSourceVerOnly, "true");
});

test("adt_activate allows preauditRequested override to false", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    preauditRequested: false,
  });
  assert.equal(calls[0].query.preauditRequested, "false");
});

test("adt_activate omits isProcessRedoneOOSourceVerOnly when flag is false", async () => {
  const { ctx, calls } = makeCtx();
  const handlers = register(ctx);
  await handlers.adt_activate({
    objects: [{ name: "ZCL_FOO", type: "CLAS" }],
    processRedoneOOSourceVersionOnly: false,
  });
  assert.equal(calls[0].query.isProcessRedoneOOSourceVerOnly, undefined);
});
