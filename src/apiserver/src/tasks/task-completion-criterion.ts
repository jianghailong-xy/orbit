import type { TaskCompletionPolicyValue, TaskVerdictValue } from '../projects/task-aggregation';

/**
 * The four peer ways a task may declare how its work is proved complete.
 *
 * All four have an implementation. EXECUTABLE compares one exit code and VERIFICATION reads an
 * independent verdict; EVIDENCE_JUDGMENT, whose machinery the account owner had removed on
 * 2026-09-02, reads one CONFIRM decision made against the current revision of the task's
 * completion evidence by a session that did not do the work. OWNER_CONFIRMED reads the newest
 * decision the account owner recorded about the task from the app, which no session can record.
 * `evaluateTaskCompletion` is where each of those answers is stated.
 */
export const TASK_COMPLETION_CRITERIA = [
  'EXECUTABLE',
  'VERIFICATION',
  'EVIDENCE_JUDGMENT',
  'OWNER_CONFIRMED',
] as const;

export type TaskCompletionCriterionValue = (typeof TASK_COMPLETION_CRITERIA)[number];

/** Rows written by the current service are protected by migration 0193's canonical DONE fence. */
export const TASK_COMPLETION_FENCE_REVISION = 1;

export interface TaskCompletionDeclaration {
  completionCriterion?: TaskCompletionCriterionValue | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  /**
   * How long acceptanceCommand may run, in seconds; null/absent is the runner's own default.
   *
   * Part of the declaration rather than a separate concern because it is only meaningful next to
   * a command, and because the database says the same thing: 0236's
   * `task_acceptance_timeout_shape_check` refuses a budget on a task that declares no EXECUTABLE
   * command. Validating it here is what turns that constraint into a sentence instead of a 500.
   *
   * It bounds the run and decides nothing about it. A command killed at this budget reports -1
   * and -1 is compared with acceptanceExpectedExitCode like any other integer.
   */
  acceptanceTimeoutSeconds?: number | null;
  completionPolicy?: TaskCompletionPolicyValue | null;
  /** A verifier task points at another task; it cannot simultaneously own executable acceptance. */
  verifiesTaskId?: string | null;
}

/**
 * Compatibility resolution for callers that predate completionCriterion.
 *
 * A caller that sends the old executable pair or VERIFICATION_PASSED policy keeps the meaning it
 * explicitly requested. A completely undeclared task is EVIDENCE_JUDGMENT. This is not a runtime
 * fallback: the function runs once while constructing the declaration.
 */
export function resolveTaskCompletionCriterion(
  declaration: TaskCompletionDeclaration,
): TaskCompletionCriterionValue {
  if (declaration.completionCriterion != null) return declaration.completionCriterion;
  // A verifier is itself a small piece of work whose output is its verdict.  Its role is already
  // explicit in the relation, so callers must not have to opt it into a second, human criterion.
  if (declaration.verifiesTaskId != null) return 'VERIFICATION';
  if (
    declaration.acceptanceCommand != null
    || declaration.acceptanceExpectedExitCode != null
  ) return 'EXECUTABLE';
  if (declaration.completionPolicy === 'VERIFICATION_PASSED') return 'VERIFICATION';
  return 'EVIDENCE_JUDGMENT';
}

/**
 * Returns the public refusal reason for a malformed declaration, or null when it is coherent.
 * Kept pure so REST, batch creation and later status derivation share one definition.
 *
 * VERIFICATION is where the two columns say different things, and both are legal. The criterion
 * names WHO settles the task — an independent verdict — while the policy says whether anything
 * other than this row's own work is involved in getting there:
 *
 *  - `VERIFICATION` + `VERIFICATION_PASSED` + no subject: a gate row. It has no work to dispatch,
 *    and a PASS recorded against it is its whole lifecycle.
 *  - `VERIFICATION` + `MANUAL` + no subject: a work row. It runs, and a separate session's verdict
 *    rather than its own run is what settles it.
 *  - `VERIFICATION` + `MANUAL` + a subject: the verifier itself.
 */
