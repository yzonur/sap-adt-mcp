// Map ABAP object identifiers (name + type) to ADT URIs.
//
// Accepts either friendly type aliases (program / class / interface / ...) or
// raw TADIR-style codes (PROG / CLAS / INTF / FUGR / FUGR/FF / INCL).
// Function modules need a function group: pass `{ type: "function", name, group }`.
//
// Object URI = the ADT object resource (used for lock/unlock and metadata GET).
// Source URI = the editable source document (used for source GET/PUT).
// Some objects (classes) have multiple source includes — `include` selects which.

const TYPE_ALIASES = {
  program: "PROG",
  prog: "PROG",
  report: "PROG",
  include: "INCL",
  incl: "INCL",
  class: "CLAS",
  clas: "CLAS",
  interface: "INTF",
  intf: "INTF",
  function: "FUGR/FF",
  functionmodule: "FUGR/FF",
  fm: "FUGR/FF",
  functiongroup: "FUGR",
  fugr: "FUGR",
  table: "TABL",
  tabl: "TABL",
  structure: "TABL",
  dataelement: "DTEL",
  dtel: "DTEL",
  domain: "DOMA",
  doma: "DOMA",
  cds: "DDLS",
  ddls: "DDLS",
  accesscontrol: "DCLS",
  dcls: "DCLS",
  metadataextension: "DDLX",
  metadataext: "DDLX",
  ddlx: "DDLX",
  behaviordef: "BDEF",
  behaviordefinition: "BDEF",
  bdef: "BDEF",
  servicedefinition: "SRVD",
  servicedef: "SRVD",
  srvd: "SRVD",
  servicebinding: "SRVB",
  srvb: "SRVB",
  messageclass: "MSAG",
  msag: "MSAG",
};

const CLASS_INCLUDES = {
  main: "main",
  definitions: "definitions",
  defs: "definitions",
  implementations: "implementations",
  imps: "implementations",
  macros: "macros",
  testclasses: "testclasses",
  tests: "testclasses",
};

export function normalizeType(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Object type is required");
  }
  const upper = input.toUpperCase();
  if (upper.includes("/")) return upper;
  const aliased = TYPE_ALIASES[input.toLowerCase()];
  return aliased ?? upper;
}

export function objectUri({ type, name, group }) {
  const t = normalizeType(type);
  const n = name.toLowerCase();
  switch (t) {
    case "PROG":
      return `/sap/bc/adt/programs/programs/${enc(n)}`;
    case "INCL":
      return `/sap/bc/adt/programs/includes/${enc(n)}`;
    case "CLAS":
      return `/sap/bc/adt/oo/classes/${enc(n)}`;
    case "INTF":
      return `/sap/bc/adt/oo/interfaces/${enc(n)}`;
    case "FUGR":
      return `/sap/bc/adt/functions/groups/${enc(n)}`;
    case "FUGR/FF": {
      if (!group) {
        throw new Error(
          `Function module '${name}': pass 'group' (the function group name)`
        );
      }
      return `/sap/bc/adt/functions/groups/${enc(group.toLowerCase())}/fmodules/${enc(n)}`;
    }
    case "FUGR/I": {
      if (!group) {
        throw new Error(
          `Function group include '${name}': pass 'group' (the function group name)`
        );
      }
      return `/sap/bc/adt/functions/groups/${enc(group.toLowerCase())}/includes/${enc(n)}`;
    }
    case "TABL":
      return `/sap/bc/adt/ddic/tables/${enc(n)}`;
    case "DTEL":
      return `/sap/bc/adt/ddic/dataelements/${enc(n)}`;
    case "DOMA":
      return `/sap/bc/adt/ddic/domains/${enc(n)}`;
    case "DDLS":
      return `/sap/bc/adt/ddic/ddl/sources/${enc(n)}`;
    case "DCLS":
      return `/sap/bc/adt/acm/dcls/${enc(n)}`;
    case "DDLX":
      return `/sap/bc/adt/ddic/ddlx/sources/${enc(n)}`;
    case "BDEF":
      return `/sap/bc/adt/bo/behaviordefinitions/${enc(n)}`;
    case "SRVD":
      return `/sap/bc/adt/ddic/srvd/sources/${enc(n)}`;
    case "SRVB":
      return `/sap/bc/adt/businessservices/bindings/${enc(n)}`;
    case "MSAG":
      return `/sap/bc/adt/messageclasses/${enc(n)}`;
    default:
      throw new Error(`Unsupported object type: ${type} (normalized: ${t})`);
  }
}

export function sourceUri({ type, name, group, include }) {
  const t = normalizeType(type);
  const base = objectUri({ type: t, name, group });

  if (t === "CLAS") {
    const inc = include ? CLASS_INCLUDES[include.toLowerCase()] : "main";
    if (!inc) {
      throw new Error(
        `Unknown class include '${include}'. Use one of: ${Object.keys(CLASS_INCLUDES).join(", ")}`
      );
    }
    return inc === "main"
      ? `${base}/source/main`
      : `${base}/includes/${inc}`;
  }

  // DDIC primitives have no separate source endpoint in the form X/source/main.
  // Tables, data elements, domains and message classes expose object metadata
  // via the object URI directly, returned as XML. CDS / DCLS / DDLX / BDEF do
  // use /source/main.
  if (t === "DTEL" || t === "DOMA" || t === "MSAG") return base;
  if (t === "TABL") return `${base}/source/main`;

  return `${base}/source/main`;
}

function enc(s) {
  return encodeURIComponent(s);
}
