---
name: abap-clean-core
description: Apply SAP Clean Core extensibility principles whenever the user writes, reviews, refactors, or designs ABAP code for SAP S/4HANA — any deployment (Public Cloud, Private Cloud, on-premise). Use this skill any time the conversation involves ABAP extensions, custom Z-code, BAdIs, BAPIs, user exits, CDS views, RAP services, custom fields or business objects, modifications, enhancements, ATC findings, the Cloudification Repository, ABAP Cloud vs classic ABAP, on-stack vs side-by-side architecture, RISE/GROW with SAP, BTP extensions, or migrating legacy ABAP toward ABAP Cloud. Trigger generously — even when the user just mentions terms like "modification," "user exit," "enhancement spot," "implicit enhancement," "Z-program," "Z-table," "released API," "internal SAP object," "upgrade-safe," "S/4HANA migration," "clean core," "fit-to-standard," "BTP first," or "technical debt in ABAP," this skill is almost certainly relevant. Better to load it and stay quiet than to miss the context.
---

# ABAP Clean Core

This skill encodes SAP's official Clean Core extensibility framework. Apply it when guiding the user through ABAP development, code review, refactoring, or architecture decisions for SAP S/4HANA.

## Why Clean Core matters

Every extension that touches SAP-internal objects, modifies standard code, or relies on undocumented APIs becomes a maintenance liability. It blocks upgrades, breaks unpredictably, and accumulates as technical debt that compounds over years.

Clean Core is the discipline of building extensions that survive SAP upgrades automatically — by isolating custom code from the standard through stable, released interfaces. It's not theoretical: SAP's entire cloud strategy (RISE, GROW, S/4HANA Cloud) assumes customer extensions are decoupled. Code that ignores Clean Core is code that will eventually be rewritten.

Clean Core spans **five principles** — Processes, Data, Integration, Operations, and Extensibility. This skill focuses on Extensibility (the code and architecture side), but be aware: when a user asks about "clean core data" or "clean core integration," they're asking about the other four principles, not about extensions.

When you help with ABAP, your job is to nudge the user toward extensions that will still work after the next upgrade — without lecturing, without refusing classic-ABAP work when it's needed, but always making the trade-off visible.

## Two strategic tracks: Stay Clean & Get Clean

All clean core work falls into one of two efforts. Naming which one the user is in helps frame the advice.

### Stay Clean — preventing new technical debt

Applies to **new development**. The goal is zero unnecessary debt: every new extension at the highest achievable level, governed by a process that catches violations before they ship. When the user is writing or designing something new, you're in Stay Clean mode — enforcement-heavy, with quality gates blocking transport on Level 1–2 ATC findings.

### Get Clean — reducing existing technical debt

Applies to **existing custom code**. Realistic, prioritized reduction over years — eliminate Level D first ("Level D zero" is a year-one goal), then chip away at C and B. When the user is reviewing legacy or planning remediation, you're in Get Clean mode — prioritization-heavy, with tactics like the boy scout principle (every developer leaves code cleaner than they found it), the lighthouse approach (clean during major rework anyway), and a 10% annual reduction target.

For the full Stay Clean / Get Clean playbook, KPI calculations, and exemption process, see `references/governance.md`.

## The four cleanliness levels

Every ABAP extension sits in exactly one of four "cleanliness levels." Identifying the level — and pushing it upward when possible — is the entire framework.

### Level A — Released APIs (the goal)
- Uses publicly released APIs with formal stability contracts
- ABAP Cloud development model on-stack, or SAP Build / CAP / ABAP Cloud on BTP side-by-side
- ATC behavior: no finding
- Upgrade-safe by SAP guarantee

**Examples:** released CDS views, business object interfaces, released BAdIs, RAP services, OData APIs documented in the SAP Business Accelerator Hub, custom fields via the Custom Fields app or extension framework.

### Level B — Classic APIs (acceptable when needed)
- Documented, historically stable APIs without a formal stability contract
- Examples: BAPIs (e.g., `BAPI_PO_CREATE1`), released user exits, classic ALV grid (`CL_GUI_ALV_GRID`), traditional Web Dynpro
- ATC behavior: priority 3 (informational)

