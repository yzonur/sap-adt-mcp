import { test } from "node:test";
import assert from "node:assert/strict";

import { register as registerRequest } from "../src/tools/request.js";
import { register as registerTransports } from "../src/tools/transports.js";
import { register as registerLifecycle } from "../src/tools/lifecycle.js";
import { register as registerDiscovery } from "../src/tools/discovery.js";
import { register as registerData } from "../src/tools/data.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        resolvePath: (p) => p,
        request: async (call) => {
          calls.push(call);
          const r = responses ? responses[i++] ?? responses[responses.length - 1] : {
            ok: true,
            status: 200,
            headers: { get: () => "application/xml" },
            text: async () => "<ok/>",
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

// ─── Bug 1: adt_request contentType shortcut ──────────────────────────────────

test("adt_request: contentType shortcut sets Content-Type header", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerRequest(ctx);
  await h.adt_request({
    method: "POST",
    path: "/sap/bc/adt/foo",
    contentType: "application/vnd.sap.adt.domains.v2+xml",
    body: "<x/>",
  });
  assert.equal(
    calls[0].headers["Content-Type"],
    "application/vnd.sap.adt.domains.v2+xml"
  );
});

test("adt_request: explicit headers['Content-Type'] wins over contentType shortcut", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerRequest(ctx);
  await h.adt_request({
    method: "POST",
    path: "/sap/bc/adt/foo",
    contentType: "application/vnd.sap.adt.domains.v2+xml",
    headers: { "Content-Type": "application/xml" },
    body: "<x/>",
  });
  assert.equal(calls[0].headers["Content-Type"], "application/xml");
});

test("adt_request: no contentType → headers undisturbed", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerRequest(ctx);
  await h.adt_request({ method: "GET", path: "/sap/bc/adt/discovery" });
  assert.equal(calls[0].headers, undefined);
});

// ─── Bug 2: adt_get_transport / adt_release_transport validation ──────────────

test("adt_get_transport: missing transport → friendly error, no crash", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerTransports(ctx);
  const r = await h.adt_get_transport({ system: "E4D", transportId: "E4DK979456" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /transport.*required/i);
  assert.match(r.content[0].text, /transportId/);
  assert.equal(calls.length, 0);
});

test("adt_get_transport: valid transport upper-cases and calls correct path", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerTransports(ctx);
  await h.adt_get_transport({ transport: "e4dk900123" });
  assert.equal(
    calls[0].path,
    "/sap/bc/adt/cts/transportrequests/E4DK900123"
  );
});

test("adt_release_transport: missing transport → friendly error, no crash", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerTransports(ctx);
  const r = await h.adt_release_transport({});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /transport.*required/i);
  assert.equal(calls.length, 0);
});

// ─── Bug 4: adt_activate validation ───────────────────────────────────────────

test("adt_activate: missing objects → friendly error, no crash", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerLifecycle(ctx);
  const r = await h.adt_activate({ objectName: "ZCL_FOO", objectType: "CLAS" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /objects.*required/i);
  assert.match(r.content[0].text, /objectName|objectType/);
  assert.equal(calls.length, 0);
});

test("adt_activate: empty array → friendly error", async () => {
  const { ctx } = makeCtx();
  const h = registerLifecycle(ctx);
  const r = await h.adt_activate({ objects: [] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /non-empty/i);
});

test("adt_activate: item missing name/type → friendly error", async () => {
  const { ctx } = makeCtx();
  const h = registerLifecycle(ctx);
  const r = await h.adt_activate({ objects: [{ name: "X" }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /objects\[0\]/);
});

// ─── Bug 3: adt_search_objects quickSearch → legacy fallback ──────────────────

test("adt_search_objects: falls back when quickSearch service is missing", async () => {
  const { ctx, calls } = makeCtx({
    responses: [
      {
        ok: false,
        status: 500,
        headers: { get: () => "application/xml" },
        text: async () =>
          '<exc:exception><localizedMessage>No service found for ID quickSearch</localizedMessage></exc:exception>',
      },
      {
        ok: true,
        status: 200,
        headers: { get: () => "application/xml" },
        text: async () => "<empty/>",
      },
    ],
  });
  const h = registerDiscovery(ctx);
  const r = await h.adt_search_objects({ query: "ZCL*" });
  assert.ok(!r.isError, "fallback response should not be an error");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.operation, "quickSearch");
  assert.equal(calls[1].query.operation, undefined);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.operation, "legacy");
});

test("adt_search_objects: non-quickSearch 500 is not retried", async () => {
  const { ctx, calls } = makeCtx({
    responses: [
      {
        ok: false,
        status: 500,
        headers: { get: () => "application/xml" },
        text: async () => "<exc:exception>some other error</exc:exception>",
      },
    ],
  });
  const h = registerDiscovery(ctx);
  const r = await h.adt_search_objects({ query: "ZCL*" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1);
});

test("adt_search_objects: happy path doesn't retry", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  await h.adt_search_objects({ query: "ZCL*" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.operation, "quickSearch");
});

// ─── Bug A: adt_search_objects uses GET (POST → ris_request_type 400) ──────────

test("adt_search_objects: quickSearch goes over GET, not POST", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  await h.adt_search_objects({ query: "ZCL*" });
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[0].path,
    "/sap/bc/adt/repository/informationsystem/search"
  );
});

// ─── Bug C: adt_where_used request body + crash guard (#73/#74) ────────────────

test("adt_where_used: POSTs a usageReferenceRequest body so the server accepts it (#73)", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  await h.adt_where_used({ object: "/FGLR/S_MEAS_CHARACTERISTIC", type: "table" });
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].body, /usageReferenceRequest/, "body must carry the expected root element");
  assert.match(calls[0].body, /affectedObjects/);
  assert.equal(calls[0].headers["Content-Type"], "application/*");
});

test("adt_where_used: a function module without group returns a clean error, not a crash (#74)", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerDiscovery(ctx);
  const r = await h.adt_where_used({ object: "/FGLR/DELIVERY_CREATE", type: "FUGR/FF" });
  assert.match(r.content[0].text, /pass 'group'/);
  assert.equal(calls.length, 0, "must not issue a request when the URI can't be built");
});

// ─── Bug B: adt_read_table sends the data-preview table Accept header ──────────

test("adt_read_table: POSTs with the data-preview table Accept header", async () => {
  const { ctx, calls } = makeCtx({
    responses: [
      {
        ok: true,
        status: 200,
        headers: { get: () => "application/xml" },
        text: async () => "<dataPreview:tableData/>",
      },
    ],
  });
  const h = registerData(ctx);
  await h.adt_read_table({ query: "SELECT vclname FROM vcldir" });
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls[0].accept,
    "application/vnd.sap.adt.datapreview.table.v1+xml"
  );
  assert.equal(calls[0].headers["Content-Type"], "text/plain; charset=utf-8");
});

// ─── Bug: adt_create_transport sent tm:target="" → opaque 500 (#63) ──────────

test("adt_create_transport: no target omits tm:target entirely (not tm:target='')", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerTransports(ctx);
  await h.adt_create_transport({ description: "FIT Service WO fix" });
  const body = calls[0].body;
  assert.doesNotMatch(body, /tm:target/, "blank target must not be emitted");
  assert.match(body, /tm:desc="FIT Service WO fix"/);
  assert.match(body, /tm:type="K"/);
});

test("adt_create_transport: a real target is emitted (trimmed)", async () => {
  const { ctx, calls } = makeCtx();
  const h = registerTransports(ctx);
  await h.adt_create_transport({ description: "d", target: "  LOCAL  " });
  assert.match(calls[0].body, /tm:target="LOCAL"/);
});
