// Pure helpers for adt_value_help: language-key mapping, fixed-value merging
// and check-table / text-table joining. The tool itself (src/tools/value-help.js)
// only fetches rows; everything that can be unit-tested lives here.

// DDIC text tables store the 1-character internal language key (SPRAS), while
// config profiles usually carry the 2-letter ISO code ("EN", "TR"). Map the
// common ones; unknown ISO codes fall back to their first letter, which is right
// for most Latin-script languages.
const ISO_TO_SAP = {
  AR: "A",
  BG: "W",
  CS: "C",
  DA: "K",
  DE: "D",
  EL: "G",
  EN: "E",
  ES: "S",
  FI: "U",
  FR: "F",
  HE: "B",
  HR: "6",
  HU: "H",
  IT: "I",
  JA: "J",
  KO: "3",
  NL: "N",
  NO: "O",
  PL: "L",
  PT: "P",
  RO: "4",
  RU: "R",
  SK: "Q",
  SL: "5",
  SV: "V",
  TH: "2",
  TR: "T",
  UK: "8",
  ZF: "M",
  ZH: "1",
};

export function sapLanguage(lang) {
  if (typeof lang !== "string") return "E";
  const v = lang.trim().toUpperCase();
  if (/^[A-Z0-9]$/.test(v)) return v;
  if (/^[A-Z]{2}$/.test(v)) return ISO_TO_SAP[v] ?? v[0];
  return "E";
}

// Merge DD07L (values) with DD07T (texts) by VALPOS. Texts in the requested
// language win; English fills the gaps so a value never comes back unlabeled
// just because it lacks a translation.
export function mergeFixedValues(valueRows, textRows, language) {
  const texts = new Map();
  for (const t of textRows ?? []) {
    const key = t.VALPOS;
    const prev = texts.get(key);
    if (!prev || (t.DDLANGUAGE === language && prev.DDLANGUAGE !== language)) {
      texts.set(key, t);
    }
  }
  return [...(valueRows ?? [])]
    .sort((a, b) => String(a.VALPOS).localeCompare(String(b.VALPOS)))
    .map((v) => {
      const t = texts.get(v.VALPOS);
      return {
        value: v.DOMVALUE_L,
        ...(v.DOMVALUE_H ? { high: v.DOMVALUE_H } : {}),
        text: t?.DDTEXT ?? null,
        ...(t && t.DDLANGUAGE !== language ? { textLanguage: t.DDLANGUAGE } : {}),
      };
    });
}

const CLIENT_DOMAINS = new Set(["MANDT", "CLNT"]);

function isClientField(name) {
  return name === "MANDT" || name === "CLIENT";
}

export function stripClient(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!isClientField(k)) out[k] = v;
  return out;
}

// Pick the text table's language field and the key fields shared with the check
// table from the text table's DD03L key rows.
export function textTableKeys(keyRows) {
  let languageField = null;
  const joinFields = [];
  for (const r of keyRows ?? []) {
    if (r.DOMNAME === "SPRAS" && !languageField) languageField = r.FIELDNAME;
    else if (!CLIENT_DOMAINS.has(r.DOMNAME) && !isClientField(r.FIELDNAME)) joinFields.push(r.FIELDNAME);
  }
  return { languageField, joinFields };
}

// Attach each check-table row's text-table entry (non-key columns only) as
// `texts`. Rows without a matching text keep `texts: null`.
export function attachTexts(checkRows, textRows, { languageField, joinFields }) {
  const hidden = new Set([...(joinFields ?? []), languageField, "MANDT", "CLIENT"]);
  const index = new Map();
  for (const t of textRows ?? []) {
    const key = joinFields.map((f) => t[f] ?? "").join("\u0000");
    if (!index.has(key)) index.set(key, t);
  }
  return (checkRows ?? []).map((row) => {
    const clean = stripClient(row);
    if (joinFields.length === 0 || joinFields.some((f) => !(f in row))) {
      return { ...clean, texts: null };
    }
    const t = index.get(joinFields.map((f) => row[f] ?? "").join("\u0000"));
    if (!t) return { ...clean, texts: null };
    const texts = {};
    for (const [k, v] of Object.entries(t)) if (!hidden.has(k)) texts[k] = v;
    return { ...clean, texts };
  });
}
