/**
 * `[K5]` §6: the only shape a verification Session may write, and the one consequence it produces.
 *
 * The unit exists because of the two halves §0's incident had in place of this one. A verifying
 * agent that finds something has, today, exactly two verbs available to it — edit the subject, or
 * keep steering the worker — and both of them are how "verify X" became "AutoRetry + deploy + lock
 * ordering" without one line of the audit saying that the question had changed. §1 OW1/OW2 forbid
 * both, and a prohibition with no legal alternative is a prohibition agents route around. This file
 * is the legal alternative: a finding is a claim ABOUT the subject that changes nothing about it,
 * and §3's table turns exactly one of those claims into exactly one piece of work.
 *
 * Everything here is pure. What lands in the database is `verification-finding.service`, and it
 * lands under `[K2]`'s ledger and `[K1]`'s counters rather than beside them — a finding is an
 * observation the breaker has to see, so it is charged to the same counters every other observation
 * is charged to (§3's `计入` column) and judged against the same thresholds.
 */

import { createHash } from 'node:crypto';
import {
  CLASSIFICATION_COUNTER,
  CLASSIFICATION_OUTCOME,
  CONVERGENCE_CLASSIFICATIONS,
  ConvergenceClassification,
  ConvergenceCounters,
  ConvergenceEvent,
  ConvergenceOutcome,
  ConvergenceThresholds,
  NonConvergenceReason,
  ScopeActor,
  SeverityTrend,
  TaskProgressState,
  progressStateAfter,
} from './convergence-contract';
import {
  advanceCounters,
  detectNonConvergence,
  reclassifyExhaustedTransient,
} from './convergence-progress';

/** §6's first row. Ordered worst-first, which is also the order `severityDropped` compares on. */
export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['P0', 'P1', 'P2', 'P3'];

/**
 * §6's last row, and the reason it has only two values.
 *
 * A finding is what a check writes when the answer is NOT "it works". `PASS` is not missing by
 * oversight: a passing check has nothing to report, produces no work item and spends no budget, and
 * a "finding" that says everything is fine would be a row the triage below has no consequence for.
 */
export type FindingVerdict = 'FAIL' | 'INCONCLUSIVE';

export const FINDING_VERDICTS: readonly FindingVerdict[] = ['FAIL', 'INCONCLUSIVE'];

/** §6's table, verbatim — every field required, and no field outside it. */
export interface VerificationFinding {
  severity: FindingSeverity;
  /** A stable code for the rule that was broken. Feeds §5's fingerprint, so it is an id not prose. */
  violatedInvariant: string;
  /** One command or step sequence that reproduces it. Non-empty: an unreproducible claim is not a
   *  finding, it is an opinion, and §3 has no row that turns an opinion into work. */
  minimalRepro: string;
  /** §5's normalized failure identity. Supplied rather than derived: the reporter observed the
   *  failure and this module did not, and re-deriving it here from a message would produce a
   *  SECOND fingerprint for the same failure — which is the exact defect §5 FP1 exists to stop. */
  failureFingerprint: string;
  scopeClassification: ConvergenceClassification;
  /** §6: "Base62 拼写的 JSON". Ids inside evidence are public ids, because a finding is audit
   *  material a person reads and hands back, and an internal UUID is neither. */
  evidence: Record<string, unknown>;
  verdict: FindingVerdict;
}

/** Where a finding lands, and who is making the claim. Not part of §6's shape — see FD4. */
export interface FindingAddress {
  projectId: string;
  subjectTaskId: string;
  /** FD4: the revision the reporter measured against. Compared, never trusted. */
  scopeRevision: number;
  reporter: ScopeActor;
}

/**
 * Why a submission is not a finding. Every one of them is a REFUSAL, never a silent drop.
 *
 * A verifier whose finding was rejected has to be told which field failed, because the alternative
 * — the submission disappearing — is how an agent concludes the door does not work and goes back to
 * the two verbs §1 forbids.
 */
