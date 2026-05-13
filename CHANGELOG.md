# Changelog

All notable changes to this project will be documented in this file. Format
roughly follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to semantic versioning once it reaches 1.0.0.

## [Unreleased]

## [0.5.2]

Second round of dump-tool fixes. v0.5.1 fixed the network-level bugs but a
real-system test against on-prem ADT (S/4HANA E4D) showed three remaining
shape mismatches: the chapter parser couldn't read the boxed-pipe formatted
output, the metadata parser ignored root-element attributes (which is where
on-prem actually puts the dump payload), and the list response carried a
10+KB HTML summary per entry that blew past tool-output token limits.

### Fixed

- **`parseDumpChapters` now handles boxed (pipe-wrapped) dump output.**
  Formatted dumps on on-prem releases ship each line wrapped in `|content|`
  with chapter separators of `-` rules. The parser now unboxes the line
  before matching titles and skips separator runs, so chapter extraction
  works on both bare and boxed output. v0.5.1 returned `chapters: {}` for
  every real dump.
- **`parseDumpMetadata` now extracts root-element attributes.** Real
  on-prem ADT returns the dump payload as attributes on the root element
  (`title`, `error`, `terminatedProgram`, `author`, `datetime`,
  `serverInstance`, …) rather than as child elements. The parser scans the
  root, filters `xmlns` declarations, and merges the attributes into
  `fields`. The commonly-needed values (`runtimeError`, `program`, `user`,
  `time`, `server`, `title`) are also lifted to the top level of the
  response so the agent doesn't have to probe the map.
- **`adt_list_dumps` no longer ships per-entry `summary` HTML.** The summary
  on real systems is a 10+KB HTML chunk (chapter index + back-link) that on
  a 20-row list bloats responses past the tool-output token limit. Stripped
  from list responses; agents that need detail call `adt_get_dump` (which
  returns structured chapters anyway).
- **`whatCanYouDo` chapter pattern accepts variants of the subject.** Real
  dumps title the chapter "What can I do?" (first-person); the original
  pattern was anchored on "you" and the body leaked into the preceding
  `whatHappened` chapter. Pattern broadened to accept any single subject
  word so translations and phrasing variants don't desync the parser.

## [0.5.1]

Verifying v0.5.0 against a real on-prem ADT system (NetWeaver-class) exposed
three bugs and one gap in the dump tools shipped that day. All four are fixed
in this patch; no behavior changes elsewhere.

### Fixed

- **`adt_list_dumps` Accept header**. The feed endpoint requires
  `application/atom+xml;type=feed` and rejects bare `application/atom+xml`
  with HTTP 406. Tool now sends the correct media type.
- **`adt_list_dumps` parser missed namespace-prefixed Atom tags**. Real SAP
  feeds tag elements with the `atom:` prefix (`<atom:entry>`, `<atom:id>`,
  `<atom:author>`). The list call returned `count: 0` against a feed of 245
  entries. Parser regex now accepts both prefixed and unprefixed forms.
- **`adt_list_dumps` exposed `runtimeError` and `program`**. Real feeds carry
  the runtime error name and terminated program in `<atom:category>`
  elements, not `<atom:title>`. The parser now extracts both; if `<title>` is
  absent it falls back to the runtime error name.
- **`adt_list_dumps` trims client-side**. The server-side `maxResults`
  parameter is ignored on at least some releases (`maxResults=100` returned
  245 rows). Tool now caps the response client-side after parsing and reports
  `totalReturnedByServer` so the truncation is visible.
- **`adt_get_dump` was completely broken**. Three problems: wrong path
  (`runtime/dumps/<id>` vs the singular `runtime/dump/<id>` the feed's
  self-link advertises), double URL-encoding (feed ids arrive already
  encoded), and wrong Accept header (`application/xml` → 406, real media
  type is `application/vnd.sap.adt.runtime.dump.v1+xml`). The tool now does
  a two-step fetch: a metadata XML lookup followed by a GET on the
  `<dump:link relation="contents">` sub-resource to retrieve the formatted
  dump text.

### Added

- **`adt_get_dump` chapter extraction**. The formatted dump text is parsed
  into a chapter map (shortText, whatHappened, errorAnalysis, howToCorrect,
  whereTerminated, sourceCodeExtract, …). By default the response returns
  only the six critical chapters; pass `chapters: [...]` to pick specific
  ones or `full: true` to also include the raw text (typically 100KB+).
  `chaptersAvailable` lists every chapter the parser recognized.

## [0.5.0]

### Added

- **`adt_list_dumps` / `adt_get_dump`** — ST22 runtime errors are now first-class.
  `list_dumps` queries `/sap/bc/adt/runtime/dumps` with optional `user`, `host`,
  `from` / `to`, and `maxResults` filters; the response Atom feed is parsed into
  structured entries with their release-specific `rba:*` fields surfaced as a
  map (host, program, include, line, errorClass, …). `get_dump` fetches the
  full detail by id. Falls back to raw XML on parse failure so the agent can
  still reason about niche dump shapes.
