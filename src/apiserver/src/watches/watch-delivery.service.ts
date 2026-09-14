import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  deriveSessionLifecycleState,
  deriveSessionRunState,
  MAX_PROMPT_CHARS,
  SessionLifecycleState,
  SessionRunState,
  WATCH_LIMITS,
  type WatchSnapshot,
} from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';

/**
 * The Watch delivery worker (docs/watch-contract.md §3, §6): it turns a recorded Match into its one
 * effect — a notification, or a turn on the observer session — and records whether that worked.
 *
 * THE ROW
 * A Match is written together with its `watch_delivery` row, in the transaction that records the
 * Match — by the create path or by the evaluator's landing — so there is never a fact with nowhere to
 * say whether anybody was told. `(match_id, action)` is unique, so that row is the only one there is.
 * A RESUME_SESSION watch that ends unmatched gets a row of its own, whose `kind` says how it ended:
 * EXPIRY (migration 0261), REVOKED or UNRESOLVABLE (0263). The landing that ends the watch writes it,
 * and there is at most one per watch: a session waiting on a watch is told when the watch ends, not
 * only when it matches (contract §3, §5). A cancelled watch gets none, because its owner or its observer
 * ended it. The statements below claim, retry and dead-letter every kind of row alike.
 *
 * THE LEASE
 * A claim moves due PENDING rows to IN_FLIGHT under a fresh `lease_generation`, in one statement that
 * skips rows another claim holds. Every write that settles the row afterwards — acknowledged, retried,
 * dead-lettered — is a compare-and-set on that generation, so a worker whose lease ran out and was
 * taken over settles nothing: the takeover's generation is not its own. A worker that dies holding a
 * row leaves it to the lease-expiry sweep, which counts the lost attempt like a failed one.
 *
 * ONE TURN PER GENERATION
 * RESUME_SESSION goes through `SessionsService.createTurn`, the normal queue entry point, with
 * `clientTurnId = watch:<watchId>:<generation>` and `intent: NEXT_TURN`; a watch's end goes the same
 * way under `watch:<watchId>:expired`, `:revoked` or `:unresolvable`, keys no generation number can
 * collide with. The acknowledgement is written INSIDE that call's transaction — after the observer's row
 * is locked, before the turn is inserted — so the turn and DELIVERED commit together or not at all, and
 * a stale lease rolls its turn back. A retry after an acknowledgement that never happened meets the turn
 * already queued under the same key, which `createTurn` replays instead of writing a second; the content
 * is built only from rows that never change (the Match; the expired watch and its delivery's snapshot;
 * the revoked or unresolvable watch's id and its delivery's kind), so the replay compares equal.
 *
 * The key is not the worker's alone: every door into `createTurn` takes the caller's own `clientTurnId`,
 * so a turn somebody else queued can already hold a wake's key. `createTurn` replays only a turn with the
 * wake's exact payload and refuses any other as a conflict, and a turn with another payload is not the
 * wake: the observer was not woken, and the wake cannot be queued under a key that is taken. So a conflict
 * is a refusal no retry can change — `WAKE_KEY_TAKEN` — unless the observer's life is over, which is
 * refused as it would have been had the key been free. Acknowledging it instead would record DELIVERED
 * for a wake nobody queued.
 *
 * The session's state needs no special case to be safe: a RUNNING observer keeps running and the
 * turn queues behind the current one, AWAITING_INPUT and INTERRUPTED go PENDING and wait for a runner
 * slot like any sent message, and the queue never runs two turns of one session at once. What
 * `createTurn` would accept but a wake must not is an observer whose life is over — moved to
 * Completed, or its run ended — and that is checked under the same lock. Nothing is revived: the
 * delivery becomes a dead letter that says which it was.
 *
 * AT MOST ONE NOTIFICATION PER GENERATION
 * NOTIFY_USER acknowledges first and pushes after the commit. A push is the one effect here that no
 * transaction can join, so it is ordered to happen at most once: a worker that dies between the two
 * leaves a DELIVERED row and no banner, never two banners. Like every push, it is best-effort.
 *
 * RETRY AND DEAD LETTER
 * A failure increments `attempts` and schedules the next try on an exponential backoff; the failure
 * that brings `attempts` to the contract's `maxDeliveryAttempts` makes the row a DEAD_LETTER, and so
 * does a refusal no retry can change. Both keep `last_error`, and the watch's own read lists every
 * delivery with its state, so a dead letter is something a client reads, not a line a log once said.
 */

