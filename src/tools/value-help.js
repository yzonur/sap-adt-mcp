import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName } from "../data-preview.js";
import {
  sapLanguage,
  mergeFixedValues,
  textTableKeys,
  attachTexts,
  stripClient,
} from "../value-help.js";
import { SYSTEM_HINT } from "./_shared.js";

const DEFAULT_MAX_ROWS = 100;
const HARD_CAP_ROWS = 1000;
// Text-table rows are fetched for the whole language, not per shown key, so the
// cap is wider than the check-table one to keep the join reasonably complete.
const TEXT_ROWS_CAP = 5000;

export const tools = [
  {
    name: "adt_value_help",
    description:
      "F4-style value help for a DDIC field, data element or domain: the domain's fixed values (with texts, DD07L/DD07T) and/or the contents of its check table / value table, joined with the text table in the requested language. Pass exactly one of `domain`, `dataElement`, or `table` + `field`. Read-only (Data Preview SELECTs on DDIC tables; needs NetWeaver 7.55+ / S/4HANA). Search helps (SE11 elementary/collective) are not evaluated — when a field has neither fixed values nor a check table the result says so.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        domain: { type: "string", description: "Domain name, e.g. 'TRSTATUS'." },
        dataElement: { type: "string", description: "Data element name, e.g. 'LAND1'." },
        table: { type: "string", description: "Table or structure name (with `field`), e.g. 'KNA1'." },
        field: { type: "string", description: "Field name (with `table`), e.g. 'LAND1'." },
        language: {
          type: "string",
          description: "Text language — ISO ('EN', 'TR') or SAP key ('E', 'T'). Defaults to the system profile's language, else English.",
        },
        includeCheckTable: {
          type: "boolean",
          description: "Read the check table even when the domain has fixed values (default: only when it has none).",
        },
        maxRows: {
          type: "integer",
          description: `Maximum check-table rows (default ${DEFAULT_MAX_ROWS}, max ${HARD_CAP_ROWS}).`,
          minimum: 1,
          maximum: HARD_CAP_ROWS,
        },
      },
    },
  },
];

function fail(sys, r, stage) {
  return errorResult(sys, r.status, r.body, r.contentType, { stage });
}

