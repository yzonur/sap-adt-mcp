import { objectUri } from "../object-uris.js";
import { parseDataPreview } from "../data-preview.js";
import { parseObjectReferences } from "../object-references.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

const CDS_PREVIEW_PATH = "/sap/bc/adt/datapreview/cds";
const GRAPHDATA_PATH = "/sap/bc/adt/ddic/ddl/dependencies/graphdata";
const RELATED_PATH = "/sap/bc/adt/ddic/ddl/relatedObjects";
const RELEASESTATES_PATH = "/sap/bc/adt/repository/informationsystem/releasestates";

const DEFAULT_MAX_ROWS = 100;
const HARD_CAP_ROWS = 5000;

// Parse <nameditem:namedItem> entries (name / description / data).
const NAMED_ITEM_RE =
  /<(?:nameditem:)?namedItem>([\s\S]*?)<\/(?:nameditem:)?namedItem>/gi;
function tag(block, name) {
  const m = block.match(new RegExp(`<(?:nameditem:)?${name}>([\\s\\S]*?)</(?:nameditem:)?${name}>`));
  return m ? m[1] : undefined;
}
export function parseNamedItems(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(NAMED_ITEM_RE)) {
    const name = tag(m[1], "name");
    if (!name) continue;
    out.push({ name, description: tag(m[1], "description"), data: tag(m[1], "data") });
  }
  return out;
}

export const tools = [
  {
    name: "adt_cds_data_preview",
    description:
      "Preview the data exposed by a CDS view (DDL source) via the ADT CDS Data Preview endpoint. Read-only. Returns structured { columns, rows } just like adt_read_table, but you only pass the CDS entity / DDL source name — no SQL. Requires a system with CDS support (NetWeaver 7.5x+ / S/4HANA).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        entity: {
          type: "string",
          description: "CDS DDL source name (the DDLS object name, e.g. 'I_CURRENCY' or 'ZC_MYVIEW').",
        },
        maxRows: {
          type: "integer",
          description: `Maximum rows to return. Default ${DEFAULT_MAX_ROWS}, max ${HARD_CAP_ROWS}.`,
          minimum: 1,
          maximum: HARD_CAP_ROWS,
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "adt_cds_dependencies",
    description:
      "Return the dependency graph of a CDS view — the entities it consumes (and, where the system exposes it, related objects). Uses the ADT DDL dependency graphdata endpoint. Returns the parsed object references plus the raw graph payload. Requires CDS support.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        entity: { type: "string", description: "CDS DDL source name (DDLS object name)." },
        includeRelated: {
          type: "boolean",
          description: "Also fetch the relatedObjects list (default false). Best-effort; ignored on releases without the endpoint.",
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "adt_list_released_apis",
    description:
      "List the API release-state contracts the system defines — the catalog used to classify released objects (e.g. USE_IN_KEY_USER_APPS = C1, ADD_CUSTOM_FIELDS = C0), each with its compatibility-contract description. This is the released-API classification catalog, not a per-object enumeration (object-level released-API listing requires the release-dependent RIS search facet). Backed by repository/informationsystem/releasestates.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
      },
    },
  },
];

export function register({ getClient }) {
  return {
    adt_cds_data_preview: async (args) => {
      // `entity` is the documented field, but callers reach for `name`/`cdsName`;
      // accept those too and fail cleanly rather than throwing on `.toUpperCase`.
      const entity = args.entity ?? args.name ?? args.cdsName;
      if (typeof entity !== "string" || entity.length === 0) {
        return textResult(
          "adt_cds_data_preview: `entity` is required (the CDS view/entity name, e.g. 'I_CompanyCode').",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const max = Math.min(args.maxRows ?? DEFAULT_MAX_ROWS, HARD_CAP_ROWS);
      const res = await client.request({
        method: "POST",
        path: CDS_PREVIEW_PATH,
        query: { ddlSourceName: entity.toUpperCase(), rowNumber: String(max) },
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      let parsed;
      try {
        parsed = parseDataPreview(text);
      } catch (err) {
        return jsonResult({ system: sys, entity, parseError: err.message, raw: text.slice(0, 8000) });
      }
      const rowCount = parsed.rows.length;
      return jsonResult({
        system: sys,
        entity: entity.toUpperCase(),
        rowCount,
        truncated: rowCount >= max,
        totalRows: parsed.totalRows,
        columns: parsed.columns,
        rows: parsed.rows,
        raw: parsed.columns.length === 0 && rowCount === 0 ? text.slice(0, 4000) : undefined,
      });
    },

    adt_cds_dependencies: async (args) => {
      const entity = args.entity ?? args.name ?? args.cdsName;
      if (typeof entity !== "string" || entity.length === 0) {
        return textResult(
          "adt_cds_dependencies: `entity` is required (the CDS view/entity name, e.g. 'I_CompanyCode').",
          true
        );
      }
      const { client, name: sys } = getClient(args.system);
      const uri = objectUri({ type: "ddls", name: entity });
      const res = await client.request({ path: GRAPHDATA_PATH, query: { uri }, accept: "application/xml" });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "graphdata" });

      const refs = parseObjectReferences(text);
      let related;
      if (args.includeRelated) {
        const relRes = await client.request({ path: RELATED_PATH, query: { uri }, accept: "application/xml" });
        const relText = await relRes.text();
        related = relRes.ok ? parseObjectReferences(relText) : { error: `HTTP ${relRes.status}` };
      }
      return jsonResult({
        system: sys,
        entity: entity.toUpperCase(),
        uri,
        dependencyCount: refs.length,
        dependencies: refs,
        related,
        raw: refs.length === 0 ? text.slice(0, 6000) : undefined,
      });
    },

    adt_list_released_apis: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({ path: RELEASESTATES_PATH, accept: "application/xml" });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      const contracts = parseNamedItems(text);
      return jsonResult({
        system: sys,
        count: contracts.length,
        contracts,
        raw: contracts.length === 0 ? text.slice(0, 4000) : undefined,
      });
    },
  };
}
