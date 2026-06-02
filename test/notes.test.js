import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/notes.js";

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
            text: async () => "<note/>",
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

const NOT_FOUND =
  '<exc:exception><type id="ExceptionResourceNotFound"/><message>Resource does not exist.</message></exc:exception>';

test("adt_get_note: zero-pads the note number in the request path", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  await h.adt_get_note({ note: "3076322" });
  assert.match(calls[0].path, /\/sap\/bc\/adt\/cwb\/notes\/0003076322$/);
});

test("adt_get_note: ResourceNotFound → available:false with GUI SNOTE hint", async () => {
  const { ctx } = makeCtx({ responses: [resp(NOT_FOUND, false, 404)] });
  const h = register(ctx);
  const r = await h.adt_get_note({ note: "3076322" });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.match(out.hint, /SNOTE/);
});

test("adt_get_note: 200 → available:true", async () => {
  const { ctx } = makeCtx({ responses: [resp("<note:note title='x'/>")] });
  const h = register(ctx);
  const r = await h.adt_get_note({ note: "1" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, true);
});

test("adt_check_note_status: parses implementationStatus attribute", async () => {
  const { ctx } = makeCtx({
    responses: [resp('<note:note implementationStatus="CANNOT_BE_IMPLEMENTED"/>')],
  });
  const h = register(ctx);
  const r = await h.adt_check_note_status({ note: "1" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, "CANNOT_BE_IMPLEMENTED");
});

test("adt_implement_note: missing transport → friendly error, no request", async () => {
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_implement_note({ note: "1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /transport.*required/i);
  assert.equal(calls.length, 0);
});

test("adt_implement_note: ResourceNotFound → available:false (not a hard error)", async () => {
  const { ctx } = makeCtx({ responses: [resp(NOT_FOUND, false, 404)] });
  const h = register(ctx);
  const r = await h.adt_implement_note({ note: "1", transport: "E4DK900123" });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
});