- **`adt_read_table`** — SE16-style table reads via the ADT Data Preview API
  (`/sap/bc/adt/datapreview/freestyle`). OpenSQL SELECT in, structured
  `{ columns, rows }` out. Client-side SELECT-only guard + per-call row cap
  (default 100, hard cap 5000); the SAP endpoint enforces read-only on its
  side too. Requires NetWeaver 7.55+ / S/4HANA — older systems may not
  expose the endpoint.

### Changed

- **Modular tool layout.** `src/server.js` shrank from 1636 lines to ~190 and
  is now a thin dispatcher; each tool category lives in its own module under
  `src/tools/` (`connection`, `source`, `quality`, `lifecycle`, `discovery`,
  `cross-system`, `transports`, `runtime`, `data`, `request`). Shared helpers
  moved into `src/result.js`, `src/lock.js`, and `src/xml.js`. New tool
  modules follow the contract `export const tools` + `export function register(ctx)`,
  validated by `test/tools-shape.test.js`. No behavior changes for existing
  tools — every previous test still passes.

## [0.4.0]

### Added

- **Five Clean Core MCP prompts** — user-invokable slash commands that
  encode SAP's Clean Core extensibility framework and pair it with the
  `adt_*` tools so the model can act on real systems. None auto-fires;
  every prompt includes an applicability check that backs off on ECC and
  falls back to classic-ABAP idioms.
  - `clean_core_grade` — grade one object A/B/C/D, with refactor sketch
  - `clean_core_review` — package-wide KPIs (Clean Core Share, Tech Debt
    Score, top Level D offenders)
  - `clean_core_refactor` — mode-loading; loads wrapper / released-CDS /
    BAdI patterns
  - `clean_core_create` — mode-loading; defaults new objects to Level A
    (ABAP Cloud, RAP, business object interfaces)
  - `clean_core_design` — mode-loading; fit-to-standard + 3-phase
    methodology + on-stack vs side-by-side, no code writes
- **`skills/abap-clean-core/`** — long-form Clean Core reference shipped
  alongside the MCP. Five files (`SKILL.md` plus four deep-dives in
  `references/`): A/B/C/D level deep-dive, ABAP Cloud allowed/forbidden
  lists, the SAP Application Extension Methodology in detail, governance
  & KPI calculations. Optional install as an auto-loading Claude skill;
  the default repo behavior is prompt-only opt-in.

### Security

- **Path-traversal bypass of `readOnly`** (CRITICAL) — `isReadOnlyPostPath`
  ran `startsWith` on the raw path; `new URL()` later collapsed `../`
  segments, letting a write request smuggle in under a read-only
  allowlist entry. Fixed: path is now URL-normalized before the
  read-only check, and the same canonical path is used for the actual
  request.
- **`adt_request` confused-deputy** (CRITICAL) — the escape hatch
  accepted any path. The configured SAP credentials could be used
  against `/sap/opu/odata/...`, `/sap/bc/soap/rfc`, or any other ICF
  service. Fixed: paths are normalized and rejected if they don't sit
  under `/sap/bc/adt/`.
- **`Authorization` / `Cookie` / `X-CSRF-Token` override via
  `extraHeaders`** (HIGH) — caller-supplied headers were applied after
  the client-owned auth headers and overwrote them. Fixed: a
  `PROTECTED_HEADERS` allowlist drops these three before they reach
  `Headers.set`.
- **`adt_transport_diff` URI injection** (HIGH) — SAP-returned object
  URIs were used verbatim as the request path against both diff
  systems; a malicious entry with `../../../sap/bc/soap/rfc?...` could
  redirect the diff to non-ADT endpoints. Fixed: URIs are normalized
  and skipped (status `rejected-non-adt-uri`) if they don't resolve
  under `/sap/bc/adt/`.
- **`programType` XML attribute injection** (HIGH) in
  `adt_create_object` for programs — the field was concatenated into
  the XML body without escaping or validation, letting a caller close
  the attribute and inject elements (e.g., a second `packageRef`
  pointing at a different package). Fixed: validated against the
  SAP-published set (`executableProgram`, `modulePool`,
  `subroutinePool`, `functionGroup`, `interfacePool`, `classPool`,
  `typeGroup`, `include`) and run through `escapeXml` at the call site.

All five fixes have regression tests in `test/security.test.js`.

### Changed

- **Node.js minimum bumped to 22.19+.** The `undici@^8` dep already
  required Node 22.19+ in practice; the previous `engines.node: ">=18.17"`
  claim was unenforceable (any user on Node 18 or 20 would crash on the
  first ADT call). CI matrix moved from `[18, 20, 22]` to `[22, 24]`.

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
