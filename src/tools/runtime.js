import { errorResult, jsonResult } from "../result.js";
import { parseDumpFeed, parseDumpDetail } from "../dump-feed.js";
import { SYSTEM_HINT } from "./_shared.js";

const DUMPS_PATH = "/sap/bc/adt/runtime/dumps";

export const tools = [
  {
    name: "adt_list_dumps",
    description:
      "List ABAP short dumps (ST22) from the runtime-dumps endpoint. Each entry contains id, title (runtime error), timestamp, user, and any release-specific fields surfaced by the system. Use adt_get_dump with an id for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        user: {
          type: "string",
          description: "Filter by the user who triggered the dump.",
        },
        host: {
          type: "string",
          description: "Filter by application server host.",
        },
        from: {
          type: "string",
          description:
            "Lower time bound (ISO-8601, e.g. '2026-05-13T00:00:00Z' or 'YYYYMMDD'). Endpoint accepts the value via the 'since' query parameter — may vary across NetWeaver releases.",
        },
        to: {
          type: "string",
          description:
            "Upper time bound, sent as 'until'. May vary across NetWeaver releases.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of dumps to return (default 20).",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "adt_get_dump",
    description:
      "Fetch the full detail of one ABAP short dump by id (as returned by adt_list_dumps).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        dumpId: {
          type: "string",
          description: "Dump id, e.g. '0123456789ABCDEF'.",
        },
      },
      required: ["dumpId"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_list_dumps: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const max = args.maxResults ?? 20;
      const query = { maxResults: String(max) };
      if (args.user) query.user = args.user;
      if (args.host) query.host = args.host;
      if (args.from) query.since = args.from;
      if (args.to) query.until = args.to;

      const res = await client.request({
        path: DUMPS_PATH,
        query,
        accept: "application/atom+xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));

      let entries;
      try {
        entries = parseDumpFeed(text);
      } catch (err) {
        return jsonResult({
          system: sys,
          count: 0,
          parseError: err.message,
          raw: text.slice(0, 8000),
        });
      }
      return jsonResult({
        system: sys,
        count: entries.length,
        truncated: entries.length >= max,
        dumps: entries,
        raw: entries.length === 0 ? text.slice(0, 4000) : undefined,
      });
    },

    adt_get_dump: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const id = String(args.dumpId).trim();
      const res = await client.request({
        path: `${DUMPS_PATH}/${encodeURIComponent(id)}`,
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));

      let parsed;
      try {
        parsed = parseDumpDetail(text);
      } catch (err) {
        return jsonResult({
          system: sys,
          dumpId: id,
          parseError: err.message,
          raw: text,
        });
      }
      return jsonResult({
        system: sys,
        dumpId: id,
        ...parsed,
        raw: text,
      });
    },
  };
}
