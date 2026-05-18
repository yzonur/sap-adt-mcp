import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPartialSource, register, tools } from "../src/tools/source.js";

test("detectPartialSource accepts a class main include", () => {
  const src = `CLASS zcl_foo DEFINITION PUBLIC.
ENDCLASS.

CLASS zcl_foo IMPLEMENTATION.
ENDCLASS.`;
  assert.equal(detectPartialSource(src), null);
});

test("detectPartialSource accepts a class implementations include starting with CLASS ... IMPLEMENTATION", () => {
  const src = `CLASS zcl_foo IMPLEMENTATION.
  METHOD do_something.
    rv = 1.
  ENDMETHOD.
ENDCLASS.`;
  assert.equal(detectPartialSource(src), null);
});

test("detectPartialSource accepts a report", () => {
  assert.equal(detectPartialSource("REPORT zfoo.\n  WRITE 'hi'."), null);
});

test("detectPartialSource accepts a function module", () => {
  assert.equal(
    detectPartialSource("FUNCTION z_foo.\n  ev_x = 1.\nENDFUNCTION."),
    null,
  );
});

test("detectPartialSource accepts an interface", () => {
  assert.equal(
    detectPartialSource("INTERFACE zif_foo.\n  METHODS bar.\nENDINTERFACE."),
    null,
  );
});

test("detectPartialSource accepts a macro include starting with DEFINE", () => {
  assert.equal(
    detectPartialSource("DEFINE log.\n  WRITE 'x'.\nEND-OF-DEFINITION."),
    null,
  );
});

test("detectPartialSource accepts a data-only include", () => {
  assert.equal(
    detectPartialSource("DATA: gv_x TYPE i,\n      gv_y TYPE string."),
    null,
  );
});

test("detectPartialSource ignores leading blank and full-line comments", () => {
  const src = `
* hello
* multi
* line
* header

REPORT zfoo.`;
  assert.equal(detectPartialSource(src), null);
});

test("detectPartialSource ignores BOM", () => {
  assert.equal(detectPartialSource("﻿REPORT zfoo."), null);
});

test("detectPartialSource rejects a bare METHOD body without enclosing CLASS", () => {
  const src = `  rv_count = 0.
  LOOP AT it_lines INTO DATA(ls_line).
    rv_count = rv_count + 1.
  ENDLOOP.`;
  const reason = detectPartialSource(src);
  assert.ok(reason, "should reject");
  assert.match(reason, /top-level/);
});

test("detectPartialSource rejects a fragment that starts with ENDCLASS", () => {
  assert.ok(detectPartialSource("ENDCLASS."));
});

test("detectPartialSource rejects empty string", () => {
  assert.equal(detectPartialSource(""), "source is empty");
});

test("detectPartialSource rejects whitespace-only", () => {
  assert.equal(detectPartialSource("   \n\n  "), "source is empty");
});

test("detectPartialSource accepts a METHOD-only fragment (rare valid case)", () => {
  // METHOD is in the whitelist because an implementations include with only one
  // method *can* legitimately start with METHOD. The guard catches the broader
  // mistake of statements with no construct keyword at all.
  assert.equal(
    detectPartialSource("METHOD do_x.\n  rv = 1.\nENDMETHOD."),
    null,
  );
});

test("adt_set_source handler rejects partial source without acknowledgePartial", async () => {
  const ctx = {
    getClient: () => ({
      client: {
        request: async () => {
          throw new Error("guard should have blocked request");
        },
      },
      name: "FAKE",
    }),
    config: { systems: {}, defaultSystem: null },
  };
  const handlers = register(ctx);
  const result = await handlers.adt_set_source({
    object: "ZCL_FOO",
    type: "CLAS",
    source: "  rv = 1.\n  RETURN.",
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 422);
  assert.equal(payload.guard, "partial-source");
});

test("adt_set_source handler bypasses guard when acknowledgePartial=true", async () => {
  let called = false;
  const ctx = {
    getClient: () => ({
      client: {
        request: async () => {
          called = true;
          // Returning a fake "lock failed" response so we don't have to fake
          // the full lock→PUT→unlock chain. We only need to prove the handler
          // got past the guard.
          return {
            ok: false,
            status: 500,
            headers: { get: () => "text/plain" },
            text: async () => "fake",
          };
        },
      },
      name: "FAKE",
    }),
    config: { systems: {}, defaultSystem: null },
  };
  const handlers = register(ctx);
  await handlers.adt_set_source({
    object: "ZCL_FOO",
    type: "CLAS",
    source: "  rv = 1.\n  RETURN.",
    acknowledgePartial: true,
  });
  assert.equal(called, true, "client.request should have been called");
});

test("adt_set_source tool schema declares acknowledgePartial", () => {
  const tool = tools.find((t) => t.name === "adt_set_source");
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.acknowledgePartial.type, "boolean");
  assert.match(tool.description, /FULL text|atomically|ATOMIC/i);
});
