import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { turnStateFilter } from '../sessions/session-turn-state';
import {
  CoordinatorDeliveryService, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
} from './coordinator-delivery.service';
import {
  COORDINATOR_PAUSE_SELECT, DELIVERY_COORDINATOR_PAUSED, conversationIsPaused,
} from './coordinator-evidence-queue';
import { type WakeFact, wakeIdempotencyKey } from './coordinator-wake';
import { DependentReadyProducer } from './dependent-ready.producer';
import { blockedLineFactFor } from './project-line-blocked';
import { conversationIsOver } from './project-open-item';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskRunStoppedProducer } from './task-run-stopped.producer';

/**
 * These three facts originate on edges, not on a recovery sweep. Their wake rows are the durable
 * queue when the coordinator refuses them. Turn end supplies the prompt retry; the leader's existing
 * reconcile tick guarantees recovery without another task write or landing. All eligibility and
 * unread-turn checks are reads before claiming or requeueing anything. Permanent refusals are left
 * alone, so an idle coordinator cannot create one refusal row (and log) every minute.
 */
@Injectable()
export class CoordinatorFactQueueService {
  private readonly logger = new Logger(CoordinatorFactQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: CoordinatorDeliveryService,
    private readonly stopped: TaskRunStoppedProducer,
    private readonly ready: DependentReadyProducer,
    private readonly settled: ProjectTasksSettledProducer,
  ) {}

  async deliverOwedTo(sessionId?: string): Promise<void> {
    try {
      const projects = await this.prisma.project.findMany({
        where: {
          coordinatorEnabled: true,
          status: 'OPEN',
          ...(sessionId ? { coordinatorSessionId: sessionId } : {
            coordinatorSession: {
              // Idle and still held: no turn queued or running, not released.
              ...turnStateFilter([null, 'ABANDONED']),
              endReason: null, completedAt: null, archivedAt: null, deletedAt: null,
              cancelRequestedAt: null, retryAt: null,
            },
          }),
          coordinatorWakes: { some: { event: { in: [...EVENTS] } } },
        },
        select: { id: true, coordinatorSessionId: true, coordinatorSession: { select: COORDINATOR_PAUSE_SELECT } },
      });
      for (const project of projects) {
        const conversation = project.coordinatorSession;
        if (!conversation || conversationIsOver(conversation) || conversationIsPaused(conversation)) continue;
        const rows = await this.prisma.projectCoordinatorWake.findMany({
          where: { projectId: project.id, event: { in: [...EVENTS] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const seen = new Set<string>();
        for (const row of rows) {
          if (seen.has(row.idempotencyKey)) continue;
          seen.add(row.idempotencyKey);
          // A successful claim always owns the key even if a concurrent refusal was recorded later.
          const held = await this.prisma.projectCoordinatorWake.findFirst({
            where: { idempotencyKey: row.idempotencyKey, status: { not: 'REFUSED' } },
          });
          const current = held ?? row;
          let resend: { wakeId: string; idempotencyKey: string; clientTurnId: string } | null = null;
          if (current.status === 'DELIVERED') {
            const record = current.delivery as { clientTurnId?: string } | null;
            if (!record?.clientTurnId || !current.sessionId) continue;
            const turn = await this.prisma.conversationTurn.findUnique({
              where: { sessionId_clientTurnId: { sessionId: current.sessionId, clientTurnId: record.clientTurnId } },
              select: { status: true, deliveredAt: true },
            });
            if (turn?.deliveredAt || (turn && turn.status !== 'ANSWERED')) continue;
            resend = { wakeId: current.id, idempotencyKey: current.idempotencyKey, clientTurnId: record.clientTurnId };
          } else if (current.status !== 'REFUSED' || ![
            DELIVERY_COORDINATOR_PAUSED, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
          ].includes(current.refusalCode ?? '')) continue;

          const fact = await this.currentFact(current);
          if (!fact || fact.projectId !== project.id || wakeIdempotencyKey(fact) !== current.idempotencyKey) continue;
          if (resend) {
            await this.deliveries.requeue(fact, resend);
          } else {
            // All three producers compose the same Automatic switch and convergence authorizer.
            await this.deliveries.queue(fact, this.stopped.authorize, { holdWhilePaused: true, waited: true });
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Coordinator fact recovery failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async currentFact(row: {
    event: string; projectId: string; subjectId: string; subjectVersion: string; detail: Prisma.JsonValue;
  }): Promise<WakeFact | null> {
    if (row.event === 'DEPENDENT_READY') return (await this.ready.factsFor([row.subjectId]))[0] ?? null;
    if (row.event === 'PROJECT_TASKS_SETTLED') return this.settled.queuedFactFor(row.projectId);
    const sessionId = (row.detail as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) return null;
    const stopKey = row.subjectVersion.slice(sessionId.length + 1);
    if (stopKey.startsWith('line:')) return blockedLineFactFor(this.prisma, row.subjectVersion, new Date());
    if (stopKey.startsWith('idle:')) {
      const fact = await this.stopped.idleFactFor(sessionId, new Date());
      return fact && fact.subjectVersion === row.subjectVersion ? fact : null;
    }
    return this.stopped.factFor(sessionId, stopKey.startsWith('engine:')
      ? { engineTurnEndSeq: Number(stopKey.slice('engine:'.length)) }
      : { turnId: stopKey });
  }
}

const EVENTS = ['TASK_RUN_STOPPED', 'DEPENDENT_READY', 'PROJECT_TASKS_SETTLED'] as const;
