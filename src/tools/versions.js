import { objectUri, sourceUri, normalizeType } from "../object-uris.js";
import { unifiedLineDiff } from "../diff.js";
import { errorResult, jsonResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// Parse <vrs:version .../> or generic version entries that some ADT releases
// expose under {objectUri}/versions. Shapes vary; we collect every attribute.
const VERSION_RE = /<(?:vrs:)?version\b([\s\S]*?)(?:\/>|>)/gi;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

export function parseVersionList(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(VERSION_RE)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR_RE)) {
      attrs[a[1].replace(/^[\w]+:/, "")] = a[2];
    }
    if (Object.keys(attrs).length) out.push(attrs);
  }
  return out;
}

export const tools = [
  {
    name: "adt_list_versions",
    description:
      "List the version history of an object via the ADT versions sub-resource ({objectUri}/versions). NOTE: many on-prem NetWeaver releases do not expose a version-history REST endpoint and return 404 — in that case use adt_compare_versions to diff active vs inactive instead. The response carries available:false with a hint when the endpoint is absent.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_compare_versions",
    description:
      "Diff two versions of the SAME object's source within one system. Defaults to active-vs-inactive (the daily 'what did I change but not yet activate' question). Pass from/to to compare specific version identifiers understood by the ADT ?version= query (e.g. 'active', 'inactive', or a numeric version number where supported). Returns a unified diff plus added/removed line counts, reusing the same diff engine as adt_compare_source.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: { type: "string", description: "For classes: which include to compare." },
        from: {
          type: "string",
          description: "Base version passed to ?version= (default 'inactive').",
        },
        to: {
          type: "string",
          description: "Target version passed to ?version= (default 'active').",
        },
        context: {
          type: "integer",
          description: "Lines of context around each diff hunk (default 3).",
          minimum: 0,
          maximum: 20,
        },
      },
      required: ["object", "type"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_list_versions: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({ type: args.type, name: args.object, group: args.group });
      const res = await client.request({
        path: `${objUri}/versions`,
        accept: "application/xml",
      });
      const text = await res.text();
      if (res.status === 404) {
        return jsonResult({
          system: sys,
          object: args.object,
          type: normalizeType(args.type),
          available: false,
          hint:
            "This system's ADT does not expose a version-history list at {objectUri}/versions. " +
            "Use adt_compare_versions (active vs inactive) for the common diff use case.",
        });
      }
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const versions = parseVersionList(text);
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        available: true,
        count: versions.length,
        versions,
        raw: versions.length === 0 ? text.slice(0, 4000) : undefined,
      });
    },

    adt_compare_versions: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const from = args.from ?? "inactive";
      const to = args.to ?? "active";
      const path = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });

      const [resFrom, resTo] = await Promise.all([
        client.request({ path, query: { version: from }, accept: "text/plain" }),
        client.request({ path, query: { version: to }, accept: "text/plain" }),
      ]);
      const [textFrom, textTo] = await Promise.all([resFrom.text(), resTo.text()]);

      if (!resFrom.ok) {
        return errorResult(sys, resFrom.status, textFrom, resFrom.headers.get("content-type"), {
          side: "from",
          version: from,
        });
      }
      if (!resTo.ok) {
        return errorResult(sys, resTo.status, textTo, resTo.headers.get("content-type"), {
          side: "to",
          version: to,
        });
      }

      const diff = unifiedLineDiff(textFrom, textTo, {
        context: args.context ?? 3,
        fromFile: `${args.object}@${from}`,
        toFile: `${args.object}@${to}`,
      });
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        from,
        to,
        path,
        identical: diff.identical,
        stats: diff.stats,
        diff: diff.diff,
      });
    },
  };
}
