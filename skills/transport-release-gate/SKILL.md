---
name: transport-release-gate
description: Run a quality gate over an SAP transport request before it is released — collect the TR's objects, check for inactive objects and foreign locks, run syntax checks, ATC, and unit tests, then produce a structured go/no-go report. Use whenever the user wants to release a transport, asks "is this TR safe to release?", mentions transport quality, release checklists, pre-release validation, or CI/CD for ABAP. Also applies when reviewing someone else's transport before import into QAS/PRD. The gate only reads and checks by default — the actual release stays a human decision unless the user explicitly asks to release.
---

# Transport Release Gate

A pre-release quality gate for SAP transport requests, built from sap-adt-mcp
tools. The philosophy: **the gate decides "ready or not"; the human decides
"release"**. Never call `adt_release_transport` unless the user explicitly asks
for the release after seeing the report.

## Prerequisites

- **sap-adt-mcp ≥ 0.8.1** connected to the target system (`adt_ping` to verify).
- **NetWeaver 7.50+ or S/4HANA** recommended. The core flow (transport read,
  syntax check, ATC worklist) works on most 7.4x+ systems, but ATC worklist
  endpoints vary across releases — if `adt_run_atc_transport` fails, fall back
  to per-object `adt_run_atc`.
- **ATC configured** on the system: a check variant must exist. The tool uses
  the system default variant when none is passed; if the system has none,
  ask the user for a variant name (often `DEFAULT` or a Z variant).
- **SAP user authorizations:** display for repository objects (S_DEVELOP
  display), transport read (S_TRANSPRT), ATC execution. Release additionally
  needs transport release authorization — only relevant if the user requests it.
- **Read-only mode is enough for ~90% of the gate:** transport read, syntax
  check (`/checkruns`), and ATC (`/atc/`) are whitelisted read-only POSTs.
  **Unit tests (`adt_run_unit_tests`) require write mode** — in read-only mode,
  skip them and note that in the report. `adt_release_transport` obviously
  requires write mode too.

## Workflow

Run the steps in order; collect findings as you go instead of stopping at the
first problem — the report should show everything wrong at once.

### 1. Resolve the transport

`adt_get_transport` with the TR id. Verify it exists and is **modifiable**
(already-released TRs can't be gated — say so and stop). Extract the object
list. If the TR is empty, report "nothing to check" and stop.

### 2. Cheap structural checks first

- `adt_list_inactive_objects` — any object of this TR still inactive is an
  instant **NO-GO** (released TRs with inactive objects import broken).
- `adt_list_locks` — objects locked by *other* users/TRs indicate parallel
  work in flight; flag as a warning with the blocking TR if visible.
- Optionally `adt_transport_diff` against the target system (if a second
  system is configured) to preview what would change on import.

### 3. Syntax check

For each ABAP source object in the TR (programs, classes, function groups,
includes): `adt_syntax_check`. For includes pass `context` (the main program)
— without it the check returns `notProcessed`. Any syntax **error** is a
NO-GO; warnings are findings.

### 4. ATC

`adt_run_atc_transport` with the TR id — one call covers every object. Use the
priority histogram: **priority 1 findings are NO-GO**, priority 2 are NO-GO
unless the user's organization tolerates them (ask once if unclear), priority 3
are listed as advisories. If the abap-clean-core skill is available, classify
findings against the clean-core levels for richer framing.

### 5. Unit tests (write mode only)

For classes in the TR that have test classes: `adt_run_unit_tests`. Any failed
assertion is a NO-GO. In read-only mode, skip and record "unit tests not run
(read-only mode)" in the report — never silently omit.

### 6. The report

Produce a compact verdict block first, then details:

```
TRANSPORT GATE — E4DK900123 (system DEV)
Verdict: NO-GO  (2 blockers, 3 warnings)

Blockers
1. ZCL_INVOICE_POSTING — inactive object
2. ZSD_PRICING_UPD — ATC priority 1: SELECT in loop (CI_DYNPRO check)

Warnings
…

Checked: 14 objects | syntax 14/14 ok | ATC: 1×P1 2×P2 5×P3 | tests: 12 passed
```

End with next actions: what to fix for each blocker, and — only if the verdict
is GO — offer the release: "Say 'release it' and I'll run
`adt_release_transport`." On an explicit release request, run it, then verify
with `adt_get_transport` that the status flipped to released.

## Failure handling

- ATC endpoint shape varies by release — on persistent ATC errors, degrade to
  syntax-check-only mode and mark the report "ATC unavailable on this system".
- Never treat a tool error as a clean check: a check that errored is
  **unknown**, not passed. Show it in the report as such.
