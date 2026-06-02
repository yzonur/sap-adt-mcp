import { test } from "node:test";
import assert from "node:assert/strict";

import * as connection from "../src/tools/connection.js";
import * as source from "../src/tools/source.js";
import * as quality from "../src/tools/quality.js";
import * as lifecycle from "../src/tools/lifecycle.js";
import * as discovery from "../src/tools/discovery.js";
import * as crossSystem from "../src/tools/cross-system.js";
import * as transports from "../src/tools/transports.js";
import * as runtime from "../src/tools/runtime.js";
import * as data from "../src/tools/data.js";
import * as request from "../src/tools/request.js";
import * as versions from "../src/tools/versions.js";
import * as notes from "../src/tools/notes.js";
import * as cds from "../src/tools/cds.js";
import * as worklist from "../src/tools/worklist.js";
import * as jobs from "../src/tools/jobs.js";
import * as rap from "../src/tools/rap.js";

const MODULES = {
  connection,
  source,
  quality,
  lifecycle,
  discovery,
  "cross-system": crossSystem,
  transports,
  runtime,
  data,
  request,
  versions,
  notes,
  cds,
  worklist,
  jobs,
  rap,
};

const fakeCtx = {
  getClient: () => {
    throw new Error("not used in shape test");
  },
  config: { systems: {}, defaultSystem: null },
};

test("every tool module exports a tools array with proper shape", () => {
  for (const [modName, mod] of Object.entries(MODULES)) {
    assert.ok(Array.isArray(mod.tools), `${modName}.tools should be an array`);
    assert.ok(mod.tools.length > 0, `${modName}.tools should not be empty`);
    for (const t of mod.tools) {
      assert.equal(typeof t.name, "string", `${modName}: tool needs name`);
      assert.match(t.name, /^adt_/, `${modName}: name ${t.name} must start with adt_`);
      assert.equal(typeof t.description, "string");
      assert.equal(typeof t.inputSchema, "object");
      assert.equal(t.inputSchema.type, "object");
    }
  }
});

test("every tool module's register() returns handlers matching its tools", () => {
  for (const [modName, mod] of Object.entries(MODULES)) {
    const handlers = mod.register(fakeCtx);
    const handlerNames = Object.keys(handlers).sort();
    const toolNames = mod.tools.map((t) => t.name).sort();
    assert.deepEqual(
      handlerNames,
      toolNames,
      `${modName}: handlers and tools must match exactly`
    );
    for (const fn of Object.values(handlers)) {
      assert.equal(typeof fn, "function");
    }
  }
});

test("no tool name is registered in two modules", () => {
  const seen = new Map();
  for (const [modName, mod] of Object.entries(MODULES)) {
    for (const t of mod.tools) {
      assert.equal(
        seen.has(t.name),
        false,
        `${t.name} declared in both ${seen.get(t.name)} and ${modName}`
      );
      seen.set(t.name, modName);
    }
  }
});

test("expected new tools exist", () => {
  const allNames = new Set();
  for (const mod of Object.values(MODULES)) {
    for (const t of mod.tools) allNames.add(t.name);
  }
  for (const name of [
    "adt_list_dumps",
    "adt_get_dump",
    "adt_read_table",
    "adt_grep_source",
    "adt_list_versions",
    "adt_compare_versions",
    "adt_run_atc_package",
    "adt_run_atc_transport",
    "adt_get_note",
    "adt_check_note_status",
    "adt_implement_note",
    "adt_cds_data_preview",
    "adt_cds_dependencies",
    "adt_list_released_apis",
    "adt_list_inactive_objects",
    "adt_list_locks",
    "adt_schedule_job",
    "adt_read_spool",
    "adt_rap_scaffold",
  ]) {
    assert.ok(allNames.has(name), `${name} should be registered`);
  }
});
