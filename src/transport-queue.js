// Interpret a transport request's E070 header and TPALOG (tp action log) rows.
//
// The TMS import buffer itself is a file in the transport directory and is not
// reachable over ADT, but every tp step that touches a system is logged in that
// system's TPALOG: export in the source, forward ("<") into a follow-on buffer,
// and the import steps in the target. Reading TPALOG on each system of the route
// answers "where is TR X right now".

// TRSTATUS fixed values (domain TRSTATUS).
export const TR_STATUS = {
  D: "Modifiable",
  L: "Modifiable, protected",
  O: "Release started",
  R: "Released",
  N: "Released (import protection for repaired objects)",
};

// TRTPSTEP fixed values (domain TRTPSTEP) — the steps an agent is likely to see.
export const TP_STEPS = {
  "<": "Forward to follow-on system(s)",
  "!": "Import end",
  "*": "Prepare buffer",
  ">": "Remove from buffer",
  "6": "Activate DDIC runtime descriptions (nametabs)",
  "7": "Execute special after import methods",
  "9": "Execute standard XPRAs",
  A: "Activation",
  B: "Inactive import",
  C: "Deploy HANA objects",
  E: "Main export",
  G: "Generation",
  H: "ABAP Dictionary import",
  I: "Main import",
  J: "DDIC activation",
  L: "Import transport request object list",
  N: "Update",
  P: "Test import",
  Q: "Results confirmation",
  R: "Execute after import methods and XPRAs",
  S: "Distribute DDIC changes",
  T: "Deployment (non-ABAP)",
  U: "Read request metadata",
  V: "Version management",
  X: "ADO export (obsolete)",
  e: "Prepare for export",
  f: "Check write to buffers",
  g: "Import queue adjustment",
  h: "Accelerated DDIC import",
  i: "Accelerated main import",
  m: "Create cofile",
  n: "Update matchcode / enqueue objects",
  u: "Fast preview",
  v: "Create versions after import",
  w: "Create versions before import",
};

const EXPORT_STEPS = new Set(["E"]);
const IMPORT_STEPS = new Set(["I", "i", "H", "h", "A", "!"]);
const FORWARD_STEPS = new Set(["<"]);

// tp return codes: 0 ok, 4 warnings, 8 errors, ≥12 aborted.
export function rcSeverity(rc) {
  const n = Number.parseInt(rc, 10);
  if (!Number.isFinite(n)) return "unknown";
  if (n === 0) return "ok";
  if (n <= 4) return "warning";
  if (n <= 8) return "error";
  return "aborted";
}

// "20261008100325" (TSTAMP) → "2026-10-08T10:03:25Z" (tp logs in UTC).
export function tstampToIso(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(ts ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

// Group TPALOG rows by target system and decide where the request stands there.
export function summarizeTpalog(rows) {
  const bySystem = new Map();
  const sorted = [...(rows ?? [])].sort((a, b) => String(a.TRTIME).localeCompare(String(b.TRTIME)));
  for (const r of sorted) {
    const sid = r.TARSYSTEM || "?";
    if (!bySystem.has(sid)) bySystem.set(sid, []);
    bySystem.get(sid).push({
      step: r.TRSTEP,
      stepText: TP_STEPS[r.TRSTEP] ?? null,
      rc: r.RETCODE,
      severity: rcSeverity(r.RETCODE),
      client: r.TRCLI || undefined,
      time: tstampToIso(r.TRTIME),
      user: r.TRUSER || undefined,
    });
  }

  const targets = [];
  for (const [sid, steps] of bySystem) {
    const exported = steps.some((s) => EXPORT_STEPS.has(s.step));
    const imports = steps.filter((s) => IMPORT_STEPS.has(s.step));
    const forwarded = steps.some((s) => FORWARD_STEPS.has(s.step));
    const maxRc = steps.reduce((m, s) => {
      const n = Number.parseInt(s.rc, 10);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);

    let status;
    if (imports.length > 0) {
      status = maxRc >= 12 ? "import-aborted" : maxRc >= 8 ? "imported-with-errors" : "imported";
    } else if (exported) {
      status = maxRc >= 8 ? "export-failed" : "exported";
    } else if (forwarded) {
      status = "in-import-queue";
    } else {
      status = "logged";
    }

    targets.push({
      system: sid,
      status,
      maxRc,
      lastAction: steps[steps.length - 1]?.time ?? null,
      steps,
    });
  }
  return targets;
}

export function describeHeader(row) {
  if (!row) return null;
  return {
    transport: row.TRKORR,
    type: row.TRFUNCTION,
    status: row.TRSTATUS,
    statusText: TR_STATUS[row.TRSTATUS] ?? null,
    target: row.TARSYSTEM || undefined,
    owner: row.AS4USER,
    lastChanged:
      row.AS4DATE && /^\d{8}$/.test(row.AS4DATE)
        ? `${row.AS4DATE.slice(0, 4)}-${row.AS4DATE.slice(4, 6)}-${row.AS4DATE.slice(6, 8)}`
        : row.AS4DATE,
    parent: row.STRKORR || undefined,
  };
}
