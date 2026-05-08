# ABAP Clean Core — Levels in detail

This file expands on the four cleanliness levels (A/B/C/D) introduced in SKILL.md. Load it when:
- The user asks how to look up an object's level
- A code review needs to cite specific Cloudification Repository states
- The conversation involves released local vs released remote APIs
- The user is planning long-term, level-by-level remediation

## The Cloudification Repository as source of truth

The Cloudification Repository is SAP's authoritative catalog of how every SAP object relates to clean core. Before claiming an object is at any level, this is where to check. Each object carries one of these state values:

| State | Meaning | Level |
|---|---|---|
| `released` | Publicly released API with stability contract | A |
| `classic` | Documented, historically stable, no formal contract | B |
| `internal` | SAP-internal, not released, not recommended for customer use | C (default) |
| `noAPI` | Explicitly marked as not-an-API; do not use | D |
| `internalAPI` (with `successor`) | Currently internal, but a released successor exists — use the successor | C, but with migration path |

The repository is searchable. When the user is uncertain about an object, the right answer is rarely from memory — it's a Cloudification Repository lookup. SAP Note 3578329 complements this with a framework/technology classification guide.

## Released APIs: local vs remote

"Released" is one category, but it has two flavors with different usage patterns. Mixing them up causes confusion.

### Released local APIs

Used **inside** the SAP system, by ABAP code calling other ABAP code.

- **CDS views** (the `I_*`, `C_*` namespaces are common indicators of released views)
- **Business object interfaces** — programmatic API to create/read/update/delete domain entities (sales orders, materials, etc.) with validations and authorizations enforced
- **Released BAdIs and extension points** — documented hooks for plugging custom logic into SAP standard processes
- **Released ABAP classes / interfaces** — the catalog of `CL_*` and `IF_*` artifacts SAP has explicitly committed to

Use these when your code runs on-stack and needs to query, modify, or extend SAP business data with transactional consistency.

### Released remote APIs

Used **across** systems — typically from BTP, mobile apps, partner systems, or integration middleware calling into SAP.

- **OData services** (the dominant pattern)
- **REST services**
- **RFC-enabled function modules** in the released catalog
- **Events** published to SAP Event Mesh / SAP Integration Suite

Use these when your code runs side-by-side or in another system entirely. Find them in the **SAP Business Accelerator Hub**, which is the canonical catalog with documentation, code samples, and OpenAPI specs.

### Practical implication

In a hybrid extension (BTP frontend + ABAP backend), you'll often use **both**:
- The on-stack ABAP code uses released local APIs
- The on-stack code exposes its own service via RAP, which becomes a released remote API
- The BTP code consumes that remote API

## Level B in practice

Classic APIs are documented and historically stable, but lack a formal stability contract. SAP doesn't guarantee them in writing — they're upgrade-stable in practice but could in principle change.

The most common Level B citizens you'll meet in code:

- **BAPIs** — `BAPI_PO_CREATE1`, `BAPI_SALESORDER_CREATEFROMDAT2`, `BAPI_MATERIAL_SAVEDATA`, etc.
- **Classic ALV grid** — `CL_GUI_ALV_GRID`, `CL_SALV_TABLE`
- **Classic user exits** — released BAdIs that pre-date the ABAP Cloud era
- **Established function modules** with a long, public usage history (conversion routines, currency conversion FMs)
- **SAP GUI / Web Dynpro** as UI frameworks

The right pattern is: **wrap them**. A small Level A wrapper class isolates the dependency; if SAP later releases a successor, you change one file.

## Level C and the reclassification dynamic

By default, every SAP object is internal — released is the exception, not the rule. Level C code reaches into objects that aren't in the released catalog.

The risk isn't theoretical: SAP can **reclassify** internal objects. An internal function module you depend on could be:
- Promoted to `classic` (Level B) — usually safe, no immediate action
- Demoted to `noAPI` (Level D) — your code is now in the highest-risk tier
- Removed in a future release entirely

This is why **Changelog for SAP Objects** matters. It's an ATC check that proactively flags upcoming incompatible changes for any internal object you reference. Enabling it converts a future surprise into a planned refactoring window.

For Level C code that is unavoidable today, the playbook is:
1. Encapsulate the access in a single class — never scatter direct internal-object calls
2. Enable changelog monitoring
3. Document the dependency in the team's technical-debt log
4. Set a refactoring trigger (next major upgrade, next time the surrounding feature is touched)

## Level D anti-patterns by category

Level D isn't one thing — it's several distinct anti-patterns, each with its own remediation path:

### Modifications

Changes to SAP standard code via the modification key (or via Note Assistant for SAP Notes that require code changes). Each modification must be manually re-applied or merged at every upgrade.

**Refactor:** find the released BAdI / extension point that exposes the same hook. If none exists, file an SAP Customer Influence request and use a Level B classic user exit as a bridge.

### Direct write access to SAP core tables

`UPDATE`, `INSERT`, or `MODIFY` statements on SAP standard tables — `MARA`, `VBAK`, `BSEG`, etc. Bypasses validation and authorization, breaks data consistency.

**Refactor:** use the released business object interface. Every major SAP business object (Sales Order, Material, Posting) has one — they enforce the same rules SAP standard code does.

### Implicit enhancements

Enhancement points marked `INCLUDE BOUND` that intercept method behavior implicitly. Brittle to SAP code changes; not allowed in ABAP Cloud at all.

**Refactor:** the released BAdI catalog has explicit replacements for the common interception points.

### "noAPI" objects

Objects marked `noAPI` in the Cloudification Repository are explicitly out-of-scope. SAP won't support them, won't document them, won't preserve them.

**Refactor:** there's no path other than finding a different way. Search the repository for a released alternative; if there genuinely isn't one, file Customer Influence.

### Code copy-paste from SAP standard

Lifting SAP code into a Z-namespace and modifying it. Diverges from SAP over time; double maintenance burden; usually fails at the next functional upgrade.

**Refactor:** start over with the released APIs. Treat the copy as a reference for understanding, not as a base to extend.

## Level-by-level lookup checklist

When reviewing or writing code, work through this lookup before declaring a level:

1. Is the object in your own Z-namespace? Custom tables, custom classes, custom CDS views — these are **always Level A** as long as they don't violate the rules below (your Z-class can still be Level D internally if it modifies SAP standard).

2. Is it a released API? Check the SAP Business Accelerator Hub (remote APIs) or the Cloudification Repository (local APIs). If yes — Level A.

3. Is it in the classic catalog? BAPIs, released user exits, ALV grid, classic frameworks. SAP Note 3578329 lists framework classifications. If yes — Level B.

4. Is it `noAPI`, a modification, or a direct write to SAP standard? Level D.

5. Otherwise — it's internal. Level C, with the changelog mitigation.

The mistake to avoid: skipping the lookup and guessing. The level depends on the object's state in the Cloudification Repository, not on intuition about how the object "feels."
