import { test } from "node:test";
import assert from "node:assert/strict";

import {
  methodName,
  methodIncludeSuffix,
  methodInclude,
  functionInclude,
  crossRefName,
  parseCrossRefName,
  parseInclude,
  resolveIncludes,
} from "../src/code-intel.js";
import { chunk } from "../src/data-preview.js";
import { register } from "../src/tools/code-intel.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

test("methodName accepts plain and interface-qualified names only", () => {
  assert.equal(methodName("refresh_table_display"), "REFRESH_TABLE_DISPLAY");
  assert.equal(methodName("if_dragdrop~ondrag"), "IF_DRAGDROP~ONDRAG");
  assert.equal(methodName("/NS/IF~M"), "/NS/IF~M");
  assert.equal(methodName("A~B~C"), null);
  assert.equal(methodName("M' OR '1'='1"), null);
  assert.equal(methodName(""), null);
});

test("method include names use a base-36 index padded to three", () => {
  assert.equal(methodIncludeSuffix("00029"), "00T");
  assert.equal(methodIncludeSuffix(77), "025");
  assert.equal(methodIncludeSuffix(1), "001");
  assert.equal(methodInclude("CL_GUI_ALV_GRID", "00029"), "CL_GUI_ALV_GRID===============CM00T");
  assert.equal(methodInclude("CL_SADL_GW_UI_COMPOSIT_CONTROL", 1), "CL_SADL_GW_UI_COMPOSIT_CONTROLCM001");
});

test("functionInclude builds plain and namespaced function module includes", () => {
  assert.equal(functionInclude("SAPLSU_USER", "18"), "LSU_USERU18");
  assert.equal(functionInclude("/SDF/SAPLCOMUSER_UPDATE", "03"), "/SDF/LCOMUSER_UPDATEU03");
  assert.equal(functionInclude("ZPROG", "01"), null);
});

test("cross-reference names route interface methods to the interface", () => {
  assert.equal(crossRefName("CL_X", "DO_IT"), "CL_X\\ME:DO_IT");
  assert.equal(crossRefName("CL_X", "IF_Y~RUN"), "IF_Y\\ME:RUN");
  assert.deepEqual(parseCrossRefName("CL_X\\ME:DO_IT"), { className: "CL_X", method: "DO_IT" });
  assert.equal(parseCrossRefName("garbage"), null);
});

test("parseInclude classifies class, function and plain includes", () => {
  assert.deepEqual(parseInclude("CL_GUI_ALV_GRID===============CM00T"), {
    kind: "method",
    className: "CL_GUI_ALV_GRID",
    methodIndex: 29,
  });
  assert.deepEqual(parseInclude("CL_SADL_GW_UI_COMPOSIT_CONTROLCCIMP"), {
    kind: "class-include",
    className: "CL_SADL_GW_UI_COMPOSIT_CONTROL",
    section: "local implementations",
  });
  assert.deepEqual(parseInclude("/SDF/LCOMUSER_UPDATEU06"), {
    kind: "function-include",
    mainProgram: "/SDF/SAPLCOMUSER_UPDATE",
    includeNo: "06",
  });
  assert.deepEqual(parseInclude("RHIQCOH00_F01"), { kind: "include", include: "RHIQCOH00_F01" });
});

test("resolveIncludes maps includes to methods and function modules", () => {
  const out = resolveIncludes(
    ["CL_A==========================CM002", "CL_B==========================CM009", "LZGRPU01", "ZREPORT"],
    [{ CLASSNAME: "CL_A", METHODINDX: "00002", METHODNAME: "RUN" }],
    [{ FUNCNAME: "Z_FM", PNAME: "SAPLZGRP", INCLUDE: "01" }]
  );
  assert.deepEqual(out, [
    { kind: "method", class: "CL_A", method: "RUN", include: "CL_A==========================CM002" },
    { kind: "class", class: "CL_B", include: "CL_B==========================CM009" },
    { kind: "function", function: "Z_FM", include: "LZGRPU01" },
    { kind: "include", include: "ZREPORT" },
  ]);
});

