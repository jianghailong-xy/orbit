import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { NormalizedRunEvent, RunEventType } from '@orbit/shared';
import { Observable, Subject, filter, map } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {
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
          .findUnique({ where: { runId_seq: { runId: m.r, seq: m.s } } })
          .then((row) => {
            if (row) {
              this.hub.next({
                runId: m.r,
                event: {
                  seq: row.seq,
                  type: row.type as RunEventType,
                  payload: row.payload as Record<string, unknown>,
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
  }

  streamForRun(runId: string): Observable<NormalizedRunEvent> {
    return this.hub.asObservable().pipe(
      filter((m) => m.runId === runId),
      map((m) => m.event),
    );
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
    const runs = await this.prisma.taskRun.findMany({
      where: {
        runnerId,
        cancelRequestedAt: { gt: recentlyRequested },
        OR: [{ finishedAt: null }, { finishedAt: { gt: recentlyFinished } }],
      },
      select: { id: true },
    });
    return runs.map((r) => r.id);
  }
}
