// SAP ADT Data Preview endpoint helpers.
//
// The /sap/bc/adt/datapreview/freestyle endpoint accepts an OpenSQL SELECT
// statement and returns column metadata + rows in a dataPreview-namespaced
// XML document. The exact shape varies slightly across releases:
//
//   <dataPreview:tableData>
//     <dataPreview:columns>
//       <dataPreview:metadata dataPreview:name="MATNR" dataPreview:type="C" ... />
//       ...
//     </dataPreview:columns>
//     <dataPreview:values>
//       <dataPreview:row>
//         <dataPreview:value>...</dataPreview:value>
//         ...
//       </dataPreview:row>
//     </dataPreview:values>
//   </dataPreview:tableData>
//
// Older releases emit a flat <dataPreview:dataSet> with
// <dataPreview:data columnName="X">value</dataPreview:data> per cell — we
// handle both.

// Client-side guard. The SAP /datapreview/freestyle endpoint already enforces
// SELECT-only on the server side, but we add a cheap sanity check so callers
// fail fast and obvious mistakes don't burn a round-trip. We don't try to
// fully parse OpenSQL — we just confirm the statement starts with SELECT and
// doesn't chain a second statement via ";".
export function validateSelect(query) {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, reason: "Query is empty." };
  }
  // Strip leading line comments (ABAP: " or *).
  let stripped = query.trim();
  while (true) {
    const before = stripped;
    stripped = stripped.replace(/^\s*(?:"|\*)[^\n]*\n/, "").trimStart();
    if (stripped === before) break;
  }
  if (!/^SELECT\b/i.test(stripped)) {
    return { ok: false, reason: "Only SELECT statements are allowed." };
  }
  // Reject a semicolon followed by more non-trivial content (statement chain).
  const withoutTrailingSemi = stripped.replace(/;\s*$/, "");
  if (/;\s*\S/.test(withoutTrailingSemi)) {
    return { ok: false, reason: "Multiple statements are not allowed." };
  }
  return { ok: true };
}

const METADATA_RE =
  /<[a-zA-Z]+:metadata\b([^/]*)\/>|<[a-zA-Z]+:metadata\b([^>]*)>[\s\S]*?<\/[a-zA-Z]+:metadata>/g;
const ROW_RE = /<[a-zA-Z]+:row\b[^>]*>([\s\S]*?)<\/[a-zA-Z]+:row>/g;
const VALUE_RE = /<[a-zA-Z]+:value\b[^>]*>([\s\S]*?)<\/[a-zA-Z]+:value>/g;
const DATA_CELL_RE =
  /<[a-zA-Z]+:data\b[^>]*\b(?:dataPreview:)?columnName="([^"]+)"[^>]*>([\s\S]*?)<\/[a-zA-Z]+:data>/g;
// Column-major table.v1+xml: one <columns> block per column, each carrying a
// <metadata> (the column) and a <dataSet> of <data> cells, one per row.
const COLUMN_BLOCK_RE =
  /<[a-zA-Z]+:columns\b[^>]*>([\s\S]*?)<\/[a-zA-Z]+:columns>/g;
// A <data> cell, matching both <data>val</data> and self-closing <data/> (null).
const DATA_RE =
  /<[a-zA-Z]+:data\b[^>]*?(?:\/>|>([\s\S]*?)<\/[a-zA-Z]+:data>)/g;
const ATTR_RE = (attr) =>
  new RegExp(`\\b(?:[a-zA-Z]+:)?${attr}="([^"]*)"`, "i");

function pickAttr(s, attr) {
  const m = s.match(ATTR_RE(attr));
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

function pickTagText(xml, tag) {
  const re = new RegExp(`<[a-zA-Z]+:${tag}\\b[^>]*>([\\s\\S]*?)<\\/[a-zA-Z]+:${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1].trim()) : undefined;
}

// Parse the column-major table.v1+xml shape into row objects. Each
// <dataPreview:columns> block holds one <metadata> (the column) and a
// <dataSet> whose <data> children are that column's values across all rows.
// Returns [] when the document isn't column-major (no per-column data cells).
function parseColumnMajor(xml) {
  const cols = [];
  let nrows = 0;
  for (const block of xml.matchAll(COLUMN_BLOCK_RE)) {
    const inner = block[1];
    const metaMatch = inner.match(/<[a-zA-Z]+:metadata\b([^>]*)>/);
    const name = metaMatch ? pickAttr(metaMatch[1], "name") : undefined;
    const values = [...inner.matchAll(DATA_RE)].map((d) =>
      decodeEntities((d[1] ?? "").trim())
    );
    // A metadata-only <columns> wrapper (Shape A) carries no data cells — skip.
    if (!name || values.length === 0) continue;
    cols.push({ name, values });
    if (values.length > nrows) nrows = values.length;
  }
  if (cols.length === 0) return [];
  const rows = [];
  for (let i = 0; i < nrows; i++) {
    const row = {};
    for (const c of cols) row[c.name] = c.values[i] ?? null;
    rows.push(row);
  }
  return rows;
}

export function parseDataPreview(xml) {
  const columns = [];
  for (const m of xml.matchAll(METADATA_RE)) {
    const attrs = m[1] ?? m[2] ?? "";
    const name = pickAttr(attrs, "name");
    if (!name) continue;
    columns.push({
      name,
      type: pickAttr(attrs, "type"),
      description: pickAttr(attrs, "description"),
      length: pickAttr(attrs, "colLength") ?? pickAttr(attrs, "length"),
      isKey: pickAttr(attrs, "keyAttribute") === "true",
      isNumeric: pickAttr(attrs, "isNumeric") === "true",
    });
  }

  const rows = [];

  // Shape A: <row> + <value> positional elements aligned to column order.
  const rowMatches = [...xml.matchAll(ROW_RE)];
  if (rowMatches.length > 0) {
    for (const rm of rowMatches) {
      const inner = rm[1];
      const values = [...inner.matchAll(VALUE_RE)].map((v) =>
        decodeEntities(v[1].trim())
      );
      if (columns.length > 0) {
        const row = {};
        columns.forEach((col, i) => {
          row[col.name] = values[i] ?? null;
        });
        rows.push(row);
      } else {
        rows.push(values);
      }
    }
  } else {
    // Shape C: column-major table.v1+xml — each <columns> block carries the
    // column metadata plus its own <dataSet> of cells. Transpose to rows.
    const colMajor = parseColumnMajor(xml);
    if (colMajor.length > 0) {
      rows.push(...colMajor);
    } else {
      // Shape B: flat <data columnName="X">val</data> blocks. We group every N
      // cells into a row where N = column count.
      const cells = [...xml.matchAll(DATA_CELL_RE)].map((m) => ({
        column: m[1],
        value: decodeEntities(m[2].trim()),
      }));
      if (columns.length > 0 && cells.length > 0) {
        const stride = columns.length;
        for (let i = 0; i < cells.length; i += stride) {
          const row = {};
          for (let j = 0; j < stride && i + j < cells.length; j++) {
            const cell = cells[i + j];
            row[cell.column] = cell.value;
          }
          rows.push(row);
        }
      }
    }
  }

  const totalRowsAttr = pickTagText(xml, "totalRows");
  const totalRows = totalRowsAttr ? Number(totalRowsAttr) : undefined;
  const executedQuery = pickTagText(xml, "executedQueryString");
  const executionTime = pickTagText(xml, "queryExecutionTime");

  return {
    columns,
    rows,
    totalRows: Number.isFinite(totalRows) ? totalRows : rows.length,
    executedQuery,
    executionTime,
  };
}
