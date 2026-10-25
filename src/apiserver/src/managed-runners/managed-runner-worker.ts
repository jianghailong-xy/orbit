import { Logger } from '@nestjs/common';

import type { ManagedRunnerManager } from './managed-runner-manager';

/** Mappings visited per pass. */
export const MANAGED_RUNNER_PASS_BATCH = 50;

/**
 * The reconcile loop: one per replica, constructed and started only when the feature is enabled
 * and the environment profile is valid. A pass reads the mappings that need work from the database
 * — the durable work queue, so the first pass after a restart picks up every provisioning that was
 * in flight — and reconciles each under its own lease. A request that changed a mapping kicks a
 * pass at once; otherwise passes run every poll interval.
 */
export class ManagedRunnerWorker {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;
  /** A kick that arrived during a pass: run the next one at once. */
  private again = false;

  constructor(
    private readonly manager: ManagedRunnerManager,
    private readonly intervalMs: number,
    private readonly log: Pick<Logger, 'error'> = new Logger('ManagedRunnerWorker'),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /** Something wanted changed: pass now rather than at the next interval. */
  kick(): void {
    if (!this.running) return;
    if (this.pass) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tick();
  }

  /** One pass: wake the sleeping mappings that work is waiting for, then every mapping that is due. */
  async drain(): Promise<void> {
    try {
      await this.manager.sweepDemand();
    } catch (error) {
      this.log.error(`managed runner demand sweep failed: ${(error as Error).message}`);
    }
    for (const id of await this.manager.dueMappings(MANAGED_RUNNER_PASS_BATCH)) {
      try {
        await this.manager.reconcile(id);
      } catch (error) {
        this.log.error(`managed runner ${id}: pass failed: ${(error as Error).message}`);
      }
    }
  }

  private tick(): void {
    if (!this.running || this.pass) return;
    this.pass = this.drain()
      .catch((error: Error) => this.log.error(`managed runner pass failed: ${error.message}`))
      .finally(() => {
        this.pass = undefined;
        if (!this.running) return;
        const delay = this.again ? 0 : this.intervalMs;
        this.again = false;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.tick();
        }, delay);
        this.timer.unref(); // never what keeps a process alive
      });
  }
}
