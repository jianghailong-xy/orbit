import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ConditionsService } from './conditions.service';

/** How often a pass looks for silent conditions. The shortest interval is a minute, and silence is three of them. */
export const CONDITION_WORKER_POLL_INTERVAL_MS = 30_000;

/**
 * The conditions' clock (docs/condition-triggers-design.md §5.3), one loop per replica, shaped like the schedule
 * worker's: a pass at boot, then one per interval. Each pass moves every condition with no sample for three intervals
 * to UNKNOWN and prunes samples older than 30 days. Replicas racing each other is safe: each condition is decided
 * under its row lock.
 */
@Injectable()
export class ConditionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ConditionWorker');
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pass?: Promise<void>;

  constructor(private readonly conditions: ConditionsService) {}

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

  private tick(): void {
    if (!this.running || this.pass) return;
    this.pass = this.conditions.sweep()
      .then(() => undefined)
      .catch((error) => this.log.error(`condition pass failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.pass = undefined;
        if (!this.running) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.tick();
        }, CONDITION_WORKER_POLL_INTERVAL_MS);
        this.timer.unref();
      });
  }
}
