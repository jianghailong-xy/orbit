"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.presetDefaultModel = presetDefaultModel;
exports.withPreset = withPreset;
exports.followsRuntimeCatalog = followsRuntimeCatalog;
exports.ownsModel = ownsModel;
const shared_1 = require("@orbit/shared");
const model_catalog_1 = require("./model-catalog");
/** The catalogue governing this row's models, or undefined when the row governs its own. */
function governing(row) {
    return row.followsPreset ? (0, shared_1.providerPreset)(row.presetSlug) : undefined;
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
function presetDefaultModel(row) {
    const preset = governing(row);
    return preset ? (0, model_catalog_1.catalogDefaultModel)(preset) : row.defaultModel;
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
function withPreset(row) {
    const preset = governing(row);
    if (!preset)
        return row;
    // `models` here is the fallback for a vendor whose CLI reports its own — see modelsFromRuntime
    // on the preset. The flag rides along so the pickers (and the connect form) know to prefer the
    // runner's live catalogue over this list without having to know the endpoint. For everyone else
    // catalogModels() has already folded in whatever the last models.dev refresh found.
    return {
        ...row,
        models: (0, model_catalog_1.catalogModels)(preset),
        defaultModel: presetDefaultModel(row),
        modelsFromRuntime: preset.modelsFromRuntime ?? false,
    };
}
/**
 * Whether this row's model space is the runtime CLI's own — the vendor IS that CLI's endpoint
 * (Anthropic for `claude`, OpenAI for `codex`), so the runner's live probe describes it and the
 * preset's `models`/`defaultModel` are only the fallback for a runner that hasn't reported one.
 * The pickers already resolve these rows off the runner's catalogue (web `modelOptionsForProvider`,
 * Swift `WorkspaceDefaults.models(for:catalog:configured:)`); this is what lets dispatch agree.
 */
function followsRuntimeCatalog(row) {
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
function ownsModel(row, model) {
    if (!model)
        return false;
    const preset = governing(row);
    if (preset?.modelsFromRuntime)
        return true;
    const models = preset ? (0, model_catalog_1.catalogModels)(preset) : row.models;
    return (Array.isArray(models) &&
        models.some((entry) => !!entry && typeof entry === 'object' && entry.value === model));
}
//# sourceMappingURL=preset-overlay.js.map