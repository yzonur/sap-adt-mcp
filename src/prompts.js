// MCP prompts exposed by sap-adt-mcp.
//
// These surface in MCP-compatible clients (Claude Desktop, Claude Code, etc.)
// as user-invokable slash commands. Each prompt encodes a slice of SAP's
// Clean Core extensibility framework and tells the model how to combine the
// adt_* tools to deliver a specific outcome — grade an object, review a
// package's KPIs, refactor toward a higher cleanliness level, create new
// code at Level A, or design an extension architecture.
//
// In Claude Code these appear as e.g. /mcp__sap-adt__clean_core_grade.
// The "sap-adt" segment depends on the name the user gave the server when
// registering it (`claude mcp add sap-adt -- npx sap-adt-mcp`).
//
// The skill at skills/abap-clean-core/ remains as the long-form reference
// documentation. These prompts are the operational surface — they pull the
// relevant slice of that material and pair it with the MCP tool surface so
// the model can act on real systems instead of reasoning in the abstract.

const APPLICABILITY_GUARD = `
APPLICABILITY CHECK (run this first, every time):
- Clean Core is an SAP S/4HANA discipline (Public Cloud, Private Cloud, or
  on-premise). It does NOT apply to ECC / R/3 / pre-S/4HANA systems.
- If the target system is ECC or you cannot tell, ask the user once. If it's
  ECC, refuse to apply Clean Core grading. Help with classic ABAP idioms
  instead, without level labels.
- Use adt_ping or adt_list_systems if you need to introspect the landscape.
`.trim();

const TONE = `
TONE:
- Descriptive, not judgmental. Name the level, name the trade-off, do not
  moralize.
- The user is the engineer of record. If they say "I know it's Level D, just
  ship it" — deliver, mark the level, sketch the Level A refactor for later,
  and move on. Do not refuse, do not lecture twice.
`.trim();

const TOOL_REMINDER = `
RELEVANT MCP TOOLS:
- adt_get_source        — fetch ABAP source by name + type
- adt_run_atc           — run ATC (Cloud Readiness variant maps to A/B/C/D)
- adt_run_unit_tests    — run ABAP Unit
- adt_syntax_check      — syntax check before set_source
- adt_search_objects    — name-pattern search (find released equivalents)
- adt_where_used        — where-used list
- adt_browse_package    — one level of package contents
- adt_list_packages     — recursive walk
- adt_create_object     — create new ABAP objects (Level A pipeline below)
- adt_set_source        — replace source (orchestrates lock/PUT/unlock)
- adt_activate          — activate one or more objects
- adt_compare_source    — diff one object across two systems
`.trim();

const LEVELS_TABLE = `
LEVELS:
- Level A — Released APIs (CDS views, business object interfaces, released
  BAdIs, RAP services). ATC: no finding. Upgrade-safe by SAP guarantee.
- Level B — Classic APIs (BAPIs, released user exits, classic ALV). ATC:
  priority 3 (info). Wrap in Level A class when introducing in new code.
- Level C — Internal SAP objects (default state of any unreleased object).
  ATC: priority 2 (warning). Risk: SAP can reclassify to noAPI any release.
  Mitigate via Changelog for SAP Objects + encapsulation.
- Level D — Modifications, direct writes to SAP standard tables, implicit
  enhancements, noAPI. ATC: priority 1 (error). Top refactor priority.
`.trim();

