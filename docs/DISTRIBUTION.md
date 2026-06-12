# Distribution checklist

Where to list sap-adt-mcp and exactly what each step needs. No documents or
business verification anywhere — the only identity check is GitHub login
(proving you own the repo). Reusable copy-paste text is at the bottom.

Effort legend: 🟢 ~2 min · 🟡 ~10 min · ⚪ automatic (nothing to do).

---

## 1. Official MCP Registry 🟡 — highest priority

The registry that client "add MCP server" UIs increasingly read from. Manifest
lives in the repo as [`server.json`](../server.json) (already prepared).

```bash
# install the publisher CLI (see github.com/modelcontextprotocol/registry for
# the current install method — Homebrew / Go / release binary)
mcp-publisher login github      # opens browser OAuth, like `gh auth login`
mcp-publisher publish           # reads ./server.json and publishes it
```

- Namespace `io.github.yzonur/sap-adt-mcp` is proven by the GitHub OAuth above.
- If `mcp-publisher init` reports a schema mismatch, let it regenerate
  `server.json` (it matches the current schema), then copy the `description` and
  the `SAP_ADT_MCP_CONFIG` env block from our version into it.
- **Re-publish on every release:** bump the two `version` fields in `server.json`
  to match the new npm version, then `mcp-publisher publish` again.

## 2. Smithery 🟡

Manifest is [`smithery.yaml`](../smithery.yaml) (already prepared, configured as
a local stdio server since it needs your SAP creds + network).

1. Sign in at https://smithery.ai with GitHub.
2. "Add server" / "Deploy" → point it at `github.com/yzonur/sap-adt-mcp`.
3. It reads `smithery.yaml`; confirm the metadata. Done.

Note: Smithery's "hosted run" doesn't apply here (local-only tool) — it acts as
a directory + config-snippet generator.

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
