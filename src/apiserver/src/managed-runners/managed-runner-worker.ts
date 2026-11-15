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
 *
 * With several Docker channel hosts there is one manager per host, each driving only its own
 * location's mappings, and a pass visits each in turn: a host whose channel cannot be reached (or
 * whose pool cannot be read) fails its own share of the pass, and the others still run. A host whose
 * backend is marked unreachable is first asked one cheap question (`recheckReachability`), at most
 * once per poll interval, so it is noticed when it returns even with no mapping to call on it; its
 * mappings are driven again in the pass whose recheck it answers, and wait until then.
 */
export class ManagedRunnerWorker {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;
  /** A kick that arrived during a pass: run the next one at once. */
  private again = false;

  private readonly managers: readonly ManagedRunnerManager[];

  constructor(
    manager: ManagedRunnerManager | readonly ManagedRunnerManager[],
    private readonly intervalMs: number,
    private readonly log: Pick<Logger, 'error'> = new Logger('ManagedRunnerWorker'),
  ) {
    this.managers = Array.isArray(manager) ? manager : [manager as ManagedRunnerManager];
  }

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
    // The sweep reads every sleeping runner, whatever its host: once a pass is enough.
    try {
      await this.managers[0].sweepDemand();
    } catch (error) {
      this.log.error(`managed runner demand sweep failed: ${(error as Error).message}`);
    }
    if (this.managers.length === 1) return this.drainOne(this.managers[0]);
    for (const manager of this.managers) {
      try {
        // A host marked unreachable is asked once more, so that one no mapping calls on is
        // placed on again once it is back (managed-runner-placement.ts). While it stays marked its
        // mappings wait: each would only spend a failed call on it, and calls to a host whose address
        // drops packets take until their connect timeout, which the other hosts' share would wait out.
        await manager.backend.recheckReachability?.();
        if (manager.backend.unreachable) continue;
        await this.drainOne(manager);
      } catch (error) {
        const { clusterKey, namespace } = manager.backend.location;
        this.log.error(`managed runner pass failed on ${clusterKey}/${namespace}: ${(error as Error).message}`);
      }
    }
  }

  private async drainOne(manager: ManagedRunnerManager): Promise<void> {
    for (const id of await manager.dueMappings(MANAGED_RUNNER_PASS_BATCH)) {
      try {
        await manager.reconcile(id);
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
