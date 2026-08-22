/**
 * What a verification verdict does (contract AC6 / §13.2).
 *
 * `task.verifiesTaskId` has always said "this task checks that one". v1 makes the conclusion carry
 * native consequences instead of asking a prompt to be conscientious about them: a FAIL puts the
 * subject back to OPEN, files a defect subtask under it, and stops the work that depends on it.
 *
 * One pure function over one snapshot, like §13.1's aggregation beside it — but unlike aggregation
 * these consequences are NOT a recomputation. Reverting a task, creating a subtask and raising a
 * condition are each writes that mean something different the second time, so they take a
 * permanent action key (§8.2) and this function's job is to say exactly which one:
 *
 *   pc:v1:<projectId>:verdict:<verifierTaskId>:<verdictRevision>
 *
 * The revision is the whole of V7 and the reason the key is not built from the verdict value. A
 * verdict has three states and a re-run can return to one it already held: `FAIL -> somebody fixes
 * it -> run the check again -> FAIL` would, keyed on the value, produce the SAME key as the first
 * FAIL, be skipped as already applied, and leave the subject sitting at DONE with no new defect
 * and nothing downstream stopped. Keyed on a revision that only advances when a conclusion is
 * actually reached, the same snapshot delivered twice collides (V2) and a genuinely new conclusion
 * does not (V4).
 *
 * The ids here are Base62 throughout, because a plan is audit material. The one place the internal
 * UUID appears is the action key, which is what the ledger's uniqueness is declared on; see
 * `verificationVerdictActionKey`.
 */

import { AggregationTaskStatus, TaskVerdictValue } from './task-aggregation';
import { taskRetirement } from '../tasks/task-supersession';
import { verificationVerdictActionKeyOf } from '../tasks/verification-dependency';

/** One verification task as this reads it, plus what its subject and its last run look like. */
export interface VerificationVerdictFact {
  /** The VERIFIER's id. */
  id: string;
  status: AggregationTaskStatus;
  /** The subject it names, or null on a task that verifies nothing. */
  verifiesTaskId: string | null;
  verdict: TaskVerdictValue | null;
  /** Decimal string, as BigInt columns cross the snapshot boundary everywhere else here. */
  verdictRevision: string;
  /**
   * Whether a run of this verification task is still in flight.
   *
   * V5, and the lesson is specific: this must never be derived from `numTurns`. That counter is
   * written when a turn ENDS while a task is normally marked DONE from inside the turn doing the
   * work, so "turns == 0" reads as "never executed" on precisely the runs that did execute. The
   * question here is the other one anyway — not "did it run" but "has it stopped running" — and
   * the answer is the linked Session's own terminal state.
   */
  hasLiveSession: boolean;
  /** The verifier's last run, for the record the defect subtask carries. Null if it never ran. */
  session: VerificationSessionEvidence | null;
  /**
   * §13.6 SU6's two columns for the VERIFIER. Optional: absent on a snapshot captured before 0129,
   * which reads as "nothing retired this check" — what every one of those rows was.
   */
  supersededByTaskId?: string | null;
  terminalReason?: string | null;
}

/** A verifier's last run, by its natural terminal state — never by a turn count (V5). */
export interface VerificationSessionEvidence {
  id: string;
  runStatus: string;
  finishedAt: string | null;
  /** Hashes, not text: V1 puts the verdict in a structured column, not in free prose. */
  resultHash: string | null;
  errorHash: string | null;
}

/** One subject as the plan needs it: enough to say whether reverting it is even meaningful. */
export interface VerificationSubjectFact {
  id: string;
  status: AggregationTaskStatus;
  /** §13.6 SU6 for the SUBJECT, same optionality and same reason as on the verifier. */
  supersededByTaskId?: string | null;
  terminalReason?: string | null;
}

export type VerificationVerdictSkipReason =
  | 'NOT_A_VERIFICATION'
  | 'NO_VERDICT'
  | 'NOT_CONCLUDED'
  | 'RUN_IN_FLIGHT'
  | 'SUBJECT_MISSING'
  | 'UNREVISIONED_VERDICT'
  /**
   * §13.6 SU6: this CHECK was replaced or abandoned. Its conclusion is history — the re-run that
   * took over reaches its own, and applying this one would revert a subject, file a defect and wake
   * a person over a finding somebody has already superseded.
   */
  | 'VERIFIER_RETIRED'
  /**
   * §13.6 SU6: the WORK this check was about was replaced. Reverting it is meaningless (nothing
   * will dispatch it again) and the defect subtask would be filed under an attempt nobody is doing
   * — a work item that can never be closed, holding acceptance open for as long as it exists.
   */
  | 'SUBJECT_RETIRED';

