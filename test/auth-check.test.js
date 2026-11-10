import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkIndicator,
  groupSu24,
  groupStartAuth,
  stripComments,
  parseAuthorityChecks,
  summarizeChecks,
} from "../src/auth-check.js";
import { register, groupFromMainProgram } from "../src/tools/auth-check.js";
import { sqlClient, ctxFor, parse, response } from "./helpers/fake-adt.js";

test("checkIndicator maps the SU24 flags and passes unknown ones through", () => {
  assert.deepEqual(checkIndicator("X"), { okflag: "X", check: true, proposal: true, meaning: "check, proposed for roles" });
  assert.equal(checkIndicator("N").check, false);
  assert.deepEqual(checkIndicator("V"), { okflag: "V", meaning: "unknown check indicator" });
});

test("groupSu24 merges indicators, field values and texts per object", () => {
  const out = groupSu24(
    [
      { OBJECT: "S_DEVELOP", OKFLAG: "X" },
      { OBJECT: "S_GUI", OKFLAG: "Y" },
    ],
    [
      { OBJECT: "S_DEVELOP", FIELD: "ACTVT", LOW: "03", HIGH: "" },
      { OBJECT: "S_DEVELOP", FIELD: "ACTVT", LOW: "01", HIGH: "" },
      { OBJECT: "S_DEVELOP", FIELD: "DEVCLASS", LOW: "", HIGH: "" },
      { OBJECT: "S_DEVELOP", FIELD: "OBJNAME", LOW: "A", HIGH: "M" },
    ],
    new Map([["S_DEVELOP", "ABAP Workbench"]])
  );
  assert.deepEqual(out[0], {
    object: "S_DEVELOP",
    fields: { ACTVT: ["03", "01"], DEVCLASS: [], OBJNAME: [{ low: "A", high: "M" }] },
    okflag: "X",
    check: true,
    proposal: true,
    meaning: "check, proposed for roles",
    text: "ABAP Workbench",
  });
  assert.equal(out[1].object, "S_GUI");
  assert.equal(out[1].proposal, false);
});

test("groupStartAuth groups TSTCA rows per object", () => {
  assert.deepEqual(
    groupStartAuth([
      { OBJCT: "S_DEVELOP", FIELD: "ACTVT", VALUE: "03" },
      { OBJCT: "S_DEVELOP", FIELD: "DEVCLASS", VALUE: "" },
    ]),
    [{ object: "S_DEVELOP", fields: { ACTVT: "03", DEVCLASS: "" } }]
  );
});

test("stripComments blanks comments but keeps offsets and quoted double quotes", () => {
  const src = `* full line\nWRITE 'a"b'. " trailing\nX.`;
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split("\n")[0].trim(), "");
  assert.equal(out.split("\n")[1].trimEnd(), `WRITE 'a"b'.`);
});

const SOURCE = `REPORT zdemo.
* AUTHORITY-CHECK OBJECT 'S_COMMENTED' ID 'X' FIELD 'Y'.
START-OF-SELECTION.
  AUTHORITY-CHECK OBJECT 'S_CARRID'
    ID 'CARRID' FIELD lv_carrid
    ID 'ACTVT'  FIELD '03'.
  authority-check object lv_obj id 'ACTVT' dummy. " dynamic object
  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'CARRID' DUMMY ID 'ACTVT' FIELD gc_act-display FOR USER lv_user.
`;

test("parseAuthorityChecks reads literal and dynamic checks with their lines", () => {
  const checks = parseAuthorityChecks(SOURCE);
  assert.equal(checks.length, 3);
  assert.deepEqual(checks[0], {
    line: 4,
    object: { value: "S_CARRID" },
    fields: [
      { id: { value: "CARRID" }, field: { dynamic: true, expression: "lv_carrid" } },
      { id: { value: "ACTVT" }, field: { value: "03" } },
    ],
  });
  assert.deepEqual(checks[1].object, { dynamic: true, expression: "lv_obj" });
  assert.deepEqual(checks[1].fields, [{ id: { value: "ACTVT" }, dummy: true }]);
  assert.equal(checks[2].line, 8);
  assert.deepEqual(checks[2].fields[1].field, { dynamic: true, expression: "gc_act-display" });
  assert.deepEqual(checks[2].forUser, { dynamic: true, expression: "lv_user" });
});

test("summarizeChecks collapses literal objects and keeps dynamic ones apart", () => {
  const s = summarizeChecks(parseAuthorityChecks(SOURCE));
  assert.deepEqual(s.objects, [{ object: "S_CARRID", fields: ["ACTVT", "CARRID"], lines: [4, 8] }]);
  assert.equal(s.dynamic.length, 1);
});

