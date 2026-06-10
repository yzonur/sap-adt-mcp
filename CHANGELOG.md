# Changelog

All notable changes to this project will be documented in this file. Format
roughly follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to semantic versioning once it reaches 1.0.0.

## [Unreleased]

## [0.7.1]

### Fixed

- **`adt_search_objects` — 400 "Parameter ris_request_type could not be found".**
  Quick-search now goes over **GET** (the ADT Eclipse contract) instead of POST.
  The POST routed to the RIS object-search handler, which demanded a
  `ris_request_type` query parameter the tool never supplied; namespace,
  wildcard and plain-name searches were effectively broken on several systems.
  The legacy operation-less fallback is preserved.
- **`adt_read_table` — 406 ExceptionResourceNotAcceptable.** The Data Preview
  POST now sends `Accept: application/vnd.sap.adt.datapreview.table.v1+xml`, the
  only media type the endpoint serializes a result set as. Previously every
  row-returning SELECT failed content negotiation (column/syntax errors still
  came back as 400, so the endpoint was always reached).
- **`adt_where_used` — 400 "Content type missing".** The usageReferences POST
  now sends its `Content-Type`
  (`application/vnd.sap.adt.repository.usageReferences.request.v1+xml`), fixing
  where-used on DDIC tables and structures. Code-object where-used was
  unaffected.

### Changed

- The outgoing request `User-Agent` product token is now `sap-adt-mcp` (was
  `claude-for-abap`), matching the project rename.

## [0.7.0]

### Changed

- **Project renamed to `sap-adt-mcp`** (GitHub repo: `yzonur/sap-adt-mcp`,
  previously `claude-for-abap`). The npm package is now published as
  `sap-adt-mcp`; the old `claude-for-abap` package is deprecated but its
  existing installs keep working. Both `sap-adt-mcp` and `claude-for-abap`
  bin names are provided. The MCP server now identifies itself as
  `sap-adt-mcp` in the initialize handshake. No tool, prompt, or config
  changes — the config still lives at `~/.sap-adt-mcp/config.json`.

## [0.6.0]

The high-priority tool backlog, in one pass — eighteen new tools across six new
modules plus extensions to discovery and quality. Every tool was developed
against the on-prem E4D test system; the notes below mark which were verified
live against real ADT responses and which are best-effort against endpoints E4D
does not expose (they ship with graceful `available:false` degradation and are
genuinely useful on systems — typically S/4HANA — that do expose them).

### Added — source & analysis

- **`adt_grep_source`** — full-text regex search across ABAP source, the missing
  half of `adt_search_objects` (which only matches names). Scope to a package
  (optionally recursive), a transport, or an explicit object list; fetches
  `/source/main` for each source-bearing object (PROG/CLAS/INTF/INCL/DDLS/DCLS/
  DDLX/BDEF) and returns matching lines as object + line + text. Bounded by
  `maxObjects`/`maxMatches` with explicit truncation flags; unreadable objects
  surface under `errors` rather than failing the run. _Verified live on E4D._
- **`adt_run_atc_package` / `adt_run_atc_transport`** — bulk ATC via the full
  worklist flow (create worklist → run → fetch results), the container-level
  counterpart to the per-object `adt_run_atc`. Returns parsed findings
  (check/message/priority/location) plus a priority histogram and the worklist
  id. `checkVariant` defaults to the system check variant read from ATC
  customizing. _Verified live on E4D (345 findings over `/FGLR/FLEET`)._
- **`adt_compare_versions`** — diff two versions of one object's source within a
  system (defaults to inactive-vs-active — "what did I change but not activate").
  Reuses the `adt_compare_source` diff engine. _Verified live on E4D._
- **`adt_list_versions`** — version-history list via `{objectUri}/versions`.
  On-prem NetWeaver does not expose this sub-resource (E4D returns 404), so the
  tool reports `available:false` with a pointer to `adt_compare_versions`. _Best-
  effort; not available on E4D._

### Added — CDS

- **`adt_cds_data_preview`** — preview a CDS view's data by entity name (no SQL),
  reusing the data-preview parser. _Route verified live on E4D; positive preview
  unverified (E4D ships no CDS content)._
- **`adt_cds_dependencies`** — CDS dependency graph via the DDL graphdata
  endpoint, with optional related-objects. _Route verified live on E4D._
