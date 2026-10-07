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
  return `「${project.title}」（${uuidToBase62(project.id)}）`;
}

/** Why the revision cannot be decided where the task went, in one clause. */
function whyUndecidable(moved: MovedEvidence): string {
  if (!moved.quoted) return '它没有引用任何判据';
  const quotedId = definitionIdFromKey(moved.quoted.key);
  if (
    quotedId !== null
    && moved.withdrawnCriterionDefinitionId !== null
    && quotedId.toLowerCase() === moved.withdrawnCriterionDefinitionId.toLowerCase()
  ) {
    return `它引用的判据（key ${moved.quoted.key}）是项目${projectName(moved.from)}的，`
      + '这个任务对它的声明在移动时已经收回';
  }
  return `它引用的判据（key ${moved.quoted.key}）不是这个任务在项目${projectName(moved.to)}里要满足的标准`;
}

/** The standard to quote, as lines an agent can copy into `task_evidence_submit`'s `criterion`. */
function standardLines(moved: MovedEvidence): string {
  const standard = moved.standard;
  if (standard.kind === 'PROJECT_CRITERION') {
    return `按这个任务在项目${projectName(moved.to)}里声明的判据重交，envelope 的 criterion 原样写：\n`
      + `key：${standard.key}\ntext：「${standard.text}」`;
  }
  if (standard.kind === 'TASK_ACCEPTANCE_CRITERIA') {
    return `这个任务在项目${projectName(moved.to)}里没有声明判据，按它自己的验收标准判；`
      + 'envelope 的 criterion 原样写：\n'
      + `key：${standard.key}\ntext：「${standard.text}」`;
  }
  return `这个任务在项目${projectName(moved.to)}里既没有声明判据，也没有写自己的验收标准，现在没有可以引用的标准：`
    + '先用 task_update 声明它服务的判据（criterionKey），或者写下 acceptanceCriteria，再按它重交。';
}

/** To each live run of the moved task: the revision it submitted has to be filed again, and how. */
export function resubmitMessage(moved: MovedEvidence): string {
  const taskKey = uuidToBase62(moved.taskId);
  return (
    `【任务「${moved.title}」已移到项目「${moved.to.title}」：第 ${moved.revision} 版完成证据要按那里的标准重交】\n\n`
    + `账号所有者确认了把任务 ${taskKey} 从项目${projectName(moved.from)}移到项目${projectName(moved.to)}，`
    + '这个会话随任务一起过去了，可以照常继续写入。\n\n'
    + `任务的第 ${moved.revision} 版完成证据还没判定，${whyUndecidable(moved)}，`
    + `所以在项目「${moved.to.title}」里判不了——判定入口会拒绝它（EVIDENCE_JUDGMENT_CRITERION_MOVED），`
    + '也就没有交给任何人判。\n\n'
    + `${standardLines(moved)}\n\n`
    + `然后用 task_evidence_submit（taskId 传 ${taskKey}）交新的一版；它由项目「${moved.to.title}」判。`
    + '证据里的检查照常引用这个任务下已有的行，移动不影响它们。'
  );
}

/** To an Automatic target's coordinator: the task came in with a revision that has to be filed again. */
export function arrivalMessage(moved: MovedEvidence, runSessionIds: readonly string[]): string {
  const taskKey = uuidToBase62(moved.taskId);
  const standard = moved.standard;
  const standardLine = standard.kind === 'NONE'
    ? '这个任务在这里既没有声明判据，也没有写自己的验收标准，现在没有可以引用的标准：'
      + `先给它声明判据（task_update 的 criterionKey，taskId 传 ${taskKey}）或写下 acceptanceCriteria。`
    : `它要按这个标准重交：key ${standard.key}，原文「${standard.text}」。`;
  const runs = runSessionIds.length > 0
    ? `任务的运行中会话（${runSessionIds.map((id) => uuidToBase62(id)).join('、')}）已经收到同样的说明。`
    : `这个任务现在没有运行中的会话，没有人会自己重交：要不要开工（task_start，taskId 传 ${taskKey}）由你判断。`;
  return (
    `【任务「${moved.title}」带着一版要重交的完成证据移进了这个项目】\n\n`
    + `账号所有者确认了把任务 ${taskKey} 从项目${projectName(moved.from)}移进这个项目。`
    + `它的第 ${moved.revision} 版完成证据还没判定，${whyUndecidable(moved)}，在这里判不了，`
    + '所以没有交给你判。\n\n'
    + `${standardLine}\n${runs}\n新的一版提交之后，会照常交给你判。\n\n`
    + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
    + '所以以你自己刚读到的库里状态为准——新的一版可能已经交上来了。'
  );
}
