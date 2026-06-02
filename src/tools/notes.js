import { errorResult, jsonResult, textResult } from "../result.js";
import { SYSTEM_HINT } from "./_shared.js";

// SAP Note (SNOTE / Note Assistant) integration over ADT.
//
// IMPORTANT: a stable SAP Note ADT REST API is only present on systems that ship
// the Note Assistant ADT plug-in (modern S/4HANA). Classic NetWeaver stacks do
// NOT expose it — every call returns ExceptionResourceNotFound. These tools
// detect that and respond with available:false + a hint rather than a raw 404,
// so an agent can fall back to GUI SNOTE. The endpoint shape used here
// (/sap/bc/adt/cwb/notes/{id}) is the documented Note Assistant path; treat
// these tools as experimental until verified against an S/4 system.

const NOTES_BASE = "/sap/bc/adt/cwb/notes";

function normalizeNoteId(raw) {
  const s = String(raw).trim();
  // SAP note numbers are numeric; ADT expects the zero-padded canonical form.
  if (/^\d+$/.test(s)) return s.padStart(10, "0");
  return s;
}

function isResourceNotFound(status, body) {
  return (
    status === 404 ||
    (typeof body === "string" && /ExceptionResourceNotFound/.test(body))
  );
}

function unavailable(sys, noteId, status, body) {
  return jsonResult({
    system: sys,
    note: noteId,
    available: false,
    hint:
      "The SAP Note ADT API (Note Assistant) is not available on this system. " +
      "It ships with modern S/4HANA only; classic NetWeaver has no SNOTE REST endpoint. " +
      "Use transaction SNOTE in the SAP GUI instead.",
    status,
    raw: typeof body === "string" ? body.slice(0, 600) : undefined,
  });
}

export const tools = [
  {
    name: "adt_get_note",
    description:
      "Fetch SAP Note metadata (title, component, version, type, implementation prerequisites) via the Note Assistant ADT API. EXPERIMENTAL — only available on systems shipping the SNOTE ADT plug-in (modern S/4HANA). On systems without it the response carries available:false and a hint to use GUI SNOTE.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        note: { type: "string", description: "SAP Note number (e.g. '3076322'). Zero-padding is applied automatically." },
      },
      required: ["note"],
    },
  },
  {
    name: "adt_check_note_status",
    description:
      "Report the implementation status of a SAP Note in the system (e.g. can be implemented / obsolete / fully implemented / partially implemented). EXPERIMENTAL — see adt_get_note for availability constraints.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        note: { type: "string", description: "SAP Note number." },
      },
      required: ["note"],
    },
  },
  {
    name: "adt_implement_note",
    description:
      "Implement (download + apply) a SAP Note via the Note Assistant ADT API. WRITE operation — subject to read-only mode and requires a transport. EXPERIMENTAL and potentially disruptive: implementing a note changes system objects. Only available on systems shipping the SNOTE ADT plug-in. Prefer GUI SNOTE for anything non-trivial.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        note: { type: "string", description: "SAP Note number to implement." },
        transport: { type: "string", description: "Transport request ID to record the implementation under." },
      },
      required: ["note"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_get_note: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const noteId = normalizeNoteId(args.note);
      const res = await client.request({
        path: `${NOTES_BASE}/${encodeURIComponent(noteId)}`,
        accept: "application/xml",
      });
      const text = await res.text();
      if (isResourceNotFound(res.status, text)) return unavailable(sys, noteId, res.status, text);
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, note: noteId, available: true, result: text });
    },

    adt_check_note_status: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const noteId = normalizeNoteId(args.note);
      const res = await client.request({
        path: `${NOTES_BASE}/${encodeURIComponent(noteId)}`,
        accept: "application/xml",
      });
      const text = await res.text();
      if (isResourceNotFound(res.status, text)) return unavailable(sys, noteId, res.status, text);
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      // Surface the implementation status attribute if the payload exposes one.
      const m = text.match(/(?:implementationStatus|status)="([^"]+)"/i);
      return jsonResult({
        system: sys,
        note: noteId,
        available: true,
        status: m ? m[1] : null,
        raw: m ? undefined : text.slice(0, 2000),
      });
    },

    adt_implement_note: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const noteId = normalizeNoteId(args.note);
      if (!args.transport) {
        return textResult(
          "adt_implement_note: `transport` is required — implementing a note records object changes under a transport request.",
          true,
        );
      }
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<note:implementation xmlns:note="http://www.sap.com/adt/cwb/notes" note:id="${noteId}" note:corrNr="${args.transport}"/>`;
      const res = await client.request({
        method: "POST",
        path: `${NOTES_BASE}/${encodeURIComponent(noteId)}/deployments`,
        headers: { "Content-Type": "application/xml" },
        body,
      });
      const text = await res.text();
      if (isResourceNotFound(res.status, text)) return unavailable(sys, noteId, res.status, text);
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"), { stage: "implement" });
      return jsonResult({ system: sys, note: noteId, status: "implemented", transport: args.transport, result: text });
    },
  };
}
