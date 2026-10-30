// Package and table access policy, enforced inside AdtClient.request so every
// tool — including the raw adt_request escape hatch — goes through it.
//
//   allowedPackages      every write must be attributable to one of these
//                        packages (fail-closed). Absent = no restriction.
//   blockedTables        Data Preview may not read these tables / views
//                        (added to DEFAULT_BLOCKED_TABLES).
//   allowDataPreview     false blocks every /datapreview/ request.
//
// Patterns are case-insensitive; `*` matches any run of characters and `?`
// exactly one, e.g. "Z*", "$TMP", "/ACME/*", "PA????".

export class AccessPolicyViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessPolicyViolationError";
    this.code = "ACCESS_POLICY";
  }
}

// Tables no agent should pull rows from by default: logon data and password
// hashes, RFC destinations (stored credentials), the PSE store, and HR master
// data / payroll clusters (salary, bank details, family, health).
export const DEFAULT_BLOCKED_TABLES = [
  "USR02",
  "USH02",
  "USRPWDHISTORY",
  "RFCDES",
  "SSF_PSE_D",
  "PA????", // HR master data infotypes (PA0008 basic pay, PA0009 bank details…)
  "PB????", // applicant infotypes
  "PCL1",
  "PCL2", // payroll results
  "PCL3",
  "PCL4",
  "PCL5",
];

const DATA_PREVIEW_PREFIX = "/sap/bc/adt/datapreview/";
const TRANSPORT_PREFIX = "/sap/bc/adt/cts/";
const ACTIVATION_PATH = "/sap/bc/adt/activation";

