import { errorResult, jsonResult } from "../result.js";
import {
  parseDumpFeed,
  parseDumpMetadata,
  parseDumpChapters,
  filterDumpsByUser,
  CRITICAL_CHAPTER_KEYS,
} from "../dump-feed.js";
import { SYSTEM_HINT } from "./_shared.js";

const DUMPS_FEED_PATH = "/sap/bc/adt/runtime/dumps";
const DUMP_DETAIL_PATH = "/sap/bc/adt/runtime/dump";
const DUMP_METADATA_ACCEPT = "application/vnd.sap.adt.runtime.dump.v1+xml";

export const tools = [
  {
    name: "adt_list_dumps",
    description:
      "List ABAP short dumps (ST22) from the runtime-dumps Atom feed. Each entry exposes id, runtime error name, terminated program, timestamp, user, and any release-specific rba:*/dump:* fields surfaced by the system. The server-side row cap is unreliable across releases (some ignore it) — adt_list_dumps trims to maxResults on the client too. Use adt_get_dump with an id for the full dump text.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        user: {
          type: "string",
          description:
            "Filter by the user who triggered the dump (case-insensitive). Enforced client-side — several on-prem releases ignore the server-side user filter.",
        },
        host: {
          type: "string",
          description: "Filter by application server host.",
        },
        from: {
          type: "string",
          description:
            "Lower time bound. YYYYMMDD is the format known to work on on-prem ADT (e.g. '20260513'); ISO-8601 may work on newer releases.",
        },
        to: {
          type: "string",
          description:
            "Upper time bound. Same format note as 'from'.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of dumps to return (default 20). Enforced client-side.",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "adt_get_dump",
    description:
      "Fetch the full detail of one ABAP short dump by id. Performs two requests: a metadata XML lookup (runtime error, program, links to dump text) followed by a fetch of the formatted dump text from the link returned by SAP. Returns the metadata plus a chapter map (shortText, whatHappened, errorAnalysis, howToCorrect, whereTerminated, sourceCodeExtract, …). Pass chapters: ['key', …] to limit the response to specific chapters; set full: true to also include the raw dump text (typically 100KB+).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        dumpId: {
          type: "string",
          description: "Dump id, as returned by adt_list_dumps (already URL-encoded).",
        },
        chapters: {
          type: "array",
          description:
            "Limit the response to these chapter keys. Default: the critical set (shortText, whatHappened, errorAnalysis, howToCorrect, whereTerminated, sourceCodeExtract). Pass [] to return every chapter the parser recognized.",
          items: { type: "string" },
        },
        full: {
          type: "boolean",
          description:
            "Include the entire raw dump text in the response (large — typically 100KB+). Default false.",
        },
      },
      required: ["dumpId"],
    },
  },
];

function pickContentsLink(links) {
  // Prefer formatted (human-readable) over unformatted (raw spool).
  const formatted = links.find(
    (l) => /contents/i.test(l.relation ?? "") && /formatted(?!\w)/i.test(l.uri)
  );
  if (formatted) return formatted;
  const anyContents = links.find((l) => /contents/i.test(l.relation ?? ""));
  if (anyContents) return anyContents;
  // Some releases tag the link as alternate / enclosure instead.
  return links.find((l) => /text\/plain/i.test(l.contentType ?? ""));
}

function filterChapters(chapters, requested) {
  if (!requested) {
    // Default — return only the critical set, but skip ones that didn't parse.
    const out = {};
    for (const k of CRITICAL_CHAPTER_KEYS) {
      if (chapters[k]) out[k] = chapters[k];
    }
    return out;
  }
  if (Array.isArray(requested) && requested.length === 0) {
    return chapters;
  }
  const out = {};
  for (const k of requested) {
    if (chapters[k]) out[k] = chapters[k];
  }
  return out;
}

