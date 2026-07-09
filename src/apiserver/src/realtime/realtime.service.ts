import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import {
  ArtifactCommand,
  CommitCommand,
  ControlEvent,
  ControlEventType,
  ControlSessionSummary,
  isLifecycleType,
  MergeCommand,
  NormalizedRunEvent,
  RunEventType,
  RunStatus,
  SessionEndReason,
} from '@orbit/shared';
import { Observable, Subject, filter, map, mergeMap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import {
  approvalIdOf,
  backgroundPayloadOf,
  controlTypeFor,
  errorPayloadOf,
} from './control-events';

const EVENT_CHANNEL = 'orbit_event';
const INBOX_CHANNEL = 'orbit_inbox';
const MAX_NOTIFY_BYTES = 7000; // Postgres NOTIFY payload limit is 8000 bytes; stay under.
const CANCEL_MAX_AGE_MS = 60 * 60_000; // stop redelivering a cancel after an hour

/**
 * Realtime fan-out. Within a process it uses an in-memory RxJS hub (events) and an
 * EventEmitter (inbox wakeups) — zero latency. Across replicas it bridges those over
 * Postgres LISTEN/NOTIFY: every publish/notifyInbox also NOTIFYs (tagged with this
 * instance id), and a dedicated listener connection re-emits notifications from OTHER
 * instances into the local hub/inbox. The own-instance tag means single-replica
 * behaviour is unchanged (a process ignores its own notifications; clients also dedup
 * by seq as a backstop).
 *
 * Cancellation is durable on TaskRun.cancelRequestedAt and drained from the DB on
 * heartbeat, so it also works across replicas and survives a restart.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private readonly instanceId = randomUUID();
  private readonly hub = new Subject<{ runId: string; event: NormalizedRunEvent }>();
  private readonly inbox = new EventEmitter(); // event name = runId
  private listener?: Client;
  private connecting = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** sessionId → {ownerId, agentId}, for scoping the user-stream (GET /api/events) without a
   *  DB hit per event. Bounded LRU; the control subset is low-volume so it's near-100% hits. */
  private readonly ownerCache = new Map<string, { ownerId: string; agentId: string | null }>();
  private static readonly OWNER_CACHE_MAX = 10_000;
  // Events that can lower an owner's "needs you" badge (an increment is already covered by the
  // approval-create alert push). On any of these, nudge PushService to reconcile and silently sync
  // the badge to the owner's other devices, incl. backgrounded iOS. See docs/cross-platform-badge-sync.md.
  private static readonly BADGE_EVENTS = new Set<string>([
    RunEventType.APPROVAL_RESOLVED,
    RunEventType.STATUS,
    RunEventType.SESSION_ENDED,
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {
    this.inbox.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    await this.startListener();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listener?.removeAllListeners('error');
    this.listener?.end().catch(() => undefined);
  }

  // ── cross-replica listener ──────────────────────────────────────────────

  private async startListener(): Promise<void> {
    if (this.stopped || this.connecting || this.listener) return; // never run two listeners
    this.connecting = true;
    // pg can't parse Prisma's `?schema=` query param; strip it (LISTEN/NOTIFY
    // channels are database-global, not schema-scoped).
    const url = (process.env.DATABASE_URL ?? '').split('?')[0];
    const client = new Client({ connectionString: url });
    client.on('error', (e) => {
      this.log.error('listener connection error: ' + e.message);
      this.reconnect();
    });
    client.on('notification', (msg) => this.onNotify(msg.channel, msg.payload));
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      await client.query(`LISTEN ${INBOX_CHANNEL}`);
      this.listener = client;
      this.log.log(`LISTEN/NOTIFY active (instance ${this.instanceId.slice(0, 8)})`);
    } catch (e) {
      this.log.error('listener connect failed: ' + (e as Error).message);
      client.removeAllListeners('error');
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private reconnect(): void {
    if (this.stopped) return;
    const old = this.listener;
    this.listener = undefined;
    if (old) {
      old.removeAllListeners('error'); // don't let the dead client re-trigger us
      old.end().catch(() => undefined);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.startListener();
    }, 2000);
  }

  private onNotify(channel: string, payload?: string): void {
    if (!payload) return;
    let m: { i: string; r: string; e?: NormalizedRunEvent; s?: number };
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (m.i === this.instanceId) return; // our own write — already emitted locally
    if (channel === INBOX_CHANNEL) {
      this.inbox.emit(m.r);
      return;
    }
    if (channel === EVENT_CHANNEL) {
      if (m.e) {
        this.hub.next({ runId: m.r, event: m.e });
      } else if (typeof m.s === 'number') {
        // Oversized event was sent as a signal — fetch it from the durable log.
        this.prisma.runEvent
          .findUnique({ where: { sessionId_seq: { sessionId: m.r, seq: m.s } } })
          .then((row) => {
            if (row) {
              this.hub.next({
                runId: m.r,
                event: {
                  seq: row.seq,
                  type: row.type as RunEventType,
                  payload: row.payload as Record<string, unknown>,
                  turnId: row.turnId ?? undefined,
                  ts: row.createdAt.toISOString(),
                },
              });
            }
          })
          .catch(() => undefined);
      }
    }
  }

  private notifyRaw(channel: string, payload: string): void {
    // executeRaw (not queryRaw): pg_notify returns void, which Prisma's queryRaw
    // can't deserialize ("Failed to deserialize column of type 'void'"). executeRaw
    // runs the statement — firing the NOTIFY — and returns an affected-row count
    // instead of reading result columns.
    this.prisma
      .$executeRawUnsafe('SELECT pg_notify($1, $2)', channel, payload)
      .catch((e) => this.log.warn('pg_notify failed: ' + (e as Error).message));
  }

  // ── inbox (interactive turn delivery) ───────────────────────────────────

  /** Wake a runner parked in GET /runner/runs/:id/inbox after a turn is enqueued. */
  notifyInbox(runId: string): void {
    this.inbox.emit(runId); // same replica
    this.notifyRaw(INBOX_CHANNEL, JSON.stringify({ i: this.instanceId, r: runId })); // others
  }

  /** Park until a turn is enqueued for this run, or the timeout elapses. */
  waitForInbox(runId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.inbox.off(runId, done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.inbox.once(runId, done);
    });
  }

  // ── run events (SSE) ────────────────────────────────────────────────────

  publish(runId: string, event: NormalizedRunEvent): void {
    this.hub.next({ runId, event }); // same replica
    const payload = JSON.stringify({ i: this.instanceId, r: runId, e: event });
    // NOTE: NOTIFY's limit is 8000 BYTES — measure UTF-8 bytes, not string length
    // (a multibyte CJK/emoji event can be < 7000 chars but > 8000 bytes).
    if (Buffer.byteLength(payload, 'utf8') <= MAX_NOTIFY_BYTES) {
      this.notifyRaw(EVENT_CHANNEL, payload);
    } else {
      // Too big for a NOTIFY payload — signal by seq; other replicas fetch the
      // (already-persisted) RunEvent row.
      this.notifyRaw(EVENT_CHANNEL, JSON.stringify({ i: this.instanceId, r: runId, s: event.seq }));
    }
    // Locally-originated only — NOTIFY-bridged events from other replicas arrive via onNotify →
    // hub, not here — so the owner's badge is reconciled and synced exactly once, on the origin.
    if (RealtimeService.BADGE_EVENTS.has(event.type)) {
      void this.resolveOwner(runId)
        .then((meta) => meta && this.push.scheduleBadgeSync(meta.ownerId))
        .catch(() => undefined);
    }
  }

  streamForRun(runId: string): Observable<NormalizedRunEvent> {
    return this.hub.asObservable().pipe(
      // Lifecycle signals (session_created/ended) are control-plane-internal: they ride the hub
      // for the NOTIFY bridge but must never leak into a per-session transcript stream.
      filter((m) => m.runId === runId && !isLifecycleType(m.event.type)),
      map((m) => m.event),
    );
  }

  // ── synthesized lifecycle signals (control plane only) ──────────────────
  //
  // session.created / session.ended have no natural RunEvent — archive/restore/create don't emit
  // STATUS — so the state-changing call sites publish these synthetic signals through the same
  // hub (seq 0, never persisted; ingest owns durable seq assignment). streamForRun filters them
  // out above; streamForUser maps them to ControlEventType.SESSION_CREATED / SESSION_ENDED.

  /** A session entered the owner's active list (created, or restored from archive/trash). */
  publishSessionCreated(sessionId: string): void {
    this.publish(sessionId, {
      seq: 0,
      type: RunEventType.SESSION_CREATED,
      ts: new Date().toISOString(),
      payload: {},
    });
  }

  /** A session left the owner's active list (archived → completed, or soft-deleted). Terminal
   *  RUN statuses are NOT signalled here — they already flow as STATUS → session.updated; and
   *  PARKED stays in the active list, so recycling isn't an "ended" either (see the design doc). */
  publishSessionEnded(sessionId: string, status: RunStatus | string, endReason: SessionEndReason): void {
    this.publish(sessionId, {
      seq: 0,
      type: RunEventType.SESSION_ENDED,
      ts: new Date().toISOString(),
      payload: { status, endReason },
    });
  }

  // ── user-scoped control plane (SSE: GET /api/events) ────────────────────
  //
  // One per-user stream multiplexes lifecycle/status/approval/background events across ALL of
  // the user's sessions, so a client opens it once to drive its list, badges, and
  // notifications — replacing per-list polling. Derived from the same hub as streamForRun, but
  // filtered to the coarse control subset and scoped to the user's sessions. Transcript bodies
  // never enter (the sync controlTypeFor() filter drops them before owner resolution).
  // See docs/realtime-control-plane-stream.md.

  streamForUser(userId: string): Observable<ControlEvent> {
    return this.hub.asObservable().pipe(
      filter((m) => controlTypeFor(m.event.type) !== null),
      mergeMap((m) => this.toControlEvent(userId, m.runId, m.event)),
      filter((e): e is ControlEvent => e !== null),
    );
  }

  /** Map a hub run event to a control event for `userId`, or null if it isn't this user's
   *  session or carries nothing the control plane forwards. */
  private async toControlEvent(
    userId: string,
    sessionId: string,
    ev: NormalizedRunEvent,
  ): Promise<ControlEvent | null> {
    const meta = await this.resolveOwner(sessionId);
    if (!meta || meta.ownerId !== userId) return null;
    const type = controlTypeFor(ev.type);
    if (!type) return null;

    let data: Record<string, unknown>;
    switch (type) {
      case ControlEventType.SESSION_CREATED:
      case ControlEventType.SESSION_UPDATED: {
        const summary = await this.buildSessionSummary(sessionId);
        if (!summary) return null; // session vanished mid-flight
        data = summary as unknown as Record<string, unknown>;
        break;
      }
      case ControlEventType.SESSION_ENDED:
        // Decision Q4: the session left the active list — no more events will follow, so drop
        // its owner mapping now instead of waiting for LRU pressure.
        this.ownerCache.delete(sessionId);
        data = { status: ev.payload.status, endReason: ev.payload.endReason };
        break;
      case ControlEventType.SESSION_ERROR:
        data = errorPayloadOf(ev.payload) as unknown as Record<string, unknown>;
        break;
      case ControlEventType.BACKGROUND_TASK:
        data = backgroundPayloadOf(ev.payload) as unknown as Record<string, unknown>;
        break;
      case ControlEventType.APPROVAL_REQUESTED:
      case ControlEventType.APPROVAL_RESOLVED:
        data = {
          approvalId: approvalIdOf(ev.payload),
          pendingApprovals: await this.countPendingApprovals(sessionId),
        };
        break;
      default:
        return null;
    }
    return { type, sessionId, agentId: meta.agentId, ts: ev.ts ?? new Date().toISOString(), data };
  }

  /** Resolve (and cache) a session's owner + agent. Bounded LRU; a miss is one indexed lookup. */
  private async resolveOwner(
    sessionId: string,
  ): Promise<{ ownerId: string; agentId: string | null } | null> {
    const hit = this.ownerCache.get(sessionId);
    if (hit) {
      this.ownerCache.delete(sessionId); // re-insert to mark most-recently-used
      this.ownerCache.set(sessionId, hit);
      return hit;
    }
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { ownerId: true, agentId: true },
    });
    if (!row) return null;
    const meta = { ownerId: row.ownerId, agentId: row.agentId ?? null };
    this.ownerCache.set(sessionId, meta);
    if (this.ownerCache.size > RealtimeService.OWNER_CACHE_MAX) {
      const oldest = this.ownerCache.keys().next().value; // Map iterates in insertion order
      if (oldest !== undefined) this.ownerCache.delete(oldest);
    }
    return meta;
  }

  /** The slim session summary the client upserts into its list (decision Q2: full, not a delta).
   *  Shape mirrors `ControlSessionSummary` / the `GET /sessions` list row. */
  private async buildSessionSummary(sessionId: string): Promise<ControlSessionSummary | null> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        status: true,
        agentId: true,
        lastTurnAt: true,
        agent: { select: { id: true, name: true, model: true } },
      },
    });
    if (!s) return null;
    // A blocked permission keeps a session RUNNING, so only RUNNING sessions can hold a live
    // approval — skip the count otherwise (mirrors the list endpoint).
    const pendingApprovals =
      s.status === RunStatus.RUNNING ? await this.countPendingApprovals(sessionId) : 0;
    return {
      id: s.id,
      title: s.title ?? null,
      status: s.status as RunStatus,
      agentId: s.agentId ?? null,
      agent: s.agent
        ? { id: s.agent.id, name: s.agent.name ?? null, model: s.agent.model ?? null }
        : null,
      pendingApprovals,
      lastTurnAt: s.lastTurnAt ? s.lastTurnAt.toISOString() : null,
    };
  }

  private countPendingApprovals(sessionId: string): Promise<number> {
    return this.prisma.approval.count({ where: { sessionId, status: 'PENDING' } });
  }

  // ── cancellation (durable, cross-replica) ───────────────────────────────

  /**
   * No-op: cancellation intent is persisted on TaskRun.cancelRequestedAt by the
   * caller and drained from the DB on heartbeat, so it works across replicas and
   * survives a restart. Kept for call-site compatibility.
   */
  requestCancel(_runnerId: string, _runId: string): void {
    // intentionally empty
  }

  /**
   * Runs this runner should interrupt: cancel requested (within the last hour, so a
   * never-honored cancel doesn't redeliver forever), and not yet finalized — or
   * finalized very recently, to catch a runner recovering from a partition. This is
   * an at-least-once signal; the runner ignores ids it no longer has running.
   */
  async drainCancellations(runnerId: string): Promise<string[]> {
    const now = Date.now();
    const recentlyRequested = new Date(now - CANCEL_MAX_AGE_MS);
    const recentlyFinished = new Date(now - 5 * 60_000);
    const sessions = await this.prisma.session.findMany({
      where: {
        assignedRunnerId: runnerId,
        cancelRequestedAt: { gt: recentlyRequested },
        OR: [{ finishedAt: null }, { finishedAt: { gt: recentlyFinished } }],
      },
      select: { id: true },
    });
    return sessions.map((s) => s.id);
  }

  /**
   * Branch merges this runner should perform: sessions it ran (assignedRunnerId) that the
   * user asked to merge into main (mergeStatus='pending'). At-least-once — redelivered each
   * heartbeat until the runner reports an outcome that flips mergeStatus off 'pending'. The
   * workDir comes from the session's agent; the runner resolves the repo root from it.
   */
  async drainMergeRequests(runnerId: string): Promise<MergeCommand[]> {
    const sessions = await this.prisma.session.findMany({
      where: { assignedRunnerId: runnerId, mergeStatus: 'pending', branch: { not: null } },
      select: { id: true, branch: true, mergeTarget: true, agent: { select: { workDir: true } } },
    });
    return sessions
      .filter((s) => s.branch && s.agent?.workDir)
      .map((s) => ({
        sessionId: s.id,
        branch: s.branch!,
        workDir: s.agent!.workDir!,
        // Null mergeTarget → omit it so the runner auto-detects main/master (original behavior).
        ...(s.mergeTarget ? { targetBranch: s.mergeTarget } : {}),
      }));
  }

  /**
   * Worktree commits this runner should perform: live sessions it runs (assignedRunnerId)
   * that the user asked to commit (commitStatus='pending'). At-least-once — redelivered each
   * heartbeat until the runner reports an outcome that flips commitStatus off 'pending'. The
   * runner locates the per-session checkout from the session id; branch is for logging.
   */
  async drainCommitRequests(runnerId: string): Promise<CommitCommand[]> {
    const sessions = await this.prisma.session.findMany({
      where: { assignedRunnerId: runnerId, commitStatus: 'pending', branch: { not: null } },
      select: { id: true, branch: true },
    });
    return sessions.filter((s) => s.branch).map((s) => ({ sessionId: s.id, branch: s.branch! }));
  }

  async drainArtifactRequests(runnerId: string): Promise<ArtifactCommand[]> {
    const turns = await this.prisma.conversationTurn.findMany({
      where: {
        kind: 'artifact',
        status: 'PENDING',
        session: { assignedRunnerId: runnerId },
      },
      select: { id: true, sessionId: true, content: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    return turns
      .filter((t) => t.content)
      .map((t) => ({ requestId: t.id, sessionId: t.sessionId, path: t.content! }));
  }
}
