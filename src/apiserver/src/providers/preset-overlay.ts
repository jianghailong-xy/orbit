import { providerPreset } from '@orbit/shared';
import { catalogDefaultModel, catalogModels } from './model-catalog';

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
 * A following row takes the catalogue's current pick — the newest model the vendor offers — rather
 * than the copy it stored when it was created: following the vendor is the whole point of the flag,
 * and a default frozen at creation time is how a provider ends up dispatching last year's model
 * months after its successor shipped. A row that wants a specific model takes ownership of its list
 * (followsPreset false) and keeps its own default from then on.
 */
export function presetDefaultModel(row: PresetBackedRow): string | null {
  const preset = governing(row);
  return preset ? catalogDefaultModel(preset) : row.defaultModel;
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
  // runner's live catalogue over this list without having to know the endpoint. For everyone else
  // catalogModels() has already folded in whatever the last models.dev refresh found.
  return {
    ...row,
    models: catalogModels(preset),
    defaultModel: presetDefaultModel(row),
    modelsFromRuntime: preset.modelsFromRuntime ?? false,
  } as T;
}

/**
 * Whether this row's model space is the runtime CLI's own — the vendor IS that CLI's endpoint
 * (Anthropic for `claude`, OpenAI for `codex`), so the runner's live probe describes it and the
 * preset's `models`/`defaultModel` are only the fallback for a runner that hasn't reported one.
 * The pickers already resolve these rows off the runner's catalogue (web `modelOptionsForProvider`,
 * Swift `AgentDefaults.models(for:catalog:configured:)`); this is what lets dispatch agree.
 */
export function followsRuntimeCatalog(row: PresetBackedRow): boolean {
  return governing(row)?.modelsFromRuntime === true;
}

/**
 * Whether this row's model space contains `model` — what a provider switch on a live session asks
 * before deciding whether the session keeps the model it is running or restarts on the new
 * provider's default.
 *
 * A row whose vendor IS the runtime CLI's own endpoint has no list to check: its space is whatever
 * that CLI reports, the same space the built-in engine draws from, so every model in it survives
 * the move. That is the case this exists for — two Anthropic accounts, one model.
 */
export function ownsModel(row: PresetBackedRow, model: string): boolean {
  if (!model) return false;
  const preset = governing(row);
  if (preset?.modelsFromRuntime) return true;
  const models = preset ? catalogModels(preset) : row.models;
  return (
    Array.isArray(models) &&
    models.some(
      (entry) =>
        !!entry && typeof entry === 'object' && (entry as { value?: unknown }).value === model,
    )
  );
}
