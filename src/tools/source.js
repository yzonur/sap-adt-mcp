import { sourceUri, objectUri, normalizeType } from "../object-uris.js";
import { acquireLock, releaseLock } from "../lock.js";
import { errorResult, jsonResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

export const tools = [
  {
    name: "adt_get_source",
    description:
      "Fetch the ABAP source of an object (program, class, interface, function module, include, CDS, table). Returns plain text.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name (case-insensitive)." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: {
          type: "string",
          description:
            "Function group name (required when type is function / FUGR/FF or FUGR/I).",
        },
        include: {
          type: "string",
          description:
            "For classes: which include to fetch. One of main, definitions, implementations, macros, testclasses. Default: main.",
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_set_source",
    description:
      "Replace the ABAP source of an object. Orchestrates lock → PUT → unlock automatically. Requires read-only mode to be off for the target system.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: {
          type: "string",
          description:
            "For classes: which include to write. One of main, definitions, implementations, macros, testclasses. Default: main.",
        },
        source: { type: "string", description: "New ABAP source code (full text)." },
        transport: {
          type: "string",
          description:
            "Transport request ID to assign the change to (sent as corrNr). Optional for local objects.",
        },
        lockHandle: {
          type: "string",
          description:
            "Optional externally-acquired lock handle. When supplied, adt_set_source skips its internal lock/unlock and assumes the caller will release the lock with adt_unlock.",
        },
      },
      required: ["object", "type", "source"],
    },
  },
  {
    name: "adt_pretty_print",
    description:
      "Run the ABAP pretty printer on supplied source code (stateless — no object lookup, no lock).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        source: { type: "string", description: "ABAP source to format." },
      },
      required: ["source"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_get_source: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const path = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });
      const res = await client.request({ path, accept: "text/plain" });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        path,
        source: text,
        bytes: text.length,
        lines: text.split(/\r?\n/).length,
      });
    },

    adt_set_source: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      const srcPath = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });

      const externalLock = typeof args.lockHandle === "string" && args.lockHandle.length > 0;
      let handle = args.lockHandle;
      if (!externalLock) {
        const lock = await acquireLock(client, objUri);
        if (!lock.ok) {
          return errorResult(sys, lock.status, lock.body, lock.contentType, {
            stage: "lock",
            ...(lock.error ? { detail: lock.error } : {}),
          });
        }
        handle = lock.handle;
      }

      try {
        const putQuery = { lockHandle: handle };
        if (args.transport) putQuery.corrNr = args.transport;
        const putRes = await client.request({
          method: "PUT",
          path: srcPath,
          query: putQuery,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-sap-adt-sessiontype": "stateful",
          },
          body: args.source,
        });
        const putText = await putRes.text();
        if (!putRes.ok) {
          return errorResult(sys, putRes.status, putText, putRes.headers.get("content-type"), {
            stage: "put",
          });
        }
        return jsonResult({
          system: sys,
          object: args.object,
          type: normalizeType(args.type),
          path: srcPath,
          status: "updated",
          httpStatus: putRes.status,
          lockHandle: externalLock ? handle : undefined,
        });
      } finally {
        if (!externalLock) {
          try {
            await releaseLock(client, objUri, handle);
          } catch {
            // best-effort
          }
        }
      }
    },

    adt_pretty_print: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/abapsource/prettyprinter",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: args.source,
        accept: "text/plain",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, source: text });
    },
  };
}
