import { test } from "node:test";
import assert from "node:assert/strict";

import { register, parseInactiveObjects } from "../src/tools/worklist.js";

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

const INACTIVE_XML =
  '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">' +
  "<ioc:entry>" +
  '<ioc:object><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:type="CLAS/OC" adtcore:name="ZCL_A"/></ioc:object>' +
  '<ioc:transport><adtcore:objectReference adtcore:uri="/sap/bc/adt/cts/transportrequests/E4DK900123" adtcore:name="E4DK900123"/></ioc:transport>' +
  "</ioc:entry>" +
  "<ioc:entry>" +
  '<ioc:object><adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zr" adtcore:type="PROG/P" adtcore:name="ZR"/></ioc:object>' +
  "</ioc:entry>" +
  "</ioc:inactiveObjects>";

test("parseInactiveObjects: pairs object with its transport, handles entry w/o TR", () => {
  const objs = parseInactiveObjects(INACTIVE_XML);
  assert.equal(objs.length, 2);
  assert.equal(objs[0].name, "ZCL_A");
  assert.equal(objs[0].transport, "E4DK900123");
  assert.equal(objs[1].name, "ZR");
  assert.equal(objs[1].transport, undefined);
});

test("parseInactiveObjects: empty document → []", () => {
  assert.deepEqual(parseInactiveObjects('<ioc:inactiveObjects/>'), []);
});

test("adt_list_inactive_objects: empty → count 0 with raw", async () => {
  const { ctx, calls } = makeCtx({ responses: [resp('<ioc:inactiveObjects/>')] });
  const h = register(ctx);
  const r = await h.adt_list_inactive_objects({});
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.count, 0);
  assert.equal(calls[0].accept, "application/vnd.sap.adt.inactivectsobjects.v1+xml");
});

test("adt_list_inactive_objects: populated → parsed objects", async () => {
  const { ctx } = makeCtx({ responses: [resp(INACTIVE_XML)] });
  const h = register(ctx);
  const r = await h.adt_list_inactive_objects({});
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.count, 2);
  assert.equal(out.objects[0].transport, "E4DK900123");
});

test("adt_list_locks: 404 → available:false with SM12 hint", async () => {
  const { ctx } = makeCtx({ responses: [resp("<exc>ExceptionResourceNotFound</exc>", false, 404)] });
  const h = register(ctx);
  const r = await h.adt_list_locks({});
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, false);
  assert.match(out.hint, /SM12/);
});

test("adt_list_locks: 200 → available:true with parsed locks", async () => {
  const body =
    '<locks xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:name="MARA" adtcore:uri="x"/></locks>';
  const { ctx } = makeCtx({ responses: [resp(body)] });
  const h = register(ctx);
  const r = await h.adt_list_locks({ user: "DEV" });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.available, true);
  assert.equal(out.count, 1);
});
