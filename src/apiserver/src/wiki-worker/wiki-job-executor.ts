import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { WIKI_JOB } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { currentWikiExecutorSwitch, wikiExecutorClaimOwners } from '../wiki/wiki-executor-switch';
import {
  claimWikiJobs,
  failWikiJobAsContent,
  reclaimExpiredWikiJobs,
  releaseWikiJobLease,
  requeueWikiJobForInfra,
  succeedWikiJob,
  renewWikiJobLease,
  type ClaimedWikiJob,
} from './wiki-jobs';
import {
  enqueueWikiModelRequest,
  wikiModelRequestFailedOnWaitLimit,
  wikiModelRequestSha256,
  type WikiModelRequestCall,
  type WikiModelRequestRead,
} from './wiki-model-queue';
import { WIKI_MODEL_QUEUE_OPTIONS, WikiModelRequestQueue, WikiModelWaitCancelled, type WikiModelQueueOptions } from './wiki-model-queue.service';
import { runWikiSmokeJob } from './wiki-smoke-job';

/** A job's failure whose fault is the work's: the job ends failed (§5.5 content). */
export class WikiJobContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiJobContentError';
  }
}

/** A job's failure whose fault is the platform's: the job goes back to the queue (§5.5 infra). */
export class WikiJobInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiJobInfraError';
  }
}

/** What running one job is handed: its own row, its cancel, and the queue. */
export interface WikiJobContext {
  job: ClaimedWikiJob;
  /** Aborted when the worker is stopping: a step that can stop early should. */
  signal: AbortSignal;
  /**
   * Make one model call for this job and wait for it. The pair `(step, unit)` is the call's identity inside
   * the job, so a replayed job reuses the answer the queue already holds for it or waits for the call still
   * in flight — a restart re-issues no call that answered. Resolves with the row of a succeeded call;
   * throws WikiJobInfraError for a failure that is the platform's to retry and WikiJobContentError for the
   * rest, so the runner never has to decide which the job is.
   */
  ask(step: string, unit: string, call: WikiModelRequestCall): Promise<WikiModelRequestRead>;
  log(message: string): void;
}

/** What a kind's runner returns: the report its row ends with. */
export type WikiJobRunner = (context: WikiJobContext) => Promise<Record<string, unknown> | void>;

/**
 * The kinds this build runs, and what each is (contract `jobs.kinds`). A job of a kind that is not here —
 * a pipeline whose phase (P3–P8) has not landed — stays queued: the claim only takes what it can finish,
 * so an older worker is never handed work it would have to fail.
 */
export const WIKI_JOB_RUNNERS: Record<string, WikiJobRunner> = {
  smoke: runWikiSmokeJob,
};

/**
 * The wiki job worker (design §5.1): claims jobs of the kinds this build runs and runs each in this process,
 * one job per space at a time, up to WIKI_JOB.maxConcurrentPerWorker at once. A job's model calls go through
 * the queue (wiki-model-queue.service.ts), which is also in this process: the job waits on its request, the
 * scheduler claims it when the model has room, and the answer wakes the job.
 *
 * ONE PASS: reclaim, claim, start.
 *   - reclaim: running jobs whose lease ran out go back to queued with the lost attempt counted — the
 *     worker that had them died. Their requests were let go the same way (their own sweep), so the job is
 *     re-run from the start and its pipeline re-uses the requests that already answered.
 *   - claim: `claimWikiJobs` (wiki-jobs.ts) — priority first, a new lease generation, one job per space.
 *   - start: each claimed job runs concurrently; its lease is renewed while it runs.
 * Bootstrap runs a pass at once, so a worker that starts after a restart picks the queue up where it stands.
 *
 * WHAT STOPS IT CLAIMING: ORBIT_WIKI_EXECUTOR (nothing under `runner`, only the listed accounts under
 * `canary`) and SIGTERM — the loop stops, the jobs in flight are cancelled, each lets its lease out to now,
 * and the next process's sweep takes them over (design §5.4, plan A).
 */
