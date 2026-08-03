import { providerPreset } from '@orbit/shared';

/** The fields of a ModelProvider row the preset governs (a subset of the Prisma row). */
export interface PresetBackedRow {
  presetSlug?: string | null;
  /** False for a row that keeps its vendor identity but maintains its own model list. */
  followsPreset?: boolean;
  models?: unknown;
  defaultModel: string | null;
}

/** The catalogue governing this row's models, or undefined when the row governs its own. */
function governing(row: PresetBackedRow) {
  return row.followsPreset ? providerPreset(row.presetSlug) : undefined;
}

/**
 * The model a configured-provider session dispatches with when it has no explicit model.
 *
 * A following row keeps whatever default it stored as long as the preset still offers it — an
 * admin who pinned Sonnet keeps Sonnet — but a stored id the catalogue has dropped (a retired
 * model) yields to the preset's current choice rather than reaching the runner as a dead `-m`.
 */
export function presetDefaultModel(row: PresetBackedRow): string | null {
  const preset = governing(row);
  if (!preset) return row.defaultModel;
  const stored = row.defaultModel;
  return stored && preset.models.some((m) => m.value === stored) ? stored : preset.defaultModel;
}

/**
 * Serve a preset-backed row's catalogue from the preset instead of from the copy taken when it was
 * created. This is what makes a model added to PROVIDER_PRESETS show up in the pickers of every
 * provider already configured from that preset — including on iOS and macOS, which read these rows
 * off the API and hold no catalogue of their own.
 *
 * A row that follows nothing (a custom endpoint, or one whose list the user edited) is returned
 * untouched, as is one whose preset we no longer ship — there the stored copy is all we have, and
 * it's better than an empty picker.
 */
export function withPreset<T extends PresetBackedRow>(row: T): T {
  const preset = governing(row);
  if (!preset) return row;
  // `models` here is the fallback for a vendor whose CLI reports its own — see modelsFromRuntime
  // on the preset. The flag rides along so the pickers (and the connect form) know to prefer the
  // runner's live catalogue over this list without having to know the endpoint.
  return {
    ...row,
    models: preset.models,
    defaultModel: presetDefaultModel(row),
    modelsFromRuntime: preset.modelsFromRuntime ?? false,
  } as T;
}
