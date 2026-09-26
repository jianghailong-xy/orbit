import { setTimeout as delay } from 'node:timers/promises';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import {
  SessionRunState,
  WATCH_ATTENTION_EXPIRED_ACTIONS,
  WATCH_ATTENTION_STATES,
  WATCH_DELIVERY_STATES,
  WATCH_LIMITS,
  WATCH_QUIET_DEAD_LETTER_CODES,
  WATCH_STATES,
  WATCH_UNRETRYABLE_DEAD_LETTER_CODES,
  deriveSessionRunState,
  transientDbConflictBody,
  watchDeadLetterCodeOf,
  type WatchAction,
  type WatchMode,
  type WatchPredicate,
  type WatchSnapshot,
  type WatchState,
  type WatchTargetKind,
  type WatchTargetStatusView,
} from '@orbit/shared';
import { loggedRetry, transactionRetryDelayMs, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateWatchDto, UpdateWatchDto } from './dto';
import { countWatchCreate, countWatchDuplicateSuppressed, countWatchRedrive, countWatchRolloutRefusal } from './watch-metrics';
import {
  describePredicate,
  leafHolds,
  leafVerdicts,
  observationOf,
  predicateHolds,
  predicateLeafTests,
  type WatchTargetFact,
} from './watch-predicate';
import {
  assertLeavesFitTargets,
  assertPredicateVersion,
  assertQuorumFitsTargets,
  continuousPolicy,
  parseRequestedPredicate,
  watchRefusal,
} from './watch-request';
import {
  currentWatchRollout,
  watchesAcceptWaits,
  watchesDisabledError,
  type WatchRollout,
  type WatchRolloutGatedWrite,
} from './watch-rollout';