@Injectable()
export class WikiJobExecutor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('WikiJobExecutor');
  private readonly workerId = randomUUID();
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private loop: 'STOPPED' | 'RUNNING' | 'STOPPING' = 'STOPPED';
  /** Set by the shutdown: from then on every pass claims nothing. */
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private passing: Promise<number> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WikiModelRequestQueue,
    @Optional() @Inject(WIKI_MODEL_QUEUE_OPTIONS) private readonly options: WikiModelQueueOptions = {},
  ) {}

  onApplicationBootstrap(): void {
    this.loop = 'RUNNING';
    void this.kick();
    this.arm();
  }

  /** SIGTERM (design §5.4, plan A): claim nothing more, cancel what runs, let its lease out to now. */
  async onModuleDestroy(): Promise<void> {
    this.loop = 'STOPPING';
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers.values()) controller.abort();
    await this.passing?.catch(() => undefined);
    await Promise.allSettled([...this.running.values()]);
    this.loop = 'STOPPED';
  }

  /** Waits until no job of this worker is running (the specs' handle on a pass that starts jobs). */
  async whenIdle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.running.values()]);
      if (this.running.size === 0) return;
    }
  }

  private arm(): void {
    if (this.loop !== 'RUNNING') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, (this.options.pollMs ?? WIKI_JOB.pollSeconds * 1000));
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

  /** Reclaim, claim, start — returns how many jobs this pass started. */
  async runOnce(): Promise<number> {
    const owners = wikiExecutorClaimOwners(currentWikiExecutorSwitch());
    if (owners !== null && owners.length === 0) return 0;
    await reclaimExpiredWikiJobs(this.prisma, WIKI_JOB.maxConcurrentPerWorker).catch((error: unknown) =>
      this.log.warn(`the job sweep failed: ${this.message(error)}`));
    if (this.stopped) return 0;
    const room = WIKI_JOB.maxConcurrentPerWorker - this.running.size;
    if (room <= 0) return 0;
    const claimed = await claimWikiJobs(this.prisma, {
      workerId: this.workerId,
      kinds: Object.keys(WIKI_JOB_RUNNERS),
      owners,
      limit: room,
      leaseMs: this.options.leaseMs ?? WIKI_JOB.leaseSeconds * 1000,
    });
    for (const job of claimed) this.start(job);
    return claimed.length;
  }

  /** Run one claimed job to its end, fire-and-forget: the pass does not wait for a model call. */
  private start(job: ClaimedWikiJob): void {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const running = this.run(job, controller)
      .catch((error: unknown) => this.log.error(`job ${job.id} could not be settled: ${this.message(error)}`))
      .finally(() => {
        this.controllers.delete(job.id);
        this.running.delete(job.id);
      });
    this.running.set(job.id, running);
  }

  /** One job: its kind's runner, its lease renewed while it runs, and what its end leaves on the row. */
  private async run(job: ClaimedWikiJob, controller: AbortController): Promise<void> {
    const renewMs = this.options.renewMs ?? WIKI_JOB.renewSeconds * 1000;
    const renew = setInterval(() => {
      void renewWikiJobLease(this.prisma, {
        id: job.id, generation: job.leaseGeneration, leaseMs: this.options.leaseMs ?? WIKI_JOB.leaseSeconds * 1000,
      }).then((held) => {
        if (!held) this.log.warn(`job ${job.id} lost its lease while running: another worker has it`);
      }).catch((error: unknown) => this.log.warn(`the lease renewal failed: ${this.message(error)}`));
    }, renewMs);
    renew.unref();
    try {
      const runner = WIKI_JOB_RUNNERS[job.kind];
      if (!runner) throw new WikiJobInfraError(`this build runs no '${job.kind}' jobs`);
      const report = await runner(this.context(job, controller));
      const settled = await succeedWikiJob(this.prisma, { id: job.id, generation: job.leaseGeneration, report: report ?? {} });
      if (settled) this.log.log(`job ${job.id} (${job.kind}) succeeded`);
      else this.log.warn(`job ${job.id} finished after its lease was taken over: its end is dropped`);
    } catch (error) {
      await this.settleFailure(job, error);
    } finally {
      clearInterval(renew);
    }
  }

  /** What a failed job leaves: a requeue (the platform's), an end (the work's), or a lease out to now. */
  private async settleFailure(job: ClaimedWikiJob, error: unknown): Promise<void> {
    if (error instanceof WikiModelWaitCancelled) {
      // SIGTERM: the job was cancelled with us. Let its lease out to now so the next process takes it over
      // at once (design §5.4); its requests were let go the same way by the queue's own shutdown.
      await releaseWikiJobLease(this.prisma, { id: job.id, generation: job.leaseGeneration });
      return;
    }
    const message = this.message(error);
    if (error instanceof WikiJobContentError) {
      await failWikiJobAsContent(this.prisma, { id: job.id, generation: job.leaseGeneration, error: message });
      this.log.warn(`job ${job.id} (${job.kind}) failed: ${message}`);
      return;
    }
    // Everything else — a WikiJobInfraError, or an error this build did not expect — is the platform's:
    // the job is tried again rather than counted against the space's streak.
    await requeueWikiJobForInfra(this.prisma, { id: job.id, generation: job.leaseGeneration, error: message });
    this.log.warn(`job ${job.id} (${job.kind}) will be tried again: ${message}`);
  }

  /** What the runner sees: its row, its cancel, and `ask` — the queue, per call. */
  private context(job: ClaimedWikiJob, controller: AbortController): WikiJobContext {
    return {
      job,
      signal: controller.signal,
      log: (message: string) => this.log.log(`job ${job.id}: ${message}`),
      ask: (step: string, unit: string, call: WikiModelRequestCall) => this.ask(job, step, unit, call, controller.signal),
    };
  }

  /**
   * One call: enqueue it (the row is the breakpoint, so the same unit of a re-run meets its own row), wait
   * for it, and hand back what it settled as. A wait-limit failure is the platform's — the job is tried
   * again later — and every other way a call can end is the work's.
   */
  private async ask(
    job: ClaimedWikiJob,
    step: string,
    unit: string,
    call: WikiModelRequestCall,
    signal: AbortSignal,
  ): Promise<WikiModelRequestRead> {
    const enqueued = await enqueueWikiModelRequest(this.prisma, {
      id: randomUUID(),
      jobId: job.id,
      ownerId: job.ownerId,
      spaceId: job.spaceId,
      step,
      unit,
      priority: job.priority,
      request: call,
    });
    const row = await this.queue.whenSettled(enqueued.id, { signal });
    if (!enqueued.inserted && row.requestSha256 !== wikiModelRequestSha256(call)) {
      // The same unit of the same job was already asked with a different call: replaying the stored answer
      // would be answering a question this run did not ask.
      throw new WikiJobContentError(`the model request '${step}/${unit}' already exists with a different call`);
    }
    if (row.state === 'succeeded') return row;
    if (row.state === 'failed' && wikiModelRequestFailedOnWaitLimit(row.error)) {
      throw new WikiJobInfraError(row.error ?? 'the request waited past its step\'s limit');
    }
    throw new WikiJobContentError(row.error ?? `the model request '${step}/${unit}' ended ${row.state}`);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
