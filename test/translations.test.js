import { test } from "node:test";
import assert from "node:assert/strict";

import { pivot, languagesOf, completeness, latestVersions, renderDocLines, renderLongTexts } from "../src/translations.js";
import { isoLanguage } from "../src/value-help.js";
import { register } from "../src/tools/translations.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

test("isoLanguage reverses sapLanguage for known keys", () => {
  assert.equal(isoLanguage("E"), "EN");
  assert.equal(isoLanguage("T"), "TR");
  assert.equal(isoLanguage("1"), "ZH");
  assert.equal(isoLanguage("Z"), "Z");
});

test("pivot + completeness report missing languages per text", () => {
  const entries = pivot(
    [
      { K: "001", L: "E", V: "Saved" },
      { K: "001", L: "T", V: "Kaydedildi" },
      { K: "002", L: "E", V: "Deleted" },
      { K: "003", L: "T", V: "" },
    ],
    { keyOf: (r) => r.K, langOf: (r) => r.L, valueOf: (r) => r.V }
  );
  const languages = languagesOf(entries);
  assert.deepEqual(languages, ["EN", "TR"]);
  const { entries: marked, summary } = completeness(entries, languages);
  assert.deepEqual(marked, [
    { key: "001", values: { EN: "Saved", TR: "Kaydedildi" } },
    { key: "002", values: { EN: "Deleted" }, missing: ["TR"] },
    { key: "003", values: {}, missing: ["EN", "TR"] },
  ]);
  assert.deepEqual(summary, { texts: 3, complete: 1, perLanguage: { EN: 2, TR: 1 } });
});

test("languagesOf puts requested languages first even when absent", () => {
  assert.deepEqual(languagesOf([{ values: { DE: "x", EN: "y" } }], ["TR"]), ["TR", "DE", "EN"]);
});

test("latestVersions keeps the newest DOKHL version per object and language", () => {
  const latest = latestVersions([
    { OBJECT: "SV175", LANGU: "E", DOKVERSION: "0001" },
    { OBJECT: "SV175", LANGU: "E", DOKVERSION: "0002" },
    { OBJECT: "SV175", LANGU: "D", DOKVERSION: "0001" },
  ]);
  assert.equal(latest.get("SV175\u0000E"), "0002");
  assert.equal(latest.get("SV175\u0000D"), "0001");
});

test("renderDocLines turns SAPscript lines into plain text", () => {
  const text = renderDocLines([
    { LINE: "000003", DOKFORMAT: "", DOKTEXT: "is not supported here." },
    { LINE: "000001", DOKFORMAT: "U1", DOKTEXT: "&CAUSE&" },
    { LINE: "000002", DOKFORMAT: "AS", DOKTEXT: "The selected BC Set function" },
    { LINE: "000004", DOKFORMAT: "/:", DOKTEXT: "INCLUDE ZTEXT OBJECT DOKU" },
    { LINE: "000005", DOKFORMAT: "U1", DOKTEXT: "&WHAT_TO_DO&" },
    { LINE: "000006", DOKFORMAT: "B1", DOKTEXT: "Use SCPR20" },
    { LINE: "000007", DOKFORMAT: "=", DOKTEXT: " to create BC Sets." },
  ]);
  assert.equal(
    text,
    "Cause:\nThe selected BC Set function is not supported here.\nWhat to do:\n- Use SCPR20 to create BC Sets."
  );
});

test("renderLongTexts drops lines of older versions", () => {
  const latest = new Map([["SV175\u0000E", "0002"]]);
  const out = renderLongTexts(
    [
      { OBJECT: "SV175", LANGU: "E", DOKVERSION: "0001", LINE: "000001", DOKFORMAT: "AS", DOKTEXT: "old" },
      { OBJECT: "SV175", LANGU: "E", DOKVERSION: "0002", LINE: "000001", DOKFORMAT: "AS", DOKTEXT: "new" },
    ],
    latest
  );
  assert.deepEqual(out, [{ OBJECT: "SV175", LANGU: "E", TEXT: "new" }]);
});

