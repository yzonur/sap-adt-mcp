import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Resolved at call time (not import time) so SAP_ADT_MCP_CONFIG is honoured
// whenever loadConfig runs, not just whatever it was when this module loaded.
function candidatePaths() {
  return [
    process.env.SAP_ADT_MCP_CONFIG,
    path.join(os.homedir(), ".sap-adt-mcp", "config.json"),
    path.join(process.cwd(), "config.json"),
  ].filter(Boolean);
}

export function loadConfig() {
  const configPath = candidatePaths().find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error(
      "No config found. Set SAP_ADT_MCP_CONFIG or create ~/.sap-adt-mcp/config.json " +
        "(see config.example.json)."
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse config at ${configPath}: ${err.message}`, {
      cause: err,
    });
  }

  const globalReadOnly = raw.readOnly === true;

  const systems = {};
  for (const [name, profile] of Object.entries(raw.systems ?? {})) {
    systems[name] = {
      host: requireHost(profile.host, name),
      client: profile.client != null ? String(profile.client) : undefined,
      language: profile.language != null ? String(profile.language) : undefined,
      user: requireString(profile.user, `${name}.user`),
      password: resolveSecret(profile.password, name),
      rejectUnauthorized: profile.rejectUnauthorized !== false,
      readOnly: globalReadOnly || profile.readOnly === true,
    };
  }

  if (Object.keys(systems).length === 0) {
    throw new Error(`No systems configured in ${configPath}`);
  }

  return {
    defaultSystem: raw.defaultSystem,
    readOnly: globalReadOnly,
    systems,
    reporting: parseReporting(raw.reporting),
    audit: parseAudit(raw.audit),
    panel: parsePanel(raw.panel),
    configPath,
  };
}

// Local read-only HTTP control panel. OFF by default — it opens a listening
// socket, which an stdio MCP otherwise never does. Enable via config or env.
//   "panel": { "enabled": true, "port": 0 }   (port 0 = random free port)
//   SAP_ADT_MCP_PANEL=1            (also accepts true/yes/on; 0/false/no/off forces off)
//   SAP_ADT_MCP_PANEL_PORT=39555  (overrides config port)
// The panel lives inside the MCP process: it is reachable only while this
// Claude session keeps the MCP connected, and dies the moment the process exits.
// It is bound to 127.0.0.1 and gated by a per-boot random token.
function parsePanel(raw) {
  const envVal = String(process.env.SAP_ADT_MCP_PANEL ?? "").toLowerCase();
  const envOn = ["1", "true", "yes", "on"].includes(envVal);
  const envOff = ["0", "false", "no", "off"].includes(envVal);
  const r = raw && typeof raw === "object" ? raw : {};
  const enabled = envOn ? true : envOff ? false : r.enabled === true;

  const envPort = Number.parseInt(process.env.SAP_ADT_MCP_PANEL_PORT ?? "", 10);
  const port = Number.isInteger(envPort)
    ? envPort
    : Number.isInteger(r.port)
      ? r.port
      : 0; // 0 → OS picks a free port

  return { enabled, port, host: "127.0.0.1" };
}

// Local write-audit trail (JSONL). On by default; disable via config or env.
//   "audit": { "enabled": false, "path": "/custom/audit.log" }
//   SAP_ADT_MCP_AUDIT=0   (also accepts false/no/off)
function parseAudit(raw) {
  const envVal = String(process.env.SAP_ADT_MCP_AUDIT ?? "").toLowerCase();
  const envOff = ["0", "false", "no", "off"].includes(envVal);
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: envOff ? false : r.enabled !== false,
    path:
      typeof r.path === "string" && r.path
        ? r.path
        : path.join(os.homedir(), ".sap-adt-mcp", "audit.log"),
  };
}

// Automatic crash reporting. On by default; disable via config or env.
//   "reporting": { "enabled": false, "endpoint": "...", "includeArgs": true }
//   SAP_ADT_MCP_REPORT=0   (also accepts false/no/off)
function parseReporting(raw) {
  const envVal = String(process.env.SAP_ADT_MCP_REPORT ?? "").toLowerCase();
  const envOff = ["0", "false", "no", "off"].includes(envVal);
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: envOff ? false : r.enabled !== false,
    endpoint: typeof r.endpoint === "string" && r.endpoint ? r.endpoint : null,
    includeArgs: r.includeArgs !== false,
    // Channel 1: auto-report selected non-2xx ADT results (406/415/malformed).
    adtErrors: r.adtErrors !== false,
    // Channel 2: allow the adt_report_issue tool to file agent-initiated reports.
    allowManual: r.allowManual !== false,
  };
}

function requireString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Config: ${key} must be a non-empty string`);
  }
  return value;
}

// A host without an http(s):// scheme (or an otherwise unparseable one) makes
// every request throw the cryptic "ADT path is not a valid URL component" at
// call time — once per tool call, far from the real cause. Validate the scheme
// up front so a bad config fails loudly at load with an actionable message.
function requireHost(value, systemName) {
  const host = requireString(value, `${systemName}.host`);
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error(
      `Config: ${systemName}.host must be a full URL including scheme, ` +
        `e.g. "https://sap.example.com:44300" (got "${host}").`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Config: ${systemName}.host must use http:// or https:// (got "${url.protocol}//" in "${host}").`
    );
  }
  return host;
}

function resolveSecret(value, systemName) {
  if (typeof value !== "string") {
    throw new Error(`System ${systemName}: password must be a string`);
  }
  if (value.startsWith("env:")) {
    const varName = value.slice(4);
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(
        `System ${systemName}: env var ${varName} is not set`
      );
    }
    return resolved;
  }
  return value;
}
