import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import {
  ConvergenceCounters,
  ConvergenceThresholds,
  NonConvergenceReason,
  ZERO_COUNTERS,
} from './convergence-contract';
import { DerivedProgress, EvidenceFreshness, evidenceSupportsProgress, severityTrend } from './convergence-evidence';
import {
  EMPTY_PROGRESS_VECTOR,
  ProgressVector,
  advanceCounters,
  detectNonConvergence,
  progressVectorDigest,
  strictlyImproves,
} from './convergence-progress';
import { CoordinatorWakeEvent } from './coordinator-wake';

/**
 * `[T4]`: the progress ledger a coordinator wake is charged against, and where the waking stops.
 *
 * §0 — THERE IS ONE DEFINITION OF PROGRESS AND IT IS NOT HERE
 * ===========================================================
 * `convergence-contract.ts` §0 froze it: **progress is strict improvement toward acceptance, not
 * activity**. Nothing in this module re-decides that. `strictlyImproves` answers "did this move",
 * `advanceCounters` answers "what does that cost", `detectNonConvergence` answers "is this still
 * bounded", and `deriveProgressVector` answers "what was measured" — all four are imported, none
 * of them is reimplemented, and a second opinion about any of them would be the exact defect this
 * unit exists to prevent. A control loop that counted "did something happen" is green while one
 * task retries the same failure three hundred times, which is the incident that froze the
 * contract in the first place.
 *
 * What this module DOES own is one question the contract states but does not answer for a project:
 * given a wake, may the coordinator go on waking? That is `planWakeConvergence`, and its whole
 * body is the frozen order — measure, compare, charge, THEN ask the breaker. Asking the breaker
 * first is how a loop takes one more free attempt every time round.
 *
 * §1 — WHY THE BLOCKER IS RAISED ON AN EDGE AND NOT WHILE THE CONDITION HOLDS
 * ==========================================================================
 * The blocker this raises has a name with history. `COORDINATOR_NO_PROGRESS` used to be a
 * CONDITION DETECTOR: every reconcile pass re-derived "the last coordination run changed nothing"
 * from the snapshot and re-raised the row, with an unchanged `reasonDigest`, off a session id that
 * had been dead for hours. `assertDoneAllowed` refuses a project with any open blocker, so a
 * project whose 7 acceptance criteria had all PASSED sat at OPEN for ever, and the gap between
 * somebody clearing the row and the next tick re-opening it was a few seconds.
 *
 * The fix is not a better digest. It is that a row is raised by a TRANSITION and never by a state:
 *
 *   - a wake is a committed fact (T2), and each fact is judged exactly once — the ledger row is
 *     keyed on the fact's own identity, so a redelivery reads the committed judgment instead of
 *     charging a second one;
 *   - the row is raised only where the previous committed decision was NOT already a stop
 *     (`raisesBlocker` below). While the project is stopped, further facts are refused and raise
 *     nothing, so there is no pass that can re-open what a person closed;
 *   - and nothing here is reachable from a timer, so a project about which nothing has happened
 *     produces no judgments at all.
 *
 * Coming back needs a reset, and there are exactly two, both of them the frozen contract's own:
 * strict improvement of the progress vector (§4 PV4), or a new question — a person editing what
 * the project is asking for, which moves `scopeHash` and gives the new scope its own budget. Both
 * are facts about the world. Neither is a clock.
 *
 * §2 — PURE
 * =========
 * No clock, no database, no session, for the reason every other `convergence-*` module is pure:
 * these decisions are replayed from the ledger, and one that read `Date.now()` would make two
 * replays of one world disagree about whether a project was stopped.
 */

/** The wake refusal T2's authorizer reports when the breaker has stopped this project. */
export const PROJECT_NOT_CONVERGING = 'PROJECT_NOT_CONVERGING';

/** Whether the coordinator may act on this wake. `STOP` is terminal until a reset (§1). */
export type WakeConvergenceOutcome = 'PROCEED' | 'STOP';

/**
 * The project's committed convergence state, as read from the ledger.
 *
 * Every field is the last committed row's, never a value held in a process. That is the whole of
 * the red line this unit was written under — 「重启把计数清零，于是预算永远用不完」 — and it is a
 * property of WHERE the numbers come from, not of what is done to them afterwards.
 */
