// Helpers for /sap/bc/adt/repository/nodestructure — the ADT package tree endpoint.
//
// Returns XML like:
//   <SEU_ADT_REPOSITORY_OBJ_NODE>
//     <OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>
//     <OBJECT_NAME>ZCL_FOO</OBJECT_NAME>
//     <DESCRIPTION>...</DESCRIPTION>
//   </SEU_ADT_REPOSITORY_OBJ_NODE>

const NODE_RE =
  /<SEU_ADT_REPOSITORY_OBJ_NODE>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/g;

export function buildNodeStructureQuery(packageName) {
  return new URLSearchParams({
    parent_name: packageName,
    parent_tech_name: packageName,
    parent_type: "DEVC/K",
    withShortDescriptions: "true",
  });
}

export async function fetchPackageNodes(client, packageName) {
  const q = buildNodeStructureQuery(packageName).toString();
  const res = await client.request({
    method: "POST",
    path: "/sap/bc/adt/repository/nodestructure?" + q,
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body, nodes: res.ok ? parseNodes(body) : [] };
}

export function parseNodes(xml) {
  const out = [];
  for (const m of xml.matchAll(NODE_RE)) {
    const block = m[1];
    const type = field(block, "OBJECT_TYPE");
    const name = field(block, "OBJECT_NAME");
    const description = field(block, "DESCRIPTION") ?? "";
    if (type && name) out.push({ type, name, description });
  }
  return out;
}

function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decodeEntities(m[1]) : undefined;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
