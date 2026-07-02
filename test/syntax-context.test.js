import { test } from "node:test";
import assert from "node:assert/strict";
import { toContextUri } from "../src/tools/quality.js";

test("toContextUri passes a full ADT path through unchanged", () => {
  assert.equal(
    toContextUri("/sap/bc/adt/functions/groups/v61a"),
    "/sap/bc/adt/functions/groups/v61a"
  );
  assert.equal(
    toContextUri("/sap/bc/adt/programs/programs/zmain"),
    "/sap/bc/adt/programs/programs/zmain"
  );
});

test("toContextUri treats a bare token as a program name", () => {
  assert.equal(
    toContextUri("ZMAIN"),
    "/sap/bc/adt/programs/programs/zmain"
  );
  assert.equal(
    toContextUri("  zrep  "),
    "/sap/bc/adt/programs/programs/zrep"
  );
});

test("toContextUri encodes a namespaced program name (not a URI) — #67", () => {
  // "/FGLR/R_PO_ASSET_CREATE" is a namespaced ABAP name, not an ADT URI: its
  // leading slash must not be mistaken for a ready path, or SAP 500s with
  // uriMappingError. Slashes become %2f inside the programs URI.
  assert.equal(
    toContextUri("/FGLR/R_PO_ASSET_CREATE"),
    "/sap/bc/adt/programs/programs/%2Ffglr%2Fr_po_asset_create"
  );
});
