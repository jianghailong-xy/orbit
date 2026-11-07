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

interface Watched {
  /** The streams of this account on this process that declared `hints=list_changed`. */
  streams: Set<(event: ControlEvent) => void>;
  /** The account's counter total at the last read; undefined until the first one. */
  sum?: string;
  /** The version last announced, or read as the baseline; undefined until the first read. */
  version?: string;
}

/**
 * `sessions.list_changed` (docs/realtime-control-plane-stream.md §4.8): a hint, sent to the streams
 * that asked for it, that the account's Open list may read differently than it did.
 *
 * It does not depend on any write path publishing anything. Every table the Open list is built
 * from bumps the account's `open_list_epoch` counters (migrations 0484/0487), so this process sums
 * those counters once a second — one statement for every account it has a hinted stream of, however
 * many streams and devices that is — and an account whose total moved is told. What moves only with
 * the clock (a runner going offline, a job going quiet, a review window or an escalation passing)
 * moves no counter, so every 15 s the whole version (`readOpenListVersion`) is read for each watched
 * account as well. An account is told only when its version differs from the one it was last told,
 * and `data.version` is that version.
 *
 * At most one hint per account per second: a tick sends each account at most one, and the next tick
 * is scheduled a full interval after this one ended, never on a fixed beat a slow tick could catch
 * up with.
 *
 * Reads only. It writes nothing and takes no lock.
 */
export class OpenListHints {
  private readonly log = new Logger('OpenListHints');
  private readonly owners = new Map<string, Watched>();
  private timer?: ReturnType<typeof setTimeout>;
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
      const send = (event: ControlEvent) => subscriber.next(event);
      let watched = this.owners.get(ownerId);
      if (!watched) {
        watched = { streams: new Set() };
        this.owners.set(ownerId, watched);
      }
      watched.streams.add(send);
      this.schedule();
      const mine = watched;
      return () => {
        mine.streams.delete(send);
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
    if (this.stopped || this.timer || this.owners.size === 0) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        this.timer = undefined;
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
        const moved = watched.sum !== undefined && watched.sum !== sum;
        watched.sum = sum;
        const baseline = watched.version === undefined;
        if (!baseline && !moved && !clock) return;
        const version = await readOpenListVersion(this.prisma, ownerId, Date.now());
        if (baseline || version === watched.version) {
          watched.version = version;
          return;
        }
        watched.version = version;
        const data: ControlListChanged = { version };
        const event: ControlEvent = {
          type: ControlEventType.SESSIONS_LIST_CHANGED,
          sessionId: '',
          agentId: null,
          ts: new Date().toISOString(),
          data: data as unknown as Record<string, unknown>,
        };
        // Each stream gets its own copy: the response interceptors rewrite ids in place, per request.
        for (const send of watched.streams) send({ ...event, data: { ...event.data } });
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
