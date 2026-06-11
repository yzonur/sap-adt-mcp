import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSelect, parseDataPreview } from "../src/data-preview.js";

test("validateSelect accepts plain SELECT", () => {
  const r = validateSelect("SELECT matnr FROM mara WHERE matnr LIKE 'M%'");
  assert.equal(r.ok, true);
});

test("validateSelect accepts SELECT after leading ABAP comments", () => {
  const r = validateSelect(`* read materials\n" filter on plant\nSELECT matnr FROM mara`);
  assert.equal(r.ok, true);
});

test("validateSelect rejects non-SELECT statements", () => {
  for (const sql of [
    "UPDATE mara SET matnr = '1'",
    "DELETE FROM mara",
    "INSERT INTO mara VALUES ('X')",
    "DROP TABLE mara",
  ]) {
    const r = validateSelect(sql);
    assert.equal(r.ok, false, `should reject: ${sql}`);
  }
});

test("validateSelect rejects chained statements", () => {
  const r = validateSelect("SELECT matnr FROM mara; DELETE FROM mara");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Multiple statements/i);
});

test("validateSelect allows a trailing semicolon", () => {
  const r = validateSelect("SELECT matnr FROM mara;");
  assert.equal(r.ok, true);
});

test("validateSelect rejects empty / non-string", () => {
  assert.equal(validateSelect("").ok, false);
  assert.equal(validateSelect("   ").ok, false);
  assert.equal(validateSelect(null).ok, false);
});

test("validateSelect allows literal containing forbidden-looking word", () => {
  // 'EXEC' inside a string literal must not trip the guard — this was a real
  // false-positive in an earlier version that blocklisted CALL/EXEC tokens.
  const r = validateSelect("SELECT status FROM zjob WHERE status = 'EXEC'");
  assert.equal(r.ok, true);
});

test("parseDataPreview extracts columns and rows (shape A: <row><value>)", () => {
  const xml = `
    <dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
      <dataPreview:totalRows>2</dataPreview:totalRows>
      <dataPreview:executedQueryString>SELECT matnr matkl FROM mara</dataPreview:executedQueryString>
      <dataPreview:columns>
        <dataPreview:metadata dataPreview:name="MATNR" dataPreview:type="C"
            dataPreview:keyAttribute="true" dataPreview:colLength="40"/>
        <dataPreview:metadata dataPreview:name="MATKL" dataPreview:type="C"
            dataPreview:keyAttribute="false" dataPreview:colLength="9"/>
      </dataPreview:columns>
      <dataPreview:values>
        <dataPreview:row>
          <dataPreview:value>000000000000000001</dataPreview:value>
          <dataPreview:value>ZMG1</dataPreview:value>
        </dataPreview:row>
        <dataPreview:row>
          <dataPreview:value>000000000000000002</dataPreview:value>
          <dataPreview:value>ZMG2</dataPreview:value>
        </dataPreview:row>
      </dataPreview:values>
    </dataPreview:tableData>`;

  const p = parseDataPreview(xml);
  assert.equal(p.columns.length, 2);
  assert.equal(p.columns[0].name, "MATNR");
  assert.equal(p.columns[0].isKey, true);
  assert.equal(p.columns[1].name, "MATKL");
  assert.equal(p.columns[1].isKey, false);

  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].MATNR, "000000000000000001");
  assert.equal(p.rows[0].MATKL, "ZMG1");
  assert.equal(p.rows[1].MATKL, "ZMG2");

  assert.equal(p.totalRows, 2);
  assert.match(p.executedQuery, /SELECT matnr matkl/);
});

test("parseDataPreview handles shape B (flat <data columnName>)", () => {
  const xml = `
    <dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
      <dataPreview:columns>
        <dataPreview:metadata dataPreview:name="MATNR" dataPreview:type="C"/>
        <dataPreview:metadata dataPreview:name="MATKL" dataPreview:type="C"/>
      </dataPreview:columns>
      <dataPreview:dataSet>
        <dataPreview:data dataPreview:columnName="MATNR">000001</dataPreview:data>
        <dataPreview:data dataPreview:columnName="MATKL">ZMG1</dataPreview:data>
        <dataPreview:data dataPreview:columnName="MATNR">000002</dataPreview:data>
        <dataPreview:data dataPreview:columnName="MATKL">ZMG2</dataPreview:data>
      </dataPreview:dataSet>
    </dataPreview:tableData>`;
  const p = parseDataPreview(xml);
  assert.equal(p.columns.length, 2);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].MATNR, "000001");
  assert.equal(p.rows[1].MATKL, "ZMG2");
});

test("parseDataPreview returns empty rows when feed is empty", () => {
  const p = parseDataPreview("<dataPreview:tableData/>");
  assert.deepEqual(p.rows, []);
  assert.deepEqual(p.columns, []);
});

test("parseDataPreview handles shape C (column-major table.v1+xml)", () => {
  // The Accept: application/vnd.sap.adt.datapreview.table.v1+xml shape: one
  // <columns> block per column, each with its own <dataSet> of <data> cells.
  const xml = `
    <dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
      <dataPreview:totalRows>3</dataPreview:totalRows>
      <dataPreview:columns>
        <dataPreview:metadata dataPreview:name="FIELDNAME" dataPreview:type="C" dataPreview:description="Field"/>
        <dataPreview:dataSet>
          <dataPreview:data>KDIFF</dataPreview:data>
          <dataPreview:data>KWERT</dataPreview:data>
          <dataPreview:data>KBETR</dataPreview:data>
        </dataPreview:dataSet>
      </dataPreview:columns>
      <dataPreview:columns>
        <dataPreview:metadata dataPreview:name="ROLLNAME" dataPreview:type="C"/>
        <dataPreview:dataSet>
          <dataPreview:data>KDIFF</dataPreview:data>
          <dataPreview:data/>
          <dataPreview:data>KBETR</dataPreview:data>
        </dataPreview:dataSet>
      </dataPreview:columns>
    </dataPreview:tableData>`;
  const p = parseDataPreview(xml);
  assert.equal(p.columns.length, 2);
  assert.equal(p.totalRows, 3);
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].FIELDNAME, "KDIFF");
  assert.equal(p.rows[0].ROLLNAME, "KDIFF");
  assert.equal(p.rows[1].FIELDNAME, "KWERT");
  assert.equal(p.rows[1].ROLLNAME, ""); // self-closing <data/> -> empty cell
  assert.equal(p.rows[2].FIELDNAME, "KBETR");
});
