import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ControlEvent, ControlEventType } from '@orbit/shared';
import { Observable } from 'rxjs';
import type { PrismaService } from '../prisma/prisma.service';

/** How often the owner's request rows are read for a stream that declared `hints=owner_requests`. */
export const OWNER_REQUESTS_EVERY_MS = 1_000;

interface Stream {
  send: (event: ControlEvent) => void;
  /** Undefined until its first hint, which it gets at the first tick after it subscribed. */
  told?: string;
}

interface Watched {
  streams: Set<Stream>;
}

/**
 * `owner_requests.changed` (docs/realtime-control-plane-stream.md §4.9): a hint, sent to the streams that
 * declared `hints=owner_requests`, that the owner's requests (`GET /owner-requests`) read differently than
 * that stream was last told.
 *
 * It is derived from the `owner_request` table, not published by the code that writes it, for the reason
 * `sessions.list_changed` is (open-list-hints.ts): requests are written by five services (an agent's own
 * filing, schedules, conditions, secret delivery, the expiry sweep) at some thirty call sites, most of them
 * inside a transaction with no commit hook, and a publish placed in each would miss the next writer. Every
 * write moves `updated_at` (Prisma `@updatedAt`, and the raw statements set it), so the version is the
 * account's row count and its newest `updated_at`; once a second, one statement reads it for every account
 * this process has a declared stream of. The read happens after the commit by construction.
 *
 * A new stream is told the current version at the first tick after it subscribed, whether or not anything
 * moved: a client reads its requests around the time it connects, and this first hint is what that read is
 * answered against. After that a stream is told only a version that differs from the one it holds, at most
 * once a second. Reads only.
 */
export class OwnerRequestHints {
  private readonly log = new Logger('OwnerRequestHints');
  private readonly owners = new Map<string, Watched>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly everyMs = OWNER_REQUESTS_EVERY_MS,
  ) {}

  watch(ownerId: string): Observable<ControlEvent> {
    return new Observable<ControlEvent>((subscriber) => {
      const stream: Stream = { send: (event) => subscriber.next(event) };
      let watched = this.owners.get(ownerId);
      if (!watched) {
        watched = { streams: new Set() };
        this.owners.set(ownerId, watched);
      }
      watched.streams.add(stream);
      this.schedule();
      const mine = watched;
      return () => {
        mine.streams.delete(stream);
        if (mine.streams.size === 0 && this.owners.get(ownerId) === mine) this.owners.delete(ownerId);
        if (this.owners.size === 0 && this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
      };
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.ticking || this.owners.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ticking = true;
      void this.tick().finally(() => {
        this.ticking = false;
        this.schedule();
      });
    }, this.everyMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const ids = [...this.owners.keys()];
    if (ids.length === 0) return;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ owner_id: string; version: string }>>(Prisma.sql`
        SELECT owner_id::text AS owner_id,
               count(*)::text || ':' || (extract(epoch FROM max(updated_at)) * 1000)::bigint::text AS version
          FROM owner_request
         WHERE owner_id = ANY(${ids}::uuid[])
         GROUP BY owner_id`);
      const versions = new Map(rows.map((row) => [row.owner_id, row.version]));
      for (const ownerId of ids) {
        const watched = this.owners.get(ownerId);
        if (!watched) continue;
        const version = versions.get(ownerId) ?? '0';
        for (const stream of watched.streams) {
          if (stream.told === version) continue;
          stream.told = version;
          stream.send({
            type: ControlEventType.OWNER_REQUESTS_CHANGED,
            sessionId: '',
            agentId: null,
            ts: new Date().toISOString(),
            data: { version },
          });
        }
      }
    } catch (error) {
      this.log.warn(`owner_requests tick failed: ${(error as Error).message}`);
    }
  }
}
