import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../src/config.js";

function withConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sap-adt-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  const prev = process.env.SAP_ADT_MCP_CONFIG;
  process.env.SAP_ADT_MCP_CONFIG = path;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SAP_ADT_MCP_CONFIG;
    else process.env.SAP_ADT_MCP_CONFIG = prev;
  }
}

const sys = (host) => ({
  systems: { E4D: { host, user: "U", password: "x" } },
});

test("loadConfig: accepts a host with an https scheme", () => {
  withConfig(sys("https://sap.example.com:44300"), () => {
    const cfg = loadConfig();
    assert.equal(cfg.systems.E4D.host, "https://sap.example.com:44300");
  });
});

test("loadConfig: rejects a bare hostname without a scheme (#41-48 root cause)", () => {
  withConfig(sys("sap.example.com"), () => {
    assert.throws(() => loadConfig(), /host must be a full URL including scheme/);
  });
});

test("loadConfig: rejects host:port read as a bogus scheme", () => {
  // new URL("sap.example.com:44300") parses with protocol "sap.example.com:".
  withConfig(sys("sap.example.com:44300"), () => {
    assert.throws(() => loadConfig(), /host must use http:\/\/ or https:\/\//);
  });
});

test("loadConfig: rejects a non-http scheme", () => {
  withConfig(sys("ftp://sap.example.com"), () => {
    assert.throws(() => loadConfig(), /host must use http:\/\/ or https:\/\//);
  });
});

test("loadConfig: rejects a degenerate host like '0'", () => {
  withConfig(sys("0"), () => {
    assert.throws(() => loadConfig(), /host must be a full URL including scheme/);
  });
});

function withReportEnv(value, fn) {
  const prev = process.env.SAP_ADT_MCP_REPORT;
  if (value === undefined) delete process.env.SAP_ADT_MCP_REPORT;
  else process.env.SAP_ADT_MCP_REPORT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SAP_ADT_MCP_REPORT;
    else process.env.SAP_ADT_MCP_REPORT = prev;
  }
}

test("loadConfig: reporting is off and args excluded when not configured (opt-in)", () => {
  withReportEnv(undefined, () => {
    withConfig(sys("https://sap.example.com"), () => {
      const { reporting } = loadConfig();
      assert.equal(reporting.enabled, false);
      assert.equal(reporting.includeArgs, false);
    });
  });
});

test("loadConfig: reporting.enabled true opts in; includeArgs stays off unless set", () => {
  withReportEnv(undefined, () => {
    withConfig({ ...sys("https://sap.example.com"), reporting: { enabled: true } }, () => {
      const { reporting } = loadConfig();
      assert.equal(reporting.enabled, true);
      assert.equal(reporting.includeArgs, false);
    });
    withConfig(
      { ...sys("https://sap.example.com"), reporting: { enabled: true, includeArgs: true } },
      () => assert.equal(loadConfig().reporting.includeArgs, true)
    );
  });
});

test("loadConfig: SAP_ADT_MCP_REPORT overrides the config in both directions", () => {
  withConfig(sys("https://sap.example.com"), () => {
    withReportEnv("1", () => assert.equal(loadConfig().reporting.enabled, true));
    withReportEnv("on", () => assert.equal(loadConfig().reporting.enabled, true));
  });
  withConfig({ ...sys("https://sap.example.com"), reporting: { enabled: true } }, () => {
    withReportEnv("0", () => assert.equal(loadConfig().reporting.enabled, false));
  });
});
