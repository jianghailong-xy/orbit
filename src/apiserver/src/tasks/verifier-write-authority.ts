import { toUuid } from '@orbit/shared';
import type { Prisma } from '@prisma/client';

/**
 * Who may write the verification relation.
 *
 * `verifiesTaskId` says how a task is settled and, since a verifier reads the files its subject's evidence cites
 * (`sessionJudgesEvidence`), who reads those files too. So it is written by those who answer for the work as a whole: the
 * account owner, the project's coordinator and its judgment sessions. A run answers for its own task, and a task's own run
 * keeps what it had: a verifier writes its own verdict.
 *
 * A run may therefore not make another task a verifier, nor write any field of another task that is one. Any field rather
 * than a list of them: a verifier's instructions, standard, engine and verdict each decide what its answer is worth, and a
 * list is what the next field slips past. Its dependencies and its reported progress are the same rule at their own doors,
 * and so is a delete, which takes every check of the task it deletes with it. A list's foreman is a run like any other, and
 * reports a stuck verifier rather than editing it. An ordinary sibling is still a run's to edit, and a conversation of no
 * task and no run above it is the scope contract's question, as it was.
 *
 * A run does file a verifier of its own on the owner's yes: the MCP tools and the CLI raise a card before they write. That
 * card is the authority, so the door that files one checks for it, as the delete routes do (`requireDeleteApproval`). The
 * batch of dependency edits is the same: its tool raises a card, and on a verifier the door checks for that card.
 *
 * A project's acceptance criteria are held to the same people by what a task says it serves, so `criterionKey` is written the
 * same way: a run writes its own task's and no other's. And a delete does what a decision would have had to earn, so a run
 * deletes only ordinary work it filed itself (`TasksService.assertRunMayDelete`).
 *
 * Every one of these reads the session a request names, so a request that names none reads as the owner, as it always did:
 * that is every runner older than the one that names it on these doors.
 */

export const VERIFIER_WRITE_FROM_RUN_REFUSED_CODE = 'VERIFIER_WRITE_FROM_RUN_REFUSED';
export const VERIFIER_WRITE_FROM_RUN_REFUSED_ACTION = 'ASK_THE_COORDINATOR_OR_THE_OWNER';

export const VERIFIER_CREATE_NEEDS_OWNER_CARD_CODE = 'VERIFIER_CREATE_NEEDS_OWNER_CARD';
export const VERIFIER_CREATE_NEEDS_OWNER_CARD_ACTION = 'ASK_THROUGH_TASK_CREATE';

export const VERIFIER_DAG_NEEDS_OWNER_CARD_CODE = 'VERIFIER_DAG_NEEDS_OWNER_CARD';
export const VERIFIER_DAG_NEEDS_OWNER_CARD_ACTION = 'ASK_THROUGH_TASKLIST_PROPOSE_DAG';

export const TASK_DELETE_FROM_RUN_REFUSED_CODE = 'TASK_DELETE_FROM_RUN_REFUSED';
export const TASK_DELETE_FROM_RUN_REFUSED_ACTION = 'ASK_THE_COORDINATOR_OR_THE_OWNER';

export const CRITERION_KEY_FROM_RUN_REFUSED_CODE = 'CRITERION_KEY_FROM_RUN_REFUSED';
export const CRITERION_KEY_FROM_RUN_REFUSED_ACTION = 'ASK_THE_COORDINATOR_OR_THE_OWNER';

/** The tool names runner-go files the two create cards under (`askBeforeTaskCreate`, `askBeforeBatch`). */
export const TASK_CREATE_CARD_TOOL = 'orbit_task_create';
export const TASK_BATCH_CARD_TOOL = 'orbit_task_batch';
/** The tool name runner-go files the batch of dependency edits under (`dagApprovalToolName`). */
export const DAG_CHANGE_CARD_TOOL = 'orbit_dag_change';

/** The session as these refusals name it: a conversation a run opened answers as that run (`taskOfRunBehind`). */
const A_RUN = 'this session is a run of another task, or a conversation a run opened';

/**
 * The task of the run a session answers as, or null for one that answers as no run.
 *
 * A session with a task is that task's run, unless it coordinates a project or is a judgment session, which answer for the
 * work as a whole. A session of no task answers as the session that opened it, so a run cannot hand a write to a
 * conversation it opens: the walk goes up `parentSessionId` until it meets a session with a task, a coordinator or a judgment
 * session. So what a coordinator or a judgment session opened is no run, and neither is anything with no task above it, the
 * owner's own conversations among them.
 *
 * It only ever takes something away. What a run was granted by name, as the session that dispatched a task or the run of a
 * verifier, stays with that session (`sessionJudgesEvidence`), and a run's own scope is still its own task's (`taskOfRun`).
 * A spawned tree is at most a few sessions deep, so this is a read per generation; a link that repeats ends the walk.
 */
export async function taskOfRunBehind(
  db: Pick<Prisma.TransactionClient, 'session'>,
  ownerId: string,
  sessionId?: string,
): Promise<string | null> {
  const seen = new Set<string>();
  let next: string | null | undefined = sessionId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const session: {
      taskId: string | null;
      parentSessionId: string | null;
      coordinatorForProject: { id: string } | null;
      coordinatorWakes: Array<{ projectId: string }>;
    } | null = await db.session.findFirst({
      where: { id: next, ownerId },
      select: {
        taskId: true,
        parentSessionId: true,
        coordinatorForProject: { select: { id: true } },
        coordinatorWakes: { where: { status: 'SESSION_OPENED' }, select: { projectId: true }, take: 1 },
      },
    });
    // `?.` on the list as well: a hand-built double of the row omits it (`deriveProjectScope`).
    if (!session || session.coordinatorForProject || session.coordinatorWakes?.length) return null;
    if (session.taskId) return session.taskId;
    next = session.parentSessionId;
  }
  return null;
}

