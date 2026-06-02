import { test } from "node:test";
import assert from "node:assert/strict";

import { register, parseNamedItems } from "../src/tools/cds.js";

function makeCtx({ responses } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          return responses ? responses[i++] ?? responses[responses.length - 1] : {
            ok: true,
            status: 200,
            headers: { get: () => "application/xml" },
            text: async () => "",
          };
        },
      },
      name: "FAKE",
      profile: { user: "TESTER" },
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

const resp = (body, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: () => "application/xml" },
  text: async () => body,
});

const PREVIEW_XML =
  '<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/datapreview">' +
  "<dataPreview:totalRows>2</dataPreview:totalRows>" +
  "<dataPreview:columns>" +
  '<dataPreview:metadata dataPreview:name="WAERS" dataPreview:type="C"/>' +
  '<dataPreview:metadata dataPreview:name="LTEXT" dataPreview:type="C"/>' +
  "</dataPreview:columns>" +
  "<dataPreview:values>" +
  "<dataPreview:row><dataPreview:value>EUR</dataPreview:value><dataPreview:value>Euro</dataPreview:value></dataPreview:row>" +
  "<dataPreview:row><dataPreview:value>USD</dataPreview:value><dataPreview:value>Dollar</dataPreview:value></dataPreview:row>" +
  "</dataPreview:values></dataPreview:tableData>";

const RELEASESTATES_XML =
  '<nameditem:namedItemList xmlns:nameditem="http://www.sap.com/adt/nameditem">' +
  "<nameditem:totalItemCount>2</nameditem:totalItemCount>" +
  "<nameditem:namedItem><nameditem:name>USE_IN_KEY_USER_APPS</nameditem:name>" +
  "<nameditem:description>Use in Key User Apps</nameditem:description>" +
  "<nameditem:data>type=CHAR8B@@##@@longtext=C1 contract</nameditem:data></nameditem:namedItem>" +
  "<nameditem:namedItem><nameditem:name>ADD_CUSTOM_FIELDS</nameditem:name>" +
  "<nameditem:description>Add Custom Fields</nameditem:description></nameditem:namedItem>" +
  "</nameditem:namedItemList>";

test("parseNamedItems: parses name/description/data", () => {
  const items = parseNamedItems(RELEASESTATES_XML);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "USE_IN_KEY_USER_APPS");
  assert.equal(items[0].description, "Use in Key User Apps");
  assert.match(items[0].data, /C1 contract/);
  assert.equal(items[1].data, undefined);
});

test("adt_list_released_apis: returns the release-state contract catalog", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp(RELEASESTATES_XML)] });
  const h = register(ctx);
  const r = await h.adt_list_released_apis({});
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.count, 2);
  assert.match(calls[0].path, /releasestates$/);
});

test("adt_cds_data_preview: builds ddlSourceName + rowNumber, parses columns/rows", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp(PREVIEW_XML)] });
  const h = register(ctx);
  const r = await h.adt_cds_data_preview({ entity: "i_currency", maxRows: 50 });
  const out = JSON.parse(r.content[0].text);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].path, /datapreview\/cds$/);
  assert.equal(calls[0].query.ddlSourceName, "I_CURRENCY");
  assert.equal(calls[0].query.rowNumber, "50");
  assert.equal(out.entity, "I_CURRENCY");
  assert.equal(out.columns.length, 2);
  assert.equal(out.rowCount, 2);
  assert.equal(out.rows[0].WAERS, "EUR");
});

test("adt_cds_data_preview: non-ok response → error result", async () => {
  const { ctx } = makeCtx({ responses: [resp("<exc/>", false, 404)] });
  const h = register(ctx);
  const r = await h.adt_cds_data_preview({ entity: "ZBAD" });
  assert.equal(r.isError, true);
});

test("adt_cds_dependencies: graphdata request uses the DDLS object uri, parses refs", async () => {
  const graph =
    '<dependency xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/ddic/ddl/sources/i_country" adtcore:type="DDLS/DF" adtcore:name="I_COUNTRY"/>' +
    "</dependency>";
  const { ctx, calls } = makeCtx({ responses: [resp(graph)] });
  const h = register(ctx);
  const r = await h.adt_cds_dependencies({ entity: "I_CURRENCY" });
  const out = JSON.parse(r.content[0].text);
  assert.match(calls[0].path, /dependencies\/graphdata$/);
  assert.equal(calls[0].query.uri, "/sap/bc/adt/ddic/ddl/sources/i_currency");
  assert.equal(out.dependencyCount, 1);
  assert.equal(out.dependencies[0].name, "I_COUNTRY");
});

test("adt_cds_dependencies: graphdata error is surfaced with stage", async () => {
  const { ctx } = makeCtx({ responses: [resp("<exc/>", false, 500)] });
  const h = register(ctx);
  const r = await h.adt_cds_dependencies({ entity: "ZBAD" });
  assert.equal(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.stage, "graphdata");
});
