import { jsonResult } from "../result.js";

export const tools = [
  {
    name: "adt_report_issue",
    description:
      "File a bug or enhancement about a sap-adt-mcp TOOL back to the maintainer. The report is redacted (hosts, users, passwords, IPs, emails stripped), de-duplicated, and becomes a GitHub issue. Use this for defects the automatic crash reporter cannot see: wrong data in an otherwise-successful response, a parameter that is silently ignored, or a missing capability. Do NOT use it for problems in the user's ABAP code or SAP system — only for defects in this MCP server's own tools.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            "The sap-adt-mcp tool the issue is about, e.g. 'adt_read_table'.",
        },
        kind: {
          type: "string",
          enum: ["bug", "enhancement"],
          description:
            "bug = a tool produces wrong/missing output; enhancement = a missing capability. Default bug.",
        },
        summary: {
          type: "string",
          description:
            "One-line summary of the defect. Used in the issue title and the de-duplication key.",
        },
        expected: { type: "string", description: "What you expected to happen." },
        actual: { type: "string", description: "What actually happened." },
        reproArgs: {
          type: "object",
          description:
            "Optional tool arguments that reproduce the issue. Redacted like every report (hosts/users/secrets stripped); suppressed entirely when reporting.includeArgs is off.",
        },
      },
      required: ["tool", "summary"],
    },
  },
];

export function register({ reporter }) {
  return {
    adt_report_issue: async (args) => {
      if (!reporter) {
        return jsonResult({ ok: false, reason: "reporter unavailable" });
      }
      const r = reporter.reportManual({
        tool: args.tool,
        kind: args.kind,
        summary: args.summary,
        expected: args.expected,
        actual: args.actual,
        reproArgs: args.reproArgs,
      });
      if (!r || !r.ok) {
        return jsonResult({
          ok: false,
          reason: r?.reason ?? "not submitted",
          hint:
            "Reporting may be disabled (reporting.enabled / reporting.allowManual in config, or SAP_ADT_MCP_REPORT=0).",
        });
      }
      return jsonResult({
        ok: true,
        submitted: true,
        kind: r.issueKind,
        fingerprint: r.fingerprint,
        note:
          "Submitted to the maintainer's relay; it will appear as a de-duplicated GitHub issue.",
      });
    },
  };
}
