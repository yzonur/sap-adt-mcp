import { test } from "node:test";
import assert from "node:assert/strict";

import { fieldKey, snapshot, diffRecord, diffKeyed, orderChanged, compareSnapshots } from "../src/ddic-compare.js";
import { register } from "../src/tools/ddic-compare.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

const FIELD = (name, pos, extra = {}) => ({
  FIELDNAME: name,
  POSITION: String(pos).padStart(4, "0"),
  KEYFLAG: "",
  ROLLNAME: name,
  DOMNAME: name,
  DATATYPE: "CHAR",
  LENG: "000010",
  DECIMALS: "000000",
  NOTNULL: "",
  CHECKTABLE: "",
  REFTABLE: "",
  REFFIELD: "",
  COMPTYPE: "E",
  PRECFIELD: "",
  ...extra,
});

const BASE = {
  header: { TABCLASS: "TRANSP", CLIDEP: "X", CONTFLAG: "A", MAINFLAG: "X", EXCLASS: "1" },
  fields: [
    FIELD("MANDT", 1, { KEYFLAG: "X", DATATYPE: "CLNT", LENG: "000003" }),
    FIELD("ID", 2, { KEYFLAG: "X" }),
    FIELD("TEXT", 3, { LENG: "000040" }),
    FIELD(".INCLUDE", 4, { PRECFIELD: "ZADMIN", ROLLNAME: "", DOMNAME: "" }),
  ],
  technical: { TABART: "APPL0", TABKAT: "0", BUFALLOW: "N", PUFFERUNG: "", SCHFELDANZ: "000", PROTOKOLL: "" },
  indexes: [{ INDEXNAME: "Z01", UNIQUEFLAG: "", DBINCLEXCL: "", DBSYSSEL1: "", DBSYSSEL2: "", DBSYSSEL3: "", DBSYSSEL4: "" }],
  indexFields: [
    { INDEXNAME: "Z01", POSITION: "0002", FIELDNAME: "ID" },
    { INDEXNAME: "Z01", POSITION: "0001", FIELDNAME: "MANDT" },
  ],
  foreignKeys: [{ FIELDNAME: "MANDT", CHECKTABLE: "T000", FRKART: "KEY", CARDLEFT: "1", CARD: "CN", CHECKFLAG: "" }],
  foreignKeyFields: [{ FIELDNAME: "MANDT", PRIMPOS: "0001", FORTABLE: "ZTAB", FORKEY: "MANDT", FORSTRING: "" }],
};

test("fieldKey separates .INCLUDE rows by the structure they include", () => {
  assert.equal(fieldKey({ FIELDNAME: "ID" }), "ID");
  assert.equal(fieldKey({ FIELDNAME: ".INCLUDE", PRECFIELD: "ZADMIN" }), ".INCLUDE ZADMIN");
});

test("snapshot normalizes zero-padded numbers and orders index fields", () => {
  const s = snapshot(BASE);
  assert.equal(s.fields.get("TEXT").length, "40");
  assert.equal(s.technical.genericKeyFields, "0");
  assert.deepEqual(s.order, ["MANDT", "ID", "TEXT", ".INCLUDE ZADMIN"]);
  assert.equal(s.indexes.get("Z01").fields, "MANDT, ID");
  assert.equal(s.foreignKeys.get("MANDT").assignment, "ZTAB-MANDT");
});

test("diffRecord and diffKeyed report only what differs", () => {
  assert.deepEqual(diffRecord({ a: "1", b: "2" }, { a: "1", b: "3" }), { b: { a: "2", b: "3" } });
  assert.deepEqual(diffRecord(null, null), {});
  const out = diffKeyed(
    new Map([
      ["X", { t: "1" }],
      ["Y", { t: "1" }],
    ]),
    new Map([
      ["Y", { t: "2" }],
      ["Z", { t: "1" }],
    ])
  );
  assert.deepEqual(out, {
    onlyInA: [{ name: "X", t: "1" }],
    onlyInB: [{ name: "Z", t: "1" }],
    changed: [{ name: "Y", changes: { t: { a: "1", b: "2" } } }],
  });
});

test("orderChanged ignores added fields and catches swapped ones", () => {
  assert.equal(orderChanged(["A", "B", "C"], ["A", "X", "B", "C"]), false);
  assert.equal(orderChanged(["A", "B", "C"], ["A", "C", "B"]), true);
});

