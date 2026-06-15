// Build the POST request needed to create a new ABAP object via ADT.
//
// Returns { path, contentType, body } so the server handler just dispatches it.
//
// Each ADT object kind has its own collection endpoint, content-type, and XML
// shape. The shapes here cover the common modern (NW 7.5x+ / S/4) on-prem
// surface; older systems may reject some content-types. If yours does, fall
// back to adt_request and craft the POST manually.

import { normalizeType } from "./object-uris.js";

export function buildCreateRequest({
  type,
  name,
  package: pkg,
  description,
  group,
  programType,
  responsible,
}) {
  if (!name || typeof name !== "string") {
    throw new Error("Object create: `name` is required");
  }
  if (!pkg || typeof pkg !== "string") {
    throw new Error("Object create: `package` is required");
  }
  const t = normalizeType(type);
  const upperName = name.toUpperCase();
  const upperPkg = pkg.toUpperCase();
  const desc = (description ?? upperName).slice(0, 60);
  const respAttr = responsible
    ? ` adtcore:responsible="${escapeXml(responsible.toUpperCase())}"`
    : "";

  switch (t) {
    case "PROG":
      return {
        path: "/sap/bc/adt/programs/programs",
        contentType: "application/vnd.sap.adt.programs.programs.v2+xml",
        body: xmlDecl() +
          `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="PROG/P"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}` +
          // programType is whitelisted to known ADT values; anything else
          // would either be rejected by SAP or, if it contained a stray
          // double-quote, let the caller close the attribute and inject
          // arbitrary XML attributes / elements (e.g. a second packageRef
          // pointing at a different package than the one the user asked for).
          ` program:programType="${escapeXml(validateProgramType(programType))}">` +
          packageRef(upperPkg) +
          `</program:abapProgram>`,
      };

    case "CLAS":
      return {
        path: "/sap/bc/adt/oo/classes",
        contentType: "application/vnd.sap.adt.oo.classes.v3+xml",
        body: xmlDecl() +
          `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="CLAS/OC"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}` +
          ` class:final="true" class:visibility="public" class:abstract="false"` +
          ` class:category="generalObjectType">` +
          packageRef(upperPkg) +
          `</class:abapClass>`,
      };

    case "INTF":
      return {
        path: "/sap/bc/adt/oo/interfaces",
        contentType: "application/vnd.sap.adt.oo.interfaces.v2+xml",
        body: xmlDecl() +
          `<intf:abapInterface xmlns:intf="http://www.sap.com/adt/oo/interfaces"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="INTF/OI"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</intf:abapInterface>`,
      };

    case "INCL":
      return {
        path: "/sap/bc/adt/programs/includes",
        contentType: "application/vnd.sap.adt.programs.includes.v2+xml",
        body: xmlDecl() +
          `<include:abapInclude xmlns:include="http://www.sap.com/adt/programs/includes"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="PROG/I"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</include:abapInclude>`,
      };

    case "FUGR":
      return {
        path: "/sap/bc/adt/functions/groups",
        contentType: "application/vnd.sap.adt.functions.groups.v3+xml",
        body: xmlDecl() +
          `<group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="FUGR/F"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</group:abapFunctionGroup>`,
      };

    case "FUGR/FF": {
      if (!group) {
        throw new Error(
          "Function module create: `group` (function group name) is required"
        );
      }
      const upperGroup = group.toUpperCase();
      const lowerGroup = group.toLowerCase();
      return {
        path: `/sap/bc/adt/functions/groups/${encodeURIComponent(lowerGroup)}/fmodules`,
        contentType: "application/vnd.sap.adt.functions.fmodules.v3+xml",
        body: xmlDecl() +
          `<fm:abapFunctionModule xmlns:fm="http://www.sap.com/adt/functions/fmodules"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="FUGR/FF"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          `<fm:containerRef adtcore:uri="/sap/bc/adt/functions/groups/${escapeXml(lowerGroup)}"` +
          ` adtcore:type="FUGR/F" adtcore:name="${escapeXml(upperGroup)}"/>` +
          `</fm:abapFunctionModule>`,
      };
    }

    case "DDLS":
      return {
        path: "/sap/bc/adt/ddic/ddl/sources",
        contentType: "application/vnd.sap.adt.ddlsource.v2+xml",
        body: xmlDecl() +
          `<ddl:source xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="DDLS/DF"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</ddl:source>`,
      };

    case "DCLS":
      return {
        path: "/sap/bc/adt/acm/dcls",
        contentType: "application/vnd.sap.adt.acm.dcls.v2+xml",
        body: xmlDecl() +
          `<dcl:source xmlns:dcl="http://www.sap.com/adt/acm/dcls"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="DCLS/DL"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</dcl:source>`,
      };

    case "DDLX":
      return {
        path: "/sap/bc/adt/ddic/ddlx/sources",
        contentType: "application/vnd.sap.adt.ddlxsource.v2+xml",
        body: xmlDecl() +
          `<ddlx:source xmlns:ddlx="http://www.sap.com/adt/ddic/ddlxsources"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="DDLX/EX"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</ddlx:source>`,
      };

    case "BDEF":
      return {
        path: "/sap/bc/adt/bo/behaviordefinitions",
        contentType: "application/vnd.sap.adt.bo.bdef.v2+xml",
        body: xmlDecl() +
          `<bdef:behaviorDefinition xmlns:bdef="http://www.sap.com/adt/bo/bdef"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="BDEF/BO"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</bdef:behaviorDefinition>`,
      };

    case "MSAG":
      return {
        path: "/sap/bc/adt/messageclasses",
        contentType: "application/vnd.sap.adt.messageclass.v2+xml",
        body: xmlDecl() +
          `<msag:messageClass xmlns:msag="http://www.sap.com/adt/messageclasses"` +
          ` xmlns:adtcore="http://www.sap.com/adt/core"` +
          ` adtcore:name="${escapeXml(upperName)}" adtcore:type="MSAG/N"` +
          ` adtcore:description="${escapeXml(desc)}"${respAttr}>` +
          packageRef(upperPkg) +
          `</msag:messageClass>`,
      };

    default:
      throw new Error(
        `Object create not supported for type: ${type} (normalized: ${t}). ` +
          "Use adt_request to POST to the relevant ADT collection endpoint."
      );
  }
}

// Most ADT create endpoints version their media type (…v2+xml, …v3+xml). The
// shapes above target the newest version a modern stack accepts, but older
// systems only know an earlier one and answer the newer media type with
// 415 ExceptionUnsupportedMediaType. Given a content-type, return the chain to
// try: the requested version first, then every lower version down to v1.
// A content-type with no `.vN+xml` segment is returned unchanged (single item).
export function mediaTypeFallbacks(contentType) {
  const m = /^(.*\.)v(\d+)(\+xml)$/.exec(contentType);
  if (!m) return [contentType];
  const [, prefix, ver, suffix] = m;
  const chain = [];
  for (let v = Number(ver); v >= 1; v--) {
    chain.push(`${prefix}v${v}${suffix}`);
  }
  return chain;
}

// POST a create request, retrying with successively lower media-type versions
// when the server rejects the content-type with 415. Returns
// { res, text, contentType } for the first attempt that is not a 415 — or the
// last attempt if every version is rejected. The body is read once here so
// callers must use the returned `text` rather than calling res.text() again.
export async function postCreate(client, { path, contentType, body, query }) {
  const types = mediaTypeFallbacks(contentType);
  let res;
  let text;
  let used;
  for (let i = 0; i < types.length; i++) {
    used = types[i];
    res = await client.request({
      method: "POST",
      path,
      query,
      headers: { "Content-Type": used },
      body,
    });
    text = await res.text();
    if (res.status !== 415 || i === types.length - 1) break;
  }
  return { res, text, contentType: used };
}

function xmlDecl() {
  return `<?xml version="1.0" encoding="UTF-8"?>`;
}

function packageRef(pkg) {
  return `<adtcore:packageRef adtcore:name="${escapeXml(pkg)}"/>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// SAP's published ADT values for program:programType. Anything outside this
// set is rejected so a caller can't smuggle XML attribute terminators into
// the attribute value (defense in depth — escapeXml at the call site already
// handles quoting).
const ALLOWED_PROGRAM_TYPES = new Set([
  "executableProgram",
  "modulePool",
  "subroutinePool",
  "functionGroup",
  "interfacePool",
  "classPool",
  "typeGroup",
  "include",
]);

function validateProgramType(programType) {
  if (programType == null) return "executableProgram";
  if (typeof programType !== "string" || !ALLOWED_PROGRAM_TYPES.has(programType)) {
    throw new Error(
      `Invalid programType: ${programType}. Allowed: ${[...ALLOWED_PROGRAM_TYPES].join(", ")}`
    );
  }
  return programType;
}
