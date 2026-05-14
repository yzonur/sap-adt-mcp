import { Agent, fetch as undiciFetch } from "undici";

const UNSAFE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const DISCOVERY_PATH = "/sap/bc/adt/discovery";

const DEFAULT_TIMEOUT_MS = 30_000;

// ADT endpoints that use POST but are read-only queries — allowed in read-only mode.
const READONLY_POST_PATHS = [
  "/sap/bc/adt/repository/nodestructure",
  "/sap/bc/adt/repository/informationsystem/search",
  "/sap/bc/adt/repository/informationsystem/usagereferences",
  "/sap/bc/adt/abapsource/parsers",
  "/sap/bc/adt/checkruns",
];

// Headers a caller is NOT allowed to override via adt_request. Letting these
// through would let the LLM (or anything that prompt-injects it) impersonate
// another user (Authorization), forge a session (Cookie), or smuggle a stale
// CSRF token. The client manages all three internally.
const PROTECTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-csrf-token",
]);

const DEBUG = process.env.SAP_ADT_MCP_DEBUG === "1";

export class ReadOnlyViolationError extends Error {
  constructor(method, path) {
    super(
      `Read-only mode: refusing ${method} ${path}. ` +
        "Set readOnly: false in config to allow writes."
    );
    this.name = "ReadOnlyViolationError";
    this.code = "READ_ONLY";
  }
}

export class AdtClient {
  constructor(profile) {
    this.profile = profile;
    this.cookies = new Map();
    this.csrfToken = null;
    this.timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authHeader =
      "Basic " +
      Buffer.from(`${profile.user}:${profile.password}`).toString("base64");
    this.dispatcher =
      profile.rejectUnauthorized === false
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
  }

  async request({ method = "GET", path, query, body, headers = {}, accept }) {
    const upperMethod = method.toUpperCase();

    // Resolve the path the same way #buildUrl will resolve it (collapsing
    // "../" segments) BEFORE running the read-only check. Doing the check on
    // the raw string lets a caller smuggle a write through a read-only
    // allowlist entry, e.g. "/sap/bc/adt/checkruns/../programs/..."
    // ─ startsWith() sees "/sap/bc/adt/checkruns" and allows the request, but
    // new URL() then collapses it to "/sap/bc/adt/programs/...". Normalize
    // first, gate second.
    const resolvedPath = this.#resolvePath(path);

    if (UNSAFE_METHODS.has(upperMethod) && this.profile.readOnly) {
      if (!isReadOnlyPostPath(resolvedPath)) {
        throw new ReadOnlyViolationError(upperMethod, resolvedPath);
      }
    }

    if (UNSAFE_METHODS.has(upperMethod) && !this.csrfToken) {
      await this.#fetchCsrf();
    }

    let res = await this.#send(upperMethod, resolvedPath, query, body, headers, accept);

    if (
      res.status === 403 &&
      (res.headers.get("x-csrf-token") || "").toLowerCase() === "required"
    ) {
      this.csrfToken = null;
      await this.#fetchCsrf();
      res = await this.#send(upperMethod, resolvedPath, query, body, headers, accept);
    }

    return res;
  }

  // Public wrapper so callers (e.g. the adt_request handler) can apply the
  // same path-prefix policy the client itself enforces internally.
  resolvePath(path) {
    return this.#resolvePath(path);
  }

