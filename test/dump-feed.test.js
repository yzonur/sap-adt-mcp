import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDumpFeed,
  parseDumpDetail,
  parseDumpMetadata,
  parseDumpChapters,
  CRITICAL_CHAPTER_KEYS,
} from "../src/dump-feed.js";

test("parseDumpFeed extracts entries with id, title, user, timestamp", () => {
  const xml = `
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:rba="http://www.sap.com/adt/rba">
      <entry>
        <id>https://sap.example.com/sap/bc/adt/runtime/dumps/00112233AABBCC</id>
        <title>MESSAGE_TYPE_X</title>
        <updated>2026-05-13T09:14:22Z</updated>
        <author><name>DEVELOPER</name></author>
        <summary>Runtime error raised by MESSAGE statement.</summary>
        <rba:host>sapdev01</rba:host>
        <rba:program>SAPLZTEST</rba:program>
        <rba:include>LZTESTU01</rba:include>
        <rba:line>42</rba:line>
      </entry>
      <entry>
        <id>https://sap.example.com/sap/bc/adt/runtime/dumps/00ABCDEF112233</id>
        <title>UNCAUGHT_EXCEPTION</title>
        <updated>2026-05-13T11:00:00Z</updated>
        <author><name>QAUSER</name></author>
      </entry>
    </feed>`;

  const entries = parseDumpFeed(xml);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].id, "00112233AABBCC");
  assert.equal(entries[0].title, "MESSAGE_TYPE_X");
  assert.equal(entries[0].user, "DEVELOPER");
  assert.equal(entries[0].updated, "2026-05-13T09:14:22Z");
  assert.equal(entries[0].fields["rba:host"], "sapdev01");
  assert.equal(entries[0].fields["rba:program"], "SAPLZTEST");
  assert.equal(entries[0].fields["rba:line"], "42");

  assert.equal(entries[1].id, "00ABCDEF112233");
  assert.equal(entries[1].user, "QAUSER");
});

test("parseDumpFeed returns empty array for empty / no-entries body", () => {
  assert.deepEqual(parseDumpFeed(""), []);
  assert.deepEqual(parseDumpFeed("<feed/>"), []);
});

test("parseDumpFeed decodes entities in title and summary", () => {
  const xml = `<entry><title>R &amp; D dump</title><summary>Error &lt;X&gt;</summary></entry>`;
  const [entry] = parseDumpFeed(xml);
  assert.equal(entry.title, "R & D dump");
  assert.equal(entry.summary, "Error <X>");
});

test("parseDumpFeed handles namespace-prefixed Atom entries (E4D shape)", () => {
  // Real SAP feeds tag every element with the atom: prefix.
  const xml = `
    <atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
      <atom:entry>
        <atom:id>https://host/sap/bc/adt/runtime/dump/ABC123</atom:id>
        <atom:updated>2026-05-13T10:00:00Z</atom:updated>
        <atom:author><atom:name>DEVUSER</atom:name></atom:author>
        <atom:category term="DATREF_NOT_ASSIGNED" label="ABAP runtime error"/>
        <atom:category term="/FOO/CL_BAR============CP" label="Terminated ABAP program"/>
      </atom:entry>
    </atom:feed>`;
  const [entry] = parseDumpFeed(xml);
  assert.equal(entry.id, "ABC123");
  assert.equal(entry.runtimeError, "DATREF_NOT_ASSIGNED");
  assert.equal(entry.program, "/FOO/CL_BAR============CP");
  assert.equal(entry.user, "DEVUSER");
  // Title falls back to runtimeError when <title> is absent.
  assert.equal(entry.title, "DATREF_NOT_ASSIGNED");
});

test("parseDumpDetail extracts id and rba fields", () => {
  const xml = `
    <rba:abapRuntimeError xmlns:rba="http://www.sap.com/adt/rba">
      <id>https://host/sap/bc/adt/runtime/dumps/ABC123</id>
      <title>MESSAGE_TYPE_X</title>
      <updated>2026-05-13T09:14:22Z</updated>
      <rba:errorClass>CX_FOO</rba:errorClass>
      <rba:program>SAPLZTEST</rba:program>
    </rba:abapRuntimeError>`;
  const detail = parseDumpDetail(xml);
  assert.equal(detail.id, "ABC123");
  assert.equal(detail.title, "MESSAGE_TYPE_X");
  assert.equal(detail.fields["rba:errorClass"], "CX_FOO");
  assert.equal(detail.fields["rba:program"], "SAPLZTEST");
});

