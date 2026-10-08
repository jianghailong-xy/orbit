import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { WIKI_MODEL_REQUEST_CHANNEL } from './wiki-model-queue';

/**
 * The queue's announcements, over one dedicated LISTEN connection (design §5.5; the shape is
 * `realtime/realtime.service.ts`'s). Every settled request NOTIFYs the channel with its id, so a job
 * waiting on it is woken as the answer lands rather than on a poll; a dropped connection is retried, and
 * the waiters themselves poll as the fallback — an announcement lost is latency, never a lost answer.
 */
@Injectable()
export class WikiModelRequestChannel implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WikiModelChannel');
  private listener?: Client;
  private connecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly listeners = new Set<(requestId: string) => void>();

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

  /** Hear about settled requests. The returned function stops hearing. */
  onChange(listener: (requestId: string) => void): () => void {
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
      .then(() => client.query(`LISTEN ${WIKI_MODEL_REQUEST_CHANNEL}`))
      .then(() => {
        if (this.stopped) {
          client.end().catch(() => undefined);
          return;
        }
        this.listener = client;
        this.log.log('LISTEN/NOTIFY active for the model request queue');
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