export function taskCompletionDeclarationError(
  declaration: TaskCompletionDeclaration,
): string | null {
  const command = declaration.acceptanceCommand ?? null;
  const expectedExitCode = declaration.acceptanceExpectedExitCode ?? null;
  if ((command == null) !== (expectedExitCode == null)) {
    return 'acceptanceCommand and acceptanceExpectedExitCode must be set or cleared together';
  }
  if (command != null && command.trim() === '') {
    return 'acceptanceCommand must not be blank';
  }
  const timeoutSeconds = declaration.acceptanceTimeoutSeconds ?? null;
  if (timeoutSeconds != null) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
      return 'acceptanceTimeoutSeconds must be a whole number of seconds from 1 to 86400';
    }
    if (command == null) {
      return 'acceptanceTimeoutSeconds bounds acceptanceCommand, so it cannot be set without one';
    }
  }

  const criterion = resolveTaskCompletionCriterion(declaration);
  const policy = declaration.completionPolicy ?? 'MANUAL';
  switch (criterion) {
    case 'EXECUTABLE':
      if (command == null) {
        return 'EXECUTABLE requires acceptanceCommand and acceptanceExpectedExitCode';
      }
      if (policy !== 'MANUAL') {
        return 'EXECUTABLE requires completionPolicy MANUAL';
      }
      if (declaration.verifiesTaskId != null) {
        return 'A verification task cannot use EXECUTABLE completion';
      }
      return null;
    case 'VERIFICATION':
      if (command != null) {
        return 'VERIFICATION cannot also declare executable acceptance';
      }
      if (declaration.verifiesTaskId != null) {
        if (policy !== 'MANUAL') {
          return 'A verification task requires completionPolicy MANUAL';
        }
      } else if (policy === 'ALL_CHILDREN_DONE') {
        // The one pair that would give this row two completion owners. VERIFICATION says a verdict
        // settles it and ALL_CHILDREN_DONE says its subtasks do; `recomputeTask` reads the criterion
        // first and treats every non-`VERIFICATION_PASSED` policy as "verified", so the pair would
        // write DONE on the next reconcile with no verdict recorded anywhere.
        return 'VERIFICATION cannot use completionPolicy ALL_CHILDREN_DONE';
      }
      return null;
    case 'EVIDENCE_JUDGMENT':
      if (command != null) {
        return 'EVIDENCE_JUDGMENT cannot also declare executable acceptance';
      }
      if (policy === 'VERIFICATION_PASSED') {
        return 'EVIDENCE_JUDGMENT cannot use completionPolicy VERIFICATION_PASSED';
      }
      if (declaration.verifiesTaskId != null) {
        return 'A verification task must use VERIFICATION completion';
      }
      return null;
    case 'OWNER_CONFIRMED':
      if (command != null) {
        return 'OWNER_CONFIRMED cannot also declare executable acceptance';
      }
      if (policy !== 'MANUAL') {
        return 'OWNER_CONFIRMED requires completionPolicy MANUAL';
      }
      if (declaration.verifiesTaskId != null) {
        return 'A verification task must use VERIFICATION completion';
      }
      return null;
  }
}

/** The stored code and remedy for declaring the third criterion on work that is in no project. */
export const EVIDENCE_JUDGMENT_REQUIRES_PROJECT_CODE = 'EVIDENCE_JUDGMENT_REQUIRES_PROJECT';
export const EVIDENCE_JUDGMENT_REQUIRES_PROJECT_ACTION =
  'FILE_UNDER_A_PROJECT_OR_DECLARE_ANOTHER_CRITERION';

/**
 * Why EVIDENCE_JUDGMENT cannot be DECLARED on work that is filed under no project, or null.
 *
 * This is a rule about what may be written, not about what may be decided. A task already in this
 * state is decided against its own `acceptanceCriteria` (`task-evidence-envelope.ts`), and that
 * lane keeps working — the rows on the deployed server depend on it, and it is why the two ways
 * out named below are edits rather than a deletion.
 *
 * What it refuses is arriving there by default. EVIDENCE_JUDGMENT is the criterion an undeclared
 * task falls back to, so standalone work an agent files lands on it without anybody choosing it,
 * and it then holds only while the task ALSO carries acceptance criteria its evidence quotes
 * verbatim — a second condition nothing at declaration time asks for. A task filed under a project
 * has no such gap: the standard is one the project states and `project_get` hands out.
 *
 * Pure, and separate from `taskCompletionDeclarationError` above, because the fact it reads is not
 * part of the declaration: where work is FILED is decided by the scope contract after the
 * declaration has already been validated, and the three write doors have to ask this question
 * about the project each of them actually lands in.
 */
