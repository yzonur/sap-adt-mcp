import { buildCreateRequest, postCreate } from "../object-create.js";
import { sourceUri } from "../object-uris.js";
import { acquireLock, releaseLock } from "../lock.js";
import { escapeXml } from "../xml.js";
import { jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

// adt_rap_scaffold — generate (and optionally create) a full RAP stack from a
// short spec: CDS root view entity → behavior definition → behavior pool class
// → service definition → service binding.
//
// dryRun defaults to TRUE: the tool returns the planned artifacts and their
// generated source so they can be reviewed before anything is written. Set
// dryRun:false to actually create them, in dependency order. Creation is
// subject to read-only mode (each step POSTs to ADT). The service binding is
// PLAN-ONLY — it requires an interactive publish step that is unsafe to
// automate; create/publish it via the ADT UI or adt_request after reviewing.

function deriveNames(spec) {
  const base = spec.name.toUpperCase().replace(/^Z?[CIB]?_?/, "");
  const ns = spec.name.toUpperCase().startsWith("Z") ? "" : "Z";
  return {
    view: spec.viewName?.toUpperCase() ?? `${ns}I_${base}`,
    behavior: spec.viewName?.toUpperCase() ?? `${ns}I_${base}`, // BDEF shares the view name
    implClass: spec.implClass?.toUpperCase() ?? `${ns}BP_${spec.viewName?.toUpperCase() ?? `I_${base}`}`,
    serviceDef: spec.serviceDef?.toUpperCase() ?? `${ns}SD_${base}`,
    serviceBinding: spec.serviceBinding?.toUpperCase() ?? `${ns}SB_${base}`,
    alias: spec.alias ?? base.toLowerCase(),
  };
}

function cdsSource(n, spec) {
  const keys = (spec.keyFields ?? ["key_field"])
    .map((k) => `  key ${k} as ${toCamel(k)}`)
    .join(",\n");
  const fields = (spec.fields ?? [])
    .map((f) => `  ${f} as ${toCamel(f)}`)
    .join(",\n");
  const body = [keys, fields].filter(Boolean).join(",\n");
  return (
    `@AccessControl.authorizationCheck: #NOT_REQUIRED\n` +
    `@Metadata.allowExtensions: true\n` +
    `@EndUserText.label: '${(spec.description ?? n).slice(0, 60)}'\n` +
    `define root view entity ${n}\n` +
    `  as select from ${spec.dataSource}\n` +
    `{\n${body}\n}\n`
  );
}

function bdefSource(names, spec) {
  return (
    `managed implementation in class ${names.implClass} unique;\n` +
    `strict ( 2 );\n\n` +
    `define behavior for ${names.view} alias ${names.alias}\n` +
    `persistent table ${spec.dataSource}\n` +
    `lock master\n` +
    `authorization master ( instance )\n` +
    `{\n` +
    `  create;\n  update;\n  delete;\n` +
    (spec.keyFields ?? ["key_field"]).map((k) => `  field ( readonly, numbering : managed ) ${k};`).join("\n") +
    `\n}\n`
  );
}

function implClassSource(names) {
  return (
    `CLASS ${names.implClass} DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF ${names.view}.\n` +
    `ENDCLASS.\n\n` +
    `CLASS ${names.implClass} IMPLEMENTATION.\n` +
    `ENDCLASS.\n`
  );
}

function serviceDefSource(names, spec) {
  return (
    `@EndUserText.label: '${(spec.description ?? names.serviceDef).slice(0, 60)}'\n` +
    `define service ${names.serviceDef} {\n` +
    `  expose ${names.view} as ${names.alias};\n` +
    `}\n`
  );
}

function toCamel(field) {
  return field
    .toLowerCase()
    .split("_")
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

// Build the full ordered artifact plan. Pure — no I/O. Each artifact carries the
// source plus, for auto-creatable ones, its create type. The service binding is
// flagged planOnly.
export function generateRapStack(spec) {
  const names = deriveNames(spec);
  return [
    {
      kind: "CDS root view entity",
      type: "ddls",
      name: names.view,
      source: cdsSource(names.view, spec),
    },
    {
      kind: "Behavior definition",
      type: "bdef",
      name: names.behavior,
      source: bdefSource(names, spec),
    },
    {
      kind: "Behavior implementation class",
      type: "class",
      name: names.implClass,
      source: implClassSource(names),
    },
    {
      kind: "Service definition",
      type: "srvd",
      name: names.serviceDef,
      source: serviceDefSource(names, spec),
    },
    {
      kind: "Service binding (OData V4 UI)",
      type: "srvb",
      name: names.serviceBinding,
      planOnly: true,
      note:
        "Service bindings require an activation/publish step that is unsafe to automate. " +
        "Create it in the ADT UI (or via adt_request) referencing the service definition above, then Publish.",
    },
  ];
}

// Create endpoint info for the source-based RAP artifacts. DDLS/BDEF/CLAS reuse
// the tested buildCreateRequest; SRVD has no buildCreateRequest case so its POST
// shape is defined here (experimental).
function createInfoFor(artifact, spec) {
  if (artifact.type === "srvd") {
    return {
      path: "/sap/bc/adt/ddic/srvd/sources",
      contentType: "application/vnd.sap.adt.ddic.srvd.v1+xml",
      body:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<srvd:srvdSource xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources"` +
        ` xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:name="${escapeXml(artifact.name)}" adtcore:type="SRVD/SRV"` +
        ` adtcore:description="${escapeXml((spec.description ?? artifact.name).slice(0, 60))}">` +
        `<adtcore:packageRef adtcore:name="${escapeXml(spec.package.toUpperCase())}"/>` +
        `</srvd:srvdSource>`,
    };
  }
  const req = buildCreateRequest({
    type: artifact.type,
    name: artifact.name,
    package: spec.package,
    description: spec.description ?? artifact.name,
  });
  return req;
}

async function createAndWrite(client, artifact, spec) {
  const info = createInfoFor(artifact, spec);
  // 1) create the object (retrying with lower media-type versions on 415)
  const { res: createRes, text: createText } = await postCreate(client, {
    path: info.path,
    contentType: info.contentType,
    body: info.body,
    query: spec.transport ? { corrNr: spec.transport } : undefined,
  });
  if (!createRes.ok) {
    return { name: artifact.name, stage: "create", status: createRes.status, error: createText.slice(0, 400) };
  }
  // 2) write the source
  const srcPath = sourceUri({ type: artifact.type, name: artifact.name });
  const lock = await acquireLock(client, sourceUri({ type: artifact.type, name: artifact.name }).replace(/\/source\/main$/, ""), { corrNr: spec.transport });
  if (!lock.ok) {
    return { name: artifact.name, stage: "lock", status: lock.status, error: lock.error ?? "lock failed" };
  }
  try {
    const putQuery = { lockHandle: lock.handle };
    if (spec.transport) putQuery.corrNr = spec.transport;
    const putRes = await client.request({
      method: "PUT",
      path: srcPath,
      query: putQuery,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-sap-adt-sessiontype": "stateful" },
      body: artifact.source,
    });
    const putText = await putRes.text();
    if (!putRes.ok) {
      return { name: artifact.name, stage: "source", status: putRes.status, error: putText.slice(0, 400) };
    }
    return { name: artifact.name, status: "created" };
  } finally {
    try {
      await releaseLock(client, sourceUri({ type: artifact.type, name: artifact.name }).replace(/\/source\/main$/, ""), lock.handle);
    } catch {
      // best-effort
    }
  }
}

export const tools = [
  {
    name: "adt_rap_scaffold",
    description:
      "Generate a complete RAP stack from a short spec: CDS root view entity → behavior definition (managed) → behavior implementation class → service definition → service binding. DEFAULTS TO dryRun:true — returns the planned object names and generated source for review WITHOUT creating anything. Set dryRun:false to actually create them in dependency order (subject to read-only mode; requires a transport for non-local packages). The service binding is always plan-only (its publish step is not automated). Built on the same create primitives as adt_create_object.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        name: { type: "string", description: "Base name for the scenario (e.g. 'TRAVEL' or 'ZI_TRAVEL'). Used to derive artifact names unless overridden." },
        dataSource: { type: "string", description: "The persistent table or CDS the root view selects from / the behavior persists to (e.g. 'ZTRAVEL')." },
        package: { type: "string", description: "Target package for all generated objects." },
        keyFields: { type: "array", items: { type: "string" }, description: "Key field name(s) of the data source. Default ['key_field'] (placeholder)." },
        fields: { type: "array", items: { type: "string" }, description: "Additional (non-key) fields to expose in the CDS view." },
        description: { type: "string", description: "Description applied to the generated objects." },
        alias: { type: "string", description: "Behavior/service alias (default: derived from name)." },
        viewName: { type: "string", description: "Override the CDS view / behavior definition name." },
        implClass: { type: "string", description: "Override the behavior implementation class name." },
        serviceDef: { type: "string", description: "Override the service definition name." },
        serviceBinding: { type: "string", description: "Override the service binding name." },
        transport: { type: "string", description: "Transport request for the created objects (required for non-local packages when dryRun:false)." },
        dryRun: { type: "boolean", description: "When true (DEFAULT), only plan + generate source; create nothing." },
      },
      required: ["name", "dataSource", "package"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_rap_scaffold: async (args) => {
      if (!args.name || !args.dataSource || !args.package) {
        return textResult("adt_rap_scaffold: `name`, `dataSource` and `package` are required.", true);
      }
      const { client, name: sys } = getClient(args.system);
      const plan = generateRapStack(args);
      const dryRun = args.dryRun !== false;

      if (dryRun) {
        return jsonResult({
          system: sys,
          dryRun: true,
          package: args.package.toUpperCase(),
          artifacts: plan.map((a) => ({
            kind: a.kind,
            type: a.type,
            name: a.name,
            planOnly: a.planOnly ?? false,
            note: a.note,
            source: a.source,
          })),
          next: "Review the generated source, then re-run with dryRun:false to create the source-based artifacts (the service binding stays manual).",
        });
      }

      // Create the source-based artifacts in dependency order; stop on first error.
      const results = [];
      for (const artifact of plan) {
        if (artifact.planOnly) {
          results.push({ name: artifact.name, status: "plan-only", note: artifact.note });
          continue;
        }
        const r = await createAndWrite(client, artifact, args);
        results.push(r);
        if (r.error) break; // halt the chain — later artifacts depend on this one
      }
      const failed = results.find((r) => r.error);
      return jsonResult(
        {
          system: sys,
          dryRun: false,
          package: args.package.toUpperCase(),
          transport: args.transport,
          results,
          ok: !failed,
          note: failed
            ? "Creation halted at the first failure — earlier artifacts may have been created and need manual cleanup/activation."
            : "Source-based artifacts created. Activate them (adt_activate) and create+publish the service binding manually.",
        },
        Boolean(failed),
      );
    },
  };
}
