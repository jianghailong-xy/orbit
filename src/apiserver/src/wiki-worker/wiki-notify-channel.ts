import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';

/**
 * One wiki queue's announcements, over a dedicated LISTEN connection (design §5.5; the shape is
 * `realtime/realtime.service.ts`'s). Every settled row NOTIFYs the channel with its id, so whoever waits on
 * it is woken as the answer lands rather than on a poll; a dropped connection is retried, and the waiters
 * themselves poll as the fallback — an announcement lost is latency, never a lost answer.
 *
 * One chapter per channel rather than one connection for all of them, because a channel's payload is one
 * id and the waiters of two queues have nothing to say to each other: `wiki_model_request` wakes the job
 * waiting on a model call, `wiki_repo_op` the one waiting on the repository.
 */
export class WikiNotifyChannel implements OnModuleInit, OnModuleDestroy {
  private readonly log: Logger;
  private listener?: Client;
  private connecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly listeners = new Set<(id: string) => void>();

  constructor(private readonly channel: string, label: string) {
    this.log = new Logger(label);
  }

  onModuleInit(): void {
    if (!process.env.DATABASE_URL) {
      // A module booted in a test with its own Prisma and no environment: nothing to listen on, and the
      // waiters' poll still answers (see wiki-job-executor.ts).
      return;
    }
    this.connect();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listener?.removeAllListeners('error');
    this.listener?.end().catch(() => undefined);
    this.listener = undefined;
  }

  /** Hear about settled rows. The returned function stops hearing. */
  onChange(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): void {
    if (this.stopped || this.connecting || this.listener) return;
    this.connecting = true;
    // pg cannot parse Prisma's `?schema=` query parameter; LISTEN/NOTIFY does not need it.
    const url = (process.env.DATABASE_URL as string).replace(/([?&])schema=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const client = new Client({ connectionString: url });
    client.on('error', (error: Error) => {
      this.log.error(`listener connection error: ${error.message}`);
      this.reconnect();
    });
    client
      .connect()
      .then(() => client.query(`LISTEN ${this.channel}`))
      .then(() => {
        if (this.stopped) {
          client.end().catch(() => undefined);
          return;
        }
        this.listener = client;
        this.log.log(`LISTEN/NOTIFY active for ${this.channel}`);
      })
      .catch((error: Error) => {
        this.log.error(`listener connect failed: ${error.message}`);
        client.end().catch(() => undefined);
        this.scheduleReconnect();
      })
      .finally(() => {
        this.connecting = false;
      });
    client.on('notification', (message) => {
      const id = (message.payload ?? '').trim();
      if (id === '') return;
      for (const listener of this.listeners) listener(id);
    });
  }

  private reconnect(): void {
    const old = this.listener;
    this.listener = undefined;
    old?.removeAllListeners('notification');
    old?.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2_000);
    this.reconnectTimer.unref();
  }
}
