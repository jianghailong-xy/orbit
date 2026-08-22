import { createHash } from 'node:crypto';

import { canonicalJson } from './project-blocker';
import { AttemptBudget, ConvergenceClassification } from './convergence-contract';

/**
 * `[K3]`: what ONE attempt is, what it may spend, and how it stops.
 *
 * The normative source is `docs/project-coordinator-attempt-budget.md`, checked table-by-table by
 * `attempt-budget.spec.ts` exactly as `[K1]`'s contract is. Nothing here reads a clock, a database
 * or a session: `now` and the measured spend arrive as arguments, because a budget decision is
 * replayed byte-for-byte and one that read `Date.now()` would let two replays of one world disagree
 * about whether an attempt was asked to stop.
 *
 * The sentence the unit exists for (§0): the incident's hundreds of rounds never crossed an attempt
 * line because they were never hundreds of attempts — they were ONE session steered hundreds of
 * times. A session that never ends is the blind spot every budget shares: it adds no attempt, mints
 * no new fingerprint, and looks busy the whole way. So the first thing `[K3]` fixes is not a limit,
 * it is an IDENTITY — one attempt is one Session under one Task scope revision (AT1).
 */

/** §1's six dimensions. The array order IS BD1's evaluation order; see `evaluateAttemptBudget`. */
export type AttemptBudgetDimension =
  | 'CONTEXT'
  | 'WALL_CLOCK'
  | 'TURNS'
  | 'TOOL_CALLS'
  | 'COST'
  | 'COORDINATOR_STEERS';

/**
 * BD1/BD2: fixed, and not arbitrary.
 *
 * `CONTEXT` leads because it is the one dimension whose exhaustion destroys the ability to COMPLY
 * with TH2 — an attempt out of context cannot write a credible checkpoint, so a budget that let it
 * get there would have bought nothing. `WALL_CLOCK` next, because that is the one holding a runner
 * slot. Then the three pure-spend dimensions. `COORDINATOR_STEERS` last because it bounds the
 * COORDINATOR rather than the worker: its exhaustion must not stop a worker that is already
 * finishing.
 */
export const ATTEMPT_BUDGET_DIMENSIONS: readonly AttemptBudgetDimension[] = [
  'CONTEXT',
  'WALL_CLOCK',
  'TURNS',
  'TOOL_CALLS',
  'COST',
  'COORDINATOR_STEERS',
];

/** Which budget field bounds each dimension. §1's table, as a lookup. */
export const ATTEMPT_BUDGET_LIMIT: Readonly<
  Record<AttemptBudgetDimension, keyof AttemptBudget>
> = {
  CONTEXT: 'maxContextPercent',
  WALL_CLOCK: 'maxWallClockMs',
  TURNS: 'maxTurns',
  TOOL_CALLS: 'maxToolCalls',
  COST: 'maxCostMicros',
  COORDINATOR_STEERS: 'maxCoordinatorSteers',
};

/**
 * What an attempt has actually spent, as measured from its session.
 *
 * `contextWindow` is nullable because the runner REPORTS it rather than the control plane looking
 * it up, and it is absent until the first turn reports one. BD3 turns that into `UNMEASURED` rather
 * than into a zero or an infinity — see `readDimension`.
 */
export interface AttemptSpend {
  turns: number;
  wallClockMs: number;
  toolCalls: number;
  costMicros: number;
  contextTokens: number | null;
  contextWindow: number | null;
  coordinatorSteers: number;
}

export const ZERO_ATTEMPT_SPEND: Readonly<AttemptSpend> = {
  turns: 0,
  wallClockMs: 0,
  toolCalls: 0,
  costMicros: 0,
  contextTokens: null,
  contextWindow: null,
  coordinatorSteers: 0,
};

/** BD3's four readings. `UNMEASURED` is one of them and is not optional. */
export type AttemptDimensionState = 'WITHIN' | 'EXHAUSTED' | 'UNBOUNDED' | 'UNMEASURED';

export interface AttemptDimensionReading {
  dimension: AttemptBudgetDimension;
  state: AttemptDimensionState;
  /** The limit that applied, `null` when unbounded. */
  limit: number | null;
  /** What has been spent, `null` when the dimension could not be measured. */
  spent: number | null;
  /** BD4: readable, not re-derivable. `null` when unbounded or unmeasured. */
  remaining: number | null;
}

