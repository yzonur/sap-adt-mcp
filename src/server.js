#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { AdtClient, ReadOnlyViolationError } from "./adt-client.js";
import { parseAdtError } from "./adt-error.js";
import { objectUri, sourceUri, normalizeType } from "./object-uris.js";
import { fetchPackageNodes } from "./node-structure.js";
import { unifiedLineDiff } from "./diff.js";
import { parseObjectReferences } from "./object-references.js";
import { buildCreateRequest } from "./object-create.js";
import { listPrompts, getPrompt } from "./prompts.js";

const PKG = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8"
  )
);

// --- CLI dispatch (flag-only commands exit before MCP server boot) -----------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${PKG.name} ${PKG.version}\n`);
  process.exit(0);
}
if (argv.includes("--validate-config")) {
  await validateConfig();
  // validateConfig() exits.
}

// --- MCP server boot ---------------------------------------------------------
const config = loadConfig();
process.stderr.write(
  `[${PKG.name}] v${PKG.version} — loaded ${Object.keys(config.systems).length} system(s) from ${config.configPath}; default=${config.defaultSystem ?? "none"}${config.readOnly ? " (global read-only)" : ""}\n`
);
const clients = new Map();

function getClient(systemName) {
  const name = systemName ?? config.defaultSystem;
  if (!name) {
    throw new Error(
      "No system specified and no defaultSystem configured. " +
        `Available: ${Object.keys(config.systems).join(", ")}`
    );
  }
  const profile = config.systems[name];
  if (!profile) {
    throw new Error(
      `Unknown system '${name}'. Available: ${Object.keys(config.systems).join(", ")}`
    );
  }
  if (!clients.has(name)) clients.set(name, new AdtClient(profile));
  return { name, client: clients.get(name), profile };
}

const OBJECT_TYPE_HINT =
  "Object type — friendly alias (program, class, interface, function, functiongroup, include, table, dataelement, domain, cds) or TADIR code (PROG, CLAS, INTF, FUGR, FUGR/FF, INCL, TABL, DTEL, DOMA, DDLS).";

