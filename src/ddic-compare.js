// Pure helpers for adt_compare_ddic: turn the DDIC rows of one table (DD02L,
// DD03L, DD09L, DD12L/DD17S, DD08L/DD05S) into a comparable snapshot, and diff
// two snapshots. The tool itself (src/tools/ddic-compare.js) only fetches rows.

const HEADER = {
  TABCLASS: "tableCategory",
  CLIDEP: "clientDependent",
  CONTFLAG: "deliveryClass",
  MAINFLAG: "maintenance",
  EXCLASS: "enhancementCategory",
};

const FIELD = {
  KEYFLAG: "key",
  ROLLNAME: "dataElement",
  DOMNAME: "domain",
  DATATYPE: "dataType",
  LENG: "length",
  DECIMALS: "decimals",
  NOTNULL: "notNull",
  CHECKTABLE: "checkTable",
  REFTABLE: "refTable",
  REFFIELD: "refField",
  COMPTYPE: "componentType",
};

const TECHNICAL = {
  TABART: "dataClass",
  TABKAT: "sizeCategory",
  BUFALLOW: "bufferingAllowed",
  PUFFERUNG: "bufferingType",
  SCHFELDANZ: "genericKeyFields",
  PROTOKOLL: "logChanges",
};

const INDEX = {
  UNIQUEFLAG: "unique",
  DBINCLEXCL: "dbSystemsMode",
  DBSYSSEL1: "dbSystem1",
  DBSYSSEL2: "dbSystem2",
  DBSYSSEL3: "dbSystem3",
  DBSYSSEL4: "dbSystem4",
};

const FOREIGN_KEY = {
  CHECKTABLE: "checkTable",
  FRKART: "fieldType",
  CARDLEFT: "cardinalityLeft",
  CARD: "cardinality",
  CHECKFLAG: "checkRequired",
};

// Numeric DDIC columns come back zero-padded ("000003"); compare them as numbers.
function clean(value) {
  if (value == null) return "";
  const s = String(value).trim();
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

function pick(row, columns) {
  const out = {};
  for (const [col, name] of Object.entries(columns)) out[name] = clean(row?.[col]);
  return out;
}

// .INCLUDE / .APPEND rows share a FIELDNAME; the structure they pull in
// (PRECFIELD) tells them apart.
export function fieldKey(row) {
  return row.FIELDNAME?.startsWith(".") ? `${row.FIELDNAME} ${row.PRECFIELD ?? ""}`.trim() : row.FIELDNAME;
}

export function snapshot({ header, fields, technical, indexes, indexFields, foreignKeys, foreignKeyFields }) {
  const fieldMap = new Map();
  const order = [];
  for (const r of [...(fields ?? [])].sort((a, b) => Number(a.POSITION) - Number(b.POSITION))) {
    const key = fieldKey(r);
    if (!key || fieldMap.has(key)) continue;
    fieldMap.set(key, pick(r, FIELD));
    order.push(key);
  }

  const indexMap = new Map();
  for (const r of indexes ?? []) indexMap.set(r.INDEXNAME, { ...pick(r, INDEX), fields: [] });
  for (const r of [...(indexFields ?? [])].sort((a, b) => Number(a.POSITION) - Number(b.POSITION))) {
    indexMap.get(r.INDEXNAME)?.fields.push(r.FIELDNAME);
  }
  for (const v of indexMap.values()) v.fields = v.fields.join(", ");

  const fkMap = new Map();
  for (const r of foreignKeys ?? []) fkMap.set(r.FIELDNAME, { ...pick(r, FOREIGN_KEY), assignment: [] });
  for (const r of [...(foreignKeyFields ?? [])].sort((a, b) => Number(a.PRIMPOS) - Number(b.PRIMPOS))) {
    const fk = fkMap.get(r.FIELDNAME);
    if (!fk) continue;
    fk.assignment.push(r.FORSTRING ? `'${r.FORSTRING}'` : `${r.FORTABLE}-${r.FORKEY}`);
  }
  for (const v of fkMap.values()) v.assignment = v.assignment.join(", ");

  return {
    header: header ? pick(header, HEADER) : null,
    fields: fieldMap,
    order,
    technical: technical ? pick(technical, TECHNICAL) : null,
    indexes: indexMap,
    foreignKeys: fkMap,
  };
}

// Attribute-level changes between two flat records: { attr: { a, b } }.
export function diffRecord(a, b) {
  const changes = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if ((a?.[k] ?? "") !== (b?.[k] ?? "")) changes[k] = { a: a?.[k] ?? null, b: b?.[k] ?? null };
  }
  return changes;
}

// Keyed diff: entries only in A, only in B, and changed in both.
export function diffKeyed(a, b) {
  const onlyInA = [...a.keys()].filter((k) => !b.has(k));
  const onlyInB = [...b.keys()].filter((k) => !a.has(k));
  const changed = [];
  for (const [k, va] of a) {
    if (!b.has(k)) continue;
    const changes = diffRecord(va, b.get(k));
    if (Object.keys(changes).length > 0) changed.push({ name: k, changes });
  }
  return {
    ...(onlyInA.length ? { onlyInA: onlyInA.map((k) => ({ name: k, ...a.get(k) })) } : {}),
    ...(onlyInB.length ? { onlyInB: onlyInB.map((k) => ({ name: k, ...b.get(k) })) } : {}),
    ...(changed.length ? { changed } : {}),
  };
}

// True when the fields both sides share appear in a different order.
export function orderChanged(orderA, orderB) {
  const common = new Set(orderA.filter((k) => orderB.includes(k)));
  const a = orderA.filter((k) => common.has(k));
  const b = orderB.filter((k) => common.has(k));
  return a.some((k, i) => k !== b[i]);
}

export function compareSnapshots(a, b) {
  const header = diffRecord(a.header, b.header);
  const technical = diffRecord(a.technical, b.technical);
  const fields = diffKeyed(a.fields, b.fields);
  if (orderChanged(a.order, b.order)) fields.orderChanged = true;
  const indexes = diffKeyed(a.indexes, b.indexes);
  const foreignKeys = diffKeyed(a.foreignKeys, b.foreignKeys);
  const sections = { header, fields, technicalSettings: technical, indexes, foreignKeys };
  const identical = Object.values(sections).every((s) => Object.keys(s).length === 0);
  return {
    identical,
    ...Object.fromEntries(Object.entries(sections).filter(([, s]) => Object.keys(s).length > 0)),
    counts: {
      fieldsA: a.fields.size,
      fieldsB: b.fields.size,
      indexesA: a.indexes.size,
      indexesB: b.indexes.size,
      foreignKeysA: a.foreignKeys.size,
      foreignKeysB: b.foreignKeys.size,
    },
  };
}
