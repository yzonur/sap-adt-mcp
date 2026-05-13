import { objectUri } from "../object-uris.js";
import { escapeXml } from "../xml.js";
import { errorResult, jsonResult } from "../result.js";
import { OBJECT_TYPE_HINT, SYSTEM_HINT } from "./_shared.js";

export const tools = [
  {
    name: "adt_syntax_check",
    description: "Run an ADT syntax check on an object. Returns the raw <chkrun:reports> XML.",
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
    name: "adt_run_unit_tests",
    description:
      "Run ABAP Unit tests for one or more objects (typically test container classes).",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        objects: {
          type: "array",
          description: "Objects to test.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["objects"],
    },
  },
  {
    name: "adt_run_atc",
    description:
      "Run ABAP Test Cockpit (ATC) on one or more objects. ATC endpoint shape varies across NetWeaver releases.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: SYSTEM_HINT },
        objects: {
          type: "array",
          description: "Objects to check.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: OBJECT_TYPE_HINT },
              group: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
        checkVariant: {
          type: "string",
          description: "ATC check variant. Defaults to DEFAULT.",
        },
      },
      required: ["objects"],
    },
  },
];

export function register({ getClient }) {
  return {
    adt_syntax_check: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const objUri = objectUri({
        type: args.type,
        name: args.object,
        group: args.group,
      });
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<chkrun:checkObject adtcore:uri="${escapeXml(objUri)}"/>` +
        `</chkrun:checkObjectList>`;
      const res = await client.request({
        method: "POST",
        path: "/sap/bc/adt/checkruns",
        query: { reporters: "abapCheckRun" },
        headers: { "Content-Type": "application/vnd.sap.adt.checkobjects+xml" },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, object: args.object, result: text });
    },

    adt_run_unit_tests: async (args) => {
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
        headers: {
          "Content-Type": "application/vnd.sap.adt.abapunit.testruns.config.v1+xml",
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) return errorResult(sys, res.status, text, res.headers.get("content-type"));
      return jsonResult({ system: sys, result: text });
    },

    adt_run_atc: async (args) => {
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
      return jsonResult({
        system: sys,
        checkVariant: variant,
        result: text,
        note: "ATC results are typically retrieved by following the worklist URL inside the response. Use adt_request to fetch the worklist if needed.",
      });
    },
  };
}