- **`adt_list_released_apis`** — the API release-state contract catalog
  (C0/C1/C2/C3 …) from `informationsystem/releasestates`. _Verified live on E4D
  (12 contracts)._

### Added — situational awareness

- **`adt_list_inactive_objects`** — the "Inactive Objects" worklist (edited but
  not activated), each object paired with its transport. _Verified live on E4D._
- **`adt_list_locks`** — SM12 runtime-enqueue analog. No standardized ADT REST
  exists for runtime enqueues; reports `available:false` with a hint to SM12.
  _Best-effort; not available on E4D._

### Added — experimental (no ADT REST on E4D — ship with graceful degradation)

- **`adt_get_note` / `adt_check_note_status` / `adt_implement_note`** — SAP Note
  (Note Assistant) integration. Requires the SNOTE ADT plug-in (modern S/4HANA);
  classic NetWeaver returns `ExceptionResourceNotFound`, surfaced as
  `available:false`. `adt_implement_note` is write-gated. _Graceful path verified
  on E4D; positive paths unverified._
- **`adt_schedule_job` / `adt_read_spool`** — SM36/SP01 analogs. No standardized
  ADT background-processing API; reports `available:false` on systems without an
  extension service. _Graceful path verified on E4D._

### Added — generation

- **`adt_rap_scaffold`** — generate a full RAP stack from a short spec: CDS root
  view entity → behavior definition (managed) → behavior implementation class →
  service definition → service binding. **Defaults to `dryRun:true`** — returns
  the planned names and generated source for review without creating anything;
  `dryRun:false` creates the source-based artifacts in dependency order
  (read-only-gated, halts on first failure). The service binding is always
  plan-only (its publish step is not automated). _Generation/dry-run verified on
  E4D; write path unverified (object creation was out of scope for this pass)._

### Changed

- **Per-request timeout override.** `AdtClient.request` now accepts an optional
  `timeoutMs` to override the profile default for a single call. Bulk ATC uses a
  120 s ceiling — a whole-package run executes synchronously server-side and
  routinely exceeds the 30 s default.
- **Read-only allowlist** now permits `POST /sap/bc/adt/atc/*` (worklist analysis)
  and `POST /sap/bc/adt/datapreview/*` (SELECT/CDS preview). Both are read-only in
  spirit — they execute no object changes — and were previously blocked in
  read-only mode, which also affected the existing `adt_run_atc` and
  `adt_read_table`.
- **`object-uris.js`** gained `SRVD` (service definition) and `SRVB` (service
  binding) type mappings, used by the RAP scaffold and available to all
  URI-resolving tools.

## [0.5.5]

Four MCP-seam bugs surfaced while creating DDIC objects (`/FGLR/DM_FLTTRSCNR`,
`/FGLR/DE_FLTTRSCNR`) on on-prem E4D for the Fleet Transfer scenario refactor.
All four are input-validation / shortcut gaps that turned recoverable mistakes
into opaque crashes. Tests in `test/mcp-bug-fixes.test.js`.

### Added

- **`adt_request.contentType`** — top-level shortcut for the `Content-Type`
  header, mirroring `accept`. Folds into `headers["Content-Type"]`; an explicit
  `headers["Content-Type"]` still wins. Previously callers had to know to set
  `headers` and got a silent 415 when they reached for the obvious `contentType`
  field.

### Fixed

- **`adt_get_transport` / `adt_release_transport` crash on wrong field name.**
  Both handlers now validate `args.transport` is a non-empty string before
  calling `.toUpperCase()` and return a textResult that names the correct field
  (so callers passing `transportId` get a useful error, not
  `Cannot read properties of undefined`).
- **`adt_search_objects` 500 on systems without `quickSearch`.** Detects the
  500 body match `/No service found for ID quickSearch/i` and retries the same
  endpoint without the `operation` query (legacy informationsystem/search
  shape). Response carries `operation: "legacy"` when the fallback fires.
- **`adt_activate` opaque error on wrong argument shape.** Validates `objects`
  is a non-empty array of `{name, type}` before iterating. Callers passing the
  singular `objectName` / `objectType` shape now get a clear hint instead of
  `Cannot read properties of undefined (reading 'map')`.

## [0.5.4]

Seven bugs surfaced in one real-world ABAP refactor session against a ~147 KB
class (`/FGLR/CL_FLEET_TRANSFER`) on on-prem E4D. All sit at the MCP↔ADT seam
and were invisible to the pure-unit-test suite. Full write-up in
[docs/bugfix-2026-05-15.md](docs/bugfix-2026-05-15.md).

