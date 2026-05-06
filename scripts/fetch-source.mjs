// Fetch ABAP source of an object and save to file
// Usage: node scripts/fetch-source.mjs <adt-path> <out-file>
import { loadConfig } from "../src/config.js";
import { AdtClient } from "../src/adt-client.js";
import fs from "node:fs";

const [, , adtPath, outFile] = process.argv;
if (!adtPath || !outFile) {
  console.error("Usage: node scripts/fetch-source.mjs <adt-path> <out-file>");
  process.exit(1);
}

const cfg = loadConfig();
const client = new AdtClient(cfg.systems[cfg.defaultSystem]);

const res = await client.request({ path: adtPath, accept: "text/plain" });
if (!res.ok) {
  console.error("HTTP", res.status);
  process.exit(2);
}
const text = await res.text();
fs.writeFileSync(outFile, text);
const lines = text.split(/\r?\n/).length;
console.log(`Wrote ${outFile} — ${text.length} bytes, ${lines} lines`);
