// Parse SAP ADT error envelopes.
//
// ADT typically returns failures as XML wrapped in <exc:exception>:
//   <exc:exception ... xmlns:exc="http://www.sap.com/abapxml/types/communication">
//     <namespace id="com.sap.adt"/>
//     <type id="ExceptionResourceFailure"/>
//     <message lang="EN">Object ZFOO does not exist</message>
//     <localizedMessage lang="EN">...</localizedMessage>
//     <properties>
//       <entry key="LONGTEXT"><![CDATA[<html>...full diagnostics...</html>]]></entry>
//       <entry key="T100KEY-ID">SLOCK</entry>
//       <entry key="T100KEY-NO">038</entry>
//       <entry key="T100KEY-V1">…blocking-transport id…</entry>
//       <entry key="T100KEY-V2">…</entry>
//       …
//     </properties>
//   </exc:exception>
//
// On CTS / SLOCK / S_LOCK errors, the properties carry the actual diagnostic
// (which TR blocks the lock, who owns it, suggested resolution). Older code
// dropped these — surface them as `properties.longText` and `properties.t100`.
//
// Some endpoints return abap-style messages instead — we fall through to a
// best-effort message extraction.

const TYPE_RE = /<type[^>]*id\s*=\s*"([^"]+)"/i;
const NS_RE = /<namespace[^>]*id\s*=\s*"([^"]+)"/i;
const MSG_RE = /<message[^>]*>([\s\S]*?)<\/message>/i;
const LOCAL_MSG_RE = /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/i;

// Match both <entry key="X">val</entry> and <property name="X">val</property>
// shapes — different ADT endpoints use different conventions.
const PROPERTY_RE =
  /<(?:entry|property)\b[^>]*\b(?:key|name)\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:entry|property)>/gi;

export function parseAdtError(body, contentType) {
  if (typeof body !== "string" || body.length === 0) return null;

  const isXml =
    (contentType && /xml/i.test(contentType)) ||
    body.trimStart().startsWith("<");

  if (!isXml) return null;

  const hasExceptionTag = /<\w*:?exception\b/i.test(body);
  if (!hasExceptionTag && !MSG_RE.test(body)) return null;

  const type = match(body, TYPE_RE);
  const namespace = match(body, NS_RE);
  const message = decode(match(body, MSG_RE));
  const localizedMessage = decode(match(body, LOCAL_MSG_RE));
  const props = extractProperties(body);

  if (!type && !message && !localizedMessage && !props) return null;

  return {
    type,
    namespace,
    message,
    localizedMessage: localizedMessage === message ? undefined : localizedMessage,
    ...(props ? { properties: props } : {}),
  };
}

function extractProperties(body) {
  const raw = {};
  let m;
  PROPERTY_RE.lastIndex = 0;
  while ((m = PROPERTY_RE.exec(body)) !== null) {
    const key = m[1];
    const value = stripCData(m[2]);
    if (key && value) raw[key] = decode(value).trim();
  }
  if (Object.keys(raw).length === 0) return null;

  const result = {};
  if (raw.LONGTEXT) {
    result.longText = stripHtml(raw.LONGTEXT);
  }
  const t100 = {};
  if (raw["T100KEY-ID"]) t100.id = raw["T100KEY-ID"];
  if (raw["T100KEY-NO"]) t100.number = raw["T100KEY-NO"];
  for (let i = 1; i <= 4; i++) {
    const v = raw[`T100KEY-V${i}`];
    if (v) {
      t100.vars = t100.vars || [];
      t100.vars.push(v);
    }
  }
  if (Object.keys(t100).length > 0) result.t100 = t100;

  // Anything else (e.g. CTS-specific properties) — keep as `other`.
  const other = {};
  for (const k of Object.keys(raw)) {
    if (k === "LONGTEXT" || k.startsWith("T100KEY-")) continue;
    other[k] = raw[k];
  }
  if (Object.keys(other).length > 0) result.other = other;

  return Object.keys(result).length > 0 ? result : null;
}

function stripCData(s) {
  if (!s) return s;
  const trimmed = s.trim();
  const m = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : trimmed;
}

function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function match(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : undefined;
}

function decode(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