export type FindingRefusal =
  /** FD4. The reporter measured a scope this task no longer has. */
  | 'STALE_SCOPE_REVISION'
  | 'UNKNOWN_SEVERITY'
  | 'UNKNOWN_VERDICT'
  | 'UNKNOWN_CLASSIFICATION'
  | 'EMPTY_VIOLATED_INVARIANT'
  | 'EMPTY_MINIMAL_REPRO'
  | 'MALFORMED_FINGERPRINT'
  | 'EMPTY_EVIDENCE'
  /** §6: an id in `evidence` spelled as an internal UUID. */
  | 'EVIDENCE_NOT_PUBLIC_ID'
  /** §3's `谁能定` column: this actor may not put a failure in this class. */
  | 'CLASSIFICATION_NOT_REPORTABLE';

export const FINDING_REFUSALS: readonly FindingRefusal[] = [
  'STALE_SCOPE_REVISION',
  'UNKNOWN_SEVERITY',
  'UNKNOWN_VERDICT',
  'UNKNOWN_CLASSIFICATION',
  'EMPTY_VIOLATED_INVARIANT',
  'EMPTY_MINIMAL_REPRO',
  'MALFORMED_FINGERPRINT',
  'EMPTY_EVIDENCE',
  'EVIDENCE_NOT_PUBLIC_ID',
  'CLASSIFICATION_NOT_REPORTABLE',
];

/**
 * §3's `谁能定` column, as a table rather than as a sentence in a prompt.
 *
 * The two rows that matter are `TRANSIENT` and `ENVIRONMENT`, and they matter for §0's reason.
 * Both are read from SYSTEM evidence, which means no agent gets to declare its own failure one:
 * "it was flaky" and "the environment is broken" are the two self-diagnoses that cost nothing and
 * buy another attempt, and an agent that can write them can retry for ever without ever spending
 * the attempt budget (CL1 — neither class charges it). The COORDINATOR may write them because the
 * orchestrator derives them from run facts; a WORKER or a VERIFIER may not, and its failure is
 * classified by whoever is looking at the evidence.
 *
 * `HUMAN_REQUIRED` is open to everyone by §3, and deliberately so — "I need a person" is the one
 * claim that costs the claimant something (it stops the work) rather than buying it something.
 */
export const FINDING_REPORTERS: Readonly<
  Record<ConvergenceClassification, readonly ScopeActor[]>
> = {
  TRANSIENT: ['USER', 'COORDINATOR'],
  IN_SCOPE_DEFECT: ['USER', 'COORDINATOR', 'VERIFIER'],
  PREREQUISITE: ['USER', 'COORDINATOR', 'VERIFIER'],
  // §1 OW2 in its positive form. A worker may not add an acceptance criterion, and this is what it
  // does instead: the request is a finding, classified `SCOPE_EXPANSION`, and CL3 guarantees the
  // answer is a freeze rather than more work under the current revision.
  SCOPE_EXPANSION: ['USER', 'COORDINATOR', 'WORKER', 'VERIFIER'],
  ENVIRONMENT: ['USER', 'COORDINATOR'],
  HUMAN_REQUIRED: ['USER', 'COORDINATOR', 'WORKER', 'VERIFIER'],
};

/**
 * FD3's counter, and what actually closes one of its rounds.
 *
 * A verification round is one finding-and-repair cycle ABOUT THE WORK, so the three classes that
 * say something about the work close one and the other three do not:
 *
 *  - `TRANSIENT` is a statement about the infrastructure. Charging it a round means three flaky
 *    runs exhaust `maxVerificationRounds` and freeze a task no check has yet examined once — the
 *    breaker firing with a diagnosis that is not the task's, which is the error CL1 exists to name.
 *    It has its own bound (`maxTransientRetries`), and CL2 converts it when that runs out.
 *  - `ENVIRONMENT` and `HUMAN_REQUIRED` are CL1's exempt pair for the same reason one level up.
 */
export const CLASSES_CLOSING_A_VERIFICATION_ROUND: ReadonlySet<ConvergenceClassification> =
  new Set<ConvergenceClassification>(['IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION']);

/** Which §2 event a class raises. One row per class, so FD2's "exactly one result" starts here. */
export const CLASSIFICATION_EVENT: Readonly<
  Record<ConvergenceClassification, ConvergenceEvent>
> = {
  TRANSIENT: 'ATTEMPT_FAILED_TRANSIENT',
  IN_SCOPE_DEFECT: 'VERIFICATION_FAILED_IN_SCOPE',
  PREREQUISITE: 'PREREQUISITE_FOUND',
  SCOPE_EXPANSION: 'SCOPE_EXPANSION_REQUESTED',
  ENVIRONMENT: 'ENVIRONMENT_FAILURE',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
};

