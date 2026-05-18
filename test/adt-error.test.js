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

test("extracts LONGTEXT (HTML-stripped) and T100KEY fields from CTS lock conflict envelope (entry/key shape)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communication">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceConflict"/>
  <message lang="EN">Object components locked in request and separate task</message>
  <localizedMessage lang="EN">Object components locked in request and separate task</localizedMessage>
  <properties>
    <entry key="T100KEY-ID">SLOCK</entry>
    <entry key="T100KEY-NO">038</entry>
    <entry key="T100KEY-V1">E4DK900123</entry>
    <entry key="T100KEY-V2">DEVELOPER1</entry>
    <entry key="LONGTEXT"><![CDATA[<p>The components of object <b>ZCL_FOO</b> are locked in request <b>E4DK900123</b>.</p><p>Owner: <b>DEVELOPER1</b></p>]]></entry>
  </properties>
</exc:exception>`;
  const r = parseAdtError(xml, "application/xml");
  assert.equal(r.type, "ExceptionResourceConflict");
  assert.ok(r.properties, "properties should be present");
  assert.equal(r.properties.t100.id, "SLOCK");
  assert.equal(r.properties.t100.number, "038");
  assert.deepEqual(r.properties.t100.vars, ["E4DK900123", "DEVELOPER1"]);
  assert.ok(r.properties.longText.includes("E4DK900123"));
  assert.ok(r.properties.longText.includes("DEVELOPER1"));
  assert.ok(!r.properties.longText.includes("<b>"), "HTML tags should be stripped");
});

test("extracts properties from <property name=...> shape too", () => {
  const xml = `<exc:exception xmlns:exc="x">
    <type id="X"/>
    <message lang="EN">m</message>
    <property name="LONGTEXT">plain detail text</property>
    <property name="T100KEY-V1">VAL1</property>
  </exc:exception>`;
  const r = parseAdtError(xml, "application/xml");
  assert.equal(r.properties.longText, "plain detail text");
  assert.deepEqual(r.properties.t100.vars, ["VAL1"]);
});

test("non-recognized properties land in `other`", () => {
  const xml = `<exc:exception xmlns:exc="x">
    <type id="X"/>
    <message lang="EN">m</message>
    <properties>
      <entry key="CUSTOM-KEY">foo-bar</entry>
    </properties>
  </exc:exception>`;
  const r = parseAdtError(xml, "application/xml");
  assert.equal(r.properties.other["CUSTOM-KEY"], "foo-bar");
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