const tools = [
  {
    name: "adt_list_systems",
    description:
      "List configured SAP systems available for ADT calls, the default system, and read-only flags.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "adt_ping",
    description:
      "Ping a configured SAP system by calling the ADT discovery endpoint. Use to verify credentials and network reachability.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
      },
    },
  },
  {
    name: "adt_get_source",
    description:
      "Fetch the ABAP source of an object (program, class, interface, function module, include, CDS, table). Returns plain text.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name (case-insensitive)." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: {
          type: "string",
          description: "Function group name (required when type is function / FUGR/FF or FUGR/I).",
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
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: {
          type: "string",
          description: "For classes: main / definitions / implementations / macros / testclasses.",
        },
        source: {
          type: "string",
          description: "New source text (UTF-8, plain text). Will replace the entire source body.",
        },
        transport: {
          type: "string",
          description: "Optional transport request number (CORRNR) to assign the change to.",
        },
        lockHandle: {
          type: "string",
          description:
            "If provided, skip the internal lock/unlock and reuse this handle (e.g. one obtained via adt_lock for a multi-write session). Caller is then responsible for adt_unlock.",
        },
      },
      required: ["object", "type", "source"],
    },
  },
  {
    name: "adt_activate",
    description:
      "Activate one or more inactive ABAP objects. Returns the activation result, including any errors or warnings.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        objects: {
          type: "array",
          description: "Objects to activate. Each entry: { name, type, group? }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
          minItems: 1,
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_syntax_check",
    description:
      "Run the ADT syntax checker on an existing object. Returns the list of issues (errors and warnings) found.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: { type: "string", description: "For classes: which include." },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_search_objects",
    description:
      "Quick-search the ABAP repository for objects whose name matches a pattern. Use '*' as wildcard.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
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
    description:
      "Where-used list for an object. Returns the references that point to it.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
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
      "List the immediate contents (one level) of an ABAP package: subpackages, classes, programs, etc. Use adt_list_packages for recursive walks.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
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
      "Recursively walk subpackages from a root package. Returns a flattened map of package → contents (counts and entries grouped by type). Useful for project discovery.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        root: {
          type: "string",
          description: "Root package name to walk from.",
        },
        prefix: {
          type: "string",
          description:
            "Only descend into subpackages whose name starts with this prefix. Defaults to namespace prefix (e.g. '/FOO/' for '/FOO/MAIN') or first character for non-namespaced packages.",
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
  {
    name: "adt_compare_source",
    description:
      "Compare the source of the same object across two systems. Returns a unified-diff plus added/removed line counts. Useful for landscape comparison (e.g. DEV vs PRD).",
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
    name: "adt_list_transports",
    description:
      "List transport requests visible to the configured user. Filter by user (requestor) and / or status (modifiable / released). Endpoint shape may vary across NetWeaver releases — falls back to adt_request if your system uses a different path.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        user: {
          type: "string",
          description: "Filter by requestor user. Omit for the configured connection user.",
        },
        status: {
          type: "string",
          enum: ["modifiable", "released", "all"],
          description: "Status filter (default modifiable).",
        },
        targets: {
          type: "string",
          description: "Optional comma-separated target system list.",
        },
      },
    },
  },
  {
    name: "adt_get_transport",
    description: "Fetch detail of a single transport request (header + included objects).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        transport: {
          type: "string",
          description: "Transport request ID, e.g. 'E4DK900123'.",
        },
      },
      required: ["transport"],
    },
  },
  {
    name: "adt_pretty_print",
    description:
      "Pretty-print ABAP source using the SAP-side formatter — applies the same rules as Eclipse ADT.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        source: { type: "string", description: "ABAP source code to format." },
      },
      required: ["source"],
    },
  },
  {
    name: "adt_run_unit_tests",
    description:
      "Run ABAP Unit tests for one or more objects (typically classes containing test classes). Returns the test run report (XML).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        objects: {
          type: "array",
          description: "Objects to run tests for. Each entry: { name, type, group? }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
          minItems: 1,
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_run_atc",
    description:
      "Run an ABAP Test Cockpit (ATC) check on the given objects. Returns the run report (XML). NOTE: ATC API surface varies across NetWeaver releases; if your system rejects this call, fall back to adt_request with the appropriate path.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        objects: {
          type: "array",
          description: "Objects to check. Each entry: { name, type, group? }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
          minItems: 1,
        },
        checkVariant: {
          type: "string",
          description: "ATC check variant (default 'DEFAULT' — may differ on your system).",
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_transport_diff",
    description:
      "For every object inside a transport request on systemA, fetch the same object from systemB and emit a diff. Useful before / after a release to verify what actually moved.",
    inputSchema: {
      type: "object",
      properties: {
        systemA: { type: "string", description: "System where the TR lives (typically DEV)." },
        systemB: { type: "string", description: "Target system to compare against (typically QAS or PRD)." },
        transport: { type: "string", description: "Transport request ID, e.g. 'E4DK900123'." },
        context: {
          type: "integer",
          description: "Lines of context per diff hunk (default 3).",
          minimum: 0,
          maximum: 20,
        },
        maxObjects: {
          type: "integer",
          description: "Cap on objects diffed (default 50).",
          minimum: 1,
          maximum: 500,
        },
      },
      required: ["systemA", "systemB", "transport"],
    },
  },
  {
    name: "adt_create_transport",
    description:
      "Create a new transport request. Returns the new TR number. Subject to read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        description: { type: "string", description: "Short description of the TR." },
        type: {
          type: "string",
          enum: ["K", "W"],
          description: "TR type — K = workbench (default), W = customizing.",
        },
        target: {
          type: "string",
          description: "Target system / consolidation route. Omit for default route.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "adt_release_transport",
    description: "Release a transport request. Subject to read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        transport: { type: "string", description: "Transport request ID." },
      },
      required: ["transport"],
    },
  },
  {
    name: "adt_create_object",
    description:
      "Create a new ABAP object in a package. Returns the new object URI on success. After creation, set the source body with adt_set_source and activate with adt_activate. Subject to read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        name: { type: "string", description: "Object name (will be uppercased)." },
        type: {
          type: "string",
          description:
            "Object type alias or TADIR code. Supported for create: program, class, interface, include, functiongroup, function, cds, accesscontrol, metadataext, behaviordef, messageclass.",
        },
        package: { type: "string", description: "Package to create the object in (e.g. 'ZLOCAL')." },
        description: { type: "string", description: "Short description (max 60 chars). Defaults to the object name." },
        group: { type: "string", description: "Function group (required for type=function)." },
        programType: {
          type: "string",
          description: "For type=program: 'executableProgram' (default), 'modulePool', 'functionGroup', 'subroutinePool', 'typeGroup', 'includeProgram'.",
        },
        responsible: {
          type: "string",
          description: "Responsible user. Defaults to the connection user.",
        },
        transport: {
          type: "string",
          description: "Optional transport request (corrNr) to assign the new object to.",
        },
      },
      required: ["name", "type", "package"],
    },
  },
  {
    name: "adt_delete_object",
    description:
      "Delete an ABAP object. Acquires a lock and sends DELETE on the object URI. Subject to read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF)." },
        transport: { type: "string", description: "Optional transport (corrNr) to record the deletion under." },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_lock",
    description:
      "Acquire a MODIFY lock on an object and return the lockHandle. Use this to perform multiple set_source calls under a single sticky session, then call adt_unlock when done. For one-shot edits, prefer adt_set_source — it manages the lock for you.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF)." },
        accessMode: {
          type: "string",
          enum: ["MODIFY", "DISPLAY"],
          description: "Lock mode. Default MODIFY.",
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_unlock",
    description: "Release a previously acquired lock.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF)." },
        lockHandle: { type: "string", description: "The handle returned by adt_lock." },
      },
      required: ["object", "type", "lockHandle"],
    },
  },
  {
    name: "adt_request",
    description:
      "Generic ADT REST call — escape hatch for endpoints not covered by a high-level tool. Handles Basic auth, sap-client, cookies, CSRF token automatically.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
        method: {
          type: "string",
          description: "HTTP method. Default GET.",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        },
        path: {
          type: "string",
          description:
            "ADT path, e.g. '/sap/bc/adt/discovery' or '/sap/bc/adt/programs/programs/zhello/source/main'",
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

const server = new Server(
  { name: "claude-for-abap", version: PKG.version },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  return getPrompt(name, args);
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "adt_list_systems":
        return textResult(
          JSON.stringify(
            {
              defaultSystem: config.defaultSystem ?? null,
              globalReadOnly: config.readOnly === true,
              systems: Object.entries(config.systems).map(([n, p]) => ({
                name: n,
                host: p.host,
                client: p.client,
                user: p.user,
                readOnly: p.readOnly === true,
                rejectUnauthorized: p.rejectUnauthorized,
                isDefault: n === config.defaultSystem,
              })),
            },
            null,
            2
          )
        );

      case "adt_ping":
        return await handlePing(args);
      case "adt_get_source":
        return await handleGetSource(args);
      case "adt_set_source":
        return await handleSetSource(args);
      case "adt_activate":
        return await handleActivate(args);
      case "adt_syntax_check":
        return await handleSyntaxCheck(args);
      case "adt_search_objects":
        return await handleSearch(args);
      case "adt_where_used":
        return await handleWhereUsed(args);
      case "adt_browse_package":
        return await handleBrowsePackage(args);
      case "adt_list_packages":
        return await handleListPackages(args);
      case "adt_compare_source":
        return await handleCompareSource(args);
      case "adt_list_transports":
        return await handleListTransports(args);
      case "adt_get_transport":
        return await handleGetTransport(args);
      case "adt_pretty_print":
        return await handlePrettyPrint(args);
      case "adt_run_unit_tests":
        return await handleRunUnitTests(args);
      case "adt_run_atc":
        return await handleRunAtc(args);
      case "adt_transport_diff":
        return await handleTransportDiff(args);
      case "adt_create_transport":
        return await handleCreateTransport(args);
      case "adt_release_transport":
        return await handleReleaseTransport(args);
      case "adt_create_object":
        return await handleCreateObject(args);
      case "adt_delete_object":
        return await handleDeleteObject(args);
      case "adt_lock":
        return await handleLock(args);
      case "adt_unlock":
        return await handleUnlock(args);
      case "adt_request":
        return await handleRequest(args);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    if (err instanceof ReadOnlyViolationError) {
      return textResult(JSON.stringify({ error: err.message, code: err.code }, null, 2), true);
    }
    return textResult(`Error: ${err.message}`, true);
  }
});

