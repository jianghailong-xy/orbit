"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRuntimeProvider = normalizeRuntimeProvider;
exports.initializesRuntimeDynamically = initializesRuntimeDynamically;
exports.normalizeBuiltinPermissionMode = normalizeBuiltinPermissionMode;
exports.normalizeEffortForProvider = normalizeEffortForProvider;
exports.normalizeEffortForRuntimeModel = normalizeEffortForRuntimeModel;
const shared_1 = require("@orbit/shared");
const runtime_model_1 = require("./runtime-model");
// Closed CLI enums. An account default last picked in an OpenCode session (whose variants are
// model-defined and open-ended) must degrade to runtime Default rather than make these fail.
const CLAUDE_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set([
    '',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
]);
/**
 * Turn a persisted provider identity into a built-in runner runtime.
 *
 * Configured-provider slugs are resolved before dispatch; callers using this helper are handling
 * built-in session state, so an unknown/stale identity keeps the historical Claude fallback.
 */
function normalizeRuntimeProvider(value, providerBuiltin = true) {
    if (value === shared_1.AgentProvider.CODEX)
        return shared_1.AgentProvider.CODEX;
    if (value === shared_1.AgentProvider.OPENCODE)
        return shared_1.AgentProvider.OPENCODE;
    if (value === shared_1.AgentProvider.KIMI && providerBuiltin)
        return shared_1.AgentProvider.KIMI;
    return shared_1.AgentProvider.CLAUDE;
}
/** Runtimes that learn their durable conversation id only after process initialization. */
function initializesRuntimeDynamically(provider) {
    return (provider === shared_1.AgentProvider.CODEX ||
        provider === shared_1.AgentProvider.KIMI ||
        provider === shared_1.AgentProvider.OPENCODE);
}
/** Prevent a runner from receiving a model/permission combination its built-in CLI rejects.
 *
 * This is the ONE place the constraint is enforced. The pickers only describe it (via
 * derivePermissionSemantics, off the same table), because a client-side gate is not a boundary:
 * an account default, an MCP-created session and an older client all reach dispatch without
 * passing through one. Same division as modelForProvider.
 *
 * `customProvider` is true when the model came from an enabled configured ModelProvider row; its
 * model space is vendor-defined, so the static Claude allow-list cannot police it and the CLI
 * decides for itself (it accepts Auto for any model it doesn't recognize as unsupported).
 *
 * `runsAsRoot` is the assigned runner's report about itself. It gates Bypass, which Claude Code
 * refuses under root by exiting during startup — so unlike the Auto case this is not a mode that
 * merely goes unenforced, it is a session that never runs at all. Substituting here rather than
 * rejecting is what keeps an *account-level* Bypass default from failing every session on a root
 * runner; a caller that named Bypass explicitly is told instead (assertPermissionModeRunnable). */
function normalizeBuiltinPermissionMode(provider, model, permissionMode, customProvider = false, runsAsRoot) {
    if (!(0, shared_1.permissionModeAvailableOnRunner)(permissionMode, runsAsRoot)) {
        return shared_1.ROOT_FALLBACK_PERMISSION_MODE;
    }
    if (permissionMode !== shared_1.PermissionMode.AUTO)
        return permissionMode;
    return (0, shared_1.autoAvailable)(provider, model, customProvider) ? permissionMode : shared_1.PermissionMode.DEFAULT;
}
/**
 * Keep persisted effort values valid when a session changes runtime or is resumed from an older
 * client. Kimi's vocabulary tops out at `max` and has no `minimal`/`medium`. Which levels a Codex
 * or Kimi model actually accepts is per-model (K2.7 Coding accepts none at all), so this maps the
 * vocabulary and `normalizeEffortForRuntimeModel` applies the model's own list. OpenCode variants are
 * model/provider-defined and stay open-ended, so only the closed CLI enums are clamped.
 */
function normalizeEffortForProvider(provider, effort) {
    if (effort == null)
        return undefined;
    if (provider === shared_1.AgentProvider.OPENCODE)
        return effort;
    if (provider === shared_1.AgentProvider.KIMI) {
        if (effort === 'minimal')
            return 'low';
        if (effort === 'medium')
            return 'high';
        if (effort === 'xhigh')
            return 'max';
        return effort;
    }
    if (provider === shared_1.AgentProvider.CODEX) {
        return CODEX_EFFORTS.has(effort) ? effort : '';
    }
    return CLAUDE_EFFORTS.has(effort) ? effort : '';
}
/** Runtimes whose reasoning levels are per-model, so only the assigned runner's catalog can say
 *  whether one is valid. OpenCode's variants are model/provider-defined; Kimi's are declared by
 *  each model's `supportEfforts` and rejected with invalid_params when they are not. */
const MODEL_DEFINED_EFFORT_RUNTIMES = [
    shared_1.AgentProvider.CODEX,
    shared_1.AgentProvider.OPENCODE,
    shared_1.AgentProvider.KIMI,
];
/**
 * The dispatch-time variant check, applied once the assigned runner's model catalog is known.
 *
 * These runtimes' levels are model-defined, so `normalizeEffortForProvider` alone cannot police
 * them: an account-level default picked in a Claude session (`max`) would otherwise reach OpenCode
 * as `--variant=max` and fail the turn, or reach Kimi's K2.7 Coding, which declares no levels at
 * all. Mirrors the web picker's rule — an exact catalog row is authoritative even when it lists no
 * variants, while a model the runner-wide catalog does not report may be project-scoped (or come
 * from a runner too old to probe its CLI) and keeps its value.
 */
function normalizeEffortForRuntimeModel(provider, effort, model, modelCatalog) {
    const normalized = normalizeEffortForProvider(provider, effort);
    if (!MODEL_DEFINED_EFFORT_RUNTIMES.includes(provider) || !normalized)
        return normalized;
    const levels = (0, runtime_model_1.runtimeCatalogReasoningLevels)(modelCatalog, provider, model);
    if (levels === undefined)
        return normalized;
    return levels.includes(normalized) ? normalized : '';
}
//# sourceMappingURL=runtime-provider.js.map