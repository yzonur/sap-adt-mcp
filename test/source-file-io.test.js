// #39: large-object editing without routing source through the agent's I/O cap.
//   - adt_set_source `sourceFile`: MCP reads a local file and PUTs it.
//   - adt_get_source `outputFile`: MCP writes the fetched source straight to disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { register } from "../src/tools/source.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sap-adt-fileio-"));

function captureClient() {
  const calls = [];
  return {
    calls,
    ctx: {
      getClient: () => ({
        client: {
          request: async (call) => {
            calls.push(call);
            // PUT (set_source) and GET (get_source) both just succeed.
            return {
              ok: true,
              status: 200,
              headers: { get: () => "text/plain" },
              text: async () => (call.method === "GET" || !call.method ? BIG_SOURCE : "<ok/>"),
            };
          },
        },
        name: "FAKE",
      }),
      config: { systems: {}, defaultSystem: null },
    },
  };
}

const BIG_SOURCE = "REPORT zbig.\n" + Array.from({ length: 5000 }, (_, i) => `WRITE / ${i}.`).join("\n");

test("adt_set_source reads sourceFile and PUTs its contents (#39)", async () => {
  const file = path.join(TMP, "in.abap");
  const body = "CLASS zcl_big DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_big IMPLEMENTATION.\nENDCLASS.";
  fs.writeFileSync(file, body);

  const { ctx, calls } = captureClient();
  const h = register(ctx);
  // External lockHandle → skip internal lock/unlock, leaving just the PUT.
  const r = await h.adt_set_source({
    object: "ZCL_BIG",
    type: "CLAS",
    sourceFile: file,
    lockHandle: "H1",
  });
  assert.doesNotMatch(r.content[0].text, /error/i);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "a PUT must be issued");
  assert.equal(put.body, body, "the file contents must be PUT verbatim");
});

test("adt_set_source rejects both source and sourceFile", async () => {
  const { ctx } = captureClient();
  const h = register(ctx);
  const r = await h.adt_set_source({
    object: "ZCL_BIG",
    type: "CLAS",
    source: "REPORT z.",
    sourceFile: "/whatever",
    lockHandle: "H1",
  });
  assert.match(r.content[0].text, /either `source` or `sourceFile`, not both/);
});

test("adt_set_source requires one of source / sourceFile", async () => {
  const { ctx } = captureClient();
  const h = register(ctx);
  const r = await h.adt_set_source({ object: "ZCL_BIG", type: "CLAS", lockHandle: "H1" });
  assert.match(r.content[0].text, /is required/);
});

test("adt_set_source gives a clean error when sourceFile is missing", async () => {
  const { ctx } = captureClient();
  const h = register(ctx);
  const r = await h.adt_set_source({
    object: "ZCL_BIG",
    type: "CLAS",
    sourceFile: path.join(TMP, "does-not-exist.abap"),
    lockHandle: "H1",
  });
  assert.match(r.content[0].text, /could not read sourceFile/);
  assert.match(r.content[0].text, /file not found/);
});

test("adt_get_source outputFile writes to disk and omits inline source (#39)", async () => {
  const out = path.join(TMP, "out.abap");
  const { ctx } = captureClient();
  const h = register(ctx);
  const r = await h.adt_get_source({ object: "ZBIG", type: "PROG", outputFile: out });
  const payload = JSON.parse(r.content[0].text);

  assert.equal(payload.source, undefined, "inline source must be omitted when writing a file");
  assert.equal(payload.outputFile, out);
  assert.equal(payload.bytesWritten, BIG_SOURCE.length);
  assert.equal(fs.readFileSync(out, "utf8"), BIG_SOURCE, "file must hold the full source");
});

test("adt_get_source outputFile respects a line range", async () => {
  const out = path.join(TMP, "slice.abap");
  const { ctx } = captureClient();
  const h = register(ctx);
  const r = await h.adt_get_source({
    object: "ZBIG",
    type: "PROG",
    firstLine: 1,
    lastLine: 3,
    outputFile: out,
  });
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.scope, "range:1-3");
  assert.equal(fs.readFileSync(out, "utf8"), BIG_SOURCE.split("\n").slice(0, 3).join("\n"));
});

test("adt_set_source PUTs DDIC primitives with their XML media type, not text/plain (#72)", async () => {
  const { ctx, calls } = captureClient();
  const h = register(ctx);
  const domainXml =
    '<?xml version="1.0" encoding="utf-8"?><doma:domain adtcore:name="ZRFT_DOM_EXP_ID" adtcore:type="DOMA/DD"/>';
  const r = await h.adt_set_source({
    object: "ZRFT_DOM_EXP_ID",
    type: "domain",
    source: domainXml,
    lockHandle: "H1",
  });
  assert.doesNotMatch(r.content[0].text, /error/i);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "a PUT must be issued (partial-source guard must not block XML)");
  assert.equal(put.headers["Content-Type"], "application/vnd.sap.adt.domains.v2+xml");
  assert.equal(put.body, domainXml);
});

test("adt_set_source: a function module without group returns a clean error, not a crash", async () => {
  const { ctx, calls } = captureClient();
  const h = register(ctx);
  const r = await h.adt_set_source({
    object: "/FGLR/DELIVERY_CREATE",
    type: "FUGR/FF",
    source: "FUNCTION x.\nENDFUNCTION.",
    lockHandle: "H1",
  });
  assert.match(r.content[0].text, /pass 'group'/);
  assert.equal(calls.length, 0, "no request when the URI can't be built");
});
