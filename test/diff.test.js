import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedLineDiff } from "../src/diff.js";

test("identical inputs report identical and empty diff", () => {
  const r = unifiedLineDiff("a\nb\nc\n", "a\nb\nc\n");
  assert.equal(r.identical, true);
  assert.equal(r.diff, "");
  assert.deepEqual(r.stats, { added: 0, removed: 0 });
});

test("single-line change shows added and removed lines with context", () => {
  const a = "one\ntwo\nthree\nfour\n";
  const b = "one\ntwo\nTHREE\nfour\n";
  const r = unifiedLineDiff(a, b, { context: 1 });
  assert.equal(r.identical, false);
  assert.equal(r.stats.added, 1);
  assert.equal(r.stats.removed, 1);
  assert.match(r.diff, /^---/m);
  assert.match(r.diff, /^\+\+\+/m);
  assert.match(r.diff, /-three\b/m);
  assert.match(r.diff, /\+THREE\b/m);
});

test("appends are reported as additions only", () => {
  const r = unifiedLineDiff("a\n", "a\nb\n");
  assert.equal(r.stats.added, 1);
  assert.equal(r.stats.removed, 0);
});

test("deletes are reported as removals only", () => {
  const r = unifiedLineDiff("a\nb\n", "a\n");
  assert.equal(r.stats.added, 0);
  assert.equal(r.stats.removed, 1);
});

test("handles empty input on either side", () => {
  const r1 = unifiedLineDiff("", "x\n");
  assert.equal(r1.identical, false);
  assert.equal(r1.stats.added, 1);
  const r2 = unifiedLineDiff("x\n", "");
  assert.equal(r2.identical, false);
  assert.equal(r2.stats.removed, 1);
  const r3 = unifiedLineDiff("", "");
  assert.equal(r3.identical, true);
});

test("uses fromFile and toFile in header", () => {
  const r = unifiedLineDiff("a\n", "b\n", { fromFile: "left", toFile: "right" });
  assert.match(r.diff, /^--- left/m);
  assert.match(r.diff, /^\+\+\+ right/m);
});

test("CRLF and LF inputs are normalised", () => {
  const r = unifiedLineDiff("a\r\nb\r\n", "a\nb\n");
  assert.equal(r.identical, true);
});