export interface AttemptBudgetReport {
  readings: readonly AttemptDimensionReading[];
  /** The FIRST dimension over its line in BD1 order, or null. Determinate by construction. */
  exhausted: AttemptBudgetDimension | null;
  /** Whether the worker must be asked to wind down (§2 NC1). Steers alone do not ask it to. */
  windDownRequired: boolean;
}

/**
 * §1's whole answer, as a pure function of a FROZEN budget and a measured spend.
 *
 * The budget is the one frozen at open (BD5) rather than the project's current policy, and that is
 * load-bearing rather than an optimisation: a policy edit mid-flight that could end a running
 * attempt — or revive one already asked to stop — is a result being overwritten by another result,
 * which is the exact thing TH2 refuses.
 */
export function evaluateAttemptBudget(
  budget: AttemptBudget,
  spent: AttemptSpend,
): AttemptBudgetReport {
  const readings = ATTEMPT_BUDGET_DIMENSIONS.map((dimension) =>
    readDimension(dimension, budget, spent));
  const exhausted = readings.find((reading) => reading.state === 'EXHAUSTED')?.dimension ?? null;
  return {
    readings,
    exhausted,
    // BD2: a coordinator out of steers is not a reason to stop a worker mid-sentence. It is a
    // reason to refuse the coordinator's next steer, which `authorizeSteer` does.
    windDownRequired: exhausted !== null && exhausted !== 'COORDINATOR_STEERS',
  };
}

function readDimension(
  dimension: AttemptBudgetDimension,
  budget: AttemptBudget,
  spent: AttemptSpend,
): AttemptDimensionReading {
  const limit = budget[ATTEMPT_BUDGET_LIMIT[dimension]];
  const measured = measure(dimension, spent);
  if (measured === null) {
    return { dimension, state: 'UNMEASURED', limit, spent: null, remaining: null };
  }
  if (limit === null) {
    return { dimension, state: 'UNBOUNDED', limit: null, spent: measured, remaining: null };
  }
  const remaining = Math.max(0, limit - measured);
  return {
    dimension,
    state: measured >= limit ? 'EXHAUSTED' : 'WITHIN',
    limit,
    spent: measured,
    remaining,
  };
}

/** §1's "花费从哪读" column. `null` is BD3's unmeasured, and only `CONTEXT` can produce one. */
function measure(dimension: AttemptBudgetDimension, spent: AttemptSpend): number | null {
  switch (dimension) {
    case 'CONTEXT':
      // Both halves have to be there AND the window has to be positive: a zero window would make
      // the percentage a division by zero, which reads as Infinity — an attempt declared exhausted
      // the instant it starts, for a reason that is a missing measurement rather than a spend.
      if (spent.contextTokens === null || !spent.contextWindow) return null;
      return (spent.contextTokens / spent.contextWindow) * 100;
    case 'WALL_CLOCK':
      return spent.wallClockMs;
    case 'TURNS':
      return spent.turns;
    case 'TOOL_CALLS':
      return spent.toolCalls;
    case 'COST':
      return spent.costMicros;
    case 'COORDINATOR_STEERS':
      return spent.coordinatorSteers;
  }
}

/** §2 NC2's four real outcomes. `CANCELLED` is absent on purpose and the DB refuses it too. */
export type AttemptOutcome = 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'BLOCKED';

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
  'BLOCKED',
];

/** §2's lifecycle. `WINDING_DOWN` exists so that "was asked to stop" is a fact, not an intention. */
export type AttemptStatus = 'OPEN' | 'WINDING_DOWN' | 'CLOSED';

/** §2 NC5: the pointer half of §7's checkpoint. The table and the merge gate are `[K6]`. */
export interface AttemptCheckpoint {
  sha: string;
  kind: 'ACCEPTED' | 'WIP_RED';
  evidenceDigest: string | null;
}

export type AttemptCloseRefusal =
  /** §2 NC3: a success with nothing to show, or a wind-down that recorded neither. */
  | 'ATTEMPT_CHECKPOINT_REQUIRED'
  /** §2 NC4: a closed attempt is history, not a conclusion still open for discussion. */
  | 'ATTEMPT_OUTCOME_IMMUTABLE';

export interface AttemptClose {
  outcome: AttemptOutcome;
  checkpoint: AttemptCheckpoint | null;
  /** NC3's "if there is none, say there is none". A crash HAS none — that is the honest answer. */
  noCheckpointReason: string | null;
  /** §3's class of the failure this attempt ended on, when it ended on one. Gates GN2's exemption. */
  classification: ConvergenceClassification | null;
}

