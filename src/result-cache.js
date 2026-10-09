// Short-lived cache of read-only tool results within one MCP server process.
//
// An agent session tends to repeat the same discovery calls (search, package
// walks, where-used) while it reasons; each one is a full ADT round-trip. Results
// of the tools below are cached for a short TTL and the whole cache is dropped on
// any write the ADT client performs, so a result never outlives a change made
// through this server. Changes made elsewhere (SAP GUI, Eclipse) can be up to one
// TTL stale — hence the short default.
//
//   "cache": { "ttlMs": 60000 }      0 disables
//   SAP_ADT_MCP_CACHE_TTL_MS=0       env override

export const CACHEABLE_TOOLS = new Set([
  "adt_search_objects",
  "adt_browse_package",
  "adt_list_packages",
  "adt_where_used",
  "adt_system_info",
  "adt_value_help",
]);

export const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 200;

// JSON with sorted object keys, so {a,b} and {b,a} share a cache key.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(tool, system, args) {
  const { system: _ignored, ...rest } = args ?? {};
  return `${tool}\u0000${system ?? ""}\u0000${stableStringify(rest)}`;
}

export function createResultCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  const entries = new Map();
  const enabled = Number.isFinite(ttlMs) && ttlMs > 0;

  return {
    enabled,
    ttlMs,
    get(key) {
      if (!enabled) return undefined;
      const hit = entries.get(key);
      if (!hit) return undefined;
      const age = now() - hit.at;
      if (age >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return { value: hit.value, ageMs: age };
    },
    set(key, value) {
      if (!enabled) return;
      entries.delete(key);
      entries.set(key, { value, at: now() });
      // Map iteration order is insertion order: the first key is the oldest.
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

export function parseCacheConfig(raw) {
  const env = process.env.SAP_ADT_MCP_CACHE_TTL_MS;
  if (env !== undefined && env !== "") {
    const n = Number(env);
    return { ttlMs: Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS };
  }
  const r = raw && typeof raw === "object" ? raw : {};
  const n = Number(r.ttlMs);
  return { ttlMs: r.ttlMs !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS };
}

// Serve a cacheable tool call from cache, or run it and remember a successful
// result. Error results are never cached. A hit is marked in the result's _meta
// so a client (or a debugging human) can tell it did not hit SAP.
export async function withResultCache(cache, { tool, system, args }, run) {
  if (!cache.enabled || !CACHEABLE_TOOLS.has(tool)) return run();
  const key = cacheKey(tool, system, args);
  const hit = cache.get(key);
  if (hit) {
    return {
      ...hit.value,
      _meta: { ...hit.value._meta, "sap-adt-mcp/cache": { hit: true, ageMs: hit.ageMs } },
    };
  }
  const out = await run();
  if (out && !out.isError) cache.set(key, out);
  return out;
}
