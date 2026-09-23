import { AgentProvider } from './enums';
import type { RunnerModelCatalog, RunnerModelInfo } from './dto';

/** The model each provider falls back to when neither the session nor its Runtime supplies one.
 *  Mirrors the clients' defaults (web `lib/agentDefaults` DEFAULT_MODEL_BY_PROVIDER, Swift
 *  `AgentDefaults.defaultModel(for:)`). Kept here so the server has a single source of truth. */
export const DEFAULT_MODEL_BY_PROVIDER: Record<AgentProvider, string> = {
  [AgentProvider.CLAUDE]: 'claude-opus-5',
  [AgentProvider.CODEX]: 'gpt-5.6-sol',
  [AgentProvider.KIMI]: 'kimi-code/kimi-for-coding',
  // OpenCode is a multi-provider runtime. An empty model deliberately omits `--model`,
  // leaving selection to OpenCode (configured/default for a new session, current model
  // for an existing runtime session).
  [AgentProvider.OPENCODE]: '',
};

/**
 * Whether a stored model id has been retired — the provider still runs, but no longer offers this
 * model, so keeping it pinned means a session quietly stays a generation behind forever. A retired
 * id yields to the provider's current default everywhere: the pickers show that default rather than
 * a dead id nobody can act on, and dispatch runs it, so the two can never disagree.
 *
 * `offered` is the same list the picker draws (the runner's live catalogue for a built-in runtime
 * or a vendor on its own endpoint; a configured third-party's own models otherwise) — callers pass
 * the list for the model's own space, never another provider's.
 *
 * Three deliberate escapes, each protecting an id that is legitimately absent from that list:
 *  - a blank model — OpenCode's "you pick" sentinel is a choice, not a stale value;
 *  - an unknown/empty list — a runner that hasn't reported a catalogue yet can't retire anything,
 *    and treating silence as "offers nothing" would wipe every pin the moment one goes offline;
 *  - the Runtime's own reported default — `claude`'s settings.json may name an alias (`opus`,
 *    `opusplan`, `best`) or a gateway id that the quick-pick catalogue never lists. The runtime
 *    vouching for it is exactly what makes it current.
 */
export function isRetiredModel(
  model: string | null | undefined,
  offered: ReadonlyArray<{ value?: unknown }> | null | undefined,
  runtimeDefault?: string | null,
): boolean {
  const id = model?.trim();
  if (!id) return false;
  if (!offered || offered.length === 0) return false;
  if (id === runtimeDefault?.trim()) return false;
  return !offered.some((row) => row && row.value === id);
}

/**
 * The Claude models known to have a fast lane, used ONLY where the assigned runner's catalogue has
 * not answered for that model — a runner too old to report it, or one whose probe failed.
 *
 * It is a fallback and no longer a gate. The runner asks its own CLI (`/fast` is refused out loud
 * on a model without the lane) and reports the answer per model, because this table is exactly the
 * shape that fails silently: it was written when CLI 2.1.260 offered the lane on Opus 5 and Opus
 * 4.8, and when Opus 5.5 shipped, every client withdrew `/fast` from a model that had it — no
 * error, just a capability that quietly stopped existing. A catalogue row therefore always wins,
 * including when it says no; this list can only fill a silence, never contradict an answer.
 */
export const FAST_MODE_CAPABLE_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
]);

/**
 * One model's row in the assigned runner's catalogue for the runtime that will execute it.
 *
 * Shared by the two capability questions that used to be answered from static tables, so both
 * read the same row and cannot disagree about whether the runner has spoken.
 */
export function runnerCatalogRow(
  runtime: string,
  model: string,
  modelCatalog?: RunnerModelCatalog | null,
): RunnerModelInfo | undefined {
  const rows = modelCatalog?.[runtime as AgentProvider];
  if (!Array.isArray(rows)) return undefined;
  return rows.find((row) => row?.value === model);
}

/**
 * The Codex service tier Codex calls "Fast" (`codex debug models` → service_tiers:
 * [{ id: "priority", name: "Fast" }]). The id and not the `fast` alias, because codex silently
 * omits a tier the model's catalogue does not advertise, so the id is the only spelling a session
 * can be checked against. Mirrors runner-go's codexFastServiceTier.
 */