// ---------------------------------------------------------------------------
// PROMPT 1 — clean_core_grade (atomic, single object)
// ---------------------------------------------------------------------------
const PROMPT_GRADE = {
  name: "clean_core_grade",
  description:
    "Grade one ABAP object against SAP Clean Core levels A/B/C/D. Pulls source and ATC findings, classifies, cites reasons, and (if Level C/D) sketches the Level A refactor.",
  arguments: [
    {
      name: "object",
      description: "Object name (e.g., ZCL_PRICING).",
      required: true,
    },
    {
      name: "type",
      description:
        "Object type (program, class, interface, function, include, cds, etc.).",
      required: true,
    },
    {
      name: "system",
      description: "Target system. Omit for default.",
      required: false,
    },
  ],
  build({ object, type, system }) {
    return `
You are grading a single ABAP object against SAP's Clean Core extensibility
framework.

TARGET:
- Object: ${object}
- Type: ${type}
- System: ${system ?? "<default>"}

${APPLICABILITY_GUARD}

${TONE}

${LEVELS_TABLE}

${TOOL_REMINDER}

PROCEDURE:
1. Verify applicability (S/4HANA). Stop if ECC.
2. Fetch the source: adt_get_source { object: "${object}", type: "${type}"${system ? `, system: "${system}"` : ""} }.
3. Run ATC: adt_run_atc on the object. Map findings to A/B/C/D:
   - priority 1 → Level D, priority 2 → Level C, priority 3 → Level B, no
     finding → Level A (subject to source review).
4. Read the source for the patterns ATC misses or under-weights:
   - UPDATE / INSERT / MODIFY on SAP standard tables (D)
   - ENHANCEMENT-POINT ... INCLUDE BOUND on SAP code (D)
   - Field-symbol tricks into SAP-internal structures (D)
   - SELECT FROM SAP standard tables with no released CDS view used (C)
   - CALL FUNCTION to internal (non-released) FMs (C)
   - BAPI calls in new code without a wrapper (B, suggest wrap)
   - Classic ALV / Web Dynpro / SE38 patterns in new code (B, legacy
     acceptable)
5. Output, in this order:
   - One-line verdict: "Level X" with a short reason.
   - The 3-5 strongest evidence points (with file:line where useful).
   - If Level C or D: a concrete refactor sketch in 5-10 lines (released
     CDS view names, released BAdI names, business object interface).
   - If the user says "I just need to ship": acknowledge, mark the level,
     and put the refactor in a "later" callout. Do not block.

OUTPUT FORMAT: short, scannable. No filler. No lecturing on Clean Core
philosophy unless asked.
`.trim();
  },
};

// ---------------------------------------------------------------------------
// PROMPT 2 — clean_core_review (atomic, package-wide KPIs)
// ---------------------------------------------------------------------------
const PROMPT_REVIEW = {
  name: "clean_core_review",
  description:
    "Compute Clean Core KPIs for a package: level distribution (A/B/C/D %), Technical Debt Score, top Level D offenders.",
  arguments: [
    {
      name: "package",
      description: "ABAP package name (e.g., ZSALES).",
      required: true,
    },
    {
      name: "system",
      description: "Target system. Omit for default.",
      required: false,
    },
    {
      name: "maxObjects",
      description: "Cap to avoid long runs. Default 50.",
      required: false,
    },
  ],
  build({ package: pkg, system, maxObjects }) {
    const cap = maxObjects ?? 50;
    return `
Compute Clean Core KPIs across an ABAP package and surface the worst
offenders.

TARGET:
- Package: ${pkg}
- System: ${system ?? "<default>"}
- Object cap: ${cap} (do not exceed; prefer worst-likely subset if package is larger)

${APPLICABILITY_GUARD}

${TONE}

${LEVELS_TABLE}

${TOOL_REMINDER}

PROCEDURE:
1. Verify applicability (S/4HANA).
2. Walk the package: adt_browse_package { package: "${pkg}"${system ? `, system: "${system}"` : ""} }.
3. For each object up to the cap, run adt_run_atc and record the highest
   finding priority. Map: 1→D, 2→C, 3→B, none→A.
4. Compute KPIs:
   - **Clean Core Share** — % of objects at each level. Distribution shape
     matters more than any single number.
   - **Technical Debt Score** — sum of (errors × 10 + warnings × 5 + info × 1)
     across the surveyed objects. Per-package number.
   - **Modifications count** — objects flagged with modification-key /
     SMODILOG patterns (heuristic from ATC findings).
5. Output:
   - One-line summary: "%A / %B / %C / %D, score N, M modifications."
   - Top 5-10 Level D offenders by name with their dominant finding.
   - One-paragraph "what to attack first": Level D zero is the year-one
     goal; identify the 2-3 highest-leverage targets.
   - Note objects skipped due to the cap if any.

If the package is empty or doesn't exist, say so. Do not invent numbers.
`.trim();
  },
};

