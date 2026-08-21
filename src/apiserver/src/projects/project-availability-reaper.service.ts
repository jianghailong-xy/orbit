import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const PROJECT_RUNNER_OFFLINE_AFTER_MS = 90_000;
const REAP_INTERVAL_MS = 30_000;

/**
 * Materialize the time-based edge from an ONLINE/DRAINING runner to OFFLINE.
 *
 * A timestamp becomes stale without any row being written, so a database trigger alone cannot
 * observe that edge. This small reaper performs the one guarded write; migration 0118's runner
 * trigger atomically fans the resulting `runner.offline` signal out to the affected Projects.
 * The next heartbeat writes ONLINE and produces the matching recovery edge. Multiple replicas are
 * safe: UPDATE's predicate is re-checked under the row lock and only one can change each row.
 */
@Injectable()
export class ProjectAvailabilityReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProjectAvailabilityReaperService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.reapOnce().catch((error) => {
        this.log.error(`runner availability sweep failed: ${error instanceof Error ? error.message : error}`);
      });
    }, REAP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for deterministic tests and operational one-shot verification. */
  async reapOnce(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - PROJECT_RUNNER_OFFLINE_AFTER_MS);
    const result = await this.prisma.runner.updateMany({
      where: {
        status: { not: 'OFFLINE' },
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleBefore } }],
      },
      data: { status: 'OFFLINE' },
    });
    if (result.count > 0) {
      this.log.log(`materialized ${result.count} stale runner(s) as OFFLINE`);
    }
    return result.count;
  }
}
