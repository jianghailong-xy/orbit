import {
  TASK_COMPLETION_CRITERIA,
  type TaskCompletionCriterionValue,
} from './task-completion-criterion';
import { TASK_CRITERION_OVERRIDE_REASON_FIELD } from './task-criterion-shape-advice';

/**
 * The door that makes rewriting "what counts as done" cost something.
 *
 * Deciding a task's completion evidence is fail-closed: four checks, only a session that did not do
 * the work, every refusal naming a `requiredAction`. Rewriting the CRITERION that decision answers
 * to was guarded by nothing at all. On 2026-09-05 a run that the decision door had just refused
 * changed two tasks' `completionCriterion` to EXECUTABLE instead — two calls, and afterwards the
 * only column that had moved was `updatedAt`. That is the cheapest path around completion, and it
 * was cheaper than the thing it goes around.
 *
 * The remedy is deliberately NOT a prohibition. Declaring the wrong criterion is ordinary and
 * frequent — the task that precedes this one exists to repair one — and a criterion that cannot be
 * corrected leaves work nothing can ever settle, which is a deadlock with better paperwork. So the
 * change stays available at the price of saying why, and the price is paid into the row rather
 * than into a log: the reason is stored together with the criterion the task is moving AWAY from,
 * which is the one fact `updatedAt` could never carry and the one a later reader needs.
 *
 * Only a CHANGE is questioned. Declaring a criterion while creating a task is the first statement
 * of the contract, not a rewrite of it, and re-sending the value a task already carries changes
 * nothing to explain.
 */
export const TASK_CRITERION_CHANGE_UNEXPLAINED_CODE =
  'TASK_COMPLETION_CRITERION_CHANGE_UNEXPLAINED';

/** The one executable remedy: say why, in the field that already exists for exactly this prose. */
export const TASK_CRITERION_CHANGE_REQUIRED_ACTION = 'EXPLAIN_THE_COMPLETION_CRITERION_CHANGE';

export interface TaskCriterionChange {
  from: TaskCompletionCriterionValue;
  to: TaskCompletionCriterionValue;
}

export interface TaskCriterionChangeRecord extends TaskCriterionChange {
  reason: string;
}

/**
 * The stored spelling, and the reason it is a marked prefix rather than a new column.
 *
 * `completion_criterion_override_reason` already exists, already means "audit prose about why this
 * task carries the criterion it does", and is already returned by every read. A second column would
 * cost a migration, an entry in the DB-write inventory and a pass over the census suites that
 * enumerate this table — real money in this repository — to store a fact this one can hold. The
 * marker is what keeps the two uses separable: creation prose is free text and never matches it.
 */
const CHANGE_RECORD = /^\[criterion-change ([A-Z_]+)->([A-Z_]+)\] ([\s\S]+)$/;

function isCriterion(value: string): value is TaskCompletionCriterionValue {
  return (TASK_COMPLETION_CRITERIA as readonly string[]).includes(value);
}

export function formatTaskCriterionChange(record: TaskCriterionChangeRecord): string {
  return `[criterion-change ${record.from}->${record.to}] ${record.reason}`;
}

/**
 * Read a stored change back, or null when the column holds something else.
 *
 * Both criteria are checked against the enum rather than trusted from the text: prose that happens
 * to be shaped like a record must not be able to report a criterion no task can declare.
 */
export function readTaskCriterionChange(
  stored: string | null | undefined,
): TaskCriterionChangeRecord | null {
  const match = CHANGE_RECORD.exec(stored?.trim() ?? '');
  if (!match) return null;
  const [, from, to, reason] = match;
  if (!isCriterion(from) || !isCriterion(to)) return null;
  return { from, to, reason };
}

/** The structured refusal, in the shape the doors beside it already answer with. */
export function taskCriterionChangeRefusalBody(change: TaskCriterionChange) {
  return {
    code: TASK_CRITERION_CHANGE_UNEXPLAINED_CODE,
    kind: 'REFUSAL',
    requiredAction: TASK_CRITERION_CHANGE_REQUIRED_ACTION,
    reasonField: TASK_CRITERION_OVERRIDE_REASON_FIELD,
    from: change.from,
    to: change.to,
    message:
      `This task declares ${change.from}; moving it to ${change.to} rewrites what counts as done, ` +
      `so it cannot be a silent edit. Send a non-blank ${TASK_CRITERION_OVERRIDE_REASON_FIELD} in ` +
      'the same request and the change is made: the reason is stored together with the criterion ' +
      'being left behind, and task_get returns both. Blank or whitespace is not a reason. ' +
      'Declaring a criterion when the task is created is unaffected, and so is re-sending the ' +
      'value this task already carries.',
  } as const;
}

