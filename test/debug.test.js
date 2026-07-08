import { test } from "node:test";
import assert from "node:assert/strict";

import { register, _internals } from "../src/tools/debug.js";

// A router mock: each entry matches on a predicate and returns { ok, status, text }.
function makeCtx(routes, { profile } = {}) {
  const calls = [];
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          const route = routes.find((r) => r.match(call));
          if (route?.throw) throw route.throw;
          const r = route?.reply ?? { ok: true, status: 200, text: "<x/>" };
          return {
            ok: r.ok !== false,
            status: r.status ?? 200,
            headers: { get: () => r.contentType ?? "application/xml" },
            text: async () => r.text ?? "<x/>",
          };
        },
      },
      name: "FAKE",
      profile: profile ?? { user: "DEV" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

const BP_XML =
  '<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">' +
  '<dbg:breakpoint id="BP-1" clientId="c1" kind="line" adtcore:uri="/sap/bc/adt/programs/programs/zfoo/source/main#start=5"/>' +
  "</dbg:breakpoints>";

const DEBUGGEE_XML =
  '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>' +
  "<STPDA_DEBUGGEE><CLIENT>100</CLIENT><DEBUGGEE_ID>DBG-9</DEBUGGEE_ID>" +
  "<TERMINAL_ID>t</TERMINAL_ID><IDE_ID>i</IDE_ID><DEBUGGEE_USER>DEV</DEBUGGEE_USER>" +
  "<URI>/sap/bc/adt/programs/programs/zfoo/source/main#start=5</URI></STPDA_DEBUGGEE>" +
  "</DATA></asx:values></asx:abap>";

const ATTACH_XML =
  '<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger"><reachedBreakpoints>' +
  '<breakpoint id="BP-1"/></reachedBreakpoints></dbg:attach>';

test("adt_debug_set_breakpoint builds the breakpoints POST and tracks the id", async () => {
  _internals.SESSION.breakpoints = [];
  const { ctx, calls } = makeCtx([
    { match: (c) => c.path.endsWith("/debugger/breakpoints"), reply: { text: BP_XML } },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5 });
  const payload = JSON.parse(r.content[0].text);

  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].path, /\/sap\/bc\/adt\/debugger\/breakpoints$/);
  assert.match(calls[0].body, /dbg:breakpoints/);
  assert.match(calls[0].body, /adtcore:uri="\/sap\/bc\/adt\/programs\/programs\/zfoo\/source\/main#start=5"/);
  assert.equal(payload.breakpoints[0].id, "BP-1");
  assert.deepEqual(_internals.SESSION.breakpoints, [{ id: "BP-1", uri: "/sap/bc/adt/programs/programs/zfoo/source/main#start=5" }]);
});

test("adt_debug_set_breakpoint escapes a condition and needs a line for object/type", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }]);
  const h = register(ctx);
  const noLine = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program" });
  assert.match(noLine.content[0].text, /`line`.*required/);
  assert.equal(calls.length, 0);

  await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 3, condition: 'x > "5"' });
  assert.match(calls[0].body, /condition="x &gt; &quot;5&quot;"/);
});

test("adt_debug_listen: caught → auto-attaches and returns the debuggee", async () => {
  const { ctx, calls } = makeCtx([
    { match: (c) => c.path.endsWith("/listeners"), reply: { text: DEBUGGEE_XML } },
    { match: (c) => c.query?.method === "attach", reply: { text: ATTACH_XML } },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({ timeout: 1000 });
  const payload = JSON.parse(r.content[0].text);

  assert.equal(payload.caught, true);
  assert.equal(payload.attached, true);
  assert.equal(payload.debuggee.DEBUGGEE_ID, "DBG-9");
  assert.equal(payload.debuggee.DEBUGGEE_USER, "DEV");
  // second call is the attach, keyed by the debuggee id
  assert.equal(calls[1].query.method, "attach");
  assert.equal(calls[1].query.debuggeeId, "DBG-9");
});

test("adt_debug_listen: timeout → caught:false, call-again note (not an error)", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/listeners"),
      throw: new Error("ADT request timed out after 30000ms: POST /sap/bc/adt/debugger/listeners"),
    },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.caught, false);
  assert.match(payload.note, /call adt_debug_listen again/i);
});

