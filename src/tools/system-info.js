import { errorResult, jsonResult } from "../result.js";
import { runFreestyle } from "../data-preview.js";
import { classifySystem } from "../system-info.js";
import { SYSTEM_HINT } from "./_shared.js";

// CVERS has one row per installed component — 50 to a few hundred.
const CVERS_MAX_ROWS = 2000;

export const tools = [
  {
    name: "adt_system_info",
    description:
      "Identify the connected SAP system: product (S/4HANA version, ECC or plain NetWeaver), SAP_BASIS release and SP level, and whether the ABAP Cloud development model is available (SAP_BASIS ≥ 7.57). Read-only — derived from table CVERS (installed software components) via the same Data Preview endpoint as adt_read_table, so it needs NetWeaver 7.55+ / S/4HANA. Call it before choosing release-sensitive guidance (Clean Core vs classic ABAP) or a release-dependent ADT endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        includeComponents: {
          type: "boolean",
          description: "Also return every installed software component (default false — only the key ones).",
        },
      },
    },
  },
];

export function register({ getClient }) {
  return {
    adt_system_info: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const r = await runFreestyle(client, "SELECT * FROM cvers", CVERS_MAX_ROWS);
      if (!r.ok) {
        return errorResult(sys, r.status, r.body, r.contentType, { stage: "cvers" });
      }
      const info = classifySystem(r.rows);
      return jsonResult({
        system: sys,
        ...info,
        ...(args.includeComponents
          ? {
              components: r.rows.map((row) => ({
                component: row.COMPONENT,
                release: row.RELEASE,
                extRelease: row.EXTRELEASE,
                type: row.COMP_TYPE,
              })),
            }
          : {}),
        source: "CVERS",
      });
    },
  };
}
