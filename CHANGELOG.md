# Changelog

All notable changes to this project will be documented in this file. Format
roughly follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to semantic versioning once it reaches 1.0.0.

## [Unreleased]

## [0.3.0]

### Added

- `adt_create_object` — create programs, classes, interfaces, includes,
  function groups, function modules, CDS views, access controls, metadata
  extensions, behavior definitions, and message classes from a single tool
  call. Returns the new object URI; pair with `adt_set_source` and
  `adt_activate` for end-to-end scaffolding.
- `adt_delete_object` — lock + DELETE + (no unlock needed) for any supported
  object type.
- `adt_lock` / `adt_unlock` — primitives so agents can keep an object locked
  across multiple writes within a single turn.
- `adt_set_source` accepts an optional `lockHandle` parameter to reuse an
  externally-acquired lock.
- New example workflow: scaffold a class from spec.

### Changed

- Lock acquisition / release factored into shared `acquireLock` / `releaseLock`
  helpers used by `set_source`, `delete_object`, and the new lock primitives.

## [0.2.0] — initial public preview

### Added

- High-level tools that hide ADT URI conventions from the agent:
  - `adt_get_source` — fetch source by object name + type alias
  - `adt_set_source` — orchestrates lock → PUT → unlock
  - `adt_activate` — activate one or more objects
  - `adt_syntax_check` — run the ADT syntax checker
  - `adt_search_objects` — repository quick-search
  - `adt_where_used` — usage references
  - `adt_browse_package` / `adt_list_packages` — package tree exploration
  - `adt_compare_source` — cross-system unified diff
  - `adt_list_transports` / `adt_get_transport` / `adt_create_transport` /
    `adt_release_transport` — TR management
  - `adt_transport_diff` — diff every object in a TR between two systems
  - `adt_pretty_print` — server-side ABAP pretty printer
  - `adt_run_unit_tests` — ABAP Unit runner
  - `adt_run_atc` — ABAP Test Cockpit runner
- `readOnly` config flag (global and per-system) blocks unsafe HTTP methods
  while still allowing ADT's read-only POST queries.
- Structured ADT error parsing (`<exc:exception>` → `{ type, message, namespace }`).
- CDS / RAP / DDIC type support: DDLS, DCLS, DDLX, BDEF, MSAG.
- `parseObjectReferences` helper used by search / where-used / transport-diff
  to surface results as structured JSON.
- CLI flags: `--help`, `--version`, `--validate-config`.
- `SAP_ADT_MCP_DEBUG=1` env var traces every request/response to stderr.
- Per-request timeout (default 30s, configurable per-system via `timeoutMs`).
- Test suite using `node:test` (no extra dependencies).
- ESLint flat config + GitHub Actions CI matrix (Node 18 / 20 / 22).

### Changed

- Package renamed to `claude-for-abap`. Old `sap-adt-mcp` bin name is kept as
  an alias.
- README, examples, and config samples generic-ised — no more hard-coded
  customer hostnames or paths.
