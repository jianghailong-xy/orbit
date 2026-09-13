import { createHash } from 'node:crypto';

import { successorChain } from '../tasks/task-supersession';
import { canonicalJson } from './canonical-json';
import {
  ConvergenceCounters,
  ConvergenceThresholds,
  CoordinatorSpendLimits,
  ZERO_COUNTERS,
} from './convergence-contract';
import { DerivedProgress, EvidenceFreshness, evidenceSupportsProgress } from './convergence-evidence';
import {
  EMPTY_PROGRESS_VECTOR,
  ProgressVector,
  progressVectorDigest,
  strictlyImproves,
} from './convergence-progress';
import { CoordinatorWakeEvent } from './coordinator-wake';

/**
 * `[T4]`: the ledger a coordinator wake is recorded in, and the fuse on what the coordinator spends
 * on its own.
 *
 * §0 — THERE IS ONE DEFINITION OF PROGRESS AND IT IS NOT HERE
 * ===========================================================
 * `convergence-contract.ts` §0 froze it: **progress is strict improvement toward acceptance, not
 * activity**. Nothing in this module re-decides that. `strictlyImproves` answers "did this move" and
 * `deriveProgressVector` answers "what was measured" — both are imported, neither is reimplemented,
 * and a second opinion about either would be the exact defect this unit exists to prevent.
 *
 * §1 — A WAKE IS RECORDED, AND NOTHING IS CHARGED FOR IT
 * ======================================================
 * This ledger used to be a breaker. Every wake charged `decisionsWithoutProgress`, past
 * `maxDecisionsWithoutProgress` the project was stopped, and every later fact was refused with
 * `PROJECT_NOT_CONVERGING`. It counted the wrong thing. A wake is a fact that happened TO the
 * coordinator — an attempt ended, a criterion's work finished, a merge is owed — and the vector it
 * was compared against moves only when a blocker closes, so a project with nothing to fix spent its
 * budget on its own progress reports and had its seventh fact refused, recorded-only facts
 * included. This deployment made 155 judgments that way, and one of them was progress.
 *
 * So a wake is still judged, for the record, and always allowed. Its row keeps the pair of vectors
 * and whether the step strictly improved on the last one; it charges no counter, stops nothing and
 * raises no blocker. `COORDINATOR_NO_PROGRESS` rows raised before stay what they were, and the
 * measurement still leaves them out of the vector (`noProgressDedupeKey`).
 *
 * §2 — PURE
 * =========
 * No clock, no database, no session, for the reason every other `convergence-*` module is pure:
 * these decisions are replayed from committed rows, and one that read `Date.now()` would make two
 * replays of one world disagree. The fuse below takes the start of its window as an argument for
 * the same reason.
 *
 * §3 — THE FUSE COUNTS WHAT THE AGENT SPENDS ON ITS OWN
 * =====================================================
 * What bounds a coordinator is its autonomous spend, in three kinds, each counted from committed
 * rows over the 24 hours before the reading (`COORDINATOR_SPEND_WINDOW_MS`):
 *
 *   - SELF-STARTED TURNS — turns of the project's standing coordinator conversation that nobody
 *     delivered. A turn Orbit delivers (the owner's message, another session's, a fact handed to the
 *     conversation) is a `conversation_turn`, and the runner files its events under that turn; a
 *     turn the engine starts by itself (a scheduled wake-up, a Monitor or background-task
 *     notification) has no such row, so its `turn_end` is filed under none.
 *   - SESSIONS OPENED — `task_start` and `session_create` calls that conversation made through
 *     Orbit's tools and got an answer to that was not an error. The call is counted rather than the
 *     session because only the call records who asked: a run `task_start` opens carries no link back
 *     to the session that started it.
 *   - RETRIES ON ONE SUCCESSOR CHAIN — in a chain of the project's tasks linked by
 *     `superseded_by_task_id`, the replacements an agent filed; the fuse reads the longest chain
 *     whose newest link was made in the window. A replacement a person filed is theirs, not the
 *     agent's, and a chain nobody has extended within the window is a loop that has stopped.
 *
 * The coordinator is paused when any one kind EXCEEDS its limit (`CoordinatorSpendLimits`, defaults
 * in `convergence-contract.ts`); reaching a limit is not exceeding it. Facts delivered to it or
 * recorded about its project are not spend. This module decides the pause and nothing else: what a
 * paused coordinator may still do is not decided here.
 */

/**
 * What a judgment concluded. `STOP` is what the retired breaker wrote (§1): a wake judged now is
 * always `PROCEED`, and `STOP` remains only so a row written before can be read back.
 */
export type WakeConvergenceOutcome = 'PROCEED' | 'STOP';

/**
 * The project's committed convergence state, as read from the ledger.
 *
 * Every field is the last committed row's, never a value held in a process, so the pair of vectors a
 * wake records is the same after a restart as before it.
 */