/** Why the outcome is not the one §3 gives this class. Null means it is. */
export type FindingOverrideReason =
  /** CL2: `TRANSIENT` told once too often. The class itself is rewritten, not just the outcome. */
  | 'TRANSIENT_BUDGET_EXHAUSTED'
  /** FD3: the repair rounds are spent. */
  | 'VERIFICATION_ROUNDS_EXHAUSTED'
  /**
   * `[K5]` FD3', the task's own sentence: one verification round, and the re-work did not make the
   * finding smaller. See `repairHeld` for why severity is the measure and repetition is not.
   */
  | 'REPAIR_WITHOUT_SEVERITY_DROP'
  /** §8's breaker had already tripped on another line before this finding arrived. */
  | 'CIRCUIT_TRIPPED';

/** What the coordinator creates. Exactly one per finding (FD2), and `NONE` is one of them. */
export type FindingEffectKind =
  | 'DEFECT_SUBTASK'
  | 'PREREQUISITE_TASK'
  | 'REPLAN_TASK'
  | 'SYSTEM_BLOCKER'
  | 'USER_BLOCKER'
  | 'NONE';

/** §3's `唯一合法结果` column, read one column further: which artifact each outcome is. */
export const OUTCOME_EFFECT: Readonly<Record<ConvergenceOutcome, FindingEffectKind>> = {
  RETRY_WITHIN_BUDGET: 'NONE',
  CREATE_DEFECT_SUBTASK: 'DEFECT_SUBTASK',
  CREATE_PREREQUISITE_TASK: 'PREREQUISITE_TASK',
  FREEZE_AND_REQUEST_REPLAN: 'REPLAN_TASK',
  RAISE_SYSTEM_BLOCKER: 'SYSTEM_BLOCKER',
  RAISE_USER_BLOCKER: 'USER_BLOCKER',
};

/**
 * §3's two blocker rows, in §11's vocabulary.
 *
 * Named apart rather than sharing one kind because the two send a reader to different places and
 * have different owners: a broken environment is the SYSTEM's to repair and a judgment call is a
 * person's, and one row that meant both would have to pick one of those and be wrong half the time.
 */
export const EFFECT_BLOCKER_KIND: Readonly<Record<'SYSTEM_BLOCKER' | 'USER_BLOCKER', string>> = {
  SYSTEM_BLOCKER: 'ENVIRONMENT_BROKEN',
  USER_BLOCKER: 'HUMAN_DECISION_REQUIRED',
};

/** Who owns the next step, per outcome (§11.1's second question, asked per finding). */
export const OUTCOME_OWNER: Readonly<
  Record<ConvergenceOutcome, 'USER' | 'COORDINATOR' | 'SYSTEM'>
> = {
  RETRY_WITHIN_BUDGET: 'COORDINATOR',
  CREATE_DEFECT_SUBTASK: 'COORDINATOR',
  CREATE_PREREQUISITE_TASK: 'COORDINATOR',
  // OW3: a coordinator under `GUARDED_AUTO` may not mint a new scope revision, so the task it files
  // is a REQUEST and the person is the one who answers it.
  FREEZE_AND_REQUEST_REPLAN: 'USER',
  RAISE_SYSTEM_BLOCKER: 'SYSTEM',
  RAISE_USER_BLOCKER: 'USER',
};

/**
 * The state a finding is judged against. Every field is a committed column or a committed row —
 * RL3, so a restart, a takeover and a redelivery all read the same inputs and reach the same answer.
 */
export interface FindingSubjectState {
  scopeRevision: number;
  progressState: TaskProgressState;
  counters: ConvergenceCounters;
  /** §5's identity of the previous failure on this revision, for `sameFingerprintRepeats`. */
  lastFingerprint: string | null;
  /**
   * The severity of the last finding on this (subject, revision) that produced a repair, or null
   * if none has. This is the whole memory FD3' needs, and it is one row rather than a scan.
   */
  lastRepairSeverity: FindingSeverity | null;
}

