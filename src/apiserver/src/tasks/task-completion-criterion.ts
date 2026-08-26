import type { TaskCompletionPolicyValue, TaskVerdictValue } from '../projects/task-aggregation';

/** The three peer ways a task may prove its own work complete. */
export const TASK_COMPLETION_CRITERIA = [
  'EXECUTABLE',
  'VERIFICATION',
  'HUMAN_SIGNOFF',
] as const;

export type TaskCompletionCriterionValue = (typeof TASK_COMPLETION_CRITERIA)[number];

export interface TaskCompletionDeclaration {
  completionCriterion?: TaskCompletionCriterionValue | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
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
      if (policy !== 'VERIFICATION_PASSED') {
        return 'VERIFICATION requires completionPolicy VERIFICATION_PASSED';
      }
      return null;
    case 'HUMAN_SIGNOFF':
      if (command != null) {
        return 'HUMAN_SIGNOFF cannot also declare executable acceptance';
      }
      if (policy === 'VERIFICATION_PASSED') {
        return 'HUMAN_SIGNOFF cannot use completionPolicy VERIFICATION_PASSED';
      }
      return null;
  }
}

export interface TaskCompletionFacts {
  /** Null is accepted at this pure boundary solely for rolling/migration compatibility. */
  completionCriterion?: TaskCompletionCriterionValue | null;
  acceptanceExpectedExitCode?: number | null;
  executableExitCode?: number | null;
  verificationVerdict?: TaskVerdictValue | null;
  humanSignoff?: boolean;
}

export interface TaskCompletionEvaluation {
  criterion: TaskCompletionCriterionValue;
  state: 'SATISFIED' | 'UNSATISFIED';
  satisfied: boolean;
}

/** Evaluate one declared criterion. It observes facts only and never writes Task.status. */
export function evaluateTaskCompletion(
  facts: TaskCompletionFacts,
): TaskCompletionEvaluation {
  const criterion = facts.completionCriterion ?? 'HUMAN_SIGNOFF';
  let satisfied: boolean;
  switch (criterion) {
    case 'EXECUTABLE':
      satisfied = facts.executableExitCode != null
        && facts.acceptanceExpectedExitCode != null
        && facts.executableExitCode === facts.acceptanceExpectedExitCode;
      break;
    case 'VERIFICATION':
      satisfied = facts.verificationVerdict === 'PASS';
      break;
    case 'HUMAN_SIGNOFF':
      satisfied = facts.humanSignoff === true;
      break;
  }
  return { criterion, state: satisfied ? 'SATISFIED' : 'UNSATISFIED', satisfied };
}
