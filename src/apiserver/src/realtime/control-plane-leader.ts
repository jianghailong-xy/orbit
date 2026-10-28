import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

/**
 * Which apiserver process runs the singleton sweeps, and how the others can see that a process is there.
 *
 * Three background sweeps are written for one process: the reaper (realtime/reaper.service.ts), the task
 * scheduler's sweep (TasksService's reconcile timer) and the auto-retry sweep (sessions/auto-retry.service.ts).
 * Two of them running at once reap on evidence only one of them could see, file two foremen for one stalled
 * list, count a project's free slots twice, announce the end of one retry twice and release N times the quota
 * one sweep may. So with several apiservers one runs them and the others wait: whichever holds a PostgreSQL
 * advisory lock.
 *
 * The lock is session-level, taken on a connection of this process's own (the coordination connection), never
 * on the Prisma pool: a pool hands its connections out and takes them back, and a session lock lives exactly as
 * long as the one connection it was taken on. PostgreSQL lets it go when that connection ends — the process
 * exits, is killed, or loses the database — and a process that does not hold it asks for it every
 * LEADER_POLL_MS, so another one takes the sweeps over within that. Keepalives on both ends of the connection
 * bound how long a peer that vanished without a word (a host lost, a cut network) keeps it. Nothing is
 * configured: an apiserver that is alone takes the lock as soon as it has connected, and runs the sweeps as it
 * always has.
 *
 * The same connection holds a second lock for as long as it is connected, keyed by this process's id
 * (`APISERVER_PROCESS_LOCK_PREFIX`). Nobody asks for it; it is there to be seen. The reaper reads it to tell a
 * process that has stopped reporting in `apiserver_process` but is still connected — its pool exhausted, say —
 * from one that has gone (runners/runner-presence.ts).
 *
 * What a sweep keeps in memory does not move with the lock. The reaper keeps the most, and starts again from
 * the moment this process took the lock (`leadingSince`) as if it had just started.
 */

/** How often a process that does not hold the lock asks for it, and one that does checks its connection. */
export const LEADER_POLL_MS = 5_000;

/**
 * How long a statement on the coordination connection may take before the connection is given up. Its
 * statements take a lock that is never waited for, or answer `SELECT 1`; one that has not answered in this long
 * is on a connection that is not coming back.
 */
const COORDINATION_STATEMENT_TIMEOUT_MS = 10_000;

/** The singleton sweeps' lock: `pg_try_advisory_lock(hashtextextended(…, 0))`, as the watches' owner lock is spelled. */
export const SINGLETON_SWEEPS_LOCK = 'orbit:apiserver-singleton-sweeps';

/** A process's own lock while it is connected: this prefix and its id, through the same hash. */
export const APISERVER_PROCESS_LOCK_PREFIX = 'orbit:apiserver-process:';

/** What a spec gives a leader of its own: the database, how often it asks, and which process it is. */
export interface ControlPlaneLeaderOptions {
  /** The database; DATABASE_URL otherwise. */
  databaseUrl?: string;
  /** LEADER_POLL_MS otherwise. */
  pollMs?: number;
  /** A new id otherwise. */
  processId?: string;
}

/** The injection token of ControlPlaneLeaderOptions; nothing provides it in the apiserver. */
export const CONTROL_PLANE_LEADER_OPTIONS = Symbol('CONTROL_PLANE_LEADER_OPTIONS');

const short = (id: string) => id.slice(0, 8);

@Injectable()
export class ControlPlaneLeader implements OnModuleInit, OnModuleDestroy {
  /** This process as the others name it: its row in `apiserver_process`, and the lock it holds while connected. */
  readonly processId: string;
  private readonly log = new Logger('ControlPlaneLeader');
  private readonly pollMs: number;
  private client: Client | null = null;
  /** When this process last took the lock; null while it does not hold it. */
  private since: number | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private pass: Promise<void> | null = null;
  private stopped = false;

