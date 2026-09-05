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
