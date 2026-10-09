// Test doubles shared by the tools that answer from Data Preview SELECTs.

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build a Data Preview (shape A: <row><value>) response for the given rows.
export function dataPreviewXml(rows) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const meta = columns
    .map((c) => `<dataPreview:metadata dataPreview:name="${esc(c)}" dataPreview:type="C"/>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<dataPreview:row>${columns.map((c) => `<dataPreview:value>${esc(r[c])}</dataPreview:value>`).join("")}</dataPreview:row>`
    )
    .join("");
  return (
    `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
    `<dataPreview:totalRows>${rows.length}</dataPreview:totalRows>` +
    `<dataPreview:columns>${meta}</dataPreview:columns>` +
    `<dataPreview:values>${body}</dataPreview:values>` +
    `</dataPreview:tableData>`
  );
}

export function response(status, text, contentType = "application/xml") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => text,
  };
}

// A fake AdtClient whose freestyle SELECTs are answered by the first route whose
// regex matches the statement. Unmatched statements return an empty result.
// Every call is recorded in `calls`.
export function sqlClient(routes) {
  const calls = [];
  return {
    calls,
    request: async (call) => {
      calls.push(call);
      for (const [re, rows] of routes) {
        if (re.test(call.body)) {
          if (typeof rows === "number") return response(rows, "<error/>");
          return response(200, dataPreviewXml(rows));
        }
      }
      return response(200, dataPreviewXml([]));
    },
  };
}

export function ctxFor(clients, { defaultSystem = Object.keys(clients)[0], profiles = {} } = {}) {
  return {
    config: { defaultSystem, systems: clients },
    getClient: (name) => {
      const n = name ?? defaultSystem;
      if (!clients[n]) throw new Error(`Unknown system '${n}'.`);
      return { name: n, client: clients[n], profile: profiles[n] ?? {} };
    },
  };
}

export function parse(result) {
  return JSON.parse(result.content[0].text);
}
