import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCacheConfig } from "./result-cache.js";
import { resolveSecret } from "./secrets.js";

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
    const auth = parseAuth(profile.auth, name);
    const basic = auth.type === "basic";
    systems[name] = {
      host: requireHost(profile.host, name),
      client: profile.client != null ? String(profile.client) : undefined,
      language: profile.language != null ? String(profile.language) : undefined,
      // Certificate / bearer logons don't need a user for the connection
      // itself, but tools still use it as the default TR owner / debug user.
      user:
        basic || profile.user != null
          ? requireString(profile.user, `${name}.user`)
          : undefined,
      password:
        basic || profile.password != null
          ? resolveSecret(profile.password, `System ${name}: password`)
          : undefined,
      auth,
      rejectUnauthorized: profile.rejectUnauthorized !== false,
      readOnly: globalReadOnly || profile.readOnly === true,
      // Debugging another user's session needs debug authorization on the
      // backend; off unless explicitly opted in per system.
      debugAllowRequestUser:
        profile.debug && typeof profile.debug === "object"
          ? profile.debug.allowRequestUser === true
          : false,
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
    cache: parseCacheConfig(raw.cache),
    configPath,
  };
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

// Per-system logon method. Omitted → basic auth with user/password.
//   { "type": "certificate", "pfx": "/path/client.p12", "passphrase": "keychain:DEV" }
//   { "type": "certificate", "cert": "/path/c.pem", "key": "/path/k.pem", "ca": "/path/ca.pem" }
//   { "type": "bearer", "token": "env:SAP_TOKEN" }
// Certificate material is read at load so a wrong path fails here, not mid-call.
function parseAuth(raw, systemName) {
  if (raw == null) return { type: "basic" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config: ${systemName}.auth must be an object`);
  }
  const type = String(raw.type ?? "basic").toLowerCase();
  if (type === "basic") return { type: "basic" };
  if (type === "bearer") {
    return {
      type: "bearer",
      token: resolveSecret(
        requireString(raw.token, `${systemName}.auth.token`),
        `System ${systemName}: auth.token`
      ),
    };
  }
  if (type === "certificate") {
    const readFile = (key) => {
      const p = requireString(raw[key], `${systemName}.auth.${key}`);
      try {
        return fs.readFileSync(expandHome(p));
      } catch (err) {
        throw new Error(
          `Config: ${systemName}.auth.${key}: cannot read ${p} (${err.code ?? err.message})`,
          { cause: err }
        );
      }
    };
    const out = { type: "certificate" };
    if (raw.pfx != null) {
      out.pfx = readFile("pfx");
    } else if (raw.cert != null && raw.key != null) {
      out.cert = readFile("cert");
      out.key = readFile("key");
    } else {
      throw new Error(
        `Config: ${systemName}.auth (certificate) needs "pfx", or both "cert" and "key".`
      );
    }
    if (raw.ca != null) out.ca = readFile("ca");
    if (raw.passphrase != null) {
      out.passphrase = resolveSecret(raw.passphrase, `System ${systemName}: auth.passphrase`);
    }
    return out;
  }
  throw new Error(
    `Config: ${systemName}.auth.type must be "basic", "certificate" or "bearer" (got "${raw.type}").`
  );
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
