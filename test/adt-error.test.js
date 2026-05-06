import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdtError } from "../src/adt-error.js";

const SAMPLE_ENVELOPE = `<?xml version="1.0" encoding="UTF-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communication">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceFailure"/>
  <message lang="EN">Object ZFOO does not exist</message>
  <localizedMessage lang="EN">Object ZFOO does not exist (localized)</localizedMessage>
</exc:exception>`;

test("parses the standard ADT exception envelope", () => {
  const r = parseAdtError(SAMPLE_ENVELOPE, "application/xml");
  assert.equal(r.type, "ExceptionResourceFailure");
  assert.equal(r.namespace, "com.sap.adt");
  assert.equal(r.message, "Object ZFOO does not exist");
  assert.equal(r.localizedMessage, "Object ZFOO does not exist (localized)");
});

test("returns null for non-XML inputs", () => {
  assert.equal(parseAdtError("plain error text", "text/plain"), null);
  assert.equal(parseAdtError("", "application/xml"), null);
  assert.equal(parseAdtError(null), null);
});

test("returns null when envelope and message are absent", () => {
  assert.equal(parseAdtError("<root><child/></root>", "application/xml"), null);
});

test("decodes HTML entities in message", () => {
  const xml =
    `<exc:exception xmlns:exc="x"><message lang="EN">Field &amp; Value &lt;X&gt;</message></exc:exception>`;
  const r = parseAdtError(xml, "application/xml");
  assert.equal(r.message, "Field & Value <X>");
});

test("omits localizedMessage when identical to message", () => {
  const xml =
    `<exc:exception xmlns:exc="x">` +
    `<message lang="EN">same</message>` +
    `<localizedMessage lang="EN">same</localizedMessage>` +
    `</exc:exception>`;
  const r = parseAdtError(xml, "application/xml");
  assert.equal(r.message, "same");
  assert.equal(r.localizedMessage, undefined);
});
