---
name: dump-triage
description: Triage ABAP short dumps (ST22) — list recent dumps, group by root cause, read the dump chapters, pull the source at the termination point, and produce a prioritized report with a concrete fix suggestion per dump family. Use whenever the user mentions dumps, ST22, runtime errors, CX_ exceptions, "production crashed", TYPELOAD errors, "why did this ABAP terminate", or asks for a morning system-health check. Works fully in read-only mode — safe to run against production.
---

# Dump Triage

Turn a pile of ST22 short dumps into a short, prioritized action list. The
workflow is read-only end to end, so it is safe to point at production systems.

## Prerequisites

- **sap-adt-mcp ≥ 0.8.1** connected to the target system (`adt_ping` to verify).
- **NetWeaver 7.50+ or S/4HANA** recommended — the ADT runtime-dumps feed
  (`/sap/bc/adt/runtime/dumps`) is not exposed on older releases. If
  `adt_list_dumps` 404s, the system doesn't serve the feed; tell the user to
  use ST22 directly and stop.
- **SAP user authorizations:** runtime-dump display (typically S_ADT / basis
  display roles). No write authorizations needed.
- **Read-only mode: fully supported.** This skill never writes. If a fix is
  agreed and the user wants it applied, that's a separate (write-mode) edit via
  adt_set_source — confirm explicitly before leaving read-only territory.
- Date filters use `YYYYMMDD` on on-prem systems (e.g. `20260611`).

## Workflow

### 1. Collect

`adt_list_dumps` with a sensible window — default to the last 24h unless the
user says otherwise (`from: <yesterday YYYYMMDD>`). Filter by `user` only when
asked; note the user filter is enforced client-side. Respect `maxResults`
(default 20; raise for a weekly review).

### 2. Group before reading

Don't fetch every dump's detail. Group the list by `(runtimeError, program)` —
that pair defines a dump *family*. 200 `TYPELOAD_NEW_VERSION` entries from one
job are **one** problem, not 200. Rank families by:

1. frequency (count in window),
2. blast radius (PRD > QAS > DEV; batch users hitting it every minute),
3. severity of the error class (data-loss-ish errors like
   `CONVT_NO_NUMBER`, `ITAB_DUPLICATE_KEY` in update tasks rank above
   one-off `TIME_OUT`s).

### 3. Deep-read the top families

For the top 3–5 families: `adt_get_dump` with the family's most recent dump id.
The default chapter set (shortText, whatHappened, errorAnalysis, howToCorrect,
whereTerminated, sourceCodeExtract) is usually enough; request more chapters
only when the analysis is inconclusive.

From `whereTerminated`, extract program/include + line. Then pull real context:
`adt_get_source` for that include around the failing line (use
`firstLine`/`lastLine` — ±40 lines is plenty; never fetch a 20k-line program
whole). The dump's own sourceCodeExtract is narrow; the live source shows the
surrounding logic, and whether the code has changed since the dump
(`adt_list_versions` / `adt_compare_versions` when staleness is suspected).

### 4. Diagnose per family

State a root-cause hypothesis grounded in the chapters + source, not generic
advice. Typical patterns worth checking explicitly:

- **TYPELOAD_NEW_VERSION / LOAD_PROGRAM_*:** something was transported or
  activated while jobs were running — correlate with `adt_list_transports`
  (recently released) rather than blaming the code.
- **CX_SY_OPEN_SQL_DB / SQL errors:** read the failing statement; if data
  dependent, a targeted `adt_read_table` SELECT can confirm the offending rows
  (read-only, requires NW 7.55+).
- **CONVT_*, COMPUTE_*:** almost always unvalidated input — find the field's
  origin with the source context.
- **Untyped CX_ROOT in custom code:** check whether the raise site is in a Z
  object (`adt_where_used` helps trace callers).

### 5. Report

One block per family, ranked:

```
DUMP TRIAGE — DEV, last 24h (37 dumps → 4 families)

#1  TYPELOAD_NEW_VERSION — 29× — program SAPLZSD_PRICING — users: BATCH
    Cause: TR E4DK900812 released 02:14, jobs ZPRICE_RECALC were mid-run.
    Fix: none needed in code; reschedule the job after imports, or use
    server-group restart. Prevention: import window outside job schedule.

#2  CONVT_NO_NUMBER — 5× — ZRPT_MARGIN line 214
    Cause: CONV #( lv_input ) on a field fed from file upload; row 3 of the
    file contains '12,5' (comma decimal).
    Fix: validate/replace decimal separator before CONV — patch sketch below.
    …
```

Close with: which families are *ignorable* (one-offs, already-fixed code,
test-system noise) — saying what NOT to chase is half the value of triage.
Offer follow-ups: "want me to draft the fix for #2?" (write mode) or "schedule
this as a daily morning check".