/**
 * `[K4]`'s severity trend, derived from findings rather than from the defect COUNT.
 *
 * `[K4]` asks what happened to `openP0 + openP1` between two progress vectors, which is the right
 * question when there is a vector. A finding arrives before one is measured, and it carries the
 * same information about the single worst thing found: `DROPPED` when this finding is strictly less
 * severe than the one the last repair was filed for, `HELD` when it is not, `NONE` when nothing has
 * been repaired yet — because the first finding on a revision is a diagnosis, not a failed cure.
 */
export function findingSeverityTrend(
  previous: FindingSeverity | null,
  current: FindingSeverity,
): SeverityTrend {
  if (previous === null) return 'NONE';
  return severityRank(current) > severityRank(previous) ? 'DROPPED' : 'HELD';
}

export interface FindingTriage {
  outcome: ConvergenceOutcome;
  /** After CL2. Equal to the submitted class unless `override` is `TRANSIENT_BUDGET_EXHAUSTED`. */
  effectiveClassification: ConvergenceClassification;
  override: FindingOverrideReason | null;
  effect: FindingEffectKind;
  event: ConvergenceEvent;
  /** §2's table applied to the event. Null when the state does not move (which is not an error). */
  progressState: TaskProgressState;
  /** The counters after this finding is charged, per §3's `计入` column. */
  counters: ConvergenceCounters;
  /** Non-null when §8's breaker is tripped by (or was already tripped before) this finding. */
  nonConvergenceReason: NonConvergenceReason | null;
  requiredAction: string;
  owner: 'USER' | 'COORDINATOR' | 'SYSTEM';
}

export type FindingDecision =
  | { ok: true; triage: FindingTriage }
  | { ok: false; refusal: FindingRefusal; field: string | null };

/**
 * FD1: the identity of a finding, and therefore of its effect.
 *
 * Four terms and no more. The project scopes it, the subject and the revision say what question it
 * is about (FP3 — a fingerprint means nothing across a revision boundary), and the fingerprint says
 * which failure. Deliberately absent: the reporter, the verifier task, the session, the attempt
 * generation and the clock. Any of those in the key would give the SAME defect reported by a second
 * check — or by the same check after a restart — a different key and a second subtask, which is
 * exactly the "重复 finding 不重复建 Task" this key exists to make impossible.
 */
export function findingDedupKey(
  projectId: string,
  subjectTaskId: string,
  scopeRevision: number,
  failureFingerprint: string,
): string {
  return `pc:v1:${projectId}:finding:${subjectTaskId}:${scopeRevision}:${failureFingerprint}`;
}

/**
 * The permanent key of a finding's ONE effect.
 *
 * Derived from the dedup key rather than minted, so the same finding delivered twice, out of order,
 * or after a crash between the row and its effect resolves to the same key and lands once. It is a
 * digest rather than the key itself only because `task.idempotency_key` and the action ledger are
 * bounded columns and the dedup key carries two ids.
 */
export function findingEffectKey(dedupKey: string): string {
  return `pc:v1:finding-effect:${createHash('sha256').update(dedupKey).digest('hex')}`;
}

/** Worst-first index. `P0` is 0, so "smaller number" is "worse". */
export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(severity);
}

/**
 * FD3' — did the re-work make this smaller?
 *
 * Severity is the measure and repetition is not, and the difference is the whole point. The same
 * fingerprint arriving twice is caught by FD1 and never reaches here; what reaches here is a
 * DIFFERENT failure on the same task after a repair, and the question that separates "converging"
 * from "churning" is whether the thing being found is getting less severe. `[K4]` makes the same
 * judgment about the defect COUNT (`repairsWithoutSeverityDrop`); this makes it about the single
 * worst one, which is the one a verifier actually reports.
 *
 * `null` — nothing has been repaired yet — is not a held repair. The first finding on a revision is
 * the diagnosis, not a failed cure.
 */
