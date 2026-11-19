import { Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * At most BROWSER_STREAMS_PER_RUNNER viewer streams per runner (docs/runner-browser-design.md §4), counted across every
 * apiserver process. The link gateway keeps the same bound, but per connection of the runner's, and a runner may hold
 * connections on two gateways; so the apiserver keeps the count itself.
 *
 * Each open stream holds one of its runner's slots: a session-level PostgreSQL advisory lock, keyed by the runner and
 * the slot's number, taken with pg_try_advisory_lock on one connection of this process's own. A stream takes the
 * first free slot, and finding none is refused. A slot is let go when its stream ends; and since the lock lives exactly
 * as long as the connection, a process that dies, or whose connection drops, lets all of its slots go with it. Such a
 * drop also ends every stream of this process (onLost), so that no stream runs without its slot.
 *
 * Not a write: nothing is stored, and the locks take no row.
 */

export const BROWSER_STREAMS_PER_RUNNER = 2;

/** The key text of a slot: the runner and the slot's number. hashtextextended makes the lock's bigint. */
export function browserStreamSlotKey(runnerId: string, slot: number): string {
  return `orbit.runner-browser-stream:${runnerId}:${slot}`;
}

const STATEMENT_TIMEOUT_MS = 5_000;

export interface BrowserStreamSlot {
  /** Lets the slot go, once. */
  release(): void;
}

export class BrowserStreamSlots {
  private readonly log = new Logger('BrowserStreamSlots');
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Every slot this process holds, by key, with what ends its stream when the connection goes. */
  private readonly held = new Map<string, () => void>();
  /** Statements run one at a time on the connection: pg queues them, and this keeps a release after its take. */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly databaseUrl: string | undefined = process.env.DATABASE_URL) {}

  /**
   * Takes a free slot of the runner, or answers null when all of them are held (here or by another process). onLost
   * is called if the slot is lost with the connection before it is released.
   */
  async acquire(runnerId: string, onLost: () => void): Promise<BrowserStreamSlot | null> {
    const client = await this.connect();
    for (let slot = 0; slot < BROWSER_STREAMS_PER_RUNNER; slot += 1) {
      const key = browserStreamSlotKey(runnerId, slot);
      // A session-level lock is re-entrant: this process already holding the slot would take it again.
      if (this.held.has(key)) continue;
      const taken = await this.run(client, async () => {
        const { rows } = await client.query<{ taken: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "taken"', [key]);
        return rows[0]?.taken === true;
      });
      if (!taken) continue;
      if (this.client !== client || this.held.has(key)) {
        // The connection dropped while the statement ran, taking the lock with it; or another stream of this process
        // took the same slot meanwhile (then this second lock is let go again).
        if (this.client === client) void this.unlock(client, key);
        continue;
      }
      this.held.set(key, onLost);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (this.held.get(key) !== onLost) return;
          this.held.delete(key);
          if (this.client === client) void this.unlock(client, key);
        },
      };
    }
    return null;
  }

  /** How many slots this process holds, for the specs. */
  heldCount(): number {
    return this.held.size;
  }

  async close(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    this.held.clear();
    if (client) {
      client.removeAllListeners('end');
      client.removeAllListeners('error');
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }

  private run<T>(client: Client, statement: () => Promise<T>): Promise<T> {
    const next = this.queue.then(statement, statement);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async unlock(client: Client, key: string): Promise<void> {
    try {
      await this.run(client, () => client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]));
    } catch (error) {
      this.drop(client, `letting a slot go failed (${(error as Error).message})`);
    }
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.stopped) return Promise.reject(new Error('the process is stopping'));
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    // pg cannot parse Prisma's `?schema=`; advisory locks are database-wide anyway (control-plane-leader.ts strips it too).
    const client = new Client({
      connectionString: (this.databaseUrl ?? '').split('?')[0],
      application_name: 'orbit-apiserver browser streams',
      connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    client.on('error', (error) => this.drop(client, `its connection failed (${error.message})`));
    client.on('end', () => this.drop(client, 'its connection ended'));
    await client.connect();
    try {
      // PostgreSQL lets a session's locks go when it notices the session is gone: at once for a process that exits,
      // and with these for one whose host or network went away (control-plane-leader.ts).
      await client.query('SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3');
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
    this.queue = Promise.resolve();
    return client;
  }

  /** The connection is gone, and every slot with it: each stream holding one is ended. */
  private drop(client: Client, reason: string): void {
    if (client !== this.client) return;
    this.client = null;
    client.removeAllListeners('end');
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    client.end().catch(() => undefined);
    const lost = [...this.held.values()];
    this.held.clear();
    if (lost.length > 0) this.log.warn(`the browser stream slots' connection is gone (${reason}): ending ${lost.length} stream(s)`);
    for (const onLost of lost) onLost();
  }
}
