import { uuidToBase62 } from '@orbit/shared';

import { criterionKeyOf } from '../projects/project-acceptance';
import { derivedUuid } from '../projects/project-dispatch-identity';
import { definitionIdFromKey } from './task-evidence-envelope';

/**
 * What a confirmed move does with the evidence its task brings along, and the words it says it in.
 *
 * Decision 2 of project 34b8pthjtmO06pvd8i3FW (account owner, 2026-10-06): a run in progress and
 * evidence nobody has decided go with the task, and the project it moves into decides. Moving the
 * task is `TasksService.applyMoveApproval`; this is what happens after that transaction commits,
 * driven by `TasksService.handOverMovedEvidence`, for a task that declared EVIDENCE_JUDGMENT, has
 * not settled, and whose latest revision carries no decision. Anything else says nothing to anybody.
 *
 *   * DECIDABLE where it went — the revision quotes a standard the task is held to there: its own
 *     acceptance criteria, or the criterion the move declared. It is the same question it was before
 *     the move, asked of the new project: routed through the evidence door again
 *     (`CompletionInputRouter.routeCompletionEvidence`), so an Automatic project's coordinator is
 *     handed it to decide and any other project records it for the owner's card, by the rules that
 *     door already has. The delivery made before the move was keyed by the revision alone, so this
 *     one is keyed with the project it goes to (`completionEvidenceRevisedFact`'s
 *     `movedFromProjectId`) — otherwise the first delivery would dedupe it and the new project would
 *     never be told.
 *   * NOT DECIDABLE there — most often it quotes the source's criterion, which the move took back.
 *     The decision door would refuse every answer (EVIDENCE_JUDGMENT_CRITERION_MOVED), so nobody is
 *     asked one. What is owed is a new revision, against the standard the task is held to now: the
 *     task's live runs are told so (`resubmitMessage`), and an Automatic target's coordinator is told
 *     the task arrived with a revision to be filed again (`arrivalMessage`), keyed by the revision
 *     and the project (`movedEvidenceTurnId`), never reviving a conversation that has ended.
 *
 * The notification the source was sent before the move is not taken back: the conversation keeps it
 * as what was said then. It just cannot be acted on — a session acting for the project the task left
 * is refused at the decision door (`assertDecidingSessionInTaskProject`).
 */

/** The standard a moved task's next revision has to quote, as it reads in the project it moved to. */
export type ResubmitStandard =
  | { kind: 'PROJECT_CRITERION'; key: string; text: string }
  | { kind: 'TASK_ACCEPTANCE_CRITERIA'; key: string; text: string }
  | { kind: 'NONE' };

/** What both messages say about the move and the revision. */
export interface MovedEvidence {
  taskId: string;
  title: string;
  revision: string;
  from: { id: string; title: string };
  to: { id: string; title: string };
  /** What the revision quoted, when it quoted anything. */
  quoted: { key: string; text: string } | null;
  /** The source's criterion the move took back from the task, if it declared one. */
  withdrawnCriterionDefinitionId: string | null;
  standard: ResubmitStandard;
}

/**
 * The standard a task is held to in the project it is in: the criterion it declares, or else its own
 * acceptance criteria — the two lanes `evidenceCriterionMatch` binds a quote to — keyed the way an
 * envelope quotes each (the criterion's key; the task's own public id).
 */
export function resubmitStandard(task: {
  id: string;
  acceptanceCriteria: string | null;
  declared: { id: string; text: string } | null;
}): ResubmitStandard {
  if (task.declared) {
    return { kind: 'PROJECT_CRITERION', key: criterionKeyOf(task.declared.id), text: task.declared.text };
  }
  const own = task.acceptanceCriteria?.trim() ?? '';
  if (own !== '') {
    return { kind: 'TASK_ACCEPTANCE_CRITERIA', key: uuidToBase62(task.id), text: task.acceptanceCriteria! };
  }
  return { kind: 'NONE' };
}

/** The turn one of these messages is written as: one per revision, project and reader. */
export function movedEvidenceTurnId(
  reader: 'run' | 'coordinator',
  evidenceId: string,
  projectId: string,
): string {
  return derivedUuid(`moved-task-evidence:v1:${reader}:${evidenceId}:${projectId}`);
}

function projectName(project: { id: string; title: string }): string {
  return `“${project.title}” (${uuidToBase62(project.id)})`;
}

