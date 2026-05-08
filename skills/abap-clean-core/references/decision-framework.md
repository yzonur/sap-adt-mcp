# Extension Architecture Decision Framework

This file expands on the decision flow in SKILL.md. Load it when:
- The user is choosing between on-stack and side-by-side
- A new extension is being scoped from scratch
- The conversation involves the formal SAP Application Extension Methodology
- A hybrid (on-stack + side-by-side) deployment is being designed

## Order of operations: don't extend at all if you can avoid it

Before any architecture decision, walk fit-to-standard:

1. **SAP standard** — Does the standard cover the requirement? If yes, configure and use it. No extension needed.
2. **Certified add-on** — Does an SAP-validated partner solution cover it? If yes, evaluate the add-on. The "SAP-certified for clean core with SAP S/4HANA Cloud" designation matters here — certified solutions don't compromise your clean core.
3. **Configuration** — Can the requirement be met by configuration (SPRO, business configuration)? If yes, configure.
4. **Custom extension** — Only when 1–3 don't cover the requirement, and the requirement is genuinely differentiating, consider a custom extension.

Most "we need to build an extension" conversations should pause here. Many requirements are partially covered by standard with small configuration deltas — building custom code for something the system already does is the most common form of unnecessary technical debt.

## The SAP Application Extension Methodology

Once an extension is justified, SAP's official three-phase methodology structures the technology decision. It's technology-agnostic and works for both on-stack and side-by-side scenarios.

### Phase 1 — Assess Extension Use Case

Understand the business and technical context before discussing technology.

- What's the business need? Why now? Who's the user?
- What SAP standard data and processes does the extension interact with?
- Is transactional consistency with SAP core data required? (this drives on-stack vs side-by-side)
- What's the data volume — small lookups or high-volume joins?
- Who consumes the output — internal users, external partners, customers?
- How frequently will the extension change after launch?

The output of Phase 1 is a use-case description: what the extension does, what it touches, who uses it.

### Phase 2 — Assess Extension Technology

Map the use case onto the available technology building blocks. SAP describes this in three layers:

- **Extension styles** — on-stack, side-by-side, hybrid
- **Extension tasks** — UI customization, new business logic, data integration, custom apps, etc.
- **Extension domains** — the functional area (procurement, finance, sales, etc.) and the technologies that domain typically uses

Each task can be solved by multiple technologies. The job in Phase 2 is to enumerate them with their clean core levels:

| Task | On-stack options | Side-by-side options |
|---|---|---|
| Custom UI | SAPUI5 / Fiori (A), Dynpro (B), Web Dynpro (B) | SAPUI5 / Fiori (A), SAP Build Apps (A) |
| New business logic | ABAP Cloud (A), Classic ABAP (B–D) | CAP Java/JavaScript (A), ABAP Cloud on BTP (A) |
| Data integration | Released CDS views (A), classic APIs (B), internal objects (C–D) | Released remote APIs (A), classic remote APIs (B) |
| Custom field on SAP entity | Custom Fields framework (A), append structure (B–D) | Not applicable directly |
| Stand-alone app | Not applicable | CAP, SAP Build Apps, low-code (A) |
| Process automation | Workflow (A) | SAP Build Process Automation (A) |

### Phase 3 — Define Target Solution

Pick the combination from Phase 2 that satisfies the use case at the highest achievable level. Document:
- Which extension style (on-stack / side-by-side / hybrid)
- Which technologies for each component
- Which clean core level each component reaches
- Why anything below Level A was chosen, with a refactor trigger if applicable

The deliverable is a target solution design that can be reviewed and approved before implementation begins.

## On-stack vs side-by-side — choosing the style

The default is **side-by-side** ("BTP first"). Choose on-stack only when one of these is true:

### Triggers for on-stack

- **Transactional consistency required.** The extension writes to both custom and SAP standard tables in the same logical unit of work, and partial commits are unacceptable.
- **High-volume reads with complex joins on SAP standard data.** Pulling all of this across a remote API would be prohibitive in latency or cost.
- **Frequent reads or writes to SAP standard data.** Many roundtrips to a remote API would be slow.
- **Extension of core SAP applications themselves** — adding fields, custom logic, or UI adaptations to standard transactions and Fiori apps.

