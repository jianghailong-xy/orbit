import type { Prisma } from '@prisma/client';
import type { SessionOpeningCard } from '@orbit/shared';

import { openingTurnKey } from './orbit-authored-turn';

/**
 * The opening of a session Orbit opened with a prompt of its own (`session.prompt_by_orbit`, 0493),
 * drawn as one line saying why rather than as the reader's bubble holding a brief written for the
 * agent (docs/mocks/orbit-turn-cards/). Which kind of session it is is read off the row that points
 * at it — never off the brief's words:
 *
 *  - COORDINATOR: the project whose `coordinator_session_id` it is;
 *  - JUDGMENT:    the coordinator wake bound to it (`project_coordinator_wake.session_id`), about a
 *                 task when the fact is a task's, about its project otherwise;
 *  - DISPATCH:    the task list whose console it is (`task_list.owner_session_id`);
 *  - MENTION:     the comment mention delivered into it (`task_comment_mention_delivery.target_session_id`),
 *                 with the owner's comment, which is their own words;
 *  - OTHER:       none of those any more — a coordinator replaced since, a list deleted.
 *
 * A task run's brief is not one of these: it has its own card (`readTaskStartCard`).
 */
export async function readSessionOpeningCard(
  db: Prisma.TransactionClient,
  session: { id: string; ownerId: string; taskId: string | null; promptByOrbit?: boolean },
  turn: { clientTurnId: string | null },
): Promise<SessionOpeningCard | null> {
  if (!session.promptByOrbit || session.taskId || turn.clientTurnId !== openingTurnKey(session.id)) return null;
  const project = await db.project.findFirst({
    where: { coordinatorSessionId: session.id, ownerId: session.ownerId },
    select: { id: true, title: true },
  });
  if (project) return { kind: 'COORDINATOR', target: { kind: 'PROJECT', ...project }, mention: null };

  const wake = await db.projectCoordinatorWake.findFirst({
    where: { sessionId: session.id },
    select: { subjectType: true, subjectId: true, project: { select: { id: true, title: true, ownerId: true } } },
  });
  if (wake && wake.project.ownerId === session.ownerId) {
    const task = wake.subjectType === 'TASK' && /^[0-9a-f-]{36}$/i.test(wake.subjectId)
      ? await db.task.findFirst({ where: { id: wake.subjectId, ownerId: session.ownerId }, select: { id: true, title: true } })
      : null;
    return {
      kind: 'JUDGMENT',
      target: task
        ? { kind: 'TASK', ...task }
        : { kind: 'PROJECT', id: wake.project.id, title: wake.project.title },
      mention: null,
    };
  }

  const list = await db.taskList.findFirst({
    where: { ownerSessionId: session.id, ownerId: session.ownerId },
    select: { id: true, title: true },
  });
  if (list) return { kind: 'DISPATCH', target: { kind: 'LIST', ...list }, mention: null };

  const mention = await db.taskCommentMentionDelivery.findFirst({
    where: { targetSessionId: session.id, ownerId: session.ownerId },
    orderBy: { createdAt: 'asc' },
    select: { task: { select: { id: true, title: true } }, comment: { select: { body: true } } },
  });
  if (mention) {
    return { kind: 'MENTION', target: { kind: 'TASK', ...mention.task }, mention: mention.comment.body };
  }
  return { kind: 'OTHER', target: null, mention: null };
}
