// Unit tests for the MCP prompts module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listPrompts, getPrompt } from "../src/prompts.js";

const EXPECTED_PROMPTS = [
  "clean_core_grade",
  "clean_core_review",
  "clean_core_refactor",
  "clean_core_create",
  "clean_core_design",
];

test("listPrompts returns all five Clean Core prompts in shape", () => {
  const list = listPrompts();
  assert.equal(list.length, EXPECTED_PROMPTS.length);
  for (const expected of EXPECTED_PROMPTS) {
    const p = list.find((x) => x.name === expected);
    assert.ok(p, `prompt ${expected} not present`);
    assert.ok(p.description && p.description.length > 0);
    assert.ok(Array.isArray(p.arguments));
  }
});

test("getPrompt returns user message with interpolated arguments", () => {
  const r = getPrompt("clean_core_grade", {
    object: "ZCL_TEST",
    type: "class",
    system: "DEV",
  });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "user");
  const text = r.messages[0].content.text;
  assert.match(text, /Object: ZCL_TEST/);
  assert.match(text, /Type: class/);
  assert.match(text, /System: DEV/);
});

test("getPrompt fills <default> when optional system omitted", () => {
  const r = getPrompt("clean_core_grade", {
    object: "ZCL_TEST",
    type: "class",
  });
  assert.match(r.messages[0].content.text, /System: <default>/);
});

test("getPrompt rejects missing required argument", () => {
  // grade requires both 'object' and 'type'
  assert.throws(
    () => getPrompt("clean_core_grade", { object: "ZX" }),
    /missing required argument 'type'/
  );
  assert.throws(
    () => getPrompt("clean_core_grade", { type: "class" }),
    /missing required argument 'object'/
  );
});

test("getPrompt rejects empty-string required argument", () => {
  assert.throws(
    () => getPrompt("clean_core_grade", { object: "", type: "class" }),
    /missing required argument 'object'/
  );
});

test("getPrompt rejects unknown prompt name", () => {
  assert.throws(() => getPrompt("not_a_prompt", {}), /Unknown prompt/);
});

test("clean_core_review caps maxObjects with default 50 when omitted", () => {
  const r = getPrompt("clean_core_review", { package: "Z_X" });
  assert.match(r.messages[0].content.text, /Object cap: 50/);
});

test("clean_core_review uses caller-supplied maxObjects", () => {
  const r = getPrompt("clean_core_review", {
    package: "Z_X",
    maxObjects: "200",
  });
  assert.match(r.messages[0].content.text, /Object cap: 200/);
});

test("mode-loading prompts work with no args (refactor / create / design)", () => {
  for (const name of [
    "clean_core_refactor",
    "clean_core_create",
    "clean_core_design",
  ]) {
    const r = getPrompt(name, {});
    assert.equal(r.messages.length, 1);
    assert.ok(r.messages[0].content.text.length > 100);
  }
});

test("clean_core_refactor with object pre-seeds the conversation", () => {
  const r = getPrompt("clean_core_refactor", {
    object: "ZCL_OLD",
    type: "class",
    system: "DEV",
  });
  assert.match(r.messages[0].content.text, /Start with: ZCL_OLD/);
});

test("clean_core_refactor without object asks the user to point at one", () => {
  const r = getPrompt("clean_core_refactor", {});
  assert.match(
    r.messages[0].content.text,
    /Wait for the user to point you at an object/
  );
});

test("every prompt body includes the S/4HANA applicability guard", () => {
  for (const name of EXPECTED_PROMPTS) {
    // Use minimum valid args.
    const args =
      name === "clean_core_grade"
        ? { object: "ZX", type: "class" }
        : name === "clean_core_review"
        ? { package: "ZX" }
        : {};
    const text = getPrompt(name, args).messages[0].content.text;
    assert.match(
      text,
      /Clean Core is an SAP S\/4HANA discipline/,
      `prompt ${name} missing applicability guard`
    );
    assert.match(
      text,
      /ECC/,
      `prompt ${name} should mention ECC`
    );
  }
});
