import { randomUUID } from 'crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NormalizedRunEvent, RunEventType } from '@orbit/shared';
import { Subscription } from 'rxjs';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  countWatchDuplicateSuppressed,
  countWatchEvaluation,
  countWatchReconcileRepair,
  observeWatchEvaluationDelay,
} from './watch-metrics';
import {
  describePredicate,
  leafHolds,
  leafVerdicts,
  nextStallDeadline,
  observationOf,
  parseWatchPredicate,
  predicateHolds,
  predicateLeafTests,
  predicateReachable,
  WatchLeafTest,
  WatchTargetFact,
  WatchTargetKind,
} from './watch-predicate';
import { currentWatchRollout, watchWorkersRun, type WatchRollout } from './watch-rollout';

/**
 * The Watch evaluator (docs/watch-contract.md §8, §12): it decides from the database, schedules on
 * `watch.next_evaluate_at`, and treats every real-time event as a hint that can only move a decision
 * earlier.
 *
 * THE LOOP
 * One timer per replica, however many watches exist. A pass claims what is due and evaluates it; a
 * hint that made something due starts a pass at once instead of waiting for the timer. A watch that
 * is waiting costs a row and an index entry — no timer, no process and no session of its own.
 *
 * THE LEASE
 * Claiming a due watch moves its `next_evaluate_at` forward by the lease, in one statement that
 * skips rows somebody else holds. No other worker takes it while the lease runs; a worker that dies
 * holding it lets it lapse, and the watch is due again for whoever looks next. The lease decides who
 * spends the effort, never what is true.
 *
 * THE LANDING
 * One transaction holding the watch's row lock re-reads the watch, its targets and every source
 * column its leaves name, decides, and writes the decision as a compare-and-set on the state and
 * generation it read. Nothing is carried in from outside that transaction, so a worker whose lease
 * lapsed decides from the same rows as the worker that took over: a watch already MATCHED is left
 * alone, and `watch_match_watch_generation_key` makes a second Match of one generation a
 * constraint rather than a race somebody has to lose.
 *
 * THE HINTS
 * An event this replica published about a session, or naming tasks, pulls the watches targeting
 * exactly those rows to due. That is all a hint can do: its payload is never read for a verdict, a
 * duplicate finds the watch already due, and one that arrives out of order only causes an
 * evaluation that re-reads the rows. A hint never waits in the database for a watch another
 * transaction holds — it passes the row over and asks again after a pause, holding no connection
 * in between (see `markDue`). A hint that never arrives costs latency and nothing else,
 * because a live watch is never scheduled more than `reconcileIntervalMs` ahead — and for the
 * leaves no event covers at all (a session moved to Completed, an approval row) that sweep is the
 * mechanism, not a backstop.
 *
 * STALLS
 * A no-progress leaf starts to hold when a Task's reported position has gone unchanged for its window.
 * Nothing announces that moment — it is the absence of a report — so the landing that sees one coming
 * schedules the watch's next evaluation at it: `next_evaluate_at` becomes the earliest stall deadline,
 * and the claim that serves every due watch serves this one. No sleep, timer or process waits on a watch.
 *
 * CONTINUOUS
 * A CONTINUOUS watch matches at crossings: its predicate holding at an evaluation when it did not at the
 * last landing (`holding`). A crossing opens a coalescing window of the watch's `debounce_seconds`; the
 * crossings seen before the window closes are counted into it, and the evaluation at its close records
 * ONE Match for all of them, at the next generation, with its one delivery. However fast its targets
 * change, a continuous watch therefore records at most one Match per window and never more than its
 * `wake_budget` in all — the Match that uses the last of the budget settles it at MATCHED. An expiry,
 * revocation or unresolvable end that comes while a window is open ends the watch without that window's
 * Match; an expiry's snapshot names the window instead.
 *
 * NOT HERE
 * What a Match causes — a turn, a notification — is the delivery worker's; its row joins the Match
 * inside `land`, and so does the row for the turn a RESUME_SESSION watch's end owes its observer when
 * the watch expires, is revoked or becomes unresolvable (contract §3, §5).
 */

/** How long a claim keeps a due watch from every other worker. Far longer than one evaluation. */
export const WATCH_EVALUATION_LEASE_MS = 60_000;
/** The furthest ahead a live watch is scheduled: the reconciliation period, and the most a lost hint can cost. */
export const WATCH_RECONCILE_INTERVAL_MS = 60_000;
/** How often the loop looks for due watches when no hint has started a pass. */
export const WATCH_POLL_INTERVAL_MS = 5_000;
/** Due watches taken per claim. */
export const WATCH_CLAIM_BATCH = 25;
/** How soon a hint asks again about a watch it found another transaction holding: a landing takes milliseconds. */
export const WATCH_HINT_RETRY_MS = 50;
/** The longest pause between two asks, however long that watch stays held. */
export const WATCH_HINT_RETRY_MAX_MS = 1_000;

