import { sourceUri, objectUri, normalizeType, METADATA_XML_ACCEPT } from "../object-uris.js";
import { acquireLock, releaseLock } from "../lock.js";
import { errorResult, jsonResult, textResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

const TOP_LEVEL_KEYWORDS = [
  "CLASS",
  "INTERFACE",
  "REPORT",
  "PROGRAM",
  "FUNCTION-POOL",
  "FUNCTION",
  "FORM",
  "MODULE",
  "METHOD",
  "DEFINE",
  "INCLUDE",
  "TYPE-POOL",
  "TYPE-POOLS",
  "TYPES",
  "DATA",
  "CONSTANTS",
  "TABLES",
  "FIELD-SYMBOLS",
  "STATICS",
  "PARAMETERS",
  "PARAMETER",
  "SELECTION-SCREEN",
  "SELECT-OPTIONS",
  "RANGES",
  "MESSAGE-ID",
  "LOAD-OF-PROGRAM",
  "ENHANCEMENT",
  "ENHANCEMENT-SECTION",
  "ENHANCEMENT-POINT",
];

const TOP_LEVEL_REGEX = new RegExp(
  `^(?:${TOP_LEVEL_KEYWORDS.map((k) => k.replace(/-/g, "\\-")).join("|")})\\b`,
  "i",
);

/**
 * Returns null if the source looks like full ABAP source for an include, or an
 * error string explaining why it does not. Heuristic: the first non-blank,
 * non-comment line must begin with a recognized top-level construct keyword.
 * This catches the worst-case mistake — sending a partial chunk that would
 * silently delete the rest of the include on PUT.
 */
// Server-side buffer store for adt_set_source_chunked. Module-level so it
// persists across tool calls within a single MCP server process.
const CHUNK_BUFFERS = new Map();
const CHUNK_TTL_MS = 10 * 60 * 1000;
const CHUNK_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

function evictExpiredBuffers(now = Date.now()) {
  for (const [id, buf] of CHUNK_BUFFERS) {
    if (now - buf.lastTouchedAt > CHUNK_TTL_MS) CHUNK_BUFFERS.delete(id);
  }
}

export function _getChunkBuffersForTest() {
  return CHUNK_BUFFERS;
}

/**
 * Locate a METHOD ... ENDMETHOD block by method name (case-insensitive). Returns
 * 1-based { start, end } line numbers (inclusive) or null if not found. Skips
 * method-declarations in CLASS DEFINITION (those don't have ENDMETHOD) — only
 * matches implementation blocks.
 */
export function findMethodRange(lines, methodName) {
  if (!methodName) return null;
  const target = methodName.toLowerCase();
  // Match `METHOD <name>.` or `METHOD <name> ...` allowing leading whitespace
  // and optional class qualifier (METHOD if_foo~bar.).
  const startRe = new RegExp(
    `^\\s*METHOD\\s+(?:[\\w/]+~)?${escapeRe(target)}\\s*(?:\\.|\\s|$)`,
    "i",
  );
  const endRe = /^\s*ENDMETHOD\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!startRe.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (endRe.test(lines[j])) {
        return { start: i + 1, end: j + 1 };
      }
    }
    // METHOD opened but no ENDMETHOD found — return what we have up to EOF.
    return { start: i + 1, end: lines.length };
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectPartialSource(source) {
  if (typeof source !== "string") return "source must be a string";
  if (source.trim().length === 0) return "source is empty";
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, "").trimStart();
    if (line.length === 0) continue;
    if (line.startsWith("*")) continue; // full-line comment
    if (line.startsWith('"')) continue; // inline comment that starts the line
    if (TOP_LEVEL_REGEX.test(line)) return null;
    return (
      `first non-comment line does not start with a recognized top-level ABAP keyword ` +
      `(got: ${JSON.stringify(line.slice(0, 60))}). The supplied source would atomically ` +
      `replace the entire include and delete everything else. If this is intentional, ` +
      `re-call with acknowledgePartial: true.`
    );
  }
  return "source contains no non-comment lines";
}

