# claude-for-abap

> **MCP server giving Claude (and any MCP-compatible client) live access to SAP systems via ADT.**
>
> Read source, search the repository, run syntax checks, run unit tests, run
> ATC, diff the same object across landscapes, edit and activate ABAP — all
> from a chat window or an autonomous agent. No add-on installation on the SAP
> stack required.

[![CI](https://github.com/yzonur/claude-for-abap/actions/workflows/ci.yml/badge.svg)](https://github.com/yzonur/claude-for-abap/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why

SAP development is full of repetitive read-the-source / check-the-callers /
diff-the-system work. AI assistants are great at exactly that kind of task —
but only if they can reach the system. ADT (ABAP Development Tools) is the
HTTP API that Eclipse uses; it ships with every modern NetWeaver and S/4
system. This server speaks ADT on behalf of the agent so the agent can do real
work against your real systems, with the same auth and scoping you'd give a
developer in Eclipse.

## What's in the box

**14 high-level tools** wrapped around the most common ADT endpoints, plus a
generic escape hatch for anything else.

| Category | Tools |
| --- | --- |
| Connection | `adt_list_systems`, `adt_ping` |
| Source CRUD | `adt_get_source`, `adt_set_source` |
| Quality | `adt_syntax_check`, `adt_pretty_print`, `adt_run_unit_tests`, `adt_run_atc` |
| Lifecycle | `adt_create_object`, `adt_delete_object`, `adt_activate`, `adt_lock`, `adt_unlock` |
| Discovery | `adt_browse_package`, `adt_list_packages`, `adt_search_objects`, `adt_where_used` |
| Cross-system | `adt_compare_source`, `adt_transport_diff` |
| Transports | `adt_list_transports`, `adt_get_transport`, `adt_create_transport`, `adt_release_transport` |
| Escape hatch | `adt_request` |

**Multi-system aware.** One config, many SAP systems (DEV / QAS / PRD or
landscape-wide); switch with the `system` argument or compare across two with
`adt_compare_source` / `adt_transport_diff`.

**Safe by default.** A `readOnly` flag (global or per-system) blocks every
write method. Read-only POST queries (search, where-used, package tree)
remain allowed so agents can still discover.

**Robust.** Per-request timeout. CSRF token negotiation with auto-retry on
403. Self-signed cert opt-out. Optional debug tracing to stderr.

**Structured errors.** ADT's `<exc:exception>` envelopes are parsed into
`{ type, message, namespace }` so failed calls don't dump XML into the agent's
context window.

## Install

```bash
# global
npm install -g claude-for-abap

# or run without installing
npx claude-for-abap
```

Requires Node.js **18.17+**.

## Configure

Create your config:

```bash
mkdir -p ~/.sap-adt-mcp
cp config.example.json ~/.sap-adt-mcp/config.json
$EDITOR ~/.sap-adt-mcp/config.json
```

The server searches in this order:

1. `$SAP_ADT_MCP_CONFIG` (absolute path)
2. `~/.sap-adt-mcp/config.json`
3. `./config.json` (cwd at server start)

### Sample config

```json
{
  "defaultSystem": "DEV",
  "readOnly": false,
  "systems": {
    "DEV": {
      "host": "https://sap-dev.example.com:44300",
      "client": "100",
      "language": "EN",
      "user": "DEVELOPER",
      "password": "env:SAP_DEV_PASSWORD",
      "rejectUnauthorized": false
    },
    "QAS": {
      "host": "https://sap-qas.example.com:44300",
      "client": "200",
      "user": "DEVELOPER",
      "password": "env:SAP_QAS_PASSWORD"
    },
    "PRD": {
      "host": "https://sap-prd.example.com:44300",
      "client": "300",
      "user": "READONLY",
      "password": "env:SAP_PRD_PASSWORD",
      "readOnly": true
    }
  }
}
```

### Per-system options

| Field | Meaning |
| --- | --- |
| `host` | Base URL including scheme + ICM HTTPS port (e.g. `https://...:44300`). |
| `client` | SAP client (sets `sap-client` query param). |
| `language` | Optional logon language (sets `sap-language`). |
| `user` | RFC user. |
| `password` | Either a literal string or `env:VAR_NAME` to read from environment. |
| `rejectUnauthorized` | Set `false` to skip TLS validation for self-signed certs. Default `true`. |
| `readOnly` | Block POST / PUT / DELETE / PATCH for this system (read-only POST queries still work). |
| `timeoutMs` | Override default 30 s request timeout. |

### Read-only mode

`readOnly: true` (top-level or per-system) refuses any unsafe HTTP method.
Whitelisted read-only POST endpoints (`nodestructure`, `search`,
`usagereferences`, `parsers`, `checkruns`) remain available so agents can
still discover and analyze without being able to modify.

Recommended: set `readOnly: true` for QAS and PRD profiles. Keep DEV writable.

### Self-signed certificates

Many internal SAP systems use self-signed certs. `"rejectUnauthorized": false`
disables TLS validation for that profile only. Don't set this on PRD.

## Connect a client

### Claude Code (CLI)

```bash
claude mcp add sap-adt -- npx claude-for-abap
```

Pass secrets through the registration:

```bash
claude mcp add sap-adt \
  --env SAP_DEV_PASSWORD=... \
  --env SAP_PRD_PASSWORD=... \
  -- npx claude-for-abap
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sap-adt": {
      "command": "npx",
      "args": ["-y", "claude-for-abap"],
      "env": {
        "SAP_DEV_PASSWORD": "..."
      }
    }
  }
}
```

Quit and restart Claude Desktop fully (system tray → Quit) for the change to
apply.

### Validate before connecting

```bash
npx claude-for-abap --validate-config
```

Loads the config and pings every system; exits non-zero if any are unreachable
or rejecting credentials. Run this first when troubleshooting.

## Tools

### Object-source CRUD

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_get_source` | Fetch ABAP source by object name + type. | Returns plain text. For classes, pick the include via `include`: `main` (default), `definitions`, `implementations`, `macros`, `testclasses`. Function modules require `group`. |
| `adt_set_source` | Replace source. Orchestrates lock → PUT → unlock. | Optional `transport` parameter assigns the change to a TR (`corrNr`). Optional `lockHandle` to reuse an externally-acquired lock. Refused under `readOnly: true`. |
| `adt_create_object` | Create a new ABAP object in a package. | Supported types: program, class, interface, include, functiongroup, function, cds, accesscontrol, metadataext, behaviordef, messageclass. After creation, set the source body with `adt_set_source` and activate. Refused under `readOnly: true`. |
| `adt_delete_object` | Delete an object. | Acquires lock and DELETEs. Refused under `readOnly: true`. |
| `adt_activate` | Activate one or more objects. | Pass `objects: [{ name, type, group? }]`. |
| `adt_pretty_print` | Run the SAP-side ABAP formatter. | Stateless — pass source, get formatted source back. |
| `adt_lock` / `adt_unlock` | Acquire / release a lock for multi-step edits. | For one-shot edits, prefer `adt_set_source` (manages the lock for you). Use these when you need to keep an object locked across multiple writes within a single agent turn. |

### Quality

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_syntax_check` | ADT syntax check on an object. | Returns `<chkrun:reports>` XML; the agent reads severity + line numbers. |
| `adt_run_unit_tests` | ABAP Unit run. | Pass test container objects (typically classes). |
| `adt_run_atc` | ABAP Test Cockpit run. | API surface varies across NW releases — see Caveats. |

### Discovery

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_browse_package` | One level of package contents. | |
| `adt_list_packages` | Recursive walk from a root. | Has `prefix` (only descend into matching subpackages) and `maxPackages` safety cap (default 200). |
| `adt_search_objects` | Quick-search by name pattern. | `*` wildcard. Returns parsed `{ name, type, description, packageName, uri }` records. |
| `adt_where_used` | Where-used list. | Same parsed record shape. |

### Cross-system

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_compare_source` | Diff one object between two systems. | Returns unified diff + `{ added, removed }` stats. |
| `adt_transport_diff` | Diff every object in a TR between two systems. | Caps at `maxObjects` (default 50). |

### Transports

| Tool | Purpose | Notes |
| --- | --- | --- |
| `adt_list_transports` | List TRs by user / status. | Default user = config user; default status = `modifiable`. |
| `adt_get_transport` | TR header + objects. | |
| `adt_create_transport` | Create a new TR. | Refused under `readOnly: true`. Endpoint shape varies — see Caveats. |
| `adt_release_transport` | Release a TR. | Refused under `readOnly: true`. |

### Escape hatch

`adt_request` — direct ADT REST call. Use this when a niche endpoint isn't
covered by a high-level tool. Handles auth / CSRF / cookies / sap-client
automatically.

### Object types

Friendly aliases (any of either column work):

| Alias | TADIR code |
| --- | --- |
| program / report | PROG |
| include | INCL |
| class | CLAS |
| interface | INTF |
| function / fm | FUGR/FF (requires `group`) |
| functiongroup | FUGR |
| table / structure | TABL |
| dataelement | DTEL |
| domain | DOMA |
| cds / ddls | DDLS |
| accesscontrol / dcls | DCLS |
| metadataext / ddlx | DDLX |
| behaviordef / bdef | BDEF |
| messageclass / msag | MSAG |

## Examples

See [`examples/`](examples) for end-to-end agent workflows: project discovery,
class audit, cross-system release verification, where-used-driven refactor,
test triage.

Quick taste:

```
You: "Compare class ZCL_PRICING between DEV and PRD on the live systems."
Agent: → adt_compare_source { systemA: "DEV", systemB: "PRD",
                              object: "ZCL_PRICING", type: "class" }
       Returns: { identical: false, stats: { added: 14, removed: 9 },
                  diff: "..." }
       Then narrates the meaningful changes.
```

## Architecture

```
MCP client (Claude Desktop / Claude Code / custom)
         │  stdio (JSON-RPC)
         ▼
  ┌──────────────────────────────────┐
  │  src/server.js                   │  tool definitions + dispatch
  │   ├─ src/object-uris.js          │  type alias → ADT URI map
  │   ├─ src/node-structure.js       │  package tree XML parser
  │   ├─ src/object-references.js    │  <objectReference> parser
  │   ├─ src/diff.js                 │  unified diff (LCS)
  │   ├─ src/adt-error.js            │  <exc:exception> parser
  │   └─ src/adt-client.js           │  HTTP client: auth / CSRF / cookies / timeout
  └──────────────────────────────────┘
         │  HTTPS
         ▼
   SAP system (ADT REST: /sap/bc/adt/...)
```

Two runtime dependencies: `@modelcontextprotocol/sdk` (the MCP wire protocol)
and `undici` (HTTP with custom TLS dispatcher). Everything else is stdlib.

## Multi-step editing pattern

For most edits, `adt_set_source` is enough — it acquires the lock, writes,
and releases. For workflows that touch the same object multiple times within
a single turn (e.g. apply N method-level patches, then activate), use the
sticky-lock pattern:

```text
1.  adt_lock { object: "ZCL_X", type: "class" }              → returns lockHandle
2.  adt_set_source { object: "ZCL_X", type: "class",         (repeat as needed)
                     source: "...", lockHandle: "<handle>" }
3.  adt_activate { objects: [{ name: "ZCL_X", type: "class" }] }
4.  adt_unlock { object: "ZCL_X", type: "class",
                 lockHandle: "<handle>" }
```

The `lockHandle` parameter on `adt_set_source` skips internal lock/unlock
when present.

## Caveats

- **NetWeaver release variation.** A few ADT endpoints (especially around
  transport requests, ATC, and object-create XML shapes) have small shape
  differences across NW 7.5x, S/4 on-prem, and Steampunk. If a high-level
  tool fails with HTTP 4xx, the tool description notes which endpoint it
  hits — fall back to `adt_request` with the right path / content type for
  your release.
- **ABAP Cloud (BTP / Steampunk).** Only on-prem ADT 7.5x+ has been actively
  exercised. Steampunk uses a stricter object-type allowlist (only released
  / public APIs) and some collection endpoints differ. Steampunk users:
  please open an issue with the endpoints that differ; PRs welcome.
- **Object-create XML shapes.** The body templates target modern on-prem
  releases. Some older systems require additional attributes
  (`adtcore:masterLanguage`, etc.) — open an issue if your system rejects
  the create payload, and include the response body.
- **DDIC primitives** (tables, data elements, domains) are not creatable via
  `adt_create_object` — these need a richer DDIC-specific payload that we
  haven't generalised. Use `adt_request` for now.

## Troubleshooting

**"failed" in Claude Desktop's MCP server list.** Run `claude-for-abap
--validate-config` from a terminal. If that prints OK, the server is fine and
the issue is in your `claude_desktop_config.json` (wrong path or env).

**403 with `x-csrf-token: required`.** Should self-heal — the client refetches
the token and retries. If it persists, you likely have an SSO / front-end
auth in front of ADT that breaks Basic auth; check your ICM and SAP web
dispatcher rules.

**Read-only mode refuses an obviously-read endpoint.** It's probably a POST
endpoint not in the whitelist. Open a PR or issue with the path; we'll add
it. Or temporarily flip the system to `readOnly: false`.

**`SAP_ADT_MCP_DEBUG=1`** traces every request and response (status, latency,
URL, request headers minus `Authorization`) to stderr. The MCP client shows
stderr in its server log, so check there.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — bug reports, new tool coverage,
NetWeaver compatibility notes, docs, examples all welcome.

## License

MIT — see [LICENSE](LICENSE).
