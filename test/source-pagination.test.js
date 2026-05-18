import { test } from "node:test";
import assert from "node:assert/strict";

import { register, findMethodRange } from "../src/tools/source.js";

const FAKE_CLASS = `CLASS zcl_foo DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS small.
    METHODS bigger.
ENDCLASS.

CLASS zcl_foo IMPLEMENTATION.
  METHOD small.
    rv = 1.
  ENDMETHOD.

  METHOD bigger.
    DATA(lv_x) = 0.
    LOOP AT it_lines INTO DATA(ls_line).
      lv_x = lv_x + 1.
    ENDLOOP.
    rv = lv_x.
  ENDMETHOD.
ENDCLASS.`;

function makeHandlers(returnBody = FAKE_CLASS) {
  const ctx = {
    getClient: () => ({
      client: {
        request: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => "text/plain" },
          text: async () => returnBody,
        }),
      },
      name: "FAKE",
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return register(ctx);
}

test("findMethodRange locates implementation block, skipping declaration in DEFINITION", () => {
  const lines = FAKE_CLASS.split("\n");
  const r = findMethodRange(lines, "small");
  // Find expected lines: METHOD small. is on line 8 (1-based), ENDMETHOD on line 10.
  assert.equal(lines[r.start - 1].trim(), "METHOD small.");
  assert.equal(lines[r.end - 1].trim(), "ENDMETHOD.");
});

test("findMethodRange is case-insensitive", () => {
  const lines = FAKE_CLASS.split("\n");
  const r = findMethodRange(lines, "BIGGER");
  assert.ok(r);
  assert.equal(lines[r.start - 1].trim(), "METHOD bigger.");
});

test("findMethodRange returns null for unknown method", () => {
  assert.equal(findMethodRange(FAKE_CLASS.split("\n"), "nope"), null);
});

test("adt_get_source returns full source by default", async () => {
  const handlers = makeHandlers();
  const result = await handlers.adt_get_source({ object: "ZCL_FOO", type: "CLAS" });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.source, FAKE_CLASS);
  assert.equal(payload.scope, "full");
  assert.equal(payload.truncated, false);
  assert.equal(payload.totalLines, FAKE_CLASS.split("\n").length);
});

test("adt_get_source firstLine/lastLine slices and reports range", async () => {
  const handlers = makeHandlers();
  const result = await handlers.adt_get_source({
    object: "ZCL_FOO",
    type: "CLAS",
    firstLine: 1,
    lastLine: 3,
  });
  const payload = JSON.parse(result.content[0].text);
  const expected = FAKE_CLASS.split("\n").slice(0, 3).join("\n");
  assert.equal(payload.source, expected);
  assert.equal(payload.truncated, true);
  assert.equal(payload.firstLine, 1);
  assert.equal(payload.lastLine, 3);
  assert.equal(payload.scope, "range:1-3");
});

test("adt_get_source clamps lastLine to totalLines", async () => {
  const handlers = makeHandlers();
  const total = FAKE_CLASS.split("\n").length;
  const result = await handlers.adt_get_source({
    object: "ZCL_FOO",
    type: "CLAS",
    firstLine: 1,
    lastLine: 9999,
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.lastLine, total);
});

test("adt_get_source rejects inverted range", async () => {
  const handlers = makeHandlers();
  const result = await handlers.adt_get_source({
    object: "ZCL_FOO",
    type: "CLAS",
    firstLine: 10,
    lastLine: 5,
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 422);
});

test("adt_get_source onlyMethod slices a single method body", async () => {
  const handlers = makeHandlers();
  const result = await handlers.adt_get_source({
    object: "ZCL_FOO",
    type: "CLAS",
    onlyMethod: "small",
  });
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.source.includes("METHOD small."));
  assert.ok(payload.source.includes("ENDMETHOD."));
  assert.ok(!payload.source.includes("METHOD bigger."));
  assert.match(payload.scope, /^method:small$/);
  assert.equal(payload.truncated, true);
});

test("adt_get_source onlyMethod returns 404-shaped error when method missing", async () => {
  const handlers = makeHandlers();
  const result = await handlers.adt_get_source({
    object: "ZCL_FOO",
    type: "CLAS",
    onlyMethod: "nonexistent",
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 404);
});
