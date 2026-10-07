import { Injectable } from '@nestjs/common';
import { wikiWorkerRunning, type WikiSystemModelState, type WikiSystemModelStatus } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The System model as the wiki settings page and the health line read it (contract `systemModel.read`): the model's
 * name and its state, from the one row the wiki-worker writes (migration 0398).
 *
 * The apiserver never has the model's address or key — they are in the worker's environment alone — and this read
 * passes on nothing else of the row either: `last_error` is left for whoever reads the table. A worker that has not
 * written its heartbeat for `workerStaleSeconds`, or never has, reads as `worker_not_running`, since the last
 * heartbeat. A read and nothing else.
 */
@Injectable()
export class WikiSystemModelReads {
  constructor(private readonly prisma: PrismaService) {}

  async read(now: Date = new Date()): Promise<WikiSystemModelStatus> {
    const row = await this.prisma.wikiModelStatus.findUnique({
      where: { id: 1 },
      select: { state: true, model: true, since: true, checkedAt: true, workerSeenAt: true },
    });
    if (!row) return { state: 'worker_not_running', model: null, since: null, checkedAt: null, workerSeenAt: null };
    const running = wikiWorkerRunning(row.workerSeenAt, now);
    return {
      state: running ? (row.state as WikiSystemModelState) : 'worker_not_running',
      model: row.model,
      since: (running ? row.since : row.workerSeenAt).toISOString(),
      checkedAt: row.checkedAt?.toISOString() ?? null,
      workerSeenAt: row.workerSeenAt.toISOString(),
    };
  }
}
