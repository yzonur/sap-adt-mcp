import { objectUri } from "../object-uris.js";
import { fetchPackageNodes } from "../node-structure.js";
import { parseObjectReferences } from "../object-references.js";
import { errorResult, jsonResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

function defaultDescendPrefix(pkg) {
  if (pkg.startsWith("/")) {
    const second = pkg.indexOf("/", 1);
    if (second > 0) return pkg.slice(0, second + 1);
  }
  return pkg[0] ?? "";
}

export const tools = [
  {
    name: "adt_search_objects",
    description:
      "Quick-search the ABAP repository for objects whose name matches a pattern. Use '*' as wildcard.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        query: {
          type: "string",
          description: "Search pattern, e.g. 'ZCL_CUSTOMER*' or 'Z*INVOICE*'.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of results (default 50).",
          minimum: 1,
          maximum: 500,
        },
        objectType: {
          type: "string",
          description:
            "Optional ADT object-type filter, e.g. 'CLAS/OC' for classes, 'PROG/P' for programs. Omit for all types.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "adt_where_used",
    description: "Where-used list for an object. Returns the references that point to it.",
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
    name: "adt_browse_package",
    description:
      "List the immediate contents (one level) of an ABAP package. Use adt_list_packages for recursive walks.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        package: {
          type: "string",
          description: "Package name (case-insensitive), e.g. 'ZLOCAL' or '/MYNS/MAIN'.",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "adt_list_packages",
    description:
      "Recursively walk subpackages from a root package. Returns a flattened map of package → contents (counts and entries grouped by type).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        root: { type: "string", description: "Root package name to walk from." },
        prefix: {
          type: "string",
          description:
            "Only descend into subpackages whose name starts with this prefix. Defaults to namespace prefix or first character.",
        },
        maxPackages: {
          type: "integer",
          description: "Safety limit on total packages visited (default 200).",
          minimum: 1,
          maximum: 5000,
        },
      },
      required: ["root"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_search_objects: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const maxResults = args.maxResults ?? 50;
      const query = {
        operation: "quickSearch",
        query: args.query,
        maxResults: String(maxResults),
      };
      if (args.objectType) query.objectType = args.objectType;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/repository/informationsystem/search",
        query,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const refs = parseObjectReferences(text);
      return jsonResult({
        system: sys,
        query: args.query,
        count: refs.length,
        hasMore: refs.length >= maxResults,
        results: refs,
      });
    },

    adt_where_used: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const uri = objectUri({ type: args.type, name: args.object, group: args.group });
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/repository/informationsystem/usageReferences",
        query: { uri },
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const refs = parseObjectReferences(text);
      return jsonResult({
        system: sys,
        object: args.object,
        count: refs.length,
        references: refs,
        raw: refs.length === 0 ? text : undefined,
      });
    },

    adt_browse_package: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const pkg = args.package.toUpperCase();
      const r = await fetchPackageNodes(client, pkg);
      if (!r.ok) return errorResult(sys, r.status, r.body);
      return jsonResult({ system: sys, package: pkg, total: r.nodes.length, entries: r.nodes });
    },

    adt_list_packages: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const root = args.root.toUpperCase();
      const max = args.maxPackages ?? 200;
      const prefix = args.prefix ?? defaultDescendPrefix(root);

      const visited = new Set();
      const packages = {};

      async function walk(pkg) {
        if (visited.size >= max) return;
        if (visited.has(pkg)) return;
        visited.add(pkg);
        const r = await fetchPackageNodes(client, pkg);
        if (!r.ok) {
          packages[pkg] = { error: { status: r.status } };
          return;
        }
        const byType = {};
        for (const n of r.nodes) {
          (byType[n.type] = byType[n.type] || []).push({
            name: n.name,
            description: n.description,
          });
        }
        packages[pkg] = {
          counts: Object.fromEntries(
            Object.entries(byType).map(([k, v]) => [k, v.length])
          ),
          entries: byType,
        };
        for (const n of r.nodes) {
          if (n.type === "DEVC/K" && n.name.startsWith(prefix)) {
            await walk(n.name);
          }
        }
      }

      await walk(root);

      return jsonResult({
        system: sys,
        root,
        prefix,
        packagesVisited: visited.size,
        truncated: visited.size >= max,
        packages,
      });
    },
  };
}
