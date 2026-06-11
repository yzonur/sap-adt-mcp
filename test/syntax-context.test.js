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