export const WATCH_EVALUATOR_OPTIONS = Symbol('WATCH_EVALUATOR_OPTIONS');

export interface WatchEvaluatorOptions {
  leaseMs?: number;
  reconcileIntervalMs?: number;
  pollIntervalMs?: number;
  claimBatch?: number;
  /** How far Watch is switched on (docs/watch-rollout.md); ORBIT_WATCHES as the environment sets it when omitted. */
  rollout?: WatchRollout;
}

/**
 * What one evaluation concluded. `MATCHED`: it recorded a Match — which settles a ONE_SHOT watch, and a
 * CONTINUOUS one only when that Match used the last of its wake budget. `SETTLED`: the watch was already
 * terminal or gone, and nothing was written.
 */
export type WatchEvaluationOutcome = 'MATCHED' | 'EXPIRED' | 'UNRESOLVABLE' | 'REVOKED' | 'SCHEDULED' | 'SETTLED';

export interface WatchEvaluation {
  watchId: string;
  outcome: WatchEvaluationOutcome;
  /** The Match this evaluation recorded, if it recorded one. */
  matchId: string | null;
}

/**
 * The kind of delivery row a RESUME_SESSION watch's end owes its observer, by the outcome that ended it
 * (contract §3, §5). A Match has a delivery of its own. CANCELLED is never an evaluation's outcome, and it
 * wakes nobody: cancelling is something the owner or the observer did.
 */
const END_DELIVERY_KIND: Partial<Record<WatchEvaluationOutcome, string>> = {
  EXPIRED: 'EXPIRY',
  REVOKED: 'REVOKED',
  UNRESOLVABLE: 'UNRESOLVABLE',
};

/**
 * Session events that can move a session leaf's source columns: status, lifecycle and approvals.
 * SESSION_UPDATED is among them because it is the only one a turn that ends without failing
 * publishes after /turn-complete commits the settled status: the TURN_END the runner flushed ahead
 * of that call went out while the row still read RUNNING. A rename or a tag edit announces it too,
 * which costs each watch on that session one evaluation that re-reads the rows.
 */
