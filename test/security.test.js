// Regression tests for the security findings closed in this change.
//
// 1. readOnly bypass via path traversal — was passing the raw path to
//    isReadOnlyPostPath, which used String.startsWith. new URL() then
//    collapsed "../" segments, so a write request could ride in under a
//    read-only allowlist prefix.
// 2. adt_request escape hatch hitting non-ADT endpoints — there was no
//    prefix enforcement, so /sap/opu/odata/... or /sap/bc/soap/rfc was
//    reachable with the configured SAP credentials.
// 3. caller-supplied headers overriding Authorization / Cookie / X-CSRF-Token
//    in adt_request.
// 4. transport_diff using SAP-returned URIs verbatim as request paths.
// 5. programType in object create — was concatenated into the XML body
//    without escaping and without validation, allowing XML attribute
//    injection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AdtClient, ReadOnlyViolationError } from "../src/adt-client.js";
import { buildCreateRequest } from "../src/object-create.js";

function makeClient(extra = {}) {
  return new AdtClient({
    host: "https://sap.example.com:44300",
    user: "DEVELOPER",
    password: "x",
    client: "100",
    readOnly: true,
    ...extra,
  });
}

test("readOnly: traversal under a read-only allowlist entry is rejected", async () => {
  const c = makeClient();
  // checkruns is on the read-only POST allowlist; the traversal escapes it.
  await assert.rejects(
    c.request({
      method: "PUT",
      path: "/sap/bc/adt/checkruns/../programs/programs/zfoo/source/main",
      body: "REPORT zfoo.",
    }),
    ReadOnlyViolationError
  );
});

test("readOnly: nodestructure traversal into transport release is rejected", async () => {
  const c = makeClient();
  await assert.rejects(
    c.request({
      method: "POST",
      path: "/sap/bc/adt/repository/nodestructure/../../cts/transportrequests/X/newreleasejobs",
    }),
    ReadOnlyViolationError
  );
});

test("readOnly: legitimate read-only POST still allowed (resolvePath returns canonical pathname)", () => {
  const c = makeClient();
  const resolved = c.resolvePath("/sap/bc/adt/repository/nodestructure?parent_name=ZP");
  assert.equal(resolved, "/sap/bc/adt/repository/nodestructure?parent_name=ZP");
});

test("resolvePath collapses traversal segments", () => {
  const c = makeClient();
  assert.equal(
    c.resolvePath("/sap/bc/adt/checkruns/../programs/programs/zfoo/source/main"),
    "/sap/bc/adt/programs/programs/zfoo/source/main"
  );
});

test("resolvePath rejects empty / non-string", () => {
  const c = makeClient();
  assert.throws(() => c.resolvePath(""), /non-empty/);
  assert.throws(() => c.resolvePath(null), /non-empty/);
});

test("readOnly off: writes to ADT proper still go through (no early throw)", async () => {
  // We don't want to actually make a network call. Just confirm the read-only
  // gate doesn't fire when readOnly is false; we expect a network-layer
  // failure later (which is fine — the point is the gate didn't reject).
  const c = makeClient({ readOnly: false });
  await assert.rejects(
    c.request({
      method: "PUT",
      path: "/sap/bc/adt/programs/programs/zfoo/source/main",
      body: "X",
    }),
    (err) => err.name !== "ReadOnlyViolationError"
  );
});

test("programType: invalid value rejected (XML injection defense)", () => {
  assert.throws(
    () =>
      buildCreateRequest({
        type: "program",
        name: "ZX",
        package: "ZP",
        // attribute-terminator + injected packageRef
        programType: 'executableProgram"><adtcore:packageRef adtcore:name="$TMP"/><!--',
      }),
    /Invalid programType/
  );
});

test("programType: known SAP values pass", () => {
  for (const t of ["executableProgram", "modulePool", "subroutinePool", "include"]) {
    const r = buildCreateRequest({
      type: "program",
      name: "ZX",
      package: "ZP",
      programType: t,
    });
    assert.match(r.body, new RegExp(`program:programType="${t}"`));
  }
});

test("programType: undefined defaults to executableProgram", () => {
  const r = buildCreateRequest({ type: "program", name: "ZX", package: "ZP" });
  assert.match(r.body, /program:programType="executableProgram"/);
});