test("chunk splits long IN lists", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// SEOMETAREL fake that answers each level from an edge list.
function hierarchyClient(edges, extra = []) {
  const rows = (where) => {
    const names = [...where[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const col = where[1].toUpperCase();
    return edges.filter((e) => names.includes(e[col]));
  };
  const client = sqlClient(extra);
  const base = client.request;
  client.request = async (call) => {
    const where = /FROM seometarel WHERE (clsname|refclsname) IN \(([^)]*)\)/i.exec(call.body ?? "");
    if (where) {
      const reltypes = [.../reltype IN \(([^)]*)\)/i.exec(call.body)[1].matchAll(/'(\d)'/g)].map((m) => m[1]);
      const filtered = rows(where).filter((e) => reltypes.includes(e.RELTYPE));
      return sqlClient([[/./, filtered]]).request(call);
    }
    return base(call);
  };
  return client;
}

const EDGES = [
  { CLSNAME: "CL_GRID", REFCLSNAME: "CL_BASE", RELTYPE: "2" },
  { CLSNAME: "CL_GRID", REFCLSNAME: "IF_DRAG", RELTYPE: "1" },
  { CLSNAME: "CL_BASE", REFCLSNAME: "CL_ROOT", RELTYPE: "2" },
  { CLSNAME: "CL_SUB", REFCLSNAME: "CL_GRID", RELTYPE: "2" },
  { CLSNAME: "CL_SUBSUB", REFCLSNAME: "CL_SUB", RELTYPE: "2" },
  { CLSNAME: "IF_DRAG_EX", REFCLSNAME: "IF_DRAG", RELTYPE: "0" },
];

test("adt_type_hierarchy walks up and down with relations and depth", async () => {
  const c = hierarchyClient(EDGES, [[/FROM seoclass/i, [{ CLSNAME: "CL_GRID", CLSTYPE: "0" }]]]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_type_hierarchy({ name: "cl_grid" }));
  assert.equal(out.kind, "class");
  assert.deepEqual(out.superclasses, ["CL_BASE", "CL_ROOT"]);
  assert.deepEqual(
    out.up.map((e) => [e.name, e.relation, e.depth]),
    [
      ["CL_BASE", "inherits", 1],
      ["IF_DRAG", "implements", 1],
      ["CL_ROOT", "inherits", 2],
    ]
  );
  assert.deepEqual(
    out.down.map((e) => [e.name, e.parent, e.depth]),
    [
      ["CL_SUB", "CL_GRID", 1],
      ["CL_SUBSUB", "CL_SUB", 2],
    ]
  );
});

test("adt_type_hierarchy on an interface finds implementers and including interfaces", async () => {
  const c = hierarchyClient(EDGES, [[/FROM seoclass/i, [{ CLSNAME: "IF_DRAG", CLSTYPE: "1" }]]]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_type_hierarchy({ name: "IF_DRAG", direction: "down" }));
  assert.equal(out.kind, "interface");
  assert.equal(out.up, undefined);
  assert.deepEqual(
    out.down.map((e) => [e.name, e.relation]).sort(),
    [
      ["CL_GRID", "implements"],
      ["CL_SUB", "inherits"],
      ["CL_SUBSUB", "inherits"],
      ["IF_DRAG_EX", "includes"],
    ]
  );
});

test("adt_type_hierarchy caps edges and reports depth limits", async () => {
  const c = hierarchyClient(EDGES, [[/FROM seoclass/i, [{ CLSNAME: "CL_GRID", CLSTYPE: "0" }]]]);
  const h = register(ctxFor({ E4D: c }));
  const capped = parse(await h.adt_type_hierarchy({ name: "CL_GRID", direction: "up", maxNodes: 1 }));
  assert.equal(capped.up.length, 1);
  assert.equal(capped.upTruncated, true);
  const shallow = parse(await h.adt_type_hierarchy({ name: "CL_GRID", direction: "down", depth: 1 }));
  assert.equal(shallow.down.length, 1);
  assert.equal(shallow.downDepthReached, true);
});

test("adt_type_hierarchy reports an unknown type", async () => {
  const h = register(ctxFor({ E4D: hierarchyClient([]) }));
  const r = await h.adt_type_hierarchy({ name: "ZCL_NOPE" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no global class or interface ZCL_NOPE/);
});

test("adt_method_redefinitions lists what a class redefines", async () => {
  const c = hierarchyClient(EDGES, [
    [/FROM seoredef WHERE clsname = 'CL_GRID'/i, [
      { REFCLSNAME: "CL_BASE", MTDNAME: "FREE" },
      { REFCLSNAME: "CL_BASE", MTDNAME: "DISPATCH" },
    ]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_method_redefinitions({ class: "CL_GRID" }));
  assert.deepEqual(out.redefines, [
    { method: "DISPATCH", from: "CL_BASE" },
    { method: "FREE", from: "CL_BASE" },
  ]);
});

test("adt_method_redefinitions with a method: origin plus subclass redefinitions", async () => {
  const c = hierarchyClient(EDGES, [
    [/FROM seoredef WHERE clsname = 'CL_GRID'/i, [{ REFCLSNAME: "CL_BASE", MTDNAME: "FREE" }]],
    [/FROM seocompo/i, [{ CLSNAME: "CL_ROOT" }]],
    [/FROM seoredef WHERE clsname IN/i, [{ CLSNAME: "CL_SUBSUB", REFCLSNAME: "CL_SUB" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_method_redefinitions({ class: "CL_GRID", method: "free" }));
  assert.equal(out.definedIn, "CL_ROOT");
  assert.deepEqual(out.redefinedHere, { method: "FREE", from: "CL_BASE" });
  assert.equal(out.subclassesSearched, 2);
  assert.deepEqual(out.redefinedIn, [{ class: "CL_SUBSUB", from: "CL_SUB", depth: 2 }]);
  const seocompo = c.calls.find((x) => /seocompo/i.test(x.body)).body;
  assert.match(seocompo, /'CL_GRID', 'CL_BASE', 'CL_ROOT'/);
});

test("adt_method_redefinitions takes the interface as origin of an interface method", async () => {
  const c = hierarchyClient(EDGES);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_method_redefinitions({ class: "CL_GRID", method: "IF_DRAG~ONDRAG" }));
  assert.equal(out.definedIn, "IF_DRAG");
  assert.equal(out.redefinedHere, null);
  assert.equal(c.calls.some((x) => /seocompo/i.test(x.body)), false);
});

test("adt_call_hierarchy callers resolves includes to methods and function modules", async () => {
  const c = sqlClient([
    [/FROM wbcrossgt WHERE otype = 'ME' AND name = 'CL_GRID\\ME:REFRESH'/i, [
      { INCLUDE: "CL_A==========================CM002" },
      { INCLUDE: "LZGRPU01" },
      { INCLUDE: "ZREPORT" },
    ]],
    [/FROM tmdir WHERE classname IN \('CL_A'\) AND methodindx IN \('00002'\)/i, [
      { CLASSNAME: "CL_A", METHODINDX: "00002", METHODNAME: "RUN" },
    ]],
    [/FROM tfdir WHERE pname IN \('SAPLZGRP'\) AND include IN \('01'\)/i, [
      { FUNCNAME: "Z_FM", PNAME: "SAPLZGRP", INCLUDE: "01" },
    ]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_call_hierarchy({ class: "CL_GRID", method: "REFRESH" }));
  assert.equal(out.totalReferences, 3);
  assert.deepEqual(
    out.callers.map((x) => x.kind),
    ["method", "function", "include"]
  );
  assert.equal(out.callers[0].method, "RUN");
  assert.equal(out.callees, undefined);
});

test("adt_call_hierarchy callees of a method read its CM include", async () => {
  const c = sqlClient([
    [/FROM tmdir WHERE classname = 'CL_GRID' AND methodname = 'REFRESH'/i, [
      { CLASSNAME: "CL_GRID", METHODINDX: "00029", METHODNAME: "REFRESH" },
    ]],
    [/FROM wbcrossgt WHERE include = 'CL_GRID=======================CM00T'/i, [
      { NAME: "CL_BASE\\ME:SET_AUTO_REDRAW" },
      { NAME: "IF_LOG\\ME:BEGIN" },
    ]],
    [/FROM cross WHERE include = 'CL_GRID=======================CM00T'/i, [{ NAME: "Z_FM" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_call_hierarchy({ class: "CL_GRID", method: "REFRESH", direction: "callees" }));
  assert.equal(out.include, "CL_GRID=======================CM00T");
  assert.deepEqual(out.callees, [
    { kind: "method", class: "CL_BASE", method: "SET_AUTO_REDRAW" },
    { kind: "method", class: "IF_LOG", method: "BEGIN" },
    { kind: "function", function: "Z_FM" },
  ]);
});

test("adt_call_hierarchy for a function module: callers from CROSS, callees from its U include", async () => {
  const c = sqlClient([
    [/FROM cross WHERE type = 'F' AND name = 'Z_FM'/i, [{ INCLUDE: "ZREPORT" }]],
    [/FROM tfdir WHERE funcname = 'Z_FM'/i, [{ FUNCNAME: "Z_FM", PNAME: "/NS/SAPLZGRP", INCLUDE: "02" }]],
    [/FROM cross WHERE include = '\/NS\/LZGRPU02'/i, [{ NAME: "Z_OTHER" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_call_hierarchy({ function: "z_fm", direction: "both" }));
  assert.deepEqual(out.callers, [{ kind: "include", include: "ZREPORT" }]);
  assert.equal(out.include, "/NS/LZGRPU02");
  assert.deepEqual(out.callees, [{ kind: "function", function: "Z_OTHER" }]);
});

test("adt_call_hierarchy rejects ambiguous input and explains a missing implementation", async () => {
  const h = register(ctxFor({ E4D: sqlClient([]) }));
  assert.equal((await h.adt_call_hierarchy({})).isError, true);
  assert.equal((await h.adt_call_hierarchy({ function: "X", class: "Y", method: "Z" })).isError, true);
  assert.equal((await h.adt_call_hierarchy({ class: "CL_X" })).isError, true);
  const r = await h.adt_call_hierarchy({ class: "CL_X", method: "M", direction: "callees" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no implementation of M/);
});
