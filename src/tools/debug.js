// ABAP external debugger — Phase 1 (read-mostly MVP).
//
// Flow (verified against abap-adt-api's src/api/debugger.ts and E4D discovery):
//   1. adt_debug_set_breakpoint  → POST /debugger/breakpoints (external breakpoint)
//   2. adt_debug_listen          → POST /debugger/listeners  (bounded long-poll)
//        when a debuggee hits the breakpoint the listener returns it; we auto-
//        attach (POST /debugger?method=attach) and return a summary.
//   3. adt_debug_stack           → GET  /debugger/stack
//      adt_debug_variables       → POST /debugger?method=getVariables
//   4. adt_debug_stop            → DELETE listener + breakpoints (cleanup)
//
// The listener and its breakpoints must share one terminalId + ideId for a
// debuggee to be caught by *this* process, so those are a stable per-process
// identity (like a single IDE instance). Debug flow-control / value writes
// (step, setVariableValue) are Phase 2/3 and will gate on read-only mode.
//
// Every tool also returns `raw` (the ADT XML) alongside the best-effort parse,
// so the agent always has the ground truth even where the light parser misses.

import crypto from "node:crypto";
import { sourceUri } from "../object-uris.js";
import { escapeXml } from "../xml.js";
import { jsonResult, textResult, errorResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

// Stable per-process debug session identity (see header note).
const SESSION = {
  terminalId: crypto.randomUUID(),
  ideId: crypto.randomUUID(),
  breakpoints: [], // { id, uri } set this session — tracked for cleanup
  attached: null, // last attached debuggee id
};

const DEBUGGER = "/sap/bc/adt/debugger";
const DEFAULT_LISTEN_MS = 30_000;
const MAX_LISTEN_MS = 55_000; // stay under typical MCP call budgets

// --- light XML helpers (best-effort; raw XML is always returned too) ---------

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Attribute maps for every <[ns:]tag ...> occurrence (namespace-agnostic).
function attrsOf(tag, xml) {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}\\b([^>]*?)/?>`, "gi");
  const out = [];
  for (const m of String(xml ?? "").matchAll(re)) {
    const a = {};
    for (const at of m[1].matchAll(ATTR_RE)) a[at[1].replace(/^[\w]+:/, "")] = decode(at[2]);
    if (Object.keys(a).length) out.push(a);
  }
  return out;
}

// Child-element maps for every <[ns:]tag> … </tag> block.
function recordsOf(tag, xml) {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w]+:)?${tag}>`, "gi");
  const child = /<(?:[\w]+:)?([\w.-]+)>([\s\S]*?)<\/(?:[\w]+:)?\1>/g;
  const out = [];
  for (const m of String(xml ?? "").matchAll(re)) {
    const rec = {};
    for (const c of m[1].matchAll(child)) rec[c[1]] = decode(c[2].trim());
    if (Object.keys(rec).length) out.push(rec);
  }
  return out;
}