export interface WakeConvergenceState {
  /** The scope the previous decision measured. `null` before this project's first decision. */
  scopeHash: string | null;
  counters: ConvergenceCounters;
  /** The vector the previous decision measured: the "before" half of this wake's pair. */
  progressVector: ProgressVector | null;
  /** What the previous decision concluded. */
  lastOutcome: WakeConvergenceOutcome | null;
}

export const EMPTY_WAKE_CONVERGENCE_STATE: Readonly<WakeConvergenceState> = {
  scopeHash: null,
  counters: ZERO_COUNTERS,
  progressVector: null,
  lastOutcome: null,
};

/** One wake, as measured. `derived` is `deriveProgressVector`'s output and is not recomputed here. */
export interface WakeConvergenceObservation {
  /** The fact's identity — `wakeIdempotencyKey(fact)`. What makes a redelivery one judgment. */
  wakeKey: string;
  event: CoordinatorWakeEvent;
  derived: DerivedProgress;
  observedAt: Date;
}

/** What a replay of this decision reads. Versioned because it is hashed. */
export interface WakeConvergenceInput {
  v: typeof WAKE_CONVERGENCE_INPUT_VERSION;
  observedAt: string;
  wakeKey: string;
  event: CoordinatorWakeEvent;
  scopeHash: string;
  /** True when the previous decision measured a DIFFERENT scope, so its counters were not carried. */
  scopeChanged: boolean;
  counters: ConvergenceCounters;
  thresholds: ConvergenceThresholds;
  previousProgressVector: ProgressVector | null;
  observedProgressVector: ProgressVector;
  evidenceFreshness: EvidenceFreshness;
  lastOutcome: WakeConvergenceOutcome | null;
}

/** 2: planned under §1 — recorded, never charged. A row at 1 was planned by the breaker. */
export const WAKE_CONVERGENCE_INPUT_VERSION = 2 as const;

export interface PlannedWakeConvergence {
  idempotencyKey: string;
  inputHash: string;
  input: WakeConvergenceInput;
  scopeHash: string;
  /** The pair this unit exists to record: the vector before this wake, and the vector at it. */
  previousProgressVector: ProgressVector | null;
  progressVector: ProgressVector;
  progressVectorDigest: string;
  progressed: boolean;
  evidenceFreshness: EvidenceFreshness;
  evidenceAsOf: Date | null;
  /** The committed counters, carried unchanged: a wake charges none of them (§1). */
  counters: ConvergenceCounters;
  /** A wake is recorded and never refused (§1). */
  outcome: 'PROCEED';
}

/**
 * §6.2's shape, at project scope: `pcv:v1:<projectId>:<scopeHash>:<wakeKey>`.
 *
 * The scope is IN the key for the reason the task ledger puts the revision in its own (§5 FP3):
 * the same fact observed after a person rewrote what the project is asking for is a judgment about
 * a different question, and deduping it against the old scope's row would answer the new question
 * with the old answer.
 */
export function wakeConvergenceKey(
  projectId: string,
  scopeHash: string,
  wakeKey: string,
): string {
  return `pcv:v1:${projectId}:${scopeHash}:${wakeKey}`;
}

/**
 * One wake → one ledger row, in the contract's order.
 *
 * Each step reads what the one before it settled:
 *
 *  1. a scope the previous decision was not about is a new question (§4 PV4's second licence), so
 *     neither its counters nor its vector carry — a measurement against a different target says
 *     nothing about this one (PV3);
 *  2. PV6 before PV2: a reading the evidence cannot support is not a smaller improvement, it is
 *     not a measurement of now at all;
 *  3. §4 PV2's comparison — `strictlyImproves`, imported, never re-stated.
 *
 * And then nothing is charged and nothing is stopped (§1).
 */
export function planWakeConvergence(
  projectId: string,
  state: WakeConvergenceState,
  observation: WakeConvergenceObservation,
  thresholds: ConvergenceThresholds,
): PlannedWakeConvergence {
  const observed = observation.derived.vector;
  const scopeChanged = state.scopeHash !== null && state.scopeHash !== observed.scopeHash;
  const counters = scopeChanged ? { ...ZERO_COUNTERS } : state.counters;
  const carried = scopeChanged ? null : state.progressVector;

  const previous = carried ?? { ...EMPTY_PROGRESS_VECTOR, scopeHash: observed.scopeHash };
  const progressed = evidenceSupportsProgress(observation.derived)
    && strictlyImproves(previous, observed);

  const input: WakeConvergenceInput = {
    v: WAKE_CONVERGENCE_INPUT_VERSION,
    observedAt: observation.observedAt.toISOString(),
    wakeKey: observation.wakeKey,
    event: observation.event,
    scopeHash: observed.scopeHash,
    scopeChanged,
    counters,
    thresholds,
    previousProgressVector: carried,
    observedProgressVector: observed,
    evidenceFreshness: observation.derived.freshness,
    lastOutcome: state.lastOutcome,
  };

  return {
    idempotencyKey: wakeConvergenceKey(projectId, observed.scopeHash, observation.wakeKey),
    inputHash: sha256(canonicalJson(input)),
    input,
    scopeHash: observed.scopeHash,
    previousProgressVector: carried,
    progressVector: observed,
    progressVectorDigest: progressVectorDigest(observed),
    progressed,
    evidenceFreshness: observation.derived.freshness,
    evidenceAsOf: observation.derived.evidenceAsOf,
    counters,
    outcome: 'PROCEED',
  };
}

