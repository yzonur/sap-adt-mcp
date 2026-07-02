# Crash/issue-report relay (Cloudflare Worker)

`reporter.worker.js` receives redacted reports from `sap-adt-mcp` installs and
files / de-duplicates GitHub issues on `yzonur/sap-adt-mcp`.

Why a relay: filing an issue needs a GitHub token. Shipping a token inside the
distributed npm package would expose it to everyone who clones the repo. The
token instead lives **only here**, as a Worker secret (`GITHUB_TOKEN`). The
client knows the relay's public URL — nothing more.

Deployed URL: `https://sap-adt-mcp-reporter.onuryz-itu.workers.dev`
(matches `DEFAULT_ENDPOINT` in `src/reporter.js`).

## Report kinds

| `kind` | source header | trigger | label |
| --- | --- | --- | --- |
| `crash` | `sap-adt-mcp` | a tool handler threw | `auto-reported` |
| `adt-error` | `sap-adt-mcp` | a tool returned a non-2xx ADT result the classifier flags | `auto-adt-error` |
| `manual` | `sap-adt-mcp-manual` | the agent filed it via `adt_report_issue` | `agent-reported` (+ `bug`/`enhancement`) |

Each kind de-dups within its own label namespace: the relay searches open issues
with that label for the report's `fingerprint:<hash>` marker; found → adds a
"Seen again" comment, else → opens a new issue. Both the new-issue body and the
"Seen again" comment carry an anonymous `install:` marker (a client-minted
16-hex id, validated by shape before use) so you can tell how many distinct
installs a fingerprint spans. Requests without an allowed `x-report-source` →
403; missing token → 503. Labels are created automatically on first use.

## Set the GitHub token (required before it can file issues)

Create a **fine-grained** PAT scoped to **only** `yzonur/sap-adt-mcp` with
**Issues: Read and write** (nothing else), then store it as the Worker secret:

**Dashboard:** Workers & Pages → `sap-adt-mcp-reporter` → Settings → Variables
and Secrets → add secret `GITHUB_TOKEN` → paste → deploy.

**wrangler:** `npx wrangler secret put GITHUB_TOKEN --name sap-adt-mcp-reporter`

Verify: `curl https://sap-adt-mcp-reporter.onuryz-itu.workers.dev` → `ok`.

## ⚠️ Redeploying without wiping the secret

Uploading a new script version **replaces all bindings**, which **deletes the
`GITHUB_TOKEN` secret** unless you tell the upload to keep it. Always include
`keep_bindings` in the upload metadata:

- **Cloudflare API (module upload):** add `"keep_bindings": ["secret_text"]` to
  the `metadata` part.
- **wrangler:** `wrangler deploy` preserves secrets by default (with a
  `wrangler.toml` of `name`, `main = "reporter.worker.js"`,
  `compatibility_date = "2024-11-06"`).

If the secret does get wiped, just re-add `GITHUB_TOKEN` (steps above) — the
token value can't be read back, so it must be re-entered, not recovered.

## Notes / limits

- De-dup relies on GitHub search, whose indexing can lag a few seconds; a burst
  of the same brand-new report may create a couple of duplicates. The client
  de-dups crash/adt-error per process, keeping this rare. For stricter dedup,
  back the Worker with a KV namespace keyed by `kind:fingerprint`.
- The only gate is the `x-report-source` header (the client is public, so any
  shared key would be too). The token is never at risk — worst case is junk
  issues, which the header check + content validation already filter. Add
  Cloudflare rate-limiting / WAF rules if abuse appears.
