import { test } from "node:test";
import assert from "node:assert/strict";
import { parseObjectReferences } from "../src/object-references.js";

test("extracts attributes of every objectReference element", () => {
  const xml = `
    <result>
      <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a"
        adtcore:type="CLAS/OC" adtcore:name="ZCL_A" adtcore:description="Alpha"/>
      <adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zprg"
        adtcore:type="PROG/P" adtcore:name="ZPRG" adtcore:description="Program"/>
    </result>`;
  const refs = parseObjectReferences(xml);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].name, "ZCL_A");
  assert.equal(refs[0].type, "CLAS/OC");
  assert.equal(refs[0].description, "Alpha");
});

test("handles attributes in any order and decodes entities", () => {
  const xml = `<adtcore:objectReference adtcore:name="ZX" adtcore:description="A &amp; B"/>`;
  const refs = parseObjectReferences(xml);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].description, "A & B");
});

test("empty input returns empty array", () => {
  assert.deepEqual(parseObjectReferences(""), []);
  assert.deepEqual(parseObjectReferences(null), []);
  assert.deepEqual(parseObjectReferences("<root/>"), []);
});

test("parseUsageReferences extracts adtObject entries from a where-used result (#73)", async () => {
  const { parseUsageReferences } = await import("../src/object-references.js");
  // Shape mirrors the usageReferences response: object info lives in the nested
  // <usageReferences:adtObject>, not a flat <adtcore:objectReference/>.
  const xml = `<?xml version="1.0"?>
    <usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences"
        xmlns:adtcore="http://www.sap.com/adt/core">
      <usageReferences:referencedObjects>
        <usageReferences:referencedObject uri="/sap/bc/adt/oo/classes/zcl_user">
          <usageReferences:adtObject adtcore:uri="/sap/bc/adt/oo/classes/zcl_user"
            adtcore:type="CLAS/OC" adtcore:name="ZCL_USER" adtcore:description="Uses it"/>
        </usageReferences:referencedObject>
        <usageReferences:referencedObject uri="/sap/bc/adt/programs/programs/zrep">
          <usageReferences:adtObject adtcore:uri="/sap/bc/adt/programs/programs/zrep"
            adtcore:type="PROG/P" adtcore:name="ZREP" adtcore:description="Also uses it"/>
        </usageReferences:referencedObject>
      </usageReferences:referencedObjects>
    </usageReferences:usageReferenceResult>`;
  const refs = parseUsageReferences(xml);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].name, "ZCL_USER");
  assert.equal(refs[0].type, "CLAS/OC");
  assert.equal(refs[1].name, "ZREP");
});

test("parseUsageReferences falls back to the flat objectReference shape", async () => {
  const { parseUsageReferences } = await import("../src/object-references.js");
  const xml = `<result><adtcore:objectReference adtcore:name="ZCL_OLD" adtcore:type="CLAS/OC"/></result>`;
  const refs = parseUsageReferences(xml);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "ZCL_OLD");
});
