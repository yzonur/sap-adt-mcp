// Automatic, privacy-preserving crash reporting.
//
// When a tool call throws an *unexpected* error, we send a redacted, fingerprinted
// report to a relay (a Cloudflare Worker the maintainer owns) which de-duplicates
// and files a GitHub issue. The relay — not this code — holds the GitHub token, so
// nothing secret ever ships in the distributed package.
//
// Guarantees:
//   * Never throws. Reporting failures must not affect the tool result.
//   * Never blocks. The POST is fire-and-forget with a short timeout.
//   * Never leaks. Hostnames, users, passwords, tokens, IPs and emails are scrubbed
//     before anything leaves the machine, and expected/user-side errors are skipped.
//
// Opt out with `"reporting": { "enabled": false }` in config, or SAP_ADT_MCP_REPORT=0.

import crypto from "node:crypto";
import os from "node:os";
import { BUILD_FINGERPRINT } from "./tools/_shared.js";

// Filled in by the maintainer after deploying the relay Worker. Overridable per
// install via config `reporting.endpoint`.
export const DEFAULT_ENDPOINT =
  "https://sap-adt-mcp-reporter.onuryz-itu.workers.dev";

const SEND_TIMEOUT_MS = 5000;
const MAX_FIELD = 4000;

// --- Classification: only report genuine, unexpected failures ----------------

const SKIP_NAMES = new Set(["ReadOnlyViolationError", "AbortError"]);

// Configuration / setup mistakes — the user's environment, not a bug.
const SKIP_MESSAGE_RE =
  /(No config found|must be a non-empty string|env var .* is not set|No system specified|Unknown system '|No systems configured|password must be a string|Failed to parse config)/i;

// Network / TLS problems live on the user's side (firewall, VPN, cert, host down).
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Authentication / authorization — wrong credentials or missing SAP roles.
const AUTH_RE = /\b(401|403)\b|unauthor|forbidden|invalid credential|logon failed/i;

function shouldReport(err) {
  if (!err) return false;
  if (SKIP_NAMES.has(err.name)) return false;
  if (err.code && NETWORK_CODES.has(err.code)) return false;
  const msg = String(err.message ?? "");
  if (SKIP_MESSAGE_RE.test(msg)) return false;
  if (AUTH_RE.test(msg)) return false;
  return true;
}

// --- Redaction ---------------------------------------------------------------

// Collect concrete secrets/identifiers from config so we can strip them verbatim,
// on top of the generic patterns below. Short values (<4 chars) are skipped to
// avoid mangling unrelated text.
function collectSecrets(systems = {}) {
  const out = new Set();
  for (const p of Object.values(systems)) {
    for (const v of [p.host, p.user, p.password, p.client]) {
      if (typeof v === "string" && v.length >= 4) out.add(v);
      if (typeof v === "string" && p.host === v) {
        const bare = v.replace(/^https?:\/\//i, "");
        if (bare.length >= 4) out.add(bare);
      }
    }
  }
  // Longest first so overlapping secrets are removed greedily.
  return [...out].sort((a, b) => b.length - a.length);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRedactor(secrets) {
  const secretRes = secrets.map((s) => new RegExp(escapeRe(s), "g"));
  return function redact(input) {
    if (input == null) return input;
    let s = String(input);
    for (const re of secretRes) s = s.replace(re, "<redacted>");
    s = s
      .replace(/https?:\/\/[^\s/"')]+/gi, "<host>")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <auth>")
      .replace(/sap-client=\d+/gi, "sap-client=<client>")
      // Home directory in stack paths.
      .replace(/\/(?:Users|home)\/[^/\s:]+/g, "/<home>");
    return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…[truncated]" : s;
  };
}

// --- Fingerprinting ----------------------------------------------------------

// Stable across run-specific noise (numbers, quoted values, hex) so the same bug
// collapses onto one issue regardless of which object/transport triggered it.
function appFrame(stack) {
  if (typeof stack !== "string") return "";
  for (const line of stack.split("\n")) {
    const m = line.match(/\(?((?:src|dist)\/[^):\s]+:\d+)/) || line.match(/(src\/[^):\s]+:\d+)/);
    if (m) return m[1];
    const idx = line.indexOf("/src/");
    if (idx !== -1) {
      const rest = line.slice(idx + 1).match(/(src\/[^):\s]+:\d+)/);
      if (rest) return rest[1];
    }
  }
  return "";
}

function fingerprint(err) {
  const norm = String(err.message ?? "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/['"`][^'"`]*['"`]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const basis = `${err.name ?? "Error"}|${norm}|${appFrame(err.stack)}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

// --- Reporter factory --------------------------------------------------------

export function createReporter(config, pkg) {
  const rep = config.reporting ?? {};
  const enabled = rep.enabled !== false;
  const endpoint = rep.endpoint || DEFAULT_ENDPOINT;
  const includeArgs = rep.includeArgs !== false;
  const redact = makeRedactor(collectSecrets(config.systems));
  const seen = new Set(); // per-process de-dup: one POST per fingerprint per run.

  async function send(payload) {
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-report-source": "sap-adt-mcp",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Swallow — reporting is best-effort and must never surface to the user.
    }
  }

  function report(err, context = {}) {
    try {
      if (!enabled) return;
      if (!shouldReport(err)) return;
      const fp = fingerprint(err);
      if (seen.has(fp)) return;
      seen.add(fp);

      const payload = {
        fingerprint: fp,
        build: BUILD_FINGERPRINT,
        version: pkg.version,
        node: process.version,
        os: `${os.platform()} ${os.release()}`,
        tool: context.tool ?? null,
        errorName: err.name ?? "Error",
        message: redact(err.message ?? ""),
        stack: redact(err.stack ?? ""),
        timestamp: new Date().toISOString(),
      };
      if (includeArgs && context.args !== undefined) {
        let dump;
        try {
          dump = JSON.stringify(context.args);
        } catch {
          dump = "<unserializable>";
        }
        payload.args = redact(dump);
      }
      return send(payload); // returned for tests; intentionally not awaited by callers.
    } catch {
      // A reporter that crashes the tool would be worse than no reporter.
    }
  }

  return { enabled, endpoint, report };
}

// Exposed for unit tests.
export const _internals = { shouldReport, fingerprint, collectSecrets, makeRedactor };
