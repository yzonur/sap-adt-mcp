import { errorResult, jsonResult, textResult } from "../result.js";
import { validateSelect, parseDataPreview } from "../data-preview.js";
import { SYSTEM_HINT } from "./_shared.js";

const FREESTYLE_PATH = "/sap/bc/adt/datapreview/freestyle";
const DEFAULT_MAX_ROWS = 100;
const HARD_CAP_ROWS = 5000;

export const tools = [
  {
    name: "adt_read_table",
    description:
      "Execute an OpenSQL SELECT against the SAP database via the ADT Data Preview endpoint. Read-only by design (SELECT only — INSERT/UPDATE/DELETE rejected client- and server-side). Returns structured { columns, rows }. Use ABAP OpenSQL syntax: 'SELECT matnr matkl FROM mara WHERE matnr LIKE \\'M%\\''. Row count capped at maxRows (default 100, hard cap 5000). Requires NetWeaver 7.55+ or S/4HANA — older systems may not expose this endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        query: {
          type: "string",
          description:
            "OpenSQL SELECT statement. Use ABAP syntax (e.g. UP TO N ROWS is allowed but maxRows already caps the result).",
        },
        maxRows: {
          type: "integer",
          description: `Maximum rows to return. Default ${DEFAULT_MAX_ROWS}, max ${HARD_CAP_ROWS}.`,
          minimum: 1,
          maximum: HARD_CAP_ROWS,
        },
      },
      required: ["query"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_read_table: async (args) => {
      const guard = validateSelect(args.query);
      if (!guard.ok) {
        return textResult(`adt_read_table: ${guard.reason}`, true);
      }
      const max = Math.min(args.maxRows ?? DEFAULT_MAX_ROWS, HARD_CAP_ROWS);
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({
        method: "POST",
        path: FREESTYLE_PATH,
        query: { rowNumber: String(max) },
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: args.query,
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));

      let parsed;
      try {
        parsed = parseDataPreview(text);
      } catch (err) {
        return jsonResult({
          system: sys,
          parseError: err.message,
          raw: text.slice(0, 8000),
        });
      }

      const rowCount = parsed.rows.length;
      return jsonResult({
        system: sys,
        query: args.query,
        rowCount,
        truncated: rowCount >= max,
        totalRows: parsed.totalRows,
        executionTime: parsed.executionTime,
        executedQuery: parsed.executedQuery,
        columns: parsed.columns,
        rows: parsed.rows,
        raw: parsed.columns.length === 0 && rowCount === 0 ? text.slice(0, 4000) : undefined,
      });
    },
  };
}
