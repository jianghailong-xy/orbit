import {
  AgentProvider,
  DEFAULT_MODEL_BY_PROVIDER,
  isRetiredModel,
  modelForProvider,
} from '@orbit/shared';
import { decryptSecret } from './provider-crypto';
import { followsRuntimeCatalog, presetDefaultModel } from './preset-overlay';
import {
  firstRuntimeCatalogModel,
  runtimeCatalogModels,
  savedRuntimeDefaultModel,
} from '../common/runtime-model';

// Built-in, first-class providers ship their own runtime CLI. Any other `provider` value is
// a control-plane-configured ModelProvider that borrows one of these runtimes.
/** True for a built-in provider (or an unset one) — i.e. NOT a configured ModelProvider slug.
 * `providerBuiltin` is persisted only to fence the former custom `kimi` slug during rolling
 * deployment; Claude/Codex predate the discriminator, and migration 0080 moves any pre-existing
 * custom `opencode` row aside, so both remain unambiguous. */
export function isBuiltinProvider(slug?: string | null, providerBuiltin = true): boolean {
  if (!slug || slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX) return true;
  if (slug === AgentProvider.OPENCODE) return true;
  if (slug === AgentProvider.KIMI) return providerBuiltin;
  return false;
}

/** The minimal ModelProvider row shape the exec resolver needs (a subset of the Prisma row). */
export interface ModelProviderRow {
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  defaultModel: string | null;
  /** The vendor preset this row came from, and whether it still owns the model list — when it
   *  does, the default model resolves from the catalogue rather than from the row. */
  presetSlug?: string | null;
  followsPreset?: boolean;
  enabled: boolean;
}

function runtimeOf(row: ModelProviderRow): AgentProvider {
  if (row.runtime === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (row.runtime === AgentProvider.KIMI) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
}

/**
 * The built-in runtime that will actually execute a provider identity: a live configured row's
 * borrowed runtime, else the built-in ladder (with the same Claude fallback a
 * deleted/disabled slug dispatches under). This is exactly `resolveProviderExec`'s `provider`,
 * answered without resolving a model or decrypting a key — the question a provider switch asks
 * of both sides before deciding whether the session may move.
 */
export function execRuntime(args: {
  declaredProvider?: string | null;
  declaredProviderBuiltin?: boolean;
  customRow: ModelProviderRow | null;
}): AgentProvider {
  if (args.customRow && args.customRow.enabled) return runtimeOf(args.customRow);
  if (args.declaredProvider === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (args.declaredProvider === AgentProvider.OPENCODE) return AgentProvider.OPENCODE;
  if (args.declaredProvider === AgentProvider.KIMI && args.declaredProviderBuiltin !== false) {
    return AgentProvider.KIMI;
  }
  return AgentProvider.CLAUDE;
}

// Env injected so the borrowed runtime CLI talks to the provider's endpoint. Claude runtime →
// Anthropic-compatible vars (Phase 1); codex runtime → OpenAI-compatible (Phase 2); kimi runtime →
// the Kimi CLI's own KIMI_MODEL_* provider.
function injectedEnv(row: ModelProviderRow, model: string): Record<string, string> {
  const apiKey = decryptSecret(row.apiKeyEnc);
  if (runtimeOf(row) === AgentProvider.CODEX) {
    return { OPENAI_BASE_URL: row.baseUrl, OPENAI_API_KEY: apiKey };
  }
  if (runtimeOf(row) === AgentProvider.KIMI) {
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
export function resolveProviderExec(args: {
  declaredProvider?: string | null;
  /** False only for a stale/pre-0077 custom-provider identity that happens to say `kimi`. */
  declaredProviderBuiltin?: boolean;
  customRow: ModelProviderRow | null;
  sessionModel?: string | null;
  /** True for Sessions created under Runtime-default semantics. False marks a model-less row
   * written by an old API replica during the 0079 rolling deployment. Defaults to true for
   * non-persisted/direct callers. */
  usesRuntimeDefaultModel?: boolean;
  /** Effective default reported by built-in runtimes on the assigned runner. A custom provider's
   * ModelProvider row remains authoritative — except for a vendor that IS the runtime CLI's own
   * endpoint, whose model space this describes (see runtimeCatalogDefault). */
  runtimeDefaultModels?: unknown;
  /**
   * Legacy per-Workspace pin. New clients never write this field, but a model-less Session created
   * or claimed by an old API replica must keep the pre-0079 model through a rolling deployment.
   * The claim path immediately snapshots this fallback onto Session.model.
   */
  workspaceModel?: string | null;
  /** Runtime-reported catalog on the assigned runner; its first model is the final dynamic
   * fallback before the shared static default. Ignored for configured providers, except those on
   * the runtime CLI's own endpoint (see runtimeCatalogDefault). */
  modelCatalog?: unknown;
  workspaceEnv?: Record<string, string> | null;
}): {
  provider: AgentProvider;
  model: string;
  env?: Record<string, string>;
  /** The session's own model was dropped because the Runtime no longer offers it. The claim path
   *  re-materializes on this, so the row stops naming a model the session isn't running. */
  retiredPin?: boolean;
} {
  const { customRow, sessionModel, workspaceModel, workspaceEnv } = args;
  const legacyInheritance = args.usesRuntimeDefaultModel === false;
  if (customRow && customRow.enabled) {
    const runtime = execRuntime(args);
    const pin = firstNonBlank(sessionModel);
    const retired = retiredPin(customRow, runtime, args, pin);
    // A custom provider's model space is its own; never coerce it through the claude/gpt
    // prefix guard. Workspace.model is only a rolling-deploy bridge for model-less sessions made
    // by old replicas; current clients put their choice directly on Session.model.
    const model =
      (retired ? undefined : pin) ||
      firstNonBlank(legacyInheritance ? workspaceModel : undefined) ||
      runtimeCatalogDefault(customRow, runtime, args) ||
      presetDefaultModel(customRow) ||
      DEFAULT_MODEL_BY_PROVIDER[runtime];
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
    ? modelForProvider(provider, legacyWorkspaceModel)
    : firstCompatibleModel(
        provider,
        savedRuntimeDefaultModel(args.runtimeDefaultModels, provider),
        firstRuntimeCatalogModel(args.modelCatalog, provider),
      );
  return {
    provider,
    model: modelForProvider(provider, explicitSessionModel ?? inheritedModel),
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
function runtimeCatalogDefault(
  row: ModelProviderRow,
  runtime: AgentProvider,
  args: { runtimeDefaultModels?: unknown; modelCatalog?: unknown },
): string | undefined {
  if (!followsRuntimeCatalog(row)) return undefined;
  return firstNonBlank(
    savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime),
    firstRuntimeCatalogModel(args.modelCatalog, runtime),
  );
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
function retiredPin(
  row: ModelProviderRow | null,
  runtime: AgentProvider,
  args: { runtimeDefaultModels?: unknown; modelCatalog?: unknown },
  model: string | undefined,
): boolean {
  if (!model) return false;
  if (runtime === AgentProvider.OPENCODE) return false;
  if (row && !followsRuntimeCatalog(row)) return false;
  return isRetiredModel(
    model,
    runtimeCatalogModels(args.modelCatalog, runtime),
    savedRuntimeDefaultModel(args.runtimeDefaultModels, runtime),
  );
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstCompatibleModel(
  provider: AgentProvider,
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const model = firstNonBlank(value);
    if (model && modelForProvider(provider, model) === model) return model;
  }
  return undefined;
}
