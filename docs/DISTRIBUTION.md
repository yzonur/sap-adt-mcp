# Distribution checklist

Where to list sap-adt-mcp and exactly what each step needs. No documents or
business verification anywhere — the only identity check is GitHub login
(proving you own the repo). Reusable copy-paste text is at the bottom.

Effort legend: 🟢 ~2 min · 🟡 ~10 min · ⚪ automatic (nothing to do).

---

## 1. Official MCP Registry — ✅ PUBLISHED

Listed as `io.github.yzonur/sap-adt-mcp` at registry.modelcontextprotocol.io.
Manifest is [`server.json`](../server.json).

Ownership is verified two ways, both already in place:
- `package.json` carries `"mcpName": "io.github.yzonur/sap-adt-mcp"` (the
  registry fetches the published npm package and matches this field);
- the `mcp-publisher` login proves the `io.github.yzonur` GitHub namespace.

Headless re-publish (no browser needed — uses the gh token), for **every
release**:

```bash
# 1. bump the two "version" fields in server.json to the new npm version first
# 2. download the CLI (darwin-arm64 shown):
curl -sL https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_darwin_arm64.tar.gz | tar xz
./mcp-publisher login github --token "$(gh auth token)"
./mcp-publisher validate     # description must be <= 100 chars
./mcp-publisher publish
```

Schema in use: `…/schemas/2025-12-11/server.schema.json` (run `mcp-publisher init`
to regenerate against the current schema if it ever changes).

## 2. Smithery — ❌ not applicable

Checked 2026-06-12: Smithery's "Publish → MCP" flow only accepts **remote/hosted
servers with a public HTTPS MCP URL**. sap-adt-mcp is local (stdio) and connects
to the user's SAP host with their credentials, so it has no public URL and can't
be hosted. No GitHub/local listing path exists. Skipped — no loss.
(`smithery.yaml` is kept in the repo in case Smithery re-adds local-server
listing or other tooling reads it.)

## 3. Glama ⚪

https://glama.ai/mcp/servers — crawls GitHub/npm automatically; you likely don't
need to submit. Optionally sign in with GitHub to **claim** the listing and edit
metadata.

## 4. PulseMCP 🟢

https://www.pulsemcp.com → "Submit" — a short web form (name, GitHub URL,
description). No documents. Their weekly newsletter accepts new-server
submissions separately (worth doing).

## 5. mcp.so 🟢

https://mcp.so → submit — repo URL + basic info form.

## 6. awesome-mcp-servers (GitHub PR) 🟢

Repo: https://github.com/punkpeye/awesome-mcp-servers

1. Fork, add one line under the most fitting category (e.g. *Developer Tools* or
   *Other Tools and Integrations* — check the current sections).
2. Match the list's emoji legend (📇 = TypeScript/JS, 🏠 = local).

```markdown
- [yzonur/sap-adt-mcp](https://github.com/yzonur/sap-adt-mcp) 📇 🏠 - Live access to SAP ABAP via ADT: read/search/syntax-check/ATC/unit-test/edit objects, dump triage, transport release gate.
```

3. Open the PR. (Other popular lists: `wong2/awesome-mcp-servers`,
   `appcypher/awesome-mcp-servers` — same one-line PR.)

---

## After you're listed: add badges to README

These only resolve once the listing exists, so add them after submitting:

```markdown
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![smithery badge](https://smithery.ai/badge/@yzonur/sap-adt-mcp)](https://smithery.ai/server/@yzonur/sap-adt-mcp)
```

(Glama provides its own badge URL on the listing page once indexed.)

---

## Reusable copy-paste text

**Name:** sap-adt-mcp

**Short description (≤100 chars):**
> Give Claude live access to SAP ABAP via ADT — read, search, check, test, and edit objects.

**Long description:**
> An MCP server that connects any MCP client (Claude Code, Claude Desktop,
> Cursor, …) to a SAP system over the ADT (ABAP Development Tools) REST API.
> Read and edit ABAP source, search the repository, run syntax checks, ATC, and
> unit tests, browse packages and transports, and triage ST22 dumps — in plain
> language. Read-only mode and a local write-audit log make it safe to point at
> QAS/PRD. Ships packaged workflow skills (transport release gate, dump triage,
> legacy-code documentation).

**Tags / keywords:**
> sap, abap, adt, netweaver, s4hana, abap-development-tools, code-review, devops, mcp, claude

**Repository:** https://github.com/yzonur/sap-adt-mcp
**npm:** https://www.npmjs.com/package/sap-adt-mcp
**License:** MIT
