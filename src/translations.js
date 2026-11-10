// Pure helpers for adt_translations: pivoting per-language text rows into
// one entry per text, finding the languages each text is missing in, picking
// the current long-text version and rendering SAPscript lines (DOKTL) as plain
// text. The tool itself (src/tools/translations.js) only fetches rows.

import { isoLanguage } from "./value-help.js";

// Pivot rows into [{ key, ...extra, values: { EN: "...", DE: "..." } }] in first-seen
// key order. `keyOf` names the text, `langOf` / `valueOf` read one row.
export function pivot(rows, { keyOf, langOf, valueOf, extraOf }) {
  const entries = new Map();
  for (const r of rows ?? []) {
    const key = keyOf(r);
    if (key == null) continue;
    if (!entries.has(key)) entries.set(key, { key, ...(extraOf ? extraOf(r) : {}), values: {} });
    const value = valueOf(r);
    if (value != null && value !== "") entries.get(key).values[isoLanguage(langOf(r))] = value;
  }
  return [...entries.values()];
}

// Languages that carry at least one text, in a stable order: the requested
// ones first, then the rest alphabetically.
export function languagesOf(entries, requested = []) {
  const found = new Set();
  for (const e of entries) for (const l of Object.keys(e.values)) found.add(l);
  return [...requested, ...[...found].filter((l) => !requested.includes(l)).sort()];
}

// Mark each entry with the languages (of `expected`) it has no text in, and
// summarize per language how many texts are present.
export function completeness(entries, expected) {
  const perLanguage = Object.fromEntries(expected.map((l) => [l, 0]));
  let complete = 0;
  const marked = entries.map((e) => {
    const missing = expected.filter((l) => !(l in e.values));
    for (const l of expected) if (l in e.values) perLanguage[l]++;
    if (missing.length === 0) complete++;
    return missing.length > 0 ? { ...e, missing } : e;
  });
  return { entries: marked, summary: { texts: entries.length, complete, perLanguage } };
}

// DOKHL can hold several versions per object and language; DOKTL is read for
// the newest one only. Returns Map("OBJECT\0LANGU" → version).
export function latestVersions(headerRows) {
  const latest = new Map();
  for (const r of headerRows ?? []) {
    const k = `${r.OBJECT}\u0000${r.LANGU}`;
    if (!latest.has(k) || Number(r.DOKVERSION) > Number(latest.get(k))) latest.set(k, r.DOKVERSION);
  }
  return latest;
}

// SAPscript text-symbol headings used by message and object documentation.
const HEADINGS = {
  "&CAUSE&": "Cause",
  "&SYSTEM_RESPONSE&": "System response",
  "&WHAT_TO_DO&": "What to do",
  "&SYS_ADMIN&": "System administration",
  "&DEFINITION&": "Definition",
  "&USE&": "Use",
  "&DEPENDENCIES&": "Dependencies",
  "&EXAMPLE&": "Example",
  "&FUNCTIONALITY&": "Functionality",
  "&RELATIONS&": "Relationships",
  "&NOTES&": "Notes",
  "&INTEGRATION&": "Integration",
  "&PREREQUISITES&": "Prerequisites",
  "&PURPOSE&": "Purpose",
  "&FEATURES&": "Features",
};

// Render DOKTL lines (already of one object / language / version) as plain
// text. Format "=" continues the previous line directly, a blank format
// continues it after a space, "/:" lines are SAPscript commands and dropped,
// bullet formats (B*) get "- ", every other format starts a new line.
export function renderDocLines(lines) {
  const sorted = [...(lines ?? [])].sort((a, b) => Number(a.LINE) - Number(b.LINE));
  const out = [];
  for (const l of sorted) {
    const format = (l.DOKFORMAT ?? "").trim();
    const raw = l.DOKTEXT ?? "";
    if (format === "/:") continue;
    const text = HEADINGS[raw.trim()] ? `${HEADINGS[raw.trim()]}:` : raw;
    if (format === "=" && out.length > 0) {
      out[out.length - 1] += text;
    } else if (format === "" && out.length > 0) {
      out[out.length - 1] += text ? ` ${text}` : "";
    } else {
      out.push(/^B\d$/.test(format) ? `- ${text}` : text);
    }
  }
  return out
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Group DOKTL rows by object + language (newest version only) and render each.
export function renderLongTexts(lineRows, latest) {
  const groups = new Map();
  for (const r of lineRows ?? []) {
    const k = `${r.OBJECT}\u0000${r.LANGU}`;
    if (latest.get(k) !== r.DOKVERSION) continue;
    if (!groups.has(k)) groups.set(k, { object: r.OBJECT, langu: r.LANGU, lines: [] });
    groups.get(k).lines.push(r);
  }
  return [...groups.values()].map((g) => ({ OBJECT: g.object, LANGU: g.langu, TEXT: renderDocLines(g.lines) }));
}