export function criterionNeedsProjectRefusal(declaration: {
  completionCriterion?: TaskCompletionCriterionValue | null;
  projectId?: string | null;
}): { code: string; kind: 'REFUSAL'; requiredAction: string; message: string } | null {
  if (declaration.completionCriterion !== 'EVIDENCE_JUDGMENT') return null;
  if (declaration.projectId) return null;
  return {
    code: EVIDENCE_JUDGMENT_REQUIRES_PROJECT_CODE,
    kind: 'REFUSAL',
    requiredAction: EVIDENCE_JUDGMENT_REQUIRES_PROJECT_ACTION,
    message:
      'EVIDENCE_JUDGMENT is settled by one CONFIRM measured against a stated acceptance criterion, '
      + 'and this task is in no project, so the only standard it could be held to is whatever it '
      + 'happens to have written in its own acceptanceCriteria — which nothing here requires it to '
      + 'have, and which its evidence would then have to quote word for word. Give this work a '
      + 'projectId, so the criterion it serves is one the project states and a decider can read; '
      + 'or declare EXECUTABLE with acceptanceCommand and acceptanceExpectedExitCode, which it can '
      + 'settle without one.',
  };
}

/** The stored code and remedy for a verification subject that is in no project. */
export const VERIFICATION_SUBJECT_REQUIRES_PROJECT_CODE = 'VERIFICATION_SUBJECT_REQUIRES_PROJECT';
export const VERIFICATION_SUBJECT_REQUIRES_PROJECT_ACTION =
  'FILE_UNDER_A_PROJECT_OR_DECLARE_EXECUTABLE';

/**
 * Why a verification SUBJECT cannot be written into no project, or null.
 *
 * A subject declares VERIFICATION and verifies nothing itself: it is settled only by a PASS that a
 * separate task pointing at it records, and its own run — if its policy gives it one at all — can
 * never produce that. (A `VERIFICATION_PASSED` subject has no run: a manual start is refused and
 * auto-dispatch passes it by. A `MANUAL` one does its own work and still waits for the same PASS,
 * which is why both are refused here.) Nothing on the server files that task for it:
 * `fileVerification` checks work that is already DONE, which a subject never becomes on its own.
 * Inside a project the coordinator files and starts the verification; outside one there is no
 * coordinator and no screen that writes `verifiesTaskId`, so the subject would wait for a check
 * nobody is going to file.
 *
 * A rule about what may be written, like `criterionNeedsProjectRefusal` above, but asked of one
 * more write: a project-less EVIDENCE_JUDGMENT row still settles against its own acceptanceCriteria,
 * while a subject taken out of its project is stranded exactly as one declared outside it.
 *
 * A verifier is never refused here. Its own verdict settles it, and `fileVerification` files its
 * `[VERIFY]` tasks in whatever project their subject is in, including none.
 */
export function verificationSubjectNeedsProjectRefusal(declaration: {
  completionCriterion?: TaskCompletionCriterionValue | null;
  verifiesTaskId?: string | null;
  projectId?: string | null;
}): { code: string; kind: 'REFUSAL'; requiredAction: string; message: string } | null {
  if (declaration.completionCriterion !== 'VERIFICATION') return null;
  if (declaration.verifiesTaskId != null) return null;
  if (declaration.projectId) return null;
  return {
    code: VERIFICATION_SUBJECT_REQUIRES_PROJECT_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFICATION_SUBJECT_REQUIRES_PROJECT_ACTION,
    message:
      'VERIFICATION with no verifiesTaskId makes this task a subject: whatever its own run does, '
      + 'only a PASS recorded by a separate verification task pointing at it can settle it. Nothing '
      + 'files that verification task automatically, and this task is in no project, so there is no '
      + 'coordinator to create and start one — it would wait for a check nobody is going to file. '
      + 'Give this work a projectId, so its project\'s coordinator can file and start the '
      + 'verification; or declare EXECUTABLE with acceptanceCommand and '
      + 'acceptanceExpectedExitCode, which it can settle on its own.',
  };
}

