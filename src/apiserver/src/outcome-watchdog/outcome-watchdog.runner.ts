import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertFullGitSha,
  validateWatchdogContract,
  type WatchdogContract,
} from './outcome-watchdog';
import { OutcomeWatchdogService } from './outcome-watchdog.service';

@Injectable()
export class OutcomeWatchdogRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutcomeWatchdogRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private contract!: WatchdogContract;
  private collectorSha!: string;
  private targetSha!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly watchdog: OutcomeWatchdogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const policyPath = path.resolve(this.config.get<string>('OUTCOME_WATCHDOG_POLICY_PATH')
      ?? 'contracts/outcome-reconciler-v2-watchdog-slo.json');
    this.contract = JSON.parse(readFileSync(policyPath, 'utf8')) as WatchdogContract;
    validateWatchdogContract(this.contract);
    this.collectorSha = this.config.get<string>('OUTCOME_WATCHDOG_COLLECTOR_SHA') ?? '';
    this.targetSha = this.config.get<string>('OUTCOME_WATCHDOG_TARGET_SHA') ?? '';
    assertFullGitSha(this.collectorSha, 'COLLECTOR');
    assertFullGitSha(this.targetSha, 'TARGET');
    await this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.contract.collector.pollIntervalSeconds * 1_000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.running) {
      this.logger.error('WATCHDOG_POLL_OVERRUN: prior bounded poll is still running');
      return;
    }
    this.running = true;
    try {
      const tenantIds = await this.watchdog.tenantIds();
      for (const tenantId of tenantIds) {
        try {
          const sample = await this.watchdog.collect({
            authenticatedTenantId: tenantId,
            tenantId,
            contract: this.contract,
            collectorSha: this.collectorSha,
            targetSha: this.targetSha,
          });
          const alerts = Array.isArray(sample.alerts) ? sample.alerts.length : 0;
          this.logger.log(JSON.stringify({
            event: 'OUTCOME_WATCHDOG_SAMPLE',
            tenantId,
            sampleId: sample.sampleId,
            projectionStatus: sample.projectionStatus,
            alerts,
            collectorSha: this.collectorSha,
            targetSha: this.targetSha,
          }));
        } catch (error) {
          this.logger.error(JSON.stringify({
            event: 'OUTCOME_WATCHDOG_COLLECTION_FAILED',
            tenantId,
            code: error instanceof Error ? error.message : 'UNKNOWN',
            collectorSha: this.collectorSha,
            targetSha: this.targetSha,
          }));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