export interface WakeConvergenceState {
  /** The scope the committed counters were spent on. `null` before this project's first decision. */
  scopeHash: string | null;
  counters: ConvergenceCounters;
  /** The vector the previous decision measured: the "before" half of this wake's pair. */
  progressVector: ProgressVector | null;
  /** What the previous decision concluded. `STOP` is what disarms the blocker raise (§1). */
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

export const WAKE_CONVERGENCE_INPUT_VERSION = 1 as const;

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
  counters: ConvergenceCounters;
  nonConvergenceReason: NonConvergenceReason | null;
  observed: number | null;
  limit: number | null;
  outcome: WakeConvergenceOutcome;
  /** §1: raise on the transition into a stop, never while one holds. */
  raisesBlocker: boolean;
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
 * The order is not free to vary, and each step reads what the one before it settled:
 *
 *  1. a scope the counters were not spent on is a new question, so it gets a new budget (§4 PV4's
 *     second licence) — and the previous vector goes with it, because a measurement against a
 *     different target says nothing about this one (PV3);
 *  2. PV6 before PV2: a reading the evidence cannot support is not a smaller improvement, it is
 *     not a measurement of now at all;
 *  3. §4 PV2's comparison — `strictlyImproves`, imported, never re-stated;
 *  4. §3's counters move;
 *  5. and only THEN §8's breaker, so it reads the counters this step just charged.
 */
export function planWakeConvergence(
  projectId: string,
  state: WakeConvergenceState,
  observation: WakeConvergenceObservation,
  thresholds: ConvergenceThresholds,
): PlannedWakeConvergence {
  const observed = observation.derived.vector;
  const scopeChanged = state.scopeHash !== null && state.scopeHash !== observed.scopeHash;
  const committed = scopeChanged ? { ...ZERO_COUNTERS } : state.counters;
  const carried = scopeChanged ? null : state.progressVector;

  const believable = evidenceSupportsProgress(observation.derived);
  const previous = carried ?? { ...EMPTY_PROGRESS_VECTOR, scopeHash: observed.scopeHash };
  const progressed = believable && strictlyImproves(previous, observed);
  // A reading that may not be believed says nothing about the defect load either — `HELD` rather
  // than `NONE`, because "we could not measure" must not read as "there was nothing to fix".
  const severity = believable ? severityTrend(previous, observed) : 'HELD';

  // A wake carries no classification and no failure of its own: it is the fact that SOMETHING
  // committed, not a claim about why. Both are passed as null rather than invented, which is why
  // the only counter a wake can move is `decisionsWithoutProgress` — §8's `NO_PROGRESS` line, and
  // the one this unit's stop-loss is stated in.
  const counters = advanceCounters(committed, {
    classification: null,
    progressed,
    fingerprint: null,
    previousFingerprint: null,
    sameActionPriorCount: 0,
    severity,
  });

  const verdict = detectNonConvergence(counters, thresholds);
  const outcome: WakeConvergenceOutcome = verdict.tripped ? 'STOP' : 'PROCEED';

  const input: WakeConvergenceInput = {
    v: WAKE_CONVERGENCE_INPUT_VERSION,
    observedAt: observation.observedAt.toISOString(),
    wakeKey: observation.wakeKey,
    event: observation.event,
    scopeHash: observed.scopeHash,
    scopeChanged,
    counters: committed,
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
    nonConvergenceReason: verdict.reason,
    observed: verdict.observed,
    limit: verdict.limit,
    outcome,
    // §1. The transition, not the state: a stop that is already committed raises nothing, so
    // nothing this unit does can re-open a row a person has closed.
    raisesBlocker: verdict.tripped && state.lastOutcome !== 'STOP',
  };
}

/**
 * The one `project_blocker` row this unit writes, per §11.2's table as it stood before the control
 * loop was removed (`project-blocker.ts`, deleted in 6418a1e5).
 *
 * `USER` / `HUMAN` and not a poll: the coordinator has spent its budget on this project without
 * moving it, so the next move is a person's — re-scope the work, file what is missing, or raise
 * the budget deliberately. A `recovery` of `TIME` or `EVENT` here would be a wait for something
 * the current rows cannot produce, which is the shape that idles for ever with a status on it.
 */
export const COORDINATOR_NO_PROGRESS_KIND = 'COORDINATOR_NO_PROGRESS';
export const COORDINATOR_NO_PROGRESS_OWNER = 'USER';
export const COORDINATOR_NO_PROGRESS_RECOVERY = 'HUMAN';
export const COORDINATOR_NO_PROGRESS_SEVERITY = 'CRITICAL';

/**
 * ES4: `next_check_at` for a `HUMAN` recovery is the escalation alarm, not a recovery poll — the
 * same hour the deleted table gave this kind. It is NOT a re-raise: nothing in this module reads
 * it, and the row it belongs to is already open and already addressed to somebody.
 */
export const COORDINATOR_NO_PROGRESS_ESCALATE_MS = 60 * 60_000;

/** §11.3's default: one open episode per `<kind>:<subjectType>:<subjectId>`. */
export function noProgressDedupeKey(projectId: string): string {
  return `${COORDINATOR_NO_PROGRESS_KIND}:PROJECT:${projectId}`;
}

export interface NoProgressBlocker {
  kind: typeof COORDINATOR_NO_PROGRESS_KIND;
  owner: typeof COORDINATOR_NO_PROGRESS_OWNER;
  recovery: typeof COORDINATOR_NO_PROGRESS_RECOVERY;
  severity: typeof COORDINATOR_NO_PROGRESS_SEVERITY;
  subjectType: 'PROJECT';
  subjectId: string;
  dedupeKey: string;
  /** §7.2 TF2: a digest of the FACTS that produced the row, so "the world moved" is comparable. */
  conditionVersion: string;
  requiredAction: string;
  nextCheckAt: Date;
  detail: Record<string, unknown>;
}

/**
 * The row a stopped project gets, stated so that the person who opens it can act without going and
 * deriving the numbers again: which line was crossed, what the counter and the limit were, what the
 * progress vector has been, and — because it is the part people get wrong — what makes it resume.
 */
export function noProgressBlocker(
  projectId: string,
  planned: PlannedWakeConvergence,
  wake: { wakeId: string; event: CoordinatorWakeEvent; idempotencyKey: string },
): NoProgressBlocker {
  const reason = planned.nonConvergenceReason;
  return {
    kind: COORDINATOR_NO_PROGRESS_KIND,
    owner: COORDINATOR_NO_PROGRESS_OWNER,
    recovery: COORDINATOR_NO_PROGRESS_RECOVERY,
    severity: COORDINATOR_NO_PROGRESS_SEVERITY,
    subjectType: 'PROJECT',
    subjectId: projectId,
    dedupeKey: noProgressDedupeKey(projectId),
    conditionVersion: sha256(canonicalJson({
      reason,
      observed: planned.observed,
      limit: planned.limit,
      progressVectorDigest: planned.progressVectorDigest,
      counters: planned.counters,
    })),
    requiredAction:
      `${planned.observed} consecutive coordinator wakes on this project produced no strict `
      + `improvement toward acceptance (the limit is ${planned.limit}), so the coordinator has `
      + 'stopped being woken. Its tasks have not stopped — dispatch does not go through it — so '
      + 'the coordinator comes back on its own the moment the work actually moves: an acceptance '
      + 'criterion closing, an open P0 closing, another blocker clearing. To move it yourself, '
      + 'either re-state what this project is asking for (editing its goal or acceptance criteria '
      + 'is a new question, and gets a new budget) or raise maxDecisionsWithoutProgress in '
      + 'convergenceThresholds deliberately. Closing THIS row changes none of those and does not '
      + 'restart anything: it is the record that the coordinator was stopped, not the thing '
      + 'stopping it.',
    // ES4/BL5: for a HUMAN recovery this is the escalation alarm, not a recovery poll. It is read
    // by nothing in this unit — no pass comes back to it, and it is not a re-raise — but the column
    // is NOT NULL because §11.1 requires an answer to "when does somebody hear about this" even
    // where the owner is a person.
    nextCheckAt: new Date(
      new Date(planned.input.observedAt).getTime() + COORDINATOR_NO_PROGRESS_ESCALATE_MS,
    ),
    detail: {
      reason,
      observed: planned.observed,
      limit: planned.limit,
      counters: planned.counters,
      progressVector: planned.progressVector,
      previousProgressVector: planned.previousProgressVector,
      evidenceFreshness: planned.evidenceFreshness,
      wakeEvent: wake.event,
      wakeIdempotencyKey: wake.idempotencyKey,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
