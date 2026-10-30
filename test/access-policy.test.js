import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkDataPreview,
  classifyWrite,
  compilePattern,
  compilePolicy,
  extractSqlTables,
  objectRootPath,
  parseActivationUris,
  parsePackageRef,
} from "../src/access-policy.js";
import { loadConfig } from "../src/config.js";

test("compilePattern: * and ? wildcards, case-insensitive, anchored", () => {
  assert.ok(compilePattern("Z*").test("ZFLEET"));
  assert.ok(compilePattern("z*").test("ZFLEET"));
  assert.ok(compilePattern("$TMP").test("$tmp"));
  assert.ok(!compilePattern("$TMP").test("$TMPX"));
  assert.ok(compilePattern("/ACME/*").test("/ACME/CORE"));
  assert.ok(compilePattern("PA????").test("PA0008"));
  assert.ok(!compilePattern("PA????").test("PA00081"));
  assert.ok(!compilePattern("Z*").test("YZ"));
});

test("extractSqlTables: FROM / JOIN / subquery / UNION, namespaces, aliases", () => {
  assert.deepEqual(extractSqlTables("SELECT * FROM mara"), ["MARA"]);
  assert.deepEqual(
    extractSqlTables(
      "select a~pernr from pa0008 as a inner join /ACME/emp as b on a~pernr = b~pernr " +
        "where a~pernr in ( select pernr from pa0009 ) union select pernr from PCL2"
    ),
    ["PA0008", "/ACME/EMP", "PA0009", "PCL2"]
  );
  assert.deepEqual(extractSqlTables("SELECT\n*\nFROM\n  usr02"), ["USR02"]);
});

test("extractSqlTables: a table name inside a string literal is not a table", () => {
  assert.deepEqual(extractSqlTables("SELECT * FROM t000 WHERE mtext = 'from pa0008'"), ["T000"]);
});

