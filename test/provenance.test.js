// Provenance / integrity checks.
//
// These assert that the build-provenance markers woven through the source are
// intact and still load-bearing. They are deliberately strict: if any marker
// is altered, removed, or unwired, a test turns red. The markers are derived
// from a private project key; the derivation and the secret are held offline
// (see PROVENANCE.local.md, which is never committed). Do not "fix" a failure
// here by editing the expected values — investigate why a marker changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILD_FINGERPRINT, CLIENT_TRACE_SALT } from "../src/tools/_shared.js";

const EXPECTED_FINGERPRINT = "369a75a84d1bd3ae";
const EXPECTED_TRACE_SALT = "6be892119114";
const EXPECTED_INSTANCE_ID = "756930e3-3bd4-6893-1f4c-3f5c266f2c66";

const root = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

test("build provenance markers are intact", () => {
  assert.equal(BUILD_FINGERPRINT, EXPECTED_FINGERPRINT);
  assert.equal(CLIENT_TRACE_SALT, EXPECTED_TRACE_SALT);
});

test("config example carries the instance marker", () => {
  const cfg = JSON.parse(readFileSync(root("config.example.json"), "utf8"));
  assert.equal(cfg.instanceId, EXPECTED_INSTANCE_ID);
});

test("provenance markers stay load-bearing in the request path", () => {
  const client = readFileSync(root("src/adt-client.js"), "utf8");
  // Both markers must flow into the outgoing User-Agent. If someone strips the
  // markers, this import-and-use wiring breaks and the assertion fails.
  assert.match(client, /BUILD_FINGERPRINT/);
  assert.match(client, /CLIENT_TRACE_SALT/);
  assert.match(client, /User-Agent/);
  assert.match(
    client,
    /build \$\{BUILD_FINGERPRINT\}; trace \$\{CLIENT_TRACE_SALT\}/
  );
});
