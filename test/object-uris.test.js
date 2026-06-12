import { test } from "node:test";
import assert from "node:assert/strict";
import { objectUri, sourceUri, normalizeType } from "../src/object-uris.js";

test("normalizeType maps friendly aliases to TADIR codes", () => {
  assert.equal(normalizeType("program"), "PROG");
  assert.equal(normalizeType("class"), "CLAS");
  assert.equal(normalizeType("interface"), "INTF");
  assert.equal(normalizeType("function"), "FUGR/FF");
  assert.equal(normalizeType("functiongroup"), "FUGR");
  assert.equal(normalizeType("cds"), "DDLS");
  assert.equal(normalizeType("accesscontrol"), "DCLS");
  assert.equal(normalizeType("behaviordef"), "BDEF");
});

test("normalizeType passes TADIR codes through unchanged (uppercased)", () => {
  assert.equal(normalizeType("PROG"), "PROG");
  assert.equal(normalizeType("FUGR/FF"), "FUGR/FF");
  assert.equal(normalizeType("clas"), "CLAS");
});

test("normalizeType throws on empty input", () => {
  assert.throws(() => normalizeType(""), /required/);
  assert.throws(() => normalizeType(undefined), /required/);
});

test("objectUri builds correct paths for common types", () => {
  assert.equal(
    objectUri({ type: "class", name: "ZCL_FOO" }),
    "/sap/bc/adt/oo/classes/zcl_foo"
  );
  assert.equal(
    objectUri({ type: "program", name: "ZHELLO" }),
    "/sap/bc/adt/programs/programs/zhello"
  );
  assert.equal(
    objectUri({ type: "interface", name: "ZIF_X" }),
    "/sap/bc/adt/oo/interfaces/zif_x"
  );
  assert.equal(
    objectUri({ type: "cds", name: "Z_VIEW" }),
    "/sap/bc/adt/ddic/ddl/sources/z_view"
  );
  assert.equal(
    objectUri({ type: "behaviordef", name: "Z_BO" }),
    "/sap/bc/adt/bo/behaviordefinitions/z_bo"
  );
});

test("function module URIs include the function group", () => {
  assert.equal(
    objectUri({ type: "function", name: "Z_DO_THING", group: "ZGROUP" }),
    "/sap/bc/adt/functions/groups/zgroup/fmodules/z_do_thing"
  );
});

test("function module without group throws", () => {
  assert.throws(
    () => objectUri({ type: "function", name: "Z_DO_THING" }),
    /group/
  );
});

test("sourceUri appends /source/main for source-bearing types", () => {
  assert.equal(
    sourceUri({ type: "program", name: "ZHELLO" }),
    "/sap/bc/adt/programs/programs/zhello/source/main"
  );
  assert.equal(
    sourceUri({ type: "interface", name: "ZIF_X" }),
    "/sap/bc/adt/oo/interfaces/zif_x/source/main"
  );
});

test("class source defaults to main include and supports alternates", () => {
  assert.equal(
    sourceUri({ type: "class", name: "ZCL_FOO" }),
    "/sap/bc/adt/oo/classes/zcl_foo/source/main"
  );
  assert.equal(
    sourceUri({ type: "class", name: "ZCL_FOO", include: "definitions" }),
    "/sap/bc/adt/oo/classes/zcl_foo/includes/definitions"
  );
  assert.equal(
    sourceUri({ type: "class", name: "ZCL_FOO", include: "testclasses" }),
    "/sap/bc/adt/oo/classes/zcl_foo/includes/testclasses"
  );
});

test("DTEL/DOMA/MSAG return object URI directly (no /source/main)", () => {
  assert.equal(
    sourceUri({ type: "dataelement", name: "ZDE" }),
    "/sap/bc/adt/ddic/dataelements/zde"
  );
  assert.equal(
    sourceUri({ type: "domain", name: "ZDO" }),
    "/sap/bc/adt/ddic/domains/zdo"
  );
  assert.equal(
    sourceUri({ type: "messageclass", name: "ZMSG" }),
    "/sap/bc/adt/messageclasses/zmsg"
  );
});

test("namespaced object names are URL-encoded", () => {
  assert.equal(
    objectUri({ type: "class", name: "/MYNS/ZCL_FOO" }),
    "/sap/bc/adt/oo/classes/%2Fmyns%2Fzcl_foo"
  );
});

test("unsupported type throws", () => {
  assert.throws(
    () => objectUri({ type: "fictional_type", name: "X" }),
    /Unsupported/
  );
});

test("METADATA_XML_ACCEPT covers the DDIC primitives that 406 on text/plain", async () => {
  const { METADATA_XML_ACCEPT } = await import("../src/object-uris.js");
  assert.equal(METADATA_XML_ACCEPT.DTEL, "application/vnd.sap.adt.dataelements.v2+xml");
  assert.equal(METADATA_XML_ACCEPT.DOMA, "application/vnd.sap.adt.domains.v2+xml");
  assert.equal(METADATA_XML_ACCEPT.MSAG, "application/vnd.sap.adt.messageclass.v2+xml");
  // The object URI for a data element is where the XML metadata is served.
  assert.equal(objectUri({ type: "dataelement", name: "KDIFF" }), "/sap/bc/adt/ddic/dataelements/kdiff");
});

test("objectUri throws a clear error when name is missing (guards against TypeError crash)", () => {
  // Regression: a caller passing `name`-less args (e.g. wrong field name) used
  // to crash with "Cannot read properties of undefined (reading 'toLowerCase')".
  assert.throws(() => objectUri({ type: "CLAS" }), /Object name is required/);
  assert.throws(() => objectUri({ type: "CLAS", name: "" }), /Object name is required/);
});

test("structures route to /ddic/structures (not /ddic/tables) — fixes the gap behind #13", () => {
  assert.equal(normalizeType("structure"), "STRU");
  assert.equal(normalizeType("STRU"), "STRU");
  // Object URI (used by lock / activate) and source URI (get/set source).
  assert.equal(objectUri({ type: "structure", name: "ZSFOO" }), "/sap/bc/adt/ddic/structures/zsfoo");
  assert.equal(sourceUri({ type: "structure", name: "ZSFOO" }), "/sap/bc/adt/ddic/structures/zsfoo/source/main");
  // Tables stay on their own endpoint.
  assert.equal(objectUri({ type: "table", name: "MARA" }), "/sap/bc/adt/ddic/tables/mara");
});
