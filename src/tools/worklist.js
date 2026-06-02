import { parseObjectReferences } from "../object-references.js";
import { errorResult, jsonResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

const INACTIVE_PATH = "/sap/bc/adt/activation/inactiveobjects";
const INACTIVE_ACCEPT = "application/vnd.sap.adt.inactivectsobjects.v1+xml";

// Parse the inactive-objects worklist. Each entry wraps an object reference
// (and often a separate transport reference). We collect the object refs and
// keep a count; the raw payload is returned when nothing parses so the caller
// can inspect an unfamiliar release shape.
const ENTRY_RE = /<(?:ioc:)?entry\b[\s\S]*?<\/(?:ioc:)?entry>/gi;

export function parseInactiveObjects(xml) {
  if (typeof xml !== "string") return [];
  const entries = [...xml.matchAll(ENTRY_RE)];
  // Prefer per-entry parsing (keeps object/transport pairing), fall back to a
  // flat scan of every objectReference in the document.
  const blocks = entries.length ? entries.map((m) => m[0]) : [xml];
  const out = [];
  for (const block of blocks) {
    const refs = parseObjectReferences(block);
    if (refs.length === 0) continue;
    // First ref is the object; any later ref with a cts/transport uri is its TR.
    const [object, ...rest] = refs;
    const transport = rest.find((r) => /transportrequest/i.test(r.uri ?? ""));
    out.push({
      name: object.name,
      type: object.type,
      uri: object.uri,
      transport: transport?.name,
    });
  }
  return out;
}

export const tools = [
  {
    name: "adt_list_inactive_objects",
    description:
      "List the inactive objects worklist for the connected user (the ADT 'Inactive Objects' view — what has been edited but not yet activated). Returns each object with its type and, where available, the transport it sits in. An empty list means everything is activated.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
      },
    },
  },
  {
    name: "adt_list_locks",
    description:
      "List runtime enqueue locks (the SM12 analog). NOTE: most ABAP systems do NOT expose SM12 runtime enqueues over ADT REST — in that case the response carries available:false and a hint to use SM12. This is distinct from the editing lock acquired by adt_lock (a single object) and from DDIC lock-object definitions.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        client: { type: "string", description: "Optional SAP client filter." },
        user: { type: "string", description: "Optional lock-owner user filter." },
        table: { type: "string", description: "Optional locked-table filter." },
      },
    },
  },
];

export function register({ getClient }) {
  return {
    adt_list_inactive_objects: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({ path: INACTIVE_PATH, accept: INACTIVE_ACCEPT });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const objects = parseInactiveObjects(text);
      return jsonResult({
        system: sys,
        count: objects.length,
        objects,
        raw: objects.length === 0 ? text.slice(0, 2000) : undefined,
      });
    },

    adt_list_locks: async (args) => {
      const { client, name: sys } = getClient(args.system);
      // SM12 runtime enqueues have no standardized ADT collection. Attempt a
      // plausible path so systems that DO expose it work, but degrade
      // gracefully (available:false) on the common case where it 404s.
      const query = {};
      if (args.client) query.client = args.client;
      if (args.user) query.user = args.user;
      if (args.table) query.table = args.table;
      const res = await client.request({
        path: "/sap/bc/adt/runtime/enqueue/locks",
        query,
        accept: "application/xml",
      });
      const text = await res.text();
      if (res.status === 404 || /ExceptionResourceNotFound/.test(text)) {
        return jsonResult({
          system: sys,
          available: false,
          hint:
            "Runtime enqueue locks (SM12) are not exposed via ADT REST on this system. " +
            "Use transaction SM12 in the SAP GUI. (adt_lock manages the editing lock of a single object; " +
            "DDIC lock-object definitions are a separate concept.)",
          status: res.status,
        });
      }
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const locks = parseObjectReferences(text);
      return jsonResult({ system: sys, available: true, count: locks.length, locks, raw: text.slice(0, 2000) });
    },
  };
}
