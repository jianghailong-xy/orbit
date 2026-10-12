import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { WIKI_MODEL_QUEUE, WIKI_SYSTEM_MODEL, wikiModelCallBudgetSeconds } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { currentWikiExecutorSwitch, wikiExecutorClaimOwners } from '../wiki/wiki-executor-switch';
import { WikiSystemModelReads } from '../wiki/wiki-system-model';
import { askWikiSystemModel, WikiModelError, type WikiModelEndpoint } from './wiki-model-client';
import { WikiModelRequestChannel } from './wiki-model-notify';
import { WIKI_SYSTEM_MODEL_CONFIG, WikiModelStatusProbe } from './wiki-model-status';
import type { WikiSystemModelConfig } from './wiki-system-model';
import {
  claimWikiModelRequests,
  failWikiModelRequest,
  failWikiModelRequestsPastWaitLimit,
  reclaimExpiredWikiModelRequests,
  releaseWikiModelRequestLease,
  retryWikiModelRequest,
  succeedWikiModelRequest,
  WIKI_MODEL_REQUEST_CHANNEL,
  writeWikiModelRequestPartial,
  renewWikiModelRequestLease,
  wikiModelRequestById,
  type ClaimedWikiModelRequest,
  type WikiModelRequestRead,
} from './wiki-model-queue';

/** The queue's own timings, in a test's hands; every one has a shared default. */
export interface WikiModelQueueOptions {
  leaseMs?: number;
  renewMs?: number;
  partialMs?: number;
  pollMs?: number;
  /** How many requests this scheduler takes per pass; the room the count leaves is the hard bound. */
  claimLimit?: number;
}

export const WIKI_MODEL_QUEUE_OPTIONS = Symbol('WIKI_MODEL_QUEUE_OPTIONS');

/** The caller's cancel, as an error: the call was interrupted, and what it settled as is the caller's. */
export class WikiModelWaitCancelled extends Error {
  constructor() {
    super('the wait was cancelled');
    this.name = 'WikiModelWaitCancelled';
  }
}

/**
 * The model request queue's executor (design §5.2): every `wiki_model_request` row a job makes is run here,
 * in this process, against the deployer's System model — so the deployment's LLM concurrency is one number
 * however many jobs want it.
 *
 * ONE PASS: reclaim, expire, claim, run.
 *   - reclaim: running rows whose lease ran out go back to queued, partial kept (a process that died).
 *   - expire: queued rows that waited past their step's limit fail — the job that made one reads that and
 *     fails as infra, so a model that is away for an hour ends a run rather than hanging it forever.
 *   - claim: `claimWikiModelRequests` — the advisory-locked transaction that takes at most the concurrency
 *     minus the live running rows (wiki-model-queue.ts).
 *   - run: each claimed row is one call, concurrently; the lease is renewed while it runs and the text so
 *     far is written back on the partial interval.
 * The pass runs again `pollMs` later; bootstrap runs the first one at once, so a worker that starts after
 * an outage picks the queue up where it stands.
 *
 * WHAT STOPS IT CLAIMING
 *   - the model is not up (wiki_model_status, read each pass): down and auth_failed leave every request
 *     queued, and the probe goes on — the next up resumes by itself (design §5.3).
 *   - ORBIT_WIKI_EXECUTOR: under `runner`, no worker claims anything (the empty owner set); under `canary`,
 *     only jobs of the listed accounts are run.
 *   - SIGTERM: the loop stops, the calls in flight are aborted, each saves its partial and lets its lease
 *     out to now, and the next process's sweep re-issues them (design §5.4, the owner's plan A).
 */
