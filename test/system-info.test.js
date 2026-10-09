import { test } from "node:test";
import assert from "node:assert/strict";

import { classifySystem } from "../src/system-info.js";
import { register } from "../src/tools/system-info.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

// Component rows as CVERS returns them on the E4D (S/4HANA 2020) test system.
const S4_2020 = [
  { COMPONENT: "S4CORE", RELEASE: "105", EXTRELEASE: "0008", COMP_TYPE: "R" },
  { COMPONENT: "S4COREOP", RELEASE: "105", EXTRELEASE: "0008", COMP_TYPE: "I" },
  { COMPONENT: "S4FND", RELEASE: "105", EXTRELEASE: "0008", COMP_TYPE: "V" },
  { COMPONENT: "SAP_ABA", RELEASE: "75F", EXTRELEASE: "0008", COMP_TYPE: "S" },
  { COMPONENT: "SAP_BASIS", RELEASE: "755", EXTRELEASE: "0008", COMP_TYPE: "S" },
  { COMPONENT: "EA-HR", RELEASE: "608", EXTRELEASE: "0136", COMP_TYPE: "N" },
];

test("classifySystem: S/4HANA 2020 on SAP_BASIS 755 — no ABAP Cloud", () => {
  const info = classifySystem(S4_2020);
  assert.equal(info.product.kind, "S/4HANA");
  assert.equal(info.product.version, "2020");
  assert.equal(info.product.spLevel, 8);
  assert.equal(info.product.onPremise, true);
  assert.deepEqual(info.sapBasis, { component: "SAP_BASIS", release: "755", spLevel: 8, type: "S" });
  assert.equal(info.abapCloud.supported, false);
  assert.equal(info.componentCount, 6);
  // EA-HR is installed but not a key component.
  assert.ok(!info.keyComponents.some((c) => c.component === "EA-HR"));
});

test("classifySystem: S/4HANA 2022 (SAP_BASIS 757, SP stored as 0000000000) supports ABAP Cloud", () => {
  const info = classifySystem([
    { COMPONENT: "S4CORE", RELEASE: "107", EXTRELEASE: "0000000000", COMP_TYPE: "R" },
    { COMPONENT: "SAP_BASIS", RELEASE: "757", EXTRELEASE: "0000000000", COMP_TYPE: "S" },
  ]);
  assert.equal(info.product.label, "SAP S/4HANA 2022");
  assert.equal(info.product.spLevel, 0);
  assert.equal(info.product.onPremise, false);
  assert.equal(info.abapCloud.supported, true);
});

test("classifySystem: SAP_BASIS 816 (ABAP Platform 2025) compares above 757", () => {
  const info = classifySystem([{ COMPONENT: "SAP_BASIS", RELEASE: "816", EXTRELEASE: "0001" }]);
  assert.equal(info.abapCloud.supported, true);
  assert.equal(info.product.kind, "NetWeaver");
});

test("classifySystem: ECC is SAP_APPL without S4CORE", () => {
  const info = classifySystem([
    { COMPONENT: "SAP_APPL", RELEASE: "618", EXTRELEASE: "0012" },
    { COMPONENT: "SAP_BASIS", RELEASE: "750", EXTRELEASE: "0020" },
  ]);
  assert.equal(info.product.kind, "ECC");
  assert.equal(info.product.version, "618");
  assert.equal(info.abapCloud.supported, false);
});

test("classifySystem: unknown S4CORE release still labels as S/4HANA", () => {
  const info = classifySystem([{ COMPONENT: "S4CORE", RELEASE: "120", EXTRELEASE: "0" }]);
  assert.equal(info.product.version, null);
  assert.match(info.product.label, /S4CORE 120/);
  assert.equal(info.abapCloud.supported, null);
});

test("adt_system_info reads CVERS once and returns the classification", async () => {
  const client = sqlClient([[/FROM cvers/i, S4_2020]]);
  const h = register(ctxFor({ E4D: client }));
  const out = parse(await h.adt_system_info({}));
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, "/sap/bc/adt/datapreview/freestyle");
  assert.equal(out.system, "E4D");
  assert.equal(out.product.version, "2020");
  assert.equal(out.components, undefined);

  const full = parse(await h.adt_system_info({ includeComponents: true }));
  assert.equal(full.components.length, S4_2020.length);
});

test("adt_system_info surfaces a Data Preview failure as an error result", async () => {
  const client = sqlClient([[/FROM cvers/i, 403]]);
  const out = await register(ctxFor({ E4D: client })).adt_system_info({});
  assert.equal(out.isError, true);
  assert.equal(parse(out).stage, "cvers");
});