/**
 * The blocker kind the retired breaker raised (§1). Nothing raises it now. It is named so the
 * measurement can leave the rows raised before out of the vector: they record that this ledger once
 * stopped the project, not something standing between the project and its acceptance.
 */
export const COORDINATOR_NO_PROGRESS_KIND = 'COORDINATOR_NO_PROGRESS';

/** §11.3's default: one open episode per `<kind>:<subjectType>:<subjectId>`. */
export function noProgressDedupeKey(projectId: string): string {
  return `${COORDINATOR_NO_PROGRESS_KIND}:PROJECT:${projectId}`;
}

/** §3: how far back the fuse counts. */
export const COORDINATOR_SPEND_WINDOW_MS = 24 * 60 * 60_000;

/** §3's three kinds of autonomous spend, each counted over the window. */
export interface CoordinatorSpend {
  selfStartedTurns: number;
  sessionsOpened: number;
  successorRetries: number;
}

/** Which kind of spend crossed its limit. */
export type CoordinatorSpendReason = 'SELF_STARTED_TURNS' | 'SESSIONS_OPENED' | 'SUCCESSOR_RETRIES';

/** Each kind against its limit, in a fixed order: two crossed at once must report one answer. */
const SPEND_LINES: ReadonlyArray<{
  reason: CoordinatorSpendReason;
  spend: keyof CoordinatorSpend;
  limit: keyof CoordinatorSpendLimits;
}> = [
  { reason: 'SELF_STARTED_TURNS', spend: 'selfStartedTurns', limit: 'maxSelfStartedTurnsPerDay' },
  { reason: 'SESSIONS_OPENED', spend: 'sessionsOpened', limit: 'maxSessionsOpenedPerDay' },
  { reason: 'SUCCESSOR_RETRIES', spend: 'successorRetries', limit: 'maxRetriesPerSuccessorChain' },
];

export interface CoordinatorSpendVerdict {
  paused: boolean;
  /** The first line crossed and the two numbers that crossed it, or all three null. */
  reason: CoordinatorSpendReason | null;
  observed: number | null;
  limit: number | null;
}

/** §3: paused exactly when one kind of spend EXCEEDS its limit. */
export function coordinatorSpendVerdict(
  spend: CoordinatorSpend,
  limits: CoordinatorSpendLimits,
): CoordinatorSpendVerdict {
  for (const line of SPEND_LINES) {
    const limit = limits[line.limit];
    if (limit === null || spend[line.spend] <= limit) continue;
    return { paused: true, reason: line.reason, observed: spend[line.spend], limit };
  }
  return { paused: false, reason: null, observed: null, limit: null };
}

/** One of the project's tasks, as far as its place in a successor chain goes. */
export interface ChainedTask {
  id: string;
  supersededByTaskId: string | null;
  supersededAt: Date | null;
  filedByAgent: boolean;
}

/**
 * §3's third kind: the agent-filed replacements in the longest successor chain whose newest link
 * was made after `since`.
 *
 * Each chain is walked with `successorChain`, the walk every reader of `superseded_by_task_id`
 * uses, from its first attempt — a task that was replaced and replaces nothing. The first attempt
 * is not a retry, whoever filed it.
 */
export function successorRetries(tasks: readonly ChainedTask[], since: Date): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const edges = new Map(tasks.map((task) => [task.id, task.supersededByTaskId]));
  const replacements = new Set(tasks.flatMap((task) => task.supersededByTaskId ?? []));
  let longest = 0;
  for (const first of tasks) {
    if (first.supersededByTaskId === null || replacements.has(first.id)) continue;
    const successors = successorChain(first.id, edges).chain
      .map((id) => byId.get(id))
      .filter((task): task is ChainedTask => task !== undefined);
    const newest = Math.max(...[first, ...successors]
      .filter((task) => task.supersededByTaskId !== null)
      .map((task) => task.supersededAt?.getTime() ?? 0));
    if (newest <= since.getTime()) continue;
    longest = Math.max(longest, successors.filter((task) => task.filedByAgent).length);
  }
  return longest;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
