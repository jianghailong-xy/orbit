import {
  AgentProvider,
  PermissionMode,
  ROOT_FALLBACK_PERMISSION_MODE,
  autoAvailable,
  permissionModeAvailableOnRunner,
} from '@orbit/shared';
import type { RunnerModelCatalog } from '@orbit/shared';
import { runtimeCatalogReasoningLevels } from './runtime-model';

// Closed CLI enums. An account default last picked in an OpenCode session (whose variants are
// model-defined and open-ended) must degrade to runtime Default rather than make these fail.
// Claude's `ultra` is Claude Code's ultracode (xhigh plus standing workflow orchestration); the
// runner spells it the way the CLI does.
const CLAUDE_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
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
export function normalizeRuntimeProvider(
  value?: string | null,
  providerBuiltin = true,
): AgentProvider {
  if (value === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (value === AgentProvider.OPENCODE) return AgentProvider.OPENCODE;
  if (value === AgentProvider.KIMI && providerBuiltin) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
}

/** Runtimes that learn their durable conversation id only after process initialization. */
export function initializesRuntimeDynamically(provider?: string | null): boolean {
  return (
    provider === AgentProvider.CODEX ||
    provider === AgentProvider.KIMI ||
    provider === AgentProvider.OPENCODE
  );
}

/** Prevent a runner from receiving a model/permission combination its built-in CLI rejects.
 *
 * This is the ONE place the constraint is enforced. The pickers only describe it (via
 * derivePermissionSemantics, off the same table), because a client-side gate is not a boundary:
 * an account default, an MCP-created session and an older client all reach dispatch without
 * passing through one. Same division as modelForProvider.
 *
 * `customProvider` is true when the model came from an enabled configured ModelProvider row; its
 * model space is vendor-defined, so neither the assigned runner's Claude catalogue nor the static
 * fallback list can police it and the CLI decides for itself (it accepts Auto for any model it
 * doesn't recognize as unsupported).
 *
 * `runsAsRoot` is the assigned runner's report about itself. It gates Bypass, which Claude Code
 * refuses under root by exiting during startup — so unlike the Auto case this is not a mode that
 * merely goes unenforced, it is a session that never runs at all. Substituting here rather than
 * rejecting is what keeps an *account-level* Bypass default from failing every session on a root
 * runner; a caller that named Bypass explicitly is told instead (assertPermissionModeRunnable).
 *
 * `modelCatalog` is that same runner's, and is what decides Auto: its row for this model lists the
 * modes the CLI installed there accepts. Pass it wherever the assigned runner is known — without
 * it this falls back to a list in the repo, which is how Auto came to be withheld from a model
 * whose CLI would have honored it. */
export function normalizeBuiltinPermissionMode(
  provider: AgentProvider,
  model: string,
  permissionMode: PermissionMode,
  customProvider = false,
  runsAsRoot?: boolean | null,
  modelCatalog?: unknown,
): PermissionMode {
  if (!permissionModeAvailableOnRunner(permissionMode, runsAsRoot)) {
    return ROOT_FALLBACK_PERMISSION_MODE;
  }
  if (permissionMode !== PermissionMode.AUTO) return permissionMode;
  return autoAvailable(provider, model, customProvider, modelCatalog as RunnerModelCatalog | null)
    ? permissionMode
    : PermissionMode.DEFAULT;
}

/**
 * Keep persisted effort values valid when a session changes runtime or is resumed from an older
 * client. Kimi's vocabulary tops out at `max` and has no `minimal`/`medium`. Which levels a Codex
 * or Kimi model actually accepts is per-model (K2.7 Coding accepts none at all), so this maps the
 * vocabulary and `normalizeEffortForRuntimeModel` applies the model's own list. OpenCode variants are
 * model/provider-defined and stay open-ended, so only the closed CLI enums are clamped.
 */
export function normalizeEffortForProvider(
  provider: AgentProvider,
  effort?: string | null,
): string | undefined {
  if (effort == null) return undefined;
  if (provider === AgentProvider.OPENCODE) return effort;
  if (provider === AgentProvider.KIMI) {
    if (effort === 'minimal') return 'low';
    if (effort === 'medium') return 'high';
    if (effort === 'xhigh') return 'max';
    return effort;
  }
  if (provider === AgentProvider.CODEX) {
    return CODEX_EFFORTS.has(effort) ? effort : '';
  }
  return CLAUDE_EFFORTS.has(effort) ? effort : '';
}

/** Runtimes whose reasoning levels are per-model, so only the assigned runner's catalog can say
 *  whether one is valid. OpenCode's variants are model/provider-defined; Kimi's are declared by
 *  each model's `supportEfforts` and rejected with invalid_params when they are not. */
const MODEL_DEFINED_EFFORT_RUNTIMES: AgentProvider[] = [
  AgentProvider.CODEX,
  AgentProvider.OPENCODE,
  AgentProvider.KIMI,
];

/** Claude Code's effort levels, lowest first: the scale a declared list is read against, and the
 *  only names a configured model may declare (ProvidersService). */
export const CLAUDE_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * An effort moved onto the levels a configured model declares it accepts (declaredReasoningLevels in
 * providers/custom-provider.ts).
 *
 * Always a level, never "the default": the default is Claude Code's own pick — `high` for a model it
 * does not recognise — made without reading any declaration, so a model whose list leaves `high` out
 * would be sent it anyway. No effort is therefore read as the `high` the CLI would have sent, and a
 * level the model lacks moves to the nearest one it has; of two equally near, the higher, so a session
 * is not handed less reasoning than it asked for while more is on offer at the same distance. `ultra`
 * is Claude Code's ultracode, which runs at xhigh: it stays itself where xhigh is accepted and moves as
 * xhigh would where it is not. An empty list is a model that takes no effort, and yields none — the CLI
 * is told to send none at all (injectedEnv).
 */
export function effortWithinDeclaredLevels(effort: string | undefined, levels: string[]): string {
  const accepted = CLAUDE_EFFORT_ORDER.filter((level) => levels.includes(level));
  if (accepted.length === 0) return '';
  const asked = !effort ? 'high' : effort === 'ultra' ? 'xhigh' : effort;
  if (accepted.includes(asked)) return effort === 'ultra' ? effort : asked;
  const rank = CLAUDE_EFFORT_ORDER.indexOf(asked);
  const distance = (level: string) => Math.abs(CLAUDE_EFFORT_ORDER.indexOf(level) - rank);
  // `accepted` runs lowest first, so `<=` leaves the higher of two equally near levels standing.
  return accepted.reduce((nearest, level) => (distance(level) <= distance(nearest) ? level : nearest));
}

/**
 * The dispatch-time variant check, applied once the assigned runner's model catalog is known.
 *
 * These runtimes' levels are model-defined, so `normalizeEffortForProvider` alone cannot police
 * them: an account-level default picked in a Claude session (`max`) would otherwise reach OpenCode
 * as `--variant=max` and fail the turn, or reach Kimi's K2.7 Coding, which declares no levels at
 * all. Mirrors the web picker's rule — an exact catalog row is authoritative even when it lists no
 * variants, while a model the runner-wide catalog does not report may be project-scoped (or come
 * from a runner too old to probe its CLI) and keeps its value.
 *
 * `declaredLevels` is what a configured provider's row says its model accepts (resolveProviderExec's
 * `reasoningLevels`). No runner catalogue describes such a model, so when the row speaks it is the
 * whole answer (effortWithinDeclaredLevels).
 */
export function normalizeEffortForRuntimeModel(
  provider: AgentProvider,
  effort: string | null | undefined,
  model: string,
  modelCatalog: unknown,
  declaredLevels?: string[],
): string | undefined {
  const normalized = normalizeEffortForProvider(provider, effort);
  if (declaredLevels) return effortWithinDeclaredLevels(normalized, declaredLevels);
  if (!MODEL_DEFINED_EFFORT_RUNTIMES.includes(provider) || !normalized) return normalized;
  const levels = runtimeCatalogReasoningLevels(modelCatalog, provider, model);
  if (levels === undefined) return normalized;
  return levels.includes(normalized) ? normalized : '';
}
