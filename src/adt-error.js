// Parse SAP ADT error envelopes.
//
// ADT typically returns failures as XML wrapped in <exc:exception>:
//   <exc:exception ... xmlns:exc="http://www.sap.com/abapxml/types/communication">
//     <namespace id="com.sap.adt"/>
//     <type id="ExceptionResourceFailure"/>
//     <message lang="EN">Object ZFOO does not exist</message>
//     <localizedMessage lang="EN">...</localizedMessage>
//   </exc:exception>
//
// Some endpoints return abap-style messages instead — we fall through to a
// best-effort message extraction.

const TYPE_RE = /<type[^>]*id\s*=\s*"([^"]+)"/i;
const NS_RE = /<namespace[^>]*id\s*=\s*"([^"]+)"/i;
const MSG_RE = /<message[^>]*>([\s\S]*?)<\/message>/i;
const LOCAL_MSG_RE = /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/i;

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

  if (!type && !message && !localizedMessage) return null;

  return {
    type,
    namespace,
    message,
    localizedMessage: localizedMessage === message ? undefined : localizedMessage,
  };
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
