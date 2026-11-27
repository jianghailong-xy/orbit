import {
  AgentProvider,
  ENGINE_CLI_NAMES,
  PermissionMode,
  autoAvailable,
  credentialIsAnthropicBound,
  runnerCatalogRow,
  settingLink,
  type AnthropicBoundCredential,
  type PlanUsage,
  type RunnerModelCatalog,
  type RunnerModelInfo,
  type RuntimeDefaultModels,
} from '@orbit/shared';

/** Version 3: account health removes, ranks and holds (docs/routing-account-health-design.md §7). Version 4: a pin
 *  on an account health set aside holds with the pin named, or is relaxed when the owner allows it (§7.5). */
export const MODEL_ROUTING_POLICY_VERSION = 4;
export const MODEL_ROUTING_LEVELS = ['S', 'M', 'L', 'XL'] as const;
export type ModelRoutingLevel = (typeof MODEL_ROUTING_LEVELS)[number];

export const DEFAULT_MODEL_TIER_TABLE = {
  claude: {
    S: { prefix: 'claude-sonnet-', effort: 'low' },
    M: { prefix: 'claude-sonnet-', effort: 'medium' },
    L: { prefix: 'claude-opus-', effort: 'high' },
    XL: { prefix: 'claude-opus-', effort: 'max' },
  },
  codex: {
    S: { effort: 'low' },
    M: { effort: 'medium' },
    L: { effort: 'high' },
    XL: { effort: 'xhigh' },
  },
  // SubAgent routing only (MODEL_ROUTING_ENGINES does not list it). Each tier takes the first of its models
  // the runner reports: catalogues differ by account and site, and K3 is on every one reported so far.
  // Efforts are Kimi's own thinking levels (low, high, max).
  kimi: {
    S: { models: ['kimi-code/k3'], effort: 'low' },
    M: { models: ['kimi-code/k3'], effort: 'high' },
    L: { models: ['kimi-code/k3.1-pro', 'kimi-code/k3'], effort: 'high' },
    XL: { models: ['kimi-code/k3.1-pro', 'kimi-code/k3'], effort: 'max' },
  },
} as const;

/**
 * Tiers by model family, for every catalogue the table above does not describe (Cursor, Antigravity, and any
 * engine after them) and for a key's model that neither its preset nor the owner tiers. A family, not a model
 * list, so a release the catalogue adds later (`claude-opus-5-6`, `gemini-4-xenon`) is tiered with no edit
 * here: each tier takes the family's newest model the catalogue reports (familyNewest). In order of preference
 * within a tier. The efforts are what each tier asks for; a model runs at the highest of its own reported levels
 * at or below it (clampEffort), at its own default when it reports none.
 */
export const MODEL_FAMILY_TIERS: ReadonlyArray<{
  family: string;
  match: RegExp;
  tiers: Partial<Record<ModelRoutingLevel, string>>;
  /** The rule stands in only while the catalogue lists no model matching this. */
  unless?: RegExp;
}> = [
  { family: 'Claude Sonnet', match: /^claude-sonnet-\d/, tiers: { S: 'low', M: 'medium' } },
  { family: 'Claude Opus', match: /^claude-opus-\d/, tiers: { L: 'high', XL: 'max' } },
  { family: 'Gemini Flash', match: /^gemini-\d[\d.]*-flash$/, tiers: { S: 'low', M: 'medium' } },
  { family: 'Gemini', match: /^gemini-\d[\d.]*-(?!flash$)[a-z]+$/, tiers: { L: 'high', XL: 'max' } },
  { family: 'Composer', match: /^composer-\d/, tiers: { S: 'low' } },
  // Claude Haiku and Kimi go last so they never displace a Claude or Gemini pick in the same tier.
  { family: 'Claude Haiku', match: /^claude-haiku-\d/, tiers: { S: 'low' } },
  // Kimi as Cursor lists it, mirroring the Kimi Code table: K3 at S/M, K3.1 Pro at L/XL, K3 standing in for it.
  { family: 'Kimi K3', match: /^kimi-k3(?!\.)/, tiers: { S: 'low', M: 'high' } },
  { family: 'Kimi K3.1 Pro', match: /^kimi-k3\.\d+-pro/, tiers: { L: 'high', XL: 'max' } },
  { family: 'Kimi K3 (no Pro listed)', match: /^kimi-k3(?!\.)/, tiers: { L: 'high', XL: 'max' }, unless: /^kimi-k3\.\d+-pro/ },
  // Measured 2026-11-21 against the tier anchors (task 351AxJztYRw7WA2Ik86DK, owner-approved). Pinned to the
  // measured ids where a wider pattern would let the newest-member rule pick an unmeasured model.
  // Fable passed everything, at ~1.8x Opus's cost: L/XL, after Opus.
  { family: 'Claude Fable', match: /^claude-fable-\d/, tiers: { L: 'high', XL: 'max' } },
  // Passed everything on Antigravity, slower than Neon and one run stalled: L/XL, after Gemini.
  { family: 'Gemini Pro Orchestrator', match: /^gemini-pro-orchestrator-neon$/, tiers: { L: 'high', XL: 'max' } },
  { family: 'DeepSeek Flash', match: /^deepseek-flash$/, tiers: { S: 'low', M: 'medium' } },
  // S and M only measured: its L/XL runs died on Cursor transport errors.
  { family: 'Grok', match: /^grok-\d[\d.]*$/, tiers: { S: 'low', M: 'medium' } },
  // Pass S/M/L, miss the XL task (Sol 1/2, Terra 0/2, Luna 0/2); in that order of preference.
  { family: 'GPT Sol', match: /^gpt-5\.6-sol$/, tiers: { S: 'low', M: 'medium' } },
  { family: 'GPT Terra', match: /^gpt-5\.6-terra$/, tiers: { S: 'low', M: 'medium' } },
  { family: 'GPT Luna', match: /^gpt-5\.6-luna$/, tiers: { S: 'low', M: 'medium' } },
  // gpt-oss-120b failed every S task: no entry, so it stays untiered.
];

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The version numbers in a model id, for ordering a family newest first: `claude-opus-5-5` is [5, 5]. */
function versionOf(model: string): number[] {
  return (model.match(/\d+/g) ?? []).map(Number);
}

function newerFirst(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? 1 : -1;
    if (x[i] !== y[i]) return y[i] - x[i];
  }
  return 0;
}

/** The highest of a model's own levels at or below `wanted`, else its lowest; null when it reports none. */
function clampEffort(wanted: string, levels: readonly string[] | undefined): string | null {
  if (!levels?.length) return null;
  const rank = (level: string) => EFFORT_ORDER.indexOf(level.toLowerCase());
  const ranked = levels.filter((level) => rank(level) >= 0).sort((a, b) => rank(a) - rank(b));
  if (ranked.length === 0) return null;
  return [...ranked].reverse().find((level) => rank(level) <= rank(wanted)) ?? ranked[0];
}

/** A catalogue's tier rows by family: each family's newest model at each of its tiers, then every other model
 *  untiered (reachable by name). Ties in version go by catalogue order. */
function familyTierRows(catalog: readonly RunnerModelInfo[]): SubagentModelRow[] {
  const rows: SubagentModelRow[] = [];
  const tiered = new Set<string>();
  for (const level of MODEL_ROUTING_LEVELS) {
    for (const { match, tiers, unless } of MODEL_FAMILY_TIERS) {
      const wanted = tiers[level];
      if (!wanted) continue;
      if (unless && catalog.some((row) => unless.test(row.value))) continue;
      const newest = catalog.filter((row) => match.test(row.value)).sort((a, b) => newerFirst(a.value, b.value))[0];
      if (!newest) continue;
      rows.push({ model: newest.value, effort: clampEffort(wanted, newest.reasoningLevels), level });
      tiered.add(newest.value);
    }
  }
  return [...rows, ...catalog.filter((row) => !tiered.has(row.value)).map((row) => ({ model: row.value, effort: null, level: null }))];
}

/** The newest model of `model`'s family in a catalogue (the one familyTierRows tiers), or null for a model of no
 *  family. It is `model` itself when nothing newer is reported. */
export function familyNewest(model: string, catalog: readonly RunnerModelInfo[]): string | null {
  const rule = MODEL_FAMILY_TIERS.find(({ match }) => match.test(model));
  if (!rule) return null;
  const newest = catalog.filter((row) => rule.match.test(row.value)).sort((a, b) => newerFirst(a.value, b.value))[0];
  return newest?.value ?? null;
}

/** The effort each tier asks of a model the owner tiers: clamped to the model's own levels (clampEffort). */
const OWNER_TIER_EFFORT: Record<ModelRoutingLevel, string> = { S: 'low', M: 'medium', L: 'high', XL: 'max' };

/** The owner's tiers for the models of a built-in engine's catalogue, engine → model → tier
 *  (`UserPreferences.builtinModelTiers`, docs/subagent-design.md §7). */
export type BuiltinModelTiers = Readonly<Record<string, Readonly<Record<string, ModelRoutingLevel>>>>;

/** An engine's catalogue rows with the owner's tiers applied: each model the owner tiers leaves the built-in
 *  table's and its family's rows and takes one row at the owner's tier, the tier's effort clamped to its levels.
 *  A tier for a model the catalogue does not report adds nothing. Untiered rows stay last. */
function withOwnerTiers(
  rows: SubagentModelRow[],
  catalog: readonly RunnerModelInfo[],
  owned: Readonly<Record<string, ModelRoutingLevel>> | undefined,
): SubagentModelRow[] {
  const set = owned ? catalog.filter((row) => owned[row.value]) : [];
  if (set.length === 0) return rows;
  const names = new Set(set.map((row) => row.value));
  const kept = rows.filter((row) => !names.has(row.model));
  const own = set.map((row) => ({
    model: row.value, effort: clampEffort(OWNER_TIER_EFFORT[owned![row.value]], row.reasoningLevels), level: owned![row.value],
  }));
  return [...kept.filter((row) => row.level), ...own, ...kept.filter((row) => !row.level)];
}

/** The lowest tier a model's family takes, for a key's model with one tier and no effort; null for no family. */
export function familyTier(model: string): ModelRoutingLevel | null {
  const rule = MODEL_FAMILY_TIERS.find(({ match }) => match.test(model));
  return rule ? MODEL_ROUTING_LEVELS.find((level) => rule.tiers[level]) ?? null : null;
}

/** The built-in engines with a tier table: the only ones a run can be routed onto from another (§4.3, §6). */
export const MODEL_ROUTING_ENGINES: readonly string[] = [AgentProvider.CLAUDE, AgentProvider.CODEX];

/** At or above this share of a window used, an engine is not picked for a fresh run (§6). */
export const ENGINE_QUOTA_LIMIT = 90;

/** What account health says of an account at the moment of the route (docs/routing-account-health-design.md §7.1). */
export type RoutingHealthState = 'blocked' | 'suspect' | 'cooldown' | 'trial-due' | 'trial-running';

/** One live account-health entry, as routing input carries it: at most one for the whole account, one per model. */
export interface RoutingHealthEntry {
  state: RoutingHealthState;
  /** Null: the whole account. Otherwise the one model the entry is about. */
  model: string | null;
  /** The RunFailureKind that set it, or UNCLASSIFIED_ADMISSION for the breaker. */
  kind: string;
  /** The provider's own words. */
  said?: string;
  /** When the streak began, and when the account last refused a run (ms). */
  since: number;
  last: number;
  /** When it ends (ms): a block's or cool-down's end, a suspect period's, or a trial claim's. */
  until: number;
  trips: number;
  /** The health subject (account-health.ts subjectKey): what a dispatch claims the account's due trial by. */
  subject: string;
}

/** The states that take an account, or one model on it, out of the pool (§7.1); suspect and trial-due do not. */
const HEALTH_REMOVES: ReadonlySet<RoutingHealthState> = new Set(['blocked', 'cooldown', 'trial-running']);

