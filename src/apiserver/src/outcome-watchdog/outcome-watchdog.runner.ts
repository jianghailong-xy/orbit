import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
  private targetRef!: string;
  private instanceId!: string;
  private watchdogExpectationGeneration!: string;
  private completionAckExpectationGeneration!: string;
  private readonly moduleGraphDigest = createHash('sha256').update([
    'outcome-watchdog/main',
    'outcome-watchdog/worker-module',
    'outcome-watchdog/runner',
    'outcome-watchdog/service',
    'prisma',
  ].sort().join('\n')).digest('hex');

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
    this.targetRef = this.config.get<string>('OUTCOME_WATCHDOG_TARGET_REF')
      ?? 'refs/heads/main';
    assertFullGitSha(this.collectorSha, 'COLLECTOR');
    assertFullGitSha(this.targetSha, 'TARGET');
    if (!/^refs\/.+/.test(this.targetRef)) throw new Error('OUTCOME_WATCHDOG_TARGET_REF_INVALID');
    this.instanceId = this.config.get<string>('OUTCOME_WATCHDOG_INSTANCE_ID')
      ?? `${hostname()}:${process.pid}`;
    this.watchdogExpectationGeneration = this.requiredGeneration(
      'OUTCOME_WATCHDOG_EXPECTATION_GENERATION',
    );
    this.completionAckExpectationGeneration = this.requiredGeneration(
      'COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION',
    );
    const binding = await this.watchdog.registerCurrentBinding({
      component: 'outcome-watchdog',
      instanceId: this.instanceId,
      expectationGeneration: this.watchdogExpectationGeneration,
      sourceSha: this.collectorSha,
      targetSha: this.targetSha,
      targetRef: this.targetRef,
      moduleGraphDigest: this.moduleGraphDigest,
    });
    this.logger.log(JSON.stringify({
      event: 'OUTCOME_WATCHDOG_CURRENT_BINDING_REGISTERED',
      instanceId: this.instanceId,
      sourceSha: this.collectorSha,
      targetSha: this.targetSha,
      targetRef: this.targetRef,
      ...binding,
    }));
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
      const observedAt = new Date();
      const staleAttempts = await this.watchdog.markStaleExecutableAttempts(observedAt);
      const completionAcks = await this.watchdog.reconcileStaleCompletionAcks(
        observedAt,
        this.contract.collector.maximumDetectionDeltaSeconds,
      );
      const completionAckDeliveries = await this.watchdog.reconcileStaleCompletionAckDeliveries(
        observedAt,
        this.contract.collector.maximumDetectionDeltaSeconds,
      );
      // A detector may only claim health after its bounded scan and reducer committed. Writing the
      // heartbeat first is the self-monitoring failure this component exists to avoid: an
      // undefined SQL function or a wedged reducer would leave a fresh "healthy" row behind.
      const completedAt = new Date();
      const heartbeatInput = {
        instanceId: this.instanceId,
        sourceSha: this.collectorSha,
        moduleGraphDigest: this.moduleGraphDigest,
        observedAt: completedAt,
        deadlineAt: new Date(
          completedAt.getTime() + this.contract.collector.maximumDetectionDeltaSeconds * 1_000,
        ),
      };
      const completionHeartbeat = await this.watchdog.appendRuntimeHeartbeat({
        ...heartbeatInput,
        component: 'completion-ack-watchdog',
        expectationGeneration: this.completionAckExpectationGeneration,
        payload: {
          schemaVersion: 1,
          targetSha: this.targetSha,
          pollIntervalSeconds: this.contract.collector.pollIntervalSeconds,
          completionAcks,
          completionAckDeliveries,
        },
      });
      const heartbeat = await this.watchdog.appendRuntimeHeartbeat({
        ...heartbeatInput,
        component: 'outcome-watchdog',
        expectationGeneration: this.watchdogExpectationGeneration,
        payload: {
          schemaVersion: 1,
          targetSha: this.targetSha,
          pollIntervalSeconds: this.contract.collector.pollIntervalSeconds,
        },
      });
      this.logger.log(JSON.stringify({
        event: 'OUTCOME_WATCHDOG_HEARTBEAT',
        instanceId: this.instanceId,
        sequence: heartbeat.sequence.toString(),
        heartbeatDigest: heartbeat.heartbeatDigest,
        bindingDigest: heartbeat.bindingDigest,
        evaluatedThroughLogicalTime: heartbeat.evaluatedThroughLogicalTime?.toString(),
        completionHeartbeatDigest: completionHeartbeat.heartbeatDigest,
        sourceSha: this.collectorSha,
        staleAttempts,
        completionAcks,
        completionAckDeliveries,
      }));
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

  private requiredGeneration(name: string): string {
    const value = this.config.get<string>(name) ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${name}_INVALID`);
    }
    return value;
  }
}
