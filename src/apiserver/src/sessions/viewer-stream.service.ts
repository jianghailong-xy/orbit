import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  concatMap,
  defer,
  distinctUntilChanged,
  EMPTY,
  from,
  interval,
  map,
  merge,
  mergeMap,
  Observable,
  of,
  Subject,
  tap,
} from 'rxjs';
import { replayableEventSql } from '../common/system-noise';
import { untilStopping } from '../common/graceful-stop';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { coalesceDeltas, isStreamingDelta } from './coalesce-deltas';
import {
  KEEPALIVE_MS,
  replayThenLive,
  resyncEvent,
  SSE_GAP_CAP,
  SSE_REPLAY_CAP,
  type StreamedEvent,
} from './session-stream';
import { SessionsService } from './sessions.service';
import { truncatePayload } from './truncate-payload';
import { HEAD_FRAME, HEAD_TRIGGERS, type ViewerAudience, viewerFrame } from './viewer-stream';

/** How long a session's head triggers are gathered before its head is read again (§4: one read per 250 ms). */
export const HEAD_COALESCE_MS = 250;

/** Who is watching, as the stream needs to know it: the projection, and for a guest how to ask whether the agent
 *  waits on the owner (SessionGuestsService.waitingOnOwner — passed in, as that service sits on top of this module). */
export type ViewerStreamAudience =
  | { kind: 'GUEST'; waitingOnOwner: (sessionId: string) => Promise<boolean> }
  | { kind: 'PUBLIC'; toolOutput: boolean };

type Head = Record<string, unknown>;

/**
 * The two viewer streams' body (docs/session-viewer-stream-design.md §3–§4): the owner's stream's shape —
 * sinceSeq replay, SSE_GAP_CAP resync, SSE_REPLAY_CAP tail, replayThenLive over RealtimeService.streamForRun, a
 * ping every ~20 s, an end as the apiserver stops — with every frame through the viewer projection
 * (viewer-stream.ts) and `status` replaced by `head` frames.
 *
 * Access is the route's to check BEFORE this is called (a guard: a stream's 200 is on the wire before anything
 * here runs). Revocation (a `gone` frame) and the anonymous caps are their own tasks; the hooks they need are the
 * one place a stream is opened (`stream`) and the keepalive below, where a ping-time recheck belongs.
 */
@Injectable()
export class ViewerStreamService {
  private readonly log = new Logger(ViewerStreamService.name);
  /** `<kind>:<sessionId>` → the head triggers gathered for every stream of that session and audience kind. */
  private readonly heads = new Map<string, { ticks: Subject<Head>; streams: number; timer: NodeJS.Timeout | null; read: () => Promise<Head> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly sessions: SessionsService,
  ) {}

  stream(sessionId: string, audience: ViewerStreamAudience, opts: { sinceSeq?: string; maxPayload?: number }): Observable<MessageEvent> {
    const projection: ViewerAudience = audience.kind === 'GUEST' ? { kind: 'GUEST' } : audience;
    const key = `${audience.kind}:${sessionId}`;
    const readHead = (): Promise<Head> => this.readHead(sessionId, audience);
    const poke = () => this.poke(key);

    const since = Number(opts.sinceSeq);
    const cursor = Number.isFinite(since) && since > 0 ? Math.trunc(since) : undefined;
    // As the owner's stream replays: the gap after the cursor (asc, one row past SSE_GAP_CAP), or the newest
    // SSE_REPLAY_CAP (desc, reversed below), filtered by the predicate the paged reads use.
    const history$ = defer(() =>
      this.prisma.$queryRaw<{ seq: number; type: string; payload: unknown; turnId: string | null; createdAt: Date }[]>`
        SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
        FROM run_event
        WHERE session_id = ${sessionId}::uuid
          ${cursor !== undefined ? Prisma.sql`AND seq > ${cursor}` : Prisma.empty}
          AND ${replayableEventSql}
        ORDER BY seq ${cursor !== undefined ? Prisma.sql`ASC` : Prisma.sql`DESC`}
        ${cursor !== undefined ? Prisma.sql`LIMIT ${SSE_GAP_CAP + 1}` : Prisma.sql`LIMIT ${SSE_REPLAY_CAP}`}
      `,
    ).pipe(
      concatMap((rows): Observable<StreamedEvent> => {
        if (cursor === undefined) return from([...rows].reverse());
        if (rows.length > SSE_GAP_CAP) return of(resyncEvent());
        return from(rows);
      }),
    );
    // A head trigger is noticed on the raw live feed, before the projection drops it.
    const live$ = this.realtime.streamForRun(sessionId).pipe(
      tap((e) => {
        if (HEAD_TRIGGERS.has(e.type)) poke();
      }),
      coalesceDeltas(),
    );
    const events$ = replayThenLive(history$, live$, () => this.realtime.turnPrefix(sessionId)).pipe(
      mergeMap((e) => {
        const frame = viewerFrame(projection, cut(e, opts.maxPayload));
        return frame ? of(toMessage(frame)) : EMPTY;
      }),
    );
    const renamed$ = this.realtime.sessionUpdatesForRun(sessionId).pipe(
      tap(poke),
      mergeMap(() => EMPTY),
    );
    // One head when the stream opens, then one per gathered trigger — sent only when it differs from the last.
    const heads$ = defer(() => merge(from(readHead()), this.headTicks(key, readHead))).pipe(
      map((head) => ({ json: JSON.stringify(head), head })),
      distinctUntilChanged((a, b) => a.json === b.json),
      map(({ head }) => ({ data: { seq: 0, type: HEAD_FRAME, payload: head } }) as MessageEvent),
    );
    // The keepalive. S1r's ping-time access recheck belongs here.
    const pings$ = interval(KEEPALIVE_MS).pipe(map(() => ({ data: { type: 'ping' } }) as MessageEvent));
    return merge(heads$, events$, renamed$, pings$).pipe(untilStopping());
  }

