import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { sessionWakeSourceSql } from '../sessions/task-work-carrier';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService, type CoordinatorDeliveryOutcome } from './coordinator-delivery.service';
import { type WakeFact, taskRunStoppedFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';
import { isDerivedUuid } from './project-dispatch-identity';
import { SESSION_ENDING_SELECT, sessionHasEnded } from './project-open-item';

/** The project disappeared between the committed read and the wake's authorization. */
export const RUN_STOPPED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/** The same refusal, about the same column, its siblings spell this way. */
export const RUN_STOPPED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** How much of what the run said last is copied into the message. */
const LAST_WORDS_LIMIT = 1_200;

/**
 * What ended, which is what names one stop: a turn somebody delivered, as `/turn-complete` reports
 * it, or a turn the engine started itself, which never gets there and is known by its `TURN_END`.
 */
export type RunStop = { turnId: string } | { engineTurnEndSeq: number };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the owner typed this turn. A client mints a uuid of its own for what it sends
 * (`CreateTurnRequest.clientTurnId`), another session's message names its sender, and everything the
 * platform writes is keyed by a derived uuid or a prefix of its own.
 */
export function turnTypedByOwner(turn: { clientTurnId: string; senderSessionId: string | null }): boolean {
  return turn.senderSessionId === null && UUID_SHAPE.test(turn.clientTurnId) && !isDerivedUuid(turn.clientTurnId);
}

/**
 * `TASK_RUN_STOPPED`: a task's run has stopped working and the task is still owed something,
 * delivered to the conversation coordinating the project.
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-11-02, project 34qLPXsdBbZQ5qfwmcDJM, task 34qLYVoEQQZipg3Hz3iZo. Its run finished the work,
 * had four submissions refused with EVIDENCE_NO_RESOLVABLE_CITATION, said "someone needs to submit
 * the evidence" and ended its turn. The coordinator was waiting on `task_await` for that task, with
 * nine of ten tasks done. No revision was ever written, so `COMPLETION_EVIDENCE_REVISED` never fired;
 * the task never reached a terminal status, so the await never fired; and the run never ended, so
 * `ATTEMPT_ENDED_UNSETTLED` never fired either. Nothing moved until a person read the page and told
 * the coordinator, which that project's owner reports having to do every time.
 *
 * WHAT COUNTS AS STOPPED
 * ======================
 * This does not interpret AWAITING_INPUT, which alone says only that no turn is running: it asks
 * the question `closeUnansweredRequests` asks at the same moment. The session has no wake source
 * (`sessionWakeSourceSql`: a job, a watch, a scheduled wake-up, an armed retry), so nothing gives it
 * another turn unless somebody speaks to it. It fires on the turn ending, never on how long anything
 * has waited.
 *
 * WHAT THE TASK IS STILL OWED
 * ===========================
 * Only EVIDENCE_JUDGMENT, which is the criterion whose next step has to come from the run and whose
 * decider this conversation is. A latest revision nobody has answered is its own fact on its way to
 * the decider, so it owes nothing here; a revision sent back is answered, and a run that stops
 * without a new one is exactly this. A verifier or foreman run is not the coordinator's to move.
 *
 * WHY A TURN THE OWNER TYPED IS NOT A STOP
 * ========================================
 * The owner is reading that conversation as it answers, and a coordinator told about each reply
 * would spend a turn to walk in on it. Everything else is, whoever sent it.
 *
 * WHY IT GOES TO THE STANDING CONVERSATION
 * ========================================
 * `DEPENDENT_READY`'s reason: no exception to handle and no terminal to record, only a fact one
 * conversation can act on and nothing re-derives. `queue` rather than `deliver`, because a coordinator
 * still holding an unread message is no reason to lose this one. It is refused like every delivery on
 * that carrier when there is no conversation to tell, and the run stays where it is, saying what it
 * said, on the owner's page.
 *
 * Post-commit, like every producer here: the fact is read from what the turn's completion committed.
 */
@Injectable()
export class TaskRunStoppedProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /** Null when this stop justifies no fact, which is the ordinary answer. */
  async afterStop(sessionId: string, stop: RunStop): Promise<CoordinatorDeliveryOutcome | null> {
    const fact = await this.factFor(sessionId, stop);
    return fact ? this.deliveries.queue(fact, this.authorize) : null;
  }

  private async factFor(sessionId: string, stop: RunStop): Promise<WakeFact | null> {
    const run = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        startsTaskWork: true,
        status: RunStatus.AWAITING_INPUT,
        task: {
          projectId: { not: null },
          completionCriterion: 'EVIDENCE_JUDGMENT',
          status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
          verifiesTaskId: null,
          isForeman: false,
          supersededByTaskId: null,
        },
      },
      select: {
        ...SESSION_ENDING_SELECT,
        lastAssistantText: true,
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            completionEvidence: {
              orderBy: { revision: 'desc' },
              take: 1,
              select: { decisions: { select: { id: true }, take: 1 } },
            },
          },
        },
      },
    });
    if (!run?.task?.projectId || sessionHasEnded(run)) return null;
    const [latest] = run.task.completionEvidence;
    if (latest && latest.decisions.length === 0) return null;

    const [wakeSource] = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s."id" FROM "session" s
       WHERE s."id" = ${sessionId}::uuid
         AND ${Prisma.raw(sessionWakeSourceSql('s'))}`);
    if (wakeSource) return null;

    if ('turnId' in stop) {
      const turn = await this.prisma.conversationTurn.findFirst({
        where: { id: stop.turnId, sessionId, kind: 'message' },
        select: { clientTurnId: true, senderSessionId: true },
      });
      if (!turn || turnTypedByOwner(turn)) return null;
    }

    const words = run.lastAssistantText?.trim() ?? '';
    return taskRunStoppedFact({
      projectId: run.task.projectId,
      taskId: run.task.id,
      taskTitle: run.task.title,
      sessionId,
      stopKey: 'turnId' in stop ? stop.turnId : `engine:${stop.engineTurnEndSeq}`,
      lastWords: words.length > LAST_WORDS_LIMIT ? `${words.slice(0, LAST_WORDS_LIMIT)}…` : words || null,
    });
  }

  /**
   * Its siblings' shape: the switch, then `convergence.authorizeWake` last, because it records the
   * fact's audit row and no refusal may follow it. A property rather than a method, because handed
   * across bare a method loses its `this`.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: RUN_STOPPED_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: RUN_STOPPED_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
