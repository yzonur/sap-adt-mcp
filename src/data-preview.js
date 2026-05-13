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
