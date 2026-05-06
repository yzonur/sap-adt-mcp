import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNodes, buildNodeStructureQuery } from "../src/node-structure.js";

const SAMPLE = `
<DATA>
  <SEU_ADT_REPOSITORY_OBJ_NODE>
    <OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>
    <OBJECT_NAME>ZCL_ALPHA</OBJECT_NAME>
    <DESCRIPTION>Alpha class</DESCRIPTION>
  </SEU_ADT_REPOSITORY_OBJ_NODE>
  <SEU_ADT_REPOSITORY_OBJ_NODE>
    <OBJECT_TYPE>DEVC/K</OBJECT_TYPE>
    <OBJECT_NAME>ZSUB_PKG</OBJECT_NAME>
    <DESCRIPTION>Subpackage with &amp; entity</DESCRIPTION>
  </SEU_ADT_REPOSITORY_OBJ_NODE>
</DATA>`;

test("parseNodes extracts type/name/description triples", () => {
  const nodes = parseNodes(SAMPLE);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], {
    type: "CLAS/OC",
    name: "ZCL_ALPHA",
    description: "Alpha class",
  });
});

test("parseNodes decodes HTML entities in description", () => {
  const nodes = parseNodes(SAMPLE);
  assert.equal(nodes[1].description, "Subpackage with & entity");
});

test("parseNodes ignores nodes missing type or name", () => {
  const xml =
    `<DATA><SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>X</OBJECT_TYPE></SEU_ADT_REPOSITORY_OBJ_NODE></DATA>`;
  assert.equal(parseNodes(xml).length, 0);
});

test("buildNodeStructureQuery produces expected query string", () => {
  const q = buildNodeStructureQuery("ZLOCAL").toString();
  assert.match(q, /parent_name=ZLOCAL/);
  assert.match(q, /parent_type=DEVC%2FK/);
  assert.match(q, /withShortDescriptions=true/);
});
