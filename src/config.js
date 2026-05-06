import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CANDIDATE_PATHS = [
  process.env.SAP_ADT_MCP_CONFIG,
  path.join(os.homedir(), ".sap-adt-mcp", "config.json"),
  path.join(process.cwd(), "config.json"),
].filter(Boolean);

export function loadConfig() {
  const configPath = CANDIDATE_PATHS.find((p) => fs.existsSync(p));
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
      host: requireString(profile.host, `${name}.host`),
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
    configPath,
  };
}

function requireString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Config: ${key} must be a non-empty string`);
  }
  return value;
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