test("parseDumpMetadata extracts links and dump fields", () => {
  const xml = `
    <dump:abapRuntimeError xmlns:dump="http://www.sap.com/adt/runtime/dump"
                            xmlns:atom="http://www.w3.org/2005/Atom">
      <dump:id>0123ABCDEF</dump:id>
      <dump:runtimeError>DATREF_NOT_ASSIGNED</dump:runtimeError>
      <dump:program>/FOO/CL_BAR============CP</dump:program>
      <dump:line>42</dump:line>
      <dump:link relation="contents"
                 uri="/sap/bc/adt/runtime/dump/0123ABCDEF/formatted"
                 contentType="text/plain"/>
      <dump:link relation="contents"
                 uri="/sap/bc/adt/runtime/dump/0123ABCDEF/unformatted"
                 contentType="text/plain"/>
    </dump:abapRuntimeError>`;
  const m = parseDumpMetadata(xml);
  assert.equal(m.id, "0123ABCDEF");
  assert.equal(m.fields["dump:runtimeError"], "DATREF_NOT_ASSIGNED");
  assert.equal(m.fields["dump:program"], "/FOO/CL_BAR============CP");
  assert.equal(m.fields["dump:line"], "42");
  assert.equal(m.links.length, 2);
  assert.equal(m.links[0].relation, "contents");
  assert.match(m.links[0].uri, /formatted$/);
  assert.equal(m.links[0].contentType, "text/plain");
});

test("parseDumpMetadata returns empty links array when none present", () => {
  const m = parseDumpMetadata("<dump:abapRuntimeError xmlns:dump=\"x\"><dump:id>X</dump:id></dump:abapRuntimeError>");
  assert.deepEqual(m.links, []);
});

test("parseDumpMetadata extracts root-element attributes (E4D shape)", () => {
  // Real on-prem ADT puts the dump payload as attributes on the root element,
  // not as child leaf elements. Title is a compound string; we keep it as-is.
  const xml = `
    <dump:dump xmlns:dump="http://www.sap.com/adt/runtime/dump"
               title="Runtime Error: DATREF_NOT_ASSIGNED 13.05.2026"
               error="DATREF_NOT_ASSIGNED"
               author="X-IKOCA"
               terminatedProgram="/FGLP/CL_AVL_UTIL=============CP"
               serverInstance="s4hanad_E4D_00"
               datetime="2026-05-13T10:09:41Z">
      <dump:link relation="contents" uri="/sap/bc/adt/runtime/dump/X/formatted"
                 contentType="text/plain"/>
    </dump:dump>`;
  const m = parseDumpMetadata(xml);
  assert.equal(m.runtimeError, "DATREF_NOT_ASSIGNED");
  assert.equal(m.program, "/FGLP/CL_AVL_UTIL=============CP");
  assert.equal(m.user, "X-IKOCA");
  assert.equal(m.time, "2026-05-13T10:09:41Z");
  assert.equal(m.server, "s4hanad_E4D_00");
  assert.match(m.title, /^Runtime Error/);
  // Root attributes are also stored in fields.
  assert.equal(m.fields.error, "DATREF_NOT_ASSIGNED");
  assert.equal(m.fields.terminatedProgram, "/FGLP/CL_AVL_UTIL=============CP");
  // xmlns declarations are filtered out of fields.
  assert.equal(m.fields.xmlns, undefined);
  assert.equal(m.fields["xmlns:dump"], undefined);
  assert.equal(m.links.length, 1);
});

test("parseDumpMetadata also surfaces leaf-form metadata to top level", () => {
  // Older / synthetic shape: leaf elements, no root attributes.
  const xml = `
    <dump:abapRuntimeError xmlns:dump="x">
      <dump:id>X</dump:id>
      <dump:runtimeError>FOO_BAR</dump:runtimeError>
      <dump:terminatedProgram>SAPLZ</dump:terminatedProgram>
      <dump:author>USR</dump:author>
    </dump:abapRuntimeError>`;
  const m = parseDumpMetadata(xml);
  assert.equal(m.runtimeError, "FOO_BAR");
  assert.equal(m.program, "SAPLZ");
  assert.equal(m.user, "USR");
});