@Injectable()
export class WikiModelRequestQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('WikiModelQueue');
  private readonly workerId = randomUUID();
  private readonly inFlight = new Map<string, { claim: ClaimedWikiModelRequest; controller: AbortController }>();
  /** The executions a pass started, so a shutdown can wait for their abort paths to finish. */
  private readonly executions = new Set<Promise<void>>();
  private loop: 'STOPPED' | 'RUNNING' | 'STOPPING' = 'STOPPED';
  /** Set by the shutdown: from then on every pass claims nothing. */
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private passing: Promise<number> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WIKI_SYSTEM_MODEL_CONFIG) private readonly config: WikiSystemModelConfig,
    @Optional() private readonly probe?: WikiModelStatusProbe,
    @Optional() private readonly channel?: WikiModelRequestChannel,
    @Optional() @Inject(WIKI_MODEL_QUEUE_OPTIONS) private readonly options: WikiModelQueueOptions = {},
  ) {}

  private get leaseMs(): number {
    return this.options.leaseMs ?? WIKI_MODEL_QUEUE.leaseSeconds * 1000;
  }

  private get pollMs(): number {
    return this.options.pollMs ?? WIKI_MODEL_QUEUE.pollSeconds * 1000;
  }

  onApplicationBootstrap(): void {
    this.loop = 'RUNNING';
    // The catch-up pass at once: the queue may have been waiting for this process.
    void this.kick();
    this.arm();
  }

  /**
   * SIGTERM (design §5.4, plan A): claim nothing more, abort what is in flight — each call saves its
   * partial and sets its lease deadline to now, so a new process takes over at once — and only then let
   * Prisma go. The abort path is one statement per call, so this ends in milliseconds, not in a model call's
   * time; what a call had received is on its row either way.
   */
  async onModuleDestroy(): Promise<void> {
    this.loop = 'STOPPING';
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const { controller } of this.inFlight.values()) controller.abort();
    await Promise.allSettled([...this.executions]);
    await this.passing?.catch(() => undefined);
    this.loop = 'STOPPED';
  }

  private arm(): void {
    if (this.loop !== 'RUNNING') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, this.pollMs);
    this.timer.unref();
  }

  /** One pass, at most one at a time. Used by the loop, by bootstrap, and by the specs directly. */
  async kick(): Promise<number> {
    if (this.passing) return this.passing;
    this.passing = this.runOnce().finally(() => {
      this.passing = undefined;
      this.arm();
    });
    return this.passing;
  }

  /** Reclaim, expire, claim, start — the pass. Returns how many calls it started. */
  async runOnce(): Promise<number> {
    const switch_ = currentWikiExecutorSwitch();
    const owners = wikiExecutorClaimOwners(switch_);
    if (owners !== null && owners.length === 0) return 0;
    await reclaimExpiredWikiModelRequests(this.prisma, this.claimLimit).catch((error: unknown) =>
      this.log.warn(`the request sweep failed: ${this.message(error)}`));
    await failWikiModelRequestsPastWaitLimit(this.prisma, { owners }).catch((error: unknown) =>
      this.log.warn(`the wait-limit pass failed: ${this.message(error)}`));
    if (this.stopped) return 0;
    if (!(await this.modelUp())) return 0;
    const claimed = await claimWikiModelRequests(this.prisma, {
      workerId: this.workerId,
      concurrency: this.config.concurrency,
      owners,
      limit: this.options.claimLimit,
      leaseMs: this.leaseMs,
    });
    if (claimed.length === 0) return 0;
    // The calls run on; this pass reports what it STARTED and does not wait for them, so the loop's next
    // pass tops up whatever room frees as they end. A shutdown waits for them (onModuleDestroy).
    for (const claim of claimed) {
      const running = this.execute(claim)
        .catch((error: unknown) => this.log.error(`request ${claim.id} could not be settled: ${this.message(error)}`))
        .finally(() => this.executions.delete(running));
      this.executions.add(running);
    }
    return claimed.length;
  }

  /** Waits until no call of this worker is in flight (the specs' handle on a pass that starts calls). */
  async whenIdle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.executions]);
      if (this.executions.size === 0) return;
    }
  }

  /** Whether the deployment's model is answering: the row the worker itself keeps fresh (design §5.3). */
  private async modelUp(): Promise<boolean> {
    if (!this.config.configured) return false;
    try {
      const status = await new WikiSystemModelReads(this.prisma).read(new Date());
      return status.state === 'up';
    } catch (error) {
      this.log.warn(`the model's state could not be read: ${this.message(error)}`);
      return false;
    }
  }

  private get claimLimit(): number {
    return this.options.claimLimit ?? this.config.concurrency;
  }

  /**
   * Run one claimed call. The lease is renewed while it runs; the partial is written back when it grew.
   * A call that ends writes its answer or its failure under the claim's generation, and announces itself so
   * the job waiting on it wakes; a call that was aborted by SIGTERM saves its partial and lets its lease
   * out to now, so the next process's sweep takes it over.
   */
  private async execute(claim: ClaimedWikiModelRequest): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(claim.id, { claim, controller });
    let partial = claim.partial ?? '';
    let written = partial;
    const renew = setInterval(() => {
      void renewWikiModelRequestLease(this.prisma, { id: claim.id, generation: claim.leaseGeneration, leaseMs: this.leaseMs })
        .catch((error: unknown) => this.log.warn(`the lease renewal failed: ${this.message(error)}`));
    }, this.options.renewMs ?? WIKI_MODEL_QUEUE.renewSeconds * 1000);
    renew.unref();
    const flush = setInterval(() => {
      if (partial === written) return;
      written = partial;
      void writeWikiModelRequestPartial(this.prisma, {
        id: claim.id, generation: claim.leaseGeneration, partial, leaseMs: this.leaseMs,
      }).catch((error: unknown) => this.log.warn(`the partial write-back failed: ${this.message(error)}`));
    }, this.options.partialMs ?? WIKI_MODEL_QUEUE.partialSeconds * 1000);
    flush.unref();
    try {
      const answer = await askWikiSystemModel(this.endpoint(), {
        system: claim.request.system,
        prompt: claim.request.prompt,
        maxTokens: claim.request.maxTokens,
        timeoutMs: this.callBudgetMs(claim.step),
        idleTimeoutMs: WIKI_SYSTEM_MODEL.idleTimeoutSeconds * 1000,
        signal: controller.signal,
        onPartial: (text) => {
          partial = text;
        },
      });
      const settled = await succeedWikiModelRequest(this.prisma, {
        id: claim.id,
        generation: claim.leaseGeneration,
        answer: answer.text,
        inputTokens: answer.usage.inputTokens,
        outputTokens: answer.usage.outputTokens,
        httpStatus: 200,
      });
      if (!settled) this.log.warn(`request ${claim.id} answered after its lease was taken over: the answer is dropped`);
      else await this.announce(claim.id);
    } catch (error) {
      await this.settleFailure(claim, error);
    } finally {
      clearInterval(renew);
      clearInterval(flush);
      this.inFlight.delete(claim.id);
    }
  }

  /** What a failed call leaves: a retry, an ending, or — for a cancel — a lease out to now. */
  private async settleFailure(claim: ClaimedWikiModelRequest, error: unknown): Promise<void> {
    if (!(error instanceof WikiModelError)) throw error;
    const partial = error.partial === '' ? null : error.partial;
    if (error.failure === 'cancelled') {
      // SIGTERM: the call was ours to stop. Save what it had and let the lease out now (design §5.4);
      // the next process's sweep requeues it with the partial and re-issues the call.
      await releaseWikiModelRequestLease(this.prisma, { id: claim.id, generation: claim.leaseGeneration, partial });
      return;
    }
    if (error.kind === 'unauthorized') {
      // The key was refused: every later call would be refused the same way, so the queue pauses — the
      // probe writes auth_failed and no pass claims again until the worker restarts (design §5.3). This
      // request goes back to the queue: it is the deployment's to fix, not the work's to lose.
      await this.probe?.keyRefused(error.message);
      await retryWikiModelRequest(this.prisma, {
        id: claim.id, generation: claim.leaseGeneration, error: error.message, errorKind: 'unauthorized', httpStatus: error.status,
      });
      await this.announce(claim.id);
      return;
    }
    if (error.kind === 'retryable') {
      await retryWikiModelRequest(this.prisma, {
        id: claim.id, generation: claim.leaseGeneration, error: error.message, errorKind: 'retryable', httpStatus: error.status,
      });
      await this.announce(claim.id);
      return;
    }
    // `other`: the call's own budget ran out, the answer was not an event stream, an error event nobody
    // classes — the work itself cannot go on with it (§5.5 content), and the job decides from the row.
    if (partial !== null) {
      await writeWikiModelRequestPartial(this.prisma, { id: claim.id, generation: claim.leaseGeneration, partial, leaseMs: this.leaseMs })
        .catch(() => undefined);
    }
    await failWikiModelRequest(this.prisma, {
      id: claim.id, generation: claim.leaseGeneration, error: error.message, errorKind: 'other', httpStatus: error.status,
    });
    await this.announce(claim.id);
  }

  /** Wake whoever waits on a settled request; the waiters poll as the fallback. */
  private async announce(requestId: string): Promise<void> {
    await this.prisma.$executeRaw`SELECT pg_notify(${WIKI_MODEL_REQUEST_CHANNEL}, ${requestId})`.catch((error: unknown) =>
      this.log.warn(`the announcement did not go out: ${this.message(error)}`));
  }

  private endpoint(): WikiModelEndpoint {
    return { baseUrl: this.config.baseUrl as string, apiKey: this.config.apiKey as string, model: this.config.model as string };
  }

  private callBudgetMs(step: string): number {
    return wikiModelCallBudgetSeconds(step) * 1000;
  }

  /**
   * Wait until a request of this job's has settled — its answer, or the failure that ends it — the way a
   * job's own turn waits: the queue's announcement wakes it, and a poll catches what an announcement that
   * never arrived would have carried. The signal is the job's cancel (SIGTERM), and the wait throws
   * `WikiModelWaitCancelled` for it.
   */
  async whenSettled(requestId: string, wait: { signal?: AbortSignal } = {}): Promise<WikiModelRequestRead> {
    const pollMs = this.pollMs;
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
      wait.signal?.addEventListener('abort', aborted, { once: true });
    });
    try {
      for (;;) {
        if (wait.signal?.aborted) throw new WikiModelWaitCancelled();
        const row = await wikiModelRequestById(this.prisma, requestId);
        if (!row) throw new Error(`no model request ${requestId}`);
        if (row.state === 'succeeded' || row.state === 'failed' || row.state === 'cancelled') return row;
        let wake!: () => void;
        const heard = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const off = this.channel?.onChange((id) => {
          if (id === requestId) wake();
        });
        try {
          await Promise.race([heard, delay(pollMs).then(() => undefined), cancelled]);
        } finally {
          off?.();
        }
      }
    } finally {
      wait.signal?.removeEventListener('abort', aborted);
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