test("adt_debug_listen: a listener conflict is reported, not thrown", async () => {
  const { ctx } = makeCtx([
    {
      match: (c) => c.path.endsWith("/listeners"),
      reply: { text: "<exc:exception><localizedMessage>Debug session already active</localizedMessage></exc:exception>" },
    },
  ]);
  const h = register(ctx);
  const r = await h.adt_debug_listen({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.caught, false);
  assert.match(payload.conflict, /already active/);
});

test("adt_debug_stack parses stack entries", async () => {
  const stackXml =
    '<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger">' +
    '<dbg:stackEntry uri="/sap/bc/adt/programs/programs/zfoo/source/main#start=5" line="5" programName="ZFOO" type="ABAP"/>' +
    '<dbg:stackEntry uri="/sap/bc/adt/oo/classes/zcl_bar/source/main#start=12" line="12" programName="ZCL_BAR" type="METHOD"/>' +
    "</dbg:stack>";
  const { ctx, calls } = makeCtx([{ match: (c) => c.path.endsWith("/stack"), reply: { text: stackXml } }]);
  const h = register(ctx);
  const r = await h.adt_debug_stack({});
  const payload = JSON.parse(r.content[0].text);
  assert.equal(calls[0].query.method, "getStack");
  assert.equal(payload.depth, 2);
  assert.equal(payload.stack[0].programName, "ZFOO");
  assert.equal(payload.stack[1].line, "12");
});

test("adt_debug_variables builds the getVariables body and parses values", async () => {
  const varsXml =
    '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>' +
    "<STPDA_ADT_VARIABLE><ID>sy-subrc</ID><NAME>SY-SUBRC</NAME><VALUE>0</VALUE></STPDA_ADT_VARIABLE>" +
    "<STPDA_ADT_VARIABLE><ID>lv_total</ID><NAME>LV_TOTAL</NAME><VALUE>42</VALUE></STPDA_ADT_VARIABLE>" +
    "</DATA></asx:values></asx:abap>";
  const { ctx, calls } = makeCtx([{ match: (c) => c.query?.method === "getVariables", reply: { text: varsXml } }]);
  const h = register(ctx);
  const r = await h.adt_debug_variables({ names: ["sy-subrc", "lv_total"] });
  const payload = JSON.parse(r.content[0].text);
  assert.match(calls[0].body, /<ID>sy-subrc<\/ID>/);
  assert.match(calls[0].body, /<ID>lv_total<\/ID>/);
  assert.equal(payload.variables.length, 2);
  assert.equal(payload.variables[0].VALUE, "0");
  assert.equal(payload.variables[1].NAME, "LV_TOTAL");
});

test("adt_debug_stop deletes the listener and tracked breakpoints", async () => {
  _internals.SESSION.breakpoints = [{ id: "BP-1", uri: "u" }, { id: "BP-2", uri: "u2" }];
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: "" } }]);
  const h = register(ctx);
  const r = await h.adt_debug_stop({});
  const payload = JSON.parse(r.content[0].text);
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.ok(deletes.some((c) => c.path.endsWith("/listeners")), "listener deleted");
  assert.equal(deletes.filter((c) => /\/breakpoints\//.test(c.path)).length, 2, "both breakpoints deleted");
  assert.deepEqual(payload.breakpointsDeleted, ["BP-1", "BP-2"]);
  assert.deepEqual(_internals.SESSION.breakpoints, []);
});

test("requestUser gating: another user is refused unless the system opts in", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }], { profile: { user: "DEV" } });
  const h = register(ctx);
  const r = await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5, requestUser: "OTHER" });
  assert.match(r.content[0].text, /refusing to debug another user/);
  assert.equal(calls.length, 0);
});

test("requestUser gating: allowed when debugAllowRequestUser is set", async () => {
  const { ctx, calls } = makeCtx([{ match: () => true, reply: { text: BP_XML } }], {
    profile: { user: "DEV", debugAllowRequestUser: true },
  });
  const h = register(ctx);
  await h.adt_debug_set_breakpoint({ object: "ZFOO", type: "program", line: 5, requestUser: "OTHER" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /requestUser="OTHER"/);
});
