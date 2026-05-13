import { objectUri, normalizeType } from "../object-uris.js";
import { escapeXml } from "../xml.js";
import { acquireLock, releaseLock } from "../lock.js";
import { buildCreateRequest } from "../object-create.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

export const tools = [
  {
    name: "adt_activate",
    description: "Activate one or more ABAP objects.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        objects: {
          type: "array",
          description: "Objects to activate.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_create_object",
    description:
      "Create a new ABAP object in a package. Supported types: program, class, interface, include, functiongroup, function, cds, accesscontrol, metadataext, behaviordef, messageclass. Refused under read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        name: { type: "string", description: "New object name (Z*/Y* or namespace)." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        package: { type: "string", description: "Target package." },
        description: { type: "string", description: "Short description." },
        group: {
          type: "string",
          description: "Function group (required when creating a function module).",
        },
        programType: {
          type: "string",
          description: "Program subtype, e.g. 'executableProgram' or 'modulePool'. Default: executableProgram.",
        },
        responsible: {
          type: "string",
          description: "Responsible user. Defaults to the profile's logon user.",
        },
        transport: {
          type: "string",
          description: "Transport request ID to assign the new object to.",
        },
      },
      required: ["name", "type", "package", "description"],
    },
  },
  {
    name: "adt_delete_object",
    description: "Delete an ABAP object. Acquires a lock and issues DELETE. Refused under read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        transport: { type: "string", description: "Transport request ID (corrNr)." },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_lock",
    description:
      "Acquire a stateful lock on an ABAP object. Returns a lockHandle to reuse across multiple adt_set_source calls.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        accessMode: {
          type: "string",
          description: "Lock access mode. Default: MODIFY.",
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_unlock",
    description: "Release a stateful lock previously acquired with adt_lock.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        lockHandle: { type: "string", description: "The lockHandle returned by adt_lock." },
      },
      required: ["object", "type", "lockHandle"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_activate: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const refs = args.objects
        .map((o) => {
          const uri = objectUri({ type: o.type, name: o.name, group: o.group });
          return `<adtcore:objectReference adtcore:uri="${escapeXml(uri)}" adtcore:name="${escapeXml(o.name.toUpperCase())}"/>`;
        })
        .join("");
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs}</adtcore:objectReferences>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/activation",
        query: { method: "activate", preauditRequested: "true" },
        headers: { "Content-Type": "application/xml" },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, status: res.status, result: text });
    },

    adt_create_object: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      let req;
      try {
        req = buildCreateRequest({
          type: args.type,
          name: args.name,
          package: args.package,
          description: args.description,
          group: args.group,
          programType: args.programType,
          responsible: args.responsible ?? profile.user,
        });
      } catch (err) {
        return textResult(`Error: ${err.message}`, true);
      }
      const query = {};
      if (args.transport) query.corrNr = args.transport;
      const res = await client.request({
        method: "POST",
        path: req.path,
        query,
        headers: { "Content-Type": req.contentType },
        body: req.body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const newUri = objectUri({
        type: args.type,
        name: args.name,
        group: args.group,
      });
      return jsonResult({
        system: sys,
        name: args.name.toUpperCase(),
        type: normalizeType(args.type),
        package: args.package.toUpperCase(),
        objectUri: newUri,
        status: "created",
        httpStatus: res.status,
      });
    },

    adt_delete_object: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      const lock = await acquireLock(client, objUri);
      if (!lock.ok) {
        return errorResult(sys, lock.status, lock.body, lock.contentType, {
          stage: "lock",
        });
      }
      const query = { lockHandle: lock.handle };
      if (args.transport) query.corrNr = args.transport;
      const res = await client.request({
        method: "DELETE",
        path: objUri,
        query,
        headers: { "X-sap-adt-sessiontype": "stateful" },
      });
      const text = await res.text();
      if (!res.ok) {
        try {
          await releaseLock(client, objUri, lock.handle);
        } catch {
          // ignore
        }
        return errorResult(sys, res.status, text, res.headers.get("content-type"), {
          stage: "delete",
        });
      }
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        status: "deleted",
        httpStatus: res.status,
      });
    },

    adt_lock: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      const lock = await acquireLock(client, objUri, args.accessMode ?? "MODIFY");
      if (!lock.ok) {
        return errorResult(sys, lock.status, lock.body, lock.contentType, {
          stage: "lock",
        });
      }
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        objectUri: objUri,
        lockHandle: lock.handle,
        accessMode: args.accessMode ?? "MODIFY",
      });
    },

    adt_unlock: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      const res = await releaseLock(client, objUri, args.lockHandle);
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        status: "unlocked",
        httpStatus: res.status,
      });
    },
  };
}
