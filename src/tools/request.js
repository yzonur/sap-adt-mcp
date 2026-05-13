import { errorResult, jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

export const tools = [
  {
    name: "adt_request",
    description:
      "Generic ADT REST call — escape hatch for endpoints not covered by a high-level tool. Handles Basic auth, sap-client, cookies, CSRF token automatically. Path is confined to the /sap/bc/adt/ namespace.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        method: {
          type: "string",
          description: "HTTP method (GET, POST, PUT, DELETE, PATCH). Default GET.",
        },
        path: {
          type: "string",
          description:
            "ADT path, e.g. '/sap/bc/adt/discovery' or '/sap/bc/adt/programs/programs/zhello/source/main'.",
        },
        query: {
          type: "object",
          description: "Query-string parameters.",
          additionalProperties: true,
        },
        body: {
          description: "Request body. Strings are sent as-is; objects are JSON-encoded.",
        },
        headers: {
          type: "object",
          description: "Extra request headers.",
          additionalProperties: { type: "string" },
        },
        accept: {
          type: "string",
          description: "Override for the Accept header (e.g. 'text/plain' for ABAP source).",
        },
      },
      required: ["path"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_request: async (args) => {
      if (typeof args.path !== "string") {
        return textResult("`path` is required and must be a string.", true);
      }
      const { client, name: sys } = getClient(args.system);
      // Confine adt_request to the ADT namespace. Without this, the tool is a
      // confused-deputy primitive: a caller could use the configured SAP
      // credentials to hit OData, SOAP/RFC, or any other ICF service.
      // Path traversal is collapsed first so "/sap/bc/adt/../opu/odata/..."
      // can't slip through.
      let resolved;
      try {
        resolved = client.resolvePath(args.path);
      } catch (err) {
        return textResult(`adt_request: ${err.message}`, true);
      }
      const pathnameOnly = resolved.split("?")[0];
      if (!pathnameOnly.toLowerCase().startsWith("/sap/bc/adt/")) {
        return textResult(
          `adt_request: path must be under /sap/bc/adt/. Got: ${pathnameOnly}`,
          true
        );
      }
      const res = await client.request({
        method: args.method,
        path: args.path,
        query: args.query,
        body: args.body,
        headers: args.headers,
        accept: args.accept,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({
        system: sys,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type"),
        body: text,
      });
    },
  };
}
