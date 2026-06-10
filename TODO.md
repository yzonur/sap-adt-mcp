# sap-adt-mcp — backlog

Feature ideas surfaced during the v0.5 design discussion (2026-05-13). Sections
follow priority. The SessionStart hook (`~/.claude/show-active-todos.ps1`)
surfaces any `### ` section that still has unchecked items at the top of the
next session, so keep section headings stable and check items off as they
land — don't rewrite the file structure unless you mean to.

### MCP tool bug fixes — discovered & fixed 2026-05-15

Bugs surfaced while working with `/FGLR/CL_FLEET_TRANSFER` (~147 KB class) against
the E4D test system. All seven verified against current code and resolved.

- [x] **Bug 3 — `adt_set_source` partial-write guard.** Added `detectPartialSource()` in `src/tools/source.js` plus `acknowledgePartial` bypass flag. Tool description now warns about atomic replace. Unit tests in `test/source-guard.test.js`.
- [x] **Bug 5 — `adt_lock` strips LONGTEXT + T100KEY from CTS errors.** `parseAdtError` in `src/adt-error.js` now extracts `<entry key="LONGTEXT">` / `<property name="LONGTEXT">` (HTML-stripped) plus `T100KEY-ID/NO/V1..V4`. Surfaced as `error.properties.longText` / `error.properties.t100`. Tests in `test/adt-error.test.js`.
- [x] **Bug 6 — `adt_lock` doesn't accept `corrNr`.** `adt_lock` schema now exposes `transport`. `acquireLock(client, path, options)` accepts `{ accessMode, corrNr }` (string second arg still works). `adt_set_source` and `adt_delete_object` also forward `transport` to the LOCK call for symmetry. Tests in `test/lock.test.js`.
- [x] **Bug 2 — `adt_activate` missing `processRedoneOOSourceVersionOnly`.** Schema now exposes `processRedoneOOSourceVersionOnly` (→ `isProcessRedoneOOSourceVerOnly=true` on query) and `preauditRequested` override. Tests in `test/lifecycle-activate.test.js`.
- [x] **Bug 4 — `adt_get_source` has no pagination.** Added `firstLine` / `lastLine` (clamped to source bounds) and `onlyMethod` parameters. Response now includes `totalLines`, `totalBytes`, `firstLine`, `lastLine`, `scope`, `truncated`. Tests in `test/source-pagination.test.js`.
- [x] **Bug 1 — `adt_set_source` body cap blocks large classes.** Added `adt_set_source_chunked` tool: caller acquires lock with `adt_lock`, sends chunks with stable `bufferId` + sequential `chunkIndex`, commits with `commit=true`. Server-side buffer with 10-min TTL, 4 MB cap, out-of-order rejection, partial-source guard at commit. Tests in `test/source-chunked.test.js`.
- [x] **Bug 7 — method-level class URI.** Investigation: SAP backend does not expose a method-scope source endpoint — ADT Eclipse fetches the full implementations include and navigates client-side. The `onlyMethod` parameter on `adt_get_source` (added by Bug 4) is the practical equivalent: server fetches the include, slices the METHOD … ENDMETHOD block client-side and returns just that slice with line metadata.

### MCP tool bugs — discovered & fixed 2026-05-22

Surfaced while creating DDIC domain + DE (`/FGLR/DM_FLTTRSCNR`, `/FGLR/DE_FLTTRSCNR`) on E4D for Fleet Transfer scenario refactor. All four resolved; tests in `test/mcp-bug-fixes.test.js`.

- [x] **`adt_request` silently drops `contentType` parameter.** Added top-level `contentType` shortcut in `src/tools/request.js` mirroring `accept`. Handler folds it into `headers["Content-Type"]`; an explicit `headers["Content-Type"]` still wins.
- [x] **`adt_get_transport` crashes on the `transportId` parameter.** `src/tools/transports.js` now validates `args.transport` before `.toUpperCase()` and returns a textResult error pointing out the correct field name. Same guard added to `adt_release_transport`.
- [x] **`adt_search_objects` returns 500 "No service found for ID quickSearch" on E4D.** `src/tools/discovery.js` now detects the 500 body match `/No service found for ID quickSearch/i` and retries the same endpoint without the `operation` query (legacy informationsystem/search shape). Response carries `operation: "legacy"` so the caller can tell the fallback fired.
- [x] **`adt_activate` schema error message is opaque.** `src/tools/lifecycle.js` validates `objects` is a non-empty array of `{name, type}` before iterating and returns a friendly textResult — including a hint about the wrong singular `objectName`/`objectType` shape.

### Tool additions — high priority

