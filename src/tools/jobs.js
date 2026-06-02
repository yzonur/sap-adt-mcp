import { escapeXml } from "../xml.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

// Background-job (SM36/SM37) and spool (SP01) integration over ADT.
//
// IMPORTANT: standard ABAP systems do NOT expose background-job scheduling or
// spool reading through ADT REST — there is no registered ADT collection for
// either (verified against on-prem NetWeaver). These tools attempt a plausible
// endpoint and degrade gracefully (available:false + hint) so an agent can fall
// back to SM36/SM37/SP01. Treat them as experimental; positive paths are
// unverified and depend on a custom/extension ADT service being installed.

const JOBS_PATH = "/sap/bc/adt/scheduling/jobs";
const SPOOL_PATH = "/sap/bc/adt/scheduling/spools";

function isResourceNotFound(status, body) {
  return status === 404 || (typeof body === "string" && /ExceptionResourceNotFound/.test(body));
}

function unavailable(sys, feature, status, body) {
  return jsonResult({
    system: sys,
    available: false,
    hint:
      `${feature} is not exposed via ADT REST on this system. ` +
      "Use SM36/SM37 (jobs) or SP01 (spool) in the SAP GUI. " +
      "No standardized ADT background-processing API exists on classic NetWeaver.",
    status,
    raw: typeof body === "string" ? body.slice(0, 400) : undefined,
  });
}

export const tools = [
  {
    name: "adt_schedule_job",
    description:
      "Schedule an ABAP background job (SM36 analog) that runs a report with a variant. WRITE operation — subject to read-only mode. EXPERIMENTAL: no standardized ADT job-scheduling API exists on classic NetWeaver; on systems without an extension service the response carries available:false. Prefer SM36 for anything important.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        jobName: { type: "string", description: "Background job name." },
        program: { type: "string", description: "ABAP report/program to run." },
        variant: { type: "string", description: "Optional report variant." },
        startImmediately: {
          type: "boolean",
          description: "Start as soon as a work process is free (default true).",
        },
      },
      required: ["jobName", "program"],
    },
  },
  {
    name: "adt_read_spool",
    description:
      "Read the output (spool list) of a background job / spool request (SP01 analog). EXPERIMENTAL — see adt_schedule_job for availability constraints; returns available:false on systems without an ADT spool service.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        spoolId: { type: "string", description: "Spool request number." },
      },
      required: ["spoolId"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_schedule_job: async (args) => {
      const { client, name: sys } = getClient(args.system);
      if (!args.jobName || !args.program) {
        return textResult("adt_schedule_job: `jobName` and `program` are required.", true);
      }
      const startImmediately = args.startImmediately !== false;
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<job:job xmlns:job="http://www.sap.com/adt/scheduling" job:name="${escapeXml(args.jobName)}" ` +
        `job:program="${escapeXml(args.program)}"` +
        (args.variant ? ` job:variant="${escapeXml(args.variant)}"` : "") +
        ` job:startImmediately="${startImmediately}"/>`;
      const res = await client.request({
        method: "POST",
        path: JOBS_PATH,
        headers: { "Content-Type": "application/xml" },
        body,
      });
      const text = await res.text();
      if (isResourceNotFound(res.status, text)) return unavailable(sys, "Background-job scheduling", res.status, text);
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "schedule" });
      return jsonResult({ system: sys, jobName: args.jobName, status: "scheduled", result: text });
    },

    adt_read_spool: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({
        path: `${SPOOL_PATH}/${encodeURIComponent(String(args.spoolId))}`,
        accept: "text/plain",
      });
      const text = await res.text();
      if (isResourceNotFound(res.status, text)) return unavailable(sys, "Spool reading", res.status, text);
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, spoolId: args.spoolId, available: true, content: text });
    },
  };
}