  constructor(@Optional() @Inject(CONTROL_PLANE_LEADER_OPTIONS) private readonly options: ControlPlaneLeaderOptions = {}) {
    this.processId = options.processId ?? randomUUID();
    this.pollMs = options.pollMs ?? LEADER_POLL_MS;
  }

  onModuleInit(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref(); // the sweeps it decides about do not keep the process alive either
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pass;
    this.drop('the process is stopping');
  }

  /** Whether this process runs the singleton sweeps now. */
  leads(): boolean {
    return this.since !== null;
  }

  /**
   * When this process took the lock it holds, or null when it holds none. A sweep that keeps state in memory
   * compares it with the instant it last saw: a different one is a takeover, by this process from another or by
   * this process again after its connection dropped, and either way another reaper may have run in between.
   */
  leadingSince(): number | null {
    return this.since;
  }

  /**
   * One pass: connect when not connected, then ask for the lock, or, holding it, check the connection it is held
   * on. Never throws; a pass already running is the one a second caller gets.
   */
  tick(): Promise<void> {
    this.pass ??= this.once().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async once(): Promise<void> {
    if (this.stopped) return;
    try {
      const client = this.client ?? (await this.connect());
      if (this.since === null) {
        const { rows } = await client.query<{ taken: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "taken"',
          [SINGLETON_SWEEPS_LOCK],
        );
        // Taken on the connection that is still this process's: one dropped while the statement ran took the lock
        // with it.
        if (rows[0]?.taken && this.client === client && !this.stopped) {
          this.since = Date.now();
          this.log.log(
            `apiserver process ${short(this.processId)} now runs the reaper, the task sweep and the auto-retry sweep`,
          );
        }
      } else {
        // The lock lives exactly as long as this connection, so a statement it answers says the lock is still here.
        await client.query('SELECT 1');
      }
    } catch (error) {
      this.drop(`its coordination connection failed (${(error as Error).message})`);
    }
  }

  private async connect(): Promise<Client> {
    // pg cannot parse Prisma's `?schema=`; advisory locks are database-wide anyway (realtime.service.ts strips it too).
    const url = (this.options.databaseUrl ?? process.env.DATABASE_URL ?? '').split('?')[0];
    const client = new Client({
      connectionString: url,
      application_name: `orbit-apiserver ${this.processId}`,
      connectionTimeoutMillis: COORDINATION_STATEMENT_TIMEOUT_MS,
      query_timeout: COORDINATION_STATEMENT_TIMEOUT_MS,
      // This end's keepalives find a database that vanished; the server's, set below, find a process that did.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    client.on('error', (error) => this.drop(`its coordination connection failed (${error.message})`, client));
    client.on('end', () => this.drop('its coordination connection ended', client));
    await client.connect();
    try {
      // PostgreSQL lets a session's locks go when it notices the session is gone. A process that exits closes its
      // socket and is noticed at once; one whose host or network went away is noticed by these, after ten seconds of
      // quiet and three unanswered probes five seconds apart, rather than after the operating system's two hours.
      // Ignored over a Unix socket, which has no such peer.
      await client.query('SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3');
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0))', [
        APISERVER_PROCESS_LOCK_PREFIX + this.processId,
      ]);
    } catch (error) {
      client.removeAllListeners('end');
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.stopped) {
      client.removeAllListeners('end');
      await client.end().catch(() => undefined);
      throw new Error('the process is stopping');
    }
    this.client = client;
    return client;
  }

  /**
   * Let the coordination connection go, and with it the lock if this process held it: from here this process
   * runs no singleton sweep, until a later pass connects again and takes the lock again. `which` is the client an
   * event came from; an event of one already let go changes nothing.
   */
  private drop(reason: string, which?: Client): void {
    if (which && which !== this.client) return;
    const client = this.client;
    this.client = null;
    if (this.since !== null) {
      this.since = null;
      this.log.warn(`apiserver process ${short(this.processId)} no longer runs the singleton sweeps: ${reason}`);
    }
    if (client) {
      client.removeAllListeners('end');
      client.removeAllListeners('error');
      client.on('error', () => undefined);
      client.end().catch(() => undefined);
    }
  }
}