// ---------------------------------------------------------------------------
// PROMPT 3 — clean_core_refactor (mode-loading, conversational)
// ---------------------------------------------------------------------------
const PROMPT_REFACTOR = {
  name: "clean_core_refactor",
  description:
    "Enter Clean Core refactor mode for an ABAP object. Loads Level A patterns (BAPI wrapper, MARA→released CDS, modification→BAdI). Optionally takes an object to start with; otherwise waits for the user.",
  arguments: [
    {
      name: "object",
      description: "Optional object to start with.",
      required: false,
    },
    {
      name: "type",
      description: "Object type. Required if 'object' is given.",
      required: false,
    },
    {
      name: "system",
      description: "Target system. Omit for default.",
      required: false,
    },
  ],
  build({ object, type, system }) {
    const opening = object
      ? `Start with: ${object} (${type ?? "?type?"}) on ${system ?? "<default>"}. Fetch the source and propose a refactor plan before any writes.`
      : `Wait for the user to point you at an object or paste source. Do not act until they do.`;

    return `
You are in Clean Core REFACTOR mode. The user wants to lift an existing ABAP
object's cleanliness level — typically D→A or C→A — without changing
behavior.

${opening}

${APPLICABILITY_GUARD}

${TONE}

${LEVELS_TABLE}

${TOOL_REMINDER}

REFACTOR PATTERNS LOADED:

Pattern 1 — Wrap a classic API to expose Level A surface
  Anti-pattern: BAPI called directly from new code.
  Better: Z-class with a released-style interface; BAPI lives in one method.
  Consumers see Level A. When SAP releases the successor, you change one file.

Pattern 2 — Replace internal table read with released CDS view
  Anti-pattern: SELECT ... FROM MARA / VBAK / BSEG / etc.
  Better: SELECT ... FROM I_Product / I_SalesOrder / ...  (use
  adt_search_objects to find the released "I_*" or "C_*" namespace
  equivalent).

Pattern 3 — Replace modification with extension point
  Anti-pattern: change to SAP standard via modification key.
  Step 1: identify the business behavior changed.
  Step 2: search for a released BAdI / extension point / business object
  interface that exposes the same hook (adt_search_objects with relevant
  pattern).
  Step 3: reimplement the logic via that hook.
  Step 4: if no released hook exists, file SAP Customer Influence and use a
  Level B classic user exit as a bridge — never leave it as a Level D
  modification.

WORKFLOW (every refactor):
1. Read current source (adt_get_source).
2. Run ATC to get the actual findings (adt_run_atc).
3. Propose a refactor plan: list each problem and the target Level A
   pattern. Wait for user confirmation.
4. On confirm:
   - For wrap-style refactors: adt_create_object (new wrapper class) →
     adt_set_source → adt_syntax_check → adt_activate.
   - For in-place edits: adt_lock → adt_set_source → adt_activate →
     adt_unlock (use the sticky-lock pattern if multi-step).
   - On any read-only system, refuse the writes and tell the user which
     system would need to be writable.
5. Re-run ATC after the change. Confirm the level moved as intended.
6. If full Level A was not achievable, document why (no released
   alternative, scheduled for SAP Customer Influence) and the new actual
   level.

Never combine refactors with behavior changes. If the user asks for both,
sequence them: refactor first, behavior change second, two separate
activations so the diff is reviewable.
`.trim();
  },
};

