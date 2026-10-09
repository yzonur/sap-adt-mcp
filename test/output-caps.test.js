import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../src/tools/discovery.js";
import { response, ctxFor, parse } from "./helpers/fake-adt.js";

function nodesXml(nodes) {
  return (
    "<DATA><TREE_CONTENT>" +
    nodes
      .map(
        (n) =>
          `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>${n.type}</OBJECT_TYPE><OBJECT_NAME>${n.name}</OBJECT_NAME><DESCRIPTION>d</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>`
      )
      .join("") +
    "</TREE_CONTENT></DATA>"
  );
}

const many = (prefix, n, type = "CLAS/OC") =>
  Array.from({ length: n }, (_, i) => ({ type, name: `${prefix}${String(i).padStart(4, "0")}` }));

// Fake client answering nodestructure POSTs from a package → nodes map.
function treeClient(tree) {
  return {
    request: async ({ path }) => {
      const pkg = new URLSearchParams(path.split("?")[1]).get("parent_name");
      return response(200, nodesXml(tree[pkg] ?? []));
    },
  };
}

test("adt_browse_package: past the soft cap returns the first 500 + counts; full returns all", async () => {
  const tree = { ZBIG: [...many("ZCL_", 600), ...many("ZPROG_", 20, "PROG/P")] };
  const h = register(ctxFor({ E4D: treeClient(tree) }));

  const capped = parse(await h.adt_browse_package({ package: "zbig" }));
  assert.equal(capped.total, 620);
  assert.equal(capped.entries.length, 500);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.counts, { "CLAS/OC": 600, "PROG/P": 20 });
  assert.match(capped.hint, /full: true/);

  const full = parse(await h.adt_browse_package({ package: "ZBIG", full: true }));
  assert.equal(full.entries.length, 620);
  assert.equal(full.truncated, undefined);
});

test("adt_browse_package: a small package is unchanged apart from counts", async () => {
  const h = register(ctxFor({ E4D: treeClient({ ZSMALL: many("ZCL_", 3) }) }));
  const out = parse(await h.adt_browse_package({ package: "ZSMALL" }));
  assert.equal(out.entries.length, 3);
  assert.equal(out.truncated, undefined);
  assert.deepEqual(out.counts, { "CLAS/OC": 3 });
});

test("adt_list_packages: totals always; entries dropped past the soft cap unless full", async () => {
  const tree = {
    ZROOT: [{ type: "DEVC/K", name: "ZROOT_A" }, { type: "DEVC/K", name: "ZROOT_B" }, ...many("ZCL_R", 10)],
    ZROOT_A: many("ZCL_A", 300),
    ZROOT_B: many("ZPROG_B", 300, "PROG/P"),
  };
  const h = register(ctxFor({ E4D: treeClient(tree) }));

  const capped = parse(await h.adt_list_packages({ root: "ZROOT" }));
  assert.equal(capped.packagesVisited, 3);
  assert.equal(capped.totalObjects, 612);
  assert.deepEqual(capped.totals, { "DEVC/K": 2, "CLAS/OC": 310, "PROG/P": 300 });
  assert.equal(capped.entriesOmitted, true);
  assert.equal(capped.packages.ZROOT_A.entries, undefined);
  assert.equal(capped.packages.ZROOT_A.counts["CLAS/OC"], 300);

  const full = parse(await h.adt_list_packages({ root: "ZROOT", full: true }));
  assert.equal(full.entriesOmitted, undefined);
  assert.equal(full.packages.ZROOT_A.entries["CLAS/OC"].length, 300);
});

test("adt_list_packages: a small tree keeps its entries", async () => {
  const h = register(ctxFor({ E4D: treeClient({ ZS: many("ZCL_", 4) }) }));
  const out = parse(await h.adt_list_packages({ root: "ZS" }));
  assert.equal(out.totalObjects, 4);
  assert.equal(out.packages.ZS.entries["CLAS/OC"].length, 4);
});