/** A delivery as a client reads it: a retry in progress and a dead letter are read here. */
const DELIVERY_VIEW_SELECT = {
  id: true,
  action: true,
  state: true,
  attempts: true,
  nextAttemptAt: true,
  lastError: true,
  deliveredAt: true,
  deadLetteredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WatchDeliverySelect;

/** What a client reads back. Never the owner id: the caller is the owner. */
const WATCH_VIEW_SELECT = {
  id: true,
  observerType: true,
  observerSessionId: true,
  predicateVersion: true,
  predicate: true,
  mode: true,
  action: true,
  state: true,
  generation: true,
  debounceSeconds: true,
  wakeBudget: true,
  holding: true,
  windowOpenedAt: true,
  windowClosesAt: true,
  windowCrossings: true,
  expiresAt: true,
  nextEvaluateAt: true,
  lastEvaluatedAt: true,
  idempotencyKey: true,
  createdAt: true,
  updatedAt: true,
  targets: {
    select: { targetKind: true, targetResourceId: true, state: true, targetEpoch: true, lastEvaluatedAt: true },
    orderBy: [{ targetKind: 'asc' }, { targetResourceId: 'asc' }],
  },
  matches: {
    select: {
      id: true,
      generation: true,
      matchedAt: true,
      reason: true,
      predicateVersion: true,
      perTargetSnapshot: true,
      // What the Match caused and whether it worked.
      deliveries: { select: DELIVERY_VIEW_SELECT, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { generation: 'asc' },
  },
  // What the watch's end caused (contract §3, §5): at most one, for a RESUME_SESSION watch that expired,
  // was revoked or became unresolvable, with `kind` saying which and, for an expiry, the snapshot its
  // turn carries.
  expiryDeliveries: {
    select: { ...DELIVERY_VIEW_SELECT, kind: true, expirySnapshot: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.WatchSelect;

type WatchRow = Prisma.WatchGetPayload<{ select: typeof WATCH_VIEW_SELECT }>;

/** A watch as a client reads it: every target carries its own name and standing, read with the watch (`named`). */
type NamedWatchRow = Omit<WatchRow, 'targets'> & {
  targets: (WatchRow['targets'][number] & {
    targetTitle: string | null;
    targetStatus: WatchTargetStatusView | null;
  })[];
};

/** A delivery as the operations read lists it: what a watch's read shows, and the watch and Match it belongs to. */
const DELIVERY_OPS_SELECT = {
  ...DELIVERY_VIEW_SELECT,
  kind: true,
  watchId: true,
  match: { select: { watchId: true, generation: true } },
} satisfies Prisma.WatchDeliverySelect;

type DeliveryOpsRow = Prisma.WatchDeliveryGetPayload<{ select: typeof DELIVERY_OPS_SELECT }>;

/** How far the wake-loop check follows a chain of watches. A longer cycle is left to the observer's storm limit. */
const WAKE_LOOP_SEARCH_DEPTH = 32;

/**
 * How long a create waits for its account's turn at the capacity checks, and runs again a transaction that lapsed
 * without writing, before it answers the retryable 503. Under the 20s an agent's `watch_create` gives its request, so
 * a create that cannot be decided in time is told so instead of timing out unanswered.
 */
const CREATE_WAIT_MS = 10_000;

/** The pause before asking again whether an account's turn is free: doubling from 10ms to at most 200ms, jittered. */
const TURN_ASK_PACING = { baseDelayMs: 10, maxDelayMs: 200 };

export const WATCHES_OPTIONS = Symbol('WATCHES_OPTIONS');

/** The live-watch quotas, defaulting to the contract's limits, and how long a create waits for its account's turn. */
export interface WatchesOptions {
  maxLiveWatchesPerOwner?: number;
  maxLiveWatchesPerTarget?: number;
  maxCreateWaitMs?: number;
  /** How far Watch is switched on (docs/watch-rollout.md); ORBIT_WATCHES as the environment sets it when omitted. */
  rollout?: WatchRollout;
}

const TRANSITION_SELECT = {
  state: true,
  mode: true,
  expiresAt: true,
  targets: { select: { targetKind: true } },
} satisfies Prisma.WatchSelect;

type TransitionRow = Prisma.WatchGetPayload<{ select: typeof TRANSITION_SELECT }>;

/** The states a watch can still be paused, resumed, edited or cancelled from. */
const LIVE_STATES: readonly string[] = ['ACTIVE', 'PAUSED'] satisfies WatchState[];

/** How often a transition re-reads and decides again when its compare-and-set found the row moved. */
const TRANSITION_ATTEMPTS = 3;

const LIST_LIMIT = 100;

/**
 * Narrows a read to the watches one session observes. The runner door passes the calling session, so
 * an agent reads and edits its own waits and never the rest of the owner's.
 */
export interface WatchScope {
  observerSessionId?: string;
}

/** A watch that has no coalescing window open. What a CONTINUOUS watch coalesced is not carried past a new condition or an end. */
const NO_WINDOW = { windowOpenedAt: null, windowClosesAt: null, windowCrossings: 0 } satisfies Prisma.WatchUpdateManyMutationInput;

interface CreateRequest {
  predicateVersion: number;
  predicate: WatchPredicate;
  /** Deduplicated and sorted, so two spellings of one set are one request. */
  targets: { kind: WatchTargetKind; id: string }[];
  action: WatchAction;
  mode: WatchMode;
  /** A CONTINUOUS watch's debounce window and wake budget; null on a ONE_SHOT watch. */
  policy: { debounceSeconds: number; wakeBudget: number } | null;
  observerSessionId: string | null;
  ttlSeconds: number;
  idempotencyKey: string | null;
}

interface ObservedTarget {
  kind: WatchTargetKind;
  id: string;
  fact: WatchTargetFact;
}

@Injectable()
export class WatchesService {
  private readonly logger = new Logger(WatchesService.name);
  private readonly maxLiveWatchesPerOwner: number;
  private readonly maxLiveWatchesPerTarget: number;
  private readonly maxCreateWaitMs: number;
  private readonly rollout: WatchRollout;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WATCHES_OPTIONS) options: WatchesOptions = {},
    // Only the writes that change what a watch reads as announce through it (`watch.changed`, an
    // accelerant only — docs/watch-contract.md §8.1). Defaulted so the specs that construct this
    // service by hand do not each have to stub a hub they never read; `RealtimeModule` is global,
    // so Nest injects the real one by type, not by position.
    private readonly realtime: RealtimeService = undefined as unknown as RealtimeService,
  ) {
    this.maxLiveWatchesPerOwner = options.maxLiveWatchesPerOwner ?? WATCH_LIMITS.maxLiveWatchesPerOwner;
    this.maxLiveWatchesPerTarget = options.maxLiveWatchesPerTarget ?? WATCH_LIMITS.maxLiveWatchesPerTarget;
    this.maxCreateWaitMs = options.maxCreateWaitMs ?? CREATE_WAIT_MS;
    this.rollout = options.rollout ?? currentWatchRollout();
  }

  /**
   * Refuse a write that would add a wait or a wake while Watch is not on for the account (docs/watch-rollout.md). What
   * reads a watch or stops one is never asked: it is how an owner winds down what was made while Watch was on.
   */
  private assertWatchesOn(ownerId: string, write: WatchRolloutGatedWrite): void {
    if (watchesAcceptWaits(this.rollout, ownerId)) return;
    countWatchRolloutRefusal(write);
    throw watchesDisabledError(this.rollout, write);
  }

  /**
   * Create a watch, and decide a one-shot watch before answering.
   *
   * Permission, the frozen target set and the first evaluation are one read inside one
   * transaction, so there is no moment at which a watch exists that has not looked at its targets:
   * a condition that already holds is matched here, once, with its delivery, rather than waited
   * for. A condition that does not hold yet leaves the watch ACTIVE and due at once — a change
   * committed after that read reached no watch, because this row was not visible yet, and being due
   * is what makes the next evaluation, not a hint about the change, the thing that sees it.
   *
   * A RESUME_SESSION watch may not close a wake loop, and a watch that stays live must keep the account and
   * each of its targets within their live-watch quotas (`assertCapacity`). Both are decided in the same
   * transaction, after the first evaluation: a watch matched at create occupies no live slot.
   *
   * A CONTINUOUS watch is never matched here. It matches at crossings, coalesced by the evaluator, so it
   * starts ACTIVE, due at once and not yet holding: a condition already true is the first crossing its
   * first evaluation sees.
   *
   * The account's creates take turns at `assertCapacity`, and none waits for its turn inside its transaction, where the
   * wait would spend the transaction's five seconds and hold a pooled connection: a create that finds the turn taken
   * rolls back and asks again once the turn is free (`untilOwnerTurn`), and so does one whose transaction lapsed without
   * writing. A create still waiting after `maxCreateWaitMs` answers the retryable 503, having written nothing.
   */
  async create(ownerId: string, dto: CreateWatchDto): Promise<NamedWatchRow> {
    const request = this.createRequest(dto);
    // Before any gate: a create whose response was lost reads back what it made even if a target
    // has since become unreadable. What already happened is looked up, not judged again.
    if (request.idempotencyKey !== null) {
      const committed = await this.replay(ownerId, request);
      if (committed) return replayed(committed);
    }
    // After the replay, like every other gate: a retry of a create made while Watch was on gets back what it made.
    this.assertWatchesOn(ownerId, 'create');
    let watchId: string;
    try {
      watchId = await this.untilOwnerTurn(ownerId, () => withTransactionRetry(
        this.prisma,
        async (tx) => {
          const observed = await this.readTargets(tx, ownerId, request);
          const now = new Date();
          const facts = observed.map((target) => target.fact);
          const holds = request.mode === 'ONE_SHOT' && predicateHolds(request.predicate, facts, now.getTime());
          const snapshot = snapshotAtCreate(request.predicate, observed, now);
          const watch = await tx.watch.create({
            data: {
              ownerId,
              observerType: request.observerSessionId === null ? 'USER' : 'SESSION',
              observerSessionId: request.observerSessionId,
              predicate: request.predicate as unknown as Prisma.InputJsonValue,
              predicateVersion: request.predicateVersion,
              mode: request.mode,
              debounceSeconds: request.policy?.debounceSeconds ?? null,
              wakeBudget: request.policy?.wakeBudget ?? null,
              action: request.action,
              state: holds ? 'MATCHED' : 'ACTIVE',
              generation: holds ? 1 : 0,
              holding: holds,
              expiresAt: new Date(now.getTime() + request.ttlSeconds * 1000),
              nextEvaluateAt: holds ? null : now,
              lastEvaluatedAt: now,
              idempotencyKey: request.idempotencyKey,
              createdAt: now,
            },
            select: { id: true },
          });
          // After the watch row, not before it: creates that collide on one idempotency key meet at its insert, where
          // the key decides between them, and only then take their turn at the account's capacity.
          await this.assertCapacity(tx, ownerId, request, holds, watch.id);
          await tx.watchTarget.createMany({
            data: snapshot.targets.map((target) => ({
              watchId: watch.id,
              targetKind: target.kind,
              targetResourceId: target.id,
              state: target.state,
              targetEpoch: target.epoch,
              lastEvaluatedAt: now,
              createdAt: now,
            })),
          });
          if (holds) {
            const match = await tx.watchMatch.create({
              data: {
                watchId: watch.id,
                generation: 1,
                matchedAt: now,
                reason: describePredicate(request.predicate, facts, now.getTime()),
                predicateVersion: request.predicateVersion,
                perTargetSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              },
              select: { id: true },
            });
            // The match is the fact; this row is the effect, left PENDING for the delivery worker.
            await tx.watchDelivery.create({ data: { matchId: match.id, action: request.action, nextAttemptAt: now } });
          }
          return watch.id;
        },
        loggedRetry(this.logger, 'watches.create'),
      ));
    } catch (error) {
      // Two creates with one key both found nothing above, and `watch_owner_idempotency_key` let one
      // of them insert. The other gets the answer a later retry would get.
      if (request.idempotencyKey !== null && isUniqueViolation(error)) {
        const committed = await this.replay(ownerId, request);
        if (committed) return replayed(committed);
      }
      throw error;
    }
    const watch = await this.get(ownerId, watchId);
    countWatchCreate(watch.state === 'MATCHED' ? 'matched_at_create' : 'created');
    // After the commit, and not on the replay above: a retry of a create that already happened
    // announces nothing, because nothing changed for it to announce.
    this.realtime?.publishWatchChanged(ownerId, watch.id);
    return watch;
  }

  async get(ownerId: string, id: string, scope: WatchScope = {}): Promise<NamedWatchRow> {
    const watch = await this.prisma.watch.findFirst({
      where: { id, ownerId, ...scopeWhere(scope) },
      select: WATCH_VIEW_SELECT,
    });
    if (!watch) throw new NotFoundException('watch not found');
    return (await this.named(ownerId, [watch]))[0];
  }

  async list(ownerId: string, state?: string, scope: WatchScope = {}): Promise<NamedWatchRow[]> {
    assertListState(state);
    const watches = await this.prisma.watch.findMany({
      where: { ownerId, ...(state !== undefined ? { state } : {}), ...scopeWhere(scope) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: WATCH_VIEW_SELECT,
    });
    return this.named(ownerId, watches);
  }

  /**
   * Every target's own name, in two reads for the whole answer, so a card can say what it watches
   * without a request per target: a Following page draws up to LIST_LIMIT watches, each naming up to
   * `maxTargetsPerWatch`, and names fetched one row at a time arrive late for some of them and not at
   * all for the rest — which is how a card ended up showing a truncated id where a title belongs.
   *
   * Scoped to the owner like every other read here. A target this account can no longer read has no
   * title, and that is all it means: whether the row is gone is the target's own `state` (GONE), which
   * the evaluator writes, and which is the only thing a client may say "Deleted" from.
   *
   * Where each target stands rides along from the same rows (`targetStatus`), so the strip above a
   * session's composer can say what it waits on is doing without a read per target: a task in the task
   * list's words — its status with the `running`/`queued` overlays, derived as `TasksService.withRunning`
   * derives them — and a session by its run state. Not read at all, it is null with the title.
   */
  private async named(ownerId: string, watches: WatchRow[]): Promise<NamedWatchRow[]> {
    const idsOf = (kind: WatchTargetKind): string[] => [
      ...new Set(
        watches.flatMap((w) => w.targets.filter((t) => t.targetKind === kind).map((t) => t.targetResourceId)),
      ),
    ];
    const sessionIds = idsOf('SESSION');
    const taskIds = idsOf('TASK');
    const [sessions, tasks, busy] = await Promise.all([
      sessionIds.length === 0
        ? []
        : this.prisma.session.findMany({
            where: { id: { in: sessionIds }, ownerId },
            select: { id: true, title: true, status: true, endReason: true },
          }),
      taskIds.length === 0
        ? []
        : this.prisma.task.findMany({
            where: { id: { in: taskIds }, ownerId },
            select: { id: true, title: true, status: true },
          }),
      taskIds.length === 0
        ? []
        : this.prisma.session.groupBy({
            by: ['taskId', 'status'],
            where: { ownerId, taskId: { in: taskIds }, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
            _count: { _all: true },
          }),
    ]);
    const running = new Set(busy.filter((b) => b.status === RunStatus.RUNNING).map((b) => b.taskId));
    const queued = new Set(busy.filter((b) => b.status === RunStatus.PENDING).map((b) => b.taskId));
    const read = new Map<string, { title: string | null; status: WatchTargetStatusView }>();
    for (const row of sessions) {
      const state = deriveSessionRunState({ status: row.status, endReason: row.endReason });
      read.set(`SESSION:${row.id}`, {
        title: row.title,
        status: {
          status: state,
          running: state === SessionRunState.RUNNING,
          queued: state === SessionRunState.QUEUED,
        },
      });
    }
    for (const row of tasks) {
      // A task with both is simply running: `queued` only means something while nothing runs yet.
      const on = running.has(row.id);
      read.set(`TASK:${row.id}`, {
        title: row.title,
        status: { status: row.status, running: on, queued: queued.has(row.id) && !on },
      });
    }
    return watches.map((watch) => ({
      ...watch,
      targets: watch.targets.map((target) => {
        const row = read.get(`${target.targetKind}:${target.targetResourceId}`);
        return { ...target, targetTitle: row?.title ?? null, targetStatus: row?.status ?? null };
      }),
    }));
  }

  /**
   * The owner's watches that need attention (contract `attention`), newest first and at most LIST_LIMIT, in whatever
   * state each is in and narrowed to one state when `state` is given: one that stopped REVOKED or UNRESOLVABLE, a
   * NOTIFY_USER watch that expired with no session waiting to be told, and any watch with a delivery that
   * dead-lettered under a code somebody has to look at or that is being retried after a failed attempt.
   *
   * None of those clears itself, so this is the read that does not depend on the watch still being among the newest
   * LIST_LIMIT `list` answers with — an account that ends watches all day would otherwise push a failure off the
   * list before anybody saw it. The rule is the contract's as shared transcribes it, and the picking is SQL so a
   * dead letter nobody has to act on never takes a place in the answer: its code is the heading of `last_error`,
   * read here as `watchDeadLetterCodeOf` reads it (and as the gauges in watch-metrics.ts already read it).
   */
  async listNeedingAttention(ownerId: string, state?: string): Promise<NamedWatchRow[]> {
    assertListState(state);
    const needsLooking = Prisma.sql`(
          (d."state" = 'DEAD_LETTER'
            AND COALESCE(substring(d."last_error" FROM '^([A-Z][A-Z0-9_]*):'), '') <> ALL(${textArray(WATCH_QUIET_DEAD_LETTER_CODES)}))
          OR (d."state" IN ('PENDING', 'IN_FLIGHT') AND d."attempts" > 0))`;
    const picked = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT w."id"
        FROM "watch" w
       WHERE w."owner_id" = ${ownerId}::uuid
         AND (${state ?? null}::text IS NULL OR w."state" = ${state ?? null}::text)
         AND (w."state" = ANY(${textArray(WATCH_ATTENTION_STATES)})
           OR (w."state" = 'EXPIRED' AND w."action" = ANY(${textArray(WATCH_ATTENTION_EXPIRED_ACTIONS)}))
           OR EXISTS (SELECT 1 FROM "watch_match" m JOIN "watch_delivery" d ON d."match_id" = m."id"
                       WHERE m."watch_id" = w."id" AND ${needsLooking})
           OR EXISTS (SELECT 1 FROM "watch_delivery" d WHERE d."watch_id" = w."id" AND ${needsLooking}))
       ORDER BY w."created_at" DESC, w."id" DESC
       LIMIT ${LIST_LIMIT}::int`);
    // Read back through the view every other list answers with, so one watch reads the same wherever it is shown.
    const watches = await this.prisma.watch.findMany({
      where: { ownerId, id: { in: picked.map((row) => row.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: WATCH_VIEW_SELECT,
    });
    return this.named(ownerId, watches);
  }

  /** Edit the condition or the deadline of a live watch. Its targets, its action and its mode stay as created. */
  async update(ownerId: string, id: string, dto: UpdateWatchDto): Promise<NamedWatchRow> {
    this.assertWatchesOn(ownerId, 'update');
    if (dto.predicate === undefined && dto.ttlSeconds === undefined) {
      throw new BadRequestException('nothing to update: send a predicate with its predicateVersion, or ttlSeconds');
    }
    let edit: { version: number; predicate: WatchPredicate } | undefined;
    if (dto.predicate !== undefined) {
      const version = assertPredicateVersion(dto.predicateVersion);
      edit = { version, predicate: parseRequestedPredicate(dto.predicate, version) };
    }
    const { ttlSeconds } = dto;
    if (ttlSeconds !== undefined) assertTtl(ttlSeconds);
    return this.transition(ownerId, id, (watch, now) => {
      if (!LIVE_STATES.includes(watch.state)) throw notLive(watch.state, 'edited');
      if (edit) {
        assertLeavesFitTargets(edit.predicate, watch.targets.map((target) => target.targetKind as WatchTargetKind));
        assertQuorumFitsTargets(edit.predicate, watch.targets.length);
      }
      const expiresAt = ttlSeconds === undefined ? watch.expiresAt : new Date(now.getTime() + ttlSeconds * 1000);
      return {
        // A new condition has not held yet: its first holding is its first crossing, and a window the old
        // condition opened is not one it coalesces into.
        ...(edit
          ? { predicate: edit.predicate as unknown as Prisma.InputJsonValue, predicateVersion: edit.version, holding: false, ...NO_WINDOW }
          : {}),
        expiresAt,
        // Level-triggered: an ACTIVE watch is due again under what it now says; a PAUSED one keeps
        // only its expiry scheduled.
        nextEvaluateAt: watch.state === 'ACTIVE' ? earlier(now, expiresAt) : expiresAt,
      };
    });
  }

  pause(ownerId: string, id: string): Promise<NamedWatchRow> {
    return this.transition(ownerId, id, (watch) => {
      if (watch.state === 'PAUSED') return null;
      if (watch.state !== 'ACTIVE') throw notLive(watch.state, 'paused');
      // Pausing does not extend the TTL, so the sweep still has to reach the watch when it expires.
      return { state: 'PAUSED', nextEvaluateAt: watch.expiresAt };
    });
  }

  async resume(ownerId: string, id: string): Promise<NamedWatchRow> {
    this.assertWatchesOn(ownerId, 'resume');
    return this.transition(ownerId, id, (watch, now) => {
      if (watch.state === 'ACTIVE') return null;
      if (watch.state !== 'PAUSED') throw notLive(watch.state, 'resumed');
      // Due at once: what changed while it was paused is seen by reading the rows as they are now.
      return { state: 'ACTIVE', nextEvaluateAt: earlier(now, watch.expiresAt) };
    });
  }

  cancel(ownerId: string, id: string): Promise<NamedWatchRow> {
    return this.transition(ownerId, id, (watch) => {
      if (watch.state === 'CANCELLED') return null;
      if (!LIVE_STATES.includes(watch.state)) throw notLive(watch.state, 'cancelled');
      return { state: 'CANCELLED', nextEvaluateAt: null, ...NO_WINDOW };
    });
  }

  /**
   * The account's deliveries in one state, most recently changed first: its dead letters unless another state is
   * asked for (docs/watch-operations.md §5). Each names its watch, its dead-letter code and whether a redrive is
   * allowed, so a dead letter is something to act on, not only a line on one watch's read.
   */
  async listDeliveries(ownerId: string, state = 'DEAD_LETTER'): Promise<DeliveryOpsView[]> {
    if (!(WATCH_DELIVERY_STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(`state is one of ${WATCH_DELIVERY_STATES.join(', ')}`);
    }
    const rows = await this.prisma.watchDelivery.findMany({
      where: { state, ...ownedBy(ownerId) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: DELIVERY_OPS_SELECT,
    });
    return rows.map(opsView);
  }

  /**
   * Redrive one dead letter (contract `deliveryGuards.redrive`): back to PENDING, due at once, its attempts counted
   * from zero, for the delivery worker to attempt under every guard again. A delivery that is not a dead letter is
   * refused, and so is a dead letter whose code is not retryable. The write is a compare-and-set on the state and
   * the `last_error` the decision read, so two requests racing on one dead letter redrive it once.
   */
  async retryDelivery(ownerId: string, id: string): Promise<DeliveryOpsView> {
    this.assertWatchesOn(ownerId, 'redrive');
    const row = await this.prisma.watchDelivery.findFirst({ where: { id, ...ownedBy(ownerId) }, select: DELIVERY_OPS_SELECT });
    if (!row) throw new NotFoundException('delivery not found');
    const view = opsView(row);
    if (view.state !== 'DEAD_LETTER') {
      countWatchRedrive('refused');
      throw new ConflictException({
        code: 'DELIVERY_NOT_DEAD_LETTER',
        message: `a ${view.state} delivery is not redriven: only a dead letter is`,
        state: view.state,
      });
    }
    if (!view.retryable) {
      countWatchRedrive('refused');
      throw new ConflictException({
        code: 'DELIVERY_NOT_RETRYABLE',
        message: `a ${view.deadLetterCode} dead letter is not redriven: a wake that left its observer's queue unrun is not queued again, and a revoked payload is not delivered`,
        deadLetterCode: view.deadLetterCode,
      });
    }
    const redriven = await this.prisma.$executeRaw`
      UPDATE "watch_delivery"
      SET "state" = 'PENDING', "attempts" = 0, "next_attempt_at" = now(), "dead_lettered_at" = NULL, "updated_at" = now()
      WHERE "id" = ${id}::uuid AND "state" = 'DEAD_LETTER' AND "last_error" IS NOT DISTINCT FROM ${row.lastError}::text`;
    if (redriven !== 1) {
      countWatchRedrive('refused');
      throw new ConflictException('the delivery changed while this request decided; read it again and retry');
    }
    countWatchRedrive('redriven');
    const after = await this.prisma.watchDelivery.findFirst({ where: { id, ...ownedBy(ownerId) }, select: DELIVERY_OPS_SELECT });
    if (!after) throw new NotFoundException('delivery not found');
    return opsView(after);
  }

  private createRequest(dto: CreateWatchDto): CreateRequest {
    const predicateVersion = assertPredicateVersion(dto.predicateVersion);
    const predicate = parseRequestedPredicate(dto.predicate, predicateVersion);
    const refs = [...new Map(dto.targets.map((target) => [`${target.kind}:${target.id}`, target])).values()];
    if (refs.length === 0) {
      throw watchRefusal('EMPTY_TARGET_SET', 'a watch names at least one target: ALL over an empty set would hold at once');
    }
    if (refs.length > WATCH_LIMITS.maxTargetsPerWatch) {
      throw watchRefusal('TOO_MANY_TARGETS', `a watch names at most ${WATCH_LIMITS.maxTargetsPerWatch} targets`);
    }
    const targets: CreateRequest['targets'] = [];
    for (const ref of refs) {
      if (ref.kind === 'TASK_LIST' || ref.kind === 'PROJECT') {
        throw watchRefusal(
          'DYNAMIC_SET_UNSUPPORTED',
          `a ${ref.kind} is not a watchable target: name its sessions or tasks, which are frozen at create`,
        );
      }
      targets.push({ kind: ref.kind, id: ref.id });
    }
    targets.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    assertLeavesFitTargets(predicate, targets.map((target) => target.kind));
    assertQuorumFitsTargets(predicate, targets.length);
    const mode = dto.mode ?? 'ONE_SHOT';
    const policy = continuousPolicy(mode, dto.debounceSeconds, dto.wakeBudget);
    const ttlSeconds = dto.ttlSeconds ?? WATCH_LIMITS.defaultTtlSeconds;
    assertTtl(ttlSeconds);
    const observerSessionId = dto.observerSessionId ?? null;
    if (dto.action === 'RESUME_SESSION') {
      if (observerSessionId === null) {
        throw new BadRequestException('RESUME_SESSION resumes the observer session: name it in observerSessionId');
      }
      if (targets.some((target) => target.kind === 'SESSION' && target.id === observerSessionId)) {
        throw watchRefusal('SELF_WATCH_LOOP', 'a RESUME_SESSION watch cannot name its own observer session among its targets');
      }
    }
    return {
      predicateVersion,
      predicate,
      targets,
      action: dto.action,
      mode,
      policy,
      observerSessionId,
      ttlSeconds,
      idempotencyKey: dto.idempotencyKey ?? null,
    };
  }

  /**
   * The owner's reading of every target, which is both the permission check and the snapshot: the
   * source columns each leaf names. A target that does not exist and one that belongs to another
   * account are refused alike, so the refusal says nothing about which ids exist.
   */
  private async readTargets(tx: Prisma.TransactionClient, ownerId: string, request: CreateRequest): Promise<ObservedTarget[]> {
    const ids = (kind: WatchTargetKind) => request.targets.filter((target) => target.kind === kind).map((target) => target.id);
    const tasks = await tx.task.findMany({
      where: { id: { in: ids('TASK') }, ownerId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        // The progress leaves' columns and the lifecycle epoch. Never the message: no leaf reads it.
        progress: {
          select: { lifecycleEpoch: true, epochStartedAt: true, phase: true, current: true, total: true, lastProgressAt: true },
        },
      },
    });
    const sessions = await tx.session.findMany({
      where: { id: { in: ids('SESSION') }, ownerId },
      select: { id: true, status: true, endReason: true, completedAt: true, archivedAt: true, deletedAt: true },
    });
    const unreadable = request.targets.length - tasks.length - sessions.length;
    if (unreadable > 0) {
      throw watchRefusal('PERMISSION_DENIED', `${unreadable} of ${request.targets.length} targets cannot be read by this account`);
    }
    if (request.observerSessionId !== null) {
      const observer = await tx.session.findFirst({ where: { id: request.observerSessionId, ownerId }, select: { id: true } });
      if (!observer) throw watchRefusal('PERMISSION_DENIED', 'the observer session cannot be read by this account');
    }
    const approvals = await tx.approval.findMany({
      where: { sessionId: { in: sessions.map((session) => session.id) }, status: 'PENDING' },
      select: { sessionId: true },
    });
    const awaitingAnswer = new Set(approvals.map((approval) => approval.sessionId));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    return request.targets.map((target): ObservedTarget => {
      if (target.kind === 'TASK') {
        const task = taskById.get(target.id)!;
        const progress = task.progress;
        return {
          ...target,
          fact: {
            kind: 'TASK',
            status: task.status,
            epoch: progress?.lifecycleEpoch ?? 0,
            epochStartedAt: progress?.epochStartedAt ?? task.createdAt,
            progress: {
              phase: progress?.phase ?? null,
              current: progress?.current ?? null,
              total: progress?.total ?? null,
              lastProgressAt: progress?.lastProgressAt ?? null,
            },
          },
        };
      }
      const session = sessionById.get(target.id)!;
      return {
        ...target,
        fact: {
          kind: 'SESSION',
          status: session.status,
          endReason: session.endReason,
          completedAt: session.completedAt,
          archivedAt: session.archivedAt,
          deletedAt: session.deletedAt,
          pendingApproval: awaitingAnswer.has(target.id),
        },
      };
    });
  }

  /**
   * Runs `attempt`, one create's whole transaction, until it is not turned back for its account's turn. An attempt that
   * found the turn taken, or whose transaction lapsed without writing, has rolled back and let its connection go by the
   * time it arrives here, so the wait between attempts holds nothing.
   */
  private async untilOwnerTurn<T>(ownerId: string, attempt: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.maxCreateWaitMs;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof OwnerTurnTaken) && !isLapsedTransaction(error)) throw error;
        await this.awaitOwnerTurn(ownerId, deadline);
      }
    }
  }

  /**
   * Pauses, then asks whether anybody holds the account's turn, until nobody does. The ask takes the owner's lock and lets
   * it go within its own statement, outside any transaction, so it never waits on the lock and no holder waits on it. A
   * pause that would end past `deadline` answers the retryable 503 instead: the create wrote nothing, and the same
   * request can be sent again.
   */
  private async awaitOwnerTurn(ownerId: string, deadline: number): Promise<void> {
    for (let ask = 1; ; ask += 1) {
      const pause = transactionRetryDelayMs(ask, TURN_ASK_PACING);
      if (Date.now() + pause > deadline) {
        this.logger.warn(`operation=watches.create outcome=TURN_NOT_REACHED waitMs=${this.maxCreateWaitMs}`);
        throw new ServiceUnavailableException(transientDbConflictBody());
      }
      await delay(pause);
      const [{ free }] = await this.prisma.$queryRaw<Array<{ free: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${ownerLock(ownerId)}, 0)) AS "free"`;
      if (free) return;
    }
  }

  /**
   * What a create has to pass beyond permission (contract `refusals`). A RESUME_SESSION watch may not close a wake
   * loop, even one that holds at once: re-arming a wait that already holds is how two sessions ping-pong one
   * immediate wake at a time. A watch that stays live (`holds` false) may not take the account or any of its
   * targets past its live-watch quota. Decided under a transaction-scoped advisory lock on the owner, so of two
   * creates for one account the second reads the first's watch: two sessions asking to wake each other cannot
   * both succeed, and a quota cannot be passed by racing. Every watch these reads count is the owner's, because
   * a watch names only targets its owner can read. The lock is taken once the new watch row is written and before its
   * targets are, so that row (`watchId`) is left out of the account's count, and is not yet part of a loop or of a
   * target's count.
   *
   * The lock is taken without waiting. When another create holds it, this throws `OwnerTurnTaken` before reading
   * anything, the transaction rolls back, and the create asks again once the turn is free (`untilOwnerTurn`).
   */
  private async assertCapacity(tx: Prisma.TransactionClient, ownerId: string, request: CreateRequest, holds: boolean, watchId: string): Promise<void> {
    const [{ turn }] = await tx.$queryRaw<Array<{ turn: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${ownerLock(ownerId)}, 0)) AS "turn"`;
    if (!turn) throw new OwnerTurnTaken();
    const sessionTargets = request.targets.filter((target) => target.kind === 'SESSION').map((target) => target.id);
    if (request.action === 'RESUME_SESSION' && sessionTargets.length > 0) {
      // The sessions a turn settling on the observer already wakes, and the sessions those wake in turn. A session
      // this watch waits on among them closes the loop: its turn would wake the observer, whose turn comes back to it.
      const [loop] = await tx.$queryRaw<Array<{ depth: number }>>`
        WITH RECURSIVE "woken" ("session_id", "depth") AS (
          SELECT ${request.observerSessionId}::uuid, 0
          UNION
          SELECT w."observer_session_id", r."depth" + 1
          FROM "woken" r
          JOIN "watch_target" t ON t."target_kind" = 'SESSION' AND t."target_resource_id" = r."session_id"
          JOIN "watch" w ON w."id" = t."watch_id"
          WHERE r."depth" < ${WAKE_LOOP_SEARCH_DEPTH}::int
            AND w."owner_id" = ${ownerId}::uuid AND w."action" = 'RESUME_SESSION' AND w."state" IN ('ACTIVE', 'PAUSED')
        )
        SELECT min("depth")::int AS "depth" FROM "woken"
        WHERE "session_id" = ANY(${sessionTargets}::uuid[])
        HAVING count(*) > 0`;
      if (loop) {
        throw watchRefusal(
          'WAKE_LOOP',
          `a session this watch waits on is already woken by its observer through ${loop.depth} live watch${loop.depth === 1 ? '' : 'es'}, so this watch would close a wake loop`,
        );
      }
    }
    // A watch matched at create is terminal: it occupies no live slot.
    if (holds) return;
    const [{ live }] = await tx.$queryRaw<Array<{ live: number }>>`
      SELECT count(*)::int AS "live" FROM "watch"
      WHERE "owner_id" = ${ownerId}::uuid AND "state" IN ('ACTIVE', 'PAUSED') AND "id" <> ${watchId}::uuid`;
    if (live >= this.maxLiveWatchesPerOwner) {
      throw watchRefusal(
        'WATCH_QUOTA_EXCEEDED',
        `this account already holds ${live} live watches, and it may hold ${this.maxLiveWatchesPerOwner}: cancel one it no longer needs`,
      );
    }
    const [{ full }] = await tx.$queryRaw<Array<{ full: number }>>`
      SELECT count(*)::int AS "full" FROM (
        SELECT 1 FROM "watch_target" t JOIN "watch" w ON w."id" = t."watch_id"
        WHERE w."owner_id" = ${ownerId}::uuid AND w."state" IN ('ACTIVE', 'PAUSED')
          AND (t."target_kind", t."target_resource_id") IN (
            SELECT * FROM unnest(${request.targets.map((target) => target.kind)}::text[], ${request.targets.map((target) => target.id)}::uuid[]))
        GROUP BY t."target_kind", t."target_resource_id"
        HAVING count(*) >= ${this.maxLiveWatchesPerTarget}::int
      ) AS "crowded"`;
    if (full > 0) {
      throw watchRefusal(
        'WATCH_QUOTA_EXCEEDED',
        `${full} of this watch's targets already have ${this.maxLiveWatchesPerTarget} live watches, the most one target may have`,
      );
    }
  }

  /** The watch this key already made, if the request is the one that made it; a 409 if it is not. */
  private async replay(ownerId: string, request: CreateRequest): Promise<NamedWatchRow | null> {
    const committed = await this.prisma.watch.findFirst({
      where: { ownerId, idempotencyKey: request.idempotencyKey },
      select: WATCH_VIEW_SELECT,
    });
    if (!committed) return null;
    const same =
      committed.predicateVersion === request.predicateVersion
      && canonicalJson(committed.predicate) === canonicalJson(request.predicate)
      && committed.action === request.action
      && committed.mode === request.mode
      && committed.debounceSeconds === (request.policy?.debounceSeconds ?? null)
      && committed.wakeBudget === (request.policy?.wakeBudget ?? null)
      && committed.observerSessionId === request.observerSessionId
      && committed.expiresAt.getTime() - committed.createdAt.getTime() === request.ttlSeconds * 1000
      && canonicalJson(committed.targets.map((target) => `${target.targetKind}:${target.targetResourceId}`).sort())
        === canonicalJson(request.targets.map((target) => `${target.kind}:${target.id}`).sort());
    if (!same) {
      // Says nothing about the watch it refused beyond that it differs: a retry needs no more.
      throw new ConflictException('that idempotency key already made a different watch; nothing was written — use a new key for a new request');
    }
    return (await this.named(ownerId, [committed]))[0];
  }

  /**
   * Read, decide, compare-and-set on what the decision was made from. `decide` returns null when
   * the watch is already where the request wants it, so a retried pause or cancel is not a 409.
   */
  private async transition(
    ownerId: string,
    id: string,
    decide: (watch: TransitionRow, now: Date) => Prisma.WatchUpdateManyMutationInput | null,
  ): Promise<NamedWatchRow> {
    for (let attempt = 1; attempt <= TRANSITION_ATTEMPTS; attempt += 1) {
      const watch = await this.prisma.watch.findFirst({ where: { id, ownerId }, select: TRANSITION_SELECT });
      if (!watch) throw new NotFoundException('watch not found');
      const data = decide(watch, new Date());
      if (data === null) break;
      const { count } = await this.prisma.watch.updateMany({
        where: { id, ownerId, state: watch.state, expiresAt: watch.expiresAt },
        data,
      });
      if (count === 1) {
        // After the write, so a client that re-reads on this nudge reads what landed. A decision
        // that changed nothing (`data === null`: a second cancel, a pause of a paused watch) left
        // the loop above without one: there is nothing for another client to see.
        this.realtime?.publishWatchChanged(ownerId, id);
        break;
      }
      if (attempt === TRANSITION_ATTEMPTS) {
        throw new ConflictException('the watch kept changing while this request decided; read it again and retry');
      }
    }
    return this.get(ownerId, id);
  }
}

