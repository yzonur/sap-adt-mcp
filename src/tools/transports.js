import { escapeXml } from "../xml.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

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
      "Create a new transport request. Returns the new TR number. Subject to read-only mode.",
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
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="newrequest">` +
        `<tm:request tm:desc="${escapeXml(args.description)}" tm:type="${trType}" tm:target="${escapeXml(args.target ?? "")}" tm:cliDep="X">` +
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
  };
}