_All shipped in v0.6.0 — released to GitHub (tag v0.6.0) and published to npm on
2026-06-02. Endpoints absent on the E4D test system (SNOTE, SM12 locks,
jobs/spool) ship as best-effort with graceful `available:false` degradation —
useful on S/4 systems that expose them, unverified there. See CHANGELOG 0.6.0
for the per-tool live-verified vs best-effort breakdown._

- [x] `adt_grep_source` — full-text source search (regex) scoped to package / TR / system. _Verified live on E4D._
- [x] `adt_list_versions` + `adt_compare_versions` — ADT versions API. compare = inactive-vs-active source diff (_verified live_); list = graceful `available:false` (no `/versions` REST on E4D).
- [x] `adt_run_atc_package` / `adt_run_atc_transport` — bulk ATC by container via the full worklist flow. _Verified live on E4D (345 findings)._
- [x] `adt_get_note` + `adt_implement_note` + `adt_check_note_status` — SAP Note (SNOTE) integration. _Best-effort; needs the SNOTE ADT plug-in (S/4), absent on E4D._
- [x] `adt_cds_dependencies` + `adt_cds_data_preview` + `adt_list_released_apis` — CDS tooling. released-APIs + dependency/preview routes _verified live on E4D_ (positive preview needs CDS content E4D lacks).
- [x] `adt_list_locks` (SM12 analog) + `adt_list_inactive_objects` — inactive-objects _verified live_; SM12 locks graceful `available:false` (no enqueue REST on E4D).
- [x] `adt_schedule_job` + `adt_read_spool` — background job submit + spool read. _Best-effort; no ADT background-processing REST on E4D._
- [x] `adt_rap_scaffold` — generate a full RAP stack (CDS + behavior def + impl class + service def + service binding) from a spec. Defaults to `dryRun:true`. _Generation verified live; write path unverified (creation out of scope this pass)._

### Tool additions — nice-to-have

- [ ] `adt_value_help` — F4 / domain fixed values / check-table contents.
- [ ] `adt_auth_check` — SU24 auth objects required by a transaction / object.
- [ ] Code-intelligence pack — method-level call hierarchy, interface implementations, redefined methods, type hierarchy. `adt_where_used` is the broad sweep; agent needs the surgical version.
- [ ] `adt_translations` — long texts for messages / classes (SE63 lite).
- [ ] `adt_system_info` — release, SP level, S/4 vs ECC, ABAP Cloud availability. Clean Core prompts currently guess at this via heuristics; with a real signal the ECC backoff becomes deterministic.
- [ ] `adt_transport_queue` — STMS import buffer status. "Where is TR X right now — DEV, in QAS buffer, imported into PRD?"
- [ ] `adt_compare_ddic` — DDIC metadata diff (fields, indexes, foreign keys, technical settings). Today only source can be compared cross-system; for tables that's not enough.

### Structural improvements

- [ ] MCP `resources` registration — expose the system list, open TRs, recent dumps as live resources so an agent can see them without burning a tool call.
- [ ] Integration tests with an undici interceptor — happy/error paths for CSRF retry, read-only enforcement, lock orchestration. All current tests are pure-unit; the wire layer is unverified.
- [ ] Read-only result cache (30 s – 2 min TTL) for repeated calls in a single agent session. `list_packages`, `search_objects`, `list_systems` are the obvious wins.
- [ ] Cost / token awareness — soft output caps for large lists, "top N + summary" mode, opt-in `full=true`. A reckless `list_packages` against a big root currently floods context.
- [ ] ECC-specific prompt set — `classic-abap-review`, `modification-audit`, `user-exit-finder`. Clean Core prompts are S/4-only and ECC shops get less day-one value than they could.
- [ ] **mcp-whereused-ddic-structure** — `adt_where_used` DDIC structure (type=table, TADIR TABL) için 400 "Content type missing" döndürüyor. Tool: `adt_where_used`. Repro: `{object:'/FGLR/S_MEAS_CHARACTERISTIC', type:'table', system:'E4D'}`. Beklenen: usage references listesi. Dönen: HTTP 400 ExceptionResourceBadRequest. Muhtemelen request'te `Content-Type` header'ı eksik gönderiliyor. Tarih: 2026-05-22.

- [ ] **mcp-search-namespace-param** — adt_search_objects namespace-prefixed query (`/FGLR/CL_MR_ATTACHMENT`) returns tool-side `ExceptionParameterNotFound: ris_request_type could not be found` (HTTP 400) instead of results. Tool: `adt_search_objects`. Repro: `query=/FGLR/CL_MR_ATTACHMENT system=E4D`. Expected: object list (or empty); same object resolves fine via adt_get_source (404/200). Date: 2026-06-03.