export interface TaskCompletionFacts {
  /** Required, and not nullable: evaluating a criterion begins with knowing which one was declared. */
  completionCriterion: TaskCompletionCriterionValue;
  /** 0177's declared expectation. Half a declaration is refused above, so in practice this is
   *  present exactly when the task declares EXECUTABLE. */
  acceptanceExpectedExitCode?: number | null;
  /** The exit code the acceptance command actually returned, carried in memory from the runner
   *  callback to this comparison and then dropped. Nothing stores it. */
  executableExitCode?: number | null;
  /** The subject-facing result of an independent verifier. Only PASS settles the subject. */
  verificationVerdict?: TaskVerdictValue | null;
  /** Non-null identifies this task as the verifier carrier rather than the verified subject. */
  verifiesTaskId?: string | null;
  /** A verifier's own result. Any conclusion settles the carrier activity. */
  ownVerdict?: TaskVerdictValue | null;
  /**
   * The newest revision of this task's completion evidence, or null when none was submitted.
   *
   * The ledger is append-only, so its latest revision is the one a judgment has to be about: a
   * decision naming an earlier one answers a question a later submission has already replaced.
   */
  latestEvidenceRevision?: bigint | null;
  /** The evidence revision an independent session's CONFIRM decision answers, when one exists. */
  confirmedEvidenceRevision?: bigint | null;
  /**
   * The newest decision the account owner recorded about this task, or null when there is none.
   *
   * Only the owner's own app credential, with no session behind the request, can record one
   * (`task-owner-confirmation.ts`), so a CONFIRM here is the owner saying the work is done and not
   * a run reporting that about itself.
   */
  ownerDecision?: 'CONFIRM' | 'SEND_BACK' | null;
}

export interface TaskCompletionEvaluation {
  criterion: TaskCompletionCriterionValue;
  state: 'SATISFIED' | 'UNSATISFIED' | 'ACTIONABLE';
  satisfied: boolean;
}

/**
 * The only optimistic Task.status this criterion boundary can produce.
 *
 * `null` is deliberate: an unsatisfied criterion does not guess whether the task is OPEN,
 * IN_PROGRESS or FAILED. Those states still describe work/run outcomes. DONE is different — it
 * authorises downstream work — so callers may obtain it only by presenting a satisfied criterion.
 */
export type DerivedTaskCompletionStatus = 'DONE' | null;

export type TaskLifecycleStatusValue =
  | 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FAILED';

/**
 * Evaluate one declared criterion. It observes facts only and never writes Task.status.
 *
 * EXECUTABLE is one comparison and nothing else. On 2026-09-03 the account owner asked for the
 * exit-code decision back — "根据 exit code 来简单判断，不需要实际记录数据" — so the two facts it
 * reads arrive as arguments and are gone when this returns. No ledger, no attempt row, no typed
 * termination: a command that timed out, was cancelled or died on a signal is indistinguishable
 * here from one that ran and returned the wrong code, and all of them are UNSATISFIED. That is
 * the accepted cost of storing nothing.
 *
 * ACTIONABLE is the third answer and is not a failure: with either side of the comparison
 * missing there is no comparison, so the goal stays open rather than being guessed wrong.
 *
 * The criterion itself is not one of the facts that may be missing. It used to fall back to
 * EVIDENCE_JUDGMENT when absent, which meant this evaluator answered about a criterion the task had
 * never declared; the column is NOT NULL and, since 0237, carries no default, so there is no such
 * task to be lenient towards.
 *
 * EVIDENCE_JUDGMENT is two revisions compared, and the comparison lives here for the same reason
 * EXECUTABLE's does: a caller allowed to hand in "somebody confirmed something" would be deciding
 * the criterion instead of declaring facts to it. What satisfies it is a CONFIRM decision whose
 * evidence revision is still the task's latest. Nothing submitted, nothing decided, a SEND_BACK,
 * and a CONFIRM of a revision a later submission superseded are one answer, UNSATISFIED — an
 * unjudged claim is not an uncomparable one, so this criterion has no ACTIONABLE arm.
 *
 * Whether the decider was independent is deliberately NOT re-derived here. That is checked where
 * the decision is written, against this task's whole session history and the authorship of its
 * evidence; this function reads the row that check produced.
 *
 * OWNER_CONFIRMED is the account owner's newest decision about the task being a CONFIRM. Who may
 * record one is checked at its door for the same reason independence is checked at the evidence
 * door: this function is handed the decision, never the credential that made it.
 *
 * Every criterion keeps its own explicit arm and the switch has no default, which is what makes a
 * fourth criterion unable to silently inherit somebody else's answer.
 */
