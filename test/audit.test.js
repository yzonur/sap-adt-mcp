import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAuditLog, toolContext } from "../src/audit.js";
import { AdtClient, ReadOnlyViolationError } from "../src/adt-client.js";

function tmpFile() {
  return path.join(
    os.tmpdir(),
    `sap-adt-mcp-audit-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    "audit.log"
  );
}

test("createAuditLog appends JSONL entries with timestamp and tool context", () => {
  const file = tmpFile();
  const audit = createAuditLog({ audit: { enabled: true, path: file } });
  assert.equal(audit.enabled, true);

  toolContext.run({ tool: "adt_set_source" }, () => {
    audit.record({ method: "PUT", path: "/sap/bc/adt/programs/programs/ztest/source/main", status: 200, ok: true });
  });
  audit.record({ method: "POST", path: "/sap/bc/adt/cts/transportrequests", status: 201, ok: true });

  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, "adt_set_source");
  assert.equal(lines[0].method, "PUT");
  assert.ok(lines[0].ts);
  assert.equal(lines[1].tool, undefined); // outside toolContext
  assert.equal(lines[1].status, 201);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("createAuditLog with enabled=false writes nothing", () => {
  const file = tmpFile();
  const audit = createAuditLog({ audit: { enabled: false, path: file } });
  audit.record({ method: "PUT", path: "/x" });
  assert.equal(fs.existsSync(file), false);
});

// --- AdtClient integration over a real local HTTP server ---------------------

function startStubServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/sap/bc/adt/discovery")) {
      res.setHeader("x-csrf-token", "test-token");
      res.writeHead(200);
      res.end("<service/>");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function profileFor(server, extra = {}) {
  const { port } = server.address();
  return {
    host: `http://127.0.0.1:${port}`,
    user: "AUDITUSER",
    password: "x",
    rejectUnauthorized: true,
    readOnly: false,
    ...extra,
  };
}

test("AdtClient audits writes (with transport) but not reads or read-only POST queries", async () => {
  const server = await startStubServer();
  try {
    const entries = [];
    const client = new AdtClient(profileFor(server), { audit: (e) => entries.push(e) });

    // Read — not audited.
    await client.request({ path: "/sap/bc/adt/programs/programs/ztest" });
    // Whitelisted read-only POST (checkruns) — a query, not audited.
    await client.request({ method: "POST", path: "/sap/bc/adt/checkruns", body: "<x/>" });
    // Genuine write with a transport — audited.
    await client.request({
      method: "PUT",
      path: "/sap/bc/adt/programs/programs/ztest/source/main",
      query: { lockHandle: "h1", corrNr: "E4DK900123" },
      body: "REPORT ztest.",
    });

    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.method, "PUT");
    assert.equal(e.path, "/sap/bc/adt/programs/programs/ztest/source/main");
    assert.equal(e.status, 200);
    assert.equal(e.ok, true);
    assert.equal(e.transport, "E4DK900123");
    assert.equal(e.sapUser, "AUDITUSER");
    assert.match(e.host, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    server.close();
  }
});

test("AdtClient audits blocked read-only violations", async () => {
  const server = await startStubServer();
  try {
    const entries = [];
    const client = new AdtClient(profileFor(server, { readOnly: true }), {
      audit: (e) => entries.push(e),
    });

    await assert.rejects(
      () => client.request({ method: "PUT", path: "/sap/bc/adt/programs/programs/ztest/source/main", body: "x" }),
      ReadOnlyViolationError
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "blocked-read-only");
    assert.equal(entries[0].method, "PUT");
  } finally {
    server.close();
  }
});

test("a throwing audit hook never breaks the request", async () => {
  const server = await startStubServer();
  try {
    const client = new AdtClient(profileFor(server), {
      audit: () => {
        throw new Error("audit exploded");
      },
    });
    const res = await client.request({
      method: "PUT",
      path: "/sap/bc/adt/programs/programs/ztest/source/main",
      body: "x",
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
