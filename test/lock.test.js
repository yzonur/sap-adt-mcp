import { test } from "node:test";
import assert from "node:assert/strict";

import { acquireLock, releaseLock, extractLockHandle } from "../src/lock.js";

function makeClient(spy) {
  return {
    request: async (call) => {
      spy.calls.push(call);
      return spy.response;
    },
  };
}

const SUCCESS_BODY = `<?xml version="1.0"?><result xmlns="http://www.sap.com/adt/lock">
  <LOCK_HANDLE>HANDLE-1234</LOCK_HANDLE>
</result>`;

test("acquireLock keeps the old signature (string accessMode)", async () => {
  const spy = {
    calls: [],
    response: {
      ok: true,
      status: 200,
      headers: { get: () => "application/xml" },
      text: async () => SUCCESS_BODY,
    },
  };
  const r = await acquireLock(makeClient(spy), "/path", "EXCLUSIVE");
  assert.equal(r.ok, true);
  assert.equal(r.handle, "HANDLE-1234");
  assert.equal(spy.calls[0].query.accessMode, "EXCLUSIVE");
  assert.equal(spy.calls[0].query.corrNr, undefined);
});

test("acquireLock with options object forwards corrNr", async () => {
  const spy = {
    calls: [],
    response: {
      ok: true,
      status: 200,
      headers: { get: () => "application/xml" },
      text: async () => SUCCESS_BODY,
    },
  };
  await acquireLock(makeClient(spy), "/path", {
    accessMode: "MODIFY",
    corrNr: "E4DK900123",
  });
  assert.equal(spy.calls[0].query._action, "LOCK");
  assert.equal(spy.calls[0].query.accessMode, "MODIFY");
  assert.equal(spy.calls[0].query.corrNr, "E4DK900123");
});

test("acquireLock with no args defaults to MODIFY and no corrNr", async () => {
  const spy = {
    calls: [],
    response: {
      ok: true,
      status: 200,
      headers: { get: () => "application/xml" },
      text: async () => SUCCESS_BODY,
    },
  };
  await acquireLock(makeClient(spy), "/path");
  assert.equal(spy.calls[0].query.accessMode, "MODIFY");
  assert.equal(spy.calls[0].query.corrNr, undefined);
});

test("acquireLock surfaces the body on failure", async () => {
  const spy = {
    calls: [],
    response: {
      ok: false,
      status: 403,
      headers: { get: () => "application/xml" },
      text: async () => "<error/>",
    },
  };
  const r = await acquireLock(makeClient(spy), "/path");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.body, "<error/>");
});

test("extractLockHandle parses LOCK_HANDLE tag", () => {
  assert.equal(extractLockHandle(SUCCESS_BODY), "HANDLE-1234");
  assert.equal(extractLockHandle("<no/>"), null);
});

test("releaseLock unchanged shape", async () => {
  const spy = {
    calls: [],
    response: { ok: true, status: 200, headers: { get: () => "x" }, text: async () => "" },
  };
  await releaseLock(makeClient(spy), "/path", "H");
  assert.equal(spy.calls[0].query._action, "UNLOCK");
  assert.equal(spy.calls[0].query.lockHandle, "H");
});
