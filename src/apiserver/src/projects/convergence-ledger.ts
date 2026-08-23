import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import {
  CLASSIFICATION_OUTCOME,
  ConvergenceAutomationPolicy,
  ConvergenceClassification,
  ConvergenceCounters,
  ConvergenceEvent,
  ConvergenceOutcome,
  ConvergenceThresholds,
  NonConvergenceReason,
  ScopeActor,
  ScopeAuthorityDecision,
  TaskProgressState,
  ZERO_COUNTERS,
  authorizeScopeAction,
  progressStateAfter,
} from './convergence-contract';
import {
  EMPTY_PROGRESS_VECTOR,
  FailureFacts,
  ProgressVector,
  advanceCounters,
  detectNonConvergence,
  failureFingerprint,
  progressVectorDigest,
  reclassifyExhaustedTransient,
  scopeHash,
  strictlyImproves,
} from './convergence-progress';
import {
  EvidenceFreshness,
  EvidenceReading,
  evidenceSupportsProgress,
  severityTrend,
} from './convergence-evidence';

/**
 * `[K2]`: what a coordination judgment IS, as a pure function of committed facts.
 *
 * `[K1]` proved the breaker is decidable; nothing yet commits the facts it decides from, so every
 * counter still lives in whatever process computed it. That is the incident's second half (§0):
 * *「重启把计数清零，于是预算永远用不完」*. A budget held in memory is not a budget.
 *
 * This module turns one observation into one durable ledger row, and `convergence-ledger.service`
 * writes it. Nothing here reads a clock, a database or a session — `observedAt` arrives as an
 * argument for the same reason `[K1]`'s functions take their counters as arguments: the ledger is
 * replayed byte-for-byte, and a decision that read `Date.now()` would make two replays of one world
 * disagree about whether a task was stopped.
 */

/** §2 `progressStateAfter` twice, plus the six §3 outcomes, plus the three the table has no name for. */
export type ConvergenceDecisionKind =
  | ConvergenceOutcome
  /** The state moved and nothing else is owed — the loop may take the next step. */
  | 'CONTINUE'
  /** §2: a `(state, event)` pair the table does not have. The state holds AND the pass is charged. */
  | 'NO_TRANSITION'
  /** The task reached `SETTLED`. */
  | 'SETTLE';

/** Who has to act on `requiredAction`. Mirrors `ProjectBlockerOwner` — a blocker raised from this
 *  decision inherits it rather than deciding it a second time. */
export type ConvergenceActionOwner = 'USER' | 'COORDINATOR' | 'SYSTEM';

export type ConvergenceDecidedBy = 'ORCHESTRATOR' | 'COORDINATOR_AGENT' | 'USER';

/** The task's committed convergence state, as read. Every field is a column or a ledger row. */
export interface ConvergenceState {
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  progressState: TaskProgressState;
  counters: ConvergenceCounters;
  lastProgressAt: Date | null;
  knownGoodSha: string | null;
  /** The vector the previous decision measured. Absent before the first one. */
  progressVector: ProgressVector | null;
  /** The previous decision's fingerprint, for §8's `sameFingerprintRepeats`. */
  lastFingerprint: string | null;
  /**
   * `[K4]`: how many committed decisions in the current no-progress window already proposed the
   * action this observation is proposing.
   *
   * Read from the ledger by the writer under the same lock as everything else here, because it is
   * a fact about committed rows (TH4) and because it depends on the observation — a counter cannot
   * accumulate it without also being told when a DIFFERENT action was taken. Absent means "the
   * caller did not look", which counts as zero: it cannot invent repeats, only miss them.
   */
  sameActionPriorCount?: number;
}

/**
 * One fact about a task, as observed.
 *
 * `observationKey` is the load-bearing field and the one a caller must not improvise. It is the
 * DURABLE IDENTITY OF THE FACT — `session:<id>:delivered`, `verdict:<taskId>:<revision>`,
 * `finding:<fingerprint>` — and it is what makes AC1 true: a redelivered or out-of-order event
 * recomputes the same key, conflicts, and is read instead of written.
 *
 * It deliberately is NOT derived from the reader's snapshot. A snapshot changes the moment the
 * first delivery commits, so a hash of it would give the redelivery a different key and write the
 * same fact twice — which is the incident's counter-inflation in miniature.
 */
