// Parse ADT runtime-dumps Atom feed.
// The /sap/bc/adt/runtime/dumps endpoint returns an Atom feed where each
// <entry> represents one ST22-style short dump. SAP enriches entries with
// dump-specific elements in the rba (runtime / basis abap) namespace, but
// concrete element names vary across NetWeaver releases. We parse the Atom
// basics defensively and surface any rba:* fields as a map so the agent can
// see release-specific metadata without us hard-coding every name.

const ENTRY_RE = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
const TAG_RE = (tag) =>
  new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
// Leaf-only: content must not contain '<', so a wrapper like
// <rba:abapRuntimeError>...children...</rba:abapRuntimeError> is skipped and
// we descend into its children. Mixed-content elements (rare in ADT XML) are
// not captured — acceptable trade-off for not needing a full XML parser.
const NS_FIELD_RE = /<([a-z]+):([a-zA-Z0-9_]+)\b[^>]*>([^<]*)<\/\1:\2>/g;

const NS_BLOCKLIST = new Set(["atom", "adtcore", "app"]);

function pickFirst(xml, tag) {
  const m = xml.match(TAG_RE(tag));
  return m ? decodeEntities(m[1].trim()) : undefined;
}

function pickAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1]) : undefined;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseExtensionFields(xml) {
  const out = {};
  for (const m of xml.matchAll(NS_FIELD_RE)) {
    const ns = m[1];
    const name = m[2];
    if (NS_BLOCKLIST.has(ns)) continue;
    const value = decodeEntities(m[3].trim());
    if (!value) continue;
    out[`${ns}:${name}`] = value;
  }
  return out;
}

export function parseDumpFeed(xml) {
  const entries = [];
  for (const m of xml.matchAll(ENTRY_RE)) {
    const inner = m[1];
    const id = pickFirst(inner, "id");
    const dumpId = id ? id.split("/").pop() : undefined;
    const title = pickFirst(inner, "title");
    const updated = pickFirst(inner, "updated");
    const published = pickFirst(inner, "published");
    const summary = pickFirst(inner, "summary");
    const authorName = (() => {
      const author = inner.match(/<author\b[^>]*>([\s\S]*?)<\/author>/i);
      if (!author) return undefined;
      const n = author[1].match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
      return n ? decodeEntities(n[1].trim()) : undefined;
    })();
    const fields = parseExtensionFields(inner);
    entries.push({
      id: dumpId ?? id,
      title,
      updated: updated ?? published,
      user: authorName,
      summary,
      fields,
    });
  }
  return entries;
}

export function parseDumpDetail(xml) {
  // The detail response can be either an Atom entry or a richer rba-namespaced
  // document; surface what we can extract plus the raw body.
  const id = pickFirst(xml, "id") ?? pickAttr(xml, "rba:abapRuntimeError", "id");
  const title = pickFirst(xml, "title");
  const updated = pickFirst(xml, "updated") ?? pickFirst(xml, "published");
  const fields = parseExtensionFields(xml);
  return {
    id: id ? id.split("/").pop() : undefined,
    title,
    updated,
    fields,
  };
}
