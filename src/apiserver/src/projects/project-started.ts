import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import { derivedUuid } from './project-dispatch-identity';
import { SESSION_ENDING_SELECT, sessionHasEnded } from './project-open-item';

/**
 * "The owner started this project", told to the conversation the project is coordinated from.
 *
 * §0 — WHY THE PLATFORM SAYS IT
 * =============================
 * "Start the project" (`ProjectAcceptanceService.confirmStandardSet`) turns `coordinator_enabled`
 * on, and that switch lets Orbit start this project's tasks — the ones opted into auto-run, and no
 * others. A coordinator that filed its tasks to be started by hand and then waited for the owner's
 * go-ahead was never told the go-ahead came: the press spoke to the dispatcher, and the one party
 * holding the work was a conversation it never reached. On 2026-09-23 a project was started with
 * all eight of its tasks held that way, its coordinator parked on a question, and nothing moved.
 *
 * §1 — WHAT IT SAYS, AND WHAT IT DOES NOT
 * =======================================
 * The fact, and the open tasks nothing will start except the coordinator. It is not a stand-in for
 * any other answer: the press authorized work on the project and answered no question the
 * coordinator put to the owner, and the message says so — a coordinator still waiting on the owner
 * puts its question back in front of them instead of waiting in silence.
 *
 * §2 — ONCE PER START, AND NEVER A REVIVAL
 * ========================================
 * Keyed by the confirmation that started the project, so a replay collapses onto the turn already
 * written. A conversation that has ended is not revived to be told (`sessionHasEnded`), and a
 * project with no conversation has nobody to tell. A turn is a notification, not an interrupt: a
 * coordinator in the middle of a turn reads this when that turn ends.
 */

/** How many held tasks the message names before it counts the rest. */
export const PROJECT_STARTED_LISTED_TASKS = 20;

/** An open task nothing will start but the coordinator, as the message names it. */
export interface HeldTask {
  id: string;
  title: string;
}

/** The `clientTurnId` of the one turn that tells a coordinator its project was started. */
export function projectStartedTurnId(confirmationId: string): string {
  return derivedUuid(`project-started:v1:turn:${confirmationId}`);
}

/** The message's words. `held` is at most `PROJECT_STARTED_LISTED_TASKS` of `heldCount`. */
export function projectStartedMessage(input: {
  projectId: string;
  projectTitle: string;
  criteriaCount: number;
  confirmedAt: Date;
  held: readonly HeldTask[];
  heldCount: number;
}): string {
  const project = uuidToBase62(input.projectId);
  const criteria = `${input.criteriaCount} acceptance `
    + (input.criteriaCount === 1 ? 'criterion' : 'criteria');
  const paragraphs = [
    'From Orbit · project started',
    `The account owner confirmed the ${criteria} of project “${input.projectTitle}” (${project}) `
      + `and started it at ${input.confirmedAt.toISOString()}. From now on Orbit starts this `
      + 'project’s tasks that are set to run on their own (autoRunWhenReady), within its '
      + 'concurrency limit.',
  ];
  if (input.heldCount === 0) {
    paragraphs.push(
      'None of its open tasks is set to be started by hand, so none of them is waiting on you.',
    );
  } else {
    const one = input.heldCount === 1;
    const lines = input.held.map((task) => `- ${task.title} (${uuidToBase62(task.id)})`);
    const rest = input.heldCount - input.held.length;
    if (rest > 0) lines.push(`- …and ${rest} more (task_list with projectId: ${project})`);
    paragraphs.push(
      `${input.heldCount} of its open tasks ${one ? 'is' : 'are'} set to be started by hand `
        + `(autoRunWhenReady=false), so nothing starts ${one ? 'it' : 'them'} unless you do:\n`
        + lines.join('\n'),
      'If you were holding them for this go-ahead, start them with task_start, or set '
        + 'autoRunWhenReady with task_update on the ones that may start by themselves.',
    );
  }
  paragraphs.push(
    'Starting the project answered nothing else: if you are still waiting on the owner for '
      + 'something, ask it again.',
  );
  return paragraphs.join('\n\n');
}

/**
 * Tell the project's coordinator conversation that the confirmation `confirmationId` started the
 * project. §2.
 *
 * Null when nobody was told: the project has no conversation, it has ended, or `createTurn`
 * refused for a state of the world rather than a fault. A fault is thrown.
 */
export async function tellCoordinatorProjectStarted(
  prisma: PrismaService,
  sessions: SessionsService,
  input: {
    ownerId: string;
    projectId: string;
    confirmationId: string;
    confirmedAt: Date;
    criteriaCount: number;
  },
): Promise<{ sessionId: string; clientTurnId: string } | null> {
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, ownerId: input.ownerId },
    select: {
      title: true,
      coordinatorSessionId: true,
      coordinatorSession: { select: SESSION_ENDING_SELECT },
    },
  });
  const sessionId = project?.coordinatorSessionId;
  if (!project || !sessionId || !project.coordinatorSession) return null;
  if (sessionHasEnded(project.coordinatorSession)) return null;

  const where = {
    projectId: input.projectId,
    status: TaskStatus.OPEN,
    autoRunWhenReady: false,
  };
  const held = await prisma.task.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROJECT_STARTED_LISTED_TASKS,
    select: { id: true, title: true },
  });
  const heldCount = await prisma.task.count({ where });

  const clientTurnId = projectStartedTurnId(input.confirmationId);
  try {
    await sessions.createTurn(input.ownerId, sessionId, {
      clientTurnId,
      content: projectStartedMessage({
        projectId: input.projectId,
        projectTitle: project.title,
        criteriaCount: input.criteriaCount,
        confirmedAt: input.confirmedAt,
        held,
        heldCount,
      }),
      intent: 'NEXT_TURN',
    });
  } catch (e) {
    // The refusals `createTurn` gives for an ordinary state of the world: the conversation is
    // gone, it ended or is being written right now, its workspace will not run it, or the key is
    // already spent. Anything else is a fault and is left to the caller.
    if (
      e instanceof NotFoundException
      || e instanceof ConflictException
      || e instanceof ForbiddenException
      || e instanceof BadRequestException
    ) {
      return null;
    }
    throw e;
  }
  return { sessionId, clientTurnId };
}
