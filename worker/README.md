# Crash-report relay (Cloudflare Worker)

`reporter.worker.js` receives redacted crash reports from `sap-adt-mcp` installs
and files / de-duplicates GitHub issues on `yzonur/sap-adt-mcp`.

Why a relay: filing an issue needs a GitHub token. Shipping a token inside the
distributed npm package would expose it to everyone who clones the repo. The
token instead lives **only here**, as a Worker secret (`GITHUB_TOKEN`). The
client knows the relay's public URL — nothing more.

## What it does

- `GET /` → health check (`sap-adt-mcp reporter: ok`).
- `POST /` with header `x-report-source: sap-adt-mcp` and a JSON report:
  - searches open issues labelled `auto-reported` for the report's
    `fingerprint:<hash>` marker;
  - **found** → adds a "Seen again" comment to that issue;
  - **not found** → opens a new issue titled `[auto] <Error>: <message>`, labelled
    `auto-reported` + `bug` (labels are created automatically on first use).
- Anything without the source header → `403`. Missing token → `503`.

The deployed URL is:

```
https://sap-adt-mcp-reporter.onuryz-itu.workers.dev
```

which matches `DEFAULT_ENDPOINT` in `src/reporter.js`.

## Set the GitHub token (required before it can file issues)

Create a **fine-grained** personal access token scoped to **only** the
`yzonur/sap-adt-mcp` repository with **Issues: Read and write** (nothing else),
then store it as the Worker secret. Easiest options:

**Cloudflare dashboard:** Workers & Pages → `sap-adt-mcp-reporter` → Settings →
Variables and Secrets → add secret `GITHUB_TOKEN` → paste token → deploy.

**wrangler CLI:**

```bash
npx wrangler secret put GITHUB_TOKEN --name sap-adt-mcp-reporter
# paste the token when prompted
```

Verify:

```bash
curl https://sap-adt-mcp-reporter.onuryz-itu.workers.dev            # -> ok
curl -X POST https://sap-adt-mcp-reporter.onuryz-itu.workers.dev \
  -H 'content-type: application/json' -H 'x-report-source: sap-adt-mcp' \
  -d '{"fingerprint":"smoketest0000","errorName":"Error","message":"relay smoke test"}'
# before the token is set -> 503 "relay not configured"
# after  the token is set -> {"status":"created","issue":N}  (delete that test issue)
```

## Redeploy after editing the worker

This Worker was deployed via the Cloudflare API (ES-module upload). To redeploy
with wrangler instead, a minimal `wrangler.toml` is:

```toml
name = "sap-adt-mcp-reporter"
main = "reporter.worker.js"
compatibility_date = "2024-11-06"
```

```bash
npx wrangler deploy
```

## Notes / limits

- De-dup relies on GitHub search, whose indexing can lag a few seconds; a burst
  of the same brand-new crash may create a couple of duplicates. The client
  de-dups per process, keeping this rare. For stricter dedup, back the Worker
  with a KV namespace keyed by fingerprint.
- There is no auth beyond the `x-report-source` header (the client is public, so
  any shared key would be too). The token is never at risk — worst case is junk
  issues, which the source-header check and content validation already filter.
  Add Cloudflare rate-limiting / WAF rules if abuse appears.
