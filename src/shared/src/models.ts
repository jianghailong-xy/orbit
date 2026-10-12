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
  // Empty omits `--model`, and agy runs its own default (Gemini 3.1 Pro at Low on 1.2.15). Its
  // models ship with the CLI and come and go with its releases (`agy models`), so naming one here
  // could only ever go stale; the runner's catalogue supplies the concrete ids.
  [AgentProvider.ANTIGRAVITY]: '',
  // ACP supplies opaque model tokens via configOptions. No static model or window fallback:
  // a blank selection leaves the Harness's current/default choice intact (P0 contract §4).
  [AgentProvider.DSH]: '',
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
 * - Kimi, OpenCode and Antigravity have no fast lane.
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

/** agy's thinking levels, the suffixes its `agy models` slugs carry (`claude-opus-5-5-medium`). */
const ANTIGRAVITY_MODEL_LEVELS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** The catalogue row an agy model id belongs to: `claude-opus-5-5-medium` -> `claude-opus-5-5`.
 *
 *  The runner folds each `agy models` slug into one row per BASE model, reporting the levels as
 *  `reasoningLevels` (dto.ts, contract §9.1), while agy itself also accepts the full slug a
 *  session may carry — the runner splits it back apart before `--model`/`--effort`
 *  (runner-go antigravityModelArgs). A model and its base name are therefore the same offered
 *  model. */
export function antigravityBaseModel(model: string): string {
  const i = model.lastIndexOf('-');
  if (i <= 0) return model;
  const suffix = model.slice(i + 1).toLowerCase();
  return ANTIGRAVITY_MODEL_LEVELS.has(suffix) ? model.slice(0, i) : model;
}

/** Whether the assigned runner's `agy models` catalogue offers this model.
 *
 *  The catalogue is agy's own answer about what `--model` accepts, and it is the whole space: the
 *  API-key list, plus — for a runner with a Google sign-in — the Claude Opus/Sonnet 5.5 and
 *  GPT-OSS rows that sign-in adds (contract §16.7). `claude-…`/`gpt-oss-…` ids are therefore
 *  agy's too, which no prefix rule could have known; only the runner can say.
 *
 *  Silence is not a no. A runner that has not reported a catalogue (or reported none for
 *  Antigravity) cannot be asked, so the historical `gemini-…` prefix rule stands in — the space
 *  every catalogue has always contained. A catalogue that HAS spoken is authoritative in both
 *  directions: an id it does not list is one agy refuses to start on. */
function antigravityOffers(
  model: string,
  offered: ReadonlyArray<{ value?: unknown }> | null | undefined,
): boolean {
  if (!offered || offered.length === 0) return model.startsWith('gemini-');
  const base = antigravityBaseModel(model);
  return offered.some((row) => row && (row.value === model || row.value === base));
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
 *  `ANTHROPIC_MODEL` endpoint override) pass through untouched.
 *
 *  `offered` is the assigned runner's live catalogue for this provider's own model space, where
 *  one applies: Antigravity's is the only space a prefix cannot describe (antigravityOffers). */
export function modelForProvider(
  provider: AgentProvider,
  override?: string | null,
  offered?: ReadonlyArray<{ value?: unknown }> | null,
): string {
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider];
  // `||` (not `??`) so a blank override ('' from a degenerate row) also falls back to the default
  // rather than reaching the runner as `-m ''`.
  const model = override || fallback;
  // Harness configOptions values are opaque tokens, not ids that can be rebuilt or validated
  // using another runtime's prefixes. Admission checks them against that runtime's live list.
  if (provider === AgentProvider.DSH) return model;
  // OpenCode's selector is always `provider/model`. A provider-only API patch from an older
  // client can leave the prior runtime's model on the agent; omit that invalid bare id instead
  // of passing it to the CLI. A namespaced id is opaque here — it may legitimately name any
  // upstream provider (`anthropic/…`, `kimi-code/…`), so the prefix guards below must not
  // police it.
  if (provider === AgentProvider.OPENCODE) return model.includes('/') ? model : fallback;
  // agy refuses to start on a `--model` it does not list, so what is dropped here is what would
  // have failed the turn. What it lists is the runner's own catalogue, never a prefix: a Google
  // sign-in's rows are `claude-opus-5-5`, `gpt-oss-120b` and friends, which a `gemini-…`-only
  // rule discarded — the session then silently ran Gemini instead of the model that was picked.
  if (provider === AgentProvider.ANTIGRAVITY) {
    return antigravityOffers(model, offered) ? model : fallback;
  }
  // `gemini-…` stays the one unambiguous agy prefix, but solely as an OTHER-provider guard: the
  // account catalogue's `claude-…`/`gpt-oss-…` ids belong to the runtimes that own those prefixes
  // too, so they cannot be policed for them by prefix — and each of those providers' own rules
  // already polices them.
  const isAntigravityModel = model.startsWith('gemini-');
  const isClaudeModel = model.startsWith('claude-');
  const isCodexModel = model.startsWith('gpt-');
  const isKimiModel = model.startsWith('kimi-') || model.startsWith('kimi-code/');
  if (provider !== AgentProvider.CLAUDE && isClaudeModel) return fallback;
  if (provider !== AgentProvider.CODEX && isCodexModel) return fallback;
  if (provider !== AgentProvider.KIMI && isKimiModel) return fallback;
  if (isAntigravityModel) return fallback;
  return model;
}
