// Parse ADT runtime-dumps Atom feed.
// The /sap/bc/adt/runtime/dumps endpoint returns an Atom feed where each
// <entry> represents one ST22-style short dump. SAP enriches entries with
// dump-specific elements in the rba (runtime / basis abap) namespace, but
// concrete element names vary across NetWeaver releases. We parse the Atom
// basics defensively and surface any rba:* fields as a map so the agent can
// see release-specific metadata without us hard-coding every name.

const ENTRY_RE = /<(?:[a-z]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?entry>/g;
const TAG_RE = (tag) =>
  new RegExp(`<(?:[a-z]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z]+:)?${tag}>`, "i");
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
    let title = pickFirst(inner, "title");
    const updated = pickFirst(inner, "updated");
    const published = pickFirst(inner, "published");
    const summary = pickFirst(inner, "summary");
    const categories = [];
    const catRe = /<(?:[a-z]+:)?category\b([^>]*)\/?>/gi;
    for (const cm of inner.matchAll(catRe)) {
      const attrs = cm[1];
      const term = attrs.match(/\bterm="([^"]*)"/i)?.[1];
      const label = attrs.match(/\blabel="([^"]*)"/i)?.[1];
      if (term) categories.push({ term: decodeEntities(term), label: label ? decodeEntities(label) : undefined });
    }
    const runtimeError = categories.find((c) => /runtime error/i.test(c.label ?? ""))?.term;
    const program = categories.find((c) => /terminated/i.test(c.label ?? ""))?.term;
    if (!title) title = runtimeError;
    const authorName = (() => {
      const author = inner.match(/<(?:[a-z]+:)?author\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?author>/i);
      if (!author) return undefined;
      const n = author[1].match(/<(?:[a-z]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?name>/i);
      return n ? decodeEntities(n[1].trim()) : undefined;
    })();
    const fields = parseExtensionFields(inner);
    entries.push({
      id: dumpId ?? id,
      title,
      runtimeError,
      program,
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

// Parse the application/vnd.sap.adt.runtime.dump.v1+xml metadata document.
// SAP returns a namespaced XML containing dump metadata (id, runtime error,
// program, include, line, timestamps) plus one or more <dump:link> entries
// that point at the actual dump text (formatted / unformatted). We extract
// the leaf metadata fields generically and surface every link so the agent —
// and our get_dump handler — can follow the right sub-resource.
const LINK_RE = /<(?:[a-z]+:)?link\b([^>]*)\/?>(?:\s*<\/(?:[a-z]+:)?link>)?/gi;

export function parseDumpMetadata(xml) {
  const fields = parseExtensionFields(xml);
  const id =
    pickFirst(xml, "id") ??
    fields["dump:id"] ??
    fields["rba:id"];
  const links = [];
  for (const m of xml.matchAll(LINK_RE)) {
    const attrs = m[1];
    const relation =
      attrs.match(/\b(?:relation|rel)="([^"]*)"/i)?.[1];
    const uri =
      attrs.match(/\b(?:uri|href)="([^"]*)"/i)?.[1];
    const contentType = attrs.match(/\bcontentType="([^"]*)"/i)?.[1];
    if (uri) links.push({ relation, uri: decodeEntities(uri), contentType });
  }
  return {
    id: id ? id.split("/").pop() : undefined,
    fields,
    links,
  };
}

// Parse a formatted ST22 dump text into a chapter map. ST22 formatted output
// uses chapter titles at column 0 followed by indented body text. We match a
// known set of English (and a few German) titles; everything between two
// title lines becomes the chapter body.
const CHAPTER_PATTERNS = [
  { key: "shortText", re: /^(?:Short\s*text|Kurztext)\b/i },
  { key: "whatHappened", re: /^(?:What\s*happened\??|Was\s*ist\s*passiert\??)\b/i },
  { key: "whatCanYouDo", re: /^What\s*can\s*you\s*do\??/i },
  { key: "errorAnalysis", re: /^(?:Error\s*analysis|Fehleranalyse)\b/i },
  { key: "howToCorrect", re: /^How\s*to\s*correct\b/i },
  { key: "whereTerminated", re: /^(?:Information\s*on\s*where\s*terminated|Where\s*terminated)\b/i },
  { key: "sourceCodeExtract", re: /^Source\s*Code\s*Extract\b/i },
  { key: "userAndTransaction", re: /^User\s*and\s*Transaction\b/i },
  { key: "activeCalls", re: /^Active\s*Calls.*Events\b/i },
  { key: "systemEnvironment", re: /^System\s*environment\b/i },
  { key: "systemFields", re: /^Contents\s*of\s*system\s*fields\b/i },
  { key: "internalNotes", re: /^Internal\s*notes\b/i },
  { key: "chosenVariables", re: /^Chosen\s*variables\b/i },
  { key: "directoryAppTables", re: /^Directory\s*of\s*Application\s*Tables\b/i },
  { key: "programsAffected", re: /^List\s*of\s*ABAP\s*programs\s*affected\b/i },
];

export const CRITICAL_CHAPTER_KEYS = [
  "shortText",
  "whatHappened",
  "errorAnalysis",
  "howToCorrect",
  "whereTerminated",
  "sourceCodeExtract",
];

export function parseDumpChapters(text) {
  if (typeof text !== "string" || text.length === 0) return {};
  const lines = text.split(/\r?\n/);
  const result = {};
  let current = null;
  for (const raw of lines) {
    // Titles sit at column 0 (no leading whitespace) and are not blank.
    const isTitleCandidate = raw.length > 0 && !/^\s/.test(raw);
    let matched = null;
    if (isTitleCandidate) {
      for (const c of CHAPTER_PATTERNS) {
        if (c.re.test(raw)) {
          matched = c.key;
          break;
        }
      }
    }
    if (matched) {
      if (current) result[current.key] = current.body.replace(/\n+$/, "");
      current = { key: matched, body: "" };
    } else if (current) {
      current.body += raw + "\n";
    }
  }
  if (current) result[current.key] = current.body.replace(/\n+$/, "");
  return result;
}
