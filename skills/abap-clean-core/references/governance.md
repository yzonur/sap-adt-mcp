# Clean Core Governance & Measurement

This file expands the operational side of clean core: how organizations stay clean, get clean, measure progress, and govern exceptions. Load it when:
- The user asks "how do we know if we're improving?"
- The conversation involves clean core KPIs or maturity assessment
- An ATC exemption is being considered
- The team is planning a clean core remediation roadmap
- The user is choosing between key user and developer extensibility

## Two strategic tracks

All clean core work falls into one of two efforts. Naming them explicitly helps the user understand which mode they're in.

### Stay Clean — preventing new technical debt

Applies to **new development**. The goal is zero unnecessary debt: every new extension at the highest achievable level, governed by a process that catches violations before they ship.

The four governance elements:

#### 1. Functional requirements
- Documented business case (differentiating, not commodity)
- Not achievable via standard or certified add-on (fit-to-standard cleared)
- Linked to a process/capability in SAP Cloud ALM
- Approved by the Solution Standardization Board (or equivalent governance body)

Quality questions to ask before approving any extension request:
- Is it differentiating, or is the business doing something non-standard for no good reason?
- Does it provide tangible business value or is it a workflow preference?
- Can it be solved with configuration first?

#### 2. Extension architecture
- Use the SAP Application Extension Methodology (3 phases) for the decision
- Document via the Extension Task Guidance Template
- Map business needs to clean core-compliant technologies
- "BTP first" — pick side-by-side unless on-stack is genuinely required
- Get stakeholder alignment before implementation begins

#### 3. Extension implementation
- Establish clean core mindset across the team — code is strategic, think long-term maintainability
- Document and enforce development guidelines (APIs, enhancements, naming, coding standards)
- Train developers on ABAP Cloud, SAP BTP, modern paradigms (free SAP learning paths: "Acquiring Core ABAP Skills," "Managing Clean Core," "Practicing Clean Core"; certification: SAP Certified Associate — Back-End Developer — ABAP Cloud)
- Use the wrapper pattern for any unavoidable Level B/C dependencies
- Top-down approach: try Level A first, fall back only if needed

#### 4. Extension deployment
- ABAP Test Cockpit checks integrated into transport release — high-priority findings (1–2) block transport
- The **ABAP Cloud Readiness** ATC variant is the default; SAP ships pre-delivered variants
- Formal exemption process (see below) for any blocked finding

### Get Clean — reducing existing technical debt

Applies to **existing custom code**. The goal isn't 100% in year one — it's a sustainable, prioritized reduction trajectory.

#### Measure & assess
- Establish a baseline using the RISE with SAP Methodology dashboard or ATC
- Classify all custom objects by level (A/B/C/D)
- Identify unused code and high-risk dependencies
- Set target maturity scores

#### Prioritize & remediate
- **First priority:** eliminate Level D. The realistic year-one goal is "Level D zero."
- **Second priority:** reduce Level C dependencies, with changelog monitoring as a bridge
- **Boy scout principle:** every developer leaves the code cleaner than they found it; small refactorings are factored into normal project estimates rather than being deferred to a separate "cleanup project" that never comes
- **Lighthouse approach:** when a major rework is happening anyway (re-architecture, big new feature, platform migration), use the opportunity to rebuild the surrounding extensions cleanly
- **Annual reduction target:** 10% per year is realistic; faster than that usually means cutting corners

## Measurement: the four KPIs

These are the quantitative metrics SAP defines for clean core progress. When the user asks "how do we know we're winning?", these are the answer.

### 1. Clean Core Share

The distribution of custom objects across levels A, B, C, D — typically expressed as percentages.

**Calculation:** count of objects at each level / total custom objects.

**Use:** track overall system health. Set targets ("Level D < 5% by Q4", "Level A > 60% by year-end"). The shape of the distribution is more informative than any single number.

### 2. Technical Debt Score

A weighted score of all ATC findings, summed across the codebase.

