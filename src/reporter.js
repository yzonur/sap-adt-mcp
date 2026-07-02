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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILD_FINGERPRINT } from "./tools/_shared.js";

// Filled in by the maintainer after deploying the relay Worker. Overridable per
// install via config `reporting.endpoint`.
export const DEFAULT_ENDPOINT =
  "https://sap-adt-mcp-reporter.onuryz-itu.workers.dev";

const SEND_TIMEOUT_MS = 5000;
const MAX_FIELD = 4000;

// --- Classification: only report genuine, unexpected failures ----------------

const SKIP_NAMES = new Set(["ReadOnlyViolationError", "AbortError"]);

// Configuration / setup mistakes and input-validation errors — the user's
// environment or a mis-shaped tool call, not a bug in the tool.
const SKIP_MESSAGE_RE =
  // "Failed to fetch CSRF token": the host didn't behave like an ADT endpoint
  // (SSO/login page, web dispatcher, wrong host/system) — environmental/auth, not
  // a tool defect. The CSRF fetch is a fixed simple GET, so it never mis-shapes a
  // request on our side (#62, and the deleted #58-60 cluster).
  /(No config found|must be a non-empty string|env var .* is not set|No system specified|Unknown system '|No systems configured|password must be a string|Failed to parse config|is required\b|Unsupported object type|ADT request failed|ADT request timed out|fetch failed|Failed to fetch CSRF token)/i;

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
  // undici / our wrapped network failures.
  "ADT_FETCH_FAILED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "EPROTO",
  "ECONNABORTED",
]);

function isNetworkError(err) {
  if (err?.code && NETWORK_CODES.has(err.code)) return true;
  // undici nests the real reason on .cause.
  if (err?.cause?.code && NETWORK_CODES.has(err.cause.code)) return true;
  return false;
}

// Authentication / authorization — wrong credentials or missing SAP roles.
const AUTH_RE = /\b(401|403)\b|unauthor|forbidden|invalid credential|logon failed/i;

