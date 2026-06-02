import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/jobs.js";

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

const NOT_FOUND = '<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>';

test("adt_schedule_job: missing program/jobName → friendly error, no request", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_schedule_job({ jobName: "JOB1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /required/i);
  assert.equal(calls.length, 0);
});

test("adt_schedule_job: builds job body with program/variant/startImmediately", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  await h.adt_schedule_job({ jobName: "JOB1", program: "ZREP", variant: "VAR1", startImmediately: false });
  assert.match(calls[0].body, /job:name="JOB1"/);
  assert.match(calls[0].body, /job:program="ZREP"/);
  assert.match(calls[0].body, /job:variant="VAR1"/);
  assert.match(calls[0].body, /job:startImmediately="false"/);
});

test("adt_schedule_job: ResourceNotFound → available:false with SM36 hint", async () => {
  const { ctx } = makeCtx({ responses: [resp(NOT_FOUND, false, 404)] });
  const h = register(ctx);
  const r = await h.adt_schedule_job({ jobName: "J", program: "ZREP" });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.match(out.hint, /SM36/);
});

test("adt_read_spool: ResourceNotFound → available:false", async () => {
  const { ctx } = makeCtx({ responses: [resp(NOT_FOUND, false, 404)] });
  const h = register(ctx);
  const r = await h.adt_read_spool({ spoolId: "123" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
});

test("adt_read_spool: 200 → available:true with content", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp("SPOOL LINE 1\nSPOOL LINE 2")] });
  const h = register(ctx);
  const r = await h.adt_read_spool({ spoolId: "456" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, true);
  assert.match(out.content, /SPOOL LINE 1/);
  assert.match(calls[0].path, /scheduling\/spools\/456$/);
});
