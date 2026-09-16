import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { lockOwnerTaskGraph } from '../common/lock-order';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';

/** How many `task` rows one chunk transaction writes. The knob that bounds a same-owner wait. */
export const PAUSE_PROJECTION_CHUNK = 2_000;
/**
 * Wall-clock budget for ONE chunk transaction.
 *
 * Not a retry policy and not a second chance: exceeding it kills the chunk, which the watermark
 * makes survivable (the page is simply re-done). It exists so the budget is a number this service
 * chose rather than Prisma's 5s default applied to a page that is allowed to be slow — see the
 * measurement in `sweepChunk`. Sized at ~10x the measured cost of a full page on a loaded server.
 */
export const PAUSE_PROJECTION_CHUNK_TIMEOUT_MS = 60_000;
/**
 * How long a list may be behind before it is worth a warning. Five minutes is far longer than any
 * honest projection (sub-second when the kick fires, 60s at worst when the catch-up finds it) and
 * far shorter than the window in which somebody would reasonably stop watching, which is the
 * question: this warning is the only thing that says a pause is decided but not in force.
 */
export const PAUSE_PROJECTION_LAG_WARN_MS = 5 * 60_000;
/**
 * How many full walks one sweep may make while the decision keeps moving. Past it the sweep gives
 * up and leaves the worklist to the next tick: a list toggled faster than it is swept cannot be
 * converged, and holding one sweep open against it would starve every other list behind it.
 */
export const PAUSE_PROJECTION_MAX_PASSES = 4;

export const TASK_LIST_PAUSE_PROJECTION_OPTIONS = Symbol('TASK_LIST_PAUSE_PROJECTION_OPTIONS');

export interface PauseProjectionOptions {
  /** Off means no sweeps at all — the kick and the catch-up both stop. The lag warning does not. */
  enabled?: boolean;
  chunkSize?: number;
  /** Test seam: stop a pass after this many chunks, which is what a mid-sweep crash leaves behind. */
  maxChunksPerPass?: number;
  lagWarnMs?: number;
}

/**
 * Converge `task.dispatch_hold` toward the list's current pause decision, in bounded chunks.
 *
 * WHY THIS IS NOT IN THE REQUEST
 * ------------------------------
 * 2026-09-14: PATCHing `paused` on four 27,468-task lists ran `task.updateMany({ dispatch_hold })`
 * inside the PATCH's transaction, which holds the owner graph mutex (`common/lock-order.ts` I1).
 * One sweep took 5+ minutes — `task` carries 27 indexes, a GIN and a trigram one among them — every
 * same-owner request queued behind it, clients timed out and retried, and each retry re-ran the
 * whole O(n) unit until the pool itself was gone ("nginx 499 on all /api/* for that user"). The
 * root cause was a row rewrite proportional to the list, inside a lock-holding request transaction.
 *
 * So the decision and its consequence are split. The request writes `task_list.paused` and bumps
 * `pause_epoch` in O(1) and commits; this service converges the tasks afterwards. What dispatch
 * reads is unchanged — it vetoes on the task's own `dispatch_hold`, never on the list row, which is
 * deletable (deleting 112 paused lists released 55,513 tasks that ran for a fortnight).
 *
 * WHAT IS TRUE BETWEEN THE TWO
 * ----------------------------
 * A pause is DECIDED at the PATCH and IN FORCE for dispatch once the projection reaches the tasks.
 * That window is sub-second when the kick below fires and bounded by the catch-up interval (60s,
 * the reconcile timer this rides) in the worst case. That is a stated cost of the design, not an
 * oversight — the alternative was a request that wedges its owner. A list that stays behind is
 * therefore watched, not assumed: see `warnAboutLaggingLists`.
 *
 * THE WORKLIST IS THE WATERMARK
 * -----------------------------
 * There is no cursor, no lease, no queue row and no claim table. `pause_applied_epoch < pause_epoch`
 * names the lists with work outstanding, and `task_list` is the only state this service owns. A
 * projector that dies mid-sweep strands nothing: the next pass re-claims from the watermark and
 * re-runs the chunks, and each chunk's guard (`dispatch_hold <> target`) makes re-applying one
 * write no rows. The same property is what makes the periodic catch-up sufficient — a missed kick,
 * a crash and a restart all leave the same watermark a sweep can read.
 *
 * HOW A SWEEP IS CHUNKED, AND WHAT BOUNDS IT
 * ------------------------------------------
 * One keyset page per transaction: `SELECT id … WHERE list_id = $x AND id > $after ORDER BY id
 * LIMIT n`, then `UPDATE … WHERE id = ANY($ids) AND dispatch_hold <> $target` in the SAME
 * transaction as the cursor advance. The cursor is the last id of the SELECT regardless of how many
 * rows the UPDATE matched, so a page that changed nothing still advances — otherwise a chunk that
 * changed nothing would be re-read forever.
 *
 * Each chunk is its own transaction, which is the whole point: the request path is never waiting on
 * a piece of work proportional to the list, and a chunk's wait for a lock is bounded by one page
 * rather than by the sweep. It takes the owner graph mutex for exactly that page, because I1 says a
 * transaction that writes more than one `task` row takes it (the same reason `batchAssign` does),
 * and its rows are taken in ascending id order — the order every other multi-row Task selection
 * uses. A same-owner request that wants the mutex waits for at most one page: PostgreSQL's lock
 * queue is fair, so a waiter is granted before this sweep's next chunk. The page size is the knob
 * that trades that wait against the number of transactions.
 *
 * Reads of the decision are unlocked on purpose. A `FOR SHARE` on the list row would make every
 * concurrent PATCH wait for one page of the projection — the same convoy in a smaller form — and a
 * plain read under READ COMMITTED sees the current committed decision anyway, which is all the
 * epoch comparison below needs.
 */
