import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreateRequest } from "../src/object-create.js";

test("missing name or package throws", () => {
  assert.throws(() => buildCreateRequest({ type: "class" }), /name/);
  assert.throws(
    () => buildCreateRequest({ type: "class", name: "ZCL_X" }),
    /package/
  );
});

test("unsupported type throws with hint", () => {
  assert.throws(
    () => buildCreateRequest({ type: "tabl", name: "ZX", package: "ZP" }),
    /not supported/
  );
});

test("class create posts to oo/classes with v3 content type", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "zcl_alpha",
    package: "zlocal",
    description: "Alpha class",
  });
  assert.equal(r.path, "/sap/bc/adt/oo/classes");
  assert.match(r.contentType, /oo\.classes\.v3\+xml/);
  assert.match(r.body, /adtcore:name="ZCL_ALPHA"/);
  assert.match(r.body, /adtcore:type="CLAS\/OC"/);
  assert.match(r.body, /adtcore:packageRef adtcore:name="ZLOCAL"/);
  assert.match(r.body, /adtcore:description="Alpha class"/);
});

test("interface create posts to oo/interfaces", () => {
  const r = buildCreateRequest({
    type: "interface",
    name: "ZIF_X",
    package: "ZPKG",
  });
  assert.equal(r.path, "/sap/bc/adt/oo/interfaces");
  assert.match(r.body, /adtcore:type="INTF\/OI"/);
});

test("program create defaults to executableProgram type", () => {
  const r = buildCreateRequest({
    type: "program",
    name: "ZHELLO",
    package: "ZPKG",
  });
  assert.equal(r.path, "/sap/bc/adt/programs/programs");
  assert.match(r.body, /program:programType="executableProgram"/);
});

test("program create accepts modulePool override", () => {
  const r = buildCreateRequest({
    type: "program",
    name: "ZHELLO",
    package: "ZPKG",
    programType: "modulePool",
  });
  assert.match(r.body, /program:programType="modulePool"/);
});

test("function module create needs group and posts under it", () => {
  assert.throws(
    () =>
      buildCreateRequest({
        type: "function",
        name: "Z_FM",
        package: "ZPKG",
      }),
    /group/
  );
  const r = buildCreateRequest({
    type: "function",
    name: "Z_FM",
    package: "ZPKG",
    group: "ZGROUP",
  });
  assert.equal(r.path, "/sap/bc/adt/functions/groups/zgroup/fmodules");
  assert.match(r.body, /adtcore:type="FUGR\/FF"/);
  assert.match(r.body, /containerRef[^>]*adtcore:name="ZGROUP"/);
});

test("CDS / DCLS / DDLX / BDEF / MSAG endpoints route correctly", () => {
  assert.equal(
    buildCreateRequest({ type: "cds", name: "Z_V", package: "ZP" }).path,
    "/sap/bc/adt/ddic/ddl/sources"
  );
  assert.equal(
    buildCreateRequest({ type: "accesscontrol", name: "Z_AC", package: "ZP" }).path,
    "/sap/bc/adt/acm/dcls"
  );
  assert.equal(
    buildCreateRequest({ type: "metadataext", name: "Z_MX", package: "ZP" }).path,
    "/sap/bc/adt/ddic/ddlx/sources"
  );
  assert.equal(
    buildCreateRequest({ type: "behaviordef", name: "Z_BD", package: "ZP" }).path,
    "/sap/bc/adt/bo/behaviordefinitions"
  );
  assert.equal(
    buildCreateRequest({ type: "messageclass", name: "Z_MSG", package: "ZP" }).path,
    "/sap/bc/adt/messageclasses"
  );
});

test("description longer than 60 chars is truncated", () => {
  const long = "x".repeat(120);
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    description: long,
  });
  const m = r.body.match(/adtcore:description="([^"]*)"/);
  assert.ok(m);
  assert.equal(m[1].length, 60);
});

test("XML special characters in description are escaped", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    description: "A & B <C>",
  });
  assert.match(r.body, /adtcore:description="A &amp; B &lt;C&gt;"/);
});

test("responsible attribute included when provided", () => {
  const r = buildCreateRequest({
    type: "class",
    name: "ZCL_X",
    package: "ZP",
    responsible: "developer",
  });
  assert.match(r.body, /adtcore:responsible="DEVELOPER"/);
});