/** The engine as the provider's words are attributed to it: its product name. */
const productOf = (engine: string): string => ENGINE_CLI_NAMES[engine as AgentProvider] ?? engine;

/** The Why line of an account or model health removes (§7.1): what the provider said, since when, and its end. */
export function healthLine(entry: RoutingHealthEntry, engine: string): string {
  const since = minuteOf(entry.since);
  const until = minuteOf(entry.until);
  if (entry.state === 'trial-running') return 'The account is being tried now by another run';
  const quoted = entry.said ? ` "${entry.said}"` : '';
  if (entry.model) {
    if (entry.kind === 'CAPACITY') {
      return `${entry.model} was at capacity on this account at ${minuteOf(entry.last)}; used again from ${until}`;
    }
    return `${entry.model} is not available on this account${entry.said ? `: "${entry.said}"` : ''} (tried again at ${until})`;
  }
  switch (entry.kind) {
    case 'ACCOUNT_ACTION_REQUIRED':
      return `The account needs your action${entry.said ? `: ${productOf(engine)} said${quoted}` : ''} (since ${since}; tried again at ${until})`;
    case 'CREDENTIAL_REFUSED':
      return `The provider refused the account's credential (since ${since}; tried again at ${until})`;
    case 'ACCESS_DENIED':
      return `The provider does not allow this account to run${entry.said ? `:${quoted}` : ''} (since ${since}; tried again at ${until})`;
    case 'USAGE_LIMIT':
      return `The account hit its usage limit; used again from ${until}`;
    case 'CAPACITY':
      return `The account was at capacity at ${minuteOf(entry.last)}; used again from ${until}`;
    default:
      return `The account failed to start ${Math.max(entry.trips, 1) + 1} runs in a row at no cost; tried again at ${until}`;
  }
}

/** The account-level entry that removes an account, if one does. */
function accountRemoval(health: readonly RoutingHealthEntry[] | undefined): RoutingHealthEntry | null {
  return health?.find((entry) => entry.model === null && HEALTH_REMOVES.has(entry.state)) ?? null;
}

/** The model-level entries that remove one model each, by model. */
function modelRemovals(health: readonly RoutingHealthEntry[] | undefined): Map<string, RoutingHealthEntry> {
  return new Map((health ?? [])
    .filter((entry) => entry.model !== null && HEALTH_REMOVES.has(entry.state))
    .map((entry) => [entry.model!, entry]));
}

/** What an account's health leaves of it in the pool: ranked last while suspect, and the trial it is due. */
function healthStanding(health: readonly RoutingHealthEntry[] | undefined): {
  suspect: boolean; trial: RoutingHealthEntry | null; modelHealth: Map<string, RoutingHealthEntry>;
} {
  const account = health?.find((entry) => entry.model === null);
  return {
    suspect: account?.state === 'suspect',
    trial: account?.state === 'trial-due' ? account : null,
    modelHealth: modelRemovals(health),
  };
}

/** What the target runner says of one engine, for the account a run there would use (§6). */
export interface ModelRoutingEngineState {
  signedOut?: boolean;
  /** Claude's own sign-in on a runner whose Claude connection to Anthropic is in a region Anthropic does not offer
   *  Claude in (docs/claude-region-check-contract.md §12): ruled out as a signed-out engine is. */
  regionBlocked?: boolean;
  /** The fullest of that account's windows that cap the whole engine, not one model family. */
  quota?: { utilization: number; window: string } | null;
  /** That account is paused on the runner. */
  paused?: boolean;
  /** No quota reading for that account: `quota` null then says nothing about its headroom. Only the SubAgent
   *  router reads it (routeSubagent ranks such an account after those whose headroom is known). */
  quotaUnread?: boolean;
  /** When what that account has left goes to waste (quotaExpiresAt, ms); null when no reset is known. And whether a
   *  window is nearly spent (quotaNearLimit). Only the SubAgent router reads them: soonest expiry first. */
  expiresAt?: number | null;
  /** How long the window whose reset expiresAt is lasts, in minutes; null when no window says. A weekly or monthly
   *  quota about to reset is one about to go to waste (SUBAGENT_WASTE_WINDOW_MS); a 5-hour one always resets soon. */
  expiryWindowMins?: number | null;
  nearLimit?: boolean;
  /** That account's Opus weekly window, in percent; null when none is live. At ENGINE_QUOTA_LIMIT Opus is not routed onto. */
  opusUtilization?: number | null;
  /** What account health says of that account (docs/routing-account-health-design.md §7.1); absent: healthy. */
  health?: readonly RoutingHealthEntry[];
}

export interface ModelRoutingSelection {
  /** The credential the run spends (docs/provider-engine-contract.md §4.4): the baseline's own, or —
   *  on an engine the baseline credential cannot run — that engine's own sign-in, named by the engine. */
  provider: string;
  model: string | null;
  effort: string | null;
}

export type ModelRoutingOutcome =
  'FAILED' | 'ACCEPTANCE_FAILED' | 'VERIFICATION_FAILED' | 'SENT_BACK' | 'OK';

/**
 * Why a failed run is not counted against its task (docs/routing-account-health-design.md §7.4): its failure was the
 * account's or the provider's, not the task's (common/run-not-counted.ts decides it, for routing and the failure
 * budget alike).
 */
export type ModelRoutingNotCounted = 'usage-limit' | 'capacity' | 'account' | 'transport' | 'admission';

export interface ModelRoutingRun {
  ordinal: number;
  status: string;
  /** Set when the run is skipped for escalation; absent, it counts. */
  notCounted?: ModelRoutingNotCounted | null;
  /** The provider the run was a refused trial of (§6.5), when it was one. */
  trialOf?: string | null;
  /** The prior decision's tier, including a shadow decision; null falls back to the actual model. */
  level?: ModelRoutingLevel | null;
  model?: string | null;
  effort?: string | null;
  runtime?: string;
  /** Includes a verifier FAIL or owner SEND_BACK after this work run. */
  outcome?: ModelRoutingOutcome;
}

export interface ModelRoutingFeatures {
  completionCriterion?: string | null;
  hasAcceptanceCommand?: boolean;
  verifiesTask?: boolean;
  isForeman?: boolean;
  dependents?: number;
  promptChars?: number;
}

/** Structural inference uses only the same value snapshot recorded with the decision. */
export function inferRuleTier(features: ModelRoutingFeatures = {}): {
  level: ModelRoutingLevel | null; source: 'rule'; reasons: string[];
} {
  const validCount = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const { completionCriterion, hasAcceptanceCommand, verifiesTask, isForeman, dependents, promptChars } = features;
  let level: ModelRoutingLevel | null = null;
  let body = 'No structural rule matched';
  if (isForeman === true || verifiesTask === true ||
      completionCriterion === 'OWNER_CONFIRMED' || completionCriterion === 'VERIFICATION') {
    level = 'L';
    body = 'Tier L: review or coordination requires a conservative starting tier';
  } else if ((validCount(dependents) && dependents >= 3) || (validCount(promptChars) && promptChars >= 8000)) {
    level = 'L';
    body = 'Tier L: broad dependency impact or a large prompt';
  } else if (completionCriterion === 'EXECUTABLE' && hasAcceptanceCommand === true) {
    level = 'M';
    body = 'Tier M: executable work with acceptance feedback';
    if (dependents === 0 && validCount(promptChars) && promptChars > 0 && promptChars <= 2000) {
      level = 'S';
      body = 'Tier S: bounded executable work with immediate acceptance feedback';
    }
  }
  return { level, source: 'rule', reasons: [`[rule] Rule inference — ${body}`] };
}

export type ModelRoutingOptimizeFor = 'cost' | 'balance' | 'intelligence';

export interface ModelRoutingInput {
  optimizeFor?: ModelRoutingOptimizeFor;
  features?: ModelRoutingFeatures;
  task: {
    /** The task's engine pin: like a provider pin, it keeps the run on its engine. */
    engine?: string | null;
    provider?: string | null;
    model?: string | null;
    modelHint?: ModelRoutingLevel | null;
    modelHintReason?: string | null;
  };
  baseline: ModelRoutingSelection & {
    /** The engine the baseline runs on; absent, `environment.runtime`. */
    engine?: string;
    /** Every engine the baseline credential can run on (the shared compatibility table). A run moved to
     *  one of them keeps that credential; absent, the credential runs on its own engine only. */
    engines?: readonly string[];
  };
  /** Work runs only, newest first. The caller supplies ordering and quota classification. */
  history: readonly ModelRoutingRun[];
  environment: {
    /** Resolved runtime of task.provider, or baseline.provider when the task has no provider pin. */
    runtime: string;
    /** Configured providers with their own model space have no runtime tier table. */
    hasOwnModelSpace?: boolean;
    modelCatalog?: RunnerModelCatalog | null;
    runtimeDefaultModels?: RuntimeDefaultModels | null;
    defaultPermissionMode?: string | null;
    planUsage?: PlanUsage | null;
  };
  engines?: {
    /** For a verification task: the engine the task it verifies last ran on, which the pick moves off when it can. */
    verifiedRunEngine?: string | null;
  };
  /** What the SubAgent router reads for the Agent's runner (runner-api/subagent-route.ts subagentRouteInput): the
   *  pool a tiered run is picked from. Absent: nothing was read, and the run keeps the agent's model. */
  pool?: SubagentRoutingInput | null;
  /** The owner's UserPreferences.relaxBlockedPins (docs/routing-account-health-design.md §7.5): a pin on an account
   *  health set aside may run elsewhere. Off (absent): the task holds with the pin named. */
  relaxBlockedPins?: boolean;
}

export interface ModelRoutingDecision extends ModelRoutingSelection {
  policyVersion: typeof MODEL_ROUTING_POLICY_VERSION;
  level: ModelRoutingLevel | null;
  /** The engine the run starts on: the baseline's, or the one the route moved it to (§6). */
  engine: string;
  reasons: string[];
  /** Nothing can run it now (docs/routing-account-health-design.md §7.5): the run is not started, and the task waits. */
  hold?: ModelRoutingHold;
  /** The pick's account is due a trial (§6.5): the dispatch claims it before the run starts. */
  trial?: { subject: string; scopeModel: string; provider: string };
  /** A pin was relaxed off an account health set aside (§7.5): the run goes where it says, tier or not. */
  relaxed?: true;
}

/** Why a task waits for an account (§7.5): each account that could have run it, and when the first is tried again. */
export interface ModelRoutingHold {
  kind: 'ACCOUNT_NEEDS_ACTION';
  /** One sentence: "Waiting for an account: …. Next try at …", or the pin named. */
  reason: string;
  /** The earliest end among them (ISO): the hold lifts then, and the held task takes the trial. */
  until: string;
  accounts: Array<{ provider: string; engine: string | null; line: string; until: string }>;
  /** A pinned task held with relaxation off: the setting that would let it run elsewhere (§7.5), as a link. */
  setting?: string;
}

const FAILURE_WORDING = {
  FAILED: 'failed',
  ACCEPTANCE_FAILED: 'failed its acceptance command',
  VERIFICATION_FAILED: 'was failed by its verifier',
  SENT_BACK: 'was sent back by the owner',
} as const;

export function priorLevel(run: ModelRoutingRun, runtime: string): ModelRoutingLevel | null {
  if (run.level) return run.level;
  const model = run.model ?? '';
  if (model === 'opus' || model.startsWith('claude-opus-')) return 'L';
  if (model === 'sonnet' || model.startsWith('claude-sonnet-')) return 'M';
  if ((run.runtime ?? runtime) === AgentProvider.CODEX) {
    return MODEL_ROUTING_LEVELS.find((level) =>
      DEFAULT_MODEL_TIER_TABLE.codex[level].effort === run.effort,
    ) ?? null;
  }
  return null;
}