/** How long a claim keeps a delivery from every other worker. Far longer than one attempt. */
export const WATCH_DELIVERY_LEASE_MS = 60_000;
/** How often the loop looks for due deliveries when nothing has started a pass. */
export const WATCH_DELIVERY_POLL_INTERVAL_MS = 5_000;
/** Due deliveries taken per claim. */
export const WATCH_DELIVERY_CLAIM_BATCH = 25;
/** The wait after the first failed attempt; each later failure doubles it, up to the maximum. */
export const WATCH_DELIVERY_RETRY_BASE_MS = 5_000;
export const WATCH_DELIVERY_RETRY_MAX_MS = 300_000;

export const WATCH_DELIVERY_OPTIONS = Symbol('WATCH_DELIVERY_OPTIONS');

export interface WatchDeliveryOptions {
  leaseMs?: number;
  pollIntervalMs?: number;
  claimBatch?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** A delivery this worker holds, and the lease generation every write that settles it must match. */
export interface ClaimedWatchDelivery {
  id: string;
  leaseGeneration: string;
}

/**
 * What one attempt came to. `LEASE_LOST`: the row was no longer this claim's, so this attempt wrote
 * nothing — whoever holds it now settles it.
 */
export type WatchDeliveryOutcome = 'DELIVERED' | 'RETRY' | 'DEAD_LETTER' | 'LEASE_LOST';

export interface WatchDeliveryResult {
  deliveryId: string;
  outcome: WatchDeliveryOutcome;
}

/** The turn key a generation's wake is written under (contract §6). One generation, one key, one turn. */
export function watchTurnClientId(watchId: string, generation: number): string {
  return `watch:${watchId}:${generation}`;
}

/** The turn key a watch's expiry is written under (contract §5). A watch expires at most once, and no generation number spells `expired`. */
export function watchExpiryTurnClientId(watchId: string): string {
  return `watch:${watchId}:expired`;
}

/**
 * What a revoked or unresolvable watch's turn says about how it ended, and that is all it says: a REVOKED
 * watch reports nothing about what it watched (contract §7), and an UNRESOLVABLE watch has nothing left to
 * report.
 */
const WATCH_END_MEANING = {
  REVOKED: 'its permission recheck failed, so it stopped and reports nothing about what it watched',
  UNRESOLVABLE: 'every target it watched is gone, so its condition can never be decided',
} as const;

/** A watch end whose turn carries nothing but the state's name (migration 0263). */
export type BareWatchEnd = keyof typeof WATCH_END_MEANING;

/** The turn key a revoked or unresolvable watch's end is written under (contract §3). A watch ends once, and no generation number spells either word. */
export function watchEndTurnClientId(watchId: string, end: BareWatchEnd): string {
  return `watch:${watchId}:${end.toLowerCase()}`;
}

const OBSERVER_SELECT = {
  status: true,
  endReason: true,
  completedAt: true,
  archivedAt: true,
  deletedAt: true,
  cancelRequestedAt: true,
} satisfies Prisma.SessionSelect;

type ObserverRow = Prisma.SessionGetPayload<{ select: typeof OBSERVER_SELECT }>;

interface DeliveredWatch {
  id: string;
  ownerId: string;
  observerSessionId: string | null;
}

interface DeliveredMatch {
  generation: number;
  matchedAt: Date;
  reason: string;
  perTargetSnapshot: Prisma.JsonValue;
  watch: DeliveredWatch;
}

/** A refusal no retry can change: the delivery is a dead letter at once, with the code first in `last_error`. */
class DeliveryRefused extends Error {
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

/** The claim's lease generation is no longer the row's. */
class DeliveryLeaseLost extends Error {}

@Injectable()
export class WatchDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WatchDelivery');
  /** This replica's name on the rows it leases. */
  private readonly workerId = randomUUID();
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly claimBatch: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private loop: 'IDLE' | 'RUNNING' | 'STOPPED' = 'IDLE';
  private timer?: ReturnType<typeof setTimeout>;
  /** The pass in flight. A replica never runs two. */
  private pass?: Promise<void>;
  /** Something asked for a pass while one was running: go round again instead of waiting for the timer. */
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly push: PushService,
    @Optional() @Inject(WATCH_DELIVERY_OPTIONS) options: WatchDeliveryOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? WATCH_DELIVERY_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? WATCH_DELIVERY_POLL_INTERVAL_MS;
    this.claimBatch = options.claimBatch ?? WATCH_DELIVERY_CLAIM_BATCH;
    this.retryBaseMs = options.retryBaseMs ?? WATCH_DELIVERY_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? WATCH_DELIVERY_RETRY_MAX_MS;
  }

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Run the loop. The first pass starts at once: it is what finds everything that came due while no replica was running. */
  start(): void {
    if (this.loop === 'RUNNING') return;
    this.loop = 'RUNNING';
    this.kick();
  }