async function handlePing(args) {
  const { client, name: sys } = getClient(args.system);
  const res = await client.request({ path: "/sap/bc/adt/discovery" });
  return textResult(
    JSON.stringify({ system: sys, status: res.status, ok: res.ok }, null, 2),
    !res.ok
  );
}

async function handleGetSource(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        path,
        source: text,
        bytes: text.length,
        lines: text.split(/\r?\n/).length,
      },
      null,
      2
    )
  );
}

async function handleSetSource(args) {
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

  // External-lock mode: caller already owns a handle; we only PUT.
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
    return textResult(
      JSON.stringify(
        {
          system: sys,
          object: args.object,
          type: normalizeType(args.type),
          path: srcPath,
          status: "updated",
          httpStatus: putRes.status,
          lockHandle: externalLock ? handle : undefined,
        },
        null,
        2
      )
    );
  } finally {
    if (!externalLock) {
      // Best-effort unlock; never throw out of the finally.
      try {
        await releaseLock(client, objUri, handle);
      } catch {
        // ignore
      }
    }
  }
}

async function handleActivate(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        status: res.status,
        result: text,
      },
      null,
      2
    )
  );
}

async function handleSyntaxCheck(args) {
  const { client, name: sys } = getClient(args.system);
  const objUri = objectUri({
    type: args.type,
    name: args.object,
    group: args.group,
  });
  const checkBody =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<chkrun:checkObject adtcore:uri="${escapeXml(objUri)}"/>` +
    `</chkrun:checkObjectList>`;
  const res = await client.request({
    method: "POST",
    path: "/sap/bc/adt/checkruns",
    query: { reporters: "abapCheckRun" },
    headers: { "Content-Type": "application/vnd.sap.adt.checkobjects+xml" },
    body: checkBody,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        result: text,
      },
      null,
      2
    )
  );
}

async function handleSearch(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        query: args.query,
        count: refs.length,
        hasMore: refs.length >= maxResults,
        results: refs,
      },
      null,
      2
    )
  );
}

async function handleWhereUsed(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        count: refs.length,
        references: refs,
        raw: refs.length === 0 ? text : undefined,
      },
      null,
      2
    )
  );
}

async function handleBrowsePackage(args) {
  const { client, name: sys } = getClient(args.system);
  const pkg = args.package.toUpperCase();
  const r = await fetchPackageNodes(client, pkg);
  if (!r.ok) return errorResult(sys, r.status, r.body);
  return textResult(
    JSON.stringify(
      { system: sys, package: pkg, total: r.nodes.length, entries: r.nodes },
      null,
      2
    )
  );
}

async function handleListPackages(args) {
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

  const truncated = visited.size >= max;
  return textResult(
    JSON.stringify(
      {
        system: sys,
        root,
        prefix,
        packagesVisited: visited.size,
        truncated,
        packages,
      },
      null,
      2
    )
  );
}

function defaultDescendPrefix(pkg) {
  if (pkg.startsWith("/")) {
    const second = pkg.indexOf("/", 1);
    if (second > 0) return pkg.slice(0, second + 1);
  }
  return pkg[0] ?? "";
}

async function handleCompareSource(args) {
  const aClient = getClient(args.systemA);
  const bClient = getClient(args.systemB);
  const path = sourceUri({
    type: args.type,
    name: args.object,
    group: args.group,
    include: args.include,
  });

  const [resA, resB] = await Promise.all([
    aClient.client.request({ path, accept: "text/plain" }),
    bClient.client.request({ path, accept: "text/plain" }),
  ]);
  const [textA, textB] = await Promise.all([resA.text(), resB.text()]);

  if (!resA.ok) return errorResult(aClient.name, resA.status, textA, resA.headers.get("content-type"), { side: "A" });
  if (!resB.ok) return errorResult(bClient.name, resB.status, textB, resB.headers.get("content-type"), { side: "B" });

  const diff = unifiedLineDiff(textA, textB, {
    context: args.context ?? 3,
    fromFile: `${aClient.name}:${args.object}`,
    toFile: `${bClient.name}:${args.object}`,
  });
  return textResult(
    JSON.stringify(
      {
        object: args.object,
        type: normalizeType(args.type),
        systemA: aClient.name,
        systemB: bClient.name,
        identical: diff.identical,
        stats: diff.stats,
        path,
        diff: diff.diff,
      },
      null,
      2
    )
  );
}

async function handleListTransports(args) {
  const { client, name: sys, profile } = getClient(args.system);
  const status = args.status ?? "modifiable";
  const query = {};
  query.user = args.user ?? profile.user;
  if (status !== "all") query.status = status;
  if (args.targets) query.targets = args.targets;

  const res = await client.request({
    path: "/sap/bc/adt/cts/transportrequests",
    query,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(
    JSON.stringify(
      {
        system: sys,
        filters: query,
        result: text,
      },
      null,
      2
    )
  );
}

async function handleGetTransport(args) {
  const { client, name: sys } = getClient(args.system);
  const res = await client.request({
    path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(args.transport.toUpperCase())}`,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(
    JSON.stringify({ system: sys, transport: args.transport.toUpperCase(), result: text }, null, 2)
  );
}

