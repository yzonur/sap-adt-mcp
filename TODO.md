# claude-for-abap — backlog

Feature ideas surfaced during the v0.5 design discussion (2026-05-13). Sections
follow priority. The SessionStart hook (`~/.claude/show-active-todos.ps1`)
surfaces any `### ` section that still has unchecked items at the top of the
next session, so keep section headings stable and check items off as they
land — don't rewrite the file structure unless you mean to.

### Tool additions — high priority

- [ ] `adt_grep_source` — full-text source search (regex) scoped to package / TR / system. Today `adt_search_objects` only matches names; this is the missing half. Needed for Clean Core grading to actually inspect code patterns at scale.
- [ ] `adt_list_versions` + `adt_compare_versions` — ADT versions API (`/versions`). Diff active vs inactive, or current vs previous. "Who/when last changed this method" is a daily question.
- [ ] `adt_run_atc_package` / `adt_run_atc_transport` — bulk ATC by container. Current `adt_run_atc` is per-object; real workflows run ATC for a whole TR or package. The `clean_core_review` prompt is currently hamstrung by this gap.
- [ ] `adt_get_note` + `adt_implement_note` + `adt_check_note_status` — SAP Note (SNOTE) integration. Devs spend a lot of time here; agent value is high.
- [ ] `adt_cds_dependencies` + `adt_cds_data_preview` + `adt_list_released_apis` — CDS-specific tooling. Modern SAP is CDS-first; agent currently can't answer "which released views exist" or "what does this CDS expose."
- [ ] `adt_list_locks` (SM12 analog) + `adt_list_inactive_objects` — "what's locked / what's not yet active in this package" — basic situational awareness.
- [ ] `adt_schedule_job` + `adt_read_spool` — background job submit + read its spool output. Necessary for long-running tasks (migrations, mass updates).
- [ ] `adt_rap_scaffold` — generate a full RAP stack (CDS + behavior def + service def + service binding + implementation class) from a spec. Builds on the existing `adt_create_object` primitives. Would make `/clean_core_create` actually one-shot for the modern flow.

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
