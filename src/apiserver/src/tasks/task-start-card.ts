import { SessionRunSource } from '@prisma/client';
import type { TaskStartCard, TaskStartCriterion } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { isAutomaticTaskRunToken, taskRunResumeToken } from './task-run-identity';
import { buildTaskExecutionPrompt } from './tasks.service';

/**
 * The card a task run's opening turn is drawn as (`TaskStartCard`), or null for every other turn.
 *
 * WHICH TURNS. A run's brief reaches the conversation under one of two keys: the seeded first turn
 * of the Session the run created (`SessionsService.initialTurnClientId`), or the turn a run request
 * delivers to a paused Session it resumes (`taskRunResumeTurnId`). Nothing else is read — a batch of
 * ordinary messages costs no query.
 *
 * WHY THE BRIEF IS REBUILT. The card is taken from the task's own columns when the runner's echo is
 * stored, which can be later than the dispatch that wrote the brief: a queued run waits for a slot,
 * and the task can be edited meanwhile. So the brief is rebuilt from what is read and compared with
 * the turn's content, and a mismatch is no card at all. What a card says is then provably what the
 * agent was handed, never a newer description of the task than the one it read.
 */
export async function readTaskStartCard(
  prisma: Pick<PrismaService, 'task'>,
  session: { id: string; taskId?: string | null; runSource?: SessionRunSource | null },
  turn: { clientTurnId: string | null; content: string | null },
): Promise<TaskStartCard | null> {
  if (!session.taskId || !turn.content || !turn.clientTurnId) return null;
  const opening = turn.clientTurnId === SessionsService.initialTurnClientId(session.id);
  const resumeToken = opening ? null : taskRunResumeToken(turn.clientTurnId, session.id);
  if (!opening && resumeToken === null) return null;
  const task = await prisma.task.findUnique({
    where: { id: session.taskId },
    select: {
      id: true,
      title: true,
      description: true,
      acceptanceCriteria: true,
      acceptanceCommand: true,
      acceptanceExpectedExitCode: true,
      completionCriterion: true,
      isForeman: true,
      verifiesTaskId: true,
      list: { select: { instructions: true } },
      project: { select: { id: true, title: true } },
    },
  });
  if (!task || buildTaskExecutionPrompt(task) !== turn.content) return null;
  // Read the way the brief reads them, so the card cannot carry a field the brief left out.
  const systemRun = task.isForeman || task.verifiesTaskId != null;
  return {
    taskId: task.id,
    title: task.title,
    description: task.description || null,
    acceptanceCriteria: task.acceptanceCriteria?.trim() || null,
    completionCriterion: (task.completionCriterion as TaskStartCriterion | null) ?? null,
    acceptanceCommand: task.acceptanceCommand ?? null,
    acceptanceExpectedExitCode: task.acceptanceExpectedExitCode ?? null,
    listInstructions: systemRun ? null : task.list?.instructions?.trim() || null,
    project: task.project ? { id: task.project.id, title: task.project.title } : null,
    // A created Session records which door made it; a resumed one records the door that made it
    // originally, so for a resume the request token says which door delivered THIS brief.
    auto: resumeToken === null
      ? session.runSource === SessionRunSource.TASK_LIST_AUTO
      : isAutomaticTaskRunToken(resumeToken),
  };
}