  #resolvePath(path) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("ADT path must be a non-empty string");
    }
    const base = this.profile.host.replace(/\/$/, "");
    const normalized = path.startsWith("/") ? path : `/${path}`;
    let url;
    try {
      url = new URL(base + normalized);
    } catch {
      throw new Error(`ADT path is not a valid URL component: ${path}`);
    }
    // Preserve any query stuffed into the path (some internal callers do
    // this); the read-only check below splits on "?" anyway.
    return url.pathname + url.search;
  }

  async #fetchCsrf() {
    // Pass the fetch header via `internalHeaders` so #send doesn't strip it
    // through the PROTECTED_HEADERS filter (that filter exists to stop
    // adt_request callers from forging Authorization/Cookie/X-CSRF-Token —
    // it must not apply to the client's own CSRF handshake).
    const res = await this.#send(
      "GET",
      DISCOVERY_PATH,
      null,
      null,
      {},
      "application/atomsvc+xml",
      { "X-CSRF-Token": "Fetch" }
    );
    const token = res.headers.get("x-csrf-token");
    if (!token || token.toLowerCase() === "required") {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to fetch CSRF token (status ${res.status}): ${body.slice(0, 200)}`
      );
    }
    this.csrfToken = token;
  }

  async #send(method, adtPath, query, body, extraHeaders, accept, internalHeaders) {
    const url = this.#buildUrl(adtPath, query);
    const headers = new Headers();
    headers.set("Authorization", this.authHeader);
    headers.set(
      "Accept",
      accept ?? "application/xml, application/json;q=0.9, */*;q=0.1"
    );
    if (this.cookies.size > 0) headers.set("Cookie", this.#cookieHeader());
    if (this.csrfToken && UNSAFE_METHODS.has(method)) {
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    // Apply caller-supplied headers, but never let them override the auth /
    // session headers the client owns. Without this, adt_request callers (or
    // anything that prompt-injects the LLM into using it) could swap in a
    // forged Authorization to impersonate another SAP user.
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (PROTECTED_HEADERS.has(k.toLowerCase())) continue;
      headers.set(k, v);
    }
    // Internal headers come from the client itself (e.g. the X-CSRF-Token:
    // Fetch handshake) and are trusted — they bypass the protection filter.
    if (internalHeaders) {
      for (const [k, v] of Object.entries(internalHeaders)) {
        headers.set(k, v);
      }
    }

    let reqBody;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        reqBody = body;
      } else {
        reqBody = JSON.stringify(body);
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
      }
    }

    const init = { method, headers, body: reqBody };
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    init.signal = controller.signal;

    if (DEBUG) traceRequest(method, url, headers, reqBody);

    let res;
    const start = Date.now();
    try {
      res = await undiciFetch(url, init);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(
          `ADT request timed out after ${this.timeoutMs}ms: ${method} ${adtPath}`,
          { cause: err }
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (DEBUG) traceResponse(method, url, res.status, Date.now() - start);

    this.#captureCookies(res.headers);
    return res;
  }

  #buildUrl(adtPath, query) {
    const base = this.profile.host.replace(/\/$/, "");
    const normalized = adtPath.startsWith("/") ? adtPath : `/${adtPath}`;
    const url = new URL(base + normalized);
    if (this.profile.client && !url.searchParams.has("sap-client")) {
      url.searchParams.set("sap-client", this.profile.client);
    }
    if (this.profile.language && !url.searchParams.has("sap-language")) {
      url.searchParams.set("sap-language", this.profile.language);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  #captureCookies(headers) {
    const setCookies =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  #cookieHeader() {
    return [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

function isReadOnlyPostPath(p) {
  if (typeof p !== "string") return false;
  const lower = p.toLowerCase().split("?")[0];
  return READONLY_POST_PATHS.some((allowed) => lower.startsWith(allowed));
}

function traceRequest(method, url, headers, body) {
  const safeUrl = url.replace(/\/\/[^@/]+@/, "//***@"); // strip basic-auth prefix if any
  process.stderr.write(`[adt-debug] → ${method} ${safeUrl}\n`);
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === "authorization") continue;
    process.stderr.write(`[adt-debug]   ${k}: ${v}\n`);
  }
  if (body) {
    const preview = typeof body === "string" ? body.slice(0, 200) : "[binary]";
    process.stderr.write(`[adt-debug]   body: ${preview}\n`);
  }
}

function traceResponse(method, url, status, ms) {
  process.stderr.write(`[adt-debug] ← ${status} ${method} ${url} (${ms}ms)\n`);
}