Use Level B when no Level A equivalent exists. Whenever possible, **wrap Level B calls in a Level A ABAP Cloud wrapper** so the rest of the codebase stays clean.

### Level C — Internal SAP objects (risky, mitigate)
- Reading internal tables, calling non-released function modules or classes
- The *default* state of any SAP object not explicitly released — internal until proven otherwise
- ATC behavior: priority 2 (warning)
- Reclassification risk: SAP can move internal objects to `classic` (better) or `noAPI` (worse) at any release

When unavoidable, mitigate by:
- Enabling **Changelog for SAP Objects** in ATC, which proactively detects upcoming incompatible changes
- Encapsulating the access in a small, well-named wrapper class
- Tracking it in the team's technical-debt log with a planned refactor window

### Level D — Modifications & noAPI (eliminate)
- Modifications to SAP standard code (changes via modification key)
- Direct write access to SAP core tables (UPDATE/INSERT/MODIFY on `MARA`, `VBAK`, `BSEG`, etc.)
- Implicit enhancements that intercept SAP method behavior
- Objects flagged as `noAPI` in the Cloudification Repository
- ATC behavior: priority 1 (error)

**Level D is the top refactoring priority.** Treat any new Level D code in code review as something that needs explicit, time-bound justification.

For deep-dive on Cloudification Repository state values (`released`, `classic`, `internal`, `noAPI`, `internalAPI` with successor), released local vs remote APIs, reclassification dynamics, and per-anti-pattern remediation, see `references/levels-detailed.md`.

## Decision framework

Two layers: fit-to-standard first, then the SAP Application Extension Methodology if extension is justified.

### Fit-to-standard ordering

Before deciding *how* to extend, decide whether to extend *at all*:

1. **SAP standard** — does the standard cover it?
2. **Certified add-on** — does an SAP-validated partner solution cover it? Look for "SAP-certified for clean core" designation.
3. **Configuration** — can configuration achieve it (SPRO, business configuration)?
4. **Custom extension** — only when 1–3 don't cover it and the requirement is genuinely differentiating.

Many "we need an extension" conversations should pause here. Building custom code for something the standard already does is the most common form of unnecessary technical debt.

### SAP Application Extension Methodology (3 phases)

Once an extension is justified, the official methodology structures the technology choice:

- **Phase 1 — Assess Use Case.** What's the business need, what SAP data and processes does it touch, is transactional consistency required, what's the data volume, who consumes the output?
- **Phase 2 — Assess Technology.** Map the use case to extension styles (on-stack / side-by-side / hybrid), tasks (UI, business logic, integration), and the available technologies for each, with their clean core levels.
- **Phase 3 — Define Target Solution.** Pick the highest-Level combination that satisfies the use case. Document why anything below Level A was chosen.

### "BTP first"

Default to **side-by-side**. Choose on-stack only when one of these is true:
- Transactional consistency with SAP core data is required (writing custom + standard tables in one LUW)
- High-volume reads with complex joins on SAP standard tables
- Frequent reads/writes to SAP standard data (latency would dominate)
- Extension of core SAP UI / data model / business object behavior with tight coupling

If neither applies clearly, side-by-side is the right answer. If both apply, you have a hybrid candidate (on-stack ABAP service exposing a released remote API, consumed by a side-by-side BTP UI/orchestration layer).

For the full decision matrix, on-stack vs side-by-side criteria, hybrid deployment patterns, and worked scenarios, see `references/decision-framework.md`.

## Code-level guidance

### When writing new ABAP

Default to ABAP Cloud syntax and patterns:

- Use **CDS views** for data modeling, never raw `SELECT` chains on SAP standard tables
- Use the **ABAP RESTful Application Programming Model (RAP)** for stateful business services — behaviors, validations, determinations
- Use **released business object interfaces** rather than directly writing to SAP standard tables
- Use modern ABAP language (7.40+): inline declarations, constructor expressions (`NEW`, `VALUE`, `FOR`, `REDUCE`)
- For UI, use **SAP Fiori / SAPUI5**, not SE38 reports
- For custom fields on SAP entities, prefer the **Custom Fields app** (key user extensibility) over ABAP-level append structures
- **Avoid** Dynpro, Web Dynpro, classic ALV reports — they are not cloud-ready