async function handlePrettyPrint(args) {
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
  return textResult(JSON.stringify({ system: sys, source: text }, null, 2));
}

async function handleRunUnitTests(args) {
  const { client, name: sys } = getClient(args.system);
  const refs = args.objects
    .map((o) => {
      const uri = objectUri({ type: o.type, name: o.name, group: o.group });
      return `<adtcore:objectReference adtcore:uri="${escapeXml(uri)}"/>`;
    })
    .join("");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:objectSets><adtcore:objectSet kind="inclusive">${refs}</adtcore:objectSet></adtcore:objectSets>` +
    `</aunit:runConfiguration>`;
  const res = await client.request({
    method: "POST",
    path: "/sap/bc/adt/abapunit/testruns",
    headers: { "Content-Type": "application/vnd.sap.adt.abapunit.testruns.config.v1+xml" },
    body,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(JSON.stringify({ system: sys, result: text }, null, 2));
}

async function handleRunAtc(args) {
  const { client, name: sys } = getClient(args.system);
  const refs = args.objects
    .map((o) => {
      const uri = objectUri({ type: o.type, name: o.name, group: o.group });
      return `<adtcore:objectReference adtcore:uri="${escapeXml(uri)}"/>`;
    })
    .join("");
  const variant = args.checkVariant ?? "DEFAULT";
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<atc:run xmlns:atc="http://www.sap.com/adt/atc" xmlns:adtcore="http://www.sap.com/adt/core" atc:checkVariant="${escapeXml(variant)}">` +
    `<objectSets><objectSet kind="inclusive">${refs}</objectSet></objectSets>` +
    `</atc:run>`;
  const res = await client.request({
    method: "POST",
    path: "/sap/bc/adt/atc/runs",
    headers: { "Content-Type": "application/xml" },
    body,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(
    JSON.stringify(
      {
        system: sys,
        checkVariant: variant,
        result: text,
        note: "ATC results are typically retrieved by following the worklist URL inside the response. Use adt_request to fetch the worklist if needed.",
      },
      null,
      2
    )
  );
}

async function handleTransportDiff(args) {
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
    return textResult(
      JSON.stringify(
        {
          systemA: a.name,
          systemB: b.name,
          transport: trId,
          objectCount: 0,
          note: "No <adtcore:objectReference> entries found in transport response.",
          raw: trBody.slice(0, 4000),
        },
        null,
        2
      )
    );
  }

  const results = [];
  for (const ref of refs) {
    const uri = ref.uri;
    if (!uri) continue;
    // The transport response is structured XML from SAP, but a malicious
    // entry (or an attacker-controlled DEV system upstream of a PRD diff)
    // could hand us a URI that escapes the ADT namespace, e.g.
    // "/../../../sap/bc/soap/rfc?...". Both clients would happily issue
    // that request with their configured creds. Validate post-normalization
    // and skip anything that doesn't resolve under /sap/bc/adt/.
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

  return textResult(
    JSON.stringify(
      {
        systemA: a.name,
        systemB: b.name,
        transport: trId,
        objectCount: refs.length,
        truncated: refs.length === maxObjects,
        results,
      },
      null,
      2
    )
  );
}

async function handleCreateTransport(args) {
  const { client, name: sys, profile } = getClient(args.system);
  const trType = args.type ?? "K";
  // Modern systems accept a JSON-ish XML body for transport creation.
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="newrequest">` +
    `<tm:request tm:desc="${escapeXml(args.description)}" tm:type="${trType}" tm:target="${escapeXml(args.target ?? "")}" tm:cliDep="X">` +
    `<tm:user tm:name="${escapeXml(profile.user.toUpperCase())}"/>` +
    `</tm:request>` +
    `</tm:root>`;
  const res = await client.request({
    method: "POST",
    path: "/sap/bc/adt/cts/transportrequests",
    headers: { "Content-Type": "application/vnd.sap.adt.transportorganizer.v1+xml" },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  const trMatch = text.match(/[A-Z]{3}K9\d{5}/);
  return textResult(
    JSON.stringify(
      { system: sys, transport: trMatch ? trMatch[0] : null, raw: text },
      null,
      2
    )
  );
}

async function handleReleaseTransport(args) {
  const { client, name: sys } = getClient(args.system);
  const id = args.transport.toUpperCase();
  const res = await client.request({
    method: "POST",
    path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}/newreleasejobs`,
  });
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(JSON.stringify({ system: sys, transport: id, result: text }, null, 2));
}

