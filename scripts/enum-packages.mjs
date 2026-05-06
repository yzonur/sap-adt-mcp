// Recursively enumerate subpackages of a given root package and emit a compact JSON digest.
// Usage:
//   node scripts/enum-packages.mjs <root-package> [out-file] [--system <name>] [--prefix <namespace>]
// Examples:
//   node scripts/enum-packages.mjs ZLOCAL
//   node scripts/enum-packages.mjs /MYNS/MAIN out.json --system QAS --prefix /MYNS/

import { loadConfig } from "../src/config.js";
import { AdtClient } from "../src/adt-client.js";
import { fetchPackageNodes } from "../src/node-structure.js";
import fs from "node:fs";

const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--system") flags.system = argv[++i];
  else if (a === "--prefix") flags.prefix = argv[++i];
  else positional.push(a);
}

const root = positional[0];
const outFile = positional[1] ?? "packages-digest.json";
if (!root) {
  console.error(
    "Usage: node scripts/enum-packages.mjs <root-package> [out-file] [--system <name>] [--prefix <ns>]"
  );
  process.exit(1);
}

const descendPrefix =
  flags.prefix ??
  (root.startsWith("/")
    ? root.slice(0, root.indexOf("/", 1) + 1)
    : root[0] ?? "");

const cfg = loadConfig();
const systemName = flags.system ?? cfg.defaultSystem;
const profile = cfg.systems[systemName];
if (!profile) {
  console.error(
    `Unknown system '${systemName}'. Available: ${Object.keys(cfg.systems).join(", ")}`
  );
  process.exit(1);
}
const client = new AdtClient(profile);

const visited = new Set();
const digest = {};

async function walk(pkg) {
  if (visited.has(pkg)) return;
  visited.add(pkg);
  const r = await fetchPackageNodes(client, pkg);
  if (!r.ok) return;
  digest[pkg] = r.nodes;
  for (const n of r.nodes) {
    if (n.type === "DEVC/K" && n.name.startsWith(descendPrefix)) {
      await walk(n.name);
    }
  }
}

await walk(root);

const summary = { system: systemName, root, packages: {} };
for (const [pkg, items] of Object.entries(digest)) {
  const byType = {};
  for (const it of items) {
    (byType[it.type] = byType[it.type] || []).push({
      name: it.name,
      desc: it.description,
    });
  }
  summary.packages[pkg] = {
    counts: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, v.length])
    ),
    items: byType,
  };
}

fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log("Packages:", Object.keys(digest).length);
console.log("Total objects:", Object.values(digest).flat().length);
console.log(`Written to ${outFile}`);
