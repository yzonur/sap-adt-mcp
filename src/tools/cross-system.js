import { sourceUri, normalizeType } from "../object-uris.js";
import { unifiedLineDiff } from "../diff.js";
import { parseObjectReferences } from "../object-references.js";
import { errorResult, jsonResult } from "../result.js";
import { OBJECT_TYPE_HINT } from "./_shared.js";

export const tools = [
  {
    name: "adt_compare_source",
    description:
      "Compare the source of the same object across two systems. Returns a unified-diff plus added/removed line counts.",
    inputSchema: {
      type: "object",
      properties: {
        systemA: { type: "string", description: "First system name." },
        systemB: { type: "string", description: "Second system name." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: { type: "string", description: "For classes: which include." },
        context: {
          type: "integer",
          description: "Lines of context around each diff hunk (default 3).",
          minimum: 0,
          maximum: 20,
        },
      },
      required: ["systemA", "systemB", "object", "type"],
    },
  },
  {
    name: "adt_transport_diff",
    description:
      "Diff every object listed in a transport between two systems. Capped at maxObjects (default 50).",
    inputSchema: {
      type: "object",
      properties: {
        systemA: { type: "string", description: "First system name (source of transport)." },
        systemB: { type: "string", description: "Second system name." },
        transport: { type: "string", description: "Transport request ID." },
        maxObjects: {
          type: "integer",
          description: "Maximum objects to diff (default 50).",
          minimum: 1,
          maximum: 500,
        },
        context: {
          type: "integer",
          description: "Lines of context around each diff hunk (default 3).",
          minimum: 0,
          maximum: 20,
        },
      },
      required: ["systemA", "systemB", "transport"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_compare_source: async (args) => {
      const a = getClient(args.systemA);
      const b = getClient(args.systemB);
      const path = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });

      const [resA, resB] = await Promise.all([
        a.client.request({ path, accept: "text/plain" }),
        b.client.request({ path, accept: "text/plain" }),
      ]);
      const [textA, textB] = await Promise.all([resA.text(), resB.text()]);

      if (!resA.ok)
        return errorResult(a.name, resA.status, textA, resA.headers.get("content-type"), { side: "A" });
      if (!resB.ok)
        return errorResult(b.name, resB.status, textB, resB.headers.get("content-type"), { side: "B" });

      const diff = unifiedLineDiff(textA, textB, {
        context: args.context ?? 3,
        fromFile: `${a.name}:${args.object}`,
        toFile: `${b.name}:${args.object}`,
      });
      return jsonResult({
        object: args.object,
        type: normalizeType(args.type),
        systemA: a.name,
        systemB: b.name,
        identical: diff.identical,
        stats: diff.stats,
        path,
        diff: diff.diff,
      });
    },

    adt_transport_diff: async (args) => {
      const a = getClient(args.systemA);
      const b = getClient(args.systemB);
      const trId = args.transport.toUpperCase();
      const maxObjects = args.maxObjects ?? 50;
      const context = args.context ?? 3;

      const trRes = await a.client.request({
        path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(trId)}`,
      });
      const trBody = await trRes.text();
      if (!trRes.ok) {
        return errorResult(a.name, trRes.status, trBody, trRes.headers.get("content-type"), {
          stage: "fetch-transport",
        });
      }

      const refs = parseObjectReferences(trBody).slice(0, maxObjects);
      if (refs.length === 0) {
        return jsonResult({
          systemA: a.name,
          systemB: b.name,
          transport: trId,
          objectCount: 0,
          note: "No <adtcore:objectReference> entries found in transport response.",
          raw: trBody.slice(0, 4000),
        });
      }

      const results = [];
      for (const ref of refs) {
        const uri = ref.uri;
        if (!uri) continue;
        // Guard: a transport response could carry a URI that escapes the ADT
        // namespace; resolve and require /sap/bc/adt/ prefix before issuing.
        let resolvedUri;
        try {
          resolvedUri = a.client.resolvePath(uri).split("?")[0];
        } catch {
          results.push({ name: ref.name, type: ref.type, uri, status: "invalid-uri" });
          continue;
        }
        if (!resolvedUri.toLowerCase().startsWith("/sap/bc/adt/")) {
          results.push({ name: ref.name, type: ref.type, uri, status: "rejected-non-adt-uri" });
          continue;
        }
        const sourcePath = uri.endsWith("/source/main") ? uri : `${uri}/source/main`;
        let textA = "";
        let textB = "";
        let status = "ok";
        try {
          const [resA, resB] = await Promise.all([
            a.client.request({ path: sourcePath, accept: "text/plain" }),
            b.client.request({ path: sourcePath, accept: "text/plain" }),
          ]);
          textA = await resA.text();
          textB = await resB.text();
          if (!resA.ok && !resB.ok) status = "missing-both";
          else if (!resA.ok) status = "missing-a";
          else if (!resB.ok) status = "missing-b";
        } catch (err) {
          status = `error:${err.message}`;
        }
        if (status !== "ok") {
          results.push({ name: ref.name, type: ref.type, uri, status });
          continue;
        }
        const diff = unifiedLineDiff(textA, textB, {
          context,
          fromFile: `${a.name}:${ref.name}`,
          toFile: `${b.name}:${ref.name}`,
        });
        results.push({
          name: ref.name,
          type: ref.type,
          uri,
          identical: diff.identical,
          stats: diff.stats,
          diff: diff.identical ? undefined : diff.diff,
        });
      }

      return jsonResult({
        systemA: a.name,
        systemB: b.name,
        transport: trId,
        objectCount: refs.length,
        truncated: refs.length === maxObjects,
        results,
      });
    },
  };
}
