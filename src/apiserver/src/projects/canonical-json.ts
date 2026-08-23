/**
 * Key-sorted JSON, so a hash over a structure cannot depend on key order or on how a caller built
 * the object. Used by every digest that has to survive being recomputed by a different code path.
 */

/** Byte order, never a database collation — the same reason `ORDER BY … COLLATE "C"` is spelled out. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}