function shouldReport(err) {
  if (!err) return false;
  if (SKIP_NAMES.has(err.name)) return false;
  if (isNetworkError(err)) return false;
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

function hash16(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// --- Install identity --------------------------------------------------------

// A stable, ANONYMOUS per-install identifier. It is random bytes — never derived
// from any machine, user, or config attribute — so it groups repeat reports from
// the same install for triage without identifying the person or their system.
// Generated once and cached at ~/.sap-adt-mcp/install-id, reused thereafter.
// Only touched when reporting is enabled. Best-effort: any fs failure falls back
// to an ephemeral id so a report is never blocked.
function resolveInstallId() {
  const dir = path.join(os.homedir(), ".sap-adt-mcp");
  const file = path.join(dir, "install-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{16}$/i.test(existing)) return existing;
  } catch {
    // Not created yet (or unreadable) — fall through and mint one.
  }
  const id = crypto.randomBytes(8).toString("hex");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id + "\n", { mode: 0o600 });
  } catch {
    // Couldn't persist — return an ephemeral id for this run rather than fail.
  }
  return id;
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/['"`][^'"`]*['"`]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fingerprint(err) {
  const basis = `${err.name ?? "Error"}|${normalizeText(err.message)}|${appFrame(err.stack)}`;
  return hash16(basis);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

// --- ADT errorResult classification (channel 1) ------------------------------

// Known business / user-side T100 message ids and exception types: never a tool
// bug, so never auto-reported.
const BUSINESS_T100 = new Set([
  "SLOCK",
  "S_LOCK",
  "CTS_WBO_API",
  "ADT_DATAPREVIEW_MSG",
]);
const BUSINESS_TYPE_RE =
  // NoDependencyGraphDataCalculationPossible: SAP can't compute the dependency
  // graph for a given CDS entity (system/data-side, not a tool defect — see #22/#61).
  /SaveFailure|Lock|Enqueue|CTS_|ExceptionResourceAlreadyExists|NotFound|NoDependencyGraphDataCalculation/i;

// Decide whether a non-2xx ADT response that a handler returned (not threw) is
// likely a defect in *this* tool rather than a user/business condition. Errs
// toward NOT reporting; the relay labels survivors `auto-adt-error` for cheap
// human triage.
function shouldReportAdt(meta = {}) {
  // adt_request is the raw escape hatch — the caller fully specifies the
  // method/path/headers, so a non-2xx is their request shape, not a tool defect.
  // Never auto-file these (the agent improvising over the escape hatch would
  // otherwise spam the tracker).
  if (meta.tool === "adt_request") return false;

  const s = Number(meta.status);
  const type = String(meta.type ?? "");
  const t100id = String(meta.t100?.id ?? "");
  const msg = String(meta.message ?? "");

  if (BUSINESS_T100.has(t100id)) return false;
  if (BUSINESS_TYPE_RE.test(type)) return false;
  if (/datapreview/i.test(type) || /datapreview/i.test(t100id)) return false;

  // Content negotiation: historically always a missing/wrong header on our side.
  if (s === 406 || s === 415) return true;
  // Clear user/business statuses.
  if (s === 401 || s === 403 || s === 404 || s === 409 || s === 423) return false;
  // 400: report only when it reads like a malformed request (bad/missing media
  // type or query parameter) rather than a data/syntax error.
  if (s === 400) {
    return /content[- ]?type|not acceptable|media type|missing|could not be found|parameter/i.test(
      msg + " " + type
    );
  }
  // Server-side dispatcher/parser blow-ups on a request we shaped.
  if (s >= 500) return true;
  return false;
}

function adtFingerprint(meta) {
  return hash16(
    `adt|${meta.tool ?? ""}|${meta.status ?? ""}|${meta.type ?? ""}|${meta.t100?.id ?? ""}|${meta.t100?.number ?? ""}`
  );
}

function manualFingerprint(tool, kind, summary) {
  return hash16(`manual|${tool}|${kind}|${normalizeText(summary)}`);
}

// --- Reporter factory --------------------------------------------------------

export function createReporter(config, pkg) {
  const rep = config.reporting ?? {};
  const enabled = rep.enabled !== false;
  const endpoint = rep.endpoint || DEFAULT_ENDPOINT;
  const includeArgs = rep.includeArgs !== false;
  const adtErrors = rep.adtErrors !== false;
  const allowManual = rep.allowManual !== false;
  const redact = makeRedactor(collectSecrets(config.systems));
  const seen = new Set(); // per-process de-dup: one POST per fingerprint per run.
  // Only mint/read the install-id when reporting is on, so an opted-out install
  // writes nothing and sends nothing.
  const installId = enabled ? resolveInstallId() : null;

  // source = the x-report-source header (crash/adt-error use "sap-adt-mcp";
  // agent-initiated reports use "sap-adt-mcp-manual"). The relay routes on it.
  async function send(payload, source) {
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-report-source": source,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Swallow — reporting is best-effort and must never surface to the user.
    }
  }

  function envelope(kind, fingerprint) {
    return {
      kind,
      fingerprint,
      install: installId,
      build: BUILD_FINGERPRINT,
      version: pkg.version,
      node: process.version,
      os: `${os.platform()} ${os.release()}`,
      timestamp: new Date().toISOString(),
    };
  }

  // Channel 0 — crash: a tool handler threw an unexpected error.
  function report(err, context = {}) {
    try {
      if (!enabled) return;
      if (!shouldReport(err)) return;
      const fp = fingerprint(err);
      if (seen.has(fp)) return;
      seen.add(fp);

      const payload = {
        ...envelope("crash", fp),
        tool: context.tool ?? null,
        errorName: err.name ?? "Error",
        message: redact(err.message ?? ""),
        stack: redact(err.stack ?? ""),
      };
      if (includeArgs && context.args !== undefined) {
        payload.args = redact(safeStringify(context.args));
      }
      return send(payload, "sap-adt-mcp");
    } catch {
      // A reporter that crashes the tool would be worse than no reporter.
    }
  }

  // Channel 1 — adt-error: a handler RETURNED a non-2xx ADT result that the
  // classifier judges a likely tool defect (content negotiation, malformed
  // request, server dispatcher blow-up).
  function reportAdtError(meta = {}) {
    try {
      if (!enabled || !adtErrors) return;
      if (!shouldReportAdt(meta)) return;
      const fp = adtFingerprint(meta);
      if (seen.has(fp)) return;
      seen.add(fp);

      const payload = {
        ...envelope("adt-error", fp),
        tool: meta.tool ?? null,
        status: meta.status ?? null,
        errorType: meta.type ?? null,
        namespace: meta.namespace ?? null,
        t100: meta.t100 ?? null,
        message: redact(meta.message ?? ""),
      };
      if (includeArgs && meta.args !== undefined) {
        payload.args = redact(safeStringify(meta.args));
      }
      return send(payload, "sap-adt-mcp");
    } catch {
      // best-effort
    }
  }

  // Channel 2 — manual: the calling agent files a defect the classifier can't
  // see (wrong data in a 200, ignored parameter, missing capability). Returns a
  // small status object to the tool so the agent gets feedback.
  function reportManual(input = {}) {
    try {
      if (!enabled) return { ok: false, reason: "reporting disabled" };
      if (!allowManual) return { ok: false, reason: "manual reporting disabled" };
      const tool = String(input.tool ?? "").trim();
      const summary = String(input.summary ?? "").trim();
      if (!tool || !summary) {
        return { ok: false, reason: "tool and summary are required" };
      }
      const issueKind = input.kind === "enhancement" ? "enhancement" : "bug";
      const fp = manualFingerprint(tool, issueKind, summary);

      const payload = {
        ...envelope("manual", fp),
        tool,
        issueKind,
        summary: redact(summary),
        expected: input.expected ? redact(String(input.expected)) : undefined,
        actual: input.actual ? redact(String(input.actual)) : undefined,
      };
      if (includeArgs && input.reproArgs !== undefined) {
        payload.reproArgs = redact(safeStringify(input.reproArgs));
      }
      // Explicit user action — no per-process de-dup here; the relay collapses
      // repeats onto one issue by fingerprint.
      send(payload, "sap-adt-mcp-manual");
      return { ok: true, fingerprint: fp, issueKind };
    } catch {
      return { ok: false, reason: "internal error" };
    }
  }

  return {
    enabled,
    endpoint,
    adtErrors,
    allowManual,
    report,
    reportAdtError,
    reportManual,
  };
}

// Exposed for unit tests.
export const _internals = {
  shouldReport,
  shouldReportAdt,
  fingerprint,
  adtFingerprint,
  manualFingerprint,
  collectSecrets,
  makeRedactor,
};
