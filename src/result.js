import { parseAdtError } from "./adt-error.js";

export function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

export function errorResult(system, status, body, contentType, extra = {}) {
  const parsed = parseAdtError(body, contentType);
  const result = jsonResult(
    {
      system,
      status,
      ok: false,
      ...extra,
      error: parsed ?? { raw: typeof body === "string" ? body.slice(0, 4000) : body },
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
      stage: extra.stage,
    },
    enumerable: false,
  });
  return result;
}
