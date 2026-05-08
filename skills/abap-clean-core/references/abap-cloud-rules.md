# ABAP Cloud Rules & Building Blocks

This file expands on what's allowed and not allowed in ABAP Cloud, and covers the core building blocks (RAP, CDS, business object interfaces, custom fields, prebuilt services). Load it when:
- The user is writing new ABAP and needs to know what's permitted
- A code review needs to check ABAP Cloud compliance specifically
- The user is asking about RAP, CDS, business object interfaces, or custom fields
- The conversation involves migrating classic ABAP to ABAP Cloud

## Why ABAP Cloud is the new default

ABAP Cloud isn't just "ABAP with new syntax." It's a different language version with **enforced cloud-readiness and clean core compliance built into the compiler**. Code that violates the rules doesn't compile — there's no way to bypass the checks short of leaving ABAP Cloud entirely.

This is intentional. In classic ABAP, clean core was advisory; you could write Level D code and the system happily ran it. In ABAP Cloud, the language itself prevents most Level D anti-patterns at compile time. That's the point.

For SAP S/4HANA Cloud Private Edition, ABAP Cloud is **mandatory** for new on-stack development. For on-premise S/4HANA, classic ABAP still runs, but ABAP Cloud is the recommended path for everything new.

## What's allowed in ABAP Cloud

### Released local APIs
- **Released CDS views** — read access to SAP business data with stable field names and semantics
- **Business object interfaces** — programmatic create/read/update/delete on SAP entities, with validations and authorizations enforced by SAP standard
- **Released BAdIs and extension points** — documented hooks for plugging custom logic into standard processes
- **Released ABAP classes and interfaces** — the catalog of released `CL_*`/`IF_*` artifacts

### Modeling and services
- **CDS** — for data models (`@AbapCatalog.sqlViewName`, projections, annotations, calculated fields)
- **RAP — ABAP RESTful Application Programming Model** — for services and business behaviors
- **Web services and OData** — exposing services for remote consumption
- **Event-based integration** via released events (raise, consume)

### Prebuilt services (no extra license, no setup)
- **Application logging** (BAL successor in cloud-friendly form)
- **Change documents**
- **Number ranges**
- **Background jobs and scheduling**
- **Factory calendar** (working days, holidays)
- **Currency conversion** (`CL_ABAP_CURRENCY_CONV` and friends)
- **Unit of measure conversion**
- **XLSX processing** (read/write Excel files)
- **Printing**
- **Translations / internationalization** (i18n primitives)

These exist precisely so that custom code doesn't reach into internal SAP services for these common needs.

### Custom data
- **Read/write access to your own custom tables** in your Z-namespace
- **Custom CDS views** built on top of released views or your own tables
- **Custom RAP services** exposing your own business objects

### Modern ABAP language
- Inline declarations (`DATA(...)`)
- Constructor expressions (`NEW`, `VALUE`, `FOR`, `REDUCE`, `COND`, `SWITCH`)
- Type-safe Open SQL with strict mode
- Functional method calls and chaining
- ABAP Unit testing framework

## What's NOT allowed in ABAP Cloud

The compiler rejects all of these:

### Direct access to SAP standard
- **Direct write to SAP standard tables** — `UPDATE MARA`, `INSERT VBAK`, `MODIFY BSEG`, etc. Use the business object interface instead.
- **Read access to SAP-internal tables** without going through a released CDS view
- **Calls to SAP-internal function modules or classes** — anything not in the released catalog
- **Any reference to a `noAPI` object** from the Cloudification Repository

### Non-cloud extension techniques
- **Modifications** to SAP standard objects via modification key
- **Implicit enhancements** (`ENHANCEMENT-POINT ... INCLUDE BOUND` patterns intercepting method behavior)
- **Field-symbol tricks** that reach into SAP-internal structures
- **Code copy-paste from SAP standard** with subsequent modification

### Non-cloud-ready frameworks
- **Classic Dynpro** (SAP GUI screens) — not cloud-ready, not allowed for new code
- **Web Dynpro ABAP** — superseded by SAPUI5 / Fiori Elements
- **Classic ALV grid** with internal class references — `CL_GUI_ALV_GRID` and friends
- **SE38 reports** — use Fiori + RAP for new development

### Untyped Open SQL
- **Native SQL** without type safety
- **Dynamic SQL** that bypasses the type system

## Compiler enforcement is structural