async function handleCreateObject(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        name: args.name.toUpperCase(),
        type: normalizeType(args.type),
        package: args.package.toUpperCase(),
        objectUri: newUri,
        status: "created",
        httpStatus: res.status,
      },
      null,
      2
    )
  );
}

async function handleDeleteObject(args) {
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
    // Try to release the lock — DELETE failed, object is still around.
    try {
      await releaseLock(client, objUri, lock.handle);
    } catch {
      // ignore
    }
    return errorResult(sys, res.status, text, res.headers.get("content-type"), {
      stage: "delete",
    });
  }
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        status: "deleted",
        httpStatus: res.status,
      },
      null,
      2
    )
  );
}

async function handleLock(args) {
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        objectUri: objUri,
        lockHandle: lock.handle,
        accessMode: args.accessMode ?? "MODIFY",
      },
      null,
      2
    )
  );
}

async function handleUnlock(args) {
  const { client, name: sys } = getClient(args.system);
  const objUri = objectUri({
    type: args.type,
    name: args.object,
    group: args.group,
  });
  const res = await releaseLock(client, objUri, args.lockHandle);
  const text = await res.text();
  if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
  return textResult(
    JSON.stringify(
      {
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        status: "unlocked",
        httpStatus: res.status,
      },
      null,
      2
    )
  );
}