  /** The head as the `events?after=` answer states it: SessionsService.sharedHead, and a guest's `waitingOnOwner`. */
  private async readHead(sessionId: string, audience: ViewerStreamAudience): Promise<Head> {
    if (audience.kind === 'PUBLIC') return this.sessions.sharedHead(sessionId);
    const [head, waitingOnOwner] = await Promise.all([this.sessions.sharedHead(sessionId), audience.waitingOnOwner(sessionId)]);
    return { ...head, waitingOnOwner };
  }

  /** The heads read for `key`'s gathered triggers, while this stream is open: one read per session and audience
   *  kind, however many of its streams saw the trigger, shared by all of them. */
  private headTicks(key: string, read: () => Promise<Head>): Observable<Head> {
    return new Observable<Head>((subscriber) => {
      let entry = this.heads.get(key);
      if (!entry) {
        entry = { ticks: new Subject<Head>(), streams: 0, timer: null, read };
        this.heads.set(key, entry);
      }
      entry.streams += 1;
      const sub = entry.ticks.subscribe(subscriber);
      const held = entry;
      return () => {
        sub.unsubscribe();
        held.streams -= 1;
        if (held.streams === 0) {
          if (held.timer) clearTimeout(held.timer);
          if (this.heads.get(key) === held) this.heads.delete(key);
        }
      };
    });
  }

  /** A head trigger for `key`: the first one starts a HEAD_COALESCE_MS window, the ones inside it ride along. */
  private poke(key: string): void {
    const entry = this.heads.get(key);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // A head that cannot be read (the session went to the Trash) sends nothing; ending the stream then is S1r's.
      entry.read().then(
        (head) => entry.ticks.next(head),
        (err) => this.log.debug(`viewer head ${key}: ${(err as Error).message}`),
      );
    }, HEAD_COALESCE_MS);
  }
}

/** `maxPayload` trims bulky tool bodies on both halves alike, as on the owner's stream and the paged reads. */
function cut(e: StreamedEvent, cap: number | undefined): StreamedEvent & { truncated?: true } {
  if (!cap) return e;
  const trimmed = truncatePayload(e.type, e.payload, cap);
  return trimmed.truncated ? { ...e, payload: trimmed.payload, truncated: true } : { ...e, payload: trimmed.payload };
}

/** The wire envelope: a delta's reduced one (seq/type/payload, as on the owner's stream); every other frame the
 *  fields a paged read's event has — seq, type, payload, turnId, ts and `truncated` when trimmed — and no other. */
function toMessage(e: StreamedEvent & { truncated?: true }): MessageEvent {
  if (isStreamingDelta(e.type)) return { data: { seq: e.seq, type: e.type, payload: e.payload } } as MessageEvent;
  return {
    data: {
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      turnId: e.turnId ?? null,
      ts: e.ts ?? e.createdAt,
      ...(e.truncated ? { truncated: true } : {}),
    },
  } as MessageEvent;
}