test("parseDumpChapters splits known chapter titles", () => {
  const text = [
    "Short text",
    "    SQL error in CL_FOO method bar.",
    "What happened?",
    "    The exception CX_SY_ZERODIVIDE was raised.",
    "    Continuation lines stay in the chapter.",
    "Error analysis",
    "    Caused by division by zero in line 42.",
    "How to correct the error",
    "    Add a guard before the division.",
    "Source Code Extract",
    "    line 41: DATA(d) = a / b.",
    "    line 42: WRITE: d.",
  ].join("\n");
  const ch = parseDumpChapters(text);
  assert.ok(ch.shortText.includes("SQL error"));
  assert.ok(ch.whatHappened.includes("CX_SY_ZERODIVIDE"));
  assert.ok(ch.whatHappened.includes("Continuation lines"));
  assert.ok(ch.errorAnalysis.includes("division by zero"));
  assert.ok(ch.howToCorrect.includes("Add a guard"));
  assert.ok(ch.sourceCodeExtract.includes("line 42"));
});

test("parseDumpChapters handles boxed (pipe-wrapped) chapter format (E4D shape)", () => {
  const text = [
    "----------------------------------------------------------------------------------",
    "|Short Text                                                                      |",
    "|    Exception condition \"URL_PATH_IS_NOT_SUPPORTED\" triggered.                  |",
    "----------------------------------------------------------------------------------",
    "|What happened?                                                                  |",
    "|    The exception 'CX_FOO' was raised.                                          |",
    "----------------------------------------------------------------------------------",
    "|Source Code Extract                                                             |",
    "|    line 41: METHOD bar.                                                        |",
    "|    line 42:   RAISE EXCEPTION TYPE cx_foo.                                     |",
    "----------------------------------------------------------------------------------",
  ].join("\n");
  const ch = parseDumpChapters(text);
  assert.ok(ch.shortText, "shortText should be extracted from boxed format");
  assert.ok(ch.shortText.includes("URL_PATH_IS_NOT_SUPPORTED"));
  assert.ok(ch.whatHappened.includes("CX_FOO"));
  assert.ok(ch.sourceCodeExtract.includes("line 42"));
  // Separator lines (rules of dashes) must not bleed into the body.
  assert.equal(/----/.test(ch.shortText), false);
});

test("parseDumpChapters recognizes 'What can I do?' (not just 'you')", () => {
  // Real on-prem dumps phrase this chapter in the first person. The old
  // regex was anchored to "you" and the body leaked into whatHappened.
  const text = [
    "What happened?",
    "    The exception was raised.",
    "What can I do?",
    "    Note the user actions; reproduce with a debugger.",
    "Error analysis",
    "    Caused by a null reference.",
  ].join("\n");
  const ch = parseDumpChapters(text);
  assert.ok(ch.whatHappened.includes("exception was raised"));
  assert.equal(ch.whatHappened.includes("Note the user actions"), false);
  assert.ok(ch.whatCanYouDo);
  assert.ok(ch.whatCanYouDo.includes("Note the user actions"));
  assert.ok(ch.errorAnalysis.includes("null reference"));
});

test("parseDumpChapters ignores titles inside indented body (false-positive guard)", () => {
  const text = [
    "Short text",
    "    Some body text that mentions Error analysis but indented.",
    "    Should not start a new chapter.",
  ].join("\n");
  const ch = parseDumpChapters(text);
  assert.ok(ch.shortText.includes("Error analysis"));
  assert.equal(ch.errorAnalysis, undefined);
});

test("parseDumpChapters returns empty object on empty / non-string input", () => {
  assert.deepEqual(parseDumpChapters(""), {});
  assert.deepEqual(parseDumpChapters(null), {});
});

test("CRITICAL_CHAPTER_KEYS is the documented six-chapter set", () => {
  assert.deepEqual(CRITICAL_CHAPTER_KEYS, [
    "shortText",
    "whatHappened",
    "errorAnalysis",
    "howToCorrect",
    "whereTerminated",
    "sourceCodeExtract",
  ]);
});
