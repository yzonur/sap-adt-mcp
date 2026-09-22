import { parseAdtError, hintForAdtError } from "./adt-error.js";

export function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

export function errorResult(system, status, body, contentType, extra = {}) {
  // `extra.hint` is a call-site fallback: a tool that knows *which* argument it
  // just sent can explain a backend message too generic to key a global rule on.
  // A matching global hint still wins — it is derived from the backend's own text.
  const { hint: callerHint, ...rest } = extra;
  const parsed = parseAdtError(body, contentType);
  // A caller-side hint when the backend message describes something we asked
  // for wrongly (missing transport / stale lock handle) rather than a fault.
  const hint = hintForAdtError(parsed) ?? callerHint;
  const result = jsonResult(
    {
      system,
      status,
      ok: false,
      ...rest,
      error: parsed ?? { raw: typeof body === "string" ? body.slice(0, 4000) : body },
      ...(hint ? { hint } : {}),
    },
    true
  );
  // Attach structured metadata for the crash-report wrapper to classify against,
  // without changing the content the client sees. Non-enumerable so it never
  // serializes into the MCP result.
  Object.defineProperty(result, "_adtError", {
    value: {
      system,
      status,
      type: parsed?.type,
      namespace: parsed?.namespace,
      t100: parsed?.properties?.t100,
      message: parsed?.message ?? parsed?.localizedMessage,
      stage: rest.stage,
    },
    enumerable: false,
  });
  return result;
}