The above list isn't a code review checklist — it's a compile-time check. ABAP Cloud sources are compiled in a stricter mode that fails on these patterns. There's no `#pragma` to disable the checks, no escape hatch.

This has two consequences:
- **You can't accidentally violate the rules.** Code that compiles is, by construction, free of these specific anti-patterns.
- **Migration from classic ABAP requires real work.** A classic ABAP report that uses `SELECT * FROM MARA` won't compile as ABAP Cloud — it needs to be rewritten against released CDS views.

For migration assistance, **Joule** (the SAP AI copilot) provides classic-ABAP-to-ABAP-Cloud transformation suggestions; the SAP-recommended migration path uses it as the starting point.

## Core building blocks

### CDS views

CDS (Core Data Services) is the modeling language for data and services. A CDS view defines:
- A logical data model (entities, fields, relationships)
- Annotations that enrich the model (UI hints, authorization, semantics)
- Optionally, projection logic over base entities

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Active products only'
define view entity ZI_ProductActive
  as select from I_Product
{
  key Product,
      ProductType,
      CreationDate,
      LastChangeDate
}
where ProductIsArchived = ' ';
```

The view consumes released entity `I_Product` (Level A) and exposes a filtered projection. No direct table access; SAP's stability contract on `I_Product` carries through.

### RAP — RESTful Application Programming Model

RAP is the framework for stateful business services. A RAP business object has three layers:

- **Data model** (CDS views, including projection layer for the API surface)
- **Behavior definition** (which actions, validations, determinations apply)
- **Behavior implementation** (the ABAP classes implementing the behavior)

RAP enforces strict logical-unit-of-work control: the framework manages transaction boundaries, no manual `COMMIT WORK` scattered through the code. Services are stateless from the caller's perspective; state lives in the LUW.

When the user is building a new on-stack business service, RAP is the answer.

### Business object interfaces

For consuming SAP business objects (Sales Order, Purchase Order, Material Master, Customer, etc.) programmatically, the released business object interface is the entry point. It's the Level A replacement for direct table writes and BAPI calls.

The pattern: import the released interface, call its methods. Validations, authorizations, change documents, and integration events are all triggered by the interface — no manual implementation needed.

### Custom Fields framework

For adding fields to standard SAP entities (customer, material, sales order, etc.), the Custom Fields app is the Level A path:
- Business user adds the field through a low-code UI
- Field is automatically available in standard UIs, reports, OData services, and integration scenarios
- Lifecycle is managed by SAP — upgrades preserve the field

Reach for ABAP only when the field needs business logic that the framework doesn't cover (uncommon).

## Migration from classic ABAP

Migration is rarely a mechanical translation. Common patterns:

- **`SELECT FROM <SAP table>` → released CDS view** — find the released equivalent in Business Accelerator Hub
- **`CALL FUNCTION 'BAPI_*'` → business object interface** — most BAPIs have a successor in the BO interface catalog
- **Modification → released BAdI / extension point** — find the documented hook
- **SE38 report → Fiori Elements analytical / list-report app** — RAP service + Fiori Elements UI
- **Web Dynpro screen → SAPUI5 / Fiori Elements** — typically a re-architecture, not a port

The realistic plan is incremental. A single classic report doesn't migrate in an afternoon — but each piece touched during normal development can move one step toward Level A.

## Quick allowed/forbidden table

| Pattern | ABAP Cloud verdict | Replacement |
|---|---|---|
| `SELECT * FROM MARA` | Forbidden | `SELECT FROM I_Product` |
| `UPDATE VBAK SET ...` | Forbidden | Sales Order business object interface |
| `CALL FUNCTION 'BAPI_PO_CREATE1'` | Forbidden directly; allowed via wrapper from classic | Purchase Order business object interface |
| `CL_GUI_ALV_GRID` | Forbidden | Fiori Elements list-report |
| `ENHANCEMENT-POINT ... INCLUDE BOUND` | Forbidden | Released BAdI |
| Modification with key | Forbidden | Extension point or BAdI |
| `SELECT FROM Z_MY_TABLE` | Allowed | — |
| `SELECT FROM I_Product` | Allowed | — |
| Inline `DATA(lt_x) = ...` | Allowed | — |
| `NEW` / `VALUE` / `FOR` constructor expressions | Allowed | — |
| Native SQL via `EXEC SQL` | Forbidden | Use type-safe Open SQL or CDS |
| `CALL FUNCTION 'Z_*'` (custom RFC) | Allowed | — |