export interface PlannedAttemptClose extends AttemptClose {
  /** The `ACCEPTED` sha to write back to `task.known_good_sha`, or null (NC5). */
  knownGoodSha: string | null;
}

/**
 * §2 NC3/NC4, decided before anything is written.
 *
 * The two requirements are deliberately asymmetric. A `SUCCEEDED` attempt owes an `ACCEPTED`
 * checkpoint unconditionally, because a success nobody can point at is the thing this whole unit
 * was written after. An attempt that was ASKED to stop owes either a checkpoint or a sentence
 * saying why there is none — and "the runner crashed" is a perfectly good sentence. Demanding a
 * checkpoint there would only teach the next writer to invent one, and the next generation would
 * then resume from a known-good point that does not exist.
 */
export function planAttemptClose(
  status: AttemptStatus,
  windDownRequested: boolean,
  close: AttemptClose,
): PlannedAttemptClose | AttemptCloseRefusal {
  if (status === 'CLOSED') return 'ATTEMPT_OUTCOME_IMMUTABLE';
  if (close.outcome === 'SUCCEEDED' && close.checkpoint?.kind !== 'ACCEPTED') {
    return 'ATTEMPT_CHECKPOINT_REQUIRED';
  }
  if (windDownRequested && !close.checkpoint && !nonEmpty(close.noCheckpointReason)) {
    return 'ATTEMPT_CHECKPOINT_REQUIRED';
  }
  return {
    ...close,
    knownGoodSha: close.checkpoint?.kind === 'ACCEPTED' ? close.checkpoint.sha : null,
  };
}

/** §3's actors, as the lifecycle sees them. The API knows exactly these three. */
export type SessionLifecycleActor =
  | { kind: 'USER' }
  /** An agent session acting through the orchestration API, identified by its own session id. */
  | { kind: 'AGENT_SESSION'; sessionId: string };

export type AttemptLifecycleRefusal =
  | 'ATTEMPT_OUTCOME_IS_THE_WORKERS'
  | 'ATTEMPT_STEER_BUDGET_EXHAUSTED'
  | 'ATTEMPT_WINDING_DOWN';

/**
 * §3's first row: who may end, complete or cancel the session an attempt is running in.
 *
 * The USER column is `ALLOWED` throughout, and that is the point rather than an oversight — this
 * unit bounds an autonomous loop, not a person. What it refuses is the incident's most expensive
 * single action: a coordinator that sees a run it dislikes and calls `session complete` on it. That
 * is not a close, it is a result with no ending written over a result that had one — the session
 * lands as `CANCELLED`, "what actually failed here" stops having an answer, and the next round
 * starts from scratch because nothing survived that says otherwise.
 */
export function authorizeAttemptLifecycle(
  actor: SessionLifecycleActor,
  attempt: { sessionId: string; status: AttemptStatus },
): 'ALLOWED' | AttemptLifecycleRefusal {
  if (attempt.status === 'CLOSED') return 'ALLOWED';
  if (actor.kind === 'USER') return 'ALLOWED';
  if (actor.sessionId === attempt.sessionId) return 'ALLOWED';
  return 'ATTEMPT_OUTCOME_IS_THE_WORKERS';
}

/**
 * §3's second row (AU3): steering a live attempt, bounded.
 *
 * "Keep going" produces no attempt, no fingerprint and no progress, yet produces activity without
 * limit — which is why every liveness check stayed green through the incident. The bound makes the
 * only unbounded verb finite, and the legal next step once it is spent is §4's new generation.
 */
export function authorizeSteer(
  actor: SessionLifecycleActor,
  attempt: { sessionId: string; status: AttemptStatus },
  budget: AttemptBudget,
  spent: Pick<AttemptSpend, 'coordinatorSteers'>,
): 'ALLOWED' | AttemptLifecycleRefusal {
  if (attempt.status === 'CLOSED') return 'ALLOWED';
  if (actor.kind === 'USER' || actor.sessionId === attempt.sessionId) return 'ALLOWED';
  // A worker on its way out is writing the checkpoint TH2 asked it for. Another turn injected here
  // is the coordinator overwriting the outcome by a slower route.
  if (attempt.status === 'WINDING_DOWN') return 'ATTEMPT_WINDING_DOWN';
  const limit = budget.maxCoordinatorSteers;
  if (limit !== null && spent.coordinatorSteers >= limit) return 'ATTEMPT_STEER_BUDGET_EXHAUSTED';
  return 'ALLOWED';
}

