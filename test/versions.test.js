import { test } from "node:test";
import assert from "node:assert/strict";

import { register, parseVersionList } from "../src/tools/versions.js";

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
            headers: { get: () => "text/plain" },
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
  headers: { get: () => "text/plain" },
  text: async () => body,
});

test("parseVersionList: extracts version attributes", () => {
  const xml =
    '<vrs:versions><vrs:version vrs:number="000002" vrs:author="DEV" vrs:date="20260101"/>' +
    '<vrs:version vrs:number="000001" vrs:author="DEV2"/></vrs:versions>';
  const v = parseVersionList(xml);
  assert.equal(v.length, 2);
  assert.equal(v[0].number, "000002");
  assert.equal(v[0].author, "DEV");
});

test("adt_list_versions: 404 → available:false with hint, not an error", async () => {
  const { ctx } = makeCtx({ responses: [resp("No suitable resource found", false, 404)] });
  const h = register(ctx);
  const r = await h.adt_list_versions({ object: "ZCL_A", type: "class" });
  assert.notEqual(r.isError, true); // graceful, not an error
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.match(out.hint, /adt_compare_versions/);
});

test("adt_list_versions: 200 → parsed versions, available:true", async () => {
  const xml = '<vrs:versions><vrs:version vrs:number="000001" vrs:author="X"/></vrs:versions>';
  const { ctx, calls } = makeCtx({ responses: [resp(xml)] });
  const h = register(ctx);
  const r = await h.adt_list_versions({ object: "ZCL_A", type: "class" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, true);
  assert.equal(out.count, 1);
  assert.match(calls[0].path, /\/sap\/bc\/adt\/oo\/classes\/zcl_a\/versions$/);
});

test("adt_compare_versions: diffs from/to with version query params", async () => {
  const { ctx, calls } = makeCtx({
    responses: [resp("line1\nline2\nline3"), resp("line1\nCHANGED\nline3")],
  });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.from, "inactive");
  assert.equal(out.to, "active");
  assert.equal(calls[0].query.version, "inactive");
  assert.equal(calls[1].query.version, "active");
  assert.equal(out.identical, false);
  assert.ok(out.stats.added >= 1 && out.stats.removed >= 1);
});

test("adt_compare_versions: identical sources → identical:true", async () => {
  const { ctx } = makeCtx({ responses: [resp("same\ntext"), resp("same\ntext")] });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class", from: "active", to: "active" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.identical, true);
});

test("adt_compare_versions: from-side fetch error is surfaced with side label", async () => {
  const { ctx } = makeCtx({
    responses: [resp("boom", false, 500), resp("ok")],
  });
  const h = register(ctx);
  const r = await h.adt_compare_versions({ object: "ZCL_A", type: "class" });
  assert.equal(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.side, "from");
});