/** The mechanical consequences §13.2's table gives this verdict. */
export interface VerificationVerdictConsequences {
  /** FAIL only: DONE -> OPEN on the subject. */
  revertSubject: boolean;
  /** FAIL only: one defect subtask under the subject, carrying the failure evidence. */
  fileDefect: boolean;
  /** FAIL only: the tasks depending on the subject stop being dispatchable. */
  blockDownstream: boolean;
  /** FAIL and INCONCLUSIVE: a durable, auditable VERIFICATION_FAILED condition. */
  raiseCondition: boolean;
  /** PASS only: every unresolved condition about this subject is resolved. */
  resolveConditions: boolean;
  /** FAIL and INCONCLUSIVE: §7.2's `VERDICT` row is a semantic turn, not a mechanical action. */
  opensCoordinatorTurn: boolean;
}

export interface PlannedVerificationVerdict {
  verifierTaskId: string;
  subjectTaskId: string;
  verdict: TaskVerdictValue;
  verdictRevision: string;
  consequences: VerificationVerdictConsequences;
  /** Exactly what this conclusion rests on, in Base62, ready to store on the condition row. */
  evidence: {
    v: 1;
    verifierTaskId: string;
    subjectTaskId: string;
    verdict: TaskVerdictValue;
    verdictRevision: string;
    verifierStatus: AggregationTaskStatus;
    subjectStatus: AggregationTaskStatus;
    session: VerificationSessionEvidence | null;
  };
}

export interface SkippedVerificationVerdict {
  verifierTaskId: string;
  reason: VerificationVerdictSkipReason;
}

export interface VerificationVerdictPlan {
  /** Sorted by verifier id, so the same snapshot always produces byte-identical audit. */
  verdicts: PlannedVerificationVerdict[];
  skipped: SkippedVerificationVerdict[];
}

/**
 * The permanent identity of one conclusion's consequences (§7.3 / §8.2).
 *
 * Internal UUIDs, because this is the ledger's unique key and `ProjectReconcileService` requires
 * every key to be scoped by the Project's own UUID. It never reaches a client in that form: the
 * decision audit rewrites every UUID it finds in a string to Base62 on the way out.
 */
export function verificationVerdictActionKey(
  projectId: string,
  verifierTaskId: string,
  verdictRevision: string | bigint | number,
): string {
  // Delegated rather than spelled twice: §13.3 DEP4 reads this key back out of the ledger to ask
  // whether a conclusion has actually been applied, and it has to ask for the byte-identical
  // string this writer minted. One template, two callers.
  return verificationVerdictActionKeyOf(projectId, verifierTaskId, verdictRevision);
}

/** The deterministic key that makes "one defect per conclusion" a database fact, not a habit. */
export function verificationDefectIdempotencyKey(
  projectId: string,
  verifierTaskId: string,
  verdictRevision: string | bigint | number,
): string {
  return `pc:v1:${projectId}:verdict-defect:${verifierTaskId}:${verdictRevision}`;
}

/**
 * Every verdict in `verifications` whose consequences are due, and why each of the rest is not.
 *
 * The skips are returned rather than filtered away because "this verdict did nothing" is the
 * answer somebody will need, and the alternative is reading it out of an absence.
 */
export function planVerificationVerdicts(
  verifications: readonly VerificationVerdictFact[],
  subjects: readonly VerificationSubjectFact[],
): VerificationVerdictPlan {
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const verdicts: PlannedVerificationVerdict[] = [];
  const skipped: SkippedVerificationVerdict[] = [];

  for (const fact of [...verifications].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const skip = skipReason(fact, subjectById);
    if (skip) {
      skipped.push({ verifierTaskId: fact.id, reason: skip });
      continue;
    }
    const subject = subjectById.get(fact.verifiesTaskId!)!;
    const verdict = fact.verdict!;
    verdicts.push({
      verifierTaskId: fact.id,
      subjectTaskId: subject.id,
      verdict,
      verdictRevision: fact.verdictRevision,
      consequences: consequencesOf(verdict),
      evidence: {
        v: 1,
        verifierTaskId: fact.id,
        subjectTaskId: subject.id,
        verdict,
        verdictRevision: fact.verdictRevision,
        verifierStatus: fact.status,
        subjectStatus: subject.status,
        session: fact.session,
      },
    });
  }
  return { verdicts, skipped };
}