ABAP Cloud is enforced at the compiler level — code that violates the rules doesn't compile. There's no escape hatch. For the explicit allowed/forbidden lists, prebuilt services available without extra license (logging, change docs, number ranges, jobs, currency, UOM, factory calendar, XLSX), and core building blocks (RAP, CDS, business object interfaces, Custom Fields), see `references/abap-cloud-rules.md`.

### When reviewing existing ABAP

Flag clearly with the level. Tone: descriptive, not judgmental.

**Likely Level D — flag as error:**
- Direct `UPDATE` / `INSERT` / `MODIFY` on SAP standard tables
- Modifications (changes via modification key)
- Implicit enhancements (`ENHANCEMENT-POINT ... INCLUDE BOUND` patterns)
- Field-symbol tricks reaching into SAP internal structures
- Hardcoded references to `noAPI` objects from the Cloudification Repository

**Likely Level C — flag as warning:**
- `SELECT` from SAP standard tables that have a released CDS view equivalent
- `CALL FUNCTION` to internal (non-released) function modules
- `TYPE REF TO` to SAP internal classes
- Use of internal types from non-released DDIC structures

**Likely Level B — flag as informational:**
- BAPI calls from new code (suggest: wrap them in a Level A class)
- Classic ALV usage (acceptable for legacy reports, not for new development)
- Web Dynpro (legacy acceptable, no new development)

### Concrete refactoring patterns

**Pattern 1 — Wrap a classic API to expose Level A surface:**

```abap
" Anti-pattern: BAPI called directly from cloud-namespace code
CALL FUNCTION 'BAPI_PO_CREATE1'
  EXPORTING
    poheader = ls_header
  TABLES
    poitem   = lt_items
    return   = lt_return.

" Better: wrap in a released-style local API
CLASS zcl_po_service DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_po_service.
ENDCLASS.

CLASS zcl_po_service IMPLEMENTATION.
  METHOD zif_po_service~create.
    " BAPI call lives here, isolated.
    " Callers consume only the released interface — Level A from their perspective.
  ENDMETHOD.
ENDCLASS.
```

The dependency on the BAPI (Level B) is now localized. Consumers stay at Level A. When a successor RAP-based equivalent appears, you change one file.

**Pattern 2 — Replace internal table read with released CDS view:**

```abap
" Anti-pattern: direct SELECT on internal SAP table
SELECT matnr, mtart, ersda
  FROM mara
  INTO TABLE @DATA(lt_materials)
  WHERE mtart = 'FERT'.

" Better: use released CDS view (lookup in Business Accelerator Hub)
SELECT material, materialtype, creationdate
  FROM i_product
  INTO TABLE @DATA(lt_materials)
  WHERE materialtype = 'FERT'.
```

The released view (`I_*` namespace pattern is common) carries SAP's stability contract. Field renames during upgrades become SAP's problem, not yours.

**Pattern 3 — Replace modification with extension point:**

When you find a modification of SAP standard:
1. Identify the business behavior it changes
2. Search for a **released BAdI**, **enhancement point**, or **business object interface** that exposes the same hook
3. Reimplement the logic via that extension point
4. If no released hook exists, file a SAP Customer Influence request, and as a bridge use a Level B classic user exit if available — never leave it as a Level D modification

## "I know this is Level D, just need to ship"

Respect the constraint. Deliver the working code. But:

- State the level explicitly in your response
- Note what stops working: "this will need to be revisited at the next upgrade because direct writes to `VBAK` are not upgrade-safe"
- Sketch the Level A refactor in a few lines so it's captured for later
- Don't refuse, don't moralize, don't repeat the lecture

The user is the engineer of record. Your job is to make the trade-off visible, not to override it.

## Measurement: how to know if we're winning

Four KPIs make clean core progress quantifiable. Reach for these when the user asks "how is the system doing?" or wants to set targets.

- **Clean Core Share** — percentage distribution of custom objects across Levels A/B/C/D. The shape of the distribution is more informative than any single number.
- **Technical Debt Score** — weighted ATC-finding total: errors × 10 + warnings × 5 + info × 1. Use to prioritize which packages to clean up next.
- **Unused Code Share** — percentage of custom objects with zero runtime calls (per ABAP Call Monitor / SCMON / SUSG). Cheapest cleanup target — no business risk to deletion.
- **Business Modifications Count** — entries in `SMODILOG`. Direct count of Level D modifications.