async function acquireLock(client, objectPath, accessMode = "MODIFY") {
  const res = await client.request({
    method: "POST",
    path: objectPath,
    query: { _action: "LOCK", accessMode },
    headers: { "X-sap-adt-sessiontype": "stateful" },
    accept: "application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result",
  });
  const body = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
    };
  }
  const handle = extractLockHandle(body);
  if (!handle) {
    return {
      ok: false,
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
      error: "no-lock-handle-in-response",
    };
  }
  return { ok: true, handle };
}

async function releaseLock(client, objectPath, lockHandle) {
  return client.request({
    method: "POST",
    path: objectPath,
    query: { _action: "UNLOCK", lockHandle },
    headers: { "X-sap-adt-sessiontype": "stateful" },
  });
}

async function handleRequest(args) {
  if (typeof args.path !== "string") {
    return textResult("`path` is required and must be a string.", true);
  }
  const { client, name: sys } = getClient(args.system);
  // Confine adt_request to the ADT namespace. Without this, the tool is a
  // confused-deputy primitive: a caller (or a prompt-injected LLM) could
  // use the configured SAP credentials to hit OData services
  // (/sap/opu/odata/...), SOAP/RFC over HTTP (/sap/bc/soap/rfc), or any
  // other ICF service the user can reach — well outside the "ADT REST"
  // contract the tool advertises. Path traversal is collapsed first so
  // "/sap/bc/adt/../opu/odata/..." can't slip through.
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
  return textResult(
    JSON.stringify(
      {
        system: sys,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type"),
        body: text,
      },
      null,
      2
    )
  );
}

