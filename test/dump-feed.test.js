import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDumpFeed, parseDumpDetail } from "../src/dump-feed.js";

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
