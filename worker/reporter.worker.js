// sap-adt-mcp crash-report relay.
//
// Receives redacted, fingerprinted crash reports from sap-adt-mcp installs and
// files / de-duplicates GitHub issues. The GitHub token lives here as a Worker
// secret (env.GITHUB_TOKEN) and never ships in the distributed package.
//
// Deploy: see worker/README.md. Set the secret with:
//   wrangler secret put GITHUB_TOKEN          (fine-grained, Issues: Read & Write on the repo only)
//
// De-dup strategy: search open issues labelled "auto-reported" for the report's
// fingerprint marker. Found -> add a "seen again" comment. Not found -> open a
// new issue. (GitHub search indexing can lag a few seconds, so a burst of the
// same brand-new crash may create a couple of duplicates; the client already
// de-dups per process, keeping this rare.)

const REPO = "yzonur/sap-adt-mcp";

export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      return new Response("sap-adt-mcp reporter: ok", { status: 200 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (req.headers.get("x-report-source") !== "sap-adt-mcp") {
      return new Response("forbidden", { status: 403 });
    }

    let r;
    try {
      r = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!r || typeof r.fingerprint !== "string" || typeof r.message !== "string") {
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
      "version: " + (r.version || "?") + "\n" +
      "build: " + (r.build || "?") + "\n" +
      "node: " + (r.node || "?") + "\n" +
      "os: " + (r.os || "?") + "\n" +
      "tool: " + (r.tool || "?") + "\n" +
      "time: " + (r.timestamp || new Date().toISOString());

    // --- de-dup search ---
    const q = encodeURIComponent(
      'repo:' + REPO + ' is:issue is:open label:auto-reported "fingerprint:' + fp + '" in:body'
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

    // --- create new issue ---
    const shortMsg = r.message.split("\n")[0].slice(0, 80);
    const title = ("[auto] " + (r.errorName || "Error") + ": " + shortMsg).slice(0, 120);

    const bodyParts = [
      "Automatically reported by `sap-adt-mcp`. Reports are redacted (no hostnames, users, passwords, IPs, or business data).",
      "",
      "**Tool:** `" + (r.tool || "?") + "`",
      "",
      "**Message:**",
      "```",
      r.message,
      "```",
    ];
    if (r.stack) {
      bodyParts.push("", "**Stack:**", "```", r.stack, "```");
    }
    if (r.args) {
      bodyParts.push("", "**Args (redacted):**", "```json", r.args, "```");
    }
    bodyParts.push("", "**Environment:**", "```", meta, "```", "", "<!-- fingerprint:" + fp + " -->");

    const create = await gh("/repos/" + REPO + "/issues", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: bodyParts.join("\n"),
        labels: ["auto-reported", "bug"],
      }),
    });
    if (!create.ok) {
      const text = await create.text();
      return new Response("github error " + create.status + ": " + text, { status: 502 });
    }
    const issue = await create.json();
    return json({ status: "created", issue: issue.number });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
