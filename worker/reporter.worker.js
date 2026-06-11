// sap-adt-mcp crash/issue-report relay.
//
// Receives redacted, fingerprinted reports from sap-adt-mcp installs and files /
// de-duplicates GitHub issues on yzonur/sap-adt-mcp. The GitHub token lives here
// as a Worker secret (env.GITHUB_TOKEN) and never ships in the package.
//
// Three report kinds (payload.kind), each routed to its own label + de-dup
// namespace so a human can triage them separately:
//   crash      -> a tool handler threw            -> label "auto-reported"
//   adt-error  -> a tool returned a non-2xx ADT   -> label "auto-adt-error"
//   manual     -> the agent filed it via tool     -> label "agent-reported"
//
// Sources (x-report-source header): "sap-adt-mcp" (crash + adt-error) and
// "sap-adt-mcp-manual" (manual). De-dup: search open issues with the kind's
// label for the report's fingerprint marker; found -> comment, else -> create.
//
// Deploy: see worker/README.md. Set the secret with:
//   wrangler secret put GITHUB_TOKEN --name sap-adt-mcp-reporter

const REPO = "yzonur/sap-adt-mcp";

const ALLOWED_SOURCES = { "sap-adt-mcp": true, "sap-adt-mcp-manual": true };

const KIND = {
  crash: { label: "auto-reported", prefix: "[auto]" },
  "adt-error": { label: "auto-adt-error", prefix: "[adt]" },
  manual: { label: "agent-reported", prefix: "[reported]" },
};

export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      return new Response("sap-adt-mcp reporter: ok", { status: 200 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!ALLOWED_SOURCES[req.headers.get("x-report-source")]) {
      return new Response("forbidden", { status: 403 });
    }

    let r;
    try {
      r = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const conf = r && KIND[r.kind];
    if (!r || !conf || typeof r.fingerprint !== "string") {
      return new Response("bad report", { status: 400 });
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return new Response("relay not configured", { status: 503 });
    }

    const fp = r.fingerprint.replace(/[^a-f0-9]/gi, "").slice(0, 32);
    if (!fp) {
      return new Response("bad fingerprint", { status: 400 });
    }

    const gh = (path, init) => {
      init = init || {};
      const headers = Object.assign(
        {
          authorization: "Bearer " + token,
          accept: "application/vnd.github+json",
          "user-agent": "sap-adt-mcp-reporter",
          "content-type": "application/json",
        },
        init.headers || {}
      );
      return fetch("https://api.github.com" + path, Object.assign({}, init, { headers }));
    };

    const meta =
      "kind: " + r.kind + "\n" +
      "version: " + (r.version || "?") + "\n" +
      "build: " + (r.build || "?") + "\n" +
      "node: " + (r.node || "?") + "\n" +
      "os: " + (r.os || "?") + "\n" +
      "tool: " + (r.tool || "?") + "\n" +
      "time: " + (r.timestamp || new Date().toISOString());

    // --- de-dup search, scoped to this kind's label ---
    const q = encodeURIComponent(
      'repo:' + REPO + ' is:issue is:open label:' + conf.label +
      ' "fingerprint:' + fp + '" in:body'
    );
    const search = await gh("/search/issues?q=" + q, { method: "GET" });
    const hits = search.ok ? await search.json() : { total_count: 0, items: [] };

    if (hits.total_count > 0 && hits.items && hits.items.length) {
      const issue = hits.items[0];
      await gh("/repos/" + REPO + "/issues/" + issue.number + "/comments", {
        method: "POST",
        body: JSON.stringify({ body: "Seen again on another install.\n\n" + meta }),
      });
      return json({ status: "commented", issue: issue.number });
    }

    // --- build title, body, labels per kind ---
    const title = buildTitle(r, conf);
    const labels = buildLabels(r, conf);
    const body = buildBody(r, meta, fp);

    const create = await gh("/repos/" + REPO + "/issues", {
      method: "POST",
      body: JSON.stringify({ title: title.slice(0, 120), body, labels }),
    });
    if (!create.ok) {
      const text = await create.text();
      return new Response("github error " + create.status + ": " + text, { status: 502 });
    }
    const issue = await create.json();
    return json({ status: "created", issue: issue.number });
  },
};

function firstLine(s) {
  return String(s || "").split("\n")[0];
}

function buildTitle(r, conf) {
  if (r.kind === "adt-error") {
    return (
      conf.prefix + " " + (r.tool || "?") + " " + (r.status || "?") +
      (r.errorType ? " " + r.errorType : "")
    );
  }
  if (r.kind === "manual") {
    return conf.prefix + " " + (r.tool || "?") + ": " + firstLine(r.summary).slice(0, 80);
  }
  return conf.prefix + " " + (r.errorName || "Error") + ": " + firstLine(r.message).slice(0, 80);
}

function buildLabels(r, conf) {
  if (r.kind === "manual") {
    return [conf.label, r.issueKind === "enhancement" ? "enhancement" : "bug"];
  }
  return [conf.label, "bug"];
}

function fence(content, lang) {
  return "```" + (lang || "") + "\n" + content + "\n```";
}

function buildBody(r, meta, fp) {
  const parts = [
    "Reported by `sap-adt-mcp` (" + r.kind + "). Redacted - no hostnames, users, passwords, IPs, or business data.",
    "",
    "**Tool:** `" + (r.tool || "?") + "`",
  ];

  if (r.kind === "manual") {
    parts.push("**Kind:** " + (r.issueKind || "bug"));
    if (r.summary) parts.push("", "**Summary:** " + r.summary);
    if (r.expected) parts.push("", "**Expected:**", fence(r.expected));
    if (r.actual) parts.push("", "**Actual:**", fence(r.actual));
    if (r.reproArgs) parts.push("", "**Repro args (redacted):**", fence(r.reproArgs, "json"));
  } else if (r.kind === "adt-error") {
    parts.push("**Status:** " + (r.status || "?"));
    if (r.errorType) parts.push("**Error type:** " + r.errorType);
    if (r.namespace) parts.push("**Namespace:** " + r.namespace);
    if (r.t100) parts.push("**T100:** " + JSON.stringify(r.t100));
    if (r.message) parts.push("", "**Message:**", fence(r.message));
    if (r.args) parts.push("", "**Args (redacted):**", fence(r.args, "json"));
  } else {
    if (r.message) parts.push("", "**Message:**", fence(r.message));
    if (r.stack) parts.push("", "**Stack:**", fence(r.stack));
    if (r.args) parts.push("", "**Args (redacted):**", fence(r.args, "json"));
  }

  parts.push("", "**Environment:**", fence(meta), "", "<!-- fingerprint:" + fp + " -->");
  return parts.join("\n");
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
