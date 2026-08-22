"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBuiltinProvider = isBuiltinProvider;
exports.execRuntime = execRuntime;
exports.sessionExecRuntime = sessionExecRuntime;
exports.resolveProviderExec = resolveProviderExec;
const shared_1 = require("@orbit/shared");
const provider_crypto_1 = require("./provider-crypto");
const preset_overlay_1 = require("./preset-overlay");
const runtime_model_1 = require("../common/runtime-model");
// Built-in, first-class providers ship their own runtime CLI. Any other `provider` value is
// a control-plane-configured ModelProvider that borrows one of these runtimes.
/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug.
 * `providerBuiltin` is persisted only to fence the former custom `kimi` slug during rolling
 * deployment; Claude/Codex predate the discriminator, and migration 0080 moves any pre-existing
 * custom `opencode` row aside, so both remain unambiguous. */
function isBuiltinProvider(slug, providerBuiltin = true) {
    if (!slug || slug === shared_1.AgentProvider.CLAUDE || slug === shared_1.AgentProvider.CODEX)
        return true;
    if (slug === shared_1.AgentProvider.OPENCODE)
        return true;
    if (slug === shared_1.AgentProvider.KIMI)
        return providerBuiltin;
    return false;
}
function runtimeOf(row) {
    if (row.runtime === shared_1.AgentProvider.CODEX)
        return shared_1.AgentProvider.CODEX;
    if (row.runtime === shared_1.AgentProvider.KIMI)
        return shared_1.AgentProvider.KIMI;
    return shared_1.AgentProvider.CLAUDE;
}
/**
 * The built-in runtime that will actually execute a provider identity: a live configured row's
 * borrowed runtime, else the built-in ladder (with the same Claude fallback a
 * deleted/disabled slug dispatches under). This is exactly `resolveProviderExec`'s `provider`,
 * answered without resolving a model or decrypting a key — the question a provider switch asks
 * of both sides before deciding whether the session may move.
 */
function execRuntime(args) {
    if (args.customRow && args.customRow.enabled)
        return runtimeOf(args.customRow);
    if (args.declaredProvider === shared_1.AgentProvider.CODEX)
        return shared_1.AgentProvider.CODEX;
    if (args.declaredProvider === shared_1.AgentProvider.OPENCODE)
        return shared_1.AgentProvider.OPENCODE;
    if (args.declaredProvider === shared_1.AgentProvider.KIMI && args.declaredProviderBuiltin !== false) {
        return shared_1.AgentProvider.KIMI;
    }
    return shared_1.AgentProvider.CLAUDE;
}
/**
 * The built-in runtime a session's turns actually execute on, resolving a configured (BYOK)
 * slug to the runtime it borrows. The ModelProvider lookup happens only for a slug that needs
 * one, so a built-in session costs nothing.
 *
 * Shared rather than re-derived so that everything asking a runtime-shaped question about a
 * session — can it be steered, and may this poller be handed that steer — answers it from the
 * same resolution dispatch itself uses. Two spellings of it would disagree on exactly the
 * sessions that are hardest to notice: the configured ones.
 */