/**
 * The structured trigger snapshot, in the shape the evaluator's Matches carry, so a Match recorded
 * at create reads like any other. A target is SATISFIED when a leaf the predicate asks holds for it;
 * every target is new, so it `changed` exactly when it left the initial OBSERVED, and its epoch is
 * the lifecycle epoch its row was read in.
 */
function snapshotAtCreate(predicate: WatchPredicate, observed: readonly ObservedTarget[], evaluatedAt: Date): WatchSnapshot {
  const tests = predicateLeafTests(predicate);
  const now = evaluatedAt.getTime();
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    targets: observed.map(({ kind, id, fact }) => {
      const state = tests.some((test) => leafHolds(test, fact, now)) ? 'SATISFIED' : 'OBSERVED';
      return {
        kind,
        id,
        epoch: fact.kind === 'TASK' ? fact.epoch : 0,
        state,
        changed: state !== 'OBSERVED',
        leaves: leafVerdicts(tests, fact, now),
        observed: observationOf(fact, tests),
      };
    }),
  };
}

function scopeWhere(scope: WatchScope): Prisma.WatchWhereInput {
  return scope.observerSessionId === undefined ? {} : { observerSessionId: scope.observerSessionId };
}

function assertTtl(ttlSeconds: number): void {
  if (ttlSeconds < WATCH_LIMITS.minTtlSeconds || ttlSeconds > WATCH_LIMITS.maxTtlSeconds) {
    throw watchRefusal(
      'TTL_OUT_OF_RANGE',
      `ttlSeconds is between ${WATCH_LIMITS.minTtlSeconds} and ${WATCH_LIMITS.maxTtlSeconds}`,
    );
  }
}