// Detect an ADT exception body (e.g. a listener conflict) and pull its message.
function debugError(xml) {
  const s = String(xml ?? "");
  if (!/<(?:[\w]+:)?exception\b/i.test(s)) return null;
  const msg = s.match(/<(?:[\w]+:)?(?:localizedMessage|message)[^>]*>([\s\S]*?)<\//i);
  return decode(msg?.[1]?.trim() || "debugger returned an exception");
}

// Debug flow-control / value-write actions change a live session, so they are
// WRITE operations. The read-only POST allowlist can't distinguish them from the
// inspection POSTs on the same base path (the ?method= discriminator is invisible
// to path matching), so they gate here at the tool level instead.
function refuseIfReadOnly(profile, tool) {
  if (profile.readOnly) {
    return (
      `${tool}: refused — system is read-only. This changes a live debug session ` +
      `(flow control / variable value); set readOnly:false for this system to allow it.`
    );
  }
  return null;
}

// Friendly step kind → ADT DebugStepType.
const STEP_KINDS = {
  into: "stepInto",
  over: "stepOver",
  return: "stepReturn",
  continue: "stepContinue",
  runToLine: "stepRunToLine",
  jumpToLine: "stepJumpToLine",
  terminate: "terminateDebuggee",
};

// --- request-user gating -----------------------------------------------------

// Resolve the SAP user whose session to debug. Defaults to the connection user;
// debugging *another* user requires per-system opt-in (needs debug authorization
// on the backend), so it is refused unless debug.allowRequestUser is set.
function resolveRequestUser(args, profile) {
  const self = String(profile.user || "").toUpperCase();
  if (!args.requestUser) return { user: self };
  const requested = String(args.requestUser).toUpperCase();
  if (requested === self) return { user: self };
  if (!profile.debugAllowRequestUser) {
    return {
      error:
        `adt_debug: refusing to debug another user (${requested}). Set ` +
        `"debug": { "allowRequestUser": true } for this system to allow it ` +
        `(requires debug authorization on the backend).`,
    };
  }
  return { user: requested };
}

export const tools = [
  {
    name: "adt_debug_set_breakpoint",
    description:
      "Set an external ABAP debugger breakpoint at a line of an object. Pair with adt_debug_listen to catch a session that reaches it. Returns the breakpoint id (needed to delete it). Give either `uri` (a full ADT source URI) or `object`+`type` (+`include` for classes) with `line`.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name (with `type`), e.g. 'ZCL_FOO' or 'ZREPORT'." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        include: {
          type: "string",
          description: "For classes: which include the line is in (main, definitions, implementations, macros, testclasses). Default main.",
        },
        line: { type: "integer", description: "1-based source line for the breakpoint." },
        uri: {
          type: "string",
          description: "Alternative to object/type/line: a full ADT source URI, optionally already suffixed with '#start=<line>'.",
        },
        condition: { type: "string", description: "Optional ABAP condition; the breakpoint only triggers when it is true." },
        requestUser: { type: "string", description: "Debug another user's session (needs per-system debug.allowRequestUser). Defaults to the connection user." },
      },
    },
  },
  {
    name: "adt_debug_delete_breakpoint",
    description: "Delete an external debugger breakpoint by its id (from adt_debug_set_breakpoint).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        id: { type: "string", description: "Breakpoint id returned by adt_debug_set_breakpoint." },
        requestUser: { type: "string", description: "Must match the user the breakpoint was set for. Defaults to the connection user." },
      },
      required: ["id"],
    },
  },
  {
    name: "adt_debug_listen",
    description:
      "Wait (bounded long-poll) for a debuggee to hit a breakpoint set with adt_debug_set_breakpoint. Returns { caught: true, … } with a summary (and auto-attaches) when a session is trapped, or { caught: false } if none arrived within the timeout — in which case call it again (trigger the ABAP run meanwhile). One listener per process; set breakpoints first.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        timeout: { type: "integer", description: `Max wait in ms (default ${DEFAULT_LISTEN_MS}, capped at ${MAX_LISTEN_MS}). The tool returns caught:false on timeout; just call again.` },
        requestUser: { type: "string", description: "Whose session to catch (needs per-system debug.allowRequestUser to differ). Defaults to the connection user." },
      },
    },
  },
  {
    name: "adt_debug_stack",
    description: "Return the call stack of the currently attached debuggee (after adt_debug_listen caught one).",
    inputSchema: {
      type: "object",
      properties: { system: { type: "string", description: SYSTEM_HINT } },
    },
  },
  {
    name: "adt_debug_variables",
    description:
      "Read variable values from the currently attached debuggee. Pass `names` (variable names/ids in scope, e.g. ['sy-subrc','lv_total']); omit to read the top-level scope roots.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Variable names/ids to read (e.g. ['sy-subrc','lt_items']). Defaults to the scope roots ['@ROOT'].",
        },
      },
    },
  },
  {
    name: "adt_debug_stop",
    description: "End the debug session: delete this process's listener and every breakpoint it set. Call when finished (or to reset after an error) so no dangling breakpoints/listeners are left on the system.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        requestUser: { type: "string", description: "Defaults to the connection user." },
      },
    },
  },
  {
    name: "adt_debug_step",
    description:
      "Advance the attached debuggee (Phase 2, flow control). `kind`: into (step into), over (step over), return (step out), continue (resume until the next breakpoint), runToLine / jumpToLine (need `uri`), terminate (stop the debuggee). WRITE — refused under read-only mode. Returns the new state (position, reached breakpoints) plus raw XML.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        kind: {
          type: "string",
          enum: ["into", "over", "return", "continue", "runToLine", "jumpToLine", "terminate"],
          description: "The step action.",
        },
        uri: { type: "string", description: "Target stack/source URI — required for runToLine and jumpToLine." },
      },
      required: ["kind"],
    },
  },
  {
    name: "adt_debug_goto_stack",
    description:
      "Move the active stack frame of the attached debuggee (Phase 2). Pass either `stackUri` (a /sap/bc/adt/debugger/stack/type/<t>/position/<n> URI from adt_debug_stack) or a 0-based `position`. WRITE — refused under read-only mode.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        stackUri: { type: "string", description: "A stack-entry URI from adt_debug_stack." },
        position: { type: "integer", description: "0-based stack position (alternative to stackUri)." },
      },
    },
  },
  {
    name: "adt_debug_set_variable",
    description:
      "Set a variable's value in the attached debuggee (Phase 3). WRITE — refused under read-only mode. Changes live session state; use with care on shared/production-adjacent systems.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        name: { type: "string", description: "Variable name/id in the current scope (e.g. 'lv_total', 'sy-subrc')." },
        value: { type: "string", description: "New value (as text; ABAP-typed on the backend)." },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "adt_debug_set_watchpoint",
    description:
      "Set a debugger watchpoint that breaks when a variable changes (or a condition holds). Phase 3, WRITE — refused under read-only mode. NOTE: the watchpoint request/response contract has no reference implementation and is best-effort until validated on a live system; check `raw`.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        variableName: { type: "string", description: "Variable to watch." },
        condition: { type: "string", description: "Optional condition; break only when it holds." },
        requestUser: { type: "string", description: "Defaults to the connection user (needs debug.allowRequestUser to differ)." },
      },
      required: ["variableName"],
    },
  },
  {
    name: "adt_debug_delete_watchpoint",
    description: "Delete a watchpoint by id (from adt_debug_set_watchpoint). Phase 3, WRITE — refused under read-only mode. Best-effort until validated live.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        id: { type: "string", description: "Watchpoint id." },
      },
      required: ["id"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_debug_set_breakpoint: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const ru = resolveRequestUser(args, profile);
      if (ru.error) return textResult(ru.error, true);

      let uri;
      if (typeof args.uri === "string" && args.uri.length > 0) {
        uri = args.uri;
      } else {
        if (typeof args.object !== "string" || typeof args.type !== "string") {
          return textResult("adt_debug_set_breakpoint: give `uri`, or `object`+`type` (+`line`).", true);
        }
        if (!Number.isInteger(args.line)) {
          return textResult("adt_debug_set_breakpoint: `line` (1-based integer) is required when using object/type.", true);
        }
        let base;
        try {
          base = sourceUri({ type: args.type, name: args.object, include: args.include });
        } catch (err) {
          return textResult(`adt_debug_set_breakpoint: ${err.message}.`, true);
        }
        uri = `${base}#start=${args.line}`;
      }

      const clientId = crypto.randomUUID();
      const conditionAttr = args.condition ? ` condition="${escapeXml(args.condition)}"` : "";
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<dbg:breakpoints scope="external" debuggingMode="user" requestUser="${escapeXml(ru.user)}"` +
        ` terminalId="${SESSION.terminalId}" ideId="${SESSION.ideId}" systemDebugging="false" deactivated="false"` +
        ` xmlns:dbg="http://www.sap.com/adt/debugger">` +
        `<syncScope mode="full"></syncScope>` +
        `<breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" clientId="${clientId}" skipCount="0"` +
        ` adtcore:uri="${escapeXml(uri)}"${conditionAttr}/>` +
        `</dbg:breakpoints>`;

      const res = await client.request({
        method: "POST",
        path: `${DEBUGGER}/breakpoints`,
        headers: { "Content-Type": "application/xml" },
        accept: "application/xml",
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "set-breakpoint" });

      const bps = attrsOf("breakpoint", text).filter((b) => b.id || b.uri);
      for (const b of bps) if (b.id) SESSION.breakpoints.push({ id: b.id, uri: b.uri });
      return jsonResult({
        system: sys,
        requestUser: ru.user,
        breakpoints: bps,
        note: bps.some((b) => b.id)
          ? "Breakpoint set. Now call adt_debug_listen, then trigger the ABAP run."
          : "No breakpoint id returned — see `raw` (the target line may not be executable).",
        raw: text,
      });
    },

    adt_debug_delete_breakpoint: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      if (typeof args.id !== "string" || args.id.length === 0) {
        return textResult("adt_debug_delete_breakpoint: `id` is required (from adt_debug_set_breakpoint).", true);
      }
      const ru = resolveRequestUser(args, profile);
      if (ru.error) return textResult(ru.error, true);

      const res = await client.request({
        method: "DELETE",
        path: `${DEBUGGER}/breakpoints/${encodeURIComponent(args.id)}`,
        query: { scope: "external", debuggingMode: "user", requestUser: ru.user, terminalId: SESSION.terminalId, ideId: SESSION.ideId },
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "delete-breakpoint" });
      SESSION.breakpoints = SESSION.breakpoints.filter((b) => b.id !== args.id);
      return jsonResult({ system: sys, deleted: args.id, status: "deleted" });
    },

    adt_debug_listen: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const ru = resolveRequestUser(args, profile);
      if (ru.error) return textResult(ru.error, true);

      const timeout = Math.min(
        MAX_LISTEN_MS,
        Number.isInteger(args.timeout) && args.timeout > 0 ? args.timeout : DEFAULT_LISTEN_MS
      );
      const query = {
        debuggingMode: "user",
        requestUser: ru.user,
        terminalId: SESSION.terminalId,
        ideId: SESSION.ideId,
        checkConflict: true,
        isNotifiedOnConflict: true,
      };

      let text;
      try {
        const res = await client.request({
          method: "POST",
          path: `${DEBUGGER}/listeners`,
          query,
          accept: "application/xml",
          timeoutMs: timeout,
        });
        text = await res.text();
        if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "listen" });
      } catch (err) {
        // Bounded poll: our own timeout firing just means "nobody hit it yet".
        if (/timed out after/i.test(String(err?.message))) {
          return jsonResult({
            system: sys,
            caught: false,
            note: `No debuggee within ${timeout}ms. Trigger the ABAP run, then call adt_debug_listen again.`,
          });
        }
        throw err;
      }

      const conflict = debugError(text);
      if (conflict) {
        return jsonResult({ system: sys, caught: false, listening: false, conflict, raw: text });
      }
      const debuggee = recordsOf("STPDA_DEBUGGEE", text)[0];
      if (!debuggee || !debuggee.DEBUGGEE_ID) {
        return jsonResult({ system: sys, caught: false, note: "No debuggee caught; call adt_debug_listen again.", raw: text });
      }

      // Auto-attach so the caller can immediately read stack/variables.
      const attachRes = await client.request({
        method: "POST",
        path: DEBUGGER,
        query: { method: "attach", debuggeeId: debuggee.DEBUGGEE_ID, dynproDebugging: true, debuggingMode: "user", requestUser: ru.user },
        accept: "application/xml",
      });
      const attachText = await attachRes.text();
      SESSION.attached = debuggee.DEBUGGEE_ID;
      const reached = attrsOf("breakpoint", attachText);
      return jsonResult({
        system: sys,
        caught: true,
        attached: attachRes.ok,
        debuggee,
        reachedBreakpoints: reached,
        note: attachRes.ok
          ? "Attached. Use adt_debug_stack and adt_debug_variables to inspect."
          : "Debuggee caught but attach failed — see rawAttach.",
        raw: text,
        rawAttach: attachText,
      });
    },

    adt_debug_stack: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({
        method: "GET",
        path: `${DEBUGGER}/stack`,
        query: { method: "getStack", emode: "_", semanticURIs: true },
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "stack" });
      const stack = attrsOf("stackEntry", text);
      return jsonResult({ system: sys, depth: stack.length, stack, raw: stack.length ? undefined : text });
    },

    adt_debug_variables: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const names = Array.isArray(args.names) && args.names.length ? args.names.map(String) : ["@ROOT"];
      const inner = names
        .map((n) => `<STPDA_ADT_VARIABLE><ID>${escapeXml(n)}</ID></STPDA_ADT_VARIABLE>`)
        .join("");
      const body =
        `<?xml version="1.0" encoding="UTF-8" ?>` +
        `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${inner}</DATA></asx:values></asx:abap>`;
      const media = "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.Variables";
      const res = await client.request({
        method: "POST",
        path: DEBUGGER,
        query: { method: "getVariables" },
        headers: { "Content-Type": media },
        accept: media,
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "variables" });
      const variables = recordsOf("STPDA_ADT_VARIABLE", text);
      return jsonResult({ system: sys, requested: names, variables, raw: variables.length ? undefined : text });
    },

    adt_debug_stop: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const ru = resolveRequestUser(args, profile);
      if (ru.error) return textResult(ru.error, true);

      const removed = [];
      // Delete the listener (best-effort).
      try {
        await client.request({
          method: "DELETE",
          path: `${DEBUGGER}/listeners`,
          query: { debuggingMode: "user", requestUser: ru.user, terminalId: SESSION.terminalId, ideId: SESSION.ideId, checkConflict: false, notifyConflict: true },
        });
      } catch {
        // best-effort cleanup
      }
      // Delete every breakpoint this session set (best-effort).
      for (const b of [...SESSION.breakpoints]) {
        try {
          await client.request({
            method: "DELETE",
            path: `${DEBUGGER}/breakpoints/${encodeURIComponent(b.id)}`,
            query: { scope: "external", debuggingMode: "user", requestUser: ru.user, terminalId: SESSION.terminalId, ideId: SESSION.ideId },
            accept: "application/xml",
          });
          removed.push(b.id);
        } catch {
          // best-effort
        }
      }
      SESSION.breakpoints = [];
      SESSION.attached = null;
      return jsonResult({ system: sys, status: "stopped", listenerDeleted: true, breakpointsDeleted: removed });
    },

    // ── Phase 2 — flow control (WRITE) ──────────────────────────────────────
    adt_debug_step: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const refused = refuseIfReadOnly(profile, "adt_debug_step");
      if (refused) return textResult(refused, true);

      const method = STEP_KINDS[args.kind];
      if (!method) {
        return textResult(`adt_debug_step: unknown kind ${JSON.stringify(args.kind)}. Use one of: ${Object.keys(STEP_KINDS).join(", ")}.`, true);
      }
      if ((args.kind === "runToLine" || args.kind === "jumpToLine") && !args.uri) {
        return textResult(`adt_debug_step: kind '${args.kind}' requires \`uri\` (the target line/stack URI).`, true);
      }

      const res = await client.request({
        method: "POST",
        path: DEBUGGER,
        query: { method, uri: args.uri },
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "step" });
      if (args.kind === "terminate") SESSION.attached = null;
      const step = attrsOf("step", text)[0] ?? {};
      const reached = attrsOf("breakpoint", text);
      const actions = attrsOf("action", text);
      return jsonResult({ system: sys, kind: args.kind, step, reachedBreakpoints: reached, actions, raw: text });
    },

    adt_debug_goto_stack: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const refused = refuseIfReadOnly(profile, "adt_debug_goto_stack");
      if (refused) return textResult(refused, true);

      if (typeof args.stackUri === "string" && args.stackUri) {
        if (!/^\/sap\/bc\/adt\/debugger\/stack\/type\/\w+\/position\/\d+$/.test(args.stackUri)) {
          return textResult(`adt_debug_goto_stack: stackUri must look like /sap/bc/adt/debugger/stack/type/<t>/position/<n> (got ${JSON.stringify(args.stackUri)}).`, true);
        }
        const res = await client.request({ method: "PUT", path: args.stackUri, accept: "application/xml" });
        const text = await res.text();
        if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "goto-stack" });
        return jsonResult({ system: sys, stackUri: args.stackUri, status: "moved" });
      }
      if (Number.isInteger(args.position)) {
        const res = await client.request({
          method: "POST",
          path: DEBUGGER,
          query: { method: "setStackPosition", position: args.position },
          accept: "application/xml",
        });
        const text = await res.text();
        if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "goto-stack" });
        return jsonResult({ system: sys, position: args.position, status: "moved" });
      }
      return textResult("adt_debug_goto_stack: pass either `stackUri` or `position`.", true);
    },

    // ── Phase 3 — guarded value writes (WRITE) ──────────────────────────────
    adt_debug_set_variable: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const refused = refuseIfReadOnly(profile, "adt_debug_set_variable");
      if (refused) return textResult(refused, true);
      if (typeof args.name !== "string" || !args.name || typeof args.value !== "string") {
        return textResult("adt_debug_set_variable: `name` and `value` (string) are required.", true);
      }
      const res = await client.request({
        method: "POST",
        path: DEBUGGER,
        query: { method: "setVariableValue", variableName: args.name },
        body: args.value,
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "set-variable" });
      return jsonResult({ system: sys, name: args.name, value: args.value, status: "set", raw: text });
    },

    adt_debug_set_watchpoint: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const refused = refuseIfReadOnly(profile, "adt_debug_set_watchpoint");
      if (refused) return textResult(refused, true);
      const ru = resolveRequestUser(args, profile);
      if (ru.error) return textResult(ru.error, true);
      if (typeof args.variableName !== "string" || !args.variableName) {
        return textResult("adt_debug_set_watchpoint: `variableName` is required.", true);
      }
      // Best-effort: no reference implementation exists for the watchpoint
      // contract, only the discovered signature (?variableName,condition). Send
      // the session identity like breakpoints do; surface `raw` for validation.
      const res = await client.request({
        method: "POST",
        path: `${DEBUGGER}/watchpoints`,
        query: {
          variableName: args.variableName,
          condition: args.condition,
          debuggingMode: "user",
          requestUser: ru.user,
          terminalId: SESSION.terminalId,
          ideId: SESSION.ideId,
        },
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "set-watchpoint" });
      const wp = attrsOf("watchpoint", text);
      return jsonResult({
        system: sys,
        variableName: args.variableName,
        watchpoints: wp,
        note: "Best-effort: watchpoint contract unverified — confirm against `raw`.",
        raw: text,
      });
    },

    adt_debug_delete_watchpoint: async (args) => {
      const { client, name: sys, profile } = getClient(args.system);
      const refused = refuseIfReadOnly(profile, "adt_debug_delete_watchpoint");
      if (refused) return textResult(refused, true);
      if (typeof args.id !== "string" || !args.id) {
        return textResult("adt_debug_delete_watchpoint: `id` is required.", true);
      }
      const res = await client.request({
        method: "DELETE",
        path: `${DEBUGGER}/watchpoints/${encodeURIComponent(args.id)}`,
        accept: "application/xml",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "delete-watchpoint" });
      return jsonResult({ system: sys, deleted: args.id, status: "deleted" });
    },
  };
}

// Exposed for unit tests.
export const _internals = { attrsOf, recordsOf, debugError, resolveRequestUser, SESSION };