/** Why the revision cannot be decided where the task went, in one clause. */
function whyUndecidable(moved: MovedEvidence): string {
  if (!moved.quoted) return 'it quotes no criterion';
  const quotedId = definitionIdFromKey(moved.quoted.key);
  if (
    quotedId !== null
    && moved.withdrawnCriterionDefinitionId !== null
    && quotedId.toLowerCase() === moved.withdrawnCriterionDefinitionId.toLowerCase()
  ) {
    return `the criterion it quotes (key ${moved.quoted.key}) belongs to project ${projectName(moved.from)}, `
      + `and the task's declaration of it was taken back by the move`;
  }
  return `the criterion it quotes (key ${moved.quoted.key}) is not the standard this task has to meet in project ${projectName(moved.to)}`;
}

/** The standard to quote, as lines an agent can copy into `task_evidence_submit`'s `criterion`. */
function standardLines(moved: MovedEvidence): string {
  const standard = moved.standard;
  if (standard.kind === 'PROJECT_CRITERION') {
    return `Submit it again against the criterion this task declares in project ${projectName(moved.to)}, with the envelope's criterion written exactly as:\n`
      + `key: ${standard.key}\ntext: “${standard.text}”`;
  }
  if (standard.kind === 'TASK_ACCEPTANCE_CRITERIA') {
    return `This task declares no criterion in project ${projectName(moved.to)}, so it is judged by its own acceptance criteria; `
      + `write the envelope's criterion exactly as:\n`
      + `key: ${standard.key}\ntext: “${standard.text}”`;
  }
  return `This task neither declares a criterion in project ${projectName(moved.to)} nor has acceptance criteria of its own, so there is no standard to quote yet: `
    + 'first declare the criterion it serves with task_update (criterionKey), or write down its acceptanceCriteria, then submit again against that.';
}

/** To each live run of the moved task: the revision it submitted has to be filed again, and how. */
export function resubmitMessage(moved: MovedEvidence): string {
  const taskKey = uuidToBase62(moved.taskId);
  return (
    `[Task “${moved.title}” moved to project “${moved.to.title}”: evidence revision ${moved.revision} has to be submitted again against the standard there]\n\n`
    + `The account owner confirmed moving task ${taskKey} from project ${projectName(moved.from)} to project ${projectName(moved.to)}; `
    + 'this session moved with the task and can go on writing as usual.\n\n'
    + `Revision ${moved.revision} of the task's completion evidence has not been decided yet, and it cannot be decided in `
    + `project “${moved.to.title}”: ${whyUndecidable(moved)}. The decision door would refuse it (EVIDENCE_JUDGMENT_CRITERION_MOVED), `
    + 'so it was not handed to anyone to decide.\n\n'
    + `${standardLines(moved)}\n\n`
    + `Then submit a new revision with task_evidence_submit (taskId ${taskKey}); project “${moved.to.title}” decides it. `
    + 'The checks in the evidence cite the rows already under this task as usual; the move does not affect them.'
  );
}

/** To an Automatic target's coordinator: the task came in with a revision that has to be filed again. */
export function arrivalMessage(moved: MovedEvidence, runSessionIds: readonly string[]): string {
  const taskKey = uuidToBase62(moved.taskId);
  const standard = moved.standard;
  const standardLine = standard.kind === 'NONE'
    ? 'This task neither declares a criterion here nor has acceptance criteria of its own, so there is no standard to quote yet: '
      + `first declare a criterion for it (task_update's criterionKey, taskId ${taskKey}) or write down its acceptanceCriteria.`
    : `It has to be submitted again against this standard: key ${standard.key}, text “${standard.text}”.`;
  const runs = runSessionIds.length > 0
    ? `The task's running sessions (${runSessionIds.map((id) => uuidToBase62(id)).join(', ')}) have been told the same.`
    : `This task has no running session now, so nobody will submit it again on their own: whether to start it (task_start, taskId ${taskKey}) is your call.`;
  return (
    `[Task “${moved.title}” moved into this project with an evidence revision to be submitted again]\n\n`
    + `The account owner confirmed moving task ${taskKey} from project ${projectName(moved.from)} into this project. `
    + `Revision ${moved.revision} of its completion evidence has not been decided yet, and it cannot be decided here, `
    + `so it was not handed to you to decide: ${whyUndecidable(moved)}.\n\n`
    + `${standardLine}\n${runs}\nOnce a new revision is submitted, it is handed to you to decide as usual.\n\n`
    + 'This is a notice, not an interruption: the turn you are running is not interrupted by it, and you are reading it after that turn ended, '
    + 'so go by the state you have just read from the database — the new revision may already have been submitted.'
  );
}