  /** Stop the loop. The pass in flight settles the deliveries it already claimed and claims no more. */
  async stop(): Promise<void> {
    this.loop = 'STOPPED';
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
        this.log.error(`watch delivery pass failed: ${messageOf(error)}`);
        this.again = false; // a database that is failing is retried by the timer
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
   * Return expired leases, then claim what is due and attempt it, until a claim comes back short.
   * Every delivery a claim returned is attempted even when the loop is stopping — abandoning one
   * would hold it for the rest of its lease — and a stopping loop only claims no more.
   */
  async drain(): Promise<WatchDeliveryResult[]> {
    const results: WatchDeliveryResult[] = [];
    await this.reclaimExpired();
    for (;;) {
      const claimed = await this.claimDue();
      for (const claim of claimed) {
        try {
          results.push({ deliveryId: claim.id, outcome: await this.deliver(claim) });
        } catch (error) {
          // Not even the failure could be recorded. The lease lapses and the sweep counts the attempt.
          this.log.error(`watch delivery ${claim.id} could not be settled: ${messageOf(error)}`);
        }
      }
      if (claimed.length < this.claimBatch || this.loop === 'STOPPED') return results;
    }
  }

  /**
   * Lease up to `claimBatch` due PENDING deliveries, the longest-due first, from the partial
   * `watch_delivery_due_idx`. `SKIP LOCKED` lets replicas claim side by side without waiting on each
   * other; each row gets its own lease generation.
   */
  async claimDue(): Promise<ClaimedWatchDelivery[]> {
    return this.prisma.$queryRaw<ClaimedWatchDelivery[]>`
      UPDATE "watch_delivery" AS d
      SET "state" = 'IN_FLIGHT',
          "lease_owner" = ${this.workerId}::uuid,
          "lease_generation" = gen_random_uuid(),
          "lease_deadline_at" = now() + ${this.leaseMs}::int * interval '1 millisecond',
          "updated_at" = now()
      FROM (
        SELECT "id" FROM "watch_delivery"
        WHERE "state" = 'PENDING' AND "next_attempt_at" <= now()
        ORDER BY "next_attempt_at", "id"
        LIMIT ${this.claimBatch}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE d."id" = due."id"
      RETURNING d."id", d."lease_generation" AS "leaseGeneration"`;
  }

  /**
   * Take back deliveries whose lease ran out — their worker died or stalled before settling them —
   * from the partial `watch_delivery_lease_expiry_idx` (0260). The lost attempt counts: the row goes
   * back to PENDING on the ordinary backoff, or becomes a dead letter if it was the last one.
   */
  async reclaimExpired(): Promise<number> {
    const reclaimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "watch_delivery" AS d
      SET ${afterFailedAttempt(false, this.retryBaseMs, this.retryMaxMs)},
          "last_error" = 'LEASE_EXPIRED: the worker holding this delivery stopped before settling it'
      FROM (
        SELECT "id" FROM "watch_delivery"
        WHERE "state" = 'IN_FLIGHT' AND "lease_deadline_at" <= now()
        ORDER BY "lease_deadline_at", "id"
        LIMIT ${this.claimBatch}
        FOR UPDATE SKIP LOCKED
      ) AS expired
      WHERE d."id" = expired."id"
      RETURNING d."id"`;
    return reclaimed.length;
  }

  /** Attempt one claimed delivery and settle it under the claim's lease. */
  async deliver(claim: ClaimedWatchDelivery): Promise<WatchDeliveryOutcome> {
    const delivery = await this.prisma.watchDelivery.findFirst({
      where: { id: claim.id, state: 'IN_FLIGHT', leaseGeneration: claim.leaseGeneration },
      select: {
        action: true,
        kind: true,
        match: {
          select: {
            generation: true,
            matchedAt: true,
            reason: true,
            perTargetSnapshot: true,
            watch: { select: { id: true, ownerId: true, observerSessionId: true } },
          },
        },
        watch: { select: { id: true, ownerId: true, observerSessionId: true, expiresAt: true } },
        expirySnapshot: true,
      },
    });
    if (!delivery) return 'LEASE_LOST';
    const { match, watch } = delivery;
    try {
      if (!match && delivery.kind === 'EXPIRY') {
        // An expiry. `watch_delivery_kind_shape_chk` guarantees such a row names its watch, carries its
        // snapshot, and is RESUME_SESSION.
        await this.resumeObserver(
          claim, watch!, watchExpiryTurnClientId(watch!.id), watchExpiryTurnContent(watch!, delivery.expirySnapshot),
        );
      } else if (!match) {
        // A REVOKED or UNRESOLVABLE end. The same CHECK guarantees such a row names its watch, is
        // RESUME_SESSION and carries no snapshot, so nothing about the targets can reach its turn.
        const end = delivery.kind as BareWatchEnd;
        await this.resumeObserver(claim, watch!, watchEndTurnClientId(watch!.id, end), watchEndTurnContent(watch!.id, end));
      } else if (delivery.action === 'RESUME_SESSION') {
        await this.resumeObserver(
          claim, match.watch, watchTurnClientId(match.watch.id, match.generation), watchTurnContent(match.watch.id, match),
        );
      } else if (!(await acknowledgeDelivery(this.prisma, claim))) {
        return 'LEASE_LOST';
      }
    } catch (error) {
      if (error instanceof DeliveryLeaseLost) return 'LEASE_LOST';
      return this.fail(claim, error);
    }
    if (match && delivery.action === 'NOTIFY_USER') {
      // After the acknowledgement committed, never before: see AT MOST ONE NOTIFICATION above.
      await this.push.notifyWatchMatched({
        ownerId: match.watch.ownerId,
        watchId: match.watch.id,
        generation: match.generation,
        reason: match.reason,
      });
    }
    return 'DELIVERED';
  }

  private async resumeObserver(claim: ClaimedWatchDelivery, watch: DeliveredWatch, clientTurnId: string, content: string): Promise<void> {
    const sessionId = watch.observerSessionId;
    if (!sessionId) throw new DeliveryRefused('OBSERVER_SESSION_GONE', 'the watch names no observer session');
    try {
      await this.sessions.createTurn(
        watch.ownerId,
        sessionId,
        { clientTurnId, content, intent: 'NEXT_TURN' },
        {
          // Called under the observer's row lock, after `createTurn` refused Trash, an ending session
          // and a terminal run, and before the turn is written: what is decided here commits with the
          // turn, and a refusal or a lost lease leaves no turn behind.
          participateSendTransaction: async (tx) => {
            const refusal = observerRefusal(await readObserver(tx, sessionId));
            if (refusal) throw refusal;
            if (!(await acknowledgeDelivery(tx, claim))) throw new DeliveryLeaseLost();
          },
        },
      );
    } catch (error) {
      if (error instanceof DeliveryRefused || error instanceof DeliveryLeaseLost) throw error;
      if (error instanceof NotFoundException || error instanceof SessionNotSendable) {
        throw observerRefusal(await readObserver(this.prisma, sessionId))
          ?? new DeliveryRefused('OBSERVER_SESSION_UNAVAILABLE', messageOf(error));
      }
      if (error instanceof BadRequestException) throw new DeliveryRefused('TURN_REFUSED', messageOf(error));
      if (!(error instanceof ConflictException)) throw error;
      // The key already holds a turn with another payload, which is not this wake (ONE TURN PER GENERATION
      // above). `createTurn` looks the key up before it looks at the observer, so an observer whose life is
      // over is refused as such here.
      throw observerRefusal(await readObserver(this.prisma, sessionId))
        ?? new DeliveryRefused('WAKE_KEY_TAKEN', `another turn on the observer session already holds ${clientTurnId}, so the wake was not queued`);
    }
    // The turn is on the session: written just now together with the acknowledgement, or replayed — the key
    // already holds this wake's exact payload, from an attempt whose acknowledgement never landed or a
    // redelivery after it did — in which case this is the acknowledgement.
    if (!(await acknowledgeDelivery(this.prisma, claim))) {
      const settled = await this.prisma.watchDelivery.findUnique({ where: { id: claim.id }, select: { state: true } });
      if (settled?.state !== 'DELIVERED') throw new DeliveryLeaseLost();
    }
  }

  /** Record a failed attempt under the claim's lease: the next try on the backoff, or a dead letter. */
  private async fail(claim: ClaimedWatchDelivery, error: unknown): Promise<WatchDeliveryOutcome> {
    const refused = error instanceof DeliveryRefused;
    const rows = await this.prisma.$queryRaw<Array<{ state: string; attempts: number }>>`
      UPDATE "watch_delivery"
      SET ${afterFailedAttempt(refused, this.retryBaseMs, this.retryMaxMs)},
          "last_error" = ${messageOf(error)}
      WHERE "id" = ${claim.id}::uuid AND "state" = 'IN_FLIGHT' AND "lease_generation" = ${claim.leaseGeneration}::uuid
      RETURNING "state", "attempts"`;
    const [settled] = rows;
    if (!settled) return 'LEASE_LOST';
    if (settled.state === 'DEAD_LETTER') {
      this.log.error(`watch delivery ${claim.id} is a dead letter after ${settled.attempts} attempt(s): ${messageOf(error)}`);
      return 'DEAD_LETTER';
    }
    this.log.warn(`watch delivery ${claim.id} attempt ${settled.attempts} failed, will retry: ${messageOf(error)}`);
    return 'RETRY';
  }
}

/**
 * DELIVERED, if the claim still holds the row: one compare-and-set on the lease generation the claim
 * wrote. Inside `createTurn`'s transaction for a wake, so the turn and the acknowledgement are one
 * commit; on its own for a notification, and for a turn an earlier attempt already queued.
 */
async function acknowledgeDelivery(db: Prisma.TransactionClient | PrismaService, claim: ClaimedWatchDelivery): Promise<boolean> {
  const acknowledged = await db.$executeRaw`
    UPDATE "watch_delivery"
    SET "state" = 'DELIVERED', "delivered_at" = now(),
        "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL, "updated_at" = now()
    WHERE "id" = ${claim.id}::uuid AND "state" = 'IN_FLIGHT' AND "lease_generation" = ${claim.leaseGeneration}::uuid`;
  return acknowledged === 1;
}

/**
 * The columns a failed attempt writes: one more attempt, then the next try on the backoff — or, at the
 * contract's cap or on a refusal, a dead letter. Every `"attempts"` on the right is the value before
 * the statement, so the k-th failure waits `base * 2^(k-1)`, capped.
 */
function afterFailedAttempt(refused: boolean, retryBaseMs: number, retryMaxMs: number): Prisma.Sql {
  const final = Prisma.sql`(${refused}::boolean OR "attempts" + 1 >= ${WATCH_LIMITS.maxDeliveryAttempts}::int)`;
  return Prisma.sql`
    "attempts" = "attempts" + 1,
    "state" = CASE WHEN ${final} THEN 'DEAD_LETTER' ELSE 'PENDING' END,
    "dead_lettered_at" = CASE WHEN ${final} THEN now() END,
    "next_attempt_at" = CASE WHEN ${final} THEN "next_attempt_at"
      ELSE now() + LEAST(${retryBaseMs}::double precision * power(2, "attempts"), ${retryMaxMs}::double precision)
                   * interval '1 millisecond' END,
    "lease_owner" = NULL,
    "lease_generation" = NULL,
    "lease_deadline_at" = NULL,
    "updated_at" = now()`;
}

async function readObserver(db: Prisma.TransactionClient | PrismaService, sessionId: string): Promise<ObserverRow | null> {
  return db.session.findUnique({ where: { id: sessionId }, select: OBSERVER_SELECT });
}

/**
 * Why this observer is not woken, or null when it may be. A wake never revives: a session in Trash, one
 * moved to Completed, and one whose run is over or ending all stay as they are.
 */
function observerRefusal(session: ObserverRow | null): DeliveryRefused | null {
  if (!session) return new DeliveryRefused('OBSERVER_SESSION_GONE', 'the observer session no longer exists');
  const lifecycle = deriveSessionLifecycleState(session);
  if (lifecycle === SessionLifecycleState.TRASH) {
    return new DeliveryRefused('OBSERVER_SESSION_IN_TRASH', 'the observer session is in Trash, and a watch does not restore it');
  }
  if (lifecycle === SessionLifecycleState.COMPLETED) {
    return new DeliveryRefused('OBSERVER_SESSION_COMPLETED', 'the observer session was moved to Completed, and a watch does not reopen it');
  }
  const run = deriveSessionRunState(session);
  if (session.cancelRequestedAt || run === SessionRunState.SUCCEEDED || run === SessionRunState.FAILED || run === SessionRunState.ENDED) {
    return new DeliveryRefused('OBSERVER_SESSION_ENDED', `the observer session's run is over (${run}), and a watch does not revive it`);
  }
  return null;
}

/**
 * The message a RESUME_SESSION wake carries (contract §6): one line saying what woke the session, then
 * the structured payload — `watchId`, `generation`, `reason`, `changedTargets`, `latestSnapshot` — as
 * JSON. Everything in it is read off the Match row, which never changes, so every attempt at one
 * delivery writes the same bytes. A snapshot too large for one turn is replaced by its size and where
 * to read it; the changed targets are still named.
 */
function watchTurnContent(watchId: string, match: DeliveredMatch): string {
  const snapshot = match.perTargetSnapshot as unknown as WatchSnapshot;
  const header = [
    `Orbit Watch ${watchId} matched at generation ${match.generation}: ${match.reason}`,
    '',
    'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  ].join('\n');
  const render = (payload: Record<string, unknown>) => `${header}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const base = {
    watchId,
    generation: match.generation,
    matchedAt: match.matchedAt.toISOString(),
    reason: match.reason,
  };
  const changed = snapshot.targets.filter((target) => target.changed);
  const whole = render({
    ...base,
    changedTargets: changed.map(({ kind, id, state, observed }) => ({ kind, id, state, ...(observed ? { observed } : {}) })),
    latestSnapshot: snapshot,
  });
  if (whole.length <= MAX_PROMPT_CHARS) return whole;
  return render({
    ...base,
    changedTargets: changed.map(({ kind, id, state }) => ({ kind, id, state })),
    latestSnapshot: {
      evaluatedAt: snapshot.evaluatedAt,
      targets: snapshot.targets.length,
      omitted: `too large for one turn; GET /api/watches/${watchId} returns it whole`,
    },
  });
}

/**
 * The message an expiry wake carries (contract §5): one line saying the watch EXPIRED before its
 * condition ever held, then the structured payload — `watchId`, `state`, `expiresAt` and the
 * `latestSnapshot` the expiring evaluation took — as JSON. An expired watch and its delivery's snapshot
 * never change, so every attempt writes the same bytes. As with a Match, a snapshot too large for one
 * turn is replaced by its size and where to read it.
 */
function watchExpiryTurnContent(watch: { id: string; expiresAt: Date }, expirySnapshot: Prisma.JsonValue): string {
  const snapshot = expirySnapshot as unknown as WatchSnapshot;
  const expiresAt = watch.expiresAt.toISOString();
  const header = [
    `Orbit Watch ${watch.id} EXPIRED at ${expiresAt} without its condition ever holding.`,
    '',
    'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again. What its last evaluation saw:',
  ].join('\n');
  const render = (payload: Record<string, unknown>) => `${header}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const base = { watchId: watch.id, state: 'EXPIRED', expiresAt };
  const whole = render({ ...base, latestSnapshot: snapshot });
  if (whole.length <= MAX_PROMPT_CHARS) return whole;
  return render({
    ...base,
    latestSnapshot: {
      evaluatedAt: snapshot.evaluatedAt,
      targets: snapshot.targets.length,
      omitted: `too large for one turn; GET /api/watches/${watch.id} returns it whole`,
    },
  });
}

/**
 * The message a revoked or unresolvable watch's wake carries (contract §3, §7): one line naming the state
 * the watch ended in and what that means, then the structured payload — `watchId` and `state` — as JSON,
 * and nothing else. No target and no snapshot: a REVOKED watch reports nothing it can no longer read, and
 * an UNRESOLVABLE watch's targets are all gone. Neither input ever changes, so every attempt writes the
 * same bytes.
 */
function watchEndTurnContent(watchId: string, end: BareWatchEnd): string {
  const header = [
    `Orbit Watch ${watchId} ended ${end}: ${WATCH_END_MEANING[end]}.`,
    '',
    'This turn was queued by the watch, not typed by a person. The watch has ended and will not wake this session again.',
  ].join('\n');
  return `${header}\n\n\`\`\`json\n${JSON.stringify({ watchId, state: end }, null, 2)}\n\`\`\``;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
}