test("checkDataPreview: defaults block HR / credential tables, allow ordinary ones", () => {
  const p = compilePolicy({});
  assert.equal(checkDataPreview(p, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM mara"), null);
  assert.match(
    checkDataPreview(p, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM pa0008"),
    /PA0008 is blocked/
  );
  assert.match(
    checkDataPreview(p, "/sap/bc/adt/datapreview/ddic?ddicEntityName=usr02", {}, ""),
    /USR02/
  );
  assert.match(
    checkDataPreview(p, "/sap/bc/adt/datapreview/ddic", { ddicEntityName: "RFCDES" }, ""),
    /RFCDES/
  );
});

test("checkDataPreview: blockedTables add to the defaults; useDefaultBlockedTables:false drops them", () => {
  const extra = compilePolicy({ blockedTables: ["ZSALARY*", "I_EMPLOYEE*"] });
  assert.match(checkDataPreview(extra, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM zsalary_hist"), /ZSALARY_HIST/);
  assert.match(checkDataPreview(extra, "/sap/bc/adt/datapreview/cds", { ddlSourceName: "I_EMPLOYEEPAY" }, ""), /I_EMPLOYEEPAY/);
  assert.match(checkDataPreview(extra, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM pa0008"), /PA0008/);

  const none = compilePolicy({ useDefaultBlockedTables: false });
  assert.equal(checkDataPreview(none, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM pa0008"), null);
});

test("checkDataPreview: allowDataPreview:false blocks every preview", () => {
  const p = compilePolicy({ allowDataPreview: false });
  assert.match(
    checkDataPreview(p, "/sap/bc/adt/datapreview/freestyle", {}, "SELECT * FROM t000"),
    /allowDataPreview: false/
  );
});

test("objectRootPath: strips sub-resources and query; function modules map to the group", () => {
  assert.equal(objectRootPath("/sap/bc/adt/programs/programs/ZFOO/source/main"), "/sap/bc/adt/programs/programs/ZFOO");
  assert.equal(objectRootPath("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses"), "/sap/bc/adt/oo/classes/zcl_x");
  assert.equal(objectRootPath("/sap/bc/adt/oo/classes/zcl_x?_action=LOCK&accessMode=MODIFY"), "/sap/bc/adt/oo/classes/zcl_x");
  assert.equal(
    objectRootPath("/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main"),
    "/sap/bc/adt/functions/groups/zfg"
  );
  assert.equal(objectRootPath("/sap/bc/adt/ddic/ddl/sources/zi_x/source/main"), "/sap/bc/adt/ddic/ddl/sources/zi_x");
});

test("parsePackageRef / parseActivationUris", () => {
  assert.equal(
    parsePackageRef('<x><adtcore:packageRef adtcore:uri="/p" adtcore:type="DEVC/K" adtcore:name="zpkg"/></x>'),
    "ZPKG"
  );
  assert.equal(parsePackageRef("<x/>"), null);
  assert.deepEqual(
    parseActivationUris(
      '<adtcore:objectReferences><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:name="ZCL_A"/>' +
        '<adtcore:objectReference adtcore:uri="https://h:1/sap/bc/adt/programs/programs/zp" adtcore:name="ZP"/></adtcore:objectReferences>'
    ),
    ["/sap/bc/adt/oo/classes/zcl_a", "/sap/bc/adt/programs/programs/zp"]
  );
});

test("classifyWrite: create, activation, object, transport, unattributable", () => {
  const create = classifyWrite(
    "POST",
    "/sap/bc/adt/oo/classes",
    {},
    '<class:abapClass adtcore:name="ZCL_N"><adtcore:packageRef adtcore:name="ZPKG"/></class:abapClass>'
  );
  assert.deepEqual(create, { kind: "packages", packages: ["ZPKG"] });
  const smuggled = classifyWrite(
    "POST",
    "/sap/bc/adt/oo/classes",
    {},
    '<adtcore:packageRef adtcore:name="ZPKG"/><adtcore:packageRef adtcore:name="SAP_BASIS"/>'
  );
  assert.deepEqual(smuggled.packages, ["ZPKG", "SAP_BASIS"]);

  // A PUT body is source code — a planted packageRef must not be trusted.
  const put = classifyWrite(
    "PUT",
    "/sap/bc/adt/programs/programs/SAPFOO/source/main",
    {},
    '" <adtcore:packageRef adtcore:name="ZOK"/>'
  );
  assert.deepEqual(put, { kind: "objects", roots: ["/sap/bc/adt/programs/programs/SAPFOO"] });

  // Same for a POST with an _action (lock / unlock).
  const lock = classifyWrite("POST", "/sap/bc/adt/programs/programs/SAPFOO", { _action: "LOCK" }, '<adtcore:packageRef adtcore:name="ZOK"/>');
  assert.equal(lock.kind, "objects");

  assert.deepEqual(classifyWrite("POST", "/sap/bc/adt/cts/transportrequests", {}, "<x/>"), { kind: "pass" });
  assert.equal(classifyWrite("POST", "/sap/bc/adt/activation", {}, "<x/>").kind, "refuse");
  assert.equal(classifyWrite("POST", "/sap/bc/adt/snote", {}, "<x/>").kind, "refuse");
});

function withConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sap-adt-policy-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  const prev = process.env.SAP_ADT_MCP_CONFIG;
  process.env.SAP_ADT_MCP_CONFIG = path;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SAP_ADT_MCP_CONFIG;
    else process.env.SAP_ADT_MCP_CONFIG = prev;
  }
}

const base = { host: "https://sap.example.com", user: "U", password: "x" };

test("config: global policy applies to every system; system values override / merge", () => {
  withConfig(
    {
      allowedPackages: ["Z*"],
      blockedTables: ["ZHR*"],
      systems: {
        DEV: { ...base },
        QAS: { ...base, allowedPackages: ["$TMP"], blockedTables: ["ZPAY"], allowDataPreview: false },
      },
    },
    () => {
      const cfg = loadConfig();
      assert.deepEqual(cfg.systems.DEV.allowedPackages, ["Z*"]);
      assert.deepEqual(cfg.systems.DEV.blockedTables, ["ZHR*"]);
      assert.equal(cfg.systems.DEV.allowDataPreview, true);
      assert.equal(cfg.systems.DEV.useDefaultBlockedTables, true);
      assert.deepEqual(cfg.systems.QAS.allowedPackages, ["$TMP"]);
      assert.deepEqual(cfg.systems.QAS.blockedTables, ["ZHR*", "ZPAY"]);
      assert.equal(cfg.systems.QAS.allowDataPreview, false);
    }
  );
});

test("config: no policy keys → no package restriction", () => {
  withConfig({ systems: { DEV: { ...base } } }, () => {
    assert.equal(loadConfig().systems.DEV.allowedPackages, undefined);
  });
});

test("config: malformed policy values fail loudly at load", () => {
  withConfig({ systems: { DEV: { ...base, allowedPackages: "Z*" } } }, () => {
    assert.throws(() => loadConfig(), /systems\.DEV\.allowedPackages must be an array/);
  });
  withConfig({ blockedTables: [""], systems: { DEV: { ...base } } }, () => {
    assert.throws(() => loadConfig(), /config\.blockedTables must be an array/);
  });
  withConfig({ systems: { DEV: { ...base, allowDataPreview: "no" } } }, () => {
    assert.throws(() => loadConfig(), /allowDataPreview must be true or false/);
  });
});