/** No I/O or writes to the task: every decision depends only on these value snapshots. */
export function routeTaskRun(input: ModelRoutingInput): ModelRoutingDecision {
  const { task, baseline, environment, history } = input;
  const { runtime } = environment;
  const own = baseline.engine ?? runtime;
  const provider = task.provider ?? baseline.provider;
  const unchanged = (reasons: string[]): ModelRoutingDecision => ({
    engine: own,
    provider,
    model: task.model ?? baseline.model,
    effort: baseline.effort,
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level: null,
    reasons: reasons.map((reason) => reason.startsWith('[') ? reason : `[not-routed] ${reason}`),
  });
  const credential = task.provider ?? baseline.provider;
  if (task.model != null) {
    // A named model is never swapped (§7.5): it runs as pinned, or on another provider × engine that lists that same
    // model when the owner allows it, or the task waits for its account.
    const lines = [`Task pin: ${task.model}`];
    const standing = input.pool ? ownStanding(input, input.pool, own, credential) : {};
    if (!standing.removed) {
      return standing.trial
        ? { ...unchanged(lines), trial: { subject: standing.trial.subject, scopeModel: '', provider: credential } }
        : unchanged(lines);
    }
    const held = holdOf(input, [standing.removed], credential);
    const moved = input.relaxBlockedPins ? samePinnedModel(input, input.pool!, task.model, credential, own, held) : null;
    return moved ?? { ...unchanged([...lines, held.reason]), hold: held };
  }

  const skipped: string[] = [];
  let last: ModelRoutingRun | undefined;
  for (const run of history) {
    if (!run.notCounted) {
      last = run;
      break;
    }
    skipped.push(notCountedLine(run));
  }
  const rule = task.modelHint ? null : inferRuleTier(input.features);
  let level = task.modelHint ?? rule?.level ?? null;
  const reasons: string[] = rule?.level ? [...rule.reasons] : [];
  const mode = input.optimizeFor ?? 'cost';
  const floor = mode === 'balance' ? 'M' : mode === 'intelligence' ? 'L' : null;
  if (!task.modelHint && floor && (!level || MODEL_ROUTING_LEVELS.indexOf(level) < MODEL_ROUTING_LEVELS.indexOf(floor))) {
    level = floor;
    reasons.push(`[default] Tier ${floor}: ${mode === 'balance' ? 'Balance' : 'Intelligence'} minimum for a task without a suggestion`);
  }
  const lastLevel = last ? priorLevel(last, runtime) : null;
  // How the last run ended is its outcome (task-route-decision.ts readRunHistory reads it off the release, design
  // §12.3), never its terminal status word: an end that was asked for and not honoured left the status FAILED and
  // reads OK there (W7, removal step R4).
  const failure = last?.outcome && last.outcome !== 'OK' ? last.outcome : null;
  if (last && lastLevel && failure) {
    const next = Math.min(MODEL_ROUTING_LEVELS.indexOf(lastLevel) + 1, 3);
    level = MODEL_ROUTING_LEVELS[Math.max(next, level ? MODEL_ROUTING_LEVELS.indexOf(level) : 0)];
    reasons.push(
      `[escalate] Tier ${level} — ${level === lastLevel ? 'already the highest tier after' : 'raised after'} ` +
      `run ${last.ordinal} (${lastLevel}) ${FAILURE_WORDING[failure]}`,
    );
    if (!last.level) {
      const label = runnerCatalogRow(last.runtime ?? runtime, last.model ?? '', environment.modelCatalog)?.label
        ?? last.model ?? runtime;
      reasons.push(
        `[escalate] Run ${last.ordinal} used ${label}` +
        `${last.effort ? ` · ${last.effort}` : ''}, which counts as tier ${lastLevel}`,
      );
    }
    if (task.modelHint && MODEL_ROUTING_LEVELS.indexOf(task.modelHint) > next) {
      reasons.push(`[coordinator] Coordinator suggested tier ${task.modelHint}${task.modelHintReason ? `: ${task.modelHintReason}` : ''}`);
    }
  } else if (task.modelHint) {
    reasons.push(`[coordinator] Tier ${level}: suggested by the coordinator${task.modelHintReason ? ` — ${task.modelHintReason}` : ''}`);
  } else if (!level) {
    reasons.push("[not-routed] No suggestion — keeps the agent's model, as today");
  }
  reasons.push(...skipped);
  if (!level) {
    reasons.push(`Engine ${own}: ${task.engine || task.provider ? 'pinned on the task' : "this agent's own engine"}`);
    // Kept on the Agent's own model, which only runs while its account can (§7.5, G7); with no tier there is nothing
    // to relax a pin at, so it waits. An account whose trial is due takes it.
    const standing = input.pool ? ownStanding(input, input.pool, own, credential) : {};
    if (standing.removed) return { ...unchanged(reasons), hold: holdOf(input, [standing.removed], credential) };
    return standing.trial
      ? { ...unchanged(reasons), trial: { subject: standing.trial.subject, scopeModel: '', provider: credential } }
      : unchanged(reasons);
  }
  if (!input.pool) return unchanged([...reasons, "No providers were read — keeps the agent's model"]);
  // The pick is the SubAgent router's (§4.2), at this tier: every provider × engine × model the owner has.
  const pool = taskRunPool(input, input.pool, level, mode);
  const route = routeSubagent(pool);
  const candidates = fallbackOrder(route);
  const runnable = candidates.filter((c) => autoEligible(c, environment));
  if (runnable.length < candidates.length || pool.modelCatalog !== input.pool.modelCatalog) {
    reasons.push('Models without Auto permission support were excluded');
  }
  const verified = input.engines?.verifiedRunEngine ?? null;
  const fresh = verified ? runnable.find((c) => c.engine !== verified) : undefined;
  // The Agent's own engine and credential keep the run while they can take it at this tier (owner, 2026-11-20): the
  // router's ranking only decides where it goes when they cannot. A verification's fresh pair of eyes comes first.
  // A suspect account is not kept for being the Agent's own (§6.4): the failure the router just saw outranks it, and
  // the run goes to a healthy account when there is one.
  const ownMatch = runnable.find((c) => c.engine === own && c.provider === credential && c.level === level);
  const ownPick = ownMatch?.suspect && runnable.some((c) => !c.suspect) ? undefined : ownMatch;
  const pick = fresh ?? ownPick ?? runnable[0];
  // The router's own words, less what only a SubAgent says: the caller that set the tier, and its refusal.
  const lines = route.reasons.filter((r) =>
    !r.startsWith(`Tier ${level}, set by the caller`) && !r.startsWith('No provider can run a SubAgent'));
  if (!pick) {
    // No longer the Agent's own model when its account cannot run (§7.5, G7): the task waits for the first that can.
    // A pin on what health set aside is relaxed, one step at a time, when the owner allows it (§7.5).
    const held = healthHold(input, route, own, credential);
    const relaxed = held && input.relaxBlockedPins && (task.provider || task.engine)
      ? relaxedPin(input, input.pool, level, mode, own, credential, held, [...reasons, ...lines])
      : null;
    if (relaxed) return relaxed;
    if (held) return { ...unchanged([...reasons, ...lines, held.reason]), hold: held };
    return unchanged([...reasons, ...lines, "No provider can run it at this tier — keeps the agent's model"]);
  }
  if (!fresh && ownPick && pick === ownPick) {
    reasons.push(`Engine ${own}: this agent's own engine, which can take the run at tier ${level}`);
  }
  if (verified) {
    reasons.push(fresh
      ? `Engine ${pick.engine}: the task it verifies last ran on ${verified}`
      : `Engine ${pick.engine}: no other engine it may use is available; the task it verifies last ran on ${verified}`);
  }
  if (pick !== candidates[0]) {
    // The router's "Picked …" names the candidate it ranked first, not this one.
    reasons.push(...lines.filter((r) => !r.startsWith('Picked ')));
    reasons.push(`Runs on ${pick.model}${pick.effort ? ` · ${pick.effort}` : ''} on ${pick.provider}${pick.note ? `, ${pick.note}` : ''}`);
  } else {
    reasons.push(...lines);
  }
  return {
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level,
    engine: pick.engine,
    provider: pick.provider,
    model: pick.model,
    effort: pick.effort,
    reasons,
    ...(pick.trial ? { trial: { subject: pick.trial.subject, scopeModel: '', provider: pick.provider } } : {}),
  };
}

/** The line a run skipped for escalation leaves (§7.4). */
function notCountedLine(run: ModelRoutingRun): string {
  const n = `Run ${run.ordinal}`;
  if (run.trialOf) return `${n} was a trial of ${run.trialOf}, which refused it — not counted`;
  switch (run.notCounted) {
    case 'usage-limit': return `${n} hit a usage limit — not counted`;
    case 'capacity': return `${n} found the model at capacity — not counted`;
    case 'account': return `${n} was refused by its account before it started — not counted`;
    case 'transport': return `${n} lost its connection — not counted`;
    default: return `${n} failed to start at no cost — not counted`;
  }
}

/**
 * The hold of §7.5 when nothing in the pool can run: each candidate health removed, and the earliest of their ends.
 * Only when the Agent's own engine and credential are among them (or the task is pinned to what was removed): a pool
 * that is empty for any other reason keeps the Agent's model, as it did.
 */
function healthHold(
  input: ModelRoutingInput,
  route: SubagentRoutingDecision,
  own: string,
  credential: string,
): ModelRoutingHold | null {
  const removed = route.candidates.filter((c) => c.health);
  if (removed.length === 0) return null;
  const ownRemoved = removed.some((c) => c.provider === credential && (c.engine === null || c.engine === own));
  if (!ownRemoved && !input.task.provider && !input.task.engine) return null;
  return holdOf(input, removed, credential);
}

/**
 * What account health says of the run's own provider × engine, the one a run keeps when it is not routed (§7.5, G7):
 * the removal when health sets the account aside (or, for a model pin, that model on it), else the trial its account
 * is due. Nothing for an account health has no word on, or one ruled out for another reason (that keeps today's
 * behaviour: health relaxes and holds for health only).
 */
function ownStanding(
  input: ModelRoutingInput,
  pool: SubagentRoutingInput,
  own: string,
  credential: string,
): { removed?: SubagentRemovedCandidate; trial?: RoutingHealthEntry } {
  const provider = pool.providers.find((p) => p.slug === credential);
  if (!provider || !provider.engines.some((spec) => spec.engine === own)) return {};
  if (providerRefusal(pool, provider)) return {};
  const verdict = engineVerdict(pool, provider, own);
  if ('reason' in verdict) {
    return verdict.health
      ? { removed: { provider: credential, engine: own, model: null, effort: null, reason: verdict.reason, health: verdict.health } }
      : {};
  }
  const model = input.task.model ?? null;
  const modelOut = model ? verdict.modelHealth.get(model) : undefined;
  if (model && modelOut) {
    return { removed: { provider: credential, engine: own, model, effort: null, reason: healthLine(modelOut, own), health: modelOut } };
  }
  return verdict.trial ? { trial: verdict.trial } : {};
}

/**
 * What account health means for a run that is not routed at all, the owner's smart model selection being off: the
 * run keeps its baseline (or its pins), and still does not start on an account health set aside, nor rush one whose
 * trial is due. No tier and no relaxation: both are routing (docs/routing-account-health-design.md §7.5).
 */
export function baselineHealth(input: ModelRoutingInput): {
  hold?: ModelRoutingHold;
  trial?: { subject: string; scopeModel: string; provider: string };
} {
  if (!input.pool) return {};
  const own = input.baseline.engine ?? input.environment.runtime;
  const credential = input.task.provider ?? input.baseline.provider;
  const standing = ownStanding(input, input.pool, own, credential);
  if (standing.removed) return { hold: holdOf(input, [standing.removed], credential) };
  return standing.trial ? { trial: { subject: standing.trial.subject, scopeModel: '', provider: credential } } : {};
}

/** The earliest-ending account of a hold: the one its line quotes. */
function firstHeld(hold: ModelRoutingHold): ModelRoutingHold['accounts'][number] {
  return hold.accounts.reduce((a, b) => (b.until < a.until ? b : a));
}

