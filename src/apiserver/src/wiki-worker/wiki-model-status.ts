import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { WIKI_SYSTEM_MODEL, type WikiSystemModelState } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { probeWikiSystemModel, type WikiModelEndpoint } from './wiki-model-client';
import type { WikiSystemModelConfig } from './wiki-system-model';

/** The provider token of the worker's System model configuration (`currentWikiSystemModel()`). */
export const WIKI_SYSTEM_MODEL_CONFIG = 'WIKI_SYSTEM_MODEL_CONFIG';

/** What one look at the System model found: the row's state, why it is not up, and when the probe ran. */
export interface WikiModelObservation {
  state: WikiSystemModelState;
  lastError: string | null;
  checkedAt: Date | null;
}

/**
 * Writes the one row of `wiki_model_status` (migration 0398, contract `systemModel.status`): the state and its
 * reason, the probe's time, and the worker's heartbeat, in one statement. `since` moves only when the state or the
 * model changes, so it says when the current state began however many probes have confirmed it since.
 */
export async function recordWikiModelStatus(
  prisma: PrismaService,
  model: string | null,
  seen: WikiModelObservation,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "wiki_model_status" ("id", "state", "model", "since", "last_error", "checked_at", "worker_seen_at")
    VALUES (1, ${seen.state}, ${model}, ${now}, ${seen.lastError}, ${seen.checkedAt}, ${now})
    ON CONFLICT ("id") DO UPDATE SET
      "since" = CASE
        WHEN "wiki_model_status"."state" = EXCLUDED."state" AND "wiki_model_status"."model" IS NOT DISTINCT FROM EXCLUDED."model"
        THEN "wiki_model_status"."since" ELSE EXCLUDED."since" END,
      "state" = EXCLUDED."state",
      "model" = EXCLUDED."model",
      "last_error" = EXCLUDED."last_error",
      "checked_at" = EXCLUDED."checked_at",
      "worker_seen_at" = EXCLUDED."worker_seen_at"`;
}

/**
 * The System model's state and the worker's heartbeat (contract `systemModel.health` and `.status`, design §5.3).
 *
 * Every `probeIntervalSeconds` it probes `{base}/health` and writes what it found together with the heartbeat, so a
 * worker that stops writing is a worker that stopped: the read answers `worker_not_running` once the heartbeat is
 * `workerStaleSeconds` old. With no System model configured nothing is probed, and the heartbeat still goes on.
 *
 * `auth_failed` holds until the process ends. The endpoint refusing the key — to the probe, or to a call, which the
 * request queue reports through `keyRefused` — means every later call would be refused the same way, and `/health`
 * answering 200 again says nothing about the key: only a restart, which reads the corrected key, starts over.
 */
@Injectable()
export class WikiModelStatusProbe implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('WikiModelStatus');
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private refused: string | null = null;
  private said: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WIKI_SYSTEM_MODEL_CONFIG) private readonly config: WikiSystemModelConfig,
  ) {}

  onApplicationBootstrap(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), WIKI_SYSTEM_MODEL.probeIntervalSeconds * 1000);
  }

  /** Before Prisma disconnects (this module is destroyed before the one it imports): no probe starts, and the last one is let finish. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One probe and one write. A check still under way is the one returned: two never overlap. */
  check(): Promise<void> {
    this.running ??= this.observeAndRecord().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** A call was refused its key (401): from now until this process ends the state is auth_failed. */
  async keyRefused(reason: string): Promise<void> {
    this.refused ??= reason;
    // A check already under way may have looked before this: the one after it cannot have.
    await this.running;
    await this.check();
  }

  private async observeAndRecord(): Promise<void> {
    const seen = await this.observe();
    try {
      await recordWikiModelStatus(this.prisma, this.config.model, seen, new Date());
    } catch (error) {
      this.log.error(`wiki_model_status was not written: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const said = `${seen.state}|${seen.lastError ?? ''}`;
    if (said === this.said) return;
    this.said = said;
    const model = this.config.model ?? 'the System model';
    if (seen.state === 'up') this.log.log(`${model} is up`);
    else if (seen.state === 'unconfigured') this.log.log(`unconfigured: ${seen.lastError}`);
    else this.log.warn(`${model} is ${seen.state}: ${seen.lastError}`);
  }

  private async observe(): Promise<WikiModelObservation> {
    const { baseUrl, apiKey, model } = this.config;
    if (!this.config.configured || !baseUrl || !apiKey || !model) {
      return { state: 'unconfigured', lastError: `${this.config.missing.join(', ')}: not set or not usable`, checkedAt: null };
    }
    const endpoint: WikiModelEndpoint = { baseUrl, apiKey, model };
    const checkedAt = new Date();
    const health = await probeWikiSystemModel(endpoint);
    if (health.state === 'auth_failed') this.refused ??= health.error;
    if (this.refused !== null) return { state: 'auth_failed', lastError: this.refused, checkedAt };
    return { state: health.state, lastError: health.error, checkedAt };
  }
}