export interface ConvergenceObservation {
  observationKey: string;
  event: ConvergenceEvent;
  classification: ConvergenceClassification | null;
  /** The failure, if this observation is one. Fingerprinted here rather than by the caller (§5 FP1). */
  failure: FailureFacts | null;
  /**
   * The failure's identity, when the OBSERVER already has an authoritative one.
   *
   * FP1 says one failure has one identity. It does not say the ledger is where that identity is
   * computed — only that there is one. `[K5]`'s §6 makes `failureFingerprint` a required field of
   * the finding, submitted by the reporter and written to `task_verification_finding`, so deriving
   * a second one here from `failure` would give one failure two identities: §8's repeat line
   * compares the finding's against `lastFingerprint`, which is the ledger's, and they would never
   * be equal — a loop repeating the same defect for ever would read as a sequence of new ones.
   *
   * Absent on every observation whose failure has no identity of its own, which is `[K2]`'s
   * original callers: they pass `failure` and the derivation below answers, exactly as before this
   * field existed. Present means "I already know it", and it is taken verbatim.
   *
   * The 64-hex shape is required rather than trusted. A caller that passed a message, a key or a
   * Base62 id here would silently make an identity nothing else in the system can equal, which is
   * the same defect one layer up from the one this field exists to fix.
   */
  authoritativeFingerprint?: string | null;
  /** §4's measurement, taken now. Its `scopeHash` is what makes it comparable — or not (PV3). */
  progressVector: ProgressVector;
  /**
   * `[K4]` PV6: how old the evidence behind that vector is.
   *
   * Absent when the caller measured the vector itself rather than deriving it from a snapshot —
   * `[K2]`'s callers and its specs, where the vector IS the observation. Present on every path
   * that derives one, which is every path from `[K5]` on. A STALE reading cannot claim progress;
   * see `evidenceSupportsProgress`.
   */
  evidence?: EvidenceReading | null;
  observedAt: Date;
  decidedBy: ConvergenceDecidedBy;
  /** Whether this observation closes a verification round (§8's `verificationRounds`). */
  verificationRoundClosed?: boolean;
  /** What the caller will do about it, if anything. `null` records a judgment that acted on nothing. */
  action: string | null;
  /**
   * `[K4]` §5.1: the normalized identity of that action, and of the hypothesis behind it.
   *
   * Not the same thing as `actionIdempotencyKey`, and the difference is the whole point.
   * The key answers "has THIS action already been performed" and contains the attempt generation,
   * so every generation gets a fresh one — that is what makes a redelivery safe. The identity
   * answers "is this the same thing we tried last time", so it must NOT contain the generation, or
   * a loop would look like a sequence of distinct plans forever.
   */
  actionIdentity?: string | null;
  hypothesisIdentity?: string | null;
  sessionId?: string | null;
  projectDecisionId?: string | null;
}

/** Everything one judgment commits: the ledger row, and the task columns it moves. */
export interface PlannedConvergenceDecision {
  idempotencyKey: string;
  inputHash: string;
  input: ConvergenceDecisionInput;
  event: ConvergenceEvent;
  fromState: TaskProgressState;
  toState: TaskProgressState;
  classification: ConvergenceClassification | null;
  decision: ConvergenceDecisionKind;
  action: string | null;
  actionIdempotencyKey: string | null;
  failureFingerprint: string | null;
  actionIdentity: string | null;
  hypothesisIdentity: string | null;
  progressVector: ProgressVector;
  progressVectorDigest: string;
  progressed: boolean;
  /** PV6: what the evidence reading was, and how old its oldest item was. Null when unmeasured. */
  evidenceFreshness: EvidenceFreshness | null;
  evidenceAsOf: Date | null;
  counters: ConvergenceCounters;
  nonConvergenceReason: NonConvergenceReason | null;
  knownGoodSha: string | null;
  requiredAction: string | null;
  owner: ConvergenceActionOwner | null;
  nextCheckAt: Date | null;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  /** The task columns after this judgment. Written in the same transaction as the row. */
  taskState: {
    attemptGeneration: number;
    progressState: TaskProgressState;
    counters: ConvergenceCounters;
    lastProgressAt: Date | null;
    knownGoodSha: string | null;
  };
}

/**
 * The snapshot the judgment is a function of — the world as READ, never as written.
 *
 * `attemptGeneration` here is the generation in force when the world was read, not the one an
 * `ATTEMPT_STARTED` allocates: the allocation is an OUTPUT, and a snapshot that contained its own
 * consequences could not be replayed against the state that produced it.
 */