- [ ] **mcp-readtable-406-accept** — adt_read_table fails before running the SELECT with HTTP 406 `ExceptionResourceNotAcceptable` ("Accepted content types: application/vnd.sap.adt.datapreview.table.v1+xml"). Likely wrong/missing Accept header on the Data Preview POST. Tool: `adt_read_table`. Repro: `query=SELECT text FROM t100 WHERE arbgb='/FGLR/MR_ORDER' AND msgnr='034' system=E4D`. Expected: { columns, rows }; got 406 content-negotiation error. Date: 2026-06-03.
- [ ] **mcp-search-ris-request-type** — Obje araması 400 dönüyor: "Parameter ris_request_type could not be found" (E4D). Tool: `adt_search_objects`. Repro: `{query: "/FGLR/VC_ATTR"}`. Beklenen: sonuç listesi; dönen: 400 ExceptionParameterNotFound. Aynı arama `adt_request` GET informationsystem/search?operation=quickSearch ile çalışıyor — tool muhtemelen eski/eksik query parametresi gönderiyor. Tarih: 2026-06-05.
- [ ] **mcp-read-table-accept-header** — `adt_read_table` 406 dönüyor: "Accepted content types: application/vnd.sap.adt.datapreview.table.v1+xml" (E4D). Tool: `adt_read_table`. Repro: `{query: "SELECT * FROM VCLDIR WHERE VCLNAME = '/FGLR/VC_ATTR'"}`. Beklenen: satırlar; dönen: 406 — Accept header yanlış/eksik. Workaround: adt_request POST /sap/bc/adt/datapreview/freestyle + doğru Accept. Tarih: 2026-06-05.

- [ ] **mcp-datapreview-406** — adt_read_table 406s on EVERY row-returning SELECT (reproducible, not transient): "Accepted content types: application/vnd.sap.adt.datapreview.table.v1+xml". Queries that fail column/syntax validation return a proper 400, so the endpoint is reached — the 406 hits only when a successful result set would be serialized → tool likely sends the wrong Accept header for the data-preview response. Effectively no table data can be read on USD. Tool: `adt_read_table`. Repro: `SELECT sap_object, ar_object, archiv_id FROM toaom WHERE sap_object = 'BUS2032'` and `SELECT domname, datatype, leng FROM dd01l WHERE domname = 'SAEARDOID'` on USD → 406; same query with a bogus column → 400. WORKAROUND (confirmed working): bypass the tool, call the endpoint directly — `adt_request` POST `/sap/bc/adt/datapreview/freestyle?rowNumber=N` with `accept: application/vnd.sap.adt.datapreview.table.v1+xml`, `contentType: text/plain`, body = the SQL SELECT → returns `<dataPreview:tableData>` XML with rows. So the fix in the MCP tool is just to send that Accept header. Tarih: 2026-06-08.
- [ ] **mcp-search-ris-request-type** — adt_search_objects fails on USD with 400 "Parameter ris_request_type could not be found" (T100 SADT_RESOURCE/017), with and without `objectType`. Tool seems to omit a required query param (`ris_request_type`) the server expects on this system. Effectively object name search is unavailable on USD. Tool: `adt_search_objects`. Repro: `query='ARCHIVOBJECT_CREATE_TABLE'` (and with `objectType='FUGR/FF'`) on USD → 400. Workaround: use `adt_get_source` with a known group, or `adt_grep_source` over an explicit object list. Tarih: 2026-06-08.

### MCP tool bugs (sap-adt)

- [ ] **mcp-search-ris-request-type** — `adt_search_objects` namespace/wildcard pattern'lerinde server 400 döndürüyor. Tool: `adt_search_objects`. Repro: `query="*VC_ATTR*"` veya `query="/FGLR/VC_ATTR*"` (system E4D). Beklenen: obje listesi. Dönen: `400 ExceptionParameterNotFound "Parameter ris_request_type could not be found."`. Workaround: `GET /sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=...` raw çalışıyor. Tarih: 2026-06-09.
- [ ] **mcp-readtable-406** — `adt_read_table` geçerli kolon listesi + WHERE ile bile 406 veriyor; içerik müzakeresi (Accept/Content-Type) yanlış gönderiliyor. Tool: `adt_read_table`. Repro: `query="SELECT vclname FROM vcldir WHERE vclname = '/FGLR/VC_ATTR'"` (system E4D). Beklenen: rows. Dönen: `406 ExceptionResourceNotAcceptable "Accepted content types: application/vnd.sap.adt.datapreview.table.v1+xml"`. Not: kolon/syntax hataları (400) server'a ulaşıyor ama valid query 406. Workaround: `POST /sap/bc/adt/datapreview/freestyle` body=SQL (text/plain), Accept=...table.v1+xml sorunsuz. Tarih: 2026-06-09.