export const CODEX_FAST_SERVICE_TIER = 'priority';

/**
 * Whether fast mode — the runtime's own fast lane: Claude Code's `/fast`, Codex's "Fast" service
 * tier — is something this runtime and model actually have.
 *
 * `runtime` is the built-in runtime that executes the session, not the persisted provider slug —
 * resolve a configured slug to its runtime first, exactly as `autoAvailable` asks. A configured
 * (BYOK) identity is therefore answered like the runtime it borrows, which is right for the common
 * case (a second account with the same vendor) and harmless for the other: both CLIs run without
 * the lane rather than fail when the endpoint cannot give it.
 *
 * - **Claude**: from the assigned runner's catalogue — the model's row says whether the CLI that
 *   will run it has the lane. Only a row that did not answer falls back to the static table above,
 *   so a model the runner reports as fast-less is fast-less even if the table still lists it.
 * - **Codex**: from the same catalogue — the model's row must advertise the priority tier. No row
 *   means no: unlike an effort level, a tier the catalogue does not advertise is not refused by
 *   codex but dropped from the request without a word, so "unknown" must not render a control
 *   whose only possible outcome is being ignored.
 * - Kimi and OpenCode have no fast lane.
 *
 * There is one thing this deliberately does NOT know: whether the account is ALLOWED the lane (an
 * organisation setting, EU data residency). The CLI decides that when it sends the request. A true
 * here means "there is a fast lane for this runtime and model", never "this session will get one".
 */
export function fastModeAvailable(
  runtime: string,
  model: string,
  modelCatalog?: RunnerModelCatalog | null,
): boolean {
  if (runtime === AgentProvider.CLAUDE) {
    const reported = runnerCatalogRow(runtime, model, modelCatalog)?.fastMode;
    return reported ?? FAST_MODE_CAPABLE_CLAUDE_MODELS.has(model);
  }
  if (runtime !== AgentProvider.CODEX) return false;
  const row = runnerCatalogRow(runtime, model, modelCatalog);
  return Array.isArray(row?.serviceTiers) && row.serviceTiers.includes(CODEX_FAST_SERVICE_TIER);
}

/** Resolve the model to run for a provider, guarding against a cross-provider mismatch.
 *
 *  A per-session or Runtime-derived value normally wins, but a model whose id clearly belongs to a
 *  *different* provider is coerced to the provider's default. A `claude-*` id on a Codex session
 *  used to reach the runner verbatim, which then ran `codex -m claude-opus-4-8` — the ChatGPT
 *  backend rejects that with a 400 ("model is not supported when using Codex with a ChatGPT
 *  account"). This is the server-side backstop, so no client version or stale row can produce that
 *  mismatch at dispatch.
 *
 *  Only unambiguous built-in prefixes are policed; unknown/custom ids (e.g. an
 *  `ANTHROPIC_MODEL` endpoint override) pass through untouched. */
export function modelForProvider(provider: AgentProvider, override?: string | null): string {
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider];
  // `||` (not `??`) so a blank override ('' from a degenerate row) also falls back to the default
  // rather than reaching the runner as `-m ''`.
  const model = override || fallback;
  // OpenCode's selector is always `provider/model`. A provider-only API patch from an older
  // client can leave the prior runtime's model on the agent; omit that invalid bare id instead
  // of passing it to the CLI. A namespaced id is opaque here — it may legitimately name any
  // upstream provider (`anthropic/…`, `kimi-code/…`), so the prefix guards below must not
  // police it.
  if (provider === AgentProvider.OPENCODE) return model.includes('/') ? model : fallback;
  const isClaudeModel = model.startsWith('claude-');
  const isCodexModel = model.startsWith('gpt-');
  const isKimiModel = model.startsWith('kimi-') || model.startsWith('kimi-code/');
  if (provider !== AgentProvider.CLAUDE && isClaudeModel) return fallback;
  if (provider !== AgentProvider.CODEX && isCodexModel) return fallback;
  if (provider !== AgentProvider.KIMI && isKimiModel) return fallback;
  return model;
}
