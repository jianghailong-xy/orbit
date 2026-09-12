import { randomUUID } from 'crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  NormalizedRunEvent,
  RunEventType,
} from '@orbit/shared';
import { Subscription } from 'rxjs';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  describePredicate,
  leafHolds,
  parseWatchPredicate,
  predicateHolds,
  predicateLeaves,
  WATCH_PREDICATE_VERSION,
  WatchLeaf,
  WatchTargetFact,
  WatchTargetKind,
} from './watch-predicate';

/**
 * The Watch evaluator (docs/watch-contract.md §8): it decides from the database, schedules on
 * `watch.next_evaluate_at`, and treats every real-time event as a hint that can only move a
 * decision earlier.
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
 * evaluation that re-reads the rows. A hint that never arrives costs latency and nothing else,
 * because a live watch is never scheduled more than `reconcileIntervalMs` ahead — and for the
 * leaves no event covers at all (a session moved to Completed, an approval row) that sweep is the
 * mechanism, not a backstop.
 *
 * NOT HERE
 * What a Match causes — a turn, a notification — is the delivery worker's; its row joins the Match
 * inside `land`. CONTINUOUS watches get expiry and GONE bookkeeping but never a Match: when a
 * continuous watch has crossed again needs the edge, debounce and budget semantics the continuous
 * subscription work defines, and nothing creates one before then.
 */

/** How long a claim keeps a due watch from every other worker. Far longer than one evaluation. */
export const WATCH_EVALUATION_LEASE_MS = 60_000;
/** The furthest ahead a live watch is scheduled: the reconciliation period, and the most a lost hint can cost. */
export const WATCH_RECONCILE_INTERVAL_MS = 60_000;
/** How often the loop looks for due watches when no hint has started a pass. */
export const WATCH_POLL_INTERVAL_MS = 5_000;
/** Due watches taken per claim. */
export const WATCH_CLAIM_BATCH = 25;

export const WATCH_EVALUATOR_OPTIONS = Symbol('WATCH_EVALUATOR_OPTIONS');

export interface WatchEvaluatorOptions {
  leaseMs?: number;
  reconcileIntervalMs?: number;
  pollIntervalMs?: number;
  claimBatch?: number;
}

/** What one evaluation concluded. `SETTLED`: the watch was already terminal or gone, and nothing was written. */
export type WatchEvaluationOutcome = 'MATCHED' | 'EXPIRED' | 'UNRESOLVABLE' | 'REVOKED' | 'SCHEDULED' | 'SETTLED';

export interface WatchEvaluation {
  watchId: string;
  outcome: WatchEvaluationOutcome;
  /** The Match this evaluation recorded, if it recorded one. */
  matchId: string | null;
}

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
}

interface WatchDecision {
  outcome: Exclude<WatchEvaluationOutcome, 'SETTLED'>;
  state: string;
  generation: number;
  nextEvaluateAt: Date | null;
  targetStates: TargetStateChange[];
  match: { reason: string; snapshot: Record<string, unknown> } | null;
}