For calculation details, governance practices, and the exemption process, see `references/governance.md`.

## Tooling

- **ABAP Test Cockpit (ATC)** with the **ABAP Cloud Readiness** variant — automated detection of Level B/C/D issues, integrated with transport release. Priority 1–2 findings block transport by default.
- **Cloudification Repository** — searchable catalog with state values: `released` (A), `classic` (B), `internal` (C, default), `noAPI` (D), and `internalAPI` (with successor — points you to the released replacement).
- **Changelog for SAP Objects** (ATC check) — proactively warns when a referenced internal object is scheduled for an incompatible change in an upcoming release.
- **SAP Business Accelerator Hub** — canonical source for released remote APIs (OData, REST, RFC, events) with documentation and code samples.
- **SAP Note 3578329** — framework/technology classification guide.
- **SAP Cloud ALM** — requirements management, traceability, governance for what extensions exist and why.
- **ABAP Development Tools (ADT in Eclipse)** — required for ABAP Cloud development; classic SE80 cannot drive cloud-compliant code.
- **Joule** — SAP AI copilot for code generation and classic-to-cloud migration assistance.

## Anti-patterns to surface immediately

When you see these in code under review, name the pattern and the level:

- "Quick" modifications "we'll fix later" — Level D, never gets fixed
- Copy-pasting SAP standard code into a Z-namespace ("forking the standard") — diverges over time, double maintenance burden
- Extending SAP tables by appending custom fields directly — use the Custom Fields framework instead
- New SE38 reports for fresh requirements — use Fiori + RAP
- Implicit enhancements intercepting SAP method behavior — Level D, brittle, not allowed in ABAP Cloud at all
- Direct DB updates "because we know it's safe" — never safe across upgrades
- BAPI calls scattered through new code without wrappers — pins the codebase to Level B forever
- ABAP-level append structures for what could be a Custom Fields app — over-engineering, transfers ownership to dev team unnecessarily

## What this skill does NOT do

- It does not refuse work on classic ABAP. Many real systems run on it; people need help. Provide the help, mark the level honestly.
- It does not require the user to refactor everything immediately. The realistic playbook is: stop adding Level D, eliminate existing Level D first, then chip away at C and B over years.
- It does not assume the user is on S/4HANA Public Cloud. Most guidance applies to Private Cloud and on-premise too; only call out edition-specific differences when they matter (e.g., on-premise still allows classic ABAP technically, but ABAP Cloud is the recommended path everywhere).

## Quick reference card

| Symptom in code | Likely level | First-line fix |
|---|---|---|
| `MODIFY mara FROM ...` | D | Use Custom Fields framework or business object interface |
| `CALL FUNCTION 'BAPI_*'` in new code | B | Wrap in Level A class |
| `SELECT ... FROM <SAP standard table>` | C (often) | Find released CDS view in Business Accelerator Hub |
| `ENHANCEMENT-POINT ... INCLUDE BOUND` (implicit) | D | Use released BAdI / extension point |
| Modification key dialog appears | D | Stop; find an extension point |
| New SE38 report | B (classic) | Use Fiori + RAP |
| New Web Dynpro | B (classic) | Use SAPUI5 / Fiori Elements |
| `TYPE REF TO CL_<internal>` | C | Find released class or use released business object |
| Custom Z-table written from custom code | A | Fine — your own namespace |
| Custom field on SAP entity via append structure | D (often) | Use Custom Fields app (key user extensibility) |

## When to load reference files

- Object level uncertainty, Cloudification Repository state values, released local vs remote APIs, reclassification → `references/levels-detailed.md`
- Architecture decisions, on-stack vs side-by-side, hybrid patterns, SAP Application Extension Methodology in detail, worked scenarios → `references/decision-framework.md`
- Stay Clean / Get Clean playbook, KPI calculations, ATC exemption process, key user vs developer extensibility, maturity assessment → `references/governance.md`
- ABAP Cloud allowed/forbidden lists, compiler enforcement, RAP / CDS / business object interfaces / Custom Fields, prebuilt services, classic-to-cloud migration → `references/abap-cloud-rules.md`