export function register({ getClient }) {
  return {
    adt_list_dumps: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const max = args.maxResults ?? 20;
      // We still send maxResults — some releases honor it. If they don't, we
      // trim below.
      const query = { maxResults: String(max) };
      if (args.user) query.user = args.user;
      if (args.host) query.host = args.host;
      if (args.from) query.since = args.from;
      if (args.to) query.until = args.to;

      const res = await client.request({
        path: DUMPS_FEED_PATH,
        query,
        accept: "application/atom+xml;type=feed",
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));

      let entries;
      try {
        entries = parseDumpFeed(text);
      } catch (err) {
        return jsonResult({
          system: sys,
          count: 0,
          parseError: err.message,
          raw: text.slice(0, 8000),
        });
      }
      // Server-side cap is unreliable; some on-prem releases return every
      // available entry regardless of maxResults. The `user` feed filter is
      // likewise ignored on several releases, so enforce it client-side before
      // trimming. Strip the per-entry summary too — on real systems it's a
      // 10+KB HTML chunk (chapter index + back-link) that bloats list responses
      // past the tool-output token limit. Agents that need detail call
      // adt_get_dump.
      const total = entries.length;
      const filtered = filterDumpsByUser(entries, args.user);
      const matched = filtered.length;
      const trimmed = filtered.slice(0, max).map((e) => {
        // eslint-disable-next-line no-unused-vars
        const { summary, ...rest } = e;
        return rest;
      });
      return jsonResult({
        system: sys,
        count: trimmed.length,
        totalReturnedByServer: total,
        matchedFilter: args.user ? matched : undefined,
        truncated: matched > trimmed.length,
        dumps: trimmed,
        raw: trimmed.length === 0 ? text.slice(0, 4000) : undefined,
      });
    },

    adt_get_dump: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const id = String(args.dumpId).trim();

      // Step 1: metadata XML. The id from the feed is already URL-encoded —
      // don't re-encode it (encodeURIComponent would turn %20 into %2520).
      const metaRes = await client.request({
        path: `${DUMP_DETAIL_PATH}/${id}`,
        accept: DUMP_METADATA_ACCEPT,
      });
      const metaText = await metaRes.text();
      if (!metaRes.ok) {
        return errorResult(sys, metaRes.status, metaText, metaRes.headers.get("content-type"), {
          stage: "metadata",
        });
      }

      let metadata;
      try {
        metadata = parseDumpMetadata(metaText);
      } catch (err) {
        return jsonResult({
          system: sys,
          dumpId: id,
          parseError: err.message,
          raw: metaText.slice(0, 8000),
        });
      }

      // Step 2: follow the contents link to fetch the formatted dump text.
      const link = pickContentsLink(metadata.links);
      let dumpText;
      let textFetchError;
      if (link) {
        let resolved;
        try {
          resolved = client.resolvePath(link.uri).split("?")[0];
        } catch (err) {
          textFetchError = `invalid-uri: ${err.message}`;
        }
        if (resolved && !resolved.toLowerCase().startsWith("/sap/bc/adt/")) {
          textFetchError = `rejected-non-adt-uri: ${resolved}`;
        } else if (!textFetchError) {
          const textRes = await client.request({
            path: link.uri,
            accept: link.contentType ?? "text/plain",
          });
          const body = await textRes.text();
          if (!textRes.ok) {
            textFetchError = `HTTP ${textRes.status}`;
          } else {
            dumpText = body;
          }
        }
      } else {
        textFetchError = "no-contents-link-in-metadata";
      }

      const chapters = dumpText ? parseDumpChapters(dumpText) : {};
      const responseChapters = filterChapters(chapters, args.chapters);

      return jsonResult({
        system: sys,
        dumpId: id,
        ...metadata,
        chapters: responseChapters,
        chaptersAvailable: Object.keys(chapters),
        textFetch: link
          ? {
              uri: link.uri,
              relation: link.relation,
              contentType: link.contentType,
              bytes: dumpText?.length,
              error: textFetchError,
            }
          : { error: textFetchError },
        rawText: args.full ? dumpText : undefined,
        metadataXml: dumpText ? undefined : metaText,
      });
    },
  };
}
