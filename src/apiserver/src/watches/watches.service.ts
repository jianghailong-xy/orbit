import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WATCH_LIMITS,
  WATCH_PREDICATE_VERSION,
  WATCH_STATES,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  type WatchAction,
  type WatchPredicate,
  type WatchSnapshot,
  type WatchState,
  type WatchTargetKind,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWatchDto, UpdateWatchDto } from './dto';
import { describePredicate, leafHolds, predicateHolds, predicateLeaves, type WatchTargetFact } from './watch-predicate';
import { assertLeavesFitTargets, assertPredicateVersion, parseRequestedPredicate, watchRefusal } from './watch-request';

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
      // What the Match caused and whether it worked: a retry in progress and a dead letter are read here.
      deliveries: {
        select: {
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
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { generation: 'asc' },
  },
} satisfies Prisma.WatchSelect;

type WatchRow = Prisma.WatchGetPayload<{ select: typeof WATCH_VIEW_SELECT }>;

const TRANSITION_SELECT = {
  state: true,
  expiresAt: true,
  targets: { select: { targetKind: true } },
} satisfies Prisma.WatchSelect;

type TransitionRow = Prisma.WatchGetPayload<{ select: typeof TRANSITION_SELECT }>;

/** The states a watch can still be paused, resumed, edited or cancelled from. */
const LIVE_STATES: readonly string[] = ['ACTIVE', 'PAUSED'] satisfies WatchState[];

/** How often a transition re-reads and decides again when its compare-and-set found the row moved. */
const TRANSITION_ATTEMPTS = 3;

const LIST_LIMIT = 100;