export function repairHeld(
  previous: FindingSeverity | null,
  current: FindingSeverity,
): boolean {
  return findingSeverityTrend(previous, current) === 'HELD';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * §6's shape gate, in the table's own order.
 *
 * Returns the FIRST failing field rather than a list, because a caller that has to fix one field at
 * a time gets a shorter loop than one handed a list it half-fixes; and because the order is the
 * document's, so two readers of the contract and the code see the same sequence.
 */
export function validateFinding(
  finding: VerificationFinding,
  address: FindingAddress,
  subject: { scopeRevision: number },
): { ok: true } | { ok: false; refusal: FindingRefusal; field: string | null } {
  // FD4 first, before any field is read. A finding measured against a scope the task no longer has
  // is an answer to a question nobody is asking any more, and validating its contents would suggest
  // that fixing them would help.
  if (address.scopeRevision !== subject.scopeRevision) {
    return { ok: false, refusal: 'STALE_SCOPE_REVISION', field: 'scopeRevision' };
  }
  if (!FINDING_SEVERITIES.includes(finding.severity)) {
    return { ok: false, refusal: 'UNKNOWN_SEVERITY', field: 'severity' };
  }
  if (finding.violatedInvariant.trim().length === 0) {
    return { ok: false, refusal: 'EMPTY_VIOLATED_INVARIANT', field: 'violatedInvariant' };
  }
  if (finding.minimalRepro.trim().length === 0) {
    return { ok: false, refusal: 'EMPTY_MINIMAL_REPRO', field: 'minimalRepro' };
  }
  if (!FINGERPRINT_PATTERN.test(finding.failureFingerprint)) {
    return { ok: false, refusal: 'MALFORMED_FINGERPRINT', field: 'failureFingerprint' };
  }
  if (!CONVERGENCE_CLASSIFICATIONS.includes(finding.scopeClassification)) {
    return { ok: false, refusal: 'UNKNOWN_CLASSIFICATION', field: 'scopeClassification' };
  }
  if (!FINDING_VERDICTS.includes(finding.verdict)) {
    return { ok: false, refusal: 'UNKNOWN_VERDICT', field: 'verdict' };
  }
  if (Object.keys(finding.evidence ?? {}).length === 0) {
    return { ok: false, refusal: 'EMPTY_EVIDENCE', field: 'evidence' };
  }
  if (containsInternalId(finding.evidence)) {
    return { ok: false, refusal: 'EVIDENCE_NOT_PUBLIC_ID', field: 'evidence' };
  }
  if (!FINDING_REPORTERS[finding.scopeClassification].includes(address.reporter)) {
    return { ok: false, refusal: 'CLASSIFICATION_NOT_REPORTABLE', field: 'scopeClassification' };
  }
  return { ok: true };
}

/**
 * FD2, and the only place a classification becomes work.
 *
 * The order is the judgment, and it reads downward from "this class never continues" to "this class
 * would have continued but the budget says no":
 *
 *  1. CL2 rewrites an exhausted `TRANSIENT` into `IN_SCOPE_DEFECT`. A rewrite rather than a trip,
 *     because the two say different things to whoever reads the row, and because the rewritten
 *     class then spends the attempt budget where a transient one spends nothing.
 *  2. §3's table gives the class its one outcome.
 *  3. CL3 pins `SCOPE_EXPANSION` to a freeze no matter what any budget says — a task that grew into
 *     a different task is not a task with attempts left.
 *  4. FD3' freezes a repair that held its severity, and FD3 freezes one that has used its rounds.
 *  5. §8's breaker, over the counters this finding has just been charged to, freezes everything
 *     else it catches.
 *
 * Steps 3-5 all land on `FREEZE_AND_REQUEST_REPLAN` and differ only in `override`, which is not
 * redundancy: the reason is what the replan task says on it, and "this grew" sends a person
 * somewhere completely different from "the same repair has stopped helping".
 */
export function triageFinding(
  finding: VerificationFinding,
  address: FindingAddress,
  state: FindingSubjectState,
  thresholds: ConvergenceThresholds,
): FindingTriage {
  const effective = reclassifyExhaustedTransient(
    finding.scopeClassification, state.counters, thresholds);
  const reclassified = effective !== finding.scopeClassification;

  const counters = chargeFinding(state, effective, finding.severity, finding.failureFingerprint);
  const breaker = detectNonConvergence(counters, thresholds);

  let outcome = CLASSIFICATION_OUTCOME[effective];
  let override: FindingOverrideReason | null = reclassified
    ? 'TRANSIENT_BUDGET_EXHAUSTED'
    : null;

  // CL3, stated before any budget is consulted so that a freeze here is never mistaken for one the
  // breaker produced. `SCOPE_EXPANSION` already IS `FREEZE_AND_REQUEST_REPLAN` in §3's table, so
  // this leaves the outcome alone and only claims the reason.
  if (effective === 'SCOPE_EXPANSION') {
    outcome = 'FREEZE_AND_REQUEST_REPLAN';
  } else if (outcome === 'CREATE_DEFECT_SUBTASK' || outcome === 'CREATE_PREREQUISITE_TASK') {
    // FD3'/FD3, in that order. The severity line speaks first because it is the more specific
    // diagnosis: "the re-work did not make it smaller" tells a person what to change, and "you have
    // used your rounds" only tells them to stop.
    if (repairHeld(state.lastRepairSeverity, finding.severity)) {
      outcome = 'FREEZE_AND_REQUEST_REPLAN';
      override = 'REPAIR_WITHOUT_SEVERITY_DROP';
    } else if (breaker.tripped && breaker.reason === 'VERIFICATION_ROUNDS_EXHAUSTED') {
      outcome = 'FREEZE_AND_REQUEST_REPLAN';
      override = 'VERIFICATION_ROUNDS_EXHAUSTED';
    } else if (breaker.tripped) {
      outcome = 'FREEZE_AND_REQUEST_REPLAN';
      override = 'CIRCUIT_TRIPPED';
    }
  } else if (outcome === 'RETRY_WITHIN_BUDGET' && breaker.tripped) {
    // CL1's other half. `ENVIRONMENT` and `HUMAN_REQUIRED` are NOT here: they charge no counter, so
    // the breaker has nothing of theirs to trip on, and freezing them on somebody else's line would
    // replace a blocker a person can act on with one that says "budget exhausted".
    outcome = 'FREEZE_AND_REQUEST_REPLAN';
    override = 'CIRCUIT_TRIPPED';
  }

  // A frozen outcome is the breaker speaking whatever produced it, so it reports `CIRCUIT_TRIPPED`
  // to §2's table. Everything else raises its class's own event.
  const event: ConvergenceEvent = outcome === 'FREEZE_AND_REQUEST_REPLAN' && override !== null
    ? 'CIRCUIT_TRIPPED'
    : CLASSIFICATION_EVENT[effective];

  return {
    outcome,
    effectiveClassification: effective,
    override,
    effect: OUTCOME_EFFECT[outcome],
    event,
    // §2 SM: a pair with no transition leaves the state where it was. That is not an error and not
    // a free pass — the counters above were charged either way, which is what the breaker reads.
    progressState: progressStateAfter(state.progressState, event) ?? state.progressState,
    counters,
    nonConvergenceReason: outcome === 'FREEZE_AND_REQUEST_REPLAN'
      ? (breaker.reason ?? overrideAsReason(override))
      : null,
    requiredAction: requiredAction(outcome, override, effective),
    owner: OUTCOME_OWNER[outcome],
  };
}

/** §6 + §3, in one call: validate, then triage. The service layer's whole decision. */
export function decideFinding(
  finding: VerificationFinding,
  address: FindingAddress,
  state: FindingSubjectState,
  thresholds: ConvergenceThresholds,
): FindingDecision {
  const valid = validateFinding(finding, address, state);
  if (!valid.ok) return valid;
  return { ok: true, triage: triageFinding(finding, address, state, thresholds) };
}

/**
 * §3's `计入` column, charged through `[K4]`'s rule and not through a second copy of it.
 *
 * Delegating matters more here than anywhere else in this file. The service commits the finding
 * alongside a `[K2]` ledger decision, and the ledger charges the same observation with
 * `advanceCounters`; if this function had its own arithmetic, the outcome the finding recorded and
 * the counters the breaker will read on the NEXT finding would come from two different rules, and
 * they would diverge exactly when it matters — at the boundary where one of them trips.
 *
 * Three arguments are fixed rather than passed, and each is a statement:
 *
 *  - `progressed: false`. RL0. A finding is a report that something is wrong; it never refreshes
 *    `lastProgressAt` and never resets a counter.
 *  - `attemptStarted: false`. A finding is not an attempt. §0's incident is the whole reason that
 *    distinction is load-bearing.
 *  - `sameActionPriorCount: 0`. §8's repeated-action line counts a coordinator proposing the same
 *    action again; a finding cannot repeat, because FD1 collapses the second copy before it is
 *    ever charged. Passing a number here would double-count the ledger's own reading.
 *
 * `verificationRoundClosed` reads `CLASSES_CLOSING_A_VERIFICATION_ROUND` rather than "does this
 * class charge anything", and the difference is a real bound rather than a distinction: deriving it
 * from `CLASSIFICATION_COUNTER` makes `TRANSIENT` close a round, and three flaky runs then exhaust
 * `maxVerificationRounds` and freeze a task nothing has yet verified even once.
 */
export function chargeFinding(
  state: Pick<FindingSubjectState, 'counters' | 'lastFingerprint' | 'lastRepairSeverity'>,
  classification: ConvergenceClassification,
  severity: FindingSeverity,
  fingerprint: string,
): ConvergenceCounters {
  return advanceCounters(state.counters, {
    classification,
    progressed: false,
    // §5's identity, passed through rather than nulled. Nulling it would RESET
    // `sameFingerprintRepeats` on every finding — a counter walking downward, which is exactly what
    // RL3 forbids and what `mergeCounters` exists to catch. A finding that names the same failure
    // the last attempt died on IS that failure again, and §8's repeat line has to see it.
    fingerprint,
    previousFingerprint: state.lastFingerprint,
    attemptStarted: false,
    verificationRoundClosed: CLASSES_CLOSING_A_VERIFICATION_ROUND.has(classification),
    sameActionPriorCount: 0,
    severity: findingSeverityTrend(state.lastRepairSeverity, severity),
  });
}

function overrideAsReason(override: FindingOverrideReason | null): NonConvergenceReason | null {
  switch (override) {
    case 'VERIFICATION_ROUNDS_EXHAUSTED': return 'VERIFICATION_ROUNDS_EXHAUSTED';
    case 'REPAIR_WITHOUT_SEVERITY_DROP': return 'SEVERITY_NOT_DECLINING';
    case 'TRANSIENT_BUDGET_EXHAUSTED': return 'TRANSIENT_RETRY_BUDGET_EXHAUSTED';
    // CL3's freeze is not a budget line — `SCOPE_EXPANSION` freezes at zero requests — and
    // `SCOPE_EXPANSION_REQUIRED` is the reason §8 names for it.
    default: return 'SCOPE_EXPANSION_REQUIRED';
  }
}

/** §11.1's first question. One sentence, addressed to `OUTCOME_OWNER`'s answer to the second. */
function requiredAction(
  outcome: ConvergenceOutcome,
  override: FindingOverrideReason | null,
  classification: ConvergenceClassification,
): string {
  switch (outcome) {
    case 'RETRY_WITHIN_BUDGET':
      return 'retry this attempt within the transient budget';
    case 'CREATE_DEFECT_SUBTASK':
      return 'fix the defect subtask filed under this task, then re-run its verification';
    case 'CREATE_PREREQUISITE_TASK':
      return 'complete the prerequisite task this one now depends on';
    case 'RAISE_SYSTEM_BLOCKER':
      return 'repair the environment named in the blocker; re-running the task cannot resolve it';
    case 'RAISE_USER_BLOCKER':
      return 'a person has to decide or grant access before this task can continue';
    case 'FREEZE_AND_REQUEST_REPLAN':
      switch (override) {
        case 'REPAIR_WITHOUT_SEVERITY_DROP':
          return 'the re-work did not lower the severity; re-plan this task or split it';
        case 'VERIFICATION_ROUNDS_EXHAUSTED':
          return 'the verification rounds for this scope revision are spent; re-plan or extend them';
        case 'TRANSIENT_BUDGET_EXHAUSTED':
          return 'the failure is not transient; re-plan this task around the defect it keeps hitting';
        case 'CIRCUIT_TRIPPED':
          return 'the convergence budget for this scope revision is spent; re-plan or extend it';
        default:
          return classification === 'SCOPE_EXPANSION'
            ? 'the work is larger than this task; approve a new scope revision or split it'
            : 're-plan this task';
      }
  }
}

/** Any string anywhere in the evidence that is spelled as an internal UUID (§6's Base62 rule). */
function containsInternalId(value: unknown): boolean {
  if (typeof value === 'string') return UUID_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsInternalId);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsInternalId);
  }
  return false;
}
