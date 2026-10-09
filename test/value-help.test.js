import { test } from "node:test";
import assert from "node:assert/strict";

import { sapLanguage, mergeFixedValues, textTableKeys, attachTexts } from "../src/value-help.js";
import { sqlName } from "../src/data-preview.js";
import { register } from "../src/tools/value-help.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

test("sapLanguage maps ISO codes and passes SAP keys through", () => {
  assert.equal(sapLanguage("EN"), "E");
  assert.equal(sapLanguage("tr"), "T");
  assert.equal(sapLanguage("ZH"), "1");
  assert.equal(sapLanguage("D"), "D");
  assert.equal(sapLanguage("XX"), "X");
  assert.equal(sapLanguage(undefined), "E");
  assert.equal(sapLanguage("english"), "E");
});

test("sqlName accepts DDIC names and rejects anything that could break out of a literal", () => {
  assert.equal(sqlName("kna1"), "KNA1");
  assert.equal(sqlName("/FGLR/T001"), "/FGLR/T001");
  assert.equal(sqlName("A' OR '1' = '1"), null);
  assert.equal(sqlName("MARA; DELETE"), null);
  assert.equal(sqlName(""), null);
  assert.equal(sqlName("X".repeat(31)), null);
  assert.equal(sqlName(42), null);
});

test("mergeFixedValues prefers the requested language and falls back to English", () => {
  const values = [
    { VALPOS: "0002", DOMVALUE_L: "L", DOMVALUE_H: "" },
    { VALPOS: "0001", DOMVALUE_L: "D", DOMVALUE_H: "" },
    { VALPOS: "0003", DOMVALUE_L: "1", DOMVALUE_H: "9" },
  ];
  const texts = [
    { VALPOS: "0001", DDLANGUAGE: "E", DDTEXT: "Modifiable" },
    { VALPOS: "0001", DDLANGUAGE: "T", DDTEXT: "Değiştirilebilir" },
    { VALPOS: "0002", DDLANGUAGE: "E", DDTEXT: "Modifiable, protected" },
  ];
  assert.deepEqual(mergeFixedValues(values, texts, "T"), [
    { value: "D", text: "Değiştirilebilir" },
    { value: "L", text: "Modifiable, protected", textLanguage: "E" },
    { value: "1", high: "9", text: null },
  ]);
});

test("textTableKeys + attachTexts join check-table rows with their texts", () => {
  const keys = textTableKeys([
    { FIELDNAME: "MANDT", DOMNAME: "MANDT" },
    { FIELDNAME: "SPRAS", DOMNAME: "SPRAS" },
    { FIELDNAME: "LAND1", DOMNAME: "LAND1" },
  ]);
  assert.deepEqual(keys, { languageField: "SPRAS", joinFields: ["LAND1"] });

  const rows = attachTexts(
    [
      { MANDT: "300", LAND1: "TR", WAERS: "TRY" },
      { MANDT: "300", LAND1: "XX", WAERS: "" },
    ],
    [{ MANDT: "300", SPRAS: "E", LAND1: "TR", LANDX: "Türkiye" }],
    keys
  );
  assert.deepEqual(rows, [
    { LAND1: "TR", WAERS: "TRY", texts: { LANDX: "Türkiye" } },
    { LAND1: "XX", WAERS: "", texts: null },
  ]);
});

const TRSTATUS_ROUTES = [
  [/FROM dd04l/i, [{ ROLLNAME: "TRSTATUS", DOMNAME: "TRSTATUS" }]],
  [/FROM dd01l/i, [{ DOMNAME: "TRSTATUS", ENTITYTAB: "" }]],
  [
    /FROM dd07l/i,
    [
      { VALPOS: "0001", DOMVALUE_L: "D", DOMVALUE_H: "" },
      { VALPOS: "0004", DOMVALUE_L: "R", DOMVALUE_H: "" },
    ],
  ],
  [
    /FROM dd07t/i,
    [
      { VALPOS: "0001", DDLANGUAGE: "E", DDTEXT: "Modifiable" },
      { VALPOS: "0004", DDLANGUAGE: "E", DDTEXT: "Released" },
    ],
  ],
];