export interface ConvergenceDecisionInput {
  v: typeof CONVERGENCE_LEDGER_INPUT_VERSION;
  observedAt: string;
  observationKey: string;
  event: ConvergenceEvent;
  classification: ConvergenceClassification | null;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  progressState: TaskProgressState;
  counters: ConvergenceCounters;
  thresholds: ConvergenceThresholds;
  previousProgressVector: ProgressVector | null;
  observedProgressVector: ProgressVector;
  previousFingerprint: string | null;
  observedFingerprint: string | null;
  /** v2 (`[K4]`): the three inputs the breaker gained. A replay without them is a v1 replay. */
  observedActionIdentity: string | null;
  sameActionPriorCount: number;
  evidenceFreshness: EvidenceFreshness | null;
}

/**
 * v2: `[K4]` added the action identity, its window count and the evidence reading.
 *
 * Versioned rather than silently widened because the input is hashed: a v1 row's `input_hash` was
 * taken over a v1 shape, and a replay that fed it through today's serializer would compute a
 * different hash and report the ledger as corrupt. The version in the row says which shape its
 * hash was taken over.
 */
export const CONVERGENCE_LEDGER_INPUT_VERSION = 2 as const;

/**
 * §6.2's shape, for a task's ledger. The revision is IN the key on purpose: the same fact observed
 * after a re-plan is a judgment about a different question (§5 FP3), and deduping it against the
 * old revision's row would silently answer the new question with the old answer.
 */
export function convergenceDecisionKey(
  taskId: string,
  scopeRevision: number,
  observationKey: string,
): string {
  return `pc:v1:${taskId}:conv:${scopeRevision}:${observationKey}`;
}

/** The action's own key. Separate from the decision's, because a takeover that recomputes the same
 *  plan must be refused the DISPATCH even where it is allowed to read the judgment. */
export function convergenceActionKey(
  taskId: string,
  scopeRevision: number,
  attemptGeneration: number,
  action: string,
): string {
  return `pc:v1:${taskId}:conv-act:${scopeRevision}:${attemptGeneration}:${action}`;
}

/** §1's frozen identity of a revision. Re-exported so callers need one import for a scope digest. */
export { scopeHash };

/**
 * §8's answers, per state, as one deterministic table.
 *
 * `nextCheckAt` is null wherever the owner is USER, and that is the same rule the blocker contract
 * reached the expensive way (`PC-CX-05`): a wait that ends when a person decides has no clock, and
 * scheduling one produces a wake that finds nothing changed and charges the pass for it.
 */
export const CONVERGENCE_RECHECK_MS: Readonly<Record<ConvergenceActionOwner, number | null>> = {
  USER: null,
  COORDINATOR: 15 * 60 * 1000,
  SYSTEM: 5 * 60 * 1000,
};

const REPLAN_REQUIRED_ACTION: Readonly<Record<NonConvergenceReason, string>> = {
  SCOPE_EXPANSION_REQUIRED:
    'This task grew into a different piece of work. Re-scope it into a new revision or file a successor task; it will not be attempted again on this revision.',
  SAME_FAILURE_REPEATED:
    'The same failure has repeated on this scope revision. Change the hypothesis — a new revision or a different task — rather than retrying it.',
  VERIFICATION_ROUNDS_EXHAUSTED:
    'Verification keeps failing on this scope revision. Re-plan the task; further repair rounds are not converging.',
  TRANSIENT_RETRY_BUDGET_EXHAUSTED:
    'The failure classified as transient has outlived its retry budget. Treat it as a defect of this task or re-plan it.',
  ATTEMPT_BUDGET_EXHAUSTED:
    'No strict progress toward acceptance within the attempt budget. Re-plan the task or extend the budget explicitly.',
  HARD_ATTEMPT_CAP_REACHED:
    'This scope revision has reached its absolute attempt cap. Split it or re-scope it; it was mis-sized.',
  NO_PROGRESS:
    'Consecutive decisions produced no strict progress. Re-plan the task or extend the budget explicitly.',
  SAME_ACTION_REPEATED:
    'The same action has been proposed again and again on this scope revision without moving it. Change what is being tried — a different action, a new revision, or a person — rather than repeating it.',
  SEVERITY_NOT_DECLINING:
    'Repairs keep being filed and the open P0/P1 count is not falling. Re-plan the task: closing one defect per round while another opens is not convergence.',
};