export const tools = [
  {
    name: "adt_get_source",
    description:
      "Fetch the ABAP source of an object (program, class, interface, function module, include, CDS, table). Returns plain text. DDIC primitives without plain-text source (data element, domain, message class) return their ADT XML metadata instead (format: 'xml'). For sources larger than the MCP per-call output cap (~64 KB), use firstLine/lastLine to paginate or onlyMethod to slice a single method body.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name (case-insensitive)." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: {
          type: "string",
          description:
            "Function group name (required when type is function / FUGR/FF or FUGR/I).",
        },
        include: {
          type: "string",
          description:
            "For classes: which include to fetch. One of main, definitions, implementations, macros, testclasses. Default: main.",
        },
        firstLine: {
          type: "integer",
          description:
            "Return only lines from this 1-based line number (inclusive). Combine with lastLine to paginate large sources.",
        },
        lastLine: {
          type: "integer",
          description:
            "Return only lines up to this 1-based line number (inclusive).",
        },
        onlyMethod: {
          type: "string",
          description:
            "Return only the METHOD <name> ... ENDMETHOD block (case-insensitive). Returns metadata about the slice (startLine, endLine). Convenient for inspecting one method of a large class without paginating manually.",
        },
      },
      required: ["object", "type"],
    },
  },
  {
    name: "adt_set_source",
    description:
      "Replace the ABAP source of an object. The supplied `source` is the FULL text of the include — it ATOMICALLY REPLACES the entire include on the server. Passing a partial chunk or diff will delete the rest of the include. Orchestrates lock → PUT → unlock automatically. Requires read-only mode to be off for the target system.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        object: { type: "string", description: "Object name." },
        type: { type: "string", description: OBJECT_TYPE_HINT },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: {
          type: "string",
          description:
            "For classes: which include to write. One of main, definitions, implementations, macros, testclasses. Default: main.",
        },
        source: {
          type: "string",
          description:
            "New ABAP source code — FULL text of the include. Atomic replace. Do not pass a partial diff.",
        },
        transport: {
          type: "string",
          description:
            "Transport request ID to assign the change to (sent as corrNr). Optional for local objects.",
        },
        lockHandle: {
          type: "string",
          description:
            "Optional externally-acquired lock handle. When supplied, adt_set_source skips its internal lock/unlock and assumes the caller will release the lock with adt_unlock.",
        },
        acknowledgePartial: {
          type: "boolean",
          description:
            "Set to true to bypass the partial-source guard (e.g. when writing a content-free or fragment include intentionally). The guard rejects sources whose first non-comment line does not start with a recognized top-level ABAP construct keyword.",
        },
      },
      required: ["object", "type", "source"],
    },
  },
  {
    name: "adt_set_source_chunked",
    description:
      "Replace ABAP source incrementally for files larger than the MCP per-call I/O cap. Caller acquires a lock with adt_lock, then sends the source in N chunks (chunkIndex 0..N-1) under a stable bufferId, and finally commits with commit=true to trigger the actual PUT. The chunks accumulate in server-side memory (10-minute TTL, 4 MB total cap per buffer). Same partial-source guard as adt_set_source applies at commit time.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        bufferId: {
          type: "string",
          description:
            "Caller-chosen identifier (e.g. UUID) tying multiple chunk calls into one logical write. Buffers are isolated per id and expire after 10 minutes of inactivity.",
        },
        chunkIndex: {
          type: "integer",
          description:
            "0-based ordinal of this chunk in the sequence. Must arrive in order — calls with non-sequential indices are rejected.",
        },
        chunk: {
          type: "string",
          description: "The chunk content. Concatenated verbatim — do not add separators.",
        },
        totalChunks: {
          type: "integer",
          description:
            "Total number of chunks the caller intends to send. Used to validate completeness at commit time. Optional on intermediate calls; if supplied it must be consistent across calls.",
        },
        commit: {
          type: "boolean",
          description:
            "When true, this call also commits: the accumulated buffer is concatenated and PUT to ADT. Object/type/lockHandle become required.",
        },
        object: { type: "string", description: "Object name (required when commit=true)." },
        type: { type: "string", description: OBJECT_TYPE_HINT + " (required when commit=true)." },
        group: { type: "string", description: "Function group (for FUGR/FF or FUGR/I)." },
        include: {
          type: "string",
          description:
            "For classes: which include to write. One of main, definitions, implementations, macros, testclasses. Default: main.",
        },
        transport: {
          type: "string",
          description: "Transport request ID (sent as corrNr on the PUT).",
        },
        lockHandle: {
          type: "string",
          description:
            "Lock handle obtained from adt_lock — required when commit=true. The lock MUST still be held; release it with adt_unlock after the commit succeeds.",
        },
        acknowledgePartial: {
          type: "boolean",
          description:
            "Bypass the partial-source guard at commit time. See adt_set_source for the guard semantics.",
        },
      },
      required: ["bufferId", "chunkIndex", "chunk"],
    },
  },
  {
    name: "adt_pretty_print",
    description:
      "Run the ABAP pretty printer on supplied source code (stateless — no object lookup, no lock).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        source: { type: "string", description: "ABAP source to format." },
      },
      required: ["source"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_get_source: async (args) => {
      if (typeof args.object !== "string" || args.object.length === 0) {
        const hint =
          args.name !== undefined
            ? " (you passed `name` — the field is `object`)"
            : "";
        return textResult(
          `adt_get_source: \`object\` is required${hint}. Also use \`firstLine\`/\`lastLine\` (not \`line\`/\`endLine\`) to paginate.`,
          true
        );
      }
      if (typeof args.type !== "string" || args.type.length === 0) {
        return textResult("adt_get_source: `type` is required (e.g. 'class', 'program', 'dataelement').", true);
      }
      const { client, name: sys } = getClient(args.system);
      let t;
      let path;
      try {
        t = normalizeType(args.type);
        path = sourceUri({
          type: args.type,
          name: args.object,
          group: args.group,
          include: args.include,
        });
      } catch (err) {
        // Unknown/unsupported object types (e.g. WAPA) reach the dispatch
        // tables and throw. Return that as a clean tool error with an escape
        // hatch hint instead of letting it surface as a crash.
        return textResult(
          `adt_get_source: ${err.message}. If this type has no high-level mapping yet, ` +
            `fetch it with adt_request against its ADT source URI.`,
          true
        );
      }

      // DDIC primitives (data element / domain / message class) have no
      // plain-text source — fetch their XML metadata with the right media type
      // (text/plain would 406) and return it as-is.
      const metaAccept = METADATA_XML_ACCEPT[t];
      if (metaAccept) {
        const res = await client.request({ path, accept: metaAccept });
        const text = await res.text();
        if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
        return jsonResult({
          system: sys,
          object: args.object,
          type: t,
          path,
          format: "xml",
          source: text,
          bytes: text.length,
          totalLines: text.split(/\r?\n/).length,
          note: `${t} has no plain-text source; returning ADT XML metadata (${metaAccept.split("+")[0]}+xml).`,
        });
      }

      const res = await client.request({ path, accept: "text/plain" });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));

      const allLines = text.split(/\r?\n/);
      const totalLines = allLines.length;
      const totalBytes = text.length;

      let sliceFirst = 1;
      let sliceLast = totalLines;
      let scope = "full";

      if (args.onlyMethod) {
        const range = findMethodRange(allLines, args.onlyMethod);
        if (!range) {
          return errorResult(
            sys,
            404,
            `Method ${JSON.stringify(args.onlyMethod)} not found in source. ` +
              `Looked for METHOD ${args.onlyMethod} ... ENDMETHOD (case-insensitive).`,
            "text/plain",
            { stage: "slice", scope: "method" },
          );
        }
        sliceFirst = range.start;
        sliceLast = range.end;
        scope = `method:${args.onlyMethod}`;
      } else if (
        Number.isInteger(args.firstLine) ||
        Number.isInteger(args.lastLine)
      ) {
        if (Number.isInteger(args.firstLine)) sliceFirst = Math.max(1, args.firstLine);
        if (Number.isInteger(args.lastLine)) sliceLast = Math.min(totalLines, args.lastLine);
        if (sliceFirst > sliceLast) {
          return errorResult(
            sys,
            422,
            `firstLine (${sliceFirst}) must be <= lastLine (${sliceLast}). Source has ${totalLines} lines.`,
            "text/plain",
            { stage: "slice", scope: "range" },
          );
        }
        scope = `range:${sliceFirst}-${sliceLast}`;
      }

      const slice = allLines.slice(sliceFirst - 1, sliceLast).join("\n");
      return jsonResult({
        system: sys,
        object: args.object,
        type: normalizeType(args.type),
        path,
        source: slice,
        bytes: slice.length,
        lines: sliceLast - sliceFirst + 1,
        totalLines,
        totalBytes,
        firstLine: sliceFirst,
        lastLine: sliceLast,
        scope,
        truncated: scope !== "full",
      });
    },

    adt_set_source: async (args) => {
      const { client, name: sys } = getClient(args.system);
      if (!args.acknowledgePartial) {
        const partialReason = detectPartialSource(args.source);
        if (partialReason) {
          return errorResult(sys, 422, partialReason, "text/plain", {
            stage: "validate",
            guard: "partial-source",
          });
        }
      }
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

      const externalLock = typeof args.lockHandle === "string" && args.lockHandle.length > 0;
      let handle = args.lockHandle;
      if (!externalLock) {
        const lock = await acquireLock(client, objUri, { corrNr: args.transport });
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
        return jsonResult({
          system: sys,
          object: args.object,
          type: normalizeType(args.type),
          path: srcPath,
          status: "updated",
          httpStatus: putRes.status,
          lockHandle: externalLock ? handle : undefined,
        });
      } finally {
        if (!externalLock) {
          try {
            await releaseLock(client, objUri, handle);
          } catch {
            // best-effort
          }
        }
      }
    },

    adt_set_source_chunked: async (args) => {
      const { client, name: sys } = getClient(args.system);
      evictExpiredBuffers();

      if (typeof args.bufferId !== "string" || args.bufferId.length === 0) {
        return errorResult(sys, 422, "bufferId is required", "text/plain", {
          stage: "validate",
        });
      }
      if (!Number.isInteger(args.chunkIndex) || args.chunkIndex < 0) {
        return errorResult(
          sys,
          422,
          "chunkIndex must be a non-negative integer",
          "text/plain",
          { stage: "validate" },
        );
      }
      if (typeof args.chunk !== "string") {
        return errorResult(sys, 422, "chunk must be a string", "text/plain", {
          stage: "validate",
        });
      }

      let buf = CHUNK_BUFFERS.get(args.bufferId);
      if (!buf) {
        if (args.chunkIndex !== 0) {
          return errorResult(
            sys,
            422,
            `No buffer found for bufferId ${JSON.stringify(args.bufferId)} but chunkIndex=${args.chunkIndex}. ` +
              `First chunk of a new buffer must have chunkIndex=0.`,
            "text/plain",
            { stage: "validate" },
          );
        }
        buf = {
          chunks: [],
          totalBytes: 0,
          expectedTotal: undefined,
          lastTouchedAt: Date.now(),
        };
        CHUNK_BUFFERS.set(args.bufferId, buf);
      }

      if (args.chunkIndex !== buf.chunks.length) {
        return errorResult(
          sys,
          422,
          `Out-of-order chunk: expected chunkIndex=${buf.chunks.length} but got ${args.chunkIndex}. ` +
            `Chunks must arrive sequentially.`,
          "text/plain",
          { stage: "validate" },
        );
      }

      if (Number.isInteger(args.totalChunks)) {
        if (
          buf.expectedTotal !== undefined &&
          buf.expectedTotal !== args.totalChunks
        ) {
          return errorResult(
            sys,
            422,
            `totalChunks changed mid-sequence (${buf.expectedTotal} → ${args.totalChunks})`,
            "text/plain",
            { stage: "validate" },
          );
        }
        buf.expectedTotal = args.totalChunks;
      }

      if (buf.totalBytes + args.chunk.length > CHUNK_BUFFER_MAX_BYTES) {
        CHUNK_BUFFERS.delete(args.bufferId);
        return errorResult(
          sys,
          413,
          `Buffer would exceed ${CHUNK_BUFFER_MAX_BYTES} bytes. Buffer evicted.`,
          "text/plain",
          { stage: "validate" },
        );
      }

      buf.chunks.push(args.chunk);
      buf.totalBytes += args.chunk.length;
      buf.lastTouchedAt = Date.now();

      if (!args.commit) {
        return jsonResult({
          system: sys,
          bufferId: args.bufferId,
          status: "buffered",
          chunkIndex: args.chunkIndex,
          chunksReceived: buf.chunks.length,
          expectedTotal: buf.expectedTotal,
          bufferedBytes: buf.totalBytes,
        });
      }

      // Commit path.
      if (!args.object || !args.type) {
        return errorResult(
          sys,
          422,
          "commit=true requires object and type",
          "text/plain",
          { stage: "validate" },
        );
      }
      if (!args.lockHandle) {
        return errorResult(
          sys,
          422,
          "commit=true requires lockHandle — acquire one with adt_lock first",
          "text/plain",
          { stage: "validate" },
        );
      }
      if (
        buf.expectedTotal !== undefined &&
        buf.chunks.length !== buf.expectedTotal
      ) {
        return errorResult(
          sys,
          422,
          `commit attempted with ${buf.chunks.length} chunks but expectedTotal=${buf.expectedTotal}`,
          "text/plain",
          { stage: "validate" },
        );
      }

      const fullSource = buf.chunks.join("");

      if (!args.acknowledgePartial) {
        const partialReason = detectPartialSource(fullSource);
        if (partialReason) {
          // Don't drop the buffer — let the caller retry with acknowledgePartial.
          return errorResult(sys, 422, partialReason, "text/plain", {
            stage: "validate",
            guard: "partial-source",
            bufferedBytes: buf.totalBytes,
            chunksReceived: buf.chunks.length,
          });
        }
      }

      const srcPath = sourceUri({
        type: args.type,
        name: args.object,
        group: args.group,
        include: args.include,
      });
      const putQuery = { lockHandle: args.lockHandle };
      if (args.transport) putQuery.corrNr = args.transport;
      const putRes = await client.request({
        method: "PUT",
        path: srcPath,
        query: putQuery,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-sap-adt-sessiontype": "stateful",
        },
        body: fullSource,
      });
      const putText = await putRes.text();
      if (!putRes.ok) {
        return errorResult(sys, putRes.status, putText, putRes.headers.get("content-type"), {
          stage: "put",
          bufferedBytes: buf.totalBytes,
          chunksReceived: buf.chunks.length,
        });
      }

      // Successful commit — drop the buffer.
      CHUNK_BUFFERS.delete(args.bufferId);
      return jsonResult({
        system: sys,
        bufferId: args.bufferId,
        object: args.object,
        type: normalizeType(args.type),
        path: srcPath,
        status: "committed",
        httpStatus: putRes.status,
        chunksCommitted: buf.chunks.length,
        bytesCommitted: buf.totalBytes,
      });
    },

    adt_pretty_print: async (args) => {
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
      return jsonResult({ system: sys, source: text });
    },
  };
}