const SESSION_HINT_EVENTS: ReadonlySet<string> = new Set([
  RunEventType.STATUS,
  RunEventType.SESSION_ENDED,
  RunEventType.SESSION_CREATED,
  RunEventType.SESSION_UPDATED,
  RunEventType.APPROVAL_REQUEST,
  RunEventType.APPROVAL_RESOLVED,
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The exact rows an event names, or null. Only identities are taken from it — the session it was
 * published on, the task ids a task.changed lists — and nothing it says about them. A task.changed
 * that asks for a resync names no row, so it hints nothing and the sweep answers it.
 */
export function watchHintFor(
  runId: string,
  event: NormalizedRunEvent,
): { kind: WatchTargetKind; ids: string[] } | null {
  if (event.type === RunEventType.TASK_CHANGED) {
    const payload = (event.payload ?? {}) as { taskId?: unknown; taskIds?: unknown };
    const ids = [...(Array.isArray(payload.taskIds) ? payload.taskIds : []), payload.taskId].filter(
      (id): id is string => typeof id === 'string' && UUID.test(id),
    );
    return ids.length > 0 ? { kind: 'TASK', ids: [...new Set(ids)] } : null;
  }
  return SESSION_HINT_EVENTS.has(event.type) && UUID.test(runId) ? { kind: 'SESSION', ids: [runId] } : null;
}

interface WatchRow {
  ownerId: string;
  state: string;
  mode: string;
  action: string;
  predicate: unknown;
  predicateVersion: number;
  generation: number;
  debounceSeconds: number | null;
  wakeBudget: number | null;
  holding: boolean;
  windowOpenedAt: Date | null;
  windowClosesAt: Date | null;
  windowCrossings: number;
  expiresAt: Date;
  /** The transaction's clock: every time this evaluation compares is the database's. */
  now: Date;
}

interface TargetRow {
  id: string;
  kind: WatchTargetKind;
  resourceId: string;
  state: string;
  epoch: number;
}

type OwnedFact = WatchTargetFact & { ownerId: string };

interface TargetStateChange {
  id: string;
  state: string;
  /** The lifecycle epoch the target was observed in. */
  epoch: number;
}

/** A CONTINUOUS watch's open coalescing window. */
interface CoalescingWindow {
  openedAt: Date;
  closesAt: Date;
  crossings: number;
}

interface WatchDecision {
  outcome: Exclude<WatchEvaluationOutcome, 'SETTLED'>;
  state: string;
  generation: number;
  holding: boolean;
  window: CoalescingWindow | null;
  nextEvaluateAt: Date | null;
  targetStates: TargetStateChange[];
  match: { reason: string; snapshot: Record<string, unknown> } | null;
  /** Set exactly when the decision is EXPIRED: the snapshot an expiry delivery carries. */
  expirySnapshot: Record<string, unknown> | null;
}

/** One watch a hint's ask named: whether it moved, whether it was free to, and what a later ask compares (see `markDue`). */
interface HintedWatch {
  id: string;
  pulled: boolean;
  free: boolean;
  seen: string | null;
  at: string;
}

@Injectable()
export class WatchEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WatchEvaluator');
  private readonly leaseMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly claimBatch: number;
  private readonly rollout: WatchRollout;

  private loop: 'IDLE' | 'RUNNING' | 'STOPPED' = 'IDLE';
  private hints?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;
  /** Something became due during the pass: go round again instead of waiting for the timer. */
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Optional() @Inject(WATCH_EVALUATOR_OPTIONS) options: WatchEvaluatorOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? WATCH_EVALUATION_LEASE_MS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? WATCH_RECONCILE_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;
    this.claimBatch = options.claimBatch ?? WATCH_CLAIM_BATCH;
    this.rollout = options.rollout ?? currentWatchRollout();
  }

  onModuleInit(): void {
    // ORBIT_WATCHES=off (docs/watch-rollout.md): every watch stays as it is, due or not, until a replica that runs the
    // loop starts it again, and that replica's first pass is the one that finds what came due meanwhile.
    if (!watchWorkersRun(this.rollout)) {
      this.log.warn('Watch is off (ORBIT_WATCHES=off): this replica evaluates no watch');
      return;
    }
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Take hints and run the loop. The first pass starts at once: it is what finds everything that came due while no replica was running. */
  start(): void {
    if (this.loop === 'RUNNING') return;
    this.loop = 'RUNNING';
    this.hints = this.realtime.localPublications().subscribe(({ runId, event }) => {
      const hint = watchHintFor(runId, event);
      if (hint) void this.hint(hint.kind, hint.ids);
    });
    this.kick();
  }

  /** Stop taking hints and stop the loop. The pass in flight finishes the watches it already claimed and claims no more. */
  async stop(): Promise<void> {
    this.loop = 'STOPPED';
    this.hints?.unsubscribe();
    this.hints = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /** Start a pass now, or — when one is running — make it go round once more. */
  kick(): void {
    if (this.loop !== 'RUNNING') return;
    if (this.pass) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pass = this.runPass().finally(() => {
      this.pass = undefined;
      if (this.again) this.kick();
      else this.arm();
    });
  }

  private async runPass(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.drain();
      } catch (error) {
        this.log.error(`watch sweep failed: ${error instanceof Error ? error.message : error}`);
        this.again = false; // a database that is failing is retried by the timer, not by every hint
        return;
      }
    } while (this.again && this.loop === 'RUNNING');
  }

  private arm(): void {
    if (this.loop !== 'RUNNING') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.pollIntervalMs);
    this.timer.unref(); // never what keeps a process alive
  }

  /**
   * Claim what is due and evaluate it, until a claim comes back short. Every watch a claim returned
   * is evaluated even when the loop is stopping — abandoning one would hold it for the rest of its
   * lease — and a stopping loop only claims no more. Returns how many evaluations landed.
   */
  async drain(): Promise<number> {
    let evaluated = 0;
    for (;;) {
      const claimed = await this.claimDueWithDelay();
      for (const { id: watchId, dueSeconds } of claimed) {
        const startedAt = Date.now();
        try {
          await this.evaluate(watchId);
          evaluated += 1;
          observeWatchEvaluationDelay(dueSeconds + (Date.now() - startedAt) / 1_000);
        } catch (error) {
          // Its lease lapses and it is due again; one watch that cannot be evaluated holds up no other.
          countWatchEvaluation('FAILED');
          this.log.error(`watch ${watchId} evaluation failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (claimed.length < this.claimBatch || this.loop === 'STOPPED') return evaluated;
    }
  }

  /** `claimDue`, with how long each watch it claimed had been due, on the database's clock. */
  private async claimDueWithDelay(): Promise<Array<{ id: string; dueSeconds: number }>> {
    return this.prisma.$queryRaw<Array<{ id: string; dueSeconds: number }>>`
      UPDATE "watch" AS w
      SET "next_evaluate_at" = LEAST(now() + ${this.leaseMs}::int * interval '1 millisecond', w."expires_at")
      FROM (
        SELECT "id", "next_evaluate_at" FROM "watch"
        WHERE "next_evaluate_at" <= now()
        ORDER BY "next_evaluate_at", "id"
        LIMIT ${this.claimBatch}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE w."id" = due."id"
      RETURNING w."id", EXTRACT(EPOCH FROM now() - due."next_evaluate_at")::float8 AS "dueSeconds"`;
  }

  /**
   * Take up to `claimBatch` due watches under the lease, the longest-due first, from the partial
   * `watch_due_idx`. `SKIP LOCKED` is what lets replicas claim side by side: a row another claim,
   * hint or landing holds is passed over rather than waited for. The lease never runs past
   * `expires_at` (`watch_next_evaluate_within_ttl_chk`), so a watch claimed at its expiry stays due —
   * a second claimer can only repeat a landing that finds it settled.
   */
  async claimDue(): Promise<string[]> {
    return (await this.claimDueWithDelay()).map((claimed) => claimed.id);
  }

  /** A hint, applied (see `markDue`). A hint that fails is a hint that was lost, which the sweep absorbs. */
  async hint(kind: WatchTargetKind, resourceIds: readonly string[]): Promise<number> {
    try {
      return await this.markDue(kind, resourceIds);
    } catch (error) {
      this.log.warn(`watch hint failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
  }

  /**
   * Make every ACTIVE watch with a target of this kind and one of these ids due now, and start a pass
   * as soon as that moved anything; returns how many moved. A watch already due is not written again,
   * and a terminal one has no schedule to move.
   *
   * A watch another transaction holds — a landing, a claim, a transition, another hint — is passed over
   * and asked about again after a pause, with no connection held in between, until it is found free.
   * Waiting for the row instead would hold a pooled connection for as long as the holder runs, and a
   * landing parked on a lock runs for as long as that lock is held: a burst of hints would hold the
   * replica's whole pool. Asking again is what keeps the hint, and what it asks is whether the holder
   * was a landing that began before this hint's first ask — one that may have read its rows before the
   * change the hint announces, and so lands a schedule a reconciliation period away. Only then is the
   * watch made due: its `last_evaluated_at` has moved since that first ask, to a time no later than it.
   * Any other holder left nothing to catch up on — a claim or a hint is followed by an evaluation that
   * reads the rows afresh, and a landing that began later already did — and making the watch due again
   * would only run a second evaluation beside that one. The asking stops when the loop stops, and once
   * a reconciliation period has passed, by which time the sweep has come round.
   */
  async markDue(kind: WatchTargetKind, resourceIds: readonly string[]): Promise<number> {
    if (resourceIds.length === 0) return 0;
    let asked: Prisma.Sql = Prisma.sql`
      SELECT DISTINCT "watch_id" AS "id", NULL::text AS "seen" FROM "watch_target"
      WHERE "target_kind" = ${kind} AND "target_resource_id" = ANY(${[...resourceIds]}::uuid[])`;
    /** The first ask's clock, and — per watch it found held — the `last_evaluated_at` it read: null until then. */
    let firstAskAt: string | null = null;
    const startedAt = Date.now();
    let pulled = 0;
    for (let pause = WATCH_HINT_RETRY_MS; ; pause = Math.min(pause * 2, WATCH_HINT_RETRY_MAX_MS)) {
      const hinted: HintedWatch[] = await this.prisma.$queryRaw<HintedWatch[]>`
        WITH "asked" AS (${asked}), "hinted" AS (
          SELECT w."id", w."last_evaluated_at"::text AS "last", a."seen" FROM "watch" w JOIN "asked" a ON a."id" = w."id"
          WHERE w."state" = 'ACTIVE' AND w."next_evaluate_at" > now()
        ), "free" AS (
          SELECT "id" FROM "watch"
          WHERE "id" IN (SELECT "id" FROM "hinted") AND "state" = 'ACTIVE' AND "next_evaluate_at" > now()
          FOR UPDATE SKIP LOCKED
        ), "pulled" AS (
          UPDATE "watch" AS w
          SET "next_evaluate_at" = now()
          FROM "hinted" AS h
          WHERE w."id" = h."id" AND w."id" IN (SELECT "id" FROM "free")
            AND (${firstAskAt}::timestamptz IS NULL OR (w."last_evaluated_at" IS DISTINCT FROM h."seen"::timestamptz
                                                        AND w."last_evaluated_at" <= ${firstAskAt}::timestamptz))
          RETURNING w."id"
        )
        SELECT h."id", h."id" IN (SELECT "id" FROM "pulled") AS "pulled", h."id" IN (SELECT "id" FROM "free") AS "free",
               CASE WHEN ${firstAskAt}::text IS NULL THEN h."last" ELSE h."seen" END AS "seen",
               coalesce(${firstAskAt}::text, now()::text) AS "at"
        FROM "hinted" AS h`;
      const held: HintedWatch[] = hinted.filter((watch) => !watch.free);
      const moved = hinted.filter((watch) => watch.pulled).length;
      if (moved > 0) {
        pulled += moved;
        this.kick();
      }
      if (held.length === 0 || Date.now() - startedAt + pause > this.reconcileIntervalMs) return pulled;
      await new Promise((resolve) => setTimeout(resolve, pause).unref());
      if (this.loop === 'STOPPED') return pulled;
      firstAskAt = held[0].at;
      asked = Prisma.sql`
        SELECT * FROM unnest(${held.map((watch) => watch.id)}::uuid[], ${held.map((watch) => watch.seen)}::text[]) AS h("id", "seen")`;
    }
  }

  /**
   * Decide one watch from the rows and land the decision, inside one transaction that holds the
   * watch's row lock from the first read to the last write. Safe for any watch at any time, leased
   * or not — see THE LANDING above.
   */
  async evaluate(watchId: string): Promise<WatchEvaluation> {
    // What the attempt that committed wrote, for the counters: a retried attempt overwrites an aborted one's.
    let gone = 0;
    let adopted = false;
    const evaluation = await withTransactionRetry(this.prisma, async (tx): Promise<WatchEvaluation> => {
      gone = 0;
      adopted = false;
      const [watch] = await tx.$queryRaw<WatchRow[]>`
        SELECT "owner_id" AS "ownerId", "state", "mode", "action", "predicate",
               "predicate_version" AS "predicateVersion", "generation",
               "debounce_seconds" AS "debounceSeconds", "wake_budget" AS "wakeBudget", "holding",
               "window_opened_at" AS "windowOpenedAt", "window_closes_at" AS "windowClosesAt",
               "window_crossings" AS "windowCrossings",
               "expires_at" AS "expiresAt", now() AS "now"
        FROM "watch"
        WHERE "id" = ${watchId}::uuid
        FOR UPDATE`;
      if (!watch || (watch.state !== 'ACTIVE' && watch.state !== 'PAUSED')) {
        return { watchId, outcome: 'SETTLED', matchId: null };
      }
      const targets = await readTargets(tx, watchId);
      const decision = decide(watch, targets, await readFacts(tx, targets), this.reconcileIntervalMs);
      const matchId = await this.land(tx, watchId, watch, decision);
      gone = decision.targetStates.filter((change) => change.state === 'GONE').length;
      adopted = decision.match !== null && matchId === null;
      return { watchId, outcome: decision.outcome, matchId };
    }, loggedRetry(this.log, 'watches.evaluate'));
    countWatchEvaluation(evaluation.outcome);
    if (evaluation.outcome === 'SETTLED') countWatchDuplicateSuppressed('settled_evaluation');
    if (adopted) countWatchDuplicateSuppressed('match');
    countWatchReconcileRepair('target_gone', gone);
    return evaluation;
  }

  private async land(
    tx: Prisma.TransactionClient,
    watchId: string,
    read: WatchRow,
    decision: WatchDecision,
  ): Promise<string | null> {
    if (decision.targetStates.length > 0) {
      await tx.$executeRaw`
        UPDATE "watch_target" AS t
        SET "state" = v."state", "target_epoch" = v."epoch", "last_evaluated_at" = now()
        FROM unnest(${decision.targetStates.map((change) => change.id)}::uuid[],
                    ${decision.targetStates.map((change) => change.state)}::text[],
                    ${decision.targetStates.map((change) => change.epoch)}::int[]) AS v("id", "state", "epoch")
        WHERE t."id" = v."id" AND t."watch_id" = ${watchId}::uuid`;
    }
    let matchId: string | null = null;
    if (decision.match) {
      // A Match of this generation already on record is adopted, not duplicated: the unique key is
      // what makes the second landing of one crossing the same event as the first.
      const [recorded] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "watch_match" ("id", "watch_id", "generation", "reason", "predicate_version", "per_target_snapshot")
        VALUES (${randomUUID()}::uuid, ${watchId}::uuid, ${decision.generation}, ${decision.match.reason},
                ${read.predicateVersion}, ${JSON.stringify(decision.match.snapshot)}::jsonb)
        ON CONFLICT ("watch_id", "generation") DO NOTHING
        RETURNING "id"`;
      matchId = recorded?.id ?? null;
      if (matchId) {
        // The effect's row joins the fact in the transaction that records it: a Match that commits
        // has its delivery, and one that rolls back takes its delivery with it. A Match adopted above
        // already has the delivery that was written with it, and `(match_id, action)` keeps one.
        await tx.$executeRaw`
          INSERT INTO "watch_delivery" ("id", "match_id", "action", "next_attempt_at")
          VALUES (${randomUUID()}::uuid, ${matchId}::uuid, ${read.action}, now())
          ON CONFLICT ("match_id", "action") DO NOTHING`;
      }
    }
    const endKind = END_DELIVERY_KIND[decision.outcome];
    if (endKind && read.action === 'RESUME_SESSION') {
      // Contract §3, §5: a watch that ends unmatched still owes the session waiting on it one turn that
      // says how it ended. That delivery's row joins this landing the way a Match's row joins the Match:
      // the end and its delivery commit together or not at all, and `watch_delivery_expiry_watch_key`
      // allows one per watch, whichever way it ended. Only an expiry carries a snapshot; a REVOKED watch
      // reports nothing about its targets (§7). A watch that matched is terminal, so no later landing
      // reaches this line.
      await tx.$executeRaw`
        INSERT INTO "watch_delivery" ("id", "kind", "watch_id", "action", "expiry_snapshot", "next_attempt_at")
        VALUES (${randomUUID()}::uuid, ${endKind}, ${watchId}::uuid, ${read.action},
                ${decision.expirySnapshot ? JSON.stringify(decision.expirySnapshot) : null}::jsonb, now())
        ON CONFLICT ("watch_id") WHERE "watch_id" IS NOT NULL DO NOTHING`;
    }
    const landed = await tx.$executeRaw`
      UPDATE "watch"
      SET "state" = ${decision.state},
          "generation" = ${decision.generation},
          "next_evaluate_at" = ${decision.nextEvaluateAt},
          "last_evaluated_at" = now(),
          "holding" = ${decision.holding},
          "window_opened_at" = ${decision.window?.openedAt ?? null},
          "window_closes_at" = ${decision.window?.closesAt ?? null},
          "window_crossings" = ${decision.window?.crossings ?? 0},
          "updated_at" = CASE WHEN "state" = ${decision.state} AND "generation" = ${decision.generation}
                              THEN "updated_at" ELSE now() END
      WHERE "id" = ${watchId}::uuid AND "state" = ${read.state} AND "generation" = ${read.generation}`;
    if (landed !== 1) throw new Error(`watch ${watchId} changed under its own row lock`);
    return matchId;
  }
}

async function readTargets(tx: Prisma.TransactionClient, watchId: string): Promise<TargetRow[]> {
  return tx.$queryRaw<TargetRow[]>`
    SELECT "id", "target_kind" AS "kind", "target_resource_id" AS "resourceId", "state",
           "target_epoch" AS "epoch"
    FROM "watch_target"
    WHERE "watch_id" = ${watchId}::uuid
    ORDER BY "id"`;
}

/**
 * The leaves' source columns (contract `leaves[].sourceColumns`) for every target not yet GONE, plus the
 * owner the permission recheck compares. A Task's progress and lifecycle epoch come from `task_progress`,
 * and a Task with no row there is in epoch 0, begun at its creation, with nothing reported. The report's
 * message is not read: no leaf may decide from it.
 */
async function readFacts(tx: Prisma.TransactionClient, targets: readonly TargetRow[]): Promise<Map<string, OwnedFact>> {
  const ids = (kind: WatchTargetKind) =>
    targets.filter((target) => target.kind === kind && target.state !== 'GONE').map((target) => target.resourceId);
  const facts = new Map<string, OwnedFact>();
  const taskIds = ids('TASK');
  if (taskIds.length > 0) {
    const tasks = await tx.$queryRaw<Array<{
      id: string;
      ownerId: string;
      status: string;
      epoch: number;
      epochStartedAt: Date;
      phase: string | null;
      current: number | null;
      total: number | null;
      lastProgressAt: Date | null;
    }>>`
      SELECT t."id", t."owner_id" AS "ownerId", t."status"::text AS "status",
             COALESCE(p."lifecycle_epoch", 0) AS "epoch",
             COALESCE(p."epoch_started_at", t."created_at" AT TIME ZONE 'UTC') AS "epochStartedAt",
             p."phase", p."current", p."total", p."last_progress_at" AS "lastProgressAt"
      FROM "task" t
      LEFT JOIN "task_progress" p ON p."task_id" = t."id"
      WHERE t."id" = ANY(${taskIds}::uuid[])`;
    for (const task of tasks) {
      facts.set(`TASK:${task.id}`, {
        kind: 'TASK',
        ownerId: task.ownerId,
        status: task.status,
        epoch: task.epoch,
        epochStartedAt: task.epochStartedAt,
        progress: { phase: task.phase, current: task.current, total: task.total, lastProgressAt: task.lastProgressAt },
      });
    }
  }
  const sessionIds = ids('SESSION');
  if (sessionIds.length > 0) {
    const sessions = await tx.$queryRaw<Array<Extract<WatchTargetFact, { kind: 'SESSION' }> & { id: string; ownerId: string }>>`
      SELECT s."id", s."owner_id" AS "ownerId", s."status"::text AS "status", s."end_reason" AS "endReason",
             s."completed_at" AS "completedAt", s."archived_at" AS "archivedAt", s."deleted_at" AS "deletedAt",
             EXISTS (SELECT 1 FROM "approval" a WHERE a."session_id" = s."id" AND a."status" = 'PENDING') AS "pendingApproval"
      FROM "session" s
      WHERE s."id" = ANY(${sessionIds}::uuid[])`;
    for (const { id, ...session } of sessions) facts.set(`SESSION:${id}`, { ...session, kind: 'SESSION' });
  }
  return facts;
}

function decide(
  watch: WatchRow,
  targets: readonly TargetRow[],
  facts: ReadonlyMap<string, OwnedFact>,
  reconcileIntervalMs: number,
): WatchDecision {
  const now = watch.now.getTime();
  const expired = now >= watch.expiresAt.getTime();
  const open: CoalescingWindow | null = watch.windowOpenedAt && watch.windowClosesAt
    ? { openedAt: watch.windowOpenedAt, closesAt: watch.windowClosesAt, crossings: watch.windowCrossings }
    : null;
  // A watch that ends keeps no window: what it was coalescing will not become a Match.
  const end = (
    outcome: 'UNRESOLVABLE' | 'REVOKED' | 'EXPIRED',
    targetStates: TargetStateChange[],
    expirySnapshot: Record<string, unknown> | null = null,
  ): WatchDecision => ({
    outcome, state: outcome, generation: watch.generation, holding: watch.holding, window: null,
    nextEvaluateAt: null, targetStates, match: null, expirySnapshot,
  });
  // Contract §5: an expiry is delivered too, so it carries what this evaluation saw, in a Match snapshot's
  // shape — and, for a CONTINUOUS watch, the window that was still open, which no Match will close.
  const expire = (
    seen: ReadonlyArray<{ target: TargetRow; fact: OwnedFact | undefined }>,
    targetStates: TargetStateChange[],
    tests: readonly WatchLeafTest[],
    window: CoalescingWindow | null = open,
  ): WatchDecision => end('EXPIRED', targetStates, {
    ...snapshotOf(watch, seen, targetStates, tests),
    ...(window && { openWindow: { openedAt: window.openedAt.toISOString(), crossings: window.crossings } }),
  });
  const schedule = (
    at: number,
    targetStates: TargetStateChange[] = [],
    holding: boolean = watch.holding,
    window: CoalescingWindow | null = open,
  ): WatchDecision => ({
    outcome: 'SCHEDULED', state: watch.state, generation: watch.generation, holding, window,
    nextEvaluateAt: new Date(at), targetStates, match: null, expirySnapshot: null,
  });

  // Pausing stops evaluation, not the clock (contract §3): a paused watch is looked at again at its expiry and not before.
  // A paused watch skips the permission recheck, so its expiry lists the targets only as recorded, with none of their rows.
  if (watch.state === 'PAUSED') {
    return expired ? expire(targets.map((target) => ({ target, fact: undefined })), [], []) : schedule(watch.expiresAt.getTime());
  }

  const observed = targets.map((target) => ({
    target,
    fact: target.state === 'GONE' ? undefined : facts.get(`${target.kind}:${target.resourceId}`),
  }));
  // Contract §7: permission is rechecked where it is used. A target that is no longer the owner's
  // ends the watch as REVOKED before anything about that target is written down.
  if (observed.some(({ fact }) => fact && fact.ownerId !== watch.ownerId)) return end('REVOKED', []);

  // Contract §4: a deleted target is recorded GONE and leaves the set; it never counts as satisfied.
  const gone = observed
    .filter(({ target, fact }) => !fact && target.state !== 'GONE')
    .map(({ target }) => ({ id: target.id, state: 'GONE', epoch: target.epoch }));
  const live = observed.flatMap(({ target, fact }) => (fact ? [{ target, fact }] : []));
  if (live.length === 0) return end('UNRESOLVABLE', gone);

  const reconcileAt = Math.min(now + reconcileIntervalMs, watch.expiresAt.getTime());
  const predicate = parseWatchPredicate(watch.predicate, watch.predicateVersion);
  // Not a term this build can decide. Guessing would be worse than waiting: it keeps its schedule,
  // and its TTL still ends it visibly.
  if (!predicate) return expired ? expire(observed, gone, []) : schedule(reconcileAt, gone);

  const tests = predicateLeafTests(predicate);
  const liveFacts = live.map(({ fact }) => fact);
  const changes = [
    ...gone,
    ...live.flatMap(({ target, fact }) => {
      // One-shot targets stay SATISFIED once they were (contract §3 lets only CONTINUOUS go back).
      // The predicate never reads this column — it reads the rows.
      const satisfied = tests.some((test) => leafHolds(test, fact, now))
        || (watch.mode === 'ONE_SHOT' && target.state === 'SATISFIED');
      const state = satisfied ? 'SATISFIED' : 'OBSERVED';
      const epoch = fact.kind === 'TASK' ? fact.epoch : target.epoch;
      return state === target.state && epoch === target.epoch ? [] : [{ id: target.id, state, epoch }];
    }),
  ];
  const holds = predicateHolds(predicate, liveFacts, now);
  // STALLS above: the moment a stall starts to hold is the next look, since nothing will announce it.
  const stall = nextStallDeadline(predicate, liveFacts, now) ?? Infinity;

  if (watch.mode === 'ONE_SHOT') {
    // Evaluated before the expiry check: a condition that holds when the watch is looked at is a
    // Match even if the look came late, so a hint that was lost changes when, never whether.
    if (holds) {
      return {
        outcome: 'MATCHED',
        state: 'MATCHED',
        generation: watch.generation + 1,
        holding: true,
        window: null,
        nextEvaluateAt: null,
        targetStates: changes,
        match: {
          reason: describePredicate(predicate, liveFacts, now),
          snapshot: snapshotOf(watch, observed, changes, tests),
        },
        expirySnapshot: null,
      };
    }
    // A quorum larger than the set it has left can never hold, and a watch that can never be decided says so.
    if (!predicateReachable(predicate, live.length)) return end('UNRESOLVABLE', changes);
    return expired ? expire(observed, changes, tests) : schedule(Math.min(reconcileAt, stall), changes, holds);
  }

  // CONTINUOUS above: a crossing is the predicate holding now when it did not at the last landing.
  const crossed = holds && !watch.holding;
  let window = open;
  if (crossed) {
    window = open
      ? { ...open, crossings: open.crossings + 1 }
      : { openedAt: watch.now, closesAt: new Date(now + (watch.debounceSeconds ?? 0) * 1000), crossings: 1 };
  }
  if (expired) return expire(observed, changes, tests, window);
  if (window && now >= window.closesAt.getTime()) {
    const generation = watch.generation + 1;
    const budget = watch.wakeBudget ?? generation;
    const last = generation >= budget;
    const crossings = `${window.crossings} crossing${window.crossings === 1 ? '' : 's'}`;
    return {
      outcome: 'MATCHED',
      state: last ? 'MATCHED' : 'ACTIVE',
      generation,
      holding: holds,
      window: null,
      nextEvaluateAt: last ? null : new Date(Math.min(reconcileAt, stall)),
      targetStates: changes,
      match: {
        reason: `${describePredicate(predicate, liveFacts, now)}; ${crossings} since ${
          window.openedAt.toISOString()}; wake ${generation} of ${budget}`,
        snapshot: {
          ...snapshotOf(watch, observed, changes, tests),
          window: { openedAt: window.openedAt.toISOString(), closedAt: watch.now.toISOString(), crossings: window.crossings },
          budget: { wake: generation, of: budget },
        },
      },
      expirySnapshot: null,
    };
  }
  if (!holds && !predicateReachable(predicate, live.length)) return end('UNRESOLVABLE', changes);
  return schedule(Math.min(reconcileAt, stall, window?.closesAt.getTime() ?? Infinity), changes, holds, window);
}

/** The structured snapshot a Match or an expiry carries: every target as this evaluation saw it. */
function snapshotOf(
  watch: WatchRow,
  observed: ReadonlyArray<{ target: TargetRow; fact: OwnedFact | undefined }>,
  changes: readonly TargetStateChange[],
  tests: readonly WatchLeafTest[],
): Record<string, unknown> {
  const now = watch.now.getTime();
  const next = new Map(changes.map((change) => [change.id, change]));
  return {
    evaluatedAt: watch.now.toISOString(),
    targets: observed.map(({ target, fact }) => {
      const change = next.get(target.id);
      const state = change?.state ?? target.state;
      return {
        kind: target.kind,
        id: target.resourceId,
        epoch: change?.epoch ?? target.epoch,
        state,
        changed: state !== target.state,
        ...(fact && { leaves: leafVerdicts(tests, fact, now), observed: observationOf(fact, tests) }),
      };
    }),
  };
}