export function evaluateTaskCompletion(
  facts: TaskCompletionFacts,
): TaskCompletionEvaluation {
  const criterion = facts.completionCriterion;
  let state: TaskCompletionEvaluation['state'];
  switch (criterion) {
    case 'EXECUTABLE':
      // Either side absent is "nothing was compared", which is what an older runner that omits
      // the field, or a turn that never ran, produces. The caller keeps that separable from a
      // comparison that happened and disagreed: only the latter is a conservative FAILED.
      state = (facts.executableExitCode == null || facts.acceptanceExpectedExitCode == null)
        ? 'ACTIONABLE'
        : (facts.executableExitCode === facts.acceptanceExpectedExitCode
          ? 'SATISFIED'
          : 'UNSATISFIED');
      break;
    case 'VERIFICATION':
      state = (facts.verifiesTaskId != null
        ? facts.ownVerdict != null
        : facts.verificationVerdict === 'PASS') ? 'SATISFIED' : 'UNSATISFIED';
      break;
    case 'EVIDENCE_JUDGMENT':
      // Present AND equal: a confirmed revision that is no longer the latest is an answer about
      // evidence that has since been replaced, which settles the version nobody is asking about.
      state = (facts.confirmedEvidenceRevision != null
        && facts.confirmedEvidenceRevision === facts.latestEvidenceRevision)
        ? 'SATISFIED'
        : 'UNSATISFIED';
      break;
    case 'OWNER_CONFIRMED':
      // The owner's newest word about the task, and nothing else. No decision, a SEND_BACK, and
      // every other criterion's satisfied fact are one answer: a run that reports success is not
      // the owner saying so, which is the whole of what separates this criterion from the others.
      state = facts.ownerDecision === 'CONFIRM' ? 'SATISFIED' : 'UNSATISFIED';
      break;
  }
  return { criterion, state, satisfied: state === 'SATISFIED' };
}

/** Project a criterion evaluation onto Task.status without creating a second predicate. */
export function deriveTaskCompletionStatus(
  facts: TaskCompletionFacts,
): DerivedTaskCompletionStatus {
  return evaluateTaskCompletion(facts).satisfied ? 'DONE' : null;
}

/**
 * Project a verifier role, verdict or status edit onto its carrier lifecycle.
 *
 * The generic evaluator owns the positive predicate.  This projector adds only the inverse edge:
 * when the fact that derived DONE is explicitly revoked, an otherwise-unspecified carrier returns
 * to OPEN.  A caller may provide another conservative status while revoking (for example a
 * simultaneous cancellation); that explicit lifecycle outcome is preserved.
 */
