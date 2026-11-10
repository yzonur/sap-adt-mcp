import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName } from "../data-preview.js";
import { snapshot, compareSnapshots } from "../ddic-compare.js";

// A wide table has a few hundred fields (more with appends); indexes and
// foreign keys stay far below this.
const ROWS_CAP = 5000;

export const tools = [
  {
    name: "adt_compare_ddic",
    description:
      "Compare the DDIC definition of a table or structure across two systems (or two tables): header (table category, delivery class, client dependence, maintenance, enhancement category), fields (key flag, data element, domain, type, length, decimals, not-null, check table, reference field — and whether the field order changed), technical settings (data class, size category, buffering, log changes), secondary indexes (fields, unique, DB inclusion) and foreign keys (check table, cardinality, field assignment). Returns only the differences, as onlyInA / onlyInB / changed per section, plus `identical`. Read-only (Data Preview SELECTs on DD02L/DD03L/DD09L/DD12L/DD17S/DD08L/DD05S; needs NetWeaver 7.55+ / S/4HANA). Active versions only. Use adt_compare_source for CDS views and other source-based objects.",
    inputSchema: {
      type: "object",
      properties: {
        systemA: { type: "string", description: "First system name." },
        systemB: { type: "string", description: "Second system name." },
        table: { type: "string", description: "Table or structure name." },
        tableB: {
          type: "string",
          description: "Name on side B when it differs from `table` (e.g. a copy). With it, systemA and systemB may be the same.",
        },
      },
      required: ["systemA", "systemB", "table"],
    },
  },
];

const QUERIES = {
  header: (t) => `SELECT tabname, tabclass, clidep, contflag, mainflag, exclass FROM dd02l WHERE tabname = '${t}' AND as4local = 'A'`,
  fields: (t) =>
    `SELECT fieldname, position, keyflag, rollname, domname, datatype, leng, decimals, notnull, checktable, reftable, reffield, comptype, precfield FROM dd03l WHERE tabname = '${t}' AND as4local = 'A'`,
  technical: (t) => `SELECT tabname, tabart, tabkat, bufallow, pufferung, schfeldanz, protokoll FROM dd09l WHERE tabname = '${t}' AND as4local = 'A'`,
  indexes: (t) =>
    `SELECT indexname, uniqueflag, dbinclexcl, dbsyssel1, dbsyssel2, dbsyssel3, dbsyssel4 FROM dd12l WHERE sqltab = '${t}' AND as4local = 'A'`,
  indexFields: (t) => `SELECT indexname, position, fieldname FROM dd17s WHERE sqltab = '${t}' AND as4local = 'A'`,
  foreignKeys: (t) => `SELECT fieldname, checktable, frkart, cardleft, card, checkflag FROM dd08l WHERE tabname = '${t}' AND as4local = 'A'`,
  foreignKeyFields: (t) => `SELECT fieldname, primpos, fortable, forkey, forstring FROM dd05s WHERE tabname = '${t}' AND as4local = 'A'`,
};

// Read every DDIC section of one table on one system. Returns
// { rows: { header, fields, ... } } or { fail, stage }.
async function readTable(client, table) {
  const rows = {};
  for (const [section, query] of Object.entries(QUERIES)) {
    const r = await runFreestyle(client, query(table), ROWS_CAP);
    if (!r.ok) return { fail: r, stage: section };
    rows[section] = section === "header" || section === "technical" ? r.rows[0] : r.rows;
  }
  return { rows };
}

export function register({ getClient }) {
  return {
    adt_compare_ddic: async (args) => {
      const tableA = sqlName(args.table);
      const tableB = args.tableB != null ? sqlName(args.tableB) : tableA;
      if (!tableA || !tableB) {
        return textResult("adt_compare_ddic: `table` / `tableB` must be DDIC names (letters, digits, '_' and '/', max 30 chars).", true);
      }
      const a = getClient(args.systemA);
      const b = getClient(args.systemB);
      if (a.name === b.name && tableA === tableB) {
        return textResult("adt_compare_ddic: both sides are the same table on the same system — pass a different system or `tableB`.", true);
      }

      const [ra, rb] = await Promise.all([readTable(a.client, tableA), readTable(b.client, tableB)]);
      for (const [side, r, sys] of [["A", ra, a.name], ["B", rb, b.name]]) {
        if (r.fail) return errorResult(sys, r.fail.status, r.fail.body, r.fail.contentType, { side, stage: r.stage });
      }
      const missing = [
        ...(ra.rows.header ? [] : [`${tableA} on ${a.name}`]),
        ...(rb.rows.header ? [] : [`${tableB} on ${b.name}`]),
      ];
      if (missing.length > 0) {
        return textResult(`adt_compare_ddic: no active DDIC definition for ${missing.join(" and ")} (DD02L).`, true);
      }

      return jsonResult({
        systemA: a.name,
        systemB: b.name,
        tableA,
        tableB,
        ...compareSnapshots(snapshot(ra.rows), snapshot(rb.rows)),
      });
    },
  };
}
