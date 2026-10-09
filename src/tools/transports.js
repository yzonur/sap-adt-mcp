import { escapeXml } from "../xml.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName } from "../data-preview.js";
import { summarizeTpalog, describeHeader } from "../transport-queue.js";
import { SYSTEM_HINT } from "./_shared.js";

// tp logs a dozen-plus steps per request per system; a few hundred covers even a
// long DEV → QAS → PRD history with re-imports.
const TPALOG_MAX_ROWS = 500;

export const tools = [
  {
    name: "adt_list_transports",
    description:
      "List transport requests visible to the configured user. Filter by user (requestor) and / or status (modifiable / released). Endpoint shape may vary across NetWeaver releases — falls back to adt_request if your system uses a different path.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        user: {
          type: "string",
          description: "Filter by requestor user. Omit for the configured connection user.",
        },
        status: {
          type: "string",
          enum: ["modifiable", "released", "all"],
          description: "Status filter (default modifiable).",
        },
        targets: {
          type: "string",
          description: "Optional comma-separated target system list.",
        },
      },
    },
  },
  {
    name: "adt_get_transport",
    description: "Fetch detail of a single transport request (header + included objects).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        transport: { type: "string", description: "Transport request ID, e.g. 'E4DK900123'." },
      },
      required: ["transport"],
    },
  },
  {
    name: "adt_create_transport",
    description:
      "Create a new transport request. Returns the new TR number. Subject to read-only mode. Note: on some systems TR *creation* routes through a SAP GUI dialog and fails headless with a 500 (SAPLSTRD/SAPLSPO4 'No window system type'). Assigning changes to an EXISTING request works headless — pass that TR id as `transport` to adt_lock / adt_set_source instead.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        description: { type: "string", description: "Short description of the TR." },
        type: {
          type: "string",
          enum: ["K", "W"],
          description: "TR type — K = workbench (default), W = customizing.",
        },
        target: {
          type: "string",
          description: "Target system / consolidation route. Omit for default route.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "adt_release_transport",
    description: "Release a transport request. Subject to read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        transport: { type: "string", description: "Transport request ID." },
      },
      required: ["transport"],
    },
  },
  {
    name: "adt_transport_queue",
    description:
      "Where is a transport request right now? Reads the request header (E070: status, owner, target) and the tp action log (TPALOG: export, forward into a follow-on import buffer, import steps with return codes) on one or more configured systems, and summarizes per target system: exported, in-import-queue, imported, imported-with-errors or import-aborted. Pass `systems` with every system of the route (e.g. ['DEV','QAS','PRD']) for the full picture — each system only logs the tp steps that touched it. Read-only (Data Preview SELECTs; NetWeaver 7.55+ / S/4HANA). The TMS buffer file itself is not reachable over ADT, so 'in-import-queue' is inferred from the forward step.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        transport: { type: "string", description: "Transport request ID, e.g. 'E4DK900123'. A task resolves to its parent request." },
        systems: {
          type: "array",
          items: { type: "string" },
          description: "Configured system names to read, in route order. Default: just `system` (or the default system).",
        },
      },
      required: ["transport"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_list_transports: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const status = args.status ?? "modifiable";
      const query = {};
      query.user = args.user ?? profile.user;
      if (status !== "all") query.status = status;
      if (args.targets) query.targets = args.targets;

      const res = await client.request({
        path: "/sap/bc/adt/cts/transportrequests",
        query,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, filters: query, result: text });
    },

    adt_get_transport: async (args) => {
      if (typeof args.transport !== "string" || args.transport.length === 0) {
        return textResult(
          "adt_get_transport: `transport` is required (string, e.g. 'E4DK900123'). " +
            "Did you pass `transportId`? The field is named `transport`.",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({
        path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(args.transport.toUpperCase())}`,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({
        system: sys,
        transport: args.transport.toUpperCase(),
        result: text,
      });
    },

    adt_create_transport: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const trType = args.type ?? "K";
      // Only emit tm:target when a real target is given. Sending tm:target=""
      // (the old default) makes some systems reject the create with an opaque
      // 500 — the same blank-value hazard as a whitespace corrNr (#68/#63).
      // Omitting it lets CTS apply the connection's default consolidation route.
      const targetAttr =
        typeof args.target === "string" && args.target.trim()
          ? ` tm:target="${escapeXml(args.target.trim())}"`
          : "";
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="newrequest">` +
        `<tm:request tm:desc="${escapeXml(args.description)}" tm:type="${trType}"${targetAttr} tm:cliDep="X">` +
        `<tm:user tm:name="${escapeXml(profile.user.toUpperCase())}"/>` +
        `</tm:request>` +
        `</tm:root>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/cts/transportrequests",
        headers: { "Content-Type": "application/vnd.sap.adt.transportorganizer.v1+xml" },
        body: xml,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const trMatch = text.match(/[A-Z]{3}K9\d{5}/);
      return jsonResult({
        system: sys,
        transport: trMatch ? trMatch[0] : null,
        raw: text,
      });
    },

    adt_release_transport: async (args) => {
      if (typeof args.transport !== "string" || args.transport.length === 0) {
        return textResult(
          "adt_release_transport: `transport` is required (string, e.g. 'E4DK900123'). " +
            "Did you pass `transportId`? The field is named `transport`.",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const id = args.transport.toUpperCase();
      const res = await client.request({
        method: "POST",
        path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}/newreleasejobs`,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, transport: id, result: text });
    },

    adt_transport_queue: async (args) => {
      const id = sqlName(args.transport, 20);
      if (!id) {
        return textResult(
          "adt_transport_queue: `transport` must be a transport request ID such as 'E4DK900123'.",
          true
        );
      }
      const names =
        Array.isArray(args.systems) && args.systems.length > 0 ? [...new Set(args.systems)] : [args.system];

      const results = [];
      for (const name of names) {
        let ctx;
        try {
          ctx = getClient(name);
        } catch (err) {
          results.push({ system: name ?? null, error: err.message });
          continue;
        }
        const { client, name: sys } = ctx;
        try {
          const h = await runFreestyle(
            client,
            `SELECT trkorr, trfunction, trstatus, tarsystem, as4user, as4date, as4time, strkorr FROM e070 WHERE trkorr = '${id}'`,
            1
          );
          if (!h.ok) {
            results.push({ system: sys, error: `E070 read failed (HTTP ${h.status})`, stage: "e070" });
            continue;
          }
          const header = describeHeader(h.rows[0]);
          // tp works on requests, never tasks — follow a task up to its request.
          const request = sqlName(header?.parent ?? "", 20) ?? id;

          let description;
          const t = await runFreestyle(client, `SELECT as4text FROM e07t WHERE trkorr = '${request}'`, 1);
          if (t.ok) description = t.rows[0]?.AS4TEXT || undefined;

          const log = await runFreestyle(
            client,
            `SELECT trkorr, tarsystem, trcli, trstep, retcode, trtime, truser FROM tpalog WHERE trkorr = '${request}'`,
            TPALOG_MAX_ROWS
          );
          if (!log.ok) {
            results.push({ system: sys, header, error: `TPALOG read failed (HTTP ${log.status})`, stage: "tpalog" });
            continue;
          }
          results.push({
            system: sys,
            knownHere: Boolean(header) || log.rows.length > 0,
            header,
            ...(request !== id ? { request } : {}),
            ...(description ? { description } : {}),
            targets: summarizeTpalog(log.rows),
            ...(log.totalRows > log.rows.length ? { logTruncated: true } : {}),
          });
        } catch (err) {
          results.push({ system: sys, error: err.message });
        }
      }

      return jsonResult({
        transport: id,
        systems: results,
        note:
          "Each system's TPALOG only holds the tp steps that touched that system. 'in-import-queue' means a forward into that system's buffer is logged but no import step is — confirm by including that system in `systems`.",
      });
    },
  };
}