function errorResult(system, status, body, contentType, extra = {}) {
  const parsed = parseAdtError(body, contentType);
  return textResult(
    JSON.stringify(
      {
        system,
        status,
        ok: false,
        ...extra,
        error: parsed ?? { raw: body.slice(0, 4000) },
      },
      null,
      2
    ),
    true
  );
}

function extractLockHandle(xml) {
  const m = xml.match(/<LOCK_HANDLE>([\s\S]*?)<\/LOCK_HANDLE>/i);
  return m ? m[1].trim() : null;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function printHelp() {
  process.stdout.write(`${PKG.name} ${PKG.version}
${PKG.description}

Usage:
  ${PKG.name}                    Start the MCP server (stdio transport).
  ${PKG.name} --validate-config  Load config and ping every system.
  ${PKG.name} --version          Print version.
  ${PKG.name} --help             Print this message.

Environment:
  SAP_ADT_MCP_CONFIG   Path to config.json (overrides ~/.sap-adt-mcp/config.json).
  SAP_ADT_MCP_DEBUG=1  Trace every ADT request/response to stderr.

Project: ${PKG.homepage ?? PKG.repository?.url ?? ""}
`);
}

async function validateConfig() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`Loaded config from ${cfg.configPath}\n`);
  process.stdout.write(`Default system: ${cfg.defaultSystem ?? "(none)"}\n`);
  process.stdout.write(`Global readOnly: ${cfg.readOnly ? "yes" : "no"}\n\n`);

  let allOk = true;
  for (const [name, profile] of Object.entries(cfg.systems)) {
    const flags = [];
    if (profile.readOnly) flags.push("read-only");
    if (profile.rejectUnauthorized === false) flags.push("tls-skip");
    const tag = flags.length ? ` [${flags.join(", ")}]` : "";
    process.stdout.write(`  ${name}${tag} ${profile.host} ... `);
    try {
      const client = new AdtClient(profile);
      const res = await client.request({ path: "/sap/bc/adt/discovery" });
      if (res.ok) {
        process.stdout.write(`OK (HTTP ${res.status})\n`);
      } else {
        allOk = false;
        process.stdout.write(`FAIL (HTTP ${res.status})\n`);
      }
    } catch (err) {
      allOk = false;
      process.stdout.write(`FAIL (${err.message})\n`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

await server.connect(new StdioServerTransport());
