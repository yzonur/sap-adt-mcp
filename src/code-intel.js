// Pure helpers for the code-intelligence tools (adt_type_hierarchy,
// adt_method_redefinitions, adt_call_hierarchy): include-name arithmetic,
// cross-reference names and include → owner resolution. The tools themselves
// (src/tools/code-intel.js) only fetch rows from SEOCLASS / SEOMETAREL /
// SEOREDEF / TMDIR / TFDIR / WBCROSSGT / CROSS.

// SEOMETAREL-RELTYPE.
export const RELTYPE = { INCLUDES: "0", IMPLEMENTS: "1", INHERITS: "2" };
export const RELATION = { 0: "includes", 1: "implements", 2: "inherits" };

const CLASS_POOL_WIDTH = 30;

// Method names may carry the interface prefix ("IF_FOO~BAR"); otherwise the
// repository-name alphabet. Returns the upper-cased name or null.
export function methodName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toUpperCase();
  if (name.length === 0 || name.length > 61) return null;
  return /^[A-Z0-9_/]+(~[A-Z0-9_/]+)?$/.test(name) ? name : null;
}

// TMDIR-METHODINDX (decimal) → the 3-character base-36 suffix of the method
// include: 29 → "00T", 77 → "025".
export function methodIncludeSuffix(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  return n.toString(36).toUpperCase().padStart(3, "0");
}

// The include that holds one method's implementation:
// CL_GUI_ALV_GRID + 29 → "CL_GUI_ALV_GRID===============CM00T".
export function methodInclude(className, index) {
  const suffix = methodIncludeSuffix(index);
  if (!suffix) return null;
  return `${className.padEnd(CLASS_POOL_WIDTH, "=")}CM${suffix}`;
}

// The include of a function module from TFDIR (PNAME + INCLUDE):
// SAPLSU_USER + 18 → "LSU_USERU18", /SDF/SAPLCOMUSER + 03 → "/SDF/LCOMUSERU03".
export function functionInclude(mainProgram, includeNo) {
  const m = /^(\/[^/]+\/)?SAPL(.+)$/.exec(mainProgram ?? "");
  if (!m || !includeNo) return null;
  return `${m[1] ?? ""}L${m[2]}U${includeNo}`;
}

// WBCROSSGT-NAME of a method: "CL_X\ME:M". An interface method implemented in a
// class ("IF_Y~M") is referenced under the interface: "IF_Y\ME:M".
export function crossRefName(className, method) {
  const [intf, own] = method.includes("~") ? method.split("~") : [className, method];
  return `${intf}\\ME:${own}`;
}

export function parseCrossRefName(name) {
  const m = /^(.+?)\\ME:(.+)$/.exec(name ?? "");
  return m ? { className: m[1], method: m[2] } : null;
}

const CLASS_SECTIONS = {
  CU: "public section",
  CO: "protected section",
  CI: "private section",
  CP: "class pool",
  CCDEF: "local definitions",
  CCIMP: "local implementations",
  CCMAC: "macros",
  CCAU: "test classes",
  IU: "interface section",
  IP: "interface pool",
};

// Classify an include name: a class method include, another class-pool
// include, a function module include, or a plain program / include.
export function parseInclude(include) {
  const name = String(include ?? "");
  if (name.length > CLASS_POOL_WIDTH) {
    const owner = name.slice(0, CLASS_POOL_WIDTH).replace(/=+$/, "");
    const rest = name.slice(CLASS_POOL_WIDTH);
    const cm = /^CM([0-9A-Z]{3})$/.exec(rest);
    if (owner && cm) return { kind: "method", className: owner, methodIndex: parseInt(cm[1], 36) };
    if (owner && CLASS_SECTIONS[rest]) return { kind: "class-include", className: owner, section: CLASS_SECTIONS[rest] };
  }
  const fm = /^(\/[^/]+\/)?L(.+)U([0-9A-Z]{2})$/.exec(name);
  if (fm) return { kind: "function-include", mainProgram: `${fm[1] ?? ""}SAPL${fm[2]}`, includeNo: fm[3] };
  return { kind: "include", include: name };
}

// Resolve WBCROSSGT / CROSS include names into callers: methods (via TMDIR),
// function modules (via TFDIR) or the include itself.
export function resolveIncludes(includes, tmdirRows, tfdirRows) {
  const methods = new Map();
  for (const r of tmdirRows ?? []) methods.set(`${r.CLASSNAME}\u0000${Number(r.METHODINDX)}`, r.METHODNAME);
  const functions = new Map();
  for (const r of tfdirRows ?? []) functions.set(`${r.PNAME}\u0000${r.INCLUDE}`, r.FUNCNAME);

  return includes.map((include) => {
    const p = parseInclude(include);
    if (p.kind === "method") {
      const method = methods.get(`${p.className}\u0000${p.methodIndex}`);
      return method ? { kind: "method", class: p.className, method, include } : { kind: "class", class: p.className, include };
    }
    if (p.kind === "class-include") return { kind: "class", class: p.className, section: p.section, include };
    if (p.kind === "function-include") {
      const fn = functions.get(`${p.mainProgram}\u0000${p.includeNo}`);
      if (fn) return { kind: "function", function: fn, include };
    }
    return { kind: "include", include };
  });
}