test("adt_translations message: short texts, long text and missing languages", async () => {
  const c = sqlClient([
    [/FROM t100a/i, [{ ARBGB: "ZMSG" }]],
    [/FROM t100t/i, [{ SPRSL: "E", STEXT: "Demo messages" }]],
    [/FROM t100 WHERE/i, [
      { SPRSL: "E", MSGNR: "001", TEXT: "Order &1 saved" },
      { SPRSL: "T", MSGNR: "001", TEXT: "Sipariş &1 kaydedildi" },
    ]],
    [/FROM dokhl WHERE id = 'NA' AND object IN \('ZMSG001'\)/i, [{ OBJECT: "ZMSG001", LANGU: "E", DOKVERSION: "0001" }]],
    [/FROM doktl/i, [{ OBJECT: "ZMSG001", LANGU: "E", DOKVERSION: "0001", LINE: "000001", DOKFORMAT: "AS", DOKTEXT: "Details." }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ messageClass: "zmsg", number: "1" }));
  assert.equal(out.number, "001");
  assert.deepEqual(out.languages, ["EN", "TR"]);
  assert.deepEqual(out.texts, [{ key: "001", values: { EN: "Order &1 saved", TR: "Sipariş &1 kaydedildi" } }]);
  assert.deepEqual(out.longTexts, [{ key: "001", values: { EN: "Details." }, missing: ["TR"] }]);
  assert.equal(out.longTextSummary.complete, 0);
  assert.match(c.calls.find((x) => /FROM t100 WHERE/i.test(x.body)).body, /msgnr = '001'/);
});

test("adt_translations whole message class: description, no long texts by default, language filter", async () => {
  const c = sqlClient([
    [/FROM t100a/i, [{ ARBGB: "ZMSG" }]],
    [/FROM t100t/i, [{ SPRSL: "E", STEXT: "Demo messages" }]],
    [/FROM t100 WHERE/i, [
      { SPRSL: "E", MSGNR: "002", TEXT: "B" },
      { SPRSL: "E", MSGNR: "001", TEXT: "A" },
    ]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ messageClass: "ZMSG", languages: ["EN", "tr"] }));
  assert.deepEqual(out.languages, ["EN", "TR"]);
  assert.deepEqual(out.texts.map((t) => t.key), ["description", "001", "002"]);
  assert.deepEqual(out.texts[1].missing, ["TR"]);
  assert.equal(out.longTexts, undefined);
  assert.equal(c.calls.some((x) => /dokhl/i.test(x.body)), false);
  assert.match(c.calls.find((x) => /FROM t100 WHERE/i.test(x.body)).body, /sprsl IN \('E', 'T'\)/);
});

test("adt_translations message class long texts keep only exact message objects", async () => {
  const c = sqlClient([
    [/FROM t100a/i, [{ ARBGB: "ZM" }]],
    [/FROM t100 WHERE/i, [{ SPRSL: "E", MSGNR: "001", TEXT: "A" }]],
    [/FROM dokhl WHERE id = 'NA' AND object LIKE 'ZM%'/i, [
      { OBJECT: "ZM001", LANGU: "E", DOKVERSION: "0001" },
      { OBJECT: "ZMX001", LANGU: "E", DOKVERSION: "0001" },
    ]],
    [/FROM doktl/i, [{ OBJECT: "ZM001", LANGU: "E", DOKVERSION: "0001", LINE: "000001", DOKFORMAT: "AS", DOKTEXT: "Long." }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ messageClass: "ZM", longTexts: true }));
  assert.deepEqual(out.longTexts, [{ key: "001", values: { EN: "Long." } }]);
  assert.doesNotMatch(c.calls.find((x) => /doktl/i.test(x.body)).body, /ZMX001/);
});

test("adt_translations class: description, components and documentation", async () => {
  const c = sqlClient([
    [/FROM seoclass /i, [{ CLSNAME: "ZCL_X" }]],
    [/FROM seoclasstx/i, [{ LANGU: "E", DESCRIPT: "Demo" }, { LANGU: "D", DESCRIPT: "Demo" }]],
    [/FROM seocompotx/i, [{ CMPNAME: "RUN", LANGU: "E", DESCRIPT: "Run it" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ class: "ZCL_X" }));
  assert.deepEqual(out.languages, ["DE", "EN"]);
  assert.deepEqual(out.texts[1], { key: "RUN", values: { EN: "Run it" }, missing: ["DE"] });
  assert.deepEqual(out.longTexts, []);
});

test("adt_translations data element: one entry per label", async () => {
  const c = sqlClient([
    [/FROM dd04t/i, [
      { DDLANGUAGE: "E", DDTEXT: "Message number", REPTEXT: "MsgNo", SCRTEXT_S: "MsgNo", SCRTEXT_M: "Message", SCRTEXT_L: "Message" },
      { DDLANGUAGE: "T", DDTEXT: "İleti numarası", REPTEXT: "", SCRTEXT_S: "", SCRTEXT_M: "İleti", SCRTEXT_L: "" },
    ]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ dataElement: "MSGNR", longTexts: false }));
  assert.deepEqual(out.texts.map((t) => t.key), ["description", "heading", "short label", "medium label", "long label"]);
  assert.deepEqual(out.texts[1].missing, ["TR"]);
  assert.equal(out.summary.complete, 2);
});

test("adt_translations domain: description and fixed-value texts", async () => {
  const c = sqlClient([
    [/FROM dd01t/i, [{ DDLANGUAGE: "E", DDTEXT: "Status" }]],
    [/FROM dd07t/i, [{ VALPOS: "0001", DOMVALUE_L: "D", DDLANGUAGE: "E", DDTEXT: "Modifiable" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_translations({ domain: "TRSTATUS" }));
  assert.deepEqual(out.texts.map((t) => t.key), ["description", "value D"]);
  assert.equal(out.longTexts, undefined);
});

test("adt_translations rejects ambiguous or invalid input", async () => {
  const h = register(ctxFor({ E4D: sqlClient([]) }));
  assert.equal((await h.adt_translations({})).isError, true);
  assert.equal((await h.adt_translations({ class: "A", domain: "B" })).isError, true);
  assert.equal((await h.adt_translations({ class: "A", number: "1" })).isError, true);
  assert.equal((await h.adt_translations({ messageClass: "ZM", number: "12a" })).isError, true);
  assert.equal((await h.adt_translations({ messageClass: "ZM", languages: "EN" })).isError, true);
  const r = await h.adt_translations({ messageClass: "ZNOPE" });
  assert.match(r.content[0].text, /no message class ZNOPE/);
});
