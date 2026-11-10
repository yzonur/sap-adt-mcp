import { errorResult, jsonResult, textResult } from "../result.js";
import { runFreestyle, sqlName, chunk, inList } from "../data-preview.js";
import {
  RELATION,
  methodName,
  methodInclude,
  functionInclude,
  crossRefName,
  parseCrossRefName,
  parseInclude,
  resolveIncludes,
} from "../code-intel.js";
import { SYSTEM_HINT } from "./_shared.js";

const DEFAULT_DEPTH = 5;
const MAX_DEPTH = 20;
const DEFAULT_MAX_NODES = 500;
const HARD_CAP_NODES = 5000;
const DEFAULT_MAX_RESULTS = 200;
const HARD_CAP_RESULTS = 5000;

const DATA_PREVIEW_NOTE = "Read-only (Data Preview SELECTs on the class-builder / cross-reference tables; needs NetWeaver 7.55+ / S/4HANA).";

export const tools = [
  {
    name: "adt_type_hierarchy",
    description:
      `Type hierarchy of a class or interface from SEOMETAREL. \`up\`: superclasses, implemented interfaces and the interfaces those include, level by level. \`down\`: subclasses — and for an interface its implementing classes, the interfaces that include it, and the implementers' subclasses. Each edge comes back as { name, relation: inherits | implements | includes, depth } plus \`child\` (up) or \`parent\` (down) — the type it was reached from; \`superclasses\` lists the inheritance chain in order. ${DATA_PREVIEW_NOTE} Only global classes and interfaces (SE24) — local classes are not in SEOMETAREL.`,
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        name: { type: "string", description: "Global class or interface name, e.g. 'CL_GUI_ALV_GRID'." },
        direction: {
          type: "string",
          enum: ["up", "down", "both"],
          description: "Which side of the hierarchy to walk (default both).",
        },
        depth: {
          type: "integer",
          description: `Levels to walk in each direction (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}).`,
          minimum: 1,
          maximum: MAX_DEPTH,
        },
        maxNodes: {
          type: "integer",
          description: `Cap on the edges returned per direction (default ${DEFAULT_MAX_NODES}, max ${HARD_CAP_NODES}). Widely implemented interfaces have thousands.`,
          minimum: 1,
          maximum: HARD_CAP_NODES,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "adt_method_redefinitions",
    description:
      `Method redefinitions of a global class from SEOREDEF. Without \`method\`: every method the class redefines and the superclass it redefines it from. With \`method\`: the class that originally defines it (SEOCOMPO, walking the superclass chain), whether this class redefines it, and every subclass down the hierarchy that redefines it. ${DATA_PREVIEW_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        class: { type: "string", description: "Global class name." },
        method: { type: "string", description: "Method name; interface methods as 'IF_NAME~METHOD'." },
        depth: {
          type: "integer",
          description: `Subclass levels to search for redefinitions (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}).`,
          minimum: 1,
          maximum: MAX_DEPTH,
        },
      },
      required: ["class"],
    },
  },
  {
    name: "adt_call_hierarchy",
    description:
      `Call hierarchy of a method or function module from the where-used index (WBCROSSGT / CROSS). \`callers\`: every include that calls it, resolved to the calling method (class + method), function module or program include. \`callees\`: the methods and function modules called inside its implementation. One level per call — call again on a result to go deeper. ${DATA_PREVIEW_NOTE} The index only holds what the compiler can see statically: dynamic calls (CALL METHOD (name), CALL FUNCTION lv_name) are missing, a call through an interface reference is recorded under the interface method ('IF_X~M'), and the index of objects not yet compiled may be stale.`,
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        class: { type: "string", description: "Global class or interface name (with `method`)." },
        method: { type: "string", description: "Method name (with `class`); interface methods as 'IF_NAME~METHOD'." },
        function: { type: "string", description: "Function module name (instead of `class` + `method`)." },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "callers (default), callees, or both.",
        },
        maxResults: {
          type: "integer",
          description: `Cap on callers returned (default ${DEFAULT_MAX_RESULTS}, max ${HARD_CAP_RESULTS}). \`totalReferences\` reports the full number of index entries (one caller can have several).`,
          minimum: 1,
          maximum: HARD_CAP_RESULTS,
        },
      },
    },
  },
];

function fail(sys, r, stage) {
  return errorResult(sys, r.status, r.body, r.contentType, { stage });
}

function boundedInt(value, fallback, max) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