/**
 * Who is owed the next move, per §2's state.
 *
 * `NEEDS_REPLAN` is USER's and not the coordinator's under every policy this table is used for:
 * SM4's three exits are each an explicit authorization, and §1 gives the coordinator none of them
 * under `GUARDED_AUTO` (the default). `AUTO` moves that one cell, and `planScopeRevision` is where
 * that is decided — a state table is not the place to answer a policy question.
 */
function ownerFor(
  state: TaskProgressState,
  classification: ConvergenceClassification | null,
): ConvergenceActionOwner | null {
  if (state === 'NEEDS_REPLAN' || state === 'AWAITING_HUMAN') return 'USER';
  if (state !== 'BLOCKED') return null;
  return classification === 'ENVIRONMENT' ? 'SYSTEM' : 'COORDINATOR';
}

function requiredActionFor(
  state: TaskProgressState,
  classification: ConvergenceClassification | null,
  reason: NonConvergenceReason | null,
): string | null {
  if (reason) return REPLAN_REQUIRED_ACTION[reason];
  if (state === 'NEEDS_REPLAN') return REPLAN_REQUIRED_ACTION.SCOPE_EXPANSION_REQUIRED;
  if (state === 'AWAITING_HUMAN') return 'This task needs a person to decide or to grant access before it can go on.';
  if (state !== 'BLOCKED') return null;
  if (classification === 'ENVIRONMENT') {
    return 'The environment or configuration this task runs in is broken. Repair it; changing the code will not clear this.';
  }
  return 'Work this task depends on is missing. File it as a prerequisite task and let this one resume when it lands.';
}

/**
 * One observation → one ledger row.
 *
 * The order below is the contract's and is not free to vary, because each step reads what the one
 * before it committed:
 *
 *  1. fingerprint the failure (§5), so "is this the same failure" is a comparison and not a guess;
 *  2. re-classify an exhausted `TRANSIENT` (§3 CL2) BEFORE charging a counter, so the last of the
 *     retries is charged to the budget it actually belongs to;
 *  3. decide `progressed` (§4 PV2) against the previous vector;
 *  4. move the counters (§3's column plus PV4's reset);
 *  5. only then ask the breaker (§8), so it reads the counters this step just committed and not
 *     the ones it replaced. Asking first is how a loop takes one more free attempt every time.
 */