export function register({ getClient }) {
  return {
    adt_value_help: async (args) => {
      const byField = args.table != null || args.field != null;
      const modes = [args.domain != null, args.dataElement != null, byField].filter(Boolean).length;
      if (modes !== 1) {
        return textResult(
          "adt_value_help: pass exactly one of `domain`, `dataElement`, or `table` + `field`.",
          true
        );
      }

      const table = byField ? sqlName(args.table) : null;
      const field = byField ? sqlName(args.field) : null;
      const dataElementArg = args.dataElement != null ? sqlName(args.dataElement) : null;
      const domainArg = args.domain != null ? sqlName(args.domain) : null;
      if ((byField && (!table || !field)) || (args.dataElement != null && !dataElementArg) || (args.domain != null && !domainArg)) {
        return textResult(
          "adt_value_help: names must be DDIC names (letters, digits, '_' and '/', max 30 chars); `table` and `field` go together.",
          true
        );
      }

      const { client, name: sys, profile } = getClient(args.system);
      const language = sapLanguage(args.language ?? profile?.language);
      const maxRows = Math.min(args.maxRows ?? DEFAULT_MAX_ROWS, HARD_CAP_ROWS);
      const resolved = {};

      if (byField) {
        const r = await runFreestyle(
          client,
          `SELECT fieldname, rollname, domname, checktable FROM dd03l WHERE tabname = '${table}' AND fieldname = '${field}' AND as4local = 'A'`,
          5
        );
        if (!r.ok) return fail(sys, r, "dd03l");
        const row = r.rows[0];
        if (!row) {
          return textResult(`adt_value_help: no active field ${table}-${field} in DD03L.`, true);
        }
        Object.assign(resolved, {
          table,
          field,
          dataElement: row.ROLLNAME || undefined,
          domain: row.DOMNAME || undefined,
          // "*" marks a generic check on the key field itself — no table to read.
          checkTable: row.CHECKTABLE && row.CHECKTABLE !== "*" ? row.CHECKTABLE : undefined,
        });
      } else if (dataElementArg) {
        const r = await runFreestyle(
          client,
          `SELECT rollname, domname FROM dd04l WHERE rollname = '${dataElementArg}' AND as4local = 'A'`,
          5
        );
        if (!r.ok) return fail(sys, r, "dd04l");
        if (!r.rows[0]) {
          return textResult(`adt_value_help: no active data element ${dataElementArg} in DD04L.`, true);
        }
        resolved.dataElement = dataElementArg;
        resolved.domain = r.rows[0].DOMNAME || undefined;
      } else {
        resolved.domain = domainArg;
      }

      let fixedValues = [];
      if (resolved.domain) {
        const d = await runFreestyle(
          client,
          `SELECT domname, entitytab FROM dd01l WHERE domname = '${resolved.domain}' AND as4local = 'A'`,
          5
        );
        if (!d.ok) return fail(sys, d, "dd01l");
        if (!d.rows[0] && domainArg) {
          return textResult(`adt_value_help: no active domain ${domainArg} in DD01L.`, true);
        }
        const valueTable = d.rows[0]?.ENTITYTAB || undefined;
        if (valueTable) resolved.valueTable = valueTable;

        const v = await runFreestyle(
          client,
          `SELECT valpos, domvalue_l, domvalue_h FROM dd07l WHERE domname = '${resolved.domain}' AND as4local = 'A'`,
          HARD_CAP_ROWS
        );
        if (!v.ok) return fail(sys, v, "dd07l");
        if (v.rows.length > 0) {
          const t = await runFreestyle(
            client,
            `SELECT valpos, ddlanguage, ddtext FROM dd07t WHERE domname = '${resolved.domain}' AND as4local = 'A' AND ddlanguage IN ('${language}', 'E')`,
            HARD_CAP_ROWS * 2
          );
          if (!t.ok) return fail(sys, t, "dd07t");
          fixedValues = mergeFixedValues(v.rows, t.rows, language);
        }
      }

      const checkTable = sqlName(resolved.checkTable ?? resolved.valueTable ?? "");
      let checkTableValues;
      if (checkTable && (fixedValues.length === 0 || args.includeCheckTable)) {
        const c = await runFreestyle(client, `SELECT * FROM ${checkTable}`, maxRows);
        if (!c.ok) return fail(sys, c, "check-table");

        let rows = c.rows;
        const tt = await runFreestyle(
          client,
          `SELECT tabname FROM dd08l WHERE checktable = '${checkTable}' AND frkart = 'TEXT' AND as4local = 'A'`,
          1
        );
        let textTable = tt.ok ? sqlName(tt.rows[0]?.TABNAME ?? "") : null;
        if (textTable) {
          const k = await runFreestyle(
            client,
            `SELECT fieldname, domname FROM dd03l WHERE tabname = '${textTable}' AND as4local = 'A' AND keyflag = 'X'`,
            50
          );
          const keys = k.ok ? textTableKeys(k.rows) : { languageField: null, joinFields: [] };
          if (keys.languageField) {
            const tr = await runFreestyle(
              client,
              `SELECT * FROM ${textTable} WHERE ${keys.languageField} = '${language}'`,
              TEXT_ROWS_CAP
            );
            if (tr.ok) rows = attachTexts(rows, tr.rows, keys);
          } else {
            textTable = null;
          }
        }
        if (!textTable) rows = rows.map(stripClient);

        checkTableValues = {
          table: checkTable,
          ...(textTable ? { textTable } : {}),
          rowCount: rows.length,
          totalRows: c.totalRows,
          truncated: c.totalRows > rows.length,
          rows,
        };
      }

      const empty = fixedValues.length === 0 && !checkTableValues;
      return jsonResult({
        system: sys,
        language,
        resolved,
        fixedValues,
        ...(checkTableValues ? { checkTableValues } : {}),
        ...(empty
          ? {
              note:
                "No domain fixed values and no check/value table. If the field still has an F4 help in the GUI it comes from a search help, which this tool does not evaluate — try adt_read_table on the underlying table instead.",
            }
          : {}),
      });
    },
  };
}