function notLive(state: string, verb: string): ConflictException {
  return new ConflictException({ message: `a ${state} watch cannot be ${verb}`, state });
}

function earlier(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Thrown inside a create's transaction when another create of the account holds its turn, so that the transaction rolls back. */
class OwnerTurnTaken extends Error {}

/**
 * Prisma's P2028 for a transaction that wrote nothing: it could not start in time, or its timeout rolled it back before
 * the statement or the commit that failed. Prisma runs a timeout's rollback and a commit through one queue, so an expired
 * transaction is one whose commit never ran, and either kind is safe to run again whole.
 */
function isLapsedTransaction(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2028'
    && /Unable to start a transaction in the given time|cannot be executed on an expired transaction/.test(error.message)
  );
}

/** The state a list read may narrow to, or the refusal that names the states there are. */
function assertListState(state: string | undefined): void {
  if (state !== undefined && !(WATCH_STATES as readonly string[]).includes(state)) {
    throw new BadRequestException(`state is one of ${WATCH_STATES.join(', ')}`);
  }
}

/**
 * `ARRAY[…]::text[]` of a list the contract states, the empty list included: `IN ()` is a syntax error, and a
 * contract list can legitimately go empty — no action whose expiry needs attention, say — without leaving invalid SQL.
 */
function textArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0 ? Prisma.sql`ARRAY[]::text[]` : Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;
}

