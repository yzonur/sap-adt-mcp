---
name: legacy-code-doc
description: Reverse-document legacy ABAP — read a Z program/class/function group end to end, map its structure, database touchpoints, callers, and side effects, and produce structured documentation (purpose, flow, interfaces, data, risks). Use whenever the user asks "what does this program do", wants documentation for undocumented custom code, is onboarding onto an unfamiliar codebase, planning an S/4HANA migration impact analysis, or preparing a rewrite/retirement decision for old Z code. Fully read-only — safe on production.
---

# Legacy Code Documentation

Produce documentation for ABAP objects that have none. The output is for two
audiences at once: a developer who must change the code next month, and a
manager deciding whether it survives the next migration.

## Prerequisites

- **sap-adt-mcp ≥ 0.8.1** connected to the target system (`adt_ping` to verify).
- **NetWeaver 7.4x+** — only core ADT read endpoints are needed (source read,
  search, where-used). `adt_read_table` examples additionally need **NW 7.55+**;
  skip data sampling on older systems.
- **SAP user authorizations:** repository display only (S_DEVELOP display).
- **Read-only mode: fully supported** — this skill never writes to SAP. (It may
  write the documentation to a local file if the user asks.)
- **Large sources:** `adt_get_source` output is capped per call (~64 KB). For
  big programs paginate with `firstLine`/`lastLine`, or slice with
  `onlyMethod`. Never assume one call returned the whole object — check
  `truncated`/`totalLines`.

## Workflow

### 1. Scope the object

`adt_search_objects` if only a fuzzy name is known. Identify the object type —
the strategy differs:

- **Program (PROG):** fetch the main source, then list its includes
  (`adt_browse_package` on its package, or INCLUDE statements from source) and
  fetch each include that carries logic.
- **Class (CLAS):** fetch `definitions` first (the public contract), then
  `implementations` method by method (`onlyMethod`) for the ones that matter.
- **Function group (FUGR):** document each function module separately
  (`adt_get_source` with type function + group); shared TOP include for state.

### 2. Read with a checklist

While reading, collect — don't paraphrase line by line:

- **Entry points:** events (START-OF-SELECTION, user-commands), public
  methods, FM interfaces, selection screen parameters.
- **Database touchpoints:** every table read (SELECT/JOIN) and **especially
  every write** (INSERT/UPDATE/MODIFY/DELETE, CALL FUNCTION ... IN UPDATE
  TASK). Writes are the risk register.
- **External calls:** RFCs, BAPIs, file I/O (OPEN DATASET, GUI_*), HTTP,
  authority-checks, COMMIT/ROLLBACK placement.
- **Configuration coupling:** hardcoded values, TVARV/Z-config table reads,
  sy-mandt/sy-sysid branching.
- **Smells worth flagging:** SELECT in loops, missing authority checks before
  writes, swallowed exceptions, dead branches (`adt_grep_source` across the
  package helps find copy-paste siblings).

### 3. Map the blast radius

- `adt_where_used` on the main object: who calls this? A "legacy" report
  called by 14 other programs is infrastructure, not legacy.
- `adt_list_versions` / `adt_compare_versions`: when was it last touched, how
  actively does it change? (Stable-for-8-years and changed-monthly need very
  different documentation depth.)
- Optional, NW 7.55+: one or two `adt_read_table` samples on its Z tables to
  show real data shapes (row counts, key examples) — ask before querying
  business data, and keep samples small.

### 4. Write the document

Structure (trim sections that don't apply):

```markdown
# <OBJECT> — <one-line purpose>

## What it does            (3–6 sentences, business language)
## How it's triggered      (jobs, transactions, callers — from where-used)
## Inputs / outputs        (selection screen, interfaces, files, spool)
## Data                    (tables READ / tables WRITTEN — writes first, bold)
## Control flow            (numbered happy path; branches that matter)
## External dependencies   (RFCs, BAPIs, files, config tables)
## Risks & smells          (each with file:line references)
## Change history signal   (last N versions: who, when, what theme)
## Migration notes         (S/4 readiness: deprecated statements, obsolete FMs —
                            apply the abap-clean-core skill's levels if loaded)
```

Cite everything as `INCLUDE/METHOD:line` so the next developer can jump
straight in. If the user wants the doc persisted, write it to a local markdown
file named after the object.

### 5. Batch mode

For "document the whole package": `adt_browse_package` to enumerate, then
triage — document deeply only objects with DB writes or many callers; one-line
summaries for trivial ones. State the triage rule in the output so nobody
mistakes a one-liner for a full review.
