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

/** The models a runner currently reports for one runtime, or undefined when it has reported no
 * catalog for it — the list a stored model is judged against before being treated as retired. */
export function runtimeCatalogModels(
  value: unknown,
  runtime: AgentProvider,
): Array<{ value: string }> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rows = (value as RunnerModelCatalog)[runtime];
  if (!Array.isArray(rows)) return undefined;
  return rows
    .filter((row) => !!row && typeof row.value === 'string' && !!row.value.trim())
    .map((row) => ({ value: row.value.trim() }));
}

/** The reasoning levels/variants a runner reports for one runtime model, or undefined when the
 * heartbeat catalog has no exact row for it. The heartbeat catalog is deliberately runner-wide,
 * so "no row" means "possibly project-scoped", not "unsupported". */
export function runtimeCatalogReasoningLevels(
  value: unknown,
  runtime: AgentProvider,
  model: string,
): string[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rows = (value as RunnerModelCatalog)[runtime];
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((entry) => entry && entry.value === model);
  if (!row) return undefined;
  return Array.isArray(row.reasoningLevels)
    ? row.reasoningLevels.filter((level): level is string => typeof level === 'string')
    : [];
}
