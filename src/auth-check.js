// Pure helpers for adt_auth_check: SU24 (USOBX_C / USOBT_C) grouping, the
// start authorization of a transaction (TSTCA), and a static scan of
// AUTHORITY-CHECK statements in ABAP source. The tool itself
// (src/tools/auth-check.js) only fetches rows and source.

// USOBX_C-OKFLAG. X / Y / N are the SU24 check indicators every release uses;
// any other value is passed through raw rather than guessed at.
const OKFLAG = {
  X: { check: true, proposal: true, meaning: "check, proposed for roles" },
  Y: { check: true, proposal: false, meaning: "check, not proposed" },
  N: { check: false, proposal: false, meaning: "check switched off" },
};

export function checkIndicator(okflag) {
  const known = OKFLAG[okflag];
  return known ? { okflag, ...known } : { okflag: okflag ?? "", meaning: "unknown check indicator" };
}

// One entry per authorization object: the USOBX_C check indicator plus the
// USOBT_C field proposals, field values collected per field.
export function groupSu24(indicatorRows, valueRows, textByObject = new Map()) {
  const objects = new Map();
  const ensure = (name) => {
    if (!objects.has(name)) objects.set(name, { object: name, fields: {} });
    return objects.get(name);
  };
  for (const r of indicatorRows ?? []) {
    if (!r.OBJECT) continue;
    Object.assign(ensure(r.OBJECT), checkIndicator(r.OKFLAG));
  }
  for (const r of valueRows ?? []) {
    if (!r.OBJECT || !r.FIELD) continue;
    const entry = ensure(r.OBJECT);
    const values = (entry.fields[r.FIELD] ??= []);
    if (r.LOW || r.HIGH) values.push(r.HIGH ? { low: r.LOW, high: r.HIGH } : r.LOW);
  }
  return [...objects.values()]
    .map((o) => ({ ...o, ...(textByObject.has(o.object) ? { text: textByObject.get(o.object) } : {}) }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

// TSTCA: the authorization checked when the transaction starts (on top of
// S_TCODE). Grouped to { object, fields: { FIELD: value } }.
export function groupStartAuth(rows) {
  const objects = new Map();
  for (const r of rows ?? []) {
    if (!r.OBJCT) continue;
    if (!objects.has(r.OBJCT)) objects.set(r.OBJCT, { object: r.OBJCT, fields: {} });
    if (r.FIELD) objects.get(r.OBJCT).fields[r.FIELD] = r.VALUE ?? "";
  }
  return [...objects.values()];
}

// Pick the requested language's text per object, English as fallback.
export function objectTexts(rows, language) {
  const out = new Map();
  for (const r of rows ?? []) {
    if (!r.OBJECT) continue;
    if (!out.has(r.OBJECT) || r.LANGU === language) out.set(r.OBJECT, r.TTEXT);
  }
  return out;
}

// Blank out comments while keeping every offset (and so every line number)
// intact: full-line '*' comments and '"' end-of-line comments outside literals.
export function stripComments(source) {
  const lines = String(source ?? "").split("\n");
  return lines
    .map((line) => {
      if (line.startsWith("*")) return " ".repeat(line.length);
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === "`" || c === "|") {
          quote = c;
        } else if (c === '"') {
          return line.slice(0, i) + " ".repeat(line.length - i);
        }
      }
      return line;
    })
    .join("\n");
}

const TOKEN_RE = /'(?:[^']|'')*'|`[^`]*`|[^\s'`.]+(?:\.[^\s'`.]+)*/g;

function literal(token) {
  if (!token) return { dynamic: true, expression: "" };
  if (/^'.*'$/s.test(token)) return { value: token.slice(1, -1).replace(/''/g, "'").trim() };
  if (/^`.*`$/s.test(token)) return { value: token.slice(1, -1).trim() };
  return { dynamic: true, expression: token };
}

// Find the end of a statement: the first '.' outside a literal.
function statementEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === "`") {
      quote = c;
    } else if (c === "." && !/[A-Za-z0-9_]/.test(text[i + 1] ?? "")) {
      return i;
    }
  }
  return text.length;
}

// Every AUTHORITY-CHECK OBJECT statement in the source: the object, each ID
// with its FIELD value (or DUMMY) and the 1-based line it starts on. Literals
// come back as `value`; variables as `{ dynamic: true, expression }`.
export function parseAuthorityChecks(source) {
  const text = stripComments(source);
  const results = [];
  const re = /\bAUTHORITY-CHECK\s+OBJECT\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = statementEnd(text, m.index + m[0].length);
    const body = text.slice(m.index + m[0].length, end);
    const tokens = body.match(TOKEN_RE) ?? [];
    const check = {
      line: text.slice(0, m.index).split("\n").length,
      object: literal(tokens[0]),
      fields: [],
    };
    for (let i = 1; i < tokens.length; i++) {
      const kw = tokens[i].toUpperCase();
      if (kw === "ID") {
        const id = literal(tokens[i + 1]);
        const next = (tokens[i + 2] ?? "").toUpperCase();
        if (next === "FIELD") {
          check.fields.push({ id, field: literal(tokens[i + 3]) });
          i += 3;
        } else if (next === "DUMMY") {
          check.fields.push({ id, dummy: true });
          i += 2;
        } else {
          check.fields.push({ id });
          i += 1;
        }
      } else if (kw === "FOR" && (tokens[i + 1] ?? "").toUpperCase() === "USER") {
        check.forUser = literal(tokens[i + 2]);
        i += 2;
      }
    }
    results.push(check);
    re.lastIndex = end;
  }
  return results;
}

// Collapse the static checks into one entry per literal object with the fields
// it is checked on and every line it appears on. Dynamic objects (a variable)
// stay separate — their object is only known at runtime.
export function summarizeChecks(checks) {
  const byObject = new Map();
  const dynamic = [];
  for (const c of checks) {
    if (c.object.dynamic) {
      dynamic.push(c);
      continue;
    }
    const name = c.object.value.toUpperCase();
    if (!byObject.has(name)) byObject.set(name, { object: name, fields: new Set(), lines: [] });
    const entry = byObject.get(name);
    entry.lines.push(c.line);
    for (const f of c.fields) if (f.id?.value) entry.fields.add(f.id.value.toUpperCase());
  }
  return {
    objects: [...byObject.values()]
      .map((e) => ({ object: e.object, fields: [...e.fields].sort(), lines: e.lines }))
      .sort((a, b) => a.object.localeCompare(b.object)),
    dynamic,
  };
}