/**
 * §5's seed: everything a fresh generation inherits, and NOTHING else.
 *
 * A closed record rather than an assembled prompt, so that "did the context stay bounded" is a
 * question a test can answer instead of one a reader has to eyeball (SD2). Adding
 * `previousTranscript` here turns `attempt-budget.spec.ts` red, which is the entire design.
 */
export interface AttemptSeed {
  taskId: string;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  hypothesis: string;
  /** SD1: the known-good COMMIT, not the previous session. Evidence carries; context does not. */
  inheritedKnownGoodSha: string | null;
  previousOutcome: {
    attemptGeneration: number;
    outcome: AttemptOutcome;
    exhaustedDimension: AttemptBudgetDimension | null;
    classification: ConvergenceClassification | null;
  } | null;
}

export const ATTEMPT_SEED_FIELDS: readonly (keyof AttemptSeed)[] = [
  'taskId',
  'scopeRevision',
  'scopeHash',
  'attemptGeneration',
  'hypothesis',
  'inheritedKnownGoodSha',
  'previousOutcome',
];

export interface PreviousAttempt {
  attemptGeneration: number;
  hypothesisDigest: string;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  exhaustedDimension: AttemptBudgetDimension | null;
  classification: ConvergenceClassification | null;
}

export function buildAttemptSeed(
  task: { taskId: string; scopeRevision: number; scopeHash: string; knownGoodSha: string | null },
  attemptGeneration: number,
  hypothesis: string,
  previous: PreviousAttempt | null,
): AttemptSeed {
  return {
    taskId: task.taskId,
    scopeRevision: task.scopeRevision,
    scopeHash: task.scopeHash,
    attemptGeneration,
    hypothesis,
    inheritedKnownGoodSha: task.knownGoodSha,
    previousOutcome: previous?.outcome
      ? {
        attemptGeneration: previous.attemptGeneration,
        outcome: previous.outcome,
        exhaustedDimension: previous.exhaustedDimension,
        classification: previous.classification,
      }
      : null,
  };
}

export type AttemptOpenRefusal =
  | 'ATTEMPT_ALREADY_OPEN'
  | 'ATTEMPT_GENERATION_IN_USE'
  | 'ATTEMPT_HYPOTHESIS_UNCHANGED'
  | 'ATTEMPT_HYPOTHESIS_MISSING';

/**
 * §4's gate, as a pure decision over the committed previous attempt.
 *
 * AT3 is the rule with teeth: the same hypothesis is not tried twice on one scope revision. The
 * exemption for a `TRANSIENT` close is not a hole — §3 CL2 already forces a chronically transient
 * failure to be RE-CLASSIFIED after `maxTransientRetries`, so the exemption is itself bounded, and
 * without it a network blip would cost a re-plan (GN2).
 */
export function authorizeFreshAttempt(
  hypothesis: string,
  previous: PreviousAttempt | null,
): 'ALLOWED' | AttemptOpenRefusal {
  if (!nonEmpty(hypothesis)) return 'ATTEMPT_HYPOTHESIS_MISSING';
  if (!previous) return 'ALLOWED';
  if (previous.status !== 'CLOSED') return 'ATTEMPT_ALREADY_OPEN';
  if (previous.hypothesisDigest !== hypothesisDigest(hypothesis)) return 'ALLOWED';
  return previous.classification === 'TRANSIENT' ? 'ALLOWED' : 'ATTEMPT_HYPOTHESIS_UNCHANGED';
}

/** The identity of a hypothesis: normalized so that reformatting one is not proposing a new one. */
export function hypothesisDigest(hypothesis: string): string {
  return sha256(canonicalJson({ h: hypothesis.trim().replace(/\s+/g, ' ').toLowerCase() }));
}

/**
 * GN1: the durable identity of THIS dispatch, spelled the way `[K2]` §3 spells an observation key.
 *
 * The caller supplies `attemptKey`; a `randomUUID()` here would mean a replay after a crash opens a
 * SECOND generation instead of reading back its own row — the same mistake, in the same place, as
 * hashing a snapshot for an idempotency key.
 */
export function attemptObservationKey(attemptKey: string): string {
  return `attempt:${attemptKey}`;
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