function holdOf(input: ModelRoutingInput, removed: readonly SubagentRemovedCandidate[], credential: string): ModelRoutingHold {
  // One line per account: a model's removal and its account's say the same account twice.
  const seen = new Set<string>();
  const accounts = removed
    .filter((c) => {
      const key = `${c.provider}\u0000${c.engine ?? ''}\u0000${c.health!.model ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({ provider: c.provider, engine: c.engine, line: c.reason, until: new Date(c.health!.until).toISOString() }));
  const first = accounts.reduce((a, b) => (b.until < a.until ? b : a));
  const at = minuteOf(Date.parse(first.until));
  const { task } = input;
  const pin = task.model ? `${task.model} on ${credential}` : task.provider ?? task.engine;
  const reason = pin
    ? `Pinned to ${pin}, which can't run now (${first.line}). Next try at ${at}.`
    : `Waiting for an account: ${first.line}. Next try at ${at}.`;
  // With relaxation off a pin holds, and the hold links the setting that lets it run elsewhere (§7.5).
  const setting = pin && !input.relaxBlockedPins ? { setting: settingLink('relaxBlockedPins') } : {};
  return { kind: 'ACCOUNT_NEEDS_ACTION', reason, until: first.until, accounts, ...setting };
}

/**
 * §7.5 with the switch on, for a provider or engine pin whose account health set aside: the pool is widened one step
 * at a time and the first step with a runnable candidate wins. Step 1 keeps the engine and drops the provider (only
 * when a provider is pinned); step 2 drops both. The tier is kept: the ordinary fit order applies inside the widened
 * pool. The owner's blocked providers and a shared provider out of scope stay out, as routeSubagent's own filters keep
 * them. Null when no step can run it: the task holds.
 */
function relaxedPin(
  input: ModelRoutingInput,
  pool: SubagentRoutingInput,
  level: ModelRoutingLevel,
  mode: ModelRoutingOptimizeFor,
  own: string,
  credential: string,
  held: ModelRoutingHold,
  reasons: readonly string[],
): ModelRoutingDecision | null {
  const line = firstHeld(held).line;
  const engine = input.task.engine ?? own;
  const steps: Array<{ engine: string | null; why: (pick: SubagentFallback) => string }> = [];
  if (input.task.provider) {
    steps.push({
      engine,
      why: (pick) => `Pinned to ${credential}, which can't run now (${line}); runs on ${pick.provider} instead, on the same engine, at tier ${level}`,
    });
  }
  steps.push({
    engine: null,
    why: (pick) => `Pinned to ${credential} on ${engine}, where no account can run now (${line}); runs on ${pick.model} on ${pick.provider} instead, at tier ${level}`,
  });
  for (const step of steps) {
    const widened = { ...input, task: { ...input.task, provider: null, engine: step.engine } };
    const route = routeSubagent(taskRunPool(widened, pool, level, mode));
    const pick = fallbackOrder(route).find((c) => autoEligible(c, input.environment));
    if (!pick) continue;
    return {
      policyVersion: MODEL_ROUTING_POLICY_VERSION,
      level,
      engine: pick.engine,
      provider: pick.provider,
      model: pick.model,
      effort: pick.effort,
      relaxed: true,
      reasons: [...reasons, step.why(pick)],
      ...(pick.trial ? { trial: { subject: pick.trial.subject, scopeModel: '', provider: pick.provider } } : {}),
    };
  }
  return null;
}

/**
 * §7.5 with the switch on, for a model pin whose account health set aside: the same model id on another provider ×
 * engine that lists it and passes the §4.2 filters, in the owner's provider order, at its engine's default effort.
 * Never another model: null when nobody else lists it, and the task holds.
 */
function samePinnedModel(
  input: ModelRoutingInput,
  pool: SubagentRoutingInput,
  model: string,
  credential: string,
  own: string,
  held: ModelRoutingHold,
): ModelRoutingDecision | null {
  const unpinned = { ...input, task: { ...input.task, provider: null, engine: null } };
  const named = routeSubagent({
    ...taskRunPool(unpinned, pool, 'M', input.optimizeFor ?? 'cost'),
    caller: { model },
    strictNamedModel: true,
  });
  const pick = fallbackOrder(named).find((c) =>
    c.model === model && !(c.provider === credential && c.engine === own) && autoEligible(c, input.environment));
  if (!pick) return null;
  return {
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level: null,
    engine: pick.engine,
    provider: pick.provider,
    model,
    effort: pick.effort,
    relaxed: true,
    reasons: [
      `[not-routed] Task pin: ${model}`,
      `Pinned to ${model} on ${credential}, which can't run now (${firstHeld(held).line}); runs the same model on ${pick.provider}`,
    ],
    ...(pick.trial ? { trial: { subject: pick.trial.subject, scopeModel: '', provider: pick.provider } } : {}),
  };
}

/** The SubAgent router's input for one task run at `level`: the owner's providers as read for the Agent's runner,
 *  less what the task's engine or provider pin rules out, and in Auto mode less the runner's Claude models that
 *  cannot use Auto, so a tier's family is picked among the ones that can. */
function taskRunPool(
  input: ModelRoutingInput,
  pool: SubagentRoutingInput,
  level: ModelRoutingLevel,
  mode: ModelRoutingOptimizeFor,
): SubagentRoutingInput {
  const { engine, provider } = input.task;
  const providers = pool.providers
    .filter((p) => !provider || p.slug === provider)
    .map((p) => (engine ? { ...p, engines: p.engines.filter((spec) => spec.engine === engine) } : p))
    .filter((p) => p.engines.length > 0);
  const claude = pool.modelCatalog?.[AgentProvider.CLAUDE];
  const auto = claude?.filter((row) => autoEligible(
    { engine: AgentProvider.CLAUDE, provider: '', model: row.value, effort: null }, input.environment));
  const modelCatalog = claude && auto && auto.length < claude.length
    ? { ...pool.modelCatalog, [AgentProvider.CLAUDE]: auto }
    : pool.modelCatalog;
  return {
    ...pool,
    modelCatalog,
    type: 'task',
    definitionName: 'the task',
    caller: { size: level },
    definition: {},
    optimizeFor: mode,
    providers,
    smartSelection: true,
    strictNamedModel: false,
    // A task run keeps the order it had before SubAgents chose the model first (§4.2): in Balance, the default, the
    // two steps would change which model a task run gets whenever the Agent's own engine cannot take it, and that
    // change was not asked for (owner, 2026-11-22).
    rankTogether: true,
    runnerLabel: "this agent's runner",
  };
}

/** The pick and then its fallbacks, in the router's order. */
function fallbackOrder(route: SubagentRoutingDecision): SubagentFallback[] {
  const first = route.engine && route.provider && route.model
    ? [{
      engine: route.engine, provider: route.provider, model: route.model, effort: route.effort, level: route.pickLevel ?? null,
      ...(route.note ? { note: route.note } : {}),
      ...(route.trial ? { trial: route.trial } : {}), ...(route.suspect ? { suspect: true } : {}),
    }]
    : [];
  return [...first, ...route.fallbacks];
}

/** A Claude model a run in Auto permission mode can use: Auto has to be available for it. */
function autoEligible(c: SubagentFallback, environment: ModelRoutingInput['environment']): boolean {
  return c.engine !== AgentProvider.CLAUDE
    || environment.defaultPermissionMode !== PermissionMode.AUTO
    || autoAvailable(c.engine, c.model, false, environment.modelCatalog);
}

// ─────────────────────────── SubAgent routing (docs/subagent-design.md §4.1, §4.2) ───────────────────────────

/** What a recorded SubAgent decision was made under: bump when a rule below changes what it picks. */
export const SUBAGENT_ROUTING_POLICY_VERSION = 'p8-account-health-1';

/** Which row of §4.1 set the tier — or, for the first two, the model; `not-routed`: smart model selection is off. */
export type SubagentTierSource =
  'not-routed' | 'named-model' | 'definition-model' | 'size' | 'definition-size' | 'type-default';

/** One row of the tier table: a model on one engine at one effort, its tier and its price (§4.2). */
export interface SubagentModelRow {
  model: string;
  effort: string | null;
  /** Null: the model has no tier; an engine with no tiers at all routes its default model, after every tiered one. */
  level: ModelRoutingLevel | null;
  /** USD per million output tokens, for a metered key; null when nobody knows it. */
  outputPricePerMTok?: number | null;
  /** On a provider's own model space: where the row's tier came from, the owner or the catalogue (a preset's tier or
   *  the model's family). Step 1 of the two-step order prefers the owner's tier (§4.2). */
  source?: 'catalogue' | 'owner' | null;
}

/** One engine a provider runs on, as the parent's runner sees it. */
export interface SubagentProviderEngine {
  engine: string;
  /** The rows of a model space of the provider's own. Absent: the engine's runner-reported catalogue,
   *  which the built-in tier table (DEFAULT_MODEL_TIER_TABLE) or the family tiers (MODEL_FAMILY_TIERS) describe. */
  models?: readonly SubagentModelRow[];
  /** For a key on that catalogue: USD per million output tokens by model id (models.dev). */
  prices?: Readonly<Record<string, number>>;
  /** The model it runs when none is named (the provider's own default): what an engine with no tiers routes onto. */
  defaultModel?: string | null;
}

/** One account of an account pool, as its quota and pause stand. */
export interface SubagentPoolMember {
  label: string;
  /** Its fullest live window; null when every window it reported has room again. */
  quota?: ModelRoutingEngineState['quota'];
  paused?: boolean;
  /** The endpoint refused its credential: no run can go to it. */
  refused?: boolean;
  /** Its quota could not be read: nothing was reported, or the endpoint will not report on it. */
  unreadable?: boolean;
  /** When its quota goes to waste (ms), null when unknown, and how long that window is; and whether a window is
   *  nearly spent. */
  expiresAt?: number | null;
  expiryWindowMins?: number | null;
  nearLimit?: boolean;
  /** Its Opus weekly window, in percent; null when none is live. */
  opusUtilization?: number | null;
  /** What account health says of it (docs/routing-account-health-design.md §7.1); absent: healthy. */
  health?: readonly RoutingHealthEntry[];
}

/** One provider the owner has, in the owner's order (provider_list). */
export interface SubagentProvider {
  slug: string;
  /** A sign-in that spends a subscription's quota, or a key that is billed per token. */
  billing: 'subscription' | 'key';
  /** Inside usableProviderScope: a shared provider is for admins only. */
  inScope: boolean;
  engines: readonly SubagentProviderEngine[];
  /** The credential it spends, as far as the Claude region check asks (credentialIsAnthropicBound, contract §8). */
  credential: AnthropicBoundCredential;
  /** A subscription's account on the parent's runner: its fullest window, and whether it is paused. On a metered key
   *  only `health` is read: what the runs sent to that key have shown (§7.1, G8). */
  account?: {
    quota?: ModelRoutingEngineState['quota']; paused?: boolean; refused?: boolean; unreadable?: boolean;
    expiresAt?: number | null; expiryWindowMins?: number | null; nearLimit?: boolean; opusUtilization?: number | null;
    health?: readonly RoutingHealthEntry[];
  } | null;
  /** An account pool: a subscription on its members' own credentials, whose headroom is its best member's. */
  pool?: { members: readonly SubagentPoolMember[] };
}

/** The parent's runner's word on one engine. An engine absent from `SubagentRoutingInput.engines` was not reported. */
export interface SubagentEngineReport extends ModelRoutingEngineState {
  installed: boolean;
}

export interface SubagentRoutingInput {
  /** `explore`, `general` or a definition's name. */
  type: string;
  /** What reasons call the definition: its file name, or the built-in type. */
  definitionName: string;
  caller: { model?: string | null; size?: ModelRoutingLevel | null; sizeReason?: string | null };
  /** The definition's `model` (an id, `inherit` or `auto`) and its `size`. */
  definition: { model?: string | null; size?: ModelRoutingLevel | null };
  optimizeFor: ModelRoutingOptimizeFor;
  /** The parent session's own engine, credential, model and effort. */
  parent: { engine: string; provider: string; model: string; effort: string | null };
  providers: readonly SubagentProvider[];
  /** `UserPreferences.subagentBlockedProviders`. */
  blockedProviders: readonly string[];
  /** The parent's runner's report, by engine; null when that runner has reported none. */
  engines: Readonly<Record<string, SubagentEngineReport>> | null;
  modelCatalog?: RunnerModelCatalog | null;
  runtimeDefaultModels?: RuntimeDefaultModels | null;
  /** The runner `engines` reports on, as the reasons name it; `the parent's runner` when absent. A remote SubAgent
   *  is routed on its target workspace's runner (§10.3). */
  runnerLabel?: string;
  /** A named model only runs where a usable provider offers it (§10.3): every provider × engine that offers it and
   *  passes the §4.2 filters is a candidate, the rest are removed with their reason, and none left is no pick at
   *  all — never the parent's model. Absent: the first provider in the owner's order that lists it, else the parent's. */
  strictNamedModel?: boolean;
  /** The owner's tiers for built-in engines' catalogue models (`UserPreferences.builtinModelTiers`): each overrides
   *  the built-in table and the family tiers for that model on that engine. Absent: none set. */
  builtinModelTiers?: BuiltinModelTiers;
  /** The account's smart model selection switch (common/model-routing-switch.ts). False: no tier is routed —
   *  a named model is still used, anything else runs on the parent's. Absent: on. */
  smartSelection?: boolean;
  /** When the route is made (ms): what tells a quota about to go to waste in Balance (§4.2). Absent: none is. */
  now?: number;
  /** Rank every candidate together, by quota, in every mode: the order before the two steps (policy p6), which a
   *  task run keeps (routeTaskRun, §4.2). Absent: Intelligence and Balance choose the model, then the account. */
  rankTogether?: boolean;
}

/** A candidate taken out of the pool, and why. Null model: the whole provider or engine went. */
export interface SubagentRemovedCandidate {
  provider: string;
  engine: string | null;
  model: string | null;
  effort: string | null;
  reason: string;
  /** Account health removed it (§7.1): the entry, so a hold can name it and say when it is tried again. */
  health?: RoutingHealthEntry;
}

export interface SubagentRoutingDecision {
  level: ModelRoutingLevel | null;
  tierSource: SubagentTierSource;
  optimizeFor: ModelRoutingOptimizeFor;
  /** Null when the pool was empty in the tier: a routed delegate would be refused NO_SUBAGENT_PROVIDER. */
  engine: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  reasons: string[];
  candidates: SubagentRemovedCandidate[];
  /** The rest of the pool after the pick, every tier, in the order it was ranked: where a SubAgent whose account
   *  hit its limit moves next (§4.3). Empty when the model was named rather than routed. */
  fallbacks: SubagentFallback[];
  /** SUBAGENT_ROUTING_POLICY_VERSION. */
  policyVersion: string;
  /** Where the tier or model came from, in a few words: the Why line's first clause. */
  tierNote: string;
  /** Why the pick, in a few words (its billing and headroom); absent for a model that was named. */
  note?: string;
  /** The pick's own tier, which may differ from `level` when none in that tier could run; null when untiered.
   *  Absent for a model that was named or not routed. */
  pickLevel?: ModelRoutingLevel | null;
  /** The pick's account is due its trial (§6.5). */
  trial?: RoutingHealthEntry;
  /** The pick's account failed its last run at no cost: every other candidate was suspect too (§7.2). */
  suspect?: boolean;
}

/** One candidate a SubAgent may move to after a usage-limit or capacity failure (§4.3). */
export interface SubagentFallback {
  engine: string;
  provider: string;
  model: string;
  effort: string | null;
  /** Its billing and headroom in a few words, as the Why line says it once it runs there. */
  note?: string;
  /** Its own tier, null for an untiered default model: what says so when it runs instead of the asked tier. */
  level?: ModelRoutingLevel | null;
  /** Its account's trial is due (§6.5): a run that goes there claims it first. */
  trial?: RoutingHealthEntry;
  /** Its account failed its last run at no cost (§7.2). */
  suspect?: boolean;
}

const levelIndex = (level: ModelRoutingLevel): number => MODEL_ROUTING_LEVELS.indexOf(level);
const OPTIMIZE_LABEL = { cost: 'Cost', balance: 'Balance', intelligence: 'Intelligence' } as const;

/**
 * The built-in tier table's rows for an engine's runner-reported catalogue: Claude's families at the
 * table's efforts, the family's first model by catalogue priority (as routeTaskRun picks it), and Codex's
 * runner default at each effort, and Kimi's first reported model of each tier. Every other engine's
 * catalogue is tiered by family (MODEL_FAMILY_TIERS); a model of no family has no tier. On every engine a model
 * the owner tiers (builtinModelTiers) takes the owner's tier instead (withOwnerTiers).
 */
type SubagentCatalogInput = Pick<SubagentRoutingInput, 'modelCatalog' | 'runtimeDefaultModels' | 'builtinModelTiers'>;

function builtinTierRows(
  engine: string,
  input: SubagentCatalogInput,
  prices?: Readonly<Record<string, number>>,
): SubagentModelRow[] {
  return builtinRows(engine, input).map((row) => (prices ? { ...row, outputPricePerMTok: prices[row.model] ?? null } : row));
}

function builtinRows(engine: string, input: SubagentCatalogInput): SubagentModelRow[] {
  const catalog = input.modelCatalog?.[engine as AgentProvider] ?? [];
  return withOwnerTiers(tableRows(engine, input, catalog), catalog, input.builtinModelTiers?.[engine]);
}

function tableRows(engine: string, input: SubagentCatalogInput, catalog: readonly RunnerModelInfo[]): SubagentModelRow[] {
  if (engine === AgentProvider.CLAUDE) {
    const family = (prefix: string) => catalog
      .filter((row) => row.value.startsWith(prefix))
      .reduce<RunnerModelInfo | undefined>((best, row) =>
        !best || (row.priority ?? Infinity) < (best.priority ?? Infinity) ? row : best, undefined);
    return MODEL_ROUTING_LEVELS.flatMap((level) => {
      const tier = DEFAULT_MODEL_TIER_TABLE.claude[level];
      const model = family(tier.prefix);
      return model ? [{ model: model.value, effort: tier.effort, level }] : [];
    });
  }
  if (engine === AgentProvider.CODEX) {
    const named = input.runtimeDefaultModels?.codex;
    const model = catalog.find((row) => row.value === named) ?? catalog[0];
    return model
      ? MODEL_ROUTING_LEVELS.map((level) => ({ model: model.value, effort: DEFAULT_MODEL_TIER_TABLE.codex[level].effort, level }))
      : [];
  }
  if (engine === AgentProvider.KIMI) {
    return MODEL_ROUTING_LEVELS.flatMap((level) => {
      const tier = DEFAULT_MODEL_TIER_TABLE.kimi[level];
      const model = tier.models.find((value) => catalog.some((row) => row.value === value));
      return model ? [{ model, effort: tier.effort, level }] : [];
    });
  }
  return familyTierRows(catalog);
}

/**
 * The tier rows routeSubagent reads for one engine of a provider: the provider's own model space, else the
 * engine's runner-reported catalogue through the built-in tier table. What the Providers page's Tier column
 * shows (GET /providers/subagent-tiers), so it cannot say a model is routed when the router would skip it.
 */
export function subagentEngineRows(engine: SubagentProviderEngine, input: SubagentCatalogInput): SubagentModelRow[] {
  return engine.models ? [...engine.models] : builtinTierRows(engine.engine, input, engine.prices);
}

interface SubagentCandidate extends SubagentModelRow {
  provider: SubagentProvider;
  providerIndex: number;
  engine: string;
  engineIndex: number;
  /** Its row's place in the engine's tier rows: the table's own order within a tier. */
  rowIndex: number;
  /** Where its tier came from, for step 1 (§4.2): the owner's tier, a rule (a family, measured or not, or a preset's
   *  catalogue), or an engine's built-in table. */
  origin: SubagentTierOrigin;
  /** The highest tier any row of this model reaches on this provider and engine; the asked tier for an untiered one. */
  ceiling: ModelRoutingLevel;
  /** For a pool: the quota of its account with the most left, which is its headroom. */
  quota?: ModelRoutingEngineState['quota'];
  /** A subscription whose quota was not read: ranked after those whose headroom is known. */
  quotaUnknown: boolean;
  /** A subscription's: when what it has left goes to waste (null: no reset known), how long that window is, and
   *  whether it is nearly spent. */
  expiresAt: number | null;
  expiryWindowMins: number | null;
  nearLimit: boolean;
  poolMember?: string;
  /** How it fits the asked tier (§4.2): the tier itself, a higher one, an untiered default model, a lower one. */
  fit: SubagentFit;
  /** For a higher or lower tier: how many tiers away. */
  distance: number;
  /** Its account failed its last run at no cost (the breaker's first strike): ranked after every healthy one (§7.2). */
  suspect: boolean;
  /** Its account's trial is due: ranked as healthy, so that a trial happens (§7.2). */
  trial: RoutingHealthEntry | null;
}

/** The order the fits are tried in, best first. */
const SUBAGENT_FITS = ['exact', 'higher', 'untiered', 'lower'] as const;
type SubagentFit = (typeof SUBAGENT_FITS)[number];

/** Where a model's tier came from, most preferred first (owner, 2026-11-22): the owner's own tier, a family rule
 *  (measured or not) or a preset's catalogue, an engine's built-in table. */
const SUBAGENT_TIER_ORIGINS = ['owner', 'rule', 'table'] as const;
type SubagentTierOrigin = (typeof SUBAGENT_TIER_ORIGINS)[number];

/** The engines whose catalogue the built-in table tiers (DEFAULT_MODEL_TIER_TABLE); every other one's is tiered by family. */
const TABLE_ENGINES: readonly string[] = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI];

/**
 * How soon a weekly or monthly quota's reset has to be for Balance to call what is left of it about to go to waste
 * (§4.2): a day. Long enough for the runs of that day to spend what is left; short enough that the preferred model
 * keeps the rest of the week (six days in seven of a weekly window). Only a window longer than this counts: a
 * 5-hour one always resets within it, and gives its quota back every few hours anyway.
 */
export const SUBAGENT_WASTE_WINDOW_MS = 24 * 3_600_000;

/** Quota left on a subscription's account, in percent; a key has no quota to run out of. */
const headroom = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 100 - (c.quota?.utilization ?? 0) : 100;
/** What one more run costs at the margin: nothing on a subscription, the key's price otherwise. */
const marginalPrice = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 0 : c.outputPricePerMTok ?? Infinity;

/**
 * Quota that goes to waste first is spent first (owner, 2026-11-19), as account selection does (rankAccounts in
 * planUsage.ts): one nearly spent last, then the soonest expiry. A key, and a subscription with no reset known,
 * expire never.
 */
function expiryOrder(a: SubagentCandidate, b: SubagentCandidate): number {
  const near = Number(a.nearLimit) - Number(b.nearLimit);
  if (near) return near;
  const x = a.expiresAt ?? Infinity;
  const y = b.expiresAt ?? Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}

const fitOrder = (a: SubagentCandidate, b: SubagentCandidate): number =>
  SUBAGENT_FITS.indexOf(a.fit) - SUBAGENT_FITS.indexOf(b.fit) || a.distance - b.distance;

/**
 * The accounts that can run one model, best first (step 2 of §4.2), and Cost's whole order within a fit: every usable
 * subscription before any metered key (owner, 2026-11-19: free quota is spent before money); among subscriptions those
 * whose quota was read, then the quota that goes to waste first, then the most left; among keys the cheapest; then the
 * owner's provider order.
 */
function compareAccounts(a: SubagentCandidate, b: SubagentCandidate): number {
  const subscription = (c: SubagentCandidate) => (c.provider.billing === 'subscription' ? 0 : 1);
  const unknown = (c: SubagentCandidate) => (c.quotaUnknown ? 1 : 0);
  // Healthy before suspect, for subscriptions and keys alike (§7.2): headroom never outranks a failure just seen.
  const order = Number(a.suspect) - Number(b.suspect)
    || subscription(a) - subscription(b)
    || (subscription(a) === 0
      ? unknown(a) - unknown(b) || expiryOrder(a, b) || headroom(b) - headroom(a)
      : marginalPrice(a) - marginalPrice(b));
  // NaN only from Infinity - Infinity: two keys nobody knows the price of, which tie.
  return (Number.isNaN(order) ? 0 : order) || a.providerIndex - b.providerIndex || a.engineIndex - b.engineIndex;
}

/**
 * Every candidate ranked together within its fit (the order before the two steps): Cost's order in every mode but
 * Intelligence, which ranks the model whose tier reaches highest first, then by quota and price. What Cost routes by,
 * and what a task run keeps in every mode (rankTogether).
 */
function compareTogether(mode: ModelRoutingOptimizeFor, a: SubagentCandidate, b: SubagentCandidate): number {
  const fit = fitOrder(a, b);
  if (fit) return fit;
  if (mode !== 'intelligence') return compareAccounts(a, b);
  const unknown = (c: SubagentCandidate) => (c.quotaUnknown ? 1 : 0);
  const order = Number(a.suspect) - Number(b.suspect) || levelIndex(b.ceiling) - levelIndex(a.ceiling) || unknown(a) - unknown(b) || expiryOrder(a, b)
    || marginalPrice(a) - marginalPrice(b);
  return (Number.isNaN(order) ? 0 : order) || a.providerIndex - b.providerIndex || a.engineIndex - b.engineIndex;
}

/** One model in one fit (a tier, or the untiered models), with every account that can run it, best first. */
interface SubagentModelChoice {
  model: string;
  accounts: SubagentCandidate[];
  /** The highest tier any of its rows reaches. */
  ceiling: ModelRoutingLevel;
  /** Step 1's preference (§4.2): its first account's place in the owner's provider order, then where its tier came
   *  from, then its row's place in the table. */
  preference: number[];
}

/** How step 1 settled on the model that runs, for the Why line. */
type SubagentModelReason =
  | { kind: 'only' }
  | { kind: 'preferred' }
  | { kind: 'strongest' }
  | { kind: 'near-limit'; preferred: string; keysOnly: boolean }
  | { kind: 'waste'; preferred: string; account: SubagentCandidate };

const preferenceOf = (c: SubagentCandidate): number[] =>
  [c.providerIndex, c.engineIndex, SUBAGENT_TIER_ORIGINS.indexOf(c.origin), c.rowIndex];
const comparePreference = (x: readonly number[], y: readonly number[]): number => {
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** A model with a subscription that is not nearly spent: Balance keeps the preferred model while it has one. */
const hasRoom = (m: SubagentModelChoice): boolean =>
  m.accounts.some((c) => c.provider.billing === 'subscription' && !c.nearLimit);

/** A subscription whose weekly or monthly quota resets within SUBAGENT_WASTE_WINDOW_MS with room left. */
function wastesSoon(c: SubagentCandidate, now: number | undefined): boolean {
  return now !== undefined && c.provider.billing === 'subscription' && !c.nearLimit && c.expiresAt !== null
    && (c.expiryWindowMins ?? 0) * 60_000 > SUBAGENT_WASTE_WINDOW_MS
    && c.expiresAt > now && c.expiresAt - now <= SUBAGENT_WASTE_WINDOW_MS;
}

/**
 * The two steps (§4.2, owner 2026-11-22), within each fit (exact, then higher, untiered, lower, as before): choose the
 * model, then the account. Each model's accounts are ranked by compareAccounts; the models by step 1's preference,
 * Intelligence first by how high a model's tier reaches. Intelligence moves to the next model only when no account of
 * the chosen one can run (it is then not in the pool). Balance lets another model of the same tier take over in two
 * cases: when another model's weekly or monthly quota is about to go to waste (wastesSoon) and none of the preferred
 * model's is, the one whose quota resets first; else when no subscription of the preferred model has room (all near
 * their limit, or only metered keys), the next model that has one. The rest keep their order. The result is the pick
 * and its fallbacks, in order: every account of the chosen model, then the next model's, then the next fit's.
 */
function modelFirstOrder(
  mode: 'balance' | 'intelligence',
  pool: readonly SubagentCandidate[],
  now: number | undefined,
): { ordered: SubagentCandidate[]; models: SubagentModelChoice[]; reason: SubagentModelReason } {
  const fits = new Map<string, SubagentCandidate[]>();
  for (const c of [...pool].sort(fitOrder)) {
    const key = `${c.fit}:${c.distance}`;
    fits.set(key, [...(fits.get(key) ?? []), c]);
  }
  const ordered: SubagentCandidate[] = [];
  let first: { models: SubagentModelChoice[]; reason: SubagentModelReason } | null = null;
  for (const candidates of fits.values()) {
    const byModel = new Map<string, SubagentCandidate[]>();
    for (const c of candidates) byModel.set(c.model, [...(byModel.get(c.model) ?? []), c]);
    const models: SubagentModelChoice[] = [...byModel.entries()].map(([model, accounts]) => ({
      model,
      accounts: [...accounts].sort(compareAccounts),
      ceiling: accounts.map((c) => c.ceiling).reduce((x, y) => (levelIndex(y) > levelIndex(x) ? y : x)),
      preference: accounts.map(preferenceOf).sort(comparePreference)[0],
    }));
    models.sort((a, b) => (mode === 'intelligence' ? levelIndex(b.ceiling) - levelIndex(a.ceiling) : 0)
      || comparePreference(a.preference, b.preference));
    let reason: SubagentModelReason = models.length === 1 ? { kind: 'only' }
      : mode === 'intelligence' && models[0].ceiling !== models[1].ceiling ? { kind: 'strongest' } : { kind: 'preferred' };
    if (mode === 'balance' && models.length > 1) {
      const [preferred] = models;
      // The other model whose quota goes to waste first, if any does and none of the preferred model's does.
      let wasting: { index: number; account: SubagentCandidate } | null = null;
      if (!preferred.accounts.some((c) => wastesSoon(c, now))) {
        models.forEach((m, index) => {
          const account = m.accounts.find((c) => wastesSoon(c, now));
          if (index > 0 && account && (!wasting || account.expiresAt! < wasting.account.expiresAt!)) wasting = { index, account };
        });
      }
      const found = wasting as { index: number; account: SubagentCandidate } | null;
      let takeover = -1;
      if (found) {
        takeover = found.index;
        reason = { kind: 'waste', preferred: preferred.model, account: found.account };
      } else if (!hasRoom(preferred)) {
        takeover = models.findIndex(hasRoom);
        if (takeover > 0) {
          reason = { kind: 'near-limit', preferred: preferred.model, keysOnly: preferred.accounts.every((c) => c.provider.billing === 'key') };
        }
      }
      if (takeover > 0) models.unshift(...models.splice(takeover, 1));
    }
    first ??= { models, reason };
    for (const m of models) ordered.push(...m.accounts);
  }
  return { ordered, ...first! };
}

/** A candidate's billing and headroom, in the few words the Why line gives it. */
function candidateNote(c: SubagentCandidate): string {
  if (c.poolMember) return `subscription pool, ${c.poolMember} with ${c.quotaUnknown ? 'quota unknown' : `${headroom(c)}% quota left`}`;
  if (c.provider.billing === 'subscription') return c.quotaUnknown ? 'subscription, quota unknown' : `subscription with ${headroom(c)}% quota left`;
  return c.outputPricePerMTok != null ? `key at $${c.outputPricePerMTok}/M output tokens` : 'key, price unknown';
}

const minuteOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

/** The pick as the Why line names it: its model and effort, the provider once, and the engine only when it is another name. */
const pickWhat = (c: SubagentCandidate): string =>
  `${c.model}${c.effort ? ` · ${c.effort}` : ''} on ${c.provider.slug}${c.engine === c.provider.slug ? '' : ` (${c.engine})`}`;

/** A candidate's account in a clause: its billing, and a subscription's headroom and reset. */
function accountWhy(c: SubagentCandidate): string {
  const price = c.outputPricePerMTok != null ? `$${c.outputPricePerMTok} per million output tokens` : 'an unknown price';
  const resets = c.expiresAt !== null ? ` until ${minuteOf(c.expiresAt)}` : '';
  return c.poolMember
    ? `a subscription pool whose account ${c.poolMember} ${c.quotaUnknown ? 'has no quota reading' : `has ${headroom(c)}% of its quota left${resets}`}`
    : c.provider.billing === 'subscription'
      ? (c.quotaUnknown ? 'a subscription whose quota was not read' : `a subscription with ${headroom(c)}% of its quota left${resets}`)
      : `a metered key at ${price}`;
}

/** The pick's Why line when every candidate was ranked together (Cost, and a task run in every mode). */
function pickLine(mode: ModelRoutingOptimizeFor, c: SubagentCandidate): string {
  const why = accountWhy(c);
  const among = c.level ? `tier ${c.level}` : 'the untiered models';
  const lead = mode === 'intelligence' ? `the strongest model in ${among}${c.level ? ` (reaches ${c.ceiling})` : ''}, ${why}`
    : c.provider.billing === 'subscription' ? `${why}, used before any metered key`
      : `the cheapest in ${among}: ${why}`;
  return `Picked ${pickWhat(c)} (${OPTIMIZE_LABEL[mode]}): ${lead}`;
}

/** Which step-2 key put the pick ahead of the next account that can run the same model. */
function accountStep(best: SubagentCandidate, next: SubagentCandidate | undefined): string {
  if (!next) return 'the only account that can run it';
  if (best.suspect !== next.suspect) return `${next.provider.slug} failed to start its last run`;
  if (best.provider.billing !== next.provider.billing) return 'a subscription, used before any metered key';
  if (best.provider.billing === 'key') {
    return marginalPrice(best) < marginalPrice(next) ? 'the cheapest key that runs it' : "first in the owner's provider order";
  }
  if (best.quotaUnknown !== next.quotaUnknown) return `its quota was read, ${next.provider.slug}'s was not`;
  if (best.nearLimit !== next.nearLimit) return `${next.provider.slug} is near its limit`;
  if (expiryOrder(best, next) < 0) return 'its quota resets first';
  if (headroom(best) > headroom(next)) return 'the most quota left';
  return "first in the owner's provider order";
}

/** The pick's Why line in Intelligence and Balance: which model step 1 chose and why, then which account step 2 did. */
function modelFirstLine(mode: ModelRoutingOptimizeFor, models: readonly SubagentModelChoice[], reason: SubagentModelReason): string {
  const [chosen] = models;
  const best = chosen.accounts[0];
  const among = best.level ? `tier ${best.level}` : 'the untiered models';
  const model = {
    only: `the only model in ${among} that can run`,
    preferred: `preferred in ${among}`,
    strongest: `the strongest model in ${among} (reaches ${chosen.ceiling})`,
  } as Record<string, string>;
  const why = reason.kind === 'near-limit'
    ? `takes over ${among} from the preferred ${reason.preferred}, which has ${reason.keysOnly ? 'only metered keys' : 'every account near its limit'}`
    : reason.kind === 'waste'
      ? `takes over ${among} from the preferred ${reason.preferred}: its quota on ${reason.account.provider.slug} resets at ` +
        `${minuteOf(reason.account.expiresAt!)}, within a day, and would otherwise go to waste`
      : model[reason.kind];
  return `Picked ${pickWhat(best)} (${OPTIMIZE_LABEL[mode]}): model ${chosen.model}, ${why}; ` +
    `account ${best.provider.slug}: ${accountStep(best, chosen.accounts[1])}, ${accountWhy(best)}`;
}

/**
 * Why what runs is not in the asked tier, when it is not: for the router's pick, and for a candidate further down
 * that runs because the ones before it could not start (appliedDecision).
 */
export function subagentFitLine(
  asked: ModelRoutingLevel,
  c: { level: ModelRoutingLevel | null; model: string; provider: string; engine: string },
): string | null {
  if (c.level === null) {
    return `Nothing in tier ${asked} or above can run: ${c.model} is the default model of ${c.provider} (${c.engine}), which has no tiers`;
  }
  const away = levelIndex(c.level) - levelIndex(asked);
  if (away > 0) return `Nothing in tier ${asked} can run: the nearest tier above that can is ${c.level}`;
  if (away < 0) return `Nothing in tier ${asked} or above, and no untiered model, can run: the nearest tier below is ${c.level}`;
  return null;
}

/**
 * The account an account pool would run on: of the members that can run — not refused, not paused, under
 * ENGINE_QUOTA_LIMIT — the one with the most quota left, else one whose quota was not read. Otherwise why the
 * pool can't run, in words that name its accounts.
 */
function bestPoolMember(members: readonly SubagentPoolMember[]): { member: SubagentPoolMember } | { reason: string; health?: RoutingHealthEntry } {
  if (members.length === 0) return { reason: 'The pool has no account that can run' };
  // A member health removes is out with the refused and paused ones (§7.1); a suspect one ranks after the rest.
  const live = members.filter((m) => !m.refused && !m.paused && !accountRemoval(m.health));
  const expires = (m: SubagentPoolMember) => m.expiresAt ?? Infinity;
  const suspect = (m: SubagentPoolMember) => Number(healthStanding(m.health).suspect);
  const eligible = live
    .filter((m) => !m.unreadable && (m.quota?.utilization ?? 0) < ENGINE_QUOTA_LIMIT)
    .sort((a, b) => suspect(a) - suspect(b)
      || Number(a.nearLimit === true) - Number(b.nearLimit === true)
      || (expires(a) === expires(b) ? 0 : expires(a) < expires(b) ? -1 : 1)
      || (a.quota?.utilization ?? 0) - (b.quota?.utilization ?? 0));
  if (eligible.length > 0) return { member: eligible[0] };
  const unreadable = [...live].sort((a, b) => suspect(a) - suspect(b)).find((m) => m.unreadable);
  if (unreadable) return { member: unreadable };
  const each = members.map((m) => `${m.label} ${m.refused ? 'refused its key' : m.paused ? 'paused'
    : accountRemoval(m.health) ? 'needs action'
      : `at ${m.quota!.utilization}% of its ${m.quota!.window} quota`}`);
  // Every member out, and health the reason for some: the earliest of their ends is when the pool can run again.
  const removals = members.map((m) => accountRemoval(m.health)).filter((h): h is RoutingHealthEntry => h !== null);
  const health = members.every((m) => m.refused || m.paused || accountRemoval(m.health)) && removals.length > 0
    ? removals.reduce((a, b) => (b.until < a.until ? b : a))
    : undefined;
  return { reason: `No account in the pool can run: ${each.join('; ')}`, ...(health ? { health } : {}) };
}

/** Why a provider is out of every pool (§4.2 filters 1 and 2), or null. */
function providerRefusal(input: SubagentRoutingInput, provider: SubagentProvider): string | null {
  if (input.blockedProviders.includes(provider.slug)) return 'Blocked in the SubAgents settings';
  if (!provider.inScope) return 'A shared provider, which only admins may use';
  return null;
}

/**
 * One engine of a provider against §4.2 filters 3 and 4 on the runner `engines` reports: why it cannot run there,
 * or the quota (and, for a pool, the account) a run there would spend.
 */
type EngineVerdict = { reason: string; health?: RoutingHealthEntry } | {
  quota: ModelRoutingEngineState['quota']; quotaUnknown: boolean; expiresAt: number | null; expiryWindowMins: number | null;
  nearLimit: boolean; opusUtilization: number | null; poolMember?: string;
  /** What account health leaves of the account (§7.1, §7.2). */
  suspect: boolean; trial: RoutingHealthEntry | null; modelHealth: Map<string, RoutingHealthEntry>;
};

function engineVerdict(input: SubagentRoutingInput, provider: SubagentProvider, engine: string): EngineVerdict {
  const where = input.runnerLabel ?? "the parent's runner";
  const report = input.engines?.[engine];
  // A runner that reported nothing is not judged on it; one that reported others lacks this one.
  if (input.engines && !report?.installed) return { reason: `${engine} is not installed on ${where}` };
  // Only Claude Code is gated, and only on a credential that talks to Anthropic: a sign-in, a pool or a key (§8, ⑥).
  if (engine === AgentProvider.CLAUDE && report?.regionBlocked && credentialIsAnthropicBound(provider.credential)) {
    return { reason: `${engine} can’t use Anthropic on ${where}` };
  }
  if (provider.pool) {
    // A pool runs on its members' own credentials, not the runner's sign-in: its best member decides.
    const best = bestPoolMember(provider.pool.members);
    if ('reason' in best) {
      return best.health ? { reason: best.reason, health: best.health } : { reason: best.reason };
    }
    return {
      quota: best.member.quota, quotaUnknown: best.member.unreadable === true,
      expiresAt: best.member.expiresAt ?? null, expiryWindowMins: best.member.expiryWindowMins ?? null,
      nearLimit: best.member.nearLimit === true,
      opusUtilization: best.member.opusUtilization ?? null, poolMember: best.member.label,
      ...healthStanding(best.member.health),
    };
  }
  const quota = provider.account?.quota;
  // What account health says of the account, after the owner's pause and the endpoint's refusal (§7.1): on a
  // subscription and, closing G8, on a metered key.
  const removal = accountRemoval(provider.account?.health);
  const healthOut = removal ? { reason: healthLine(removal, engine), health: removal } : null;
  const standing = healthStanding(provider.account?.health);
  if (provider.billing === 'subscription') {
    // The runner reports on its own sign-in: a subscription key runs on its own token, whatever that says.
    if (report?.signedOut && provider.credential.kind === 'login') return { reason: `${engine} is signed out on ${where}` };
    if (quota && quota.utilization >= ENGINE_QUOTA_LIMIT) {
      return { reason: `The account is at ${quota.utilization}% of its ${quota.window} quota` };
    }
    if (provider.account?.paused) return { reason: 'The account is paused' };
    if (provider.account?.refused) return { reason: "The endpoint refused the account's key" };
    if (healthOut) return healthOut;
    // No reading of its quota (nothing reported for it, or none read at all): it runs, after those whose headroom is known.
    return {
      quota, quotaUnknown: !provider.account || provider.account.unreadable === true,
      expiresAt: provider.account?.expiresAt ?? null, expiryWindowMins: provider.account?.expiryWindowMins ?? null,
      nearLimit: provider.account?.nearLimit === true,
      opusUtilization: provider.account?.opusUtilization ?? null,
      ...standing,
    };
  }
  if (healthOut) return healthOut;
  return { quota, quotaUnknown: false, expiresAt: null, expiryWindowMins: null, nearLimit: false, opusUtilization: null, ...standing };
}

/**
 * Why a provider on one engine cannot run a SubAgent on the runner `engines` reports (§4.2 filters 1 to 4), or null
 * when it can — or when the owner has no such provider, which only building its run can tell. What a remote
 * SubAgent asks of its target workspace's default engine before running on it (§10.3).
 */
export function subagentCandidateRefusal(input: SubagentRoutingInput, providerSlug: string, engine: string): string | null {
  const provider = input.providers.find((entry) => entry.slug === providerSlug);
  if (!provider) return null;
  const refused = providerRefusal(input, provider);
  if (refused) return refused;
  const verdict = engineVerdict(input, provider, engine);
  return 'reason' in verdict ? verdict.reason : null;
}

/** Whether a provider's engine lists a model: its own model space, else the runner-reported catalogue. */
function offersModel(input: SubagentRoutingInput, engine: SubagentProviderEngine, model: string): boolean {
  return engine.models
    ? engine.models.some((entry) => entry.model === model)
    : (input.modelCatalog?.[engine.engine as AgentProvider] ?? []).some((entry) => entry.value === model);
}

/** One provider × engine as the runner `engines` reports on stands toward it (§4.2 filters 1 to 4). */
export interface SubagentPairVerdict {
  provider: string;
  engine: string;
  /** Why it cannot run there; absent when it can. */
  reason?: string;
  /** Every model it lists, tier or no tier: its own model space, else the runner-reported catalogue. */
  models: string[];
}

/**
 * Every provider × engine of `input`, in the owner's order, with why it cannot run on the runner `engines` reports
 * (§4.2 filters 1 to 4, through providerRefusal and engineVerdict) and the models it lists. What
 * subagentRunnableModels keeps the usable ones of, and what provider_list's workspace view shows whole.
 */
export function subagentPairVerdicts(input: SubagentRoutingInput): SubagentPairVerdict[] {
  const out: SubagentPairVerdict[] = [];
  for (const provider of input.providers) {
    const refused = providerRefusal(input, provider);
    for (const engine of provider.engines) {
      const verdict = refused ? { reason: refused } : engineVerdict(input, provider, engine.engine);
      const models = engine.models
        ? engine.models.map((entry) => entry.model)
        : (input.modelCatalog?.[engine.engine as AgentProvider] ?? []).map((entry) => entry.value);
      out.push({
        provider: provider.slug,
        engine: engine.engine,
        ...('reason' in verdict ? { reason: verdict.reason } : {}),
        models: [...new Set(models)],
      });
    }
  }
  return out;
}

/**
 * What the runner `engines` reports on can run, by provider and engine: every model each usable provider × engine
 * lists (§4.2 filters 1 to 4; tiers do not matter, since a named model needs none). What a refused named model on
 * a remote SubAgent lists (§10.3).
 */
export function subagentRunnableModels(input: SubagentRoutingInput): Array<{ provider: string; engine: string; models: string[] }> {
  return subagentPairVerdicts(input)
    .filter((pair) => pair.reason === undefined && pair.models.length > 0)
    .map(({ provider, engine, models }) => ({ provider, engine, models }));
}

/**
 * Route one SubAgent (docs/subagent-design.md §4.1, §4.2). Pure: no I/O, every decision depends only on
 * the snapshot passed in. The tier is the first of: the caller's model, the definition's model or
 * `inherit` (neither routed), the caller's size, the definition's size, the type's default — which alone
 * Optimize For raises. The pool is every provider × engine × tier row, less what the owner blocked, what is
 * out of scope, engines the parent's runner lacks or cannot sign in to, accounts at ENGINE_QUOTA_LIMIT or
 * paused, and models without a tier; each removal is recorded with its reason.
 */
export function routeSubagent(input: SubagentRoutingInput): SubagentRoutingDecision {
  const mode = input.optimizeFor;
  const base = {
    optimizeFor: mode, candidates: [] as SubagentRemovedCandidate[], fallbacks: [] as SubagentFallback[],
    policyVersion: SUBAGENT_ROUTING_POLICY_VERSION,
  };
  const parentPick = { engine: input.parent.engine, provider: input.parent.provider, model: input.parent.model, effort: input.parent.effort };

  // Rows 1 and 2: a named model is used as named, at its engine's default effort, on every provider × engine that
  // lists it and can run on this runner (§4.2 filters 1 to 4), in the owner's order: the first is the pick, the
  // rest its fallbacks; never another model.
  const offersOf = (model: string) => {
    const removed: SubagentRemovedCandidate[] = [];
    const offers: SubagentFallback[] = [];
    for (const provider of input.providers) {
      const listing = provider.engines.filter((engine) => offersModel(input, engine, model));
      if (listing.length === 0) continue;
      const refused = providerRefusal(input, provider);
      if (refused) {
        removed.push({ provider: provider.slug, engine: null, model, effort: null, reason: refused });
        continue;
      }
      for (const engine of listing) {
        const verdict = engineVerdict(input, provider, engine.engine);
        const modelOut = 'reason' in verdict ? undefined : verdict.modelHealth.get(model);
        if ('reason' in verdict) {
          removed.push({ provider: provider.slug, engine: engine.engine, model, effort: null, reason: verdict.reason,
            ...(verdict.health ? { health: verdict.health } : {}) });
        } else if (modelOut) {
          removed.push({ provider: provider.slug, engine: engine.engine, model, effort: null, reason: healthLine(modelOut, engine.engine), health: modelOut });
        } else {
          offers.push({ engine: engine.engine, provider: provider.slug, model, effort: null, ...(verdict.trial ? { trial: verdict.trial } : {}) });
        }
      }
    }
    return { removed, offers };
  };
  const { caller, definition } = input;
  if (caller.model) {
    const model = caller.model;
    const { removed, offers } = offersOf(model);
    const [pick, ...rest] = offers;
    const where = input.runnerLabel ?? "the parent's runner";
    // Nobody lists it at all: off the remote path, the parent's own provider runs it as named, as it always has.
    if (!pick && removed.length === 0 && !input.strictNamedModel) {
      return {
        ...base, level: null, tierSource: 'named-model', tierNote: 'Model named by the caller', ...parentPick, model,
        reasons: [`Model named by the caller: ${model}`,
          `No enabled provider lists ${model} — kept on the parent's ${input.parent.provider} (${input.parent.engine})`],
      };
    }
    return {
      ...base, level: null, tierSource: 'named-model', tierNote: 'Model named by the caller', candidates: removed,
      ...(pick ?? { engine: null, provider: null, model: null, effort: null }),
      fallbacks: rest,
      reasons: [
        `Model named by the caller: ${model}`,
        ...(pick ? [] : [`No usable provider on ${where} offers ${model}`]),
      ],
    };
  }
  const definitionModel = definition.model?.trim() || null;
  const autoNotes: string[] = [];
  if (definitionModel === 'inherit') {
    return { ...base, level: null, tierSource: 'definition-model', tierNote: `Model set by ${input.definitionName}: inherit`, ...parentPick,
      reasons: [`Model set by ${input.definitionName}: inherit, the parent's ${input.parent.model}`] };
  }
  if (definitionModel && definitionModel !== 'auto') {
    const { removed, offers } = offersOf(definitionModel);
    const [found, ...rest] = offers;
    if (found) {
      return { ...base, level: null, tierSource: 'definition-model', tierNote: `Model set by ${input.definitionName}`, ...found,
        candidates: removed, fallbacks: rest, reasons: [`Model set by ${input.definitionName}: ${definitionModel}`] };
    }
    autoNotes.push(removed.length > 0
      ? `${input.definitionName} names ${definitionModel}, which no usable provider can run — routed as auto`
      : `${input.definitionName} names ${definitionModel}, which no enabled provider lists — routed as auto`);
  }
  if (input.smartSelection === false) {
    return { ...base, level: null, tierSource: 'not-routed', tierNote: 'Route by tier is off', ...parentPick,
      reasons: [...autoNotes, `Route by tier is off: runs on the parent's ${input.parent.model}`] };
  }

  // Rows 3 to 5: the tier.
  let level: ModelRoutingLevel;
  let tierSource: SubagentTierSource;
  let tierNote: string;
  const reasons: string[] = [...autoNotes];
  if (caller.size) {
    level = caller.size;
    tierSource = 'size';
    tierNote = `Tier ${level}, set by the caller`;
    reasons.push(`${tierNote}${caller.sizeReason ? `: ${caller.sizeReason}` : ''}`);
  } else if (definition.size) {
    level = definition.size;
    tierSource = 'definition-size';
    tierNote = `Tier ${level}, set by ${input.definitionName}`;
    reasons.push(tierNote);
  } else {
    level = input.type === 'explore' ? 'S' : 'M';
    tierSource = 'type-default';
    tierNote = `Tier ${level}: default for ${input.type}`;
    reasons.push(tierNote);
    const floor = mode === 'balance' ? 'M' : mode === 'intelligence' ? 'L' : null;
    if (floor && levelIndex(level) < levelIndex(floor)) {
      level = floor;
      tierNote = `Tier ${floor}: ${OPTIMIZE_LABEL[mode]} minimum`;
      reasons.push(`Tier ${floor}: ${OPTIMIZE_LABEL[mode]} minimum for a SubAgent without a size`);
    }
  }

  // The pool (§4.2): every provider × engine that can run, each removal with its reason. Every tier joins; the
  // asked one comes first, then the tiers above it, then each untiered engine's default model, then the tiers below.
  const removed: SubagentRemovedCandidate[] = [];
  const drop = (provider: string, engine: string | null, model: string | null, effort: string | null, reason: string,
    health?: RoutingHealthEntry) => removed.push({ provider, engine, model, effort, reason, ...(health ? { health } : {}) });
  const pool: SubagentCandidate[] = [];
  input.providers.forEach((provider, providerIndex) => {
    const slug = provider.slug;
    const refused = providerRefusal(input, provider);
    if (refused) return drop(slug, null, null, null, refused);
    provider.engines.forEach((spec, engineIndex) => {
      const { engine } = spec;
      const verdict = engineVerdict(input, provider, engine);
      if ('reason' in verdict) return drop(slug, engine, null, null, verdict.reason, verdict.health);
      const { quota, quotaUnknown, expiresAt, expiryWindowMins, nearLimit, opusUtilization, poolMember, suspect, trial, modelHealth } = verdict;
      // Opus has a weekly window of its own on a Claude account: at the limit, Opus is not run there; Sonnet still is.
      const opusOut = (row: SubagentModelRow) => engine === AgentProvider.CLAUDE && row.model.startsWith('claude-opus-')
        && opusUtilization !== null && opusUtilization >= ENGINE_QUOTA_LIMIT;
      const opusReason = `Opus's weekly quota is at ${opusUtilization}% on this account`;
      const rows = subagentEngineRows(spec, input);
      // Where a row's tier came from (step 1, §4.2): the owner's, a rule's or a preset's, or the engine's table.
      const origin = (row: SubagentModelRow): SubagentTierOrigin => {
        if (spec.models) return row.source === 'owner' ? 'owner' : 'rule';
        if (row.level && input.builtinModelTiers?.[engine]?.[row.model] === row.level) return 'owner';
        return TABLE_ENGINES.includes(engine) ? 'table' : 'rule';
      };
      const join = (row: SubagentModelRow, ceiling: ModelRoutingLevel, fit: SubagentFit, distance: number) => pool.push({
        ...row, provider, providerIndex, engine, engineIndex, rowIndex: Math.max(rows.indexOf(row), 0), origin: origin(row),
        ceiling, quota, quotaUnknown, expiresAt, expiryWindowMins, nearLimit, ...(poolMember ? { poolMember } : {}), fit, distance,
        suspect, trial,
      });
      // A model's own health entry removes that model's rows only, as the Opus window does; the rest of the account
      // stays (§7.1). On an engine whose tiers are one model at several efforts, that is every tier of the account.
      const modelOut = (row: SubagentModelRow) => modelHealth.get(row.model);
      if (!rows.some((row) => row.level)) {
        // No tiers at all: its default model runs, untiered; the rest of what it lists is reachable by name.
        // A list of the provider's own is its model space, even empty; only an engine on its catalogue reads the runner's.
        const listed = rows.length > 0 || spec.models ? rows : (input.modelCatalog?.[engine as AgentProvider] ?? [])
          .map((row) => ({ model: row.value, effort: null, level: null, outputPricePerMTok: spec.prices?.[row.value] ?? null }));
        if (listed.length === 0) return drop(slug, engine, null, null, `No models listed for ${engine}`);
        // The runner's default for the engine, else the provider's own, each only if it is listed; else the first listed.
        const listedAs = (model: string | null | undefined) => (model ? listed.find((row) => row.model === model) : undefined);
        const chosen = listedAs(input.runtimeDefaultModels?.[engine as AgentProvider]) ?? listedAs(spec.defaultModel) ?? listed[0];
        const out = modelOut(chosen);
        if (out) drop(slug, engine, chosen.model, chosen.effort, healthLine(out, engine), out);
        else join(chosen, level, 'untiered', 0);
        for (const row of listed) if (row !== chosen) drop(slug, engine, row.model, row.effort, `The model has no tier; ${slug} runs ${chosen.model}`);
        return;
      }
      const ceilings = new Map<string, ModelRoutingLevel>();
      for (const row of rows) {
        if (!row.level) continue;
        const prior = ceilings.get(row.model);
        if (!prior || levelIndex(row.level) > levelIndex(prior)) ceilings.set(row.model, row.level);
      }
      for (const row of rows) {
        if (!row.level) {
          drop(slug, engine, row.model, row.effort, 'The model has no tier');
          continue;
        }
        if (opusOut(row)) {
          drop(slug, engine, row.model, row.effort, opusReason);
          continue;
        }
        const out = modelOut(row);
        if (out) {
          drop(slug, engine, row.model, row.effort, healthLine(out, engine), out);
          continue;
        }
        const away = levelIndex(row.level) - levelIndex(level);
        join(row, ceilings.get(row.model)!, away === 0 ? 'exact' : away > 0 ? 'higher' : 'lower', Math.abs(away));
      }
    });
  });

  const decision = { ...base, level, tierSource, tierNote, candidates: removed };
  if (pool.length === 0) {
    return { ...decision, engine: null, provider: null, model: null, effort: null,
      reasons: [...reasons, 'No provider can run a SubAgent: the SubAgent is refused with NO_SUBAGENT_PROVIDER'] };
  }
  // Cost, and a task run in every mode, rank every candidate together; Intelligence and Balance choose the model, then
  // the account (§4.2, owner 2026-11-22).
  const together = mode === 'cost' || input.rankTogether === true;
  const twoStep = together ? null : modelFirstOrder(mode as 'balance' | 'intelligence', pool, input.now);
  const [best, ...rest] = twoStep ? twoStep.ordered : [...pool].sort((a, b) => compareTogether(mode, a, b));
  const away = subagentFitLine(level, { level: best.level, model: best.model, provider: best.provider.slug, engine: best.engine });
  if (away) reasons.push(away);
  reasons.push(twoStep ? modelFirstLine(mode, twoStep.models, twoStep.reason) : pickLine(mode, best));
  // An account whose block ran out ranks as healthy so that its trial happens (§7.2): the run says it is that trial.
  if (best.trial) reasons.push(`Trying ${best.provider.slug} again: it last refused a run at ${minuteOf(best.trial.last)}`);
  const priceless = new Set(pool
    .filter((c) => best.provider.billing === 'key' && c.fit === best.fit && c.provider.billing === 'key' && c.outputPricePerMTok == null)
    .map((c) => `No price known for ${c.model} on ${c.provider.slug}; ordered after priced keys`));
  reasons.push(...priceless);
  const exact = pool.filter((c) => c.fit === 'exact').length;
  if (pool.length > 1) {
    const others = pool.length - exact;
    reasons.push(`${exact} candidate${exact === 1 ? '' : 's'} in tier ${level}${others ? `, ${others} more in other tiers or untiered` : ''}; ties go by the owner's provider order`);
  }
  if (removed.length > 0) reasons.push(`${removed.length} candidate${removed.length === 1 ? '' : 's'} removed, each with its reason`);
  const fallbacks = rest.map((c) => ({
    engine: c.engine, provider: c.provider.slug, model: c.model, effort: c.effort, note: candidateNote(c), level: c.level,
    ...(c.trial ? { trial: c.trial } : {}), ...(c.suspect ? { suspect: true } : {}),
  }));
  return {
    ...decision, engine: best.engine, provider: best.provider.slug, model: best.model, effort: best.effort,
    note: candidateNote(best), pickLevel: best.level, reasons, fallbacks,
    ...(best.trial ? { trial: best.trial } : {}), ...(best.suspect ? { suspect: true } : {}),
  };
}
