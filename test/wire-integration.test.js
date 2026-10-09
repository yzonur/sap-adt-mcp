// Wire-level tests: the real AdtClient against an undici MockAgent. The rest of
// the suite drives tools through fake clients; these pin the HTTP behaviour the
// fakes assume — CSRF retry, read-only enforcement, and the lock → PUT → unlock
// sequence of adt_set_source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

import { AdtClient, ReadOnlyViolationError } from "../src/adt-client.js";
import { register as registerSource } from "../src/tools/source.js";

const HOST = "http://sap.test:8000";
const LOCK_BODY = `<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>LH-1</LOCK_HANDLE></DATA></asx:values></asx:abap>`;

function setup() {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  return { mock, pool: mock.get(HOST) };
}

function client(extra = {}) {
  return new AdtClient({ host: HOST, user: "U", password: "P", client: "100", ...extra });
}

function discovery(pool, token, times = 1) {
  pool
    .intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery/ })
    .reply(200, "<x/>", { headers: { "x-csrf-token": token } })
    .times(times);
}

test("CSRF: a 403 'Required' refetches the token and retries the write once", async () => {
  const { mock, pool } = setup();
  discovery(pool, "OLD");
  discovery(pool, "NEW");
  const seen = [];
  pool
    .intercept({ method: "POST", path: /\/sap\/bc\/adt\/activation/ })
    .reply((req) => {
      seen.push(req.headers["x-csrf-token"]);
      return { statusCode: 403, data: "CSRF token validation failed", responseOptions: { headers: { "x-csrf-token": "Required" } } };
    });
  pool
    .intercept({ method: "POST", path: /\/sap\/bc\/adt\/activation/ })
    .reply((req) => {
      seen.push(req.headers["x-csrf-token"]);
      return { statusCode: 200, data: "<ok/>" };
    });

  const res = await client().request({ method: "POST", path: "/sap/bc/adt/activation", body: "<x/>" });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["OLD", "NEW"]);
  await mock.close();
});

test("CSRF: a plain 403 (no 'Required' header) is returned as-is, no retry", async () => {
  const { mock, pool } = setup();
  discovery(pool, "T");
  let posts = 0;
  pool
    .intercept({ method: "POST", path: /\/sap\/bc\/adt\/activation/ })
    .reply(() => {
      posts++;
      return { statusCode: 403, data: "No authorization" };
    });
  const res = await client().request({ method: "POST", path: "/sap/bc/adt/activation", body: "<x/>" });
  assert.equal(res.status, 403);
  assert.equal(posts, 1);
  await mock.close();
});

test("read-only: writes are refused before any network call, including via path traversal", async () => {
  const { mock } = setup(); // no intercepts: any request would fail disableNetConnect
  const ro = client({ readOnly: true });
  await assert.rejects(
    ro.request({ method: "PUT", path: "/sap/bc/adt/programs/programs/z/source/main", body: "x" }),
    ReadOnlyViolationError
  );
  await assert.rejects(
    ro.request({ method: "POST", path: "/sap/bc/adt/checkruns/../programs/programs/z", body: "x" }),
    ReadOnlyViolationError
  );
  await assert.rejects(ro.request({ method: "DELETE", path: "/sap/bc/adt/programs/programs/z" }), ReadOnlyViolationError);
  await mock.close();
});

test("read-only: an allow-listed read-only POST (Data Preview) still goes through", async () => {
  const { mock, pool } = setup();
  discovery(pool, "T");
  pool.intercept({ method: "POST", path: /\/sap\/bc\/adt\/datapreview\/freestyle/ }).reply(200, "<rows/>");
  const res = await client({ readOnly: true }).request({
    method: "POST",
    path: "/sap/bc/adt/datapreview/freestyle",
    body: "SELECT * FROM t000",
  });
  assert.equal(res.status, 200);
  await mock.close();
});

function sourceHandlers(adt) {
  return registerSource({ getClient: () => ({ name: "DEV", client: adt, profile: {} }) });
}

const OBJ = /\/sap\/bc\/adt\/programs\/programs\/ztest(\?|$)/;
const SRC = /\/sap\/bc\/adt\/programs\/programs\/ztest\/source\/main/;

test("adt_set_source: lock → PUT with the lock handle → unlock, in that order", async () => {
  const { mock, pool } = setup();
  discovery(pool, "T");
  const order = [];
  pool
    .intercept({ method: "POST", path: (p) => OBJ.test(p) && /_action=LOCK/.test(p) })
    .reply(() => (order.push("lock"), { statusCode: 200, data: LOCK_BODY }));
  pool
    .intercept({ method: "PUT", path: SRC })
    .reply((req) => {
      order.push(`put:${new URLSearchParams(req.path.split("?")[1]).get("lockHandle")}`);
      return { statusCode: 200, data: "" };
    });
  pool
    .intercept({ method: "POST", path: (p) => OBJ.test(p) && /_action=UNLOCK/.test(p) })
    .reply((req) => {
      order.push(`unlock:${new URLSearchParams(req.path.split("?")[1]).get("lockHandle")}`);
      return { statusCode: 200, data: "" };
    });

  const out = await sourceHandlers(client()).adt_set_source({
    object: "ZTEST",
    type: "program",
    source: "REPORT ztest.\nWRITE 'x'.\n",
  });
  assert.equal(out.isError, false, out.content[0].text);
  assert.deepEqual(order, ["lock", "put:LH-1", "unlock:LH-1"]);
  await mock.close();
});

test("adt_set_source: a failing PUT still releases the lock", async () => {
  const { mock, pool } = setup();
  discovery(pool, "T");
  const order = [];
  pool
    .intercept({ method: "POST", path: (p) => OBJ.test(p) && /_action=LOCK/.test(p) })
    .reply(() => (order.push("lock"), { statusCode: 200, data: LOCK_BODY }));
  pool
    .intercept({ method: "PUT", path: SRC })
    .reply(() => (order.push("put"), { statusCode: 500, data: "<exc:exception/>" }));
  pool
    .intercept({ method: "POST", path: (p) => OBJ.test(p) && /_action=UNLOCK/.test(p) })
    .reply(() => (order.push("unlock"), { statusCode: 200, data: "" }));

  const out = await sourceHandlers(client()).adt_set_source({
    object: "ZTEST",
    type: "program",
    source: "REPORT ztest.\n",
  });
  assert.equal(out.isError, true);
  assert.deepEqual(order, ["lock", "put", "unlock"]);
  await mock.close();
});

test("adt_set_source: an external lock handle skips lock and unlock", async () => {
  const { mock, pool } = setup();
  discovery(pool, "T");
  const order = [];
  pool.intercept({ method: "PUT", path: SRC }).reply(() => (order.push("put"), { statusCode: 200, data: "" }));

  const out = await sourceHandlers(client()).adt_set_source({
    object: "ZTEST",
    type: "program",
    source: "REPORT ztest.\n",
    lockHandle: "EXT-9",
  });
  assert.equal(out.isError, false, out.content[0].text);
  assert.deepEqual(order, ["put"]);
  await mock.close();
});