test("groupFromMainProgram handles plain and namespaced function groups", () => {
  assert.equal(groupFromMainProgram("SAPLSU_USER"), "SU_USER");
  assert.equal(groupFromMainProgram("/SDF/SAPLCOMUSER"), "/SDF/COMUSER");
  assert.equal(groupFromMainProgram("ZPROG"), null);
});

// Data Preview SELECTs go to the routes; text/plain source GETs are answered by path.
function client(routes, sources = {}) {
  const sql = sqlClient(routes);
  return {
    calls: sql.calls,
    request: async (call) => {
      if (call.accept === "text/plain") {
        sql.calls.push(call);
        const hit = Object.entries(sources).find(([p]) => call.path.endsWith(p));
        return hit ? response(200, hit[1], "text/plain") : response(404, "<error/>");
      }
      return sql.request(call);
    },
  };
}

test("adt_auth_check transaction: start authorization + SU24 with texts", async () => {
  const c = client([
    [/FROM tstc /i, [{ TCODE: "SE38", PGMNA: "RSABAPPROGRAM" }]],
    [/FROM tstca/i, [{ OBJCT: "S_DEVELOP", FIELD: "ACTVT", VALUE: "03" }]],
    [/FROM usobx_c/i, [{ OBJECT: "S_DEVELOP", OKFLAG: "X" }]],
    [/FROM usobt_c/i, [{ OBJECT: "S_DEVELOP", FIELD: "ACTVT", LOW: "02", HIGH: "" }]],
    [/FROM tobjt/i, [{ OBJECT: "S_DEVELOP", LANGU: "E", TTEXT: "ABAP Workbench" }]],
  ]);
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_auth_check({ transaction: "se38" }));
  assert.equal(out.program, "RSABAPPROGRAM");
  assert.deepEqual(out.startAuthorization, [
    { object: "S_TCODE", fields: { TCD: "SE38" } },
    { object: "S_DEVELOP", fields: { ACTVT: "03" } },
  ]);
  assert.equal(out.su24[0].text, "ABAP Workbench");
  assert.deepEqual(out.su24[0].fields, { ACTVT: ["02"] });
  assert.match(c.calls.find((x) => /usobx_c/i.test(x.body)).body, /type = 'TR'/);
});

test("adt_auth_check function: SU24 type RF plus a scan of the module source", async () => {
  const c = client(
    [
      [/FROM tfdir/i, [{ FUNCNAME: "Z_FM", PNAME: "SAPLZGRP" }]],
      [/FROM usobx_c/i, [{ OBJECT: "S_RFC", OKFLAG: "X" }]],
    ],
    { "/functions/groups/zgrp/fmodules/z_fm/source/main": "FUNCTION z_fm.\n  AUTHORITY-CHECK OBJECT 'Z_OBJ' ID 'ACTVT' FIELD '03'.\nENDFUNCTION." }
  );
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_auth_check({ function: "Z_FM" }));
  assert.equal(out.group, "ZGRP");
  assert.equal(out.su24[0].object, "S_RFC");
  assert.deepEqual(out.sourceChecks.objects, [{ object: "Z_OBJ", fields: ["ACTVT"], lines: [2] }]);
  assert.match(c.calls.find((x) => /usobx_c/i.test(x.body ?? "")).body, /type = 'RF'/);
});

test("adt_auth_check class: scans main and local implementations, tolerates a missing include", async () => {
  const c = client([], {
    "/oo/classes/zcl_x/source/main": "CLASS zcl_x IMPLEMENTATION.\n METHOD m.\n  AUTHORITY-CHECK OBJECT 'Z_A' ID 'F' FIELD v.\n ENDMETHOD.\nENDCLASS.",
  });
  const h = register(ctxFor({ E4D: c }));
  const out = parse(await h.adt_auth_check({ object: "zcl_x", type: "class" }));
  assert.deepEqual(out.sourceChecks.scanned, ["main"]);
  assert.equal(out.sourceChecks.objects[0].object, "Z_A");
  assert.equal(out.su24, undefined);
});

test("adt_auth_check rejects ambiguous or unsafe input", async () => {
  const h = register(ctxFor({ E4D: client([]) }));
  assert.equal((await h.adt_auth_check({})).isError, true);
  assert.equal((await h.adt_auth_check({ transaction: "SE38", function: "X" })).isError, true);
  assert.equal((await h.adt_auth_check({ transaction: "SE38' OR '1'='1" })).isError, true);
  assert.equal((await h.adt_auth_check({ object: "ZTAB", type: "table" })).isError, true);
  assert.equal((await h.adt_auth_check({ object: "ZPROG" })).isError, true);
});

test("adt_auth_check transaction that does not exist", async () => {
  const h = register(ctxFor({ E4D: client([]) }));
  const r = await h.adt_auth_check({ transaction: "ZNOPE" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no transaction ZNOPE/);
});
