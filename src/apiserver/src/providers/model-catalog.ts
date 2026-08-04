import { PROVIDER_PRESETS, type ProviderPreset, type ProviderPresetModel } from '@orbit/shared';

/**
 * The live model catalogue for third-party vendors, refreshed from models.dev.
 *
 * A preset's own `models` list only changes when someone edits it and ships a release, which is how
 * a vendor's new flagship ends up missing from the picker for weeks. Each third-party preset names
 * its models.dev counterpart (ProviderPreset.catalog); ModelCatalogService fetches that catalogue
 * periodically and parks the result here, and every read of a preset-backed provider goes through
 * `catalogModels` — so a model that shipped after this build reaches web, iOS and macOS without a
 * release, exactly as the runtime-CLI probe already does for Anthropic and OpenAI.
 *
 * Process-wide rather than injected: the resolvers that need it (preset-overlay, and through it the
 * dispatch path in custom-provider) are pure functions called from everywhere, and this is a cache
 * of a public document — nothing per-request, per-user or secret passes through it.
 */

/** What a refresh contributes per vendor, newest first. Enough to cover a vendor's current
 *  generation without turning the picker into its full back catalogue. */
const PER_VENDOR_LIMIT = 6;

/** The models.dev fields we read; its api.json carries much more per model. */
interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  release_date?: unknown;
  modalities?: { output?: unknown };
  limit?: { context?: unknown };
}

/** Resolved model lists by preset slug. A slug is absent until a refresh finds models for it. */
export type ModelCatalog = Map<string, ProviderPresetModel[]>;

let live: ModelCatalog = new Map();

/** Install the result of a refresh. */
export function setModelCatalog(next: ModelCatalog): void {
  live = next;
}

/** The models a preset offers right now: its last refresh, else the list it ships with. */
export function catalogModels(preset: ProviderPreset): ProviderPresetModel[] {
  return live.get(preset.slug) ?? preset.models;
}

/**
 * The model a provider following this preset dispatches with: the newest one the vendor offers.
 *
 * Following the catalogue means following it all the way — a vendor's new flagship becomes the
 * default the day it lands, without anyone editing a provider. A row that wants to stay on a
 * specific model takes ownership of its list (followsPreset false), which is the same escape hatch
 * that governs the models themselves.
 *
 * Only a refresh moves this. The shipped `defaultModel` is a deliberate pick (MiniMax ships M2.7 as
 * its default over the newer M3), so it stands until there is live data to prefer.
 */
export function catalogDefaultModel(preset: ProviderPreset): string {
  return live.get(preset.slug)?.[0]?.value ?? preset.defaultModel;
}

/** What each preset offers right now, for the connect form — which is offering a vendor's models
 *  rather than resolving a saved row, and so can't get this from a provider. */
export function presetCatalog(presets: ProviderPreset[] = PROVIDER_PRESETS): Record<string, PresetCatalogEntry> {
  return Object.fromEntries(
    presets.map((p) => [p.slug, { models: catalogModels(p), defaultModel: catalogDefaultModel(p) }]),
  );
}

export interface PresetCatalogEntry {
  models: ProviderPresetModel[];
  defaultModel: string;
}

/** A value that changes exactly when the offered models do — what a refresh compares to decide
 *  whether anything is worth pushing to connected clients. */
export function catalogFingerprint(catalog: ModelCatalog): string {
  return JSON.stringify([...catalog.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Turn a models.dev api.json payload into per-preset model lists.
 *
 * Merges rather than replaces: the vendor's newest models lead, and anything the preset ships that
 * the refresh didn't surface is kept after them. That keeps a configured provider's pinned default
 * alive (it is always one of the shipped ids) and means a catalogue that renames or retires an id
 * can't empty a picker — the cost being that a genuinely withdrawn model lingers, which is where a
 * hand-maintained list already leaves us.
 *
 * Anything malformed is skipped rather than thrown on: this parses a document we don't control, and
 * the fallback for a vendor it says nothing usable about is the list we shipped.
 */
export function parseModelCatalog(payload: unknown, presets: ProviderPreset[] = PROVIDER_PRESETS): ModelCatalog {
  const catalog: ModelCatalog = new Map();
  if (!payload || typeof payload !== 'object') return catalog;
  const vendors = payload as Record<string, { models?: Record<string, CatalogEntry> } | undefined>;
  for (const preset of presets) {
    if (!preset.catalog) continue;
    const models = vendors[preset.catalog.source]?.models;
    if (!models || typeof models !== 'object') continue;
    const fresh = Object.values(models)
      .filter((m) => usable(m, preset.catalog!.match))
      .sort(byNewest)
      .slice(0, PER_VENDOR_LIMIT)
      .map(toPresetModel);
    // Nothing recognizable for this vendor (a renamed source, a shape we don't understand) — leave
    // the slug unset so reads keep falling back to the shipped list.
    if (fresh.length === 0) continue;
    const seen = new Set(fresh.map((m) => m.value));
    catalog.set(preset.slug, [...fresh, ...preset.models.filter((m) => !seen.has(m.value))]);
  }
  return catalog;
}

/** A model a coding agent can actually be pointed at: this vendor's, tool-calling, text out. */
function usable(m: CatalogEntry, match: RegExp): boolean {
  if (typeof m.id !== 'string' || !match.test(m.id)) return false;
  if (m.tool_call !== true) return false;
  const output = m.modalities?.output;
  return Array.isArray(output) && output.length === 1 && output[0] === 'text';
}

// Newest first — and the head of this order is what a following provider dispatches with, so the
// tie-break matters. Dates are ISO-ish strings of varying precision ("2026-01" alongside
// "2026-01-19"), which compare correctly as text; an entry without one sorts last. A vendor ships
// its variants on the same day as the model they derive from (`gemini-3.6-flash` with
// `gemini-3.5-flash-lite`, `kimi-k2.7-code` with `kimi-k2.7-code-highspeed`), and a variant is the
// base id plus a suffix — so on a tie the shorter id is the one to lead with.
function byNewest(a: CatalogEntry, b: CatalogEntry): number {
  const da = typeof a.release_date === 'string' ? a.release_date : '';
  const db = typeof b.release_date === 'string' ? b.release_date : '';
  const ia = String(a.id);
  const ib = String(b.id);
  return db.localeCompare(da) || ia.length - ib.length || ia.localeCompare(ib);
}

function toPresetModel(m: CatalogEntry): ProviderPresetModel {
  const id = m.id as string;
  const context = m.limit?.context;
  return {
    value: id,
    label: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id,
    ...(typeof context === 'number' && context > 0 ? { contextWindow: context } : {}),
  };
}
