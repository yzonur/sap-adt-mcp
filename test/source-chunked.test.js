import { test } from "node:test";
import assert from "node:assert/strict";

import { register, _getChunkBuffersForTest } from "../src/tools/source.js";

function makeCtx() {
  const calls = [];
  const ctx = {
    getClient: () => ({
      client: {
        request: async (call) => {
          calls.push(call);
          return {
            ok: true,
            status: 200,
            headers: { get: () => "text/plain" },
            text: async () => "",
          };
        },
      },
      name: "FAKE",
    }),
    config: { systems: {}, defaultSystem: null },
  };
  return { ctx, calls };
}

function clearBuffers() {
  const m = _getChunkBuffersForTest();
  m.clear();
}

test("first chunk creates buffer; status=buffered", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-1",
    chunkIndex: 0,
    chunk: "REPORT zfoo.\n",
    totalChunks: 2,
  });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.status, "buffered");
  assert.equal(p.chunksReceived, 1);
  assert.equal(p.expectedTotal, 2);
});

test("rejects non-zero first chunkIndex", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-x",
    chunkIndex: 1,
    chunk: "REPORT zfoo.",
  });
  assert.equal(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.status, 422);
});

test("rejects out-of-order chunks", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-2",
    chunkIndex: 0,
    chunk: "REPORT zfoo.\n",
  });
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-2",
    chunkIndex: 5,
    chunk: " more.",
  });
  assert.equal(r.isError, true);
});

test("rejects mismatched totalChunks", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-3",
    chunkIndex: 0,
    chunk: "REPORT zfoo.",
    totalChunks: 2,
  });
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-3",
    chunkIndex: 1,
    chunk: " more.",
    totalChunks: 3,
  });
  assert.equal(r.isError, true);
});

test("commit assembles chunks and PUTs full source", async () => {
  clearBuffers();
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-4",
    chunkIndex: 0,
    chunk: "REPORT zfoo.\n",
    totalChunks: 2,
  });
  const result = await h.adt_set_source_chunked({
    bufferId: "buf-4",
    chunkIndex: 1,
    chunk: "  WRITE 'hello'.\n",
    totalChunks: 2,
    commit: true,
    object: "ZFOO",
    type: "PROG",
    lockHandle: "HANDLE",
    transport: "E4DK900111",
  });
  const p = JSON.parse(result.content[0].text);
  assert.equal(p.status, "committed");
  assert.equal(p.chunksCommitted, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body, "REPORT zfoo.\n  WRITE 'hello'.\n");
  assert.equal(calls[0].query.lockHandle, "HANDLE");
  assert.equal(calls[0].query.corrNr, "E4DK900111");
  assert.equal(_getChunkBuffersForTest().has("buf-4"), false, "buffer evicted on success");
});

test("commit refuses without lockHandle", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-5",
    chunkIndex: 0,
    chunk: "REPORT zfoo.",
  });
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-5",
    chunkIndex: 1,
    chunk: " more.",
    commit: true,
    object: "ZFOO",
    type: "PROG",
  });
  assert.equal(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert.match(p.error.raw ?? "", /lockHandle/);
});

test("commit refuses if expectedTotal mismatches received count", async () => {
  clearBuffers();
  const { ctx } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-6",
    chunkIndex: 0,
    chunk: "REPORT zfoo.",
    totalChunks: 3,
  });
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-6",
    chunkIndex: 1,
    chunk: " more.",
    totalChunks: 3,
    commit: true,
    object: "ZFOO",
    type: "PROG",
    lockHandle: "H",
  });
  assert.equal(r.isError, true);
});

test("commit applies partial-source guard", async () => {
  clearBuffers();
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-7",
    chunkIndex: 0,
    chunk: "  rv = 1.\n",
  });
  const r = await h.adt_set_source_chunked({
    bufferId: "buf-7",
    chunkIndex: 1,
    chunk: "  RETURN.\n",
    commit: true,
    object: "ZFOO",
    type: "PROG",
    lockHandle: "H",
  });
  assert.equal(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.guard, "partial-source");
  assert.equal(calls.length, 0, "PUT must not be issued when guard rejects");
  assert.equal(_getChunkBuffersForTest().has("buf-7"), true, "buffer retained for retry");
});

test("acknowledgePartial bypasses guard on commit", async () => {
  clearBuffers();
  const { ctx, calls } = makeCtx();
  const h = register(ctx);
  await h.adt_set_source_chunked({
    bufferId: "buf-8",
    chunkIndex: 0,
    chunk: "  rv = 1.\n",
  });
  await h.adt_set_source_chunked({
    bufferId: "buf-8",
    chunkIndex: 1,
    chunk: "  RETURN.\n",
    commit: true,
    object: "ZFOO",
    type: "PROG",
    lockHandle: "H",
    acknowledgePartial: true,
  });
  assert.equal(calls.length, 1, "PUT issued when caller acknowledged");
});
