import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ScheduleRunsService } from './schedule-runs.service';

/** How often a pass looks for due slots, runs to start and runs to watch. A slot is a minute at the finest. */
export const SCHEDULE_WORKER_POLL_INTERVAL_MS = 15_000;

/**
 * The scheduled tasks' clock (docs/scheduled-tasks-design.md §5–§7), one loop per replica, shaped like the
 * scheduled-wakeup worker's: a pass at boot finds everything that came due while no replica ran, then one pass per
 * interval. Each pass fires the due schedules, starts the runs that may start, watches the ones in progress,
 * completes the sessions of NO_CHANGE runs and tells the owner of a planned end reached (§8.5). Replicas racing each
 * other is safe: every step is a compare-and-set under the schedule's row lock.
 */
@Injectable()
export class ScheduleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ScheduleWorker');
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pass?: Promise<void>;

  constructor(private readonly runs: ScheduleRunsService) {}

  onModuleInit(): void {
    this.running = true;
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /** One pass, in the order a run moves through: fired, started, watched, its session completed, the end told. */
  async runPass(): Promise<void> {
    await this.runs.fireDue();
    await this.runs.startDue();
    await this.runs.reconcile();
    await this.runs.landReportedRuns();
    await this.runs.completeNoChangeSessions();
    await this.runs.tellPlannedEnds();
  }

  private tick(): void {
    if (!this.running || this.pass) return;
    this.pass = this.runPass()
      .catch((error) => this.log.error(`schedule pass failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.pass = undefined;
        if (!this.running) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.tick();
        }, SCHEDULE_WORKER_POLL_INTERVAL_MS);
        this.timer.unref();
      });
  }
}