test("compareSnapshots of identical definitions", () => {
  const out = compareSnapshots(snapshot(BASE), snapshot(BASE));
  assert.equal(out.identical, true);
  assert.equal(out.fields, undefined);
  assert.equal(out.counts.fieldsA, 4);
});

test("compareSnapshots finds field, technical, index and foreign key drift", () => {
  const b = {
    ...BASE,
    fields: [
      BASE.fields[0],
      BASE.fields[1],
      FIELD("TEXT", 3, { LENG: "000080" }),
      FIELD("STATUS", 4),
    ],
    technical: { ...BASE.technical, BUFALLOW: "X", PUFFERUNG: "G", SCHFELDANZ: "001" },
    indexes: [],
    indexFields: [],
    foreignKeys: [{ ...BASE.foreignKeys[0], CARD: "1" }],
  };
  const out = compareSnapshots(snapshot(BASE), snapshot(b));
  assert.equal(out.identical, false);
  assert.deepEqual(out.fields.changed, [{ name: "TEXT", changes: { length: { a: "40", b: "80" } } }]);
  assert.deepEqual(out.fields.onlyInA.map((f) => f.name), [".INCLUDE ZADMIN"]);
  assert.deepEqual(out.fields.onlyInB.map((f) => f.name), ["STATUS"]);
  assert.deepEqual(Object.keys(out.technicalSettings), ["bufferingAllowed", "bufferingType", "genericKeyFields"]);
  assert.deepEqual(out.indexes.onlyInA.map((i) => i.name), ["Z01"]);
  assert.deepEqual(out.foreignKeys.changed[0].changes, { cardinality: { a: "CN", b: "1" } });
  assert.equal(out.header, undefined);
});

function tableClient(def) {
  return sqlClient([
    [/FROM dd02l/i, def.header ? [def.header] : []],
    [/FROM dd03l/i, def.fields],
    [/FROM dd09l/i, def.technical ? [def.technical] : []],
    [/FROM dd12l/i, def.indexes],
    [/FROM dd17s/i, def.indexFields],
    [/FROM dd08l/i, def.foreignKeys],
    [/FROM dd05s/i, def.foreignKeyFields],
  ]);
}

test("adt_compare_ddic compares one table across two systems", async () => {
  const dev = tableClient(BASE);
  const qas = tableClient({ ...BASE, header: { ...BASE.header, CONTFLAG: "C" } });
  const h = register(ctxFor({ DEV: dev, QAS: qas }));
  const out = parse(await h.adt_compare_ddic({ systemA: "DEV", systemB: "QAS", table: "ztab" }));
  assert.equal(out.tableA, "ZTAB");
  assert.equal(out.tableB, "ZTAB");
  assert.deepEqual(out.header, { deliveryClass: { a: "A", b: "C" } });
  assert.match(dev.calls[0].body, /tabname = 'ZTAB'/);
});

test("adt_compare_ddic compares two tables on the same system", async () => {
  const c = tableClient(BASE);
  const h = register(ctxFor({ DEV: c }));
  const out = parse(await h.adt_compare_ddic({ systemA: "DEV", systemB: "DEV", table: "ZTAB", tableB: "ZTAB_COPY" }));
  assert.equal(out.identical, true);
  assert.ok(c.calls.some((x) => /'ZTAB_COPY'/.test(x.body)));
});

test("adt_compare_ddic reports a table missing on one side", async () => {
  const h = register(ctxFor({ DEV: tableClient(BASE), QAS: tableClient({ ...BASE, header: null }) }));
  const r = await h.adt_compare_ddic({ systemA: "DEV", systemB: "QAS", table: "ZTAB" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ZTAB on QAS/);
});

test("adt_compare_ddic rejects the same table on the same system and unsafe names", async () => {
  const h = register(ctxFor({ DEV: tableClient(BASE) }));
  assert.equal((await h.adt_compare_ddic({ systemA: "DEV", systemB: "DEV", table: "ZTAB" })).isError, true);
  assert.equal((await h.adt_compare_ddic({ systemA: "DEV", systemB: "DEV", table: "Z' OR 1=1" })).isError, true);
});

test("adt_compare_ddic surfaces a backend error with its side and stage", async () => {
  const bad = sqlClient([[/FROM dd02l/i, 400]]);
  const h = register(ctxFor({ DEV: tableClient(BASE), QAS: bad }));
  const r = await h.adt_compare_ddic({ systemA: "DEV", systemB: "QAS", table: "ZTAB" });
  assert.equal(r.isError, true);
  const body = parse(r);
  assert.equal(body.side, "B");
  assert.equal(body.stage, "header");
});