/** The advisory lock an account's creates take turns under. */
function ownerLock(ownerId: string): string {
  return `watch-owner:${ownerId}`;
}

/** A create answered with the watch its idempotency key already made, counted as the repeat it is. */
function replayed<T>(watch: T): T {
  countWatchCreate('replayed');
  countWatchDuplicateSuppressed('create_replay');
  return watch;
}

/** The deliveries of this account's watches: a Match's through its Match, a watch end's through the watch itself. */
function ownedBy(ownerId: string): Prisma.WatchDeliveryWhereInput {
  return { OR: [{ match: { watch: { ownerId } } }, { watch: { ownerId } }] };
}

function opsView({ match, watchId, ...delivery }: DeliveryOpsRow) {
  const deadLetterCode = delivery.state === 'DEAD_LETTER' ? watchDeadLetterCodeOf(delivery.lastError, delivery.attempts) : null;
  return {
    ...delivery,
    // `watch_delivery_kind_shape_chk`: a MATCH row names its Match, and every other kind names its watch.
    watchId: (watchId ?? match?.watchId) as string,
    generation: match?.generation ?? null,
    deadLetterCode,
    retryable: deadLetterCode !== null && !WATCH_UNRETRYABLE_DEAD_LETTER_CODES.includes(deadLetterCode),
  };
}

type DeliveryOpsView = ReturnType<typeof opsView>;

/** JSON with every object's keys sorted, so a jsonb round trip compares equal to what was sent. */
function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}