export function planConvergenceDecision(
  taskId: string,
  state: ConvergenceState,
  observation: ConvergenceObservation,
  thresholds: ConvergenceThresholds,
): PlannedConvergenceDecision {
  const fingerprint = observation.authoritativeFingerprint
    ?? (observation.failure ? failureFingerprint(observation.failure) : null);
  const classification = observation.classification
    ? reclassifyExhaustedTransient(observation.classification, state.counters, thresholds)
    : null;

  const previousVector = state.progressVector
    ?? { ...EMPTY_PROGRESS_VECTOR, scopeHash: state.scopeHash };
  // PV6 before PV2: a measurement the evidence cannot support is not a smaller improvement, it is
  // not a measurement of now at all. Refusing it HERE rather than inside `strictlyImproves` keeps
  // §4's comparison a pure statement about two vectors — the question "may this vector be
  // believed" is about the snapshot behind it, and answering both in one function would make a
  // stale reading indistinguishable from a step that genuinely moved nothing.
  const believable = evidenceSupportsProgress(observation.evidence);
  const progressed = believable && strictlyImproves(previousVector, observation.progressVector);
  // A reading that may not be believed says nothing about the defect load either — `HELD` rather
  // than `NONE`, because "we could not measure" must not read as "there was nothing to fix".
  const severity = believable
    ? severityTrend(previousVector, observation.progressVector)
    : 'HELD';

  const attemptStarted = observation.event === 'ATTEMPT_STARTED';
  const counters = advanceCounters(state.counters, {
    classification,
    progressed,
    fingerprint,
    previousFingerprint: state.lastFingerprint,
    attemptStarted,
    verificationRoundClosed: observation.verificationRoundClosed === true,
    sameActionPriorCount: state.sameActionPriorCount ?? 0,
    severity,
  });

  const moved = progressStateAfter(state.progressState, observation.event);
  const intermediate = moved ?? state.progressState;

  // §8, after the counters moved. A task already `SETTLED` is not tripped: SM1 gives it no
  // out-edge, and a breaker that fired on it would report a live obligation about finished work.
  const verdict = intermediate === 'SETTLED'
    ? { tripped: false as const, reason: null, observed: null, limit: null }
    : detectNonConvergence(counters, thresholds);
  const toState = verdict.tripped
    ? progressStateAfter(intermediate, 'CIRCUIT_TRIPPED') ?? intermediate
    : intermediate;

  const decision: ConvergenceDecisionKind = verdict.tripped
    ? 'FREEZE_AND_REQUEST_REPLAN'
    : classification
      ? CLASSIFICATION_OUTCOME[classification]
      : toState === 'SETTLED'
        ? 'SETTLE'
        : moved === null
          ? 'NO_TRANSITION'
          : 'CONTINUE';

  // §3 CL3 and §9 GT1: a tripped breaker or a scope expansion never produces an action, however
  // much budget is left. `CIRCUIT_TRIPPED` landing on `NEEDS_REPLAN` is not a slower retry.
  const actionAllowed = !verdict.tripped && toState !== 'NEEDS_REPLAN';
  const action = actionAllowed ? observation.action : null;

  const attemptGeneration = attemptStarted
    ? state.attemptGeneration + 1
    : state.attemptGeneration;

  const owner = ownerFor(toState, classification);
  const recheckMs = owner ? CONVERGENCE_RECHECK_MS[owner] : null;

  const input: ConvergenceDecisionInput = {
    v: CONVERGENCE_LEDGER_INPUT_VERSION,
    observedAt: observation.observedAt.toISOString(),
    observationKey: observation.observationKey,
    event: observation.event,
    classification,
    scopeRevision: state.scopeRevision,
    scopeHash: state.scopeHash,
    attemptGeneration: state.attemptGeneration,
    progressState: state.progressState,
    counters: state.counters,
    thresholds,
    previousProgressVector: state.progressVector,
    observedProgressVector: observation.progressVector,
    previousFingerprint: state.lastFingerprint,
    observedFingerprint: fingerprint,
    observedActionIdentity: observation.actionIdentity ?? null,
    sameActionPriorCount: state.sameActionPriorCount ?? 0,
    evidenceFreshness: observation.evidence?.freshness ?? null,
  };

  return {
    idempotencyKey: convergenceDecisionKey(taskId, state.scopeRevision, observation.observationKey),
    inputHash: sha256(canonicalJson(input)),
    input,
    event: observation.event,
    fromState: state.progressState,
    toState,
    classification,
    decision,
    action,
    actionIdempotencyKey: action
      ? convergenceActionKey(taskId, state.scopeRevision, attemptGeneration, action)
      : null,
    failureFingerprint: fingerprint,
    // Recorded whether or not the action was authorized: the row says what this judgment PROPOSED,
    // and `action` says what it was allowed to do. Dropping the identity on a refused action would
    // erase the evidence of the repeat from the very decision the repeat caused.
    actionIdentity: observation.actionIdentity ?? null,
    hypothesisIdentity: observation.hypothesisIdentity ?? null,
    progressVector: observation.progressVector,
    progressVectorDigest: progressVectorDigest(observation.progressVector),
    progressed,
    evidenceFreshness: observation.evidence?.freshness ?? null,
    evidenceAsOf: observation.evidence?.evidenceAsOf ?? null,
    counters,
    nonConvergenceReason: verdict.reason,
    knownGoodSha: observation.progressVector.knownGoodSha,
    requiredAction: requiredActionFor(toState, classification, verdict.reason),
    owner,
    nextCheckAt: recheckMs === null
      ? null
      : new Date(observation.observedAt.getTime() + recheckMs),
    scopeRevision: state.scopeRevision,
    scopeHash: state.scopeHash,
    attemptGeneration,
    taskState: {
      attemptGeneration,
      progressState: toState,
      counters,
      lastProgressAt: progressed ? observation.observedAt : state.lastProgressAt,
      knownGoodSha: observation.progressVector.knownGoodSha ?? state.knownGoodSha,
    },
  };
}

/** What a scope change is asking to become, plus who is asking. */
export interface ScopeRevisionProposal {
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  actor: ScopeActor;
  principal: string;
  reason: string;
}