export function projectVerifierCarrierStatus(facts: {
  verifiesTaskId?: string | null;
  currentStatus: TaskLifecycleStatusValue;
  currentVerdict?: TaskVerdictValue | null;
  nextVerdict?: TaskVerdictValue | null;
  currentTerminalReason: string | null;
  nextTerminalReason: string | null;
  currentSupersededByTaskId: string | null;
  nextSupersededByTaskId: string | null;
  /** This write turns an ordinary task into a verifier. Its former DONE fact no longer applies. */
  roleAttached: boolean;
  verdictChanged: boolean;
  requestedStatus?: TaskLifecycleStatusValue;
}): TaskLifecycleStatusValue | null {
  if (facts.verifiesTaskId == null) return null;
  const retirementChanged =
    facts.currentTerminalReason !== facts.nextTerminalReason
    || facts.currentSupersededByTaskId !== facts.nextSupersededByTaskId;
  // A status edit also crosses the projection boundary: an existing verdict still owns DONE, so
  // CANCELLED/FAILED cannot be accepted and then silently rewritten by the database projector.
  if (!facts.roleAttached && !facts.verdictChanged && facts.requestedStatus === undefined
    && !retirementChanged) return null;
  const completed = deriveTaskCompletionStatus({
    completionCriterion: 'VERIFICATION',
    verifiesTaskId: facts.verifiesTaskId,
    ownVerdict: facts.nextVerdict,
  });
  if (completed) {
    // A requested non-DONE status still crosses the derived-status boundary and must be refused,
    // even while the carrier is retired.  With no status edit, clearing the last retirement fact
    // makes a non-cancelled carrier active again, so its retained verdict immediately owns DONE.
    if (facts.requestedStatus !== undefined) return completed;
    if (facts.nextTerminalReason == null && facts.nextSupersededByTaskId == null
      && facts.currentStatus !== 'CANCELLED') return completed;
  }
  if (facts.roleAttached && facts.currentStatus === 'DONE') {
    return facts.requestedStatus ?? 'OPEN';
  }
  if (!facts.verdictChanged) return null;
  if (facts.currentVerdict != null && facts.nextVerdict == null
    && facts.currentStatus === 'DONE') {
    return facts.requestedStatus ?? 'OPEN';
  }
  return null;
}

/**
 * The executable remedy returned when somebody tries to write DONE directly.
 *
 * This belongs beside the predicate so a new criterion cannot be added with a generic "not
 * allowed" wall. Every refusal must tell the caller which fact can actually complete this task.
 */
export function taskCompletionRequiredAction(
  criterion: TaskCompletionCriterionValue,
  role: { verifiesTaskId?: string | null } = {},
): { requiredAction: string; instruction: string } {
  switch (criterion) {
    case 'EXECUTABLE':
      return {
        requiredAction: 'RUN_ACCEPTANCE_COMMAND',
        instruction:
          'let the declared acceptanceCommand run to completion; Orbit compares the exit code it ' +
          'returns against acceptanceExpectedExitCode and derives DONE when they are equal, ' +
          'FAILED when they are not. Nothing else writes this status, and nothing about the run ' +
          'is recorded — read the session to see what the command printed',
      };
    case 'VERIFICATION':
      if (role.verifiesTaskId != null) {
        return {
          requiredAction: 'RECORD_VERIFICATION_VERDICT',
          instruction:
            'record PASS, FAIL or INCONCLUSIVE on this verification task; any verdict concludes ' +
            'the verifier carrier, while only PASS can settle the subject',
        };
      }
      return {
        requiredAction: 'OBTAIN_INDEPENDENT_VERIFICATION_PASS',
        instruction:
          'complete an independent verification task with verdict PASS; Orbit derives the ' +
          'subject status from that verification fact',
      };
    case 'EVIDENCE_JUDGMENT':
      return {
        requiredAction: 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION',
        instruction:
          'submit this task\'s completion evidence, then let a session that did not do the work ' +
          'decide the revision you submitted; Orbit derives DONE from a CONFIRM of the revision ' +
          'that is current when it is made, and a SEND_BACK leaves the task open for the next one',
      };
    case 'OWNER_CONFIRMED':
      return {
        requiredAction: 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP',
        instruction:
          'only the account owner can settle this task, by pressing Confirm done in the Orbit app — ' +
          'on the confirmation card in the task\'s own session once a run of it has ended its turn, ' +
          'or in the task\'s detail panel when no run is waiting — and Orbit derives DONE from that ' +
          'recorded decision. No agent session can record it, a coordinator included: finish the ' +
          'work, say in the session what was done, and end the turn. A Send back from the owner ' +
          'arrives in that same session as their next message and leaves the task open',
      };
  }
}
