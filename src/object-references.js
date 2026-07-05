// Parse <adtcore:objectReference .../> entries that appear in many ADT responses
// (search results, where-used, transport contents, etc.).

const REF_RE = /<adtcore:objectReference\b([\s\S]*?)\/>/gi;
const ATTR_RE = /(\w[\w:-]*)\s*=\s*"([^"]*)"/g;

export function parseObjectReferences(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(REF_RE)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR_RE)) {
      const key = a[1].replace(/^adtcore:/, "");
      attrs[key] = decodeEntities(a[2]);
    }
    if (attrs.name || attrs.uri) out.push(attrs);
  }
  return out;
}

// The where-used / usageReferences response nests the referencing object inside
// <usageReferences:adtObject adtcore:name=… adtcore:type=… …> rather than the
// flat <adtcore:objectReference/> element the search endpoints use, so
// parseObjectReferences finds nothing in it. Extract each adtObject's adtcore
// attributes (prefix-agnostic — the server chooses the namespace prefix).
const ADTOBJ_RE = /<(?:[\w]+:)?adtObject\b([^>]*)>/gi;

export function parseUsageReferences(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(ADTOBJ_RE)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR_RE)) {
      const key = a[1].replace(/^adtcore:/, "");
      attrs[key] = decodeEntities(a[2]);
    }
    if (attrs.name || attrs.uri) out.push(attrs);
  }
  // Older systems emit the flat objectReference shape here too — fall back so a
  // response in either form is parsed.
  return out.length ? out : parseObjectReferences(xml);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
