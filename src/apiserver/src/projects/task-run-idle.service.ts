import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { taskRunIdleFact, wakeIdempotencyKey } from './coordinator-wake';
import { findIdleRuns } from './task-run-idle';
import { runStoppedWakeOn, TaskRunStoppedProducer } from './task-run-stopped.producer';

/**
 * Tells a project's coordinator about a task run that has sat idle (`task-run-idle.ts`), once per idle
 * period. Run from the scheduler's minute tick. The ledger row's idempotency key names the period, so a
 * second tick, a second replica or a restart finds the row and writes nothing; a notice refused because
 * the coordinator was paused or gone is re-derived by `CoordinatorFactQueueService`, not re-sent here.
 */
@Injectable()
export class TaskRunIdleService {
  private readonly logger = new Logger(TaskRunIdleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stopped: TaskRunStoppedProducer,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /** Notices queued by this tick; `now` is a parameter so a spec can move the clock. */
  async tick(now: Date = new Date()): Promise<number> {
    if (!runStoppedWakeOn()) return 0;
    let sent = 0;
    try {
      for (const idle of await findIdleRuns(this.prisma, now)) {
        const fact = taskRunIdleFact(idle);
        const told = await this.prisma.projectCoordinatorWake.findFirst({
          where: { idempotencyKey: wakeIdempotencyKey(fact) },
          select: { id: true },
        });
        if (told) continue;
        await this.deliveries.queue(fact, this.stopped.authorize, { holdWhilePaused: true });
        sent += 1;
      }
    } catch (error) {
      this.logger.warn(`Idle run sweep failed: ${error instanceof Error ? error.message : error}`);
    }
    return sent;
  }
}