export type ScopeRevisionRefusal =
  | ScopeAuthorityDecision
  /** The proposal is the scope the task already has. A revision that changes nothing spends an
   *  audit row and resets a budget for free, which is the cheapest way to defeat §8. */
  | 'SCOPE_UNCHANGED'
  /** A signature is an actor AND a principal (OW4's shape). */
  | 'SCOPE_AUTHOR_UNIDENTIFIED';

export interface PlannedScopeRevision {
  revision: number;
  scopeHash: string;
  supersedesRevision: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  actor: ScopeActor;
  principal: string;
  policy: ConvergenceAutomationPolicy;
  reason: string;
  /** §4 PV4's licence: a new question gets a new budget, and the old revision keeps its spend. */
  counters: ConvergenceCounters;
}

/**
 * §1, as a decision rather than as a convention.
 *
 * Every actor may SAY the task is too small — that is `REQUEST_SCOPE_EXPANSION`, and §3 gives it
 * exactly one consequence. What this refuses is acting on your own request, which is the whole
 * difference between reporting a problem and quietly redefining success. The database refuses it
 * again in `task_scope_revision_authority_guard`, because a writer that skipped this function is
 * exactly the writer the incident had.
 */
export function planScopeRevision(
  current: { scopeRevision: number; scopeHash: string },
  proposal: ScopeRevisionProposal,
  policy: ConvergenceAutomationPolicy,
): PlannedScopeRevision | ScopeRevisionRefusal {
  const authority = authorizeScopeAction(proposal.actor, 'REVISE_SCOPE', policy);
  if (authority !== 'ALLOWED') return authority;
  if (proposal.principal.trim() === '') return 'SCOPE_AUTHOR_UNIDENTIFIED';

  const hash = scopeHash({
    title: proposal.title,
    description: proposal.description,
    acceptanceCriteria: proposal.acceptanceCriteria,
  });
  if (hash === current.scopeHash) return 'SCOPE_UNCHANGED';

  return {
    revision: current.scopeRevision + 1,
    scopeHash: hash,
    supersedesRevision: current.scopeRevision,
    title: proposal.title,
    description: proposal.description,
    acceptanceCriteria: proposal.acceptanceCriteria,
    actor: proposal.actor,
    principal: proposal.principal,
    policy,
    reason: proposal.reason,
    counters: { ...ZERO_COUNTERS },
  };
}

/** One committed ledger row, as the recovery reads it back. */
export interface ConvergenceLedgerEntry {
  seq: number;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  event: ConvergenceEvent;
  toState: TaskProgressState;
  progressed: boolean;
  counters: ConvergenceCounters;
  progressVector: ProgressVector;
  failureFingerprint: string | null;
  knownGoodSha: string | null;
  createdAt: Date;
}

/**
 * AC4: what the task's convergence columns must be, recomputed from the ledger alone.
 *
 * This is the crash-and-takeover answer. A process that died mid-pass leaves the ledger as the only
 * thing that happened, and a replacement has to be able to say "this is where we are" without
 * trusting a column some half-finished writer may have moved. Running it against the live columns
 * is also the cheapest possible corruption check, which is what `convergence-ledger.pg.spec` does.
 *
 * Rows from superseded revisions are skipped rather than folded in: their counters were spent
 * answering a different question (§4 PV3), and adding them would charge the new revision for the
 * old one's attempts.
 */
export function recoverConvergenceState(
  scopeRevision: number,
  scopeHash: string,
  entries: readonly ConvergenceLedgerEntry[],
): Pick<ConvergenceState,
  'attemptGeneration' | 'progressState' | 'counters' | 'lastProgressAt' | 'knownGoodSha'
  | 'progressVector' | 'lastFingerprint'> {
  const onRevision = entries
    .filter((entry) => entry.scopeRevision === scopeRevision)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const last = onRevision[onRevision.length - 1];
  const progressedRows = onRevision.filter((entry) => entry.progressed);
  const withCheckpoint = onRevision.filter((entry) => entry.knownGoodSha !== null);
  return {
    attemptGeneration: last?.attemptGeneration ?? 0,
    progressState: last?.toState ?? 'CONVERGING',
    counters: last?.counters ?? { ...ZERO_COUNTERS },
    lastProgressAt: progressedRows[progressedRows.length - 1]?.createdAt ?? null,
    knownGoodSha: withCheckpoint[withCheckpoint.length - 1]?.knownGoodSha ?? null,
    progressVector: last?.progressVector ?? null,
    lastFingerprint: last?.failureFingerprint ?? null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