export function compilePattern(pattern) {
  const src = String(pattern)
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

export function matchesAny(name, compiled) {
  return compiled.some((re) => re.test(name));
}

// Profile → compiled policy. Returns null fields for "no restriction".
export function compilePolicy(profile = {}) {
  const blocked = [
    ...(profile.useDefaultBlockedTables === false ? [] : DEFAULT_BLOCKED_TABLES),
    ...(profile.blockedTables ?? []),
  ];
  return {
    allowedPackages: Array.isArray(profile.allowedPackages)
      ? profile.allowedPackages.map(compilePattern)
      : null,
    allowedPackagesText: Array.isArray(profile.allowedPackages)
      ? profile.allowedPackages.join(", ")
      : "",
    blockedTables: blocked.map(compilePattern),
    allowDataPreview: profile.allowDataPreview !== false,
  };
}

// --- Data Preview ------------------------------------------------------------

export function isDataPreviewPath(path) {
  return pathOnly(path).toLowerCase().startsWith(DATA_PREVIEW_PREFIX);
}

// Table / view names an OpenSQL SELECT reads: every identifier after FROM or
// JOIN, in the outer query, subqueries and UNION branches alike. String
// literals are blanked so they can't fake a name. Comments are deliberately
// NOT stripped: a name inside one is over-detected (a false refusal), which
// beats a comment-parsing mismatch with the server hiding a real FROM.
export function extractSqlTables(sql) {
  if (typeof sql !== "string") return [];
  const cleaned = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/`(?:[^`]|``)*`/g, "''");
  const out = [];
  const re = /\b(?:FROM|JOIN)\s+([/\w$~]+)/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1].split("~")[0];
    if (/^SELECT$/i.test(name) || name.length === 0) continue;
    out.push(name.toUpperCase());
  }
  return out;
}

// Returns a refusal message, or null when the request may go out.
export function checkDataPreview(policy, path, query, body) {
  if (!policy.allowDataPreview) {
    return (
      "Data Preview is disabled for this system (allowDataPreview: false) — " +
      "table and CDS row reads are not available."
    );
  }
  const names = new Set();
  const params = new URLSearchParams(String(path).split("?")[1] ?? "");
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) params.set(k, String(v));
  }
  for (const key of ["ddicEntityName", "ddlSourceName"]) {
    const v = params.get(key);
    if (v) names.add(v.toUpperCase());
  }
  for (const t of extractSqlTables(typeof body === "string" ? body : "")) names.add(t);
  const hit = [...names].filter((n) => matchesAny(n, policy.blockedTables));
  if (hit.length > 0) {
    return (
      `Data Preview of ${hit.join(", ")} is blocked by the access policy ` +
      "(blockedTables). These tables hold sensitive data that must not be sent to the model."
    );
  }
  return null;
}

// --- Package attribution for writes ------------------------------------------

export function pathOnly(path) {
  return String(path).split("?")[0].split("#")[0];
}

function queryOf(path, query) {
  const params = new URLSearchParams(String(path).split("?")[1] ?? "");
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null) params.set(k, String(v));
  }
  return params;
}

// The repository object a write path belongs to: drop the query and any
// sub-resource (/source/main, /includes/testclasses, …). A function module
// write resolves to its function group.
export function objectRootPath(path) {
  const segs = pathOnly(path).replace(/\/+$/, "").split("/");
  const lower = segs.map((s) => s.toLowerCase());
  const fg = lower.indexOf("groups");
  if (fg > 0 && lower[fg - 1] === "functions" && segs.length > fg + 1) {
    return segs.slice(0, fg + 2).join("/");
  }
  const cut = lower.findIndex(
    (s, i) => i > 4 && (s === "source" || s === "includes" || s === "objectstructure")
  );
  return (cut === -1 ? segs : segs.slice(0, cut)).join("/");
}

// adtcore:packageRef in an object's metadata or a create payload.
export function parsePackageRef(xml) {
  if (typeof xml !== "string") return null;
  const m = xml.match(/<adtcore:packageRef\b[^>]*?\badtcore:name="([^"]+)"/);
  return m ? m[1].toUpperCase() : null;
}

// Every packageRef name in a payload — a create body carrying two must not be
// judged by whichever comes first.
export function parsePackageRefs(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  const re = /<adtcore:packageRef\b[^>]*?\badtcore:name="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].toUpperCase());
  return [...new Set(out)];
}

export function parseActivationUris(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  const re = /\badtcore:uri="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    let uri = m[1].replace(/&amp;/g, "&");
    if (/^https?:\/\//i.test(uri)) {
      try {
        uri = new URL(uri).pathname;
      } catch {
        // Leave it as-is; it then fails attribution and the write is refused.
      }
    }
    out.push(uri);
  }
  return out;
}

// Classify a write for package attribution:
//   { kind: "pass" }                     not package-bound (transport requests)
//   { kind: "packages", packages: [...] } names already known (create payload)
//   { kind: "objects", roots: [...] }    resolve each root's package via GET
//   { kind: "refuse", reason }           not attributable — fail closed
export function classifyWrite(method, path, query, body) {
  const p = pathOnly(path);
  const lower = p.toLowerCase();
  if (lower.startsWith(TRANSPORT_PREFIX)) return { kind: "pass" };

  if (lower === ACTIVATION_PATH || lower.startsWith(`${ACTIVATION_PATH}/`)) {
    const uris = parseActivationUris(typeof body === "string" ? body : "");
    if (uris.length === 0) {
      return { kind: "refuse", reason: "activation request names no object URIs" };
    }
    return { kind: "objects", roots: [...new Set(uris.map(objectRootPath))] };
  }

  const action = queryOf(path, query).get("_action");
  // A create POSTs the new object's metadata (with its package) to a
  // collection. Only a POST without an _action qualifies — a PUT body is
  // source code, where a packageRef string could be planted in a comment.
  if (method === "POST" && !action) {
    const packages = parsePackageRefs(typeof body === "string" ? body : "");
    if (packages.length > 0) return { kind: "packages", packages };
  }

  if (!lower.startsWith("/sap/bc/adt/") || lower.split("/").length < 6) {
    return {
      kind: "refuse",
      reason: "the request does not target a repository object the policy can attribute to a package",
    };
  }
  return { kind: "objects", roots: [objectRootPath(p)] };
}