### Triggers for side-by-side

- **Loose coupling.** The extension is a stand-alone app or process step; it doesn't need to be inside the SAP transactional boundary.
- **External users.** Customers, suppliers, partners who shouldn't have S/4HANA accounts.
- **Multitenant SaaS or external distribution.** The extension is sold or used outside one tenant's SAP system.
- **Different tech stack required.** Java, JavaScript, Python — anywhere ABAP isn't the right tool.
- **Independent lifecycle.** The extension needs to be updated weekly while ERP is upgraded annually.

If both sets apply, you have a hybrid candidate.

## Hybrid deployment — the most common modern pattern

Many real extensions combine both:

- **On-stack ABAP service** — handles the transactional core (writes to SAP standard via business object interfaces, enforces business rules within the LUW)
- **Side-by-side BTP UI / orchestration** — Fiori app, mobile app, or process automation built on BTP, calling into the on-stack service via released remote APIs

This pattern gives you the best of both: clean transactional consistency where it matters, plus an independently deployable, scalable, modern UI/orchestration layer.

The on-stack service should expose a **released remote API** (typically OData via RAP). That's the contract between the two halves; the BTP side has no other knowledge of the SAP system.

Benefits of hybrid:
- Faster innovation — the BTP layer updates independently of ERP cycles
- Stability — the core stays clean and upgradable
- Flexibility — pick the right tech per component (ABAP for transactional logic, Java/JavaScript for the UI/orchestration)
- Scalability — BTP layer scales horizontally, on-stack layer doesn't have to

## When the answer is "redesign the requirement"

Some requirements are framed in ways that force a Level D solution. ("We need to write directly to BSEG because…", "We need to modify the standard transaction MIRO because…")

In Phase 1, push back: is the requirement actually about the *outcome*, or about a particular implementation? Often the same business outcome can be achieved through a released BAdI, a custom BTP workflow, or configuration the requester didn't know existed. Reframing the requirement is the highest-leverage clean core move there is.

## Common scenarios

### Scenario: "We need a custom approval workflow for purchase orders."

- Phase 1: business need is process automation; integration point is the standard PO release strategy
- Phase 2: SAP standard release strategy might cover this with configuration; if not, SAP Build Process Automation (side-by-side, Level A) is the default; on-stack workflow is also available (Level A) but only justified if deeply integrated with custom on-stack data
- Phase 3: SAP Build Process Automation, consuming the released PO remote API

### Scenario: "We need to add three custom fields to the customer master."

- Phase 1: data model extension; key user task, not really a developer task
- Phase 2: Custom Fields app (key user extensibility, Level A) covers it; falling back to ABAP append structure is Level D
- Phase 3: Custom Fields app

### Scenario: "We need to build a fast custom report joining six SAP standard tables."

- Phase 1: high-volume read with complex joins → on-stack triggered
- Phase 2: ABAP Cloud + released CDS views (Level A); falling back to direct SELECTs would be Level C
- Phase 3: ABAP Cloud CDS view consuming released CDS views, exposed via Fiori Elements analytical app

### Scenario: "We need to integrate with a third-party logistics provider."

- Phase 1: integration; loosely coupled; runs at the boundary of the system
- Phase 2: SAP Integration Suite (Level A) for the integration flow; CAP-based microservice on BTP if custom logic is needed
- Phase 3: Integration Suite + optional CAP microservice; consumes SAP via released remote APIs and events

### Scenario: "We need a complex sales-order pricing extension that runs in the same LUW as order creation."

- Phase 1: transactional consistency required → on-stack triggered
- Phase 2: ABAP Cloud + released BAdI for pricing (Level A); modifying the standard pricing routine would be Level D
- Phase 3: ABAP Cloud implementation of the released BAdI; logic in dedicated classes; unit tested via ABAP Unit

In each, the methodology produces a defensible answer at the highest reachable level.