@Injectable()
export class TaskListPauseProjectorService {
  private readonly logger = new Logger(TaskListPauseProjectorService.name);

  /** Sweeps running in this process, by list. The claim: two sweeps of one list are one sweep. */
  private readonly sweeps = new Map<string, Promise<PauseProjectionResult>>();
  /** When each list was first seen behind, so the warning is about a DURATION and not a state. */
  private readonly laggingSince = new Map<string, number>();

  private readonly enabled: boolean;
  private readonly chunkSize: number;
  private readonly maxChunksPerPass: number;
  private readonly lagWarnMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(TASK_LIST_PAUSE_PROJECTION_OPTIONS) options: PauseProjectionOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.chunkSize = options.chunkSize ?? PAUSE_PROJECTION_CHUNK;
    // A seam for the tests that are ABOUT a projector dying mid-sweep: stopping after N chunks
    // leaves exactly what a killed process leaves — some chunks committed, the watermark unmoved —
    // without killing anything, so the resume can be asserted rather than merely hoped for.
    this.maxChunksPerPass = options.maxChunksPerPass ?? Number.POSITIVE_INFINITY;
    this.lagWarnMs = options.lagWarnMs ?? PAUSE_PROJECTION_LAG_WARN_MS;
  }

  /**
   * A list's decision just committed: converge its tasks now, in this process.
   *
   * Deliberately not awaited — the PATCH returns as soon as its own transaction commits, and the
   * projection is the consequence rather than part of the reply. Deliberately not a timer: the kick
   * is the latency, the catch-up is the guarantee, exactly as the comment handoff runs.
   */
  kick(listId: string): void {
    if (!this.enabled) return;
    void this.sweep(listId).catch((e) => this.logFailure(listId, e));
  }

  /**
   * The guarantee behind the kick: find every list whose projection is outstanding and converge it.
   *
   * Runs sequentially over the lists it finds, for the reason the reconcile timer runs its sweeps
   * sequentially — a second projection of one list is work that the guard would only throw away,
   * and a list paused mid-pass must be seen by the pass after it, not raced with.
   *
   * `now` is a parameter so the lag bound can be asserted instead of waited out.
   */
  async catchUp(now = new Date()): Promise<PauseProjectionTick> {
    const due = this.enabled ? await this.listsBehind() : [];
    let changed = 0;
    for (const row of due) {
      // One list's failure does not stop the others, and it does not stop the observation below
      // either: a list that cannot be converged is exactly the one that has to be reported, so
      // absorbing the error into the log here is what keeps the warning honest.
      try {
        changed += (await this.sweep(row.id)).changed;
      } catch (e) {
        this.logFailure(row.id, e);
      }
    }
    // The observation runs whether or not the sweeps do: a projector that is switched off, wedged
    // or crash-looping is exactly the state this warning exists to make visible, and a detector
    // that only runs while the worker runs could never report it.
    const lagging = await this.warnAboutLaggingLists(now);
    return { lists: due.length, changed, lagging };
  }

  /** One line for the log, phrased for whoever has to act on it. */
  private logFailure(listId: string, e: unknown): void {
    this.logger.error(
      `list ${listId} pause projection failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  /**
   * A list whose projection is outstanding, in a stable order.
   *
   * Unbounded on purpose: the set is "lists somebody paused and nothing has converged yet", it is
   * emptied by the sweeps below, and a LIMIT would only make a long-behind list's wait depend on how
   * many OTHER lists happen to be behind it.
   */
  private listsBehind(): Promise<Array<{ id: string }>> {
    return this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "task_list"
       WHERE "pause_applied_epoch" < "pause_epoch"
       ORDER BY "id"`;
  }

  /**
   * Warn about a list that has been behind for longer than the bound — through the service logger,
   * re-armed at most once per bound so a projector that is down for a day is one warning an hour
   * rather than one per tick.
   */
  private async warnAboutLaggingLists(now: Date): Promise<number> {
    const lagging = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; paused: boolean; epoch: number; applied: number }>
    >`
      SELECT "id", "title", "paused", "pause_epoch" AS "epoch",
             "pause_applied_epoch" AS "applied"
        FROM "task_list"
       WHERE "pause_applied_epoch" < "pause_epoch"
       ORDER BY "id"`;
    const behind = new Set(lagging.map((row) => row.id));
    for (const id of [...this.laggingSince.keys()]) {
      if (!behind.has(id)) this.laggingSince.delete(id);
    }
    const nowMs = now.getTime();
    for (const row of lagging) {
      const since = this.laggingSince.get(row.id) ?? nowMs;
      if (nowMs - since < this.lagWarnMs) {
        this.laggingSince.set(row.id, since);
        continue;
      }
      this.laggingSince.set(row.id, nowMs);
      this.logger.warn(
        `task list ${row.id} ("${row.title}") has been behind on its pause projection for `
          + `${Math.round((nowMs - since) / 1000)}s: paused=${row.paused}, `
          + `pause_epoch=${row.epoch}, pause_applied_epoch=${row.applied}. Its tasks still have the `
          + `${
            row.paused ? 'pre-pause' : 'paused'
          } dispatch_hold, so dispatch is not yet honouring this decision.`,
      );
    }
    return lagging.length;
  }

  /**
   * One list, from watermark to watermark. Returns what it actually wrote.
   *
   * Public because it is the operation both callers want: `kick` fires it and forgets, the
   * catch-up walks the worklist with it. It is also the honest unit to drive from a test —
   * `catchUp` is fleet-wide, and a caller that cares what ONE list cost should ask about that list.
   *
   * The claim is in-process and per list. It is deliberately not a lasting row lock: `task_list`
   * FOR UPDATE would hold the very row the PATCH needs (rank 20) for the length of a sweep — the
   * convoy this change exists to remove, moved to the background. Two replicas sweeping one list at
   * once is therefore possible and is not a corruption: every chunk re-reads the decision inside its
   * own transaction (below), so a sweep whose epoch moved restarts its pass instead of finishing
   * one it no longer agrees with, and the watermark can only ever be advanced to an epoch whose
   * pass completed. The cost of the overlap is duplicated work, and it is bounded by the fact that
   * this sweep is what the catch-up scan would have started anyway.
   */
  sweep(listId: string): Promise<PauseProjectionResult> {
    const running = this.sweeps.get(listId);
    if (running) return running;
    const sweep = this.runSweep(listId).finally(() => this.sweeps.delete(listId));
    this.sweeps.set(listId, sweep);
    return sweep;
  }

  private async runSweep(listId: string): Promise<PauseProjectionResult> {
    let changed = 0;
    // A pass is one full keyset walk at one decision. A pass that finds the decision moved restarts
    // from the beginning of the list rather than continuing: rows the earlier pass wrote carry the
    // older target, and re-walking them is what makes the last decision win. Bounded, because a
    // list toggled faster than it is swept should not hold a sweep open forever — the watermark
    // still names the work, so the next kick or tick picks it up.
    for (let pass = 0; pass < PAUSE_PROJECTION_MAX_PASSES; pass += 1) {
      const start = await this.readDecision(listId);
      if (!start) return { changed };
      if (start.applied >= start.epoch) return { changed };
      let cursor: string | null = null;
      let chunks = 0;
      for (;;) {
        const step = await this.sweepChunk({
          listId,
          cursor,
          target: start.paused,
          epoch: start.epoch,
        });
        if (step.kind === 'settled') return { changed: changed + step.changed };
        if (step.kind === 'moved') break;
        cursor = step.cursor;
        changed += step.changed;
        chunks += 1;
        if (chunks >= this.maxChunksPerPass) return { changed };
      }
    }
    return { changed };
  }

  /** The current decision, read without a lock. Null when the list is gone. */
  private async readDecision(listId: string): Promise<PauseDecision | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ paused: boolean; epoch: number; applied: number }>
    >`
      SELECT "paused", "pause_epoch" AS "epoch", "pause_applied_epoch" AS "applied"
        FROM "task_list" WHERE "id" = ${listId}::uuid`;
    const row = rows[0];
    return row ? { paused: row.paused, epoch: row.epoch, applied: row.applied } : null;
  }

  /**
   * One page of one list, in one transaction.
   *
   * Everything the chunk decides is read INSIDE it, under the locks it takes, so a retry re-derives
   * from the world that actually won rather than replaying a decision read before the conflict —
   * the same rule `writePolicy` follows. That is also what makes the epoch check meaningful: the
   * `pause_epoch` compared here is read after the owner mutex is held, so a PATCH that committed
   * while this chunk waited is seen and the pass restarts.
   */
  private sweepChunk(input: {
    listId: string;
    cursor: string | null;
    target: boolean;
    epoch: number;
  }): Promise<ChunkStep> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const [head] = await tx.$queryRaw<Array<{ own: string }>>`
          SELECT "owner_id"::text AS "own" FROM "task_list" WHERE "id" = ${input.listId}::uuid`;
        if (!head) return { kind: 'settled', changed: 0 } as ChunkStep;
        // Rank 10 first (I1, then rank 50 for the task rows below). A page is more than one row, so
        // the mutex is not optional — the same reason `batchAssign` takes it.
        await lockOwnerTaskGraph(tx, head.own);
        const [row] = await tx.$queryRaw<Array<{ paused: boolean; epoch: number }>>`
          SELECT "paused", "pause_epoch" AS "epoch"
            FROM "task_list" WHERE "id" = ${input.listId}::uuid`;
        if (!row) return { kind: 'settled', changed: 0 } as ChunkStep;
        if (row.epoch !== input.epoch) return { kind: 'moved', changed: 0 } as ChunkStep;
        const page = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "task"
           WHERE "list_id" = ${input.listId}::uuid
             AND (${input.cursor}::uuid IS NULL OR "id" > ${input.cursor}::uuid)
           ORDER BY "id"
           LIMIT ${this.chunkSize}`;
        if (page.length === 0) {
          // The pass is complete at this epoch, so this is where the watermark moves — in the same
          // transaction as the empty page that proved it, and only forwards.
          await tx.$executeRaw`
            UPDATE "task_list" SET "pause_applied_epoch" = ${input.epoch}
             WHERE "id" = ${input.listId}::uuid AND "pause_applied_epoch" < ${input.epoch}`;
          return { kind: 'settled', changed: 0 } as ChunkStep;
        }
        // `dispatch_hold <> target` is the idempotence: a re-run after a crash, a duplicated sweep
        // or a chunk that lost its race rewrites nothing, bumps no `updated_at` and touches none of
        // the 27 indexes. It also means the returned count is literally what this sweep changed.
        const written = await tx.$executeRaw`
          UPDATE "task"
             SET "dispatch_hold" = ${input.target}, "updated_at" = now()
           WHERE "id" = ANY(${page.map((row) => row.id)}::uuid[])
             AND "dispatch_hold" <> ${input.target}`;
        return { kind: 'chunk', cursor: page[page.length - 1].id, changed: written } as ChunkStep;
      },
      loggedRetry(this.logger, 'taskListPauseProjection.sweepChunk', {
        // A chunk is bounded by `chunkSize` rows, and each row is a heap write plus an entry in
        // every index on `task` — 27 of them, measured at ~3-7ms per row on a loaded server for a
        // 2,000-row page. Prisma's default interactive-transaction budget is 5s, which a page this
        // size exceeds under load: it aborts with P2028, the sweep loses the chunk, and the page is
        // simply re-done by the next sweep (the watermark is the worklist, so nothing is stranded).
        // That is a working design and a bad failure mode — a page that always takes 6s would never
        // converge. The budget is declared here instead, as `taskLists.remove` declares its own for
        // the same reason, and handed to every attempt rather than only the first.
        transaction: { timeout: PAUSE_PROJECTION_CHUNK_TIMEOUT_MS, maxWait: 10_000 },
      }),
    );
  }
}

/** How many `task` rows one chunk transaction writes. */
interface PauseDecision {
  paused: boolean;
  epoch: number;
  applied: number;
}

type ChunkStep =
  /** The page advanced the cursor. */
  | { kind: 'chunk'; cursor: string; changed: number }
  /** A newer decision landed: this pass cannot finish, and re-walking is what applies the new one. */
  | { kind: 'moved'; changed: number }
  /** The pass completed at this epoch (the watermark moved) or the list is gone. */
  | { kind: 'settled'; changed: number };

export interface PauseProjectionResult {
  /** Task rows this sweep actually rewrote — zero on a sweep that found nothing to change. */
  changed: number;
}

export interface PauseProjectionTick {
  /** Lists swept this tick. */
  lists: number;
  /** Task rows rewritten this tick, across those lists. */
  changed: number;
  /** Lists still behind after the sweeps, which is what the warning is about. */
  lagging: number;
}