### Added

- **`adt_set_source_chunked`** — multi-call protocol for writing class bodies
  that exceed a single MCP tool-call payload. Caller acquires the lock with
  `adt_lock`, sends chunks under a stable `bufferId` with sequential
  `chunkIndex`, commits with `commit=true`. Server-side buffer with 10-min TTL,
  4 MB total cap, strict ordering. Partial-source guard runs at commit.
- **`adt_get_source.firstLine` / `lastLine` / `onlyMethod`** — pagination and
  method-scope slicing. Response now reports `totalLines`, `totalBytes`,
  `firstLine`, `lastLine`, `scope`, `truncated`. `onlyMethod` is case-insensitive
  and skips declarations in `CLASS … DEFINITION`.
- **`adt_set_source.acknowledgePartial`** — explicit bypass for the new
  partial-write guard (Fixed below).
- **`adt_activate.processRedoneOOSourceVersionOnly` / `preauditRequested`** —
  forwarded to ADT as `isProcessRedoneOOSourceVerOnly=true` / `preauditRequested`.
  Recovers from "Object components locked in request and separate task" 403s
  in multi-developer transports.
- **`adt_lock.transport`** — forwards as `corrNr=<TR>` to scope the lock to a
  specific transport. `adt_set_source` and `adt_delete_object` now forward
  their `transport` parameter to the LOCK call as well, not just to the
  PUT/DELETE.

### Fixed

- **`adt_set_source` partial-write guard.** PUT on ADT is atomic — it replaces
  the entire include. Previously a caller could send a chunk thinking it was a
  diff and silently delete the rest of the include. `detectPartialSource()`
  now rejects input whose first non-comment line is not a recognised
  top-level ABAP keyword (`CLASS`, `INTERFACE`, `REPORT`, `PROGRAM`,
  `FUNCTION`, `FORM`, `MODULE`, `METHOD`, `DEFINE`, `DATA`, …). Bypass with
  `acknowledgePartial: true`.
- **`parseAdtError` no longer drops CTS diagnostics.** ADT lock failures
  carry `LONGTEXT` (human-readable diagnosis) and `T100KEY-V1..V4` (the
  blocking transport's ID, owner, suggested resolution) in either
  `<entry key="…">` or `<property name="…">` shapes. Both are now extracted
  (HTML-stripped) and surfaced as `error.properties.longText` and
  `error.properties.t100.{id, number, vars}`.

### Investigated

- **Method-scope class URI does not exist.** Seven variants of
  `/sap/bc/adt/oo/classes/<class>/includes/method/<method>` all return 404 —
  SAP's ADT REST has no method-scope source endpoint. ADT in Eclipse fetches
  the full implementations include and navigates client-side. The new
  `adt_get_source.onlyMethod` parameter is the practical equivalent.

### Tests

54 new unit tests across `test/source-guard.test.js`,
`test/source-pagination.test.js`, `test/source-chunked.test.js`,
`test/lifecycle-activate.test.js`, `test/lock.test.js`, plus extensions to
`test/adt-error.test.js`. Suite at 141/141.

## [0.5.3]

Hot-fix for a CSRF handshake bug that broke every state-changing tool against
on-prem ADT. Verified against E4D.

### Fixed

- **CSRF discovery handshake no longer strips its own `Fetch` header.** The
  `PROTECTED_HEADERS` filter on `#send` (added in the adt_request security
  pass to stop callers from forging `Authorization` / `Cookie` /
  `X-CSRF-Token`) was also stripping the `X-CSRF-Token: Fetch` header that
  `#fetchCsrf` itself attaches to the discovery GET. SAP returned the
  AtomSvc service document without a token, and every write (`adt_create_object`,
  `adt_set_source`, `adt_activate`, `adt_lock`, `adt_create_transport`,
  `adt_delete_object`, `adt_release_transport`, `adt_pretty_print`, ATC runs)
  failed with `Failed to fetch CSRF token (status 200): <?xml ...>`. The fix
  routes the internal Fetch header through a separate `internalHeaders`
  channel that bypasses the filter; caller-supplied `X-CSRF-Token` from
  `adt_request` is still stripped. Two undici `MockAgent` regression tests
  pin both sides.

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