interface CreateRequest {
  predicate: WatchPredicate;
  /** Deduplicated and sorted, so two spellings of one set are one request. */
  targets: { kind: WatchTargetKind; id: string }[];
  action: WatchAction;
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

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a one-shot watch, and decide it before answering.
   *
   * Permission, the frozen target set and the first evaluation are one read inside one
   * transaction, so there is no moment at which a watch exists that has not looked at its targets:
   * a condition that already holds is matched here, once, with its delivery, rather than waited
   * for. A condition that does not hold yet leaves the watch ACTIVE and due at once — a change
   * committed after that read reached no watch, because this row was not visible yet, and being due
   * is what makes the next evaluation, not a hint about the change, the thing that sees it.
   */
  async create(ownerId: string, dto: CreateWatchDto): Promise<WatchRow> {
    const request = this.createRequest(dto);
    // Before any gate: a create whose response was lost reads back what it made even if a target
    // has since become unreadable. What already happened is looked up, not judged again.
    if (request.idempotencyKey !== null) {
      const committed = await this.replay(ownerId, request);
      if (committed) return committed;
    }
    let watchId: string;
    try {
      watchId = await withTransactionRetry(
        this.prisma,
        async (tx) => {
          const observed = await this.readTargets(tx, ownerId, request);
          const now = new Date();
          const facts = observed.map((target) => target.fact);
          const holds = predicateHolds(request.predicate, facts);
          const snapshot = snapshotAtCreate(request.predicate, observed, now);
          const watch = await tx.watch.create({
            data: {
              ownerId,
              observerType: request.observerSessionId === null ? 'USER' : 'SESSION',
              observerSessionId: request.observerSessionId,
              predicate: request.predicate as unknown as Prisma.InputJsonValue,
              predicateVersion: WATCH_PREDICATE_VERSION,
              mode: 'ONE_SHOT',
              action: request.action,
              state: holds ? 'MATCHED' : 'ACTIVE',
              generation: holds ? 1 : 0,
              expiresAt: new Date(now.getTime() + request.ttlSeconds * 1000),
              nextEvaluateAt: holds ? null : now,
              lastEvaluatedAt: now,
              idempotencyKey: request.idempotencyKey,
              createdAt: now,
            },
            select: { id: true },
          });
          await tx.watchTarget.createMany({
            data: snapshot.targets.map((target) => ({
              watchId: watch.id,
              targetKind: target.kind,
              targetResourceId: target.id,
              state: target.state,
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
                reason: describePredicate(request.predicate, facts),
                predicateVersion: WATCH_PREDICATE_VERSION,
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
      );
    } catch (error) {
      // Two creates with one key both found nothing above, and `watch_owner_idempotency_key` let one
      // of them insert. The other gets the answer a later retry would get.
      if (request.idempotencyKey !== null && isUniqueViolation(error)) {
        const committed = await this.replay(ownerId, request);
        if (committed) return committed;
      }
      throw error;
    }
    return this.get(ownerId, watchId);
  }

  async get(ownerId: string, id: string): Promise<WatchRow> {
    const watch = await this.prisma.watch.findFirst({ where: { id, ownerId }, select: WATCH_VIEW_SELECT });
    if (!watch) throw new NotFoundException('watch not found');
    return watch;
  }

  async list(ownerId: string, state?: string): Promise<WatchRow[]> {
    if (state !== undefined && !(WATCH_STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(`state is one of ${WATCH_STATES.join(', ')}`);
    }
    return this.prisma.watch.findMany({
      where: { ownerId, ...(state !== undefined ? { state } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: WATCH_VIEW_SELECT,
    });
  }

  /** Edit the condition or the deadline of a live watch. Its targets and its action stay as created. */
  async update(ownerId: string, id: string, dto: UpdateWatchDto): Promise<WatchRow> {
    if (dto.predicate === undefined && dto.ttlSeconds === undefined) {
      throw new BadRequestException('nothing to update: send a predicate with its predicateVersion, or ttlSeconds');
    }
    let predicate: WatchPredicate | undefined;
    if (dto.predicate !== undefined) {
      assertPredicateVersion(dto.predicateVersion);
      predicate = parseRequestedPredicate(dto.predicate);
    }
    const { ttlSeconds } = dto;
    if (ttlSeconds !== undefined) assertTtl(ttlSeconds);
    return this.transition(ownerId, id, (watch, now) => {
      if (!LIVE_STATES.includes(watch.state)) throw notLive(watch.state, 'edited');
      if (predicate) assertLeavesFitTargets(predicate, watch.targets.map((target) => target.targetKind as WatchTargetKind));
      const expiresAt = ttlSeconds === undefined ? watch.expiresAt : new Date(now.getTime() + ttlSeconds * 1000);
      return {
        ...(predicate ? { predicate: predicate as unknown as Prisma.InputJsonValue } : {}),
        expiresAt,
        // Level-triggered: an ACTIVE watch is due again under what it now says; a PAUSED one keeps
        // only its expiry scheduled.
        nextEvaluateAt: watch.state === 'ACTIVE' ? earlier(now, expiresAt) : expiresAt,
      };
    });
  }

  pause(ownerId: string, id: string): Promise<WatchRow> {
    return this.transition(ownerId, id, (watch) => {
      if (watch.state === 'PAUSED') return null;
      if (watch.state !== 'ACTIVE') throw notLive(watch.state, 'paused');
      // Pausing does not extend the TTL, so the sweep still has to reach the watch when it expires.
      return { state: 'PAUSED', nextEvaluateAt: watch.expiresAt };
    });
  }

  resume(ownerId: string, id: string): Promise<WatchRow> {
    return this.transition(ownerId, id, (watch, now) => {
      if (watch.state === 'ACTIVE') return null;
      if (watch.state !== 'PAUSED') throw notLive(watch.state, 'resumed');
      // Due at once: what changed while it was paused is seen by reading the rows as they are now.
      return { state: 'ACTIVE', nextEvaluateAt: earlier(now, watch.expiresAt) };
    });
  }

  cancel(ownerId: string, id: string): Promise<WatchRow> {
    return this.transition(ownerId, id, (watch) => {
      if (watch.state === 'CANCELLED') return null;
      if (!LIVE_STATES.includes(watch.state)) throw notLive(watch.state, 'cancelled');
      return { state: 'CANCELLED', nextEvaluateAt: null };
    });
  }

  private createRequest(dto: CreateWatchDto): CreateRequest {
    assertPredicateVersion(dto.predicateVersion);
    const predicate = parseRequestedPredicate(dto.predicate);
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
          `a ${ref.kind} is not a watchable target in v1: name its sessions or tasks, which are frozen at create`,
        );
      }
      targets.push({ kind: ref.kind, id: ref.id });
    }
    targets.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    assertLeavesFitTargets(predicate, targets.map((target) => target.kind));
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
    return { predicate, targets, action: dto.action, observerSessionId, ttlSeconds, idempotencyKey: dto.idempotencyKey ?? null };
  }

  /**
   * The owner's reading of every target, which is both the permission check and the snapshot: the
   * source columns each leaf names. A target that does not exist and one that belongs to another
   * account are refused alike, so the refusal says nothing about which ids exist.
   */
  private async readTargets(tx: Prisma.TransactionClient, ownerId: string, request: CreateRequest): Promise<ObservedTarget[]> {
    const ids = (kind: WatchTargetKind) => request.targets.filter((target) => target.kind === kind).map((target) => target.id);
    const tasks = await tx.task.findMany({ where: { id: { in: ids('TASK') }, ownerId }, select: { id: true, status: true } });
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
        return { ...target, fact: { kind: 'TASK', status: taskById.get(target.id)!.status } };
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

  /** The watch this key already made, if the request is the one that made it; a 409 if it is not. */
  private async replay(ownerId: string, request: CreateRequest): Promise<WatchRow | null> {
    const committed = await this.prisma.watch.findFirst({
      where: { ownerId, idempotencyKey: request.idempotencyKey },
      select: WATCH_VIEW_SELECT,
    });
    if (!committed) return null;
    const same =
      committed.predicateVersion === WATCH_PREDICATE_VERSION
      && canonicalJson(committed.predicate) === canonicalJson(request.predicate)
      && committed.action === request.action
      && committed.mode === 'ONE_SHOT'
      && committed.observerSessionId === request.observerSessionId
      && committed.expiresAt.getTime() - committed.createdAt.getTime() === request.ttlSeconds * 1000
      && canonicalJson(committed.targets.map((target) => `${target.targetKind}:${target.targetResourceId}`).sort())
        === canonicalJson(request.targets.map((target) => `${target.kind}:${target.id}`).sort());
    if (!same) {
      // Says nothing about the watch it refused beyond that it differs: a retry needs no more.
      throw new ConflictException('that idempotency key already made a different watch; nothing was written — use a new key for a new request');
    }
    return committed;
  }

  /**
   * Read, decide, compare-and-set on what the decision was made from. `decide` returns null when
   * the watch is already where the request wants it, so a retried pause or cancel is not a 409.
   */
  private async transition(
    ownerId: string,
    id: string,
    decide: (watch: TransitionRow, now: Date) => Prisma.WatchUpdateManyMutationInput | null,
  ): Promise<WatchRow> {
    for (let attempt = 1; attempt <= TRANSITION_ATTEMPTS; attempt += 1) {
      const watch = await this.prisma.watch.findFirst({ where: { id, ownerId }, select: TRANSITION_SELECT });
      if (!watch) throw new NotFoundException('watch not found');
      const data = decide(watch, new Date());
      if (data === null) break;
      const { count } = await this.prisma.watch.updateMany({
        where: { id, ownerId, state: watch.state, expiresAt: watch.expiresAt },
        data,
      });
      if (count === 1) break;
      if (attempt === TRANSITION_ATTEMPTS) {
        throw new ConflictException('the watch kept changing while this request decided; read it again and retry');
      }
    }
    return this.get(ownerId, id);
  }
}

/**
 * The structured trigger snapshot, in the shape the evaluator's Matches carry, so a Match recorded
 * at create reads like any other. A target is SATISFIED when a leaf the predicate names holds for
 * it; every target is new, so it `changed` exactly when it left the initial OBSERVED, and its epoch
 * is the one its row starts with.
 */
function snapshotAtCreate(predicate: WatchPredicate, observed: readonly ObservedTarget[], evaluatedAt: Date): WatchSnapshot {
  const leaves = predicateLeaves(predicate);
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    targets: observed.map(({ kind, id, fact }) => {
      const state = leaves.some((leaf) => leafHolds(leaf, fact)) ? 'SATISFIED' : 'OBSERVED';
      return {
        kind,
        id,
        epoch: 0,
        state,
        changed: state !== 'OBSERVED',
        leaves: Object.fromEntries(leaves.map((leaf) => [leaf, leafHolds(leaf, fact)])),
        observed:
          fact.kind === 'TASK'
            ? { status: fact.status }
            : {
                status: fact.status,
                endReason: fact.endReason,
                runState: deriveSessionRunState(fact),
                lifecycleState: deriveSessionLifecycleState(fact),
                pendingApproval: fact.pendingApproval,
              },
      };
    }),
  };
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
