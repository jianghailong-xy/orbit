import { BadRequestException } from '@nestjs/common';

/**
 * The one answer both write boundaries give a task whose completion criterion is undeclared.
 *
 * It lives here, called by `TasksController` and `RunnerTasksController` alike, because for a while
 * it lived at only one of them and the two doors stated opposite contracts about the same required
 * field: the runner boundary refused an omission outright while the JWT/user boundary read it as
 * the compatibility spelling of EVIDENCE_JUDGMENT. A caller could not know which rule applied
 * without knowing which credential it happened to be holding, and the value the lenient door
 * invented was the one criterion nothing can satisfy — `evaluateTaskCompletion` answers
 * UNSATISFIED for every EVIDENCE_JUDGMENT task, so a forgotten field produced a task that could
 * never reach DONE. One function is what makes "the same omitted request is refused the same way"
 * a fact about the code rather than a promise two files repeat.
 *
 * The refusal keeps the spelling the runner boundary has always sent. It reads oddly at the user
 * door, but it is the code deployed agent clients already match on, and inventing a second name
 * for the identical refusal is the drift this module exists to end.
 */
export const COMPLETION_CRITERION_REQUIRED_CODE = 'RUNNER_COMPLETION_CRITERION_REQUIRED';
export const COMPLETION_CRITERION_REQUIRED_ACTION = 'DECLARE_COMPLETION_CRITERION_EXPLICITLY';

type CompletionDeclaration = {
  completionCriterion?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  completionPolicy?: string | null;
  verifiesTaskId?: string | null;
};

/** Translate only legacy declarations whose intent is unambiguous; omission never means human. */
export function requireExplicitCompletionCriterion<T extends CompletionDeclaration>(
  declaration: T,
  itemIndex?: number,
): T {
  if (declaration.completionCriterion != null) return declaration;
  const subject = itemIndex == null ? 'task' : `tasks[${itemIndex}]`;
  const command = declaration.acceptanceCommand ?? null;
  const exitCode = declaration.acceptanceExpectedExitCode ?? null;
  if (command != null || exitCode != null) {
    if (command == null || exitCode == null) {
      throw new BadRequestException({
        code: 'RUNNER_LEGACY_COMPLETION_SHAPE_INVALID',
        kind: 'REFUSAL',
        itemIndex: itemIndex ?? null,
        requiredAction: 'SEND_BOTH_EXECUTABLE_ACCEPTANCE_FIELDS',
        message: `${subject} must send acceptanceCommand and acceptanceExpectedExitCode together.`,
      });
    }
    declaration.completionCriterion = 'EXECUTABLE';
    return declaration;
  }
  if (
    declaration.verifiesTaskId != null
    || declaration.completionPolicy === 'VERIFICATION_PASSED'
  ) {
    declaration.completionCriterion = 'VERIFICATION';
    return declaration;
  }
  throw new BadRequestException({
    code: COMPLETION_CRITERION_REQUIRED_CODE,
    kind: 'REFUSAL',
    itemIndex: itemIndex ?? null,
    requiredAction: COMPLETION_CRITERION_REQUIRED_ACTION,
    message:
      `${subject}.completionCriterion is required at every task write boundary; omission is never `
      + 'translated to EVIDENCE_JUDGMENT.',
  });
}