// ── The second question this door asks: not why the standard moved, but WHO moved it ──────────

/**
 * The parts of a completion declaration that say WHAT COUNTS as this task being done.
 *
 * Four of the six fields of the declaration, and the two that are left out are left out for
 * different reasons. `acceptanceTimeoutSeconds` is a bound on the run rather than a statement
 * about the answer: raising it cannot make a failing command pass, it can only let one that was
 * going to pass finish saying so. `completionCriterionOverrideReason` is prose about the standard,
 * not the standard.
 *
 * `completionPolicy` and `verifiesTaskId` are in, even though a change to either usually drags
 * `completionCriterion` with it, because "usually" is not "always": ALL_CHILDREN_DONE on a task
 * that keeps EVIDENCE_JUDGMENT moves no criterion and still replaces the question with a different
 * one, and so does re-pointing a verifier at another subject.
 */
export interface TaskCompletionStandard {
  completionCriterion: TaskCompletionCriterionValue;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  completionPolicy: string | null;
  verifiesTaskId: string | null;
}

export type TaskCompletionStandardField = keyof TaskCompletionStandard;

const STANDARD_FIELDS: readonly TaskCompletionStandardField[] = [
  'completionCriterion',
  'acceptanceCommand',
  'acceptanceExpectedExitCode',
  'completionPolicy',
  'verifiesTaskId',
];

/**
 * Which parts of the standard this write actually moves — empty when it moves none.
 *
 * Compared field by field between the stored row and the MERGED result, for the same reason the
 * criterion-change door judges the merged criterion: a caller who re-sends the value a task
 * already carries has restated the standard, not rewritten it, and a door that fired on the
 * mention rather than on the change would refuse a request that changes nothing.
 */
export function taskCompletionStandardRewrite(
  before: TaskCompletionStandard,
  after: TaskCompletionStandard,
): readonly TaskCompletionStandardField[] {
  return STANDARD_FIELDS.filter((field) => before[field] !== after[field]);
}

export const TASK_SELF_REWRITTEN_STANDARD_CODE = 'TASK_COMPLETION_STANDARD_SELF_REWRITE_REFUSED';
export const TASK_SELF_REWRITTEN_STANDARD_ACTION =
  'HAVE_AN_INDEPENDENT_SESSION_RESTATE_THE_STANDARD';

/**
 * The refusal a task's own run reads when it rewrites the standard it is about to be measured by.
 *
 * The rule the rest of completion is built on is that a task is settled by somebody who did not do
 * the work: a verdict may not be concluded from the run of the task it verifies, and an evidence
 * decision may not be made by the session that produced the evidence. Both of those are walls
 * around the ANSWER. Neither was a wall around the QUESTION, so a run that could not have itself
 * judged done could change what being done meant instead — declare EXECUTABLE, name a command of
 * its own choosing, and have the exit code of that command settle its own task a minute later.
 * That is not a way around one door; it is a way around the idea both doors implement.
 *
 * So this refusal is a wall and not a price. The criterion-change door beside it deliberately is a
 * price — a mis-declared criterion is ordinary and has to stay repairable — and the two compose:
 * anybody who could rewrite this standard before still can, at the cost of saying why, EXCEPT the
 * one run whose own completion the answer decides. What the refusal has to carry, therefore, is
 * who that leaves: any session that is not this task's run, and the account owner acting through
 * the user API with no run at all.
 */
export function taskSelfRewrittenStandardRefusalBody(
  rewritten: readonly TaskCompletionStandardField[],
) {
  return {
    code: TASK_SELF_REWRITTEN_STANDARD_CODE,
    kind: 'REFUSAL',
    requiredAction: TASK_SELF_REWRITTEN_STANDARD_ACTION,
    rewritten: [...rewritten],
    message:
      `This edit changes ${rewritten.join(', ')}, and it is being made from the run of the very `
      + 'task those fields decide, so it would let this run choose the standard it is about to be '
      + 'measured against — a task is completed by a judgement its own work did not make. The '
      + 'edit itself is not the problem and is not refused to anybody else: any session other '
      + 'than this task\'s run, and the account owner acting with no run at all, can make exactly '
      + 'this request (a change of completionCriterion additionally needs '
      + `${TASK_CRITERION_OVERRIDE_REASON_FIELD}, which is a separate door). This run may still `
      + 'say what it found — it can write status FAILED as its own conservative outcome, and it '
      + 'can still raise acceptanceTimeoutSeconds, which bounds how long the declared command may '
      + 'run without changing what that command has to report.',
  } as const;
}
