import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ControlEvent, ControlEventType, type ControlListChanged } from '@orbit/shared';
import { Observable } from 'rxjs';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersion } from '../sessions/open-list-version';

/** How often the account counters are summed, and so the soonest a hint follows a write. */
export const LIST_CHANGED_COUNTER_EVERY_MS = 1_000;
/** How often the whole version is read for every watched account, for what moves with the clock alone. */
export const LIST_CHANGED_CLOCK_EVERY_MS = 15_000;

/** One stream that declared `hints=list_changed`, and the version it was last told. */
interface Stream {
  send: (event: ControlEvent) => void;
  /** Undefined until its first hint, which it gets at the first tick after it subscribed. */
  told?: string;
}

interface Watched {
  /** The streams of this account on this process that declared `hints=list_changed`. */
  streams: Set<Stream>;
  /** The account's counter total at the last read; undefined until the first one. */
  sum?: string;
  /** The account's version at the last read; undefined until the first one. */
  version?: string;
}

/**
 * `sessions.list_changed` (docs/realtime-control-plane-stream.md §4.8): a hint, sent to the streams
 * that asked for it, that the account's Open list may read differently than that stream was last told.
 *
 * It does not depend on any write path publishing anything. Every table the Open list is built
 * from bumps the account's `open_list_epoch` counters (migrations 0484/0487), so this process sums
 * those counters once a second — one statement for every account it has a hinted stream of, however
 * many streams and devices that is — and reads the account's version when its total moved. What
 * moves only with the clock (a runner going offline, a job going quiet, a review window or an
 * escalation passing) moves no counter, so every 15 s the whole version (`readOpenListVersion`) is
 * read for each watched account as well.
 *
 * What a stream was told is kept per stream, not per account. A new stream is told the current
 * version at the first tick after it subscribed, whether or not anything moved: a client reads its
 * list around the time it connects, in either order relative to the subscription, and this first
 * hint is what that read is answered against — a write that landed between the two is never lost
 * in a baseline. After that a stream is told only a version that differs from the one it holds.
 *
 * At most one hint per stream per second: a tick sends each stream at most one, and the next tick is
 * scheduled a full interval after this one ended, never on a fixed beat a slow tick could catch up
 * with. One tick chain at a time: a stream that arrives while a tick runs leaves the next one to that
 * tick's end.
 *
 * Reads only. It writes nothing and takes no lock.
 */
export class OpenListHints {
  private readonly log = new Logger('OpenListHints');
  private readonly owners = new Map<string, Watched>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private lastClockAt = 0;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly counterEveryMs = LIST_CHANGED_COUNTER_EVERY_MS,
    private readonly clockEveryMs = LIST_CHANGED_CLOCK_EVERY_MS,
  ) {}

  /** The hints for one stream of `ownerId`; watching starts on subscribe and ends on unsubscribe. */
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
    }, this.counterEveryMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const ids = [...this.owners.keys()];
    if (ids.length === 0) return;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ owner_id: string; total: string }>>(Prisma.sql`
        SELECT owner_id::text AS owner_id, sum(epoch)::text AS total
          FROM open_list_epoch
         WHERE owner_id = ANY(${ids}::uuid[])
         GROUP BY owner_id`);
      const sums = new Map(rows.map((row) => [row.owner_id, row.total]));
      const now = Date.now();
      const clock = now - this.lastClockAt >= this.clockEveryMs;
      if (clock) this.lastClockAt = now;
      await Promise.all(ids.map(async (ownerId) => {
        const watched = this.owners.get(ownerId);
        if (!watched) return;
        const sum = sums.get(ownerId) ?? '0';
        const moved = watched.sum !== sum;
        watched.sum = sum;
        const untold = [...watched.streams].some((stream) => stream.told === undefined);
        if (moved || clock || untold || watched.version === undefined) {
          watched.version = await readOpenListVersion(this.prisma, ownerId, Date.now());
        }
        const version = watched.version;
        for (const stream of watched.streams) {
          if (stream.told === version) continue;
          stream.told = version;
          const data: ControlListChanged = { version };
          stream.send({
            type: ControlEventType.SESSIONS_LIST_CHANGED,
            sessionId: '',
            agentId: null,
            ts: new Date().toISOString(),
            data: data as unknown as Record<string, unknown>,
          });
        }
      }));
    } catch (error) {
      this.log.warn(`list_changed tick failed: ${(error as Error).message}`);
    }
  }
}
/** Whether a `GET /api/events?hints=` value declares `list_changed`. */
export function declaresListChanged(hints: string | string[] | undefined): boolean {
  const values = Array.isArray(hints) ? hints : hints === undefined ? [] : [hints];
  return values.some((value) => value.split(',').some((hint) => hint.trim() === 'list_changed'));
}
