// Wire-level tests for the access policy: the real AdtClient against an undici
// MockAgent, so the checks are proven to sit in front of the network — and to
// cover adt_request, which talks to the client directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

import { AdtClient, AccessPolicyViolationError } from "../src/adt-client.js";
import { register as registerRequest } from "../src/tools/request.js";

const HOST = "http://sap.test:8000";

function setup() {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  return { mock, pool: mock.get(HOST) };
}

function client(extra = {}, audit) {
  return new AdtClient({ host: HOST, user: "U", password: "P", client: "100", ...extra }, { audit });
}

function discovery(pool) {
  pool
    .intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery/ })
    .reply(200, "<x/>", { headers: { "x-csrf-token": "T" } });
}

function metadata(pool, objPath, pkg) {
  pool
    .intercept({ method: "GET", path: (p) => p.split("?")[0] === objPath })
    .reply(200, `<obj><adtcore:packageRef adtcore:uri="/x" adtcore:name="${pkg}"/></obj>`);
}

test("data preview of a default-blocked table is refused before any network call, even read-only", async () => {
  const { mock } = setup(); // no intercepts: any request would fail
  const audits = [];
  await assert.rejects(
    client({ readOnly: true }, (e) => audits.push(e)).request({
      method: "POST",
      path: "/sap/bc/adt/datapreview/freestyle",
      query: { rowNumber: "10" },
      body: "SELECT pernr, betrg01 FROM pa0008",
    }),
    (err) => err instanceof AccessPolicyViolationError && /PA0008/.test(err.message)
  );
  assert.equal(audits[0].outcome, "blocked-access-policy");
  await mock.close();
});

test("data preview of an ordinary table goes out", async () => {
  const { mock, pool } = setup();
  discovery(pool);
  pool.intercept({ method: "POST", path: /\/datapreview\/freestyle/ }).reply(200, "<ok/>");
  const res = await client({ readOnly: true }).request({
    method: "POST",
    path: "/sap/bc/adt/datapreview/freestyle",
    body: "SELECT * FROM t000",
  });
  assert.equal(res.status, 200);
  await mock.close();
});

test("allowDataPreview:false blocks adt_request's raw datapreview call too", async () => {
  const { mock } = setup();
  const c = client({ allowDataPreview: false });
  const tools = registerRequest({ getClient: () => ({ client: c, name: "DEV" }) });
  await assert.rejects(
    tools.adt_request({ method: "POST", path: "/sap/bc/adt/datapreview/freestyle", body: "SELECT * FROM t000" }),
    AccessPolicyViolationError
  );
  await mock.close();
});

test("allowedPackages: a write to an object in an allowed package goes out; the package lookup is cached", async () => {
  const { mock, pool } = setup();
  metadata(pool, "/sap/bc/adt/programs/programs/ZFOO", "ZDEV");
  discovery(pool);
  pool.intercept({ method: "POST", path: /_action=LOCK/ }).reply(200, "<lock/>");
  pool.intercept({ method: "PUT", path: /\/programs\/programs\/ZFOO\/source\/main/ }).reply(200, "");
  const c = client({ allowedPackages: ["Z*"] });
  await c.request({ method: "POST", path: "/sap/bc/adt/programs/programs/ZFOO", query: { _action: "LOCK" } });
  // Second write to the same object: no second metadata GET is intercepted, so
  // this only passes if the package came from the cache.
  const res = await c.request({ method: "PUT", path: "/sap/bc/adt/programs/programs/ZFOO/source/main", body: "REPORT zfoo." });
  assert.equal(res.status, 200);
  await mock.close();
});

test("allowedPackages: a write to an SAP-package object is refused, nothing written", async () => {
  const { mock, pool } = setup();
  metadata(pool, "/sap/bc/adt/programs/programs/RSPARAM", "STUN");
  const c = client({ allowedPackages: ["Z*", "$TMP"] });
  await assert.rejects(
    c.request({ method: "PUT", path: "/sap/bc/adt/programs/programs/RSPARAM/source/main", body: "x" }),
    (err) => err instanceof AccessPolicyViolationError && /package STUN is not in allowedPackages/.test(err.message)
  );
  await mock.close();
});

test("allowedPackages: create is attributed from the payload's packageRef", async () => {
  const { mock, pool } = setup();
  const c = client({ allowedPackages: ["$TMP"] });
  await assert.rejects(
    c.request({
      method: "POST",
      path: "/sap/bc/adt/oo/classes",
      body: '<class:abapClass adtcore:name="ZCL_X"><adtcore:packageRef adtcore:name="ZPROD"/></class:abapClass>',
    }),
    /package ZPROD is not in allowedPackages/
  );
  discovery(pool);
  pool.intercept({ method: "POST", path: /\/sap\/bc\/adt\/oo\/classes/ }).reply(201, "");
  const res = await c.request({
    method: "POST",
    path: "/sap/bc/adt/oo/classes",
    body: '<class:abapClass adtcore:name="ZCL_X"><adtcore:packageRef adtcore:name="$TMP"/></class:abapClass>',
  });
  assert.equal(res.status, 201);
  await mock.close();
});

test("allowedPackages: activation checks every object in the body", async () => {
  const { mock, pool } = setup();
  metadata(pool, "/sap/bc/adt/oo/classes/zcl_a", "ZDEV");
  metadata(pool, "/sap/bc/adt/oo/classes/cl_sap", "SABP");
  const c = client({ allowedPackages: ["Z*"] });
  await assert.rejects(
    c.request({
      method: "POST",
      path: "/sap/bc/adt/activation",
      body:
        '<adtcore:objectReferences><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a"/>' +
        '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/cl_sap"/></adtcore:objectReferences>',
    }),
    /package SABP/
  );
  await mock.close();
});

test("allowedPackages: an unresolvable package fails closed", async () => {
  const { mock, pool } = setup();
  pool.intercept({ method: "GET", path: /\/programs\/programs\/ZGONE/ }).reply(404, "not found");
  const c = client({ allowedPackages: ["Z*"] });
  await assert.rejects(
    c.request({ method: "DELETE", path: "/sap/bc/adt/programs/programs/ZGONE" }),
    /could not determine the package .* \(HTTP 404\)/
  );
  await mock.close();
});

test("allowedPackages: transport requests are not package-bound and pass", async () => {
  const { mock, pool } = setup();
  discovery(pool);
  pool.intercept({ method: "POST", path: /\/cts\/transportrequests/ }).reply(200, "<tr/>");
  const res = await client({ allowedPackages: ["Z*"] }).request({
    method: "POST",
    path: "/sap/bc/adt/cts/transportrequests",
    body: "<x/>",
  });
  assert.equal(res.status, 200);
  await mock.close();
});

test("no allowedPackages configured: writes are not looked up", async () => {
  const { mock, pool } = setup();
  discovery(pool);
  pool.intercept({ method: "PUT", path: /\/programs\/programs\/RSPARAM/ }).reply(200, "");
  const res = await client().request({ method: "PUT", path: "/sap/bc/adt/programs/programs/RSPARAM/source/main", body: "x" });
  assert.equal(res.status, 200);
  await mock.close();
});
