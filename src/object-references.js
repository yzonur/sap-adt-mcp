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

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
