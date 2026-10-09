// Classify an SAP system from its CVERS rows (installed software components).
//
// CVERS is present on every NetWeaver / ABAP Platform system and drives the
// standard System > Status screen, so it is a deterministic signal for
// "S/4HANA or ECC, which release, which SP" — the question the Clean Core
// prompts used to answer heuristically.

// S4CORE release → S/4HANA on-premise product version.
const S4_VERSIONS = {
  100: "1511",
  101: "1610",
  102: "1709",
  103: "1809",
  104: "1909",
  105: "2020",
  106: "2021",
  107: "2022",
  108: "2023",
  109: "2025",
};

// ABAP Cloud (the restricted language version + released-API contract) is
// supported on-premise from ABAP Platform 2022 on, i.e. SAP_BASIS 7.57. Release
// numbering jumped from 758 to 816 with 2025, so a numeric compare holds.
const ABAP_CLOUD_MIN_BASIS = 757;

// Components worth surfacing without the caller asking for the full list.
const KEY_COMPONENTS = [
  "SAP_BASIS",
  "SAP_ABA",
  "SAP_GWFND",
  "SAP_UI",
  "S4CORE",
  "S4COREOP",
  "S4FND",
  "SAP_APPL",
  "EA-APPL",
];

function spLevel(extRelease) {
  const n = Number.parseInt(String(extRelease ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function component(row) {
  return {
    component: row.COMPONENT,
    release: row.RELEASE,
    spLevel: spLevel(row.EXTRELEASE),
    type: row.COMP_TYPE || undefined,
  };
}

export function classifySystem(rows) {
  const byName = new Map();
  for (const row of rows ?? []) {
    if (row?.COMPONENT) byName.set(String(row.COMPONENT).toUpperCase(), row);
  }

  const basis = byName.get("SAP_BASIS");
  const s4core = byName.get("S4CORE");
  const sapAppl = byName.get("SAP_APPL");

  let product;
  if (s4core) {
    const version = S4_VERSIONS[Number.parseInt(s4core.RELEASE, 10)];
    product = {
      kind: "S/4HANA",
      version: version ?? null,
      label: version ? `SAP S/4HANA ${version}` : `SAP S/4HANA (S4CORE ${s4core.RELEASE})`,
      spLevel: spLevel(s4core.EXTRELEASE),
      onPremise: byName.has("S4COREOP"),
    };
  } else if (sapAppl) {
    product = {
      kind: "ECC",
      version: sapAppl.RELEASE,
      label: `SAP ERP / ECC (SAP_APPL ${sapAppl.RELEASE})`,
      spLevel: spLevel(sapAppl.EXTRELEASE),
    };
  } else {
    product = {
      kind: "NetWeaver",
      version: basis?.RELEASE ?? null,
      label: "SAP NetWeaver / ABAP Platform without an ERP application layer",
    };
  }

  const basisRelease = Number.parseInt(basis?.RELEASE ?? "", 10);
  const abapCloud = Number.isFinite(basisRelease)
    ? {
        supported: basisRelease >= ABAP_CLOUD_MIN_BASIS,
        reason:
          basisRelease >= ABAP_CLOUD_MIN_BASIS
            ? `SAP_BASIS ${basis.RELEASE} ≥ 757 — the ABAP Cloud development model is available on this release.`
            : `SAP_BASIS ${basis.RELEASE} < 757 — ABAP Cloud needs ABAP Platform 2022 (SAP_BASIS 757) or later; use classic ABAP guidance.`,
      }
    : { supported: null, reason: "SAP_BASIS not found in CVERS." };

  return {
    product,
    sapBasis: basis ? component(basis) : null,
    abapCloud,
    keyComponents: KEY_COMPONENTS.filter((n) => byName.has(n)).map((n) => component(byName.get(n))),
    componentCount: byName.size,
  };
}