// ---------------------------------------------------------------------------
// PROMPT 4 — clean_core_create (mode-loading, ABAP Cloud default)
// ---------------------------------------------------------------------------
const PROMPT_CREATE = {
  name: "clean_core_create",
  description:
    "Enter Clean Core creation mode. New ABAP objects default to Level A (ABAP Cloud, CDS views, RAP, business object interfaces). Optionally takes a requirement; otherwise waits for the user to describe what to build.",
  arguments: [
    {
      name: "requirement",
      description:
        "Optional one-line description of what to build.",
      required: false,
    },
    {
      name: "package",
      description: "Target package. Omit to ask the user.",
      required: false,
    },
    {
      name: "system",
      description: "Target system. Omit for default.",
      required: false,
    },
  ],
  build({ requirement, package: pkg, system }) {
    const opening = requirement
      ? `Requirement: ${requirement}\nTarget package: ${pkg ?? "<ask the user>"}\nSystem: ${system ?? "<default>"}`
      : `No requirement provided. Ask the user what they want to build, then proceed.`;

    return `
You are in Clean Core CREATE mode. Every new object defaults to Level A.

${opening}

${APPLICABILITY_GUARD}

${TONE}

${TOOL_REMINDER}

ALLOWED IN ABAP CLOUD (use these):
- Released local APIs: released CDS views (I_*/C_* namespaces), business
  object interfaces, released BAdIs, released CL_*/IF_* classes.
- Modeling: CDS for data models, RAP for stateful services, OData/web
  services for remote consumption, released events for integration.
- Prebuilt services (no extra license): application logging, change
  documents, number ranges, background jobs, factory calendar, currency
  and UoM conversion, XLSX, printing, i18n.
- Custom: read/write your own Z-tables; CDS over them; RAP services
  exposing them.
- Modern ABAP: inline DATA(), constructor expressions (NEW/VALUE/FOR/
  REDUCE/COND/SWITCH), strict-mode Open SQL, ABAP Unit.

NOT ALLOWED IN ABAP CLOUD (compiler rejects):
- Direct write to SAP standard tables (UPDATE MARA, etc.) — use the BO
  interface.
- Read access to non-released SAP tables — use a released CDS view.
- Calls to non-released SAP function modules / classes.
- Any reference to a noAPI object.
- Modifications, implicit enhancements (INCLUDE BOUND), code copy-paste
  from SAP standard.
- Classic Dynpro, Web Dynpro ABAP, classic ALV grid (CL_GUI_ALV_GRID),
  new SE38 reports.
- Native SQL, dynamic SQL bypassing the type system.

CREATION PIPELINE:
1. Confirm package + system with the user; check the system is writable.
2. Propose the design before writing code:
   - Object type (class, RAP BO, CDS view, RAP service, ...).
   - Released APIs / CDS views to consume (use adt_search_objects to find
     them, e.g., pattern "I_Customer*" or "I_SalesOrder*").
   - Wait for user confirmation on the design.
3. adt_create_object → adt_set_source → adt_syntax_check.
4. If syntax errors: report and stop. Do not paper over with broad pragmas.
5. adt_activate. If activation fails: report and stop.
6. If a Level B dependency was unavoidable (e.g., BAPI for write-back
   while no successor BO interface exists yet): isolate it in a single
   wrapper method, mark with a // Level B comment, and call out the
   refactor trigger in your final summary.

DEFAULTS:
- UI? Fiori Elements + RAP, not SE38, not Web Dynpro.
- Custom field on SAP entity? Custom Fields app (key user extensibility),
  not ABAP append.
- Business logic? ABAP Cloud class.
- Read-only data API? Released CDS view or projection over one.
- Write-back? Business object interface.
`.trim();
  },
};