/** `write` finishes "a run may not ...", for a door that is not an edit of the row. */
export function verifierWriteFromRunRefusalBody(
  write = 'make a task a verifier or change any field of a task that is one',
) {
  return {
    code: VERIFIER_WRITE_FROM_RUN_REFUSED_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFIER_WRITE_FROM_RUN_REFUSED_ACTION,
    message:
      `${A_RUN}, and a run may not ${write}. Nothing was written. The account owner can make this edit, and so can the `
      + 'project\'s coordinator or a judgment session when the task is in a project; a verifier\'s own run writes its own '
      + 'verdict. Ask one of them.',
  };
}

export function taskDeleteFromRunRefusalBody() {
  return {
    code: TASK_DELETE_FROM_RUN_REFUSED_CODE,
    kind: 'REFUSAL',
    requiredAction: TASK_DELETE_FROM_RUN_REFUSED_ACTION,
    message:
      `${A_RUN}, and a run deletes only a task it filed itself, one that serves no acceptance criterion of its project, is `
      + 'not a verifier and has none. Nothing was deleted. The account owner can delete this task, and so can the '
      + 'project\'s coordinator or a judgment session when the task is in a project. Ask one of them.',
  };
}

export function criterionKeyFromRunRefusalBody() {
  return {
    code: CRITERION_KEY_FROM_RUN_REFUSED_CODE,
    kind: 'REFUSAL',
    requiredAction: CRITERION_KEY_FROM_RUN_REFUSED_ACTION,
    message:
      `${A_RUN}, and a run may not write which acceptance criterion another task serves, since that decides whether the `
      + 'criterion is satisfied. Nothing was written. The account owner can make this edit, and so can the project\'s '
      + 'coordinator or a judgment session; a task\'s own run writes its own, and asking to move a task to another project '
      + '(handoff) goes to the account owner. Ask one of them.',
  };
}

export function verifierDagNeedsOwnerCardBody() {
  return {
    code: VERIFIER_DAG_NEEDS_OWNER_CARD_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFIER_DAG_NEEDS_OWNER_CARD_ACTION,
    message:
      `${A_RUN}, and a run changes what a verifier waits for only on the account owner's yes, and no answered confirmation `
      + 'card in this conversation covers these changes. Nothing was written. tasklist_propose_dag puts the card in front '
      + 'of them; the project\'s coordinator can also make the change.',
  };
}

export function verifierCreateNeedsOwnerCardBody() {
  return {
    code: VERIFIER_CREATE_NEEDS_OWNER_CARD_CODE,
    kind: 'REFUSAL',
    requiredAction: VERIFIER_CREATE_NEEDS_OWNER_CARD_ACTION,
    message:
      'a run files a verification task only on the account owner\'s yes, and no answered confirmation card in this '
      + 'conversation covers this one. Nothing was written. task_create and task_create_batch (orbit task create, orbit '
      + 'task create-batch) put the card in front of them; the project\'s coordinator can also file it.',
  };
}

/**
 * Every verifier a create names, each as what makes it that verifier: the subject it checks and what it is called, which
 * is what the owner read on the card. Card and request are both read through this, the card as the asker sent it and the
 * request as the DTO left it, so an id counts the same in either spelling.
 */
export function verifiersNamedBy(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (isRecord(item.verification)) return [JSON.stringify(['pair', item.title, item.verification.title])];
    if (typeof item.verifiesTaskId === 'string') {
      return [JSON.stringify(['task', uuidOrAsSpelled(item.verifiesTaskId), item.title])];
    }
    if (typeof item.verifiesRef === 'string') return [JSON.stringify(['ref', item.verifiesRef, item.title])];
    return [];
  });
}

/** Whether one card, with its stored input, names every verifier this create names. */
export function cardCoversVerifiers(toolName: string, input: unknown, verifiers: readonly string[]): boolean {
  const items = toolName === TASK_BATCH_CARD_TOOL
    ? (isRecord(input) && Array.isArray(input.tasks) ? input.tasks : [])
    : [input];
  const named = new Set(verifiersNamedBy(items));
  return verifiers.every((verifier) => named.has(verifier));
}

/** Whether one batch card, with its stored input, names every edit these make: an edit as `op`, dependent and prerequisite. */
export function cardCoversDagOps(
  input: unknown,
  ops: ReadonlyArray<{ op: string; taskId: string; dependsOnTaskId: string }>,
): boolean {
  const named = new Set((isRecord(input) && Array.isArray(input.ops) ? input.ops : []).flatMap((op) => (
    isRecord(op) && typeof op.taskId === 'string' && typeof op.dependsOnTaskId === 'string'
      ? [dagOpKey(String(op.op), op.taskId, op.dependsOnTaskId)]
      : []
  )));
  return ops.every((op) => named.has(dagOpKey(op.op, op.taskId, op.dependsOnTaskId)));
}

function dagOpKey(op: string, taskId: string, dependsOnTaskId: string): string {
  return JSON.stringify([op, uuidOrAsSpelled(taskId), uuidOrAsSpelled(dependsOnTaskId)]);
}

function uuidOrAsSpelled(id: string): string {
  try {
    return toUuid(id);
  } catch {
    return id;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