/**
 * `(verifierTaskId, verdictRevision, verdict)`, sorted — §7.2's `turnFacts` for the `VERDICT` row.
 *
 * The revision is in here on purpose (TF4): it is a lifecycle generation, not an observation
 * count, so the same world delivered N times digests identically while a genuinely new conclusion
 * on the same verifier does not. Without it a second failure of the same check looks byte-for-byte
 * like the first and the coordinator never gets woken for it.
 */
export function verificationVerdictTurnFacts(
  plan: VerificationVerdictPlan,
): Array<[string, string, TaskVerdictValue]> {
  return plan.verdicts
    .filter((planned) => planned.consequences.opensCoordinatorTurn)
    .map((planned) => [planned.verifierTaskId, planned.verdictRevision, planned.verdict] as
      [string, string, TaskVerdictValue])
    .sort((a, b) => (a[0] === b[0] ? Number(BigInt(a[1]) - BigInt(b[1])) : a[0] < b[0] ? -1 : 1));
}

function skipReason(
  fact: VerificationVerdictFact,
  subjects: ReadonlyMap<string, VerificationSubjectFact>,
): VerificationVerdictSkipReason | null {
  if (!fact.verifiesTaskId) return 'NOT_A_VERIFICATION';
  if (!fact.verdict) return 'NO_VERDICT';
  // V1: the carrier is the verification task's own TERMINAL state plus a structured result. A
  // check that has concluded but not finished has not concluded.
  if (fact.status !== 'DONE') return 'NOT_CONCLUDED';
  if (fact.hasLiveSession) return 'RUN_IN_FLIGHT';
  // §13.6 SU6, both sides, before the subject is even looked up: neither a replaced check nor a
  // finding about replaced work may produce a consequence. Each has its own reason because they
  // send a reader to different places — "the re-run is over there" and "that work is being done
  // over there" are different sentences.
  if (taskRetirement({
    supersededByTaskId: fact.supersededByTaskId ?? null,
    terminalReason: fact.terminalReason ?? null,
  }) != null) {
    return 'VERIFIER_RETIRED';
  }
  // V6: the subject can be deleted while its check runs — fixtures take whole trees with them.
  // Planning nothing here is the quiet half; the action that races the delete records SUPERSEDED.
  const subject = subjects.get(fact.verifiesTaskId);
  if (!subject) return 'SUBJECT_MISSING';
  if (taskRetirement({
    supersededByTaskId: subject.supersededByTaskId ?? null,
    terminalReason: subject.terminalReason ?? null,
  }) != null) {
    return 'SUBJECT_RETIRED';
  }
  // A verdict written before migration 0124 has no revision, so it has no action identity. It is
  // not lost — the next conclusion on that verifier advances the counter and carries it.
  if (!(BigInt(fact.verdictRevision) > 0n)) return 'UNREVISIONED_VERDICT';
  return null;
}

function consequencesOf(verdict: TaskVerdictValue): VerificationVerdictConsequences {
  if (verdict === 'PASS') {
    return {
      revertSubject: false,
      fileDefect: false,
      blockDownstream: false,
      raiseCondition: false,
      resolveConditions: true,
      opensCoordinatorTurn: false,
    };
  }
  const failed = verdict === 'FAIL';
  return {
    // INCONCLUSIVE deliberately reverts nothing and files nothing: "we could not tell" is not a
    // finding, and manufacturing a defect subtask out of it would put work in the tree that
    // nobody can close. It still leaves the condition, and it still wakes the coordinator.
    revertSubject: failed,
    fileDefect: failed,
    blockDownstream: failed,
    raiseCondition: true,
    resolveConditions: false,
    opensCoordinatorTurn: true,
  };
}