test("adt_value_help: data element → domain fixed values, no check table read", async () => {
  const client = sqlClient(TRSTATUS_ROUTES);
  const out = parse(await register(ctxFor({ E4D: client })).adt_value_help({ dataElement: "trstatus" }));
  assert.equal(out.resolved.domain, "TRSTATUS");
  assert.deepEqual(out.fixedValues.map((v) => v.value), ["D", "R"]);
  assert.equal(out.fixedValues[1].text, "Released");
  assert.equal(out.checkTableValues, undefined);
  // The language filter in DD07T uses the 1-char SAP key.
  assert.match(client.calls.find((c) => /dd07t/i.test(c.body)).body, /ddlanguage IN \('E', 'E'\)/);
});

test("adt_value_help: table field → check table + text table join, language from profile", async () => {
  const client = sqlClient([
    [/FROM dd03l WHERE tabname = 'KNA1'/i, [{ FIELDNAME: "LAND1", ROLLNAME: "LAND1_GP", DOMNAME: "LAND1", CHECKTABLE: "T005" }]],
    [/FROM dd01l/i, [{ DOMNAME: "LAND1", ENTITYTAB: "T005" }]],
    [/FROM dd08l/i, [{ TABNAME: "T005T" }]],
    [
      /FROM dd03l WHERE tabname = 'T005T'/i,
      [
        { FIELDNAME: "MANDT", DOMNAME: "MANDT" },
        { FIELDNAME: "SPRAS", DOMNAME: "SPRAS" },
        { FIELDNAME: "LAND1", DOMNAME: "LAND1" },
      ],
    ],
    [/FROM T005T WHERE SPRAS = 'T'/, [{ MANDT: "300", SPRAS: "T", LAND1: "TR", LANDX: "Türkiye" }]],
    [/FROM T005$/, [{ MANDT: "300", LAND1: "TR" }, { MANDT: "300", LAND1: "DE" }]],
  ]);
  const ctx = ctxFor({ E4D: client }, { profiles: { E4D: { language: "TR" } } });
  const out = parse(await register(ctx).adt_value_help({ table: "kna1", field: "land1", maxRows: 10 }));
  assert.equal(out.language, "T");
  assert.equal(out.resolved.checkTable, "T005");
  assert.equal(out.checkTableValues.textTable, "T005T");
  assert.deepEqual(out.checkTableValues.rows, [
    { LAND1: "TR", texts: { LANDX: "Türkiye" } },
    { LAND1: "DE", texts: null },
  ]);
  const checkCall = client.calls.find((c) => /FROM T005$/.test(c.body));
  assert.equal(checkCall.query.rowNumber, "10");
});

test("adt_value_help: field without fixed values or check table explains the search-help gap", async () => {
  const client = sqlClient([
    [/FROM dd03l/i, [{ FIELDNAME: "ERNAM", ROLLNAME: "ERNAM", DOMNAME: "USNAM", CHECKTABLE: "" }]],
    [/FROM dd01l/i, [{ DOMNAME: "USNAM", ENTITYTAB: "" }]],
  ]);
  const out = parse(await register(ctxFor({ E4D: client })).adt_value_help({ table: "VBAK", field: "ERNAM" }));
  assert.deepEqual(out.fixedValues, []);
  assert.match(out.note, /search help/);
});

test("adt_value_help: argument validation happens before any SAP call", async () => {
  const client = sqlClient([]);
  const h = register(ctxFor({ E4D: client }));
  for (const args of [
    {},
    { domain: "X", dataElement: "Y" },
    { table: "KNA1" },
    { domain: "X' OR 'A'='A" },
  ]) {
    const out = await h.adt_value_help(args);
    assert.equal(out.isError, true, JSON.stringify(args));
  }
  assert.equal(client.calls.length, 0);
});

test("adt_value_help: unknown data element is a clean error", async () => {
  const client = sqlClient([[/FROM dd04l/i, []]]);
  const out = await register(ctxFor({ E4D: client })).adt_value_help({ dataElement: "ZNOPE" });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no active data element ZNOPE/);
});
