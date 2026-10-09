import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

import {
  cacheKey,
  createResultCache,
  withResultCache,
  parseCacheConfig,
  DEFAULT_TTL_MS,
} from "../src/result-cache.js";
import { AdtClient } from "../src/adt-client.js";

const ok = (text) => ({ content: [{ type: "text", text }], isError: false });

test("cacheKey ignores argument order and the system arg", () => {
  assert.equal(
    cacheKey("adt_search_objects", "E4D", { query: "Z*", maxResults: 5, system: "E4D" }),
    cacheKey("adt_search_objects", "E4D", { maxResults: 5, query: "Z*" })
  );
  assert.notEqual(
    cacheKey("adt_search_objects", "E4D", { query: "Z*" }),
    cacheKey("adt_search_objects", "S4X", { query: "Z*" })
  );
});

test("entries expire after the TTL and the oldest is evicted past maxEntries", () => {
  let t = 0;
  const cache = createResultCache({ ttlMs: 1000, maxEntries: 2, now: () => t });
  cache.set("a", 1);
  t = 999;
  assert.deepEqual(cache.get("a"), { value: 1, ageMs: 999 });
  t = 1000;
  assert.equal(cache.get("a"), undefined);

  cache.set("x", 1);
  cache.set("y", 2);
  cache.set("z", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("x"), undefined);
});

test("withResultCache: second identical call is a marked hit; errors and non-cacheable tools always run", async () => {
  const cache = createResultCache({ ttlMs: 60_000 });
  let runs = 0;
  const run = async () => {
    runs++;
    return ok("result");
  };
  const call = { tool: "adt_search_objects", system: "E4D", args: { query: "Z*" } };

  const first = await withResultCache(cache, call, run);
  const second = await withResultCache(cache, call, run);
  assert.equal(runs, 1);
  assert.equal(first._meta, undefined);
  assert.equal(second._meta["sap-adt-mcp/cache"].hit, true);
  assert.equal(second.content[0].text, "result");

  let errRuns = 0;
  const failing = async () => {
    errRuns++;
    return { content: [{ type: "text", text: "boom" }], isError: true };
  };
  const errCall = { tool: "adt_where_used", system: "E4D", args: { object: "X", type: "CLAS" } };
  await withResultCache(cache, errCall, failing);
  await withResultCache(cache, errCall, failing);
  assert.equal(errRuns, 2);

  let writeRuns = 0;
  const write = async () => {
    writeRuns++;
    return ok("done");
  };
  const writeCall = { tool: "adt_set_source", system: "E4D", args: { object: "Z" } };
  await withResultCache(cache, writeCall, write);
  await withResultCache(cache, writeCall, write);
  assert.equal(writeRuns, 2);
});

test("a disabled cache (ttl 0) never stores", async () => {
  const cache = createResultCache({ ttlMs: 0 });
  assert.equal(cache.enabled, false);
  let runs = 0;
  const call = { tool: "adt_system_info", system: "E4D", args: {} };
  await withResultCache(cache, call, async () => (runs++, ok("x")));
  await withResultCache(cache, call, async () => (runs++, ok("x")));
  assert.equal(runs, 2);
});

test("parseCacheConfig: config value, env override, defaults", () => {
  const saved = process.env.SAP_ADT_MCP_CACHE_TTL_MS;
  try {
    delete process.env.SAP_ADT_MCP_CACHE_TTL_MS;
    assert.equal(parseCacheConfig(undefined).ttlMs, DEFAULT_TTL_MS);
    assert.equal(parseCacheConfig({ ttlMs: 0 }).ttlMs, 0);
    assert.equal(parseCacheConfig({ ttlMs: -5 }).ttlMs, DEFAULT_TTL_MS);
    process.env.SAP_ADT_MCP_CACHE_TTL_MS = "0";
    assert.equal(parseCacheConfig({ ttlMs: 120_000 }).ttlMs, 0);
  } finally {
    if (saved === undefined) delete process.env.SAP_ADT_MCP_CACHE_TTL_MS;
    else process.env.SAP_ADT_MCP_CACHE_TTL_MS = saved;
  }
});

test("AdtClient fires onWrite for a real write, not for a read-only POST", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get("http://sap.test:8000");
  pool
    .intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery/ })
    .reply(200, "<x/>", { headers: { "x-csrf-token": "T1" } });
  pool.intercept({ method: "POST", path: /\/sap\/bc\/adt\/datapreview\/freestyle/ }).reply(200, "<x/>");
  pool.intercept({ method: "PUT", path: /\/sap\/bc\/adt\/programs\/programs\/ztest\/source\/main/ }).reply(200, "");

  const writes = [];
  const client = new AdtClient(
    { host: "http://sap.test:8000", user: "U", password: "P", client: "100" },
    { onWrite: (w) => writes.push(w) }
  );
  await client.request({ method: "POST", path: "/sap/bc/adt/datapreview/freestyle", body: "SELECT * FROM t000" });
  assert.equal(writes.length, 0);
  await client.request({ method: "PUT", path: "/sap/bc/adt/programs/programs/ztest/source/main", body: "REPORT ztest." });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  await mock.close();
});
