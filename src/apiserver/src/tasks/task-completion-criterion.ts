import type { TaskCompletionPolicyValue, TaskVerdictValue } from '../projects/task-aggregation';
import type { AttemptTerminationKind } from './executable-acceptance-runtime';

/** The three peer ways a task may prove its own work complete. */
export const TASK_COMPLETION_CRITERIA = [
  'EXECUTABLE',
  'VERIFICATION',
  'HUMAN_SIGNOFF',
] as const;

export type TaskCompletionCriterionValue = (typeof TASK_COMPLETION_CRITERIA)[number];

/** Rows written by the current service are protected by migration 0193's canonical DONE fence. */
export const TASK_COMPLETION_FENCE_REVISION = 1;

export interface TaskCompletionDeclaration {
  completionCriterion?: TaskCompletionCriterionValue | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  acceptanceTimeoutSeconds?: number | null;
  acceptanceOwnerTimeoutCeilingSeconds?: number | null;
  completionPolicy?: TaskCompletionPolicyValue | null;
  /** A verifier task points at another task; it cannot simultaneously own executable acceptance. */
  verifiesTaskId?: string | null;
}

/**
 * Compatibility resolution for callers that predate completionCriterion.
 *
 * A caller that sends the old executable pair or VERIFICATION_PASSED policy keeps the meaning it
 * explicitly requested. A completely undeclared task is HUMAN_SIGNOFF. This is not a runtime
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
  return 'HUMAN_SIGNOFF';
}

/**
 * Returns the public refusal reason for a malformed declaration, or null when it is coherent.
 * Kept pure so REST, batch creation and later status derivation share one definition.
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
  const timeout = declaration.acceptanceTimeoutSeconds ?? null;
  const ownerCeiling = declaration.acceptanceOwnerTimeoutCeilingSeconds ?? null;
  if (timeout == null && ownerCeiling != null) {
    return 'acceptanceOwnerTimeoutCeilingSeconds requires acceptanceTimeoutSeconds';
  }
  if (timeout != null && command == null) {
    return 'acceptanceTimeoutSeconds requires executable acceptance';
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
      } else if (policy !== 'VERIFICATION_PASSED') {
        return 'A subject using VERIFICATION requires completionPolicy VERIFICATION_PASSED';
      }
      return null;
    case 'HUMAN_SIGNOFF':
      if (command != null) {
        return 'HUMAN_SIGNOFF cannot also declare executable acceptance';
      }
      if (policy === 'VERIFICATION_PASSED') {
        return 'HUMAN_SIGNOFF cannot use completionPolicy VERIFICATION_PASSED';
      }
      if (declaration.verifiesTaskId != null) {
        return 'A verification task must use VERIFICATION completion';
      }
      return null;
  }
}

export interface TaskCompletionFacts {
  /** Null is accepted at this pure boundary solely for rolling/migration compatibility. */
  completionCriterion?: TaskCompletionCriterionValue | null;
  acceptanceExpectedExitCode?: number | null;
  executableExitCode?: number | null;
  /** Present only for v2 attempts. An exit code is a criterion fact only when this is EXITED. */
  executableTerminationKind?: AttemptTerminationKind | null;
  /** Historical shell results deliberately remain untyped; in particular exit=-1 is not EXITED. */
  executableLegacyTermination?: 'UNTYPED' | null;
  /** The subject-facing result of an independent verifier. Only PASS settles the subject. */
  verificationVerdict?: TaskVerdictValue | null;
  /** Non-null identifies this task as the verifier carrier rather than the verified subject. */
  verifiesTaskId?: string | null;
  /** A verifier's own result. Any conclusion settles the carrier activity. */
  ownVerdict?: TaskVerdictValue | null;
  humanSignoff?: boolean;
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

/** Evaluate one declared criterion. It observes facts only and never writes Task.status. */
export function evaluateTaskCompletion(
  facts: TaskCompletionFacts,
): TaskCompletionEvaluation {
  const criterion = facts.completionCriterion ?? 'HUMAN_SIGNOFF';
  let state: TaskCompletionEvaluation['state'];
  switch (criterion) {
    case 'EXECUTABLE': {
      const termination = facts.executableTerminationKind ?? null;
      // A typed non-exit says why this attempt stopped, not whether the command would have met the
      // criterion. Likewise the legacy sentinel -1 never identified timeout vs cancel vs signal.
      if (
        (termination != null && termination !== 'EXITED')
        || facts.executableLegacyTermination === 'UNTYPED'
        || facts.executableExitCode === -1
        || facts.executableExitCode == null
        || facts.acceptanceExpectedExitCode == null
      ) {
        state = 'ACTIONABLE';
        break;
      }
      // Headerless/N-1 runners have no typed field. A real integer other than the historical -1
      // sentinel remains a comparable EXITED observation during rolling compatibility.
      state = facts.executableExitCode === facts.acceptanceExpectedExitCode
        ? 'SATISFIED'
        : 'UNSATISFIED';
      break;
    }
    case 'VERIFICATION':
      state = (facts.verifiesTaskId != null
        ? facts.ownVerdict != null
        : facts.verificationVerdict === 'PASS') ? 'SATISFIED' : 'UNSATISFIED';
      break;
    case 'HUMAN_SIGNOFF':
      state = facts.humanSignoff === true ? 'SATISFIED' : 'UNSATISFIED';
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
        requiredAction: 'RUN_EXECUTABLE_CRITERION',
        instruction:
          'finish the task run and let Orbit run its declared acceptanceCommand; the recorded ' +
          'exit code must equal acceptanceExpectedExitCode',
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
    case 'HUMAN_SIGNOFF':
      return {
        requiredAction: 'CREATE_HUMAN_SIGNOFF_WITH_EVIDENCE',
        instruction:
          'have the account owner decide the current HUMAN_SIGNOFF judgment request, binding ' +
          'task_signoff / POST /tasks/:id/signoff to its requestId and evidenceDigest',
      };
  }
}
