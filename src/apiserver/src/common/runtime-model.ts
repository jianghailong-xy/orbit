import {
  AgentProvider,
  type RunnerModelCatalog,
  type RuntimeDefaultModels,
} from '@orbit/shared';

/** Normalize the heartbeat snapshot before it reaches clients or dispatch. Invalid/stale entries
 * are dropped independently so one malformed runtime cannot hide the other reported defaults. */
export function sanitizeRuntimeDefaultModels(value: unknown): RuntimeDefaultModels {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: RuntimeDefaultModels = {};
  for (const runtime of Object.values(AgentProvider)) {
    const model = source[runtime];
    if (typeof model !== 'string') continue;
    const trimmed = model.trim();
    if (trimmed) result[runtime] = trimmed;
  }
  return result;
}

export function savedRuntimeDefaultModel(value: unknown, runtime: AgentProvider): string | undefined {
  return sanitizeRuntimeDefaultModels(value)[runtime];
}

/** The runner reports catalogs in preference order. The first usable row is the fallback when the
 * Runtime cannot report its effective default directly. */
export function firstRuntimeCatalogModel(value: unknown, runtime: AgentProvider): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rows = (value as RunnerModelCatalog)[runtime];
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (row && typeof row.value === 'string' && row.value.trim()) return row.value.trim();
  }
  return undefined;
}