async function sessionExecRuntime(tx, session) {
    const customRow = isBuiltinProvider(session.provider, session.providerBuiltin)
        ? null
        : await tx.modelProvider.findFirst({
            where: { slug: session.provider, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        });
    return execRuntime({
        declaredProvider: session.provider,
        declaredProviderBuiltin: session.providerBuiltin,
        customRow,
    });
}
// Env injected so the borrowed runtime CLI talks to the provider's endpoint. Claude runtime →
// Anthropic-compatible vars (Phase 1); codex runtime → OpenAI-compatible (Phase 2); kimi runtime →
// the Kimi CLI's own KIMI_MODEL_* provider.
function injectedEnv(row, model) {
    const apiKey = (0, provider_crypto_1.decryptSecret)(row.apiKeyEnc);
    if (runtimeOf(row) === shared_1.AgentProvider.CODEX) {
        return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
    }
    if (runtimeOf(row) === shared_1.AgentProvider.KIMI) {
        // Kimi has no base-url/key flags: setting KIMI_MODEL_NAME is what makes the CLI synthesize an
        // in-memory provider from these, and it refuses to start with any of the pair missing. The
        // model travels in the environment rather than through ACP's `model` config option, which
        // would switch the session back to the runner's own Kimi sign-in and ignore this key —
        // hence the runner's kimiUsesEnvModel() check. The type pins the protocol the base URL
        // speaks, so a row pointed at a CN/self-hosted Moonshot endpoint stays consistent.
        return {
            KIMI_MODEL_NAME: model,
            KIMI_MODEL_API_KEY: apiKey,
            KIMI_MODEL_PROVIDER_TYPE: 'kimi',
            KIMI_MODEL_BASE_URL: row.baseUrl,
        };
    }
    return {
        ANTHROPIC_BASE_URL: row.baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        // Claude Code disables claude.ai connectors on its own once an auth token is set — the
        // token above — and then warns on stderr, every start, that unsetting it would bring them
        // back. Unsetting it is exactly what must not happen here (it IS the provider's key), so
        // turn the feature off explicitly: same outcome, no advice that would break the session.
        ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    };
}
/**
 * Resolve how to actually run a (possibly custom) provider at dispatch: the runner-facing
 * built-in runtime, the model to pass, and the process env. For a configured provider
 * the runner never learns its slug — it just receives a Claude/Codex/Kimi job whose env points at
 * the provider's endpoint, so the runner needs no changes. A built-in may also resolve
 * directly to Kimi or OpenCode.
 *
 * `customRow` is null for a built-in provider, or for a slug whose ModelProvider was
 * deleted/disabled (a safe fallback to the claude default rather than a dispatch failure).
 */
function resolveProviderExec(args) {
    const { customRow, sessionModel, workspaceModel, workspaceEnv } = args;
    const legacyInheritance = args.usesRuntimeDefaultModel === false;
    if (customRow && customRow.enabled) {
        const runtime = execRuntime(args);
        const pin = firstNonBlank(sessionModel);
        const retired = retiredPin(customRow, runtime, args, pin);
        // A custom provider's model space is its own; never coerce it through the claude/gpt
        // prefix guard. Workspace.model is only a rolling-deploy bridge for model-less sessions made
        // by old replicas; current clients put their choice directly on Session.model.
        const model = (retired ? undefined : pin) ||
            firstNonBlank(legacyInheritance ? workspaceModel : undefined) ||
            runtimeCatalogDefault(customRow, runtime, args) ||
            (0, preset_overlay_1.presetDefaultModel)(customRow) ||
            shared_1.DEFAULT_MODEL_BY_PROVIDER[runtime];
        return {
            provider: runtime,
            model,
            // Provider env wins over any user-set workspace env (e.g. a hand-typed ANTHROPIC_BASE_URL).
            // The kimi runtime also reads the model from here, so it can only be built once the
            // model above is resolved.
            env: { ...(workspaceEnv ?? {}), ...injectedEnv(customRow, model) },
            ...(retired ? { retiredPin: true } : {}),
        };
    }
    // Built-in (or stale/disabled custom slug → treat as claude). The runtime authenticates itself:
    // each runner carries its own `claude auth login`, and a session that finds it missing surfaces
    // the sign-in card (RunnerSignIn) rather than the control plane holding a credential for it.
    const provider = execRuntime(args);
    const env = workspaceEnv ?? undefined;
    const pin = firstNonBlank(sessionModel);
    const retired = retiredPin(null, provider, args, pin);
    const explicitSessionModel = retired ? undefined : pin;
    // An explicit per-session selection retains the historical safety behavior: a clearly
    // cross-provider id is coerced straight to the static provider default. During a rolling
    // deployment, old replicas can still create a model-less Session that expects Workspace.model;
    // preserve that one-time inheritance ahead of new Runtime defaults. Queue claim snapshots it
    // onto Session.model, and current Workspace create/update paths never write a new pin.
    const legacyWorkspaceModel = legacyInheritance ? firstNonBlank(workspaceModel) : undefined;
    const inheritedModel = legacyInheritance
        ? (0, shared_1.modelForProvider)(provider, legacyWorkspaceModel)
        : firstCompatibleModel(provider, (0, runtime_model_1.savedRuntimeDefaultModel)(args.runtimeDefaultModels, provider), (0, runtime_model_1.firstRuntimeCatalogModel)(args.modelCatalog, provider));
    return {
        provider,
        model: (0, shared_1.modelForProvider)(provider, explicitSessionModel ?? inheritedModel),
        env,
        ...(retired ? { retiredPin: true } : {}),
    };
}
/**
 * The default for a provider whose vendor IS the runtime CLI's own endpoint: what that CLI reports
 * on the assigned runner, so a model-less session runs the newest model it offers the day it ships.
 *
 * The preset's `models`/`defaultModel` are a shipped fallback for those vendors, not a catalogue —
 * without this, dispatch materializes that fallback onto the session and a BYOK Anthropic provider
 * keeps starting on last generation's Opus while every picker already offers the new one. Precedence
 * mirrors the clients exactly (web `defaultModelForProvider`, Swift `effectiveDefaultModel`):
 * runtime-reported default, then the first row of its catalogue.
 *
 * Undefined for everyone else — the runner probes its own CLI, which says nothing about what a
 * third-party vendor (DeepSeek, Moonshot, GLM…) serves.
 */
function runtimeCatalogDefault(row, runtime, args) {
    if (!(0, preset_overlay_1.followsRuntimeCatalog)(row))
        return undefined;
    return firstNonBlank((0, runtime_model_1.savedRuntimeDefaultModel)(args.runtimeDefaultModels, runtime), (0, runtime_model_1.firstRuntimeCatalogModel)(args.modelCatalog, runtime));
}
/**
 * Whether the Runtime has retired the session's own model — if so it is dropped, and the session
 * falls through to the provider's current default exactly as a model-less one would.
 *
 * A pin only survives because the model still exists. When it stops being offered, honouring it
 * keeps the session a generation behind forever, and the pickers (which draw the same catalogue)
 * would have to render a dead id nobody can select back. The claim path re-materializes what
 * dispatch resolved, so the row stops carrying the retired value too.
 *
 * Judged only against a runtime CLI's own catalogue — a built-in runtime, or a vendor whose
 * endpoint IS that CLI's. A configured third-party keeps its pin: its list is a document we mirror
 * (models.dev) or one the user maintains, and neither retires an id reliably enough to overrule a
 * deliberate choice. OpenCode is out too: it owns model selection, and the ids it reports are a
 * slice of a multi-provider space rather than the whole of it.
 */
function retiredPin(row, runtime, args, model) {
    if (!model)
        return false;
    if (runtime === shared_1.AgentProvider.OPENCODE)
        return false;
    if (row && !(0, preset_overlay_1.followsRuntimeCatalog)(row))
        return false;
    return (0, shared_1.isRetiredModel)(model, (0, runtime_model_1.runtimeCatalogModels)(args.modelCatalog, runtime), (0, runtime_model_1.savedRuntimeDefaultModel)(args.runtimeDefaultModels, runtime));
}
function firstNonBlank(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function firstCompatibleModel(provider, ...values) {
    for (const value of values) {
        const model = firstNonBlank(value);
        if (model && (0, shared_1.modelForProvider)(provider, model) === model)
            return model;
    }
    return undefined;
}
//# sourceMappingURL=custom-provider.js.map