// Walk SEOMETAREL one level at a time. `up` follows CLSNAME → REFCLSNAME
// (what a type inherits / implements / includes), `down` the reverse.
async function walk(client, root, { up, depth, maxNodes, reltypes = ["0", "1", "2"] }) {
  const edges = [];
  const seen = new Set([root]);
  let frontier = [root];
  let truncated = false;
  const [from, to] = up ? ["CLSNAME", "REFCLSNAME"] : ["REFCLSNAME", "CLSNAME"];
  for (let level = 1; level <= depth && frontier.length > 0 && !truncated; level++) {
    const next = [];
    for (const names of chunk(frontier)) {
      const r = await runFreestyle(
        client,
        `SELECT clsname, refclsname, reltype FROM seometarel WHERE ${from.toLowerCase()} IN (${inList(names)}) AND version = '1' AND reltype IN (${inList(reltypes)})`,
        maxNodes + 1
      );
      if (!r.ok) return { fail: r };
      for (const row of r.rows) {
        const name = sqlName(row[to] ?? "");
        if (!name) continue;
        if (edges.length >= maxNodes) {
          truncated = true;
          break;
        }
        edges.push({
          name,
          [up ? "child" : "parent"]: row[from],
          relation: RELATION[Number(row.RELTYPE)] ?? row.RELTYPE,
          depth: level,
        });
        if (!seen.has(name)) {
          seen.add(name);
          next.push(name);
        }
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { edges, truncated, exhausted: frontier.length === 0 };
}

// The superclass chain in order, from the inheritance edges of an upward walk.
function superclassChain(root, edges) {
  const parentOf = new Map(edges.filter((e) => e.relation === "inherits").map((e) => [e.child, e.name]));
  const chain = [];
  for (let cur = parentOf.get(root); cur && !chain.includes(cur); cur = parentOf.get(cur)) chain.push(cur);
  return chain;
}

async function classKind(client, name) {
  const r = await runFreestyle(client, `SELECT clsname, clstype FROM seoclass WHERE clsname = '${name}'`, 1);
  if (!r.ok) return { fail: r };
  if (!r.rows[0]) return { missing: true };
  return { kind: r.rows[0].CLSTYPE === "1" ? "interface" : "class" };
}

export function register({ getClient }) {
  return {
    adt_type_hierarchy: async (args) => {
      const name = sqlName(args.name);
      if (!name) return textResult("adt_type_hierarchy: `name` must be a global class or interface name.", true);
      const direction = args.direction ?? "both";
      if (!["up", "down", "both"].includes(direction)) {
        return textResult("adt_type_hierarchy: `direction` is up, down or both.", true);
      }
      const depth = boundedInt(args.depth, DEFAULT_DEPTH, MAX_DEPTH);
      const maxNodes = boundedInt(args.maxNodes, DEFAULT_MAX_NODES, HARD_CAP_NODES);
      const { client, name: sys } = getClient(args.system);

      const k = await classKind(client, name);
      if (k.fail) return fail(sys, k.fail, "seoclass");
      if (k.missing) return textResult(`adt_type_hierarchy: no global class or interface ${name} in SEOCLASS.`, true);

      const out = { system: sys, name, kind: k.kind };
      if (direction !== "down") {
        const w = await walk(client, name, { up: true, depth, maxNodes });
        if (w.fail) return fail(sys, w.fail, "seometarel-up");
        Object.assign(out, {
          superclasses: superclassChain(name, w.edges),
          up: w.edges,
          ...(w.truncated ? { upTruncated: true } : {}),
          ...(!w.exhausted && !w.truncated ? { upDepthReached: true } : {}),
        });
      }
      if (direction !== "up") {
        const w = await walk(client, name, { up: false, depth, maxNodes });
        if (w.fail) return fail(sys, w.fail, "seometarel-down");
        Object.assign(out, {
          down: w.edges,
          ...(w.truncated ? { downTruncated: true } : {}),
          ...(!w.exhausted && !w.truncated ? { downDepthReached: true } : {}),
        });
      }
      return jsonResult(out);
    },

    adt_method_redefinitions: async (args) => {
      const cls = sqlName(args.class);
      if (!cls) return textResult("adt_method_redefinitions: `class` must be a global class name.", true);
      const method = args.method != null ? methodName(args.method) : null;
      if (args.method != null && !method) {
        return textResult("adt_method_redefinitions: `method` must be a method name, 'IF_NAME~METHOD' for interface methods.", true);
      }
      const depth = boundedInt(args.depth, DEFAULT_DEPTH, MAX_DEPTH);
      const { client, name: sys } = getClient(args.system);

      const own = await runFreestyle(
        client,
        `SELECT refclsname, mtdname FROM seoredef WHERE clsname = '${cls}' AND version = '1'${method ? ` AND mtdname = '${method}'` : ""}`,
        HARD_CAP_NODES
      );
      if (!own.ok) return fail(sys, own, "seoredef");
      const redefines = own.rows
        .map((r) => ({ method: r.MTDNAME, from: r.REFCLSNAME }))
        .sort((a, b) => a.method.localeCompare(b.method));

      if (!method) return jsonResult({ system: sys, class: cls, redefines });

      // Where the method is declared: the interface for 'IF~M', otherwise the
      // first class up the superclass chain that has it as a component.
      let definedIn;
      if (method.includes("~")) {
        definedIn = method.split("~")[0];
      } else {
        const up = await walk(client, cls, { up: true, depth: MAX_DEPTH, maxNodes: MAX_DEPTH, reltypes: ["2"] });
        if (up.fail) return fail(sys, up.fail, "seometarel-up");
        const chain = [cls, ...superclassChain(cls, up.edges)];
        const c = await runFreestyle(
          client,
          `SELECT clsname FROM seocompo WHERE cmpname = '${method}' AND clsname IN (${inList(chain)})`,
          chain.length
        );
        if (!c.ok) return fail(sys, c, "seocompo");
        const owners = new Set(c.rows.map((r) => r.CLSNAME));
        // The topmost class in the chain that declares it is the original.
        definedIn = [...chain].reverse().find((n) => owners.has(n));
      }

      const down = await walk(client, cls, { up: false, depth, maxNodes: HARD_CAP_NODES, reltypes: ["2"] });
      if (down.fail) return fail(sys, down.fail, "seometarel-down");
      const depthOf = new Map(down.edges.map((e) => [e.name, e.depth]));
      const redefinedIn = [];
      for (const names of chunk([...depthOf.keys()])) {
        const r = await runFreestyle(
          client,
          `SELECT clsname, refclsname FROM seoredef WHERE clsname IN (${inList(names)}) AND mtdname = '${method}' AND version = '1'`,
          names.length
        );
        if (!r.ok) return fail(sys, r, "seoredef-down");
        for (const row of r.rows) redefinedIn.push({ class: row.CLSNAME, from: row.REFCLSNAME, depth: depthOf.get(row.CLSNAME) });
      }
      redefinedIn.sort((a, b) => a.depth - b.depth || a.class.localeCompare(b.class));

      return jsonResult({
        system: sys,
        class: cls,
        method,
        ...(definedIn ? { definedIn } : { note: `${method} is not a component of ${cls} or its superclasses.` }),
        redefinedHere: redefines.length > 0 ? redefines[0] : null,
        subclassesSearched: depthOf.size,
        redefinedIn,
        ...(down.truncated ? { truncated: true } : {}),
        ...(!down.exhausted && !down.truncated ? { depthReached: true } : {}),
      });
    },

    adt_call_hierarchy: async (args) => {
      const byFunction = args.function != null;
      if (byFunction === (args.class != null || args.method != null)) {
        return textResult("adt_call_hierarchy: pass either `class` + `method` or `function`.", true);
      }
      const direction = args.direction ?? "callers";
      if (!["callers", "callees", "both"].includes(direction)) {
        return textResult("adt_call_hierarchy: `direction` is callers, callees or both.", true);
      }
      const fm = byFunction ? sqlName(args.function) : null;
      const cls = byFunction ? null : sqlName(args.class ?? "");
      const method = byFunction ? null : methodName(args.method ?? "");
      if (byFunction ? !fm : !cls || !method) {
        return textResult("adt_call_hierarchy: names must be repository names; interface methods as 'IF_NAME~METHOD'.", true);
      }
      const maxResults = boundedInt(args.maxResults, DEFAULT_MAX_RESULTS, HARD_CAP_RESULTS);
      const { client, name: sys } = getClient(args.system);
      const out = { system: sys, ...(byFunction ? { function: fm } : { class: cls, method }) };

      // Callers: the includes the where-used index lists for this method / module.
      if (direction !== "callees") {
        const query = byFunction
          ? `SELECT DISTINCT include FROM cross WHERE type = 'F' AND name = '${fm}'`
          : `SELECT DISTINCT include FROM wbcrossgt WHERE otype = 'ME' AND name = '${crossRefName(cls, method)}'`;
        const r = await runFreestyle(client, query, maxResults);
        if (!r.ok) return fail(sys, r, byFunction ? "cross" : "wbcrossgt");
        const includes = r.rows.map((row) => row.INCLUDE).filter(Boolean);
        const resolved = await resolveCallerIncludes(client, includes);
        if (resolved.fail) return fail(sys, resolved.fail, resolved.stage);
        Object.assign(out, {
          // Data Preview counts index rows, not distinct includes — one include
          // calling the target several times is counted more than once.
          totalReferences: r.totalRows,
          callers: resolved.callers,
          ...(includes.length >= maxResults ? { callersTruncated: true } : {}),
        });
      }

      // Callees: the cross references recorded for the implementing include.
      if (direction !== "callers") {
        let include;
        if (byFunction) {
          const f = await runFreestyle(client, `SELECT funcname, pname, include FROM tfdir WHERE funcname = '${fm}'`, 1);
          if (!f.ok) return fail(sys, f, "tfdir");
          if (!f.rows[0]) return textResult(`adt_call_hierarchy: no function module ${fm} in TFDIR.`, true);
          include = functionInclude(f.rows[0].PNAME, f.rows[0].INCLUDE);
        } else {
          const t = await runFreestyle(
            client,
            `SELECT classname, methodindx, methodname FROM tmdir WHERE classname = '${cls}' AND methodname = '${method}'`,
            1
          );
          if (!t.ok) return fail(sys, t, "tmdir");
          if (!t.rows[0]) {
            return textResult(
              `adt_call_hierarchy: ${cls} has no implementation of ${method} in TMDIR (abstract, an interface, or inherited without redefinition) — callees need the implementing class.`,
              true
            );
          }
          include = methodInclude(cls, t.rows[0].METHODINDX);
        }
        const me = await runFreestyle(
          client,
          `SELECT DISTINCT name FROM wbcrossgt WHERE include = '${include}' AND otype = 'ME'`,
          HARD_CAP_RESULTS
        );
        if (!me.ok) return fail(sys, me, "wbcrossgt-callees");
        const fu = await runFreestyle(
          client,
          `SELECT DISTINCT name FROM cross WHERE include = '${include}' AND type = 'F'`,
          HARD_CAP_RESULTS
        );
        if (!fu.ok) return fail(sys, fu, "cross-callees");
        const callees = [
          ...me.rows
            .map((r) => parseCrossRefName(r.NAME))
            .filter(Boolean)
            .map((c) => ({ kind: "method", class: c.className, method: c.method })),
          ...fu.rows.map((r) => ({ kind: "function", function: r.NAME })),
        ];
        Object.assign(out, { include, callees });
      }
      return jsonResult(out);
    },
  };
}

// Map caller includes to methods (TMDIR) and function modules (TFDIR).
async function resolveCallerIncludes(client, includes) {
  const parsed = includes.map(parseInclude);
  const classes = [...new Set(parsed.filter((p) => p.kind === "method").map((p) => sqlName(p.className)).filter(Boolean))];
  const mains = [...new Set(parsed.filter((p) => p.kind === "function-include").map((p) => sqlName(p.mainProgram, 40)).filter(Boolean))];
  // The index lists are crossed (class × index), so a few extra rows can come
  // back; resolveIncludes() only keeps the exact pairs.
  const indexes = [...new Set(parsed.filter((p) => p.kind === "method").map((p) => String(p.methodIndex).padStart(5, "0")))];
  const includeNos = [...new Set(parsed.filter((p) => p.kind === "function-include").map((p) => p.includeNo))];
  const tmdir = [];
  for (const names of chunk(classes)) {
    const r = await runFreestyle(
      client,
      `SELECT classname, methodindx, methodname FROM tmdir WHERE classname IN (${inList(names)}) AND methodindx IN (${inList(indexes)})`,
      HARD_CAP_RESULTS
    );
    if (!r.ok) return { fail: r, stage: "tmdir" };
    tmdir.push(...r.rows);
  }
  const tfdir = [];
  for (const names of chunk(mains)) {
    const r = await runFreestyle(
      client,
      `SELECT funcname, pname, include FROM tfdir WHERE pname IN (${inList(names)}) AND include IN (${inList(includeNos)})`,
      HARD_CAP_RESULTS
    );
    if (!r.ok) return { fail: r, stage: "tfdir" };
    tfdir.push(...r.rows);
  }
  return { callers: resolveIncludes(includes, tmdir, tfdir) };
}
