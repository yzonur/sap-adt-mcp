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