**Calculation:** errors × 10 + warnings × 5 + info × 1, per object or per package.

**Use:** prioritize remediation. The packages with the highest debt scores are where to focus the next cleanup window.

### 3. Unused Code Share

Custom objects that are never executed at runtime, as a percentage of all custom objects.

**Calculation:** count of objects with zero runtime calls (per ABAP Call Monitor / SCMON / SUSG aggregation) / total custom objects.

**Use:** identify dead code for deletion. Unused code is the cheapest form of cleanup — no business risk, immediate reduction in surface area.

### 4. Business Modifications Count

The number of entries in `SMODILOG`, the SAP table that records modifications to standard code.

**Calculation:** raw count, optionally segmented by package or by application area.

**Use:** detect Level D anti-patterns specifically. Each entry is a modification that will need re-evaluation at every upgrade.

## ATC exemption process

ATC findings of priority 1–2 block transport release by default. Sometimes a finding is unavoidable in the short term, and the team needs to ship despite it. The exemption process keeps this from becoming a backdoor for sloppy code.

The discipline:

- **Designated Quality Manager** reviews each exemption request
- **Specific justification** required — naming the finding, the object, why no alternative is feasible now
- **Scope is narrow** — exempt this specific finding for this specific object, not a blanket waiver
- **Time-bound** — exemptions have an expiry date; they aren't perpetual
- **Recorded in ATC** for full traceability — every exemption is auditable
- **Periodic review** — sample 10–20% of active exemptions periodically to verify they're still relevant; expired exemptions become enforcement again

Avoid: broad exemptions, exemptions without justification, exemptions that effectively turn off the check.

## Governance bodies

Two roles often confused:

- **Solution Standardization Board** — approves *whether* an extension is built. Ensures business case, fit-to-standard clearance, alignment with strategy.
- **Quality Manager** — approves *how* an extension is built when it deviates from defaults. Reviews ATC exemptions, ensures clean core compliance.

Smaller organizations often combine these into one role; the distinction matters more than the title.

## Custom Fields framework — key user vs developer extensibility

When the requirement is "add a custom field to a standard SAP entity," there are two paths:

### Key user extensibility (preferred for fields)

- **Custom Fields app** — low-code, business-user-driven, no ABAP needed
- The added field is automatically available in standard UIs, reports, and APIs that opt into the framework
- Level A by default
- Lifecycle managed by SAP — the field travels with upgrades automatically
- Use this for typical "we need an extra attribute on the customer / material / order" requirements

### Developer extensibility

- ABAP Cloud development for cases where the field needs custom business logic
- More flexibility, more complexity
- Level A as long as you stay within the released framework
- Use this when the field requires non-trivial validation, derivation, or integration

The principle: **try key user first.** Most "add a field" requests don't need a developer. Reaching for ABAP for a simple field extension is over-engineering and creates ownership burden the business team probably didn't sign up for.

## Maturity assessment (brief)

The full SAP framework assesses 12 governance practices on a 0–5 maturity scale (0 = not started, 5 = expert). The 12 practices split into:

- **Governance maturity (7):** decision-making, release management, developer guidelines, architecture review, skill management, documentation, monitoring
- **System setup (5):** dev environment, tooling, change management integration, automation/quality gates, metrics

This is mostly a tool for governance teams setting up clean core programs. For day-to-day code-level conversations, the four KPIs are the more useful framing.

## A realistic multi-year journey

A clean core program looks roughly like this over time:

- **Year 1** — establish baseline KPIs, set up governance gates (Stay Clean), train teams on ABAP Cloud, configure ATC with the Cloud Readiness variant, start eliminating Level D (Get Clean priority)
- **Year 2** — Level D should be near zero; begin systematic Level C reduction with changelog monitoring; new development is consistently Level A
- **Year 3+** — continuous improvement; quality gates are habit, not enforcement; KPIs become a routine reporting metric, not a transformation project
