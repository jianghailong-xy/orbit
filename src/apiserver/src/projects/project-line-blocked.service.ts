import { Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { wakeIdempotencyKey } from './coordinator-wake';
import { spanInWords } from './evidence-undecided';
import { derivedUuid } from './project-dispatch-identity';
import {
  findBlockedLineFacts,
  findHeldLines,
  lineBlockedOwnerKey,
  lineBlockedVersionMarker,
} from './project-line-blocked';
import { runStoppedWakeOn, TaskRunStoppedProducer } from './task-run-stopped.producer';

/** What one tick did: coordinator notices queued, owner pushes sent. */
export interface LineBlockedTick {
  coordinator: number;
  owner: number;
}

/**
 * Tells about a blocked project line (`project-line-blocked.ts`), from the scheduler's minute tick.
 *
 * The coordinator first: one `TASK_RUN_STOPPED` notice per item and idle period, through the same
 * delivery and ledger as T3's idle notice, so a second tick, replica or restart writes nothing and a
 * notice refused while the coordinator was paused is re-derived by `CoordinatorFactQueueService`.
 *
 * Then the account owner: once the project's `exceptionEscalationSeconds` have passed since the first
 * notice about an item, and the item still holds the line, one push, recorded in
 * `project_orphan_notice` under `blocked-line:<itemId>` (the orphan sweep's ledger and push, so no new
 * table and no new client surface). Whether the coordinator has taken the item up does not matter: the
 * line has stayed blocked past the window either way.
 */
@Injectable()
export class ProjectLineBlockedService {
  private readonly logger = new Logger(ProjectLineBlockedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stopped: TaskRunStoppedProducer,
    private readonly deliveries: CoordinatorDeliveryService,
    @Optional() private readonly push?: PushService,
  ) {}

  /** `now` is a parameter so a spec can move the clock. Never rejects. */
  async tick(now: Date = new Date()): Promise<LineBlockedTick> {
    const done: LineBlockedTick = { coordinator: 0, owner: 0 };
    if (!runStoppedWakeOn()) return done;
    try {
      for (const fact of await findBlockedLineFacts(this.prisma, now)) {
        const told = await this.prisma.projectCoordinatorWake.findFirst({
          where: { idempotencyKey: wakeIdempotencyKey(fact) },
          select: { id: true },
        });
        if (told) continue;
        await this.deliveries.queue(fact, this.stopped.authorize, { holdWhilePaused: true });
        done.coordinator += 1;
      }
      done.owner = await this.escalate(now);
    } catch (error) {
      this.logger.warn(`Blocked line sweep failed: ${error instanceof Error ? error.message : error}`);
    }
    return done;
  }

  private async escalate(now: Date): Promise<number> {
    let told = 0;
    for (const line of await findHeldLines(this.prisma)) {
      const first = await this.prisma.projectCoordinatorWake.findFirst({
        where: {
          projectId: line.projectId,
          event: 'TASK_RUN_STOPPED',
          subjectVersion: { contains: lineBlockedVersionMarker(line.itemId) },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true, subjectId: true },
      });
      if (!first || now.getTime() - first.createdAt.getTime() < line.escalationSeconds * 1_000) continue;
      const orphanKey = lineBlockedOwnerKey(line.itemId);
      const written = await this.prisma.projectOrphanNotice.createMany({
        data: [{
          projectId: line.projectId,
          ownerId: line.ownerId,
          taskId: line.itemTaskId ?? first.subjectId,
          orphanKey,
          kind: 'EXCEPTION_ITEM',
          recipient: 'OWNER',
        }],
        skipDuplicates: true,
      });
      if (written.count === 0) continue;
      told += 1;
      const others = line.held.length === 1 ? '1 other task' : `${line.held.length} other tasks`;
      void this.push?.notifyProjectOrphan({
        ownerId: line.ownerId,
        projectId: line.projectId,
        noticeId: derivedUuid(`project-line-blocked:v1:${line.projectId}:${orphanKey}`),
        title: `${line.projectTitle}: a landing line is still blocked`,
        body: `“${line.itemTitle}” has held the landings of ${others} for `
          + `${spanInWords(now.getTime() - line.heldSince.getTime())}, and the run that must act on it went idle. `
          + `The coordinator was told ${spanInWords(now.getTime() - first.createdAt.getTime())} ago.`,
      });
    }
    return told;
  }
}
