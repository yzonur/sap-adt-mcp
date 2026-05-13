import { parseAdtError } from "./adt-error.js";

export function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

export function errorResult(system, status, body, contentType, extra = {}) {
  const parsed = parseAdtError(body, contentType);
  return jsonResult(
    {
      system,
      status,
      ok: false,
      ...extra,
      error: parsed ?? { raw: typeof body === "string" ? body.slice(0, 4000) : body },
    },
    true
  );
}