// ---------------------------------------------------------------------------
// PROMPT 5 — clean_core_design (mode-loading, architecture)
// ---------------------------------------------------------------------------
const PROMPT_DESIGN = {
  name: "clean_core_design",
  description:
    "Enter Clean Core architecture mode. Walks fit-to-standard, the SAP Application Extension Methodology (3 phases), and the on-stack vs side-by-side decision. No code writes — produces a target solution design.",
  arguments: [
    {
      name: "use_case",
      description:
        "Optional one-line description of the extension use case.",
      required: false,
    },
  ],
  build({ use_case: useCase }) {
    const opening = useCase
      ? `Use case: ${useCase}`
      : `No use case provided. Ask the user to describe the business need first.`;

    return `
You are in Clean Core DESIGN mode. The output is an extension architecture
proposal, not code. No writes.

${opening}

${APPLICABILITY_GUARD}

${TONE}

PROCEDURE:

PHASE 0 — Fit to standard (run this BEFORE any technology discussion)
1. Does SAP standard cover the requirement? If yes, configure and stop.
2. Is there a certified add-on with the "SAP-certified for clean core"
   designation? If yes, evaluate it and stop.
3. Can configuration (SPRO, business configuration) cover it? If yes,
   configure.
4. Only when 1-3 fail and the requirement is genuinely differentiating
   does a custom extension begin.

If you can stop the conversation at Phase 0, do so. The most common form
of unnecessary technical debt is custom code for something the standard
already does.

PHASE 1 — Assess the use case
- Business need, why now, who's the user.
- Which SAP standard data and processes does it touch.
- Is transactional consistency with SAP core required (one LUW writing
  custom + standard tables)?
- Data volume — small lookups vs high-volume joins.
- Consumer — internal, partners, customers, machines.
- Change cadence — weekly UI update vs annual ERP-aligned release.

PHASE 2 — Map to technology

| Task | On-stack options | Side-by-side options |
|---|---|---|
| Custom UI | SAPUI5/Fiori (A), Dynpro (B), Web Dynpro (B) | SAPUI5/Fiori (A), SAP Build Apps (A) |
| New business logic | ABAP Cloud (A), Classic ABAP (B-D) | CAP (A), ABAP Cloud on BTP (A) |
| Data integration | Released CDS (A), classic APIs (B), internal (C-D) | Released remote APIs (A), classic remote (B) |
| Custom field on SAP entity | Custom Fields framework (A), append (B-D) | n/a |
| Stand-alone app | n/a | CAP / SAP Build Apps / low-code (A) |
| Process automation | Workflow (A) | SAP Build Process Automation (A) |

ON-STACK vs SIDE-BY-SIDE — default is "BTP first" (side-by-side).
Pick on-stack only when ONE of these is clearly true:
- Transactional consistency with SAP core required.
- High-volume reads with complex joins on SAP standard data.
- Frequent reads/writes to SAP standard data (latency-sensitive).
- Extending core SAP UI / data model / business object behavior tightly.

If both groups apply: hybrid candidate. The on-stack half exposes a
released remote API (typically OData via RAP); the side-by-side half
consumes that. Best of both.

PHASE 3 — Define the target solution
Pick the highest-Level combination that satisfies Phase 1. Output:
- Extension style (on-stack / side-by-side / hybrid)
- Technologies for each component
- Clean core level for each component
- For anything below Level A: why, and the refactor trigger that would
  move it up later.

OUTPUT:
A short architectural memo. ASCII diagram of components if useful.
Decisions made, decisions deferred (with what info would unblock them),
and the level achieved at each component.

If the user pushes for a Level D solution ("just modify the standard,
it's faster"): reframe in Phase 1. The same business outcome usually has
a Level A path the requester didn't know existed — released BAdI, BTP
workflow, configuration. Reframing requirements is the highest-leverage
clean core move there is.
`.trim();
  },
};

// ---------------------------------------------------------------------------

const PROMPTS = [
  PROMPT_GRADE,
  PROMPT_REVIEW,
  PROMPT_REFACTOR,
  PROMPT_CREATE,
  PROMPT_DESIGN,
];

const PROMPT_INDEX = new Map(PROMPTS.map((p) => [p.name, p]));

export function listPrompts() {
  return PROMPTS.map(({ name, description, arguments: args }) => ({
    name,
    description,
    arguments: args,
  }));
}

export function getPrompt(name, args = {}) {
  const def = PROMPT_INDEX.get(name);
  if (!def) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  // Validate required arguments.
  for (const a of def.arguments) {
    if (a.required && (args[a.name] == null || args[a.name] === "")) {
      throw new Error(
        `Prompt ${name}: missing required argument '${a.name}'`
      );
    }
  }
  const text = def.build(args);
  return {
    description: def.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

export const __forTests = { PROMPTS, PROMPT_INDEX };