@Injectable()
export class WatchEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WatchEvaluator');
  private readonly leaseMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly claimBatch: number;

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
  }

  onModuleInit(): void {
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
      const claimed = await this.claimDue();
      for (const watchId of claimed) {
        try {
          await this.evaluate(watchId);
          evaluated += 1;
        } catch (error) {
          // Its lease lapses and it is due again; one watch that cannot be evaluated holds up no other.
          this.log.error(`watch ${watchId} evaluation failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (claimed.length < this.claimBatch || this.loop === 'STOPPED') return evaluated;
    }
  }

  /**
   * Take up to `claimBatch` due watches under the lease, the longest-due first, from the partial
   * `watch_due_idx`. `SKIP LOCKED` is what lets replicas claim side by side: a row another claim,
   * hint or landing holds is passed over rather than waited for. The lease never runs past
   * `expires_at` (`watch_next_evaluate_within_ttl_chk`), so a watch claimed at its expiry stays due —
   * a second claimer can only repeat a landing that finds it settled.
   */
  async claimDue(): Promise<string[]> {
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "watch" AS w
      SET "next_evaluate_at" = LEAST(now() + ${this.leaseMs}::int * interval '1 millisecond', w."expires_at")
      FROM (
        SELECT "id" FROM "watch"
        WHERE "next_evaluate_at" <= now()
        ORDER BY "next_evaluate_at", "id"
        LIMIT ${this.claimBatch}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE w."id" = due."id"
      RETURNING w."id"`;
    return claimed.map((row) => row.id);
  }

  /** A hint, applied: start a pass when it made anything due. A hint that fails is a hint that was lost, which the sweep absorbs. */
  async hint(kind: WatchTargetKind, resourceIds: readonly string[]): Promise<number> {
    try {
      const pulled = await this.markDue(kind, resourceIds);
      if (pulled > 0) this.kick();
      return pulled;
    } catch (error) {
      this.log.warn(`watch hint failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
  }

  /**
   * Make every ACTIVE watch with a target of this kind and one of these ids due now; returns how many
   * moved. A watch already due is not written again, a terminal one has no schedule to move, and the
   * rows are locked in id order so two hints naming overlapping watches take them in one order.
   */
  async markDue(kind: WatchTargetKind, resourceIds: readonly string[]): Promise<number> {
    if (resourceIds.length === 0) return 0;
    const pulled = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "watch" AS w
      SET "next_evaluate_at" = now()
      FROM (
        SELECT "id" FROM "watch"
        WHERE "id" IN (
            SELECT "watch_id" FROM "watch_target"
            WHERE "target_kind" = ${kind} AND "target_resource_id" = ANY(${[...resourceIds]}::uuid[]))
          AND "state" = 'ACTIVE'
          AND "next_evaluate_at" > now()
        ORDER BY "id"
        FOR UPDATE
      ) AS hinted
      WHERE w."id" = hinted."id"
      RETURNING w."id"`;
    return pulled.length;
  }

  /**
   * Decide one watch from the rows and land the decision, inside one transaction that holds the
   * watch's row lock from the first read to the last write. Safe for any watch at any time, leased
   * or not — see THE LANDING above.
   */
  async evaluate(watchId: string): Promise<WatchEvaluation> {
    return withTransactionRetry(this.prisma, async (tx): Promise<WatchEvaluation> => {
      const [watch] = await tx.$queryRaw<WatchRow[]>`
        SELECT "owner_id" AS "ownerId", "state", "mode", "action", "predicate",
               "predicate_version" AS "predicateVersion", "generation",
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
      return { watchId, outcome: decision.outcome, matchId };
    }, loggedRetry(this.log, 'watches.evaluate'));
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
        SET "state" = v."state", "last_evaluated_at" = now()
        FROM unnest(${decision.targetStates.map((change) => change.id)}::uuid[],
                    ${decision.targetStates.map((change) => change.state)}::text[]) AS v("id", "state")
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
    const landed = await tx.$executeRaw`
      UPDATE "watch"
      SET "state" = ${decision.state},
          "generation" = ${decision.generation},
          "next_evaluate_at" = ${decision.nextEvaluateAt},
          "last_evaluated_at" = now(),
          "updated_at" = CASE WHEN "state" = ${decision.state} THEN "updated_at" ELSE now() END
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

/** The leaves' source columns (contract `leaves[].sourceColumns`) for every target not yet GONE, plus the owner the permission recheck compares. */
async function readFacts(tx: Prisma.TransactionClient, targets: readonly TargetRow[]): Promise<Map<string, OwnedFact>> {
  const ids = (kind: WatchTargetKind) =>
    targets.filter((target) => target.kind === kind && target.state !== 'GONE').map((target) => target.resourceId);
  const facts = new Map<string, OwnedFact>();
  const taskIds = ids('TASK');
  if (taskIds.length > 0) {
    const tasks = await tx.$queryRaw<Array<{ id: string; ownerId: string; status: string }>>`
      SELECT "id", "owner_id" AS "ownerId", "status"::text AS "status"
      FROM "task"
      WHERE "id" = ANY(${taskIds}::uuid[])`;
    for (const task of tasks) facts.set(`TASK:${task.id}`, { kind: 'TASK', ownerId: task.ownerId, status: task.status });
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
  const settle = (outcome: 'EXPIRED' | 'UNRESOLVABLE' | 'REVOKED', targetStates: TargetStateChange[] = []): WatchDecision => ({
    outcome, state: outcome, generation: watch.generation, nextEvaluateAt: null, targetStates, match: null,
  });
  const schedule = (at: Date, targetStates: TargetStateChange[] = []): WatchDecision => ({
    outcome: 'SCHEDULED', state: watch.state, generation: watch.generation, nextEvaluateAt: at, targetStates, match: null,
  });

  // Pausing stops evaluation, not the clock (contract §3): a paused watch is looked at again at its expiry and not before.
  if (watch.state === 'PAUSED') return expired ? settle('EXPIRED') : schedule(watch.expiresAt);

  const observed = targets.map((target) => ({
    target,
    fact: target.state === 'GONE' ? undefined : facts.get(`${target.kind}:${target.resourceId}`),
  }));
  // Contract §7: permission is rechecked where it is used. A target that is no longer the owner's
  // ends the watch as REVOKED before anything about that target is written down.
  if (observed.some(({ fact }) => fact && fact.ownerId !== watch.ownerId)) return settle('REVOKED');

  // Contract §4: a deleted target is recorded GONE and leaves the set; it never counts as satisfied.
  const gone = observed
    .filter(({ target, fact }) => !fact && target.state !== 'GONE')
    .map(({ target }) => ({ id: target.id, state: 'GONE' }));
  const live = observed.flatMap(({ target, fact }) => (fact ? [{ target, fact }] : []));
  if (live.length === 0) return settle('UNRESOLVABLE', gone);

  const reconcileAt = new Date(Math.min(now + reconcileIntervalMs, watch.expiresAt.getTime()));
  const predicate = watch.predicateVersion === WATCH_PREDICATE_VERSION ? parseWatchPredicate(watch.predicate) : null;
  // Not a term this build can decide. Guessing would be worse than waiting: it keeps its schedule,
  // and its TTL still ends it visibly.
  if (!predicate) return expired ? settle('EXPIRED', gone) : schedule(reconcileAt, gone);

  const leaves = predicateLeaves(predicate);
  const liveFacts = live.map(({ fact }) => fact);
  const changes = [
    ...gone,
    ...live.flatMap(({ target, fact }) => {
      // One-shot targets stay SATISFIED once they were (contract §3 lets only CONTINUOUS go back).
      // The predicate never reads this column — it reads the rows.
      const satisfied = leaves.some((leaf) => leafHolds(leaf, fact))
        || (watch.mode === 'ONE_SHOT' && target.state === 'SATISFIED');
      const state = satisfied ? 'SATISFIED' : 'OBSERVED';
      return state === target.state ? [] : [{ id: target.id, state }];
    }),
  ];

  // Evaluated before the expiry check: a condition that holds when the watch is looked at is a
  // Match even if the look came late, so a hint that was lost changes when, never whether.
  if (watch.mode === 'ONE_SHOT' && predicateHolds(predicate, liveFacts)) {
    return {
      outcome: 'MATCHED',
      state: 'MATCHED',
      generation: watch.generation + 1,
      nextEvaluateAt: null,
      targetStates: changes,
      match: {
        reason: describePredicate(predicate, liveFacts),
        snapshot: snapshotOf(watch, observed, changes, leaves),
      },
    };
  }
  return expired ? settle('EXPIRED', changes) : schedule(reconcileAt, changes);
}

/** The structured trigger snapshot a Match carries: every target as this evaluation saw it. */
function snapshotOf(
  watch: WatchRow,
  observed: ReadonlyArray<{ target: TargetRow; fact: OwnedFact | undefined }>,
  changes: readonly TargetStateChange[],
  leaves: readonly WatchLeaf[],
): Record<string, unknown> {
  const next = new Map(changes.map((change) => [change.id, change.state]));
  return {
    evaluatedAt: watch.now.toISOString(),
    targets: observed.map(({ target, fact }) => {
      const state = next.get(target.id) ?? target.state;
      return {
        kind: target.kind,
        id: target.resourceId,
        epoch: target.epoch,
        state,
        changed: state !== target.state,
        ...(fact && {
          leaves: Object.fromEntries(leaves.map((leaf) => [leaf, leafHolds(leaf, fact)])),
          observed: fact.kind === 'TASK'
            ? { status: fact.status }
            : {
                status: fact.status,
                endReason: fact.endReason,
                runState: deriveSessionRunState(fact),
                lifecycleState: deriveSessionLifecycleState(fact),
                pendingApproval: fact.pendingApproval,
              },
        }),
      };
    }),
  };
}
