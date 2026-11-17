import { Observable } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import { isStreamingDelta } from './coalesce-deltas';

/*
 * The parts of a session's transcript stream every door shares: the owner's (`SessionsController`
 * `@Sse(':id/events')`) and the viewers' (viewer-stream.service.ts). Moved here unchanged from
 * sessions.controller.ts so the viewer streams replay and hand over exactly as the owner's does.
 */

/** ~20s data-plane keepalive (mirrors EventsController): a `ping` data frame — Nest's @Sse can't
 *  emit raw `:` comments — sent on the per-session transcript stream so an *idle* session (one
 *  sitting AWAITING_INPUT emits no events for minutes) still pushes a byte before an intermediary
 *  (Cloudflare reaps idle proxied streams) severs it. Without it the browser eventually shows
 *  ERR_HTTP2_PROTOCOL_ERROR and reconnect-storms. Clients discard the frame by its `ping` type. */
export const KEEPALIVE_MS = 20_000;

/** Cap the SSE history replay when a client connects WITHOUT a `sinceSeq` cursor. Without this,
 *  a cursor-less connect replays the entire transcript over SSE — hundreds of KB the client parses
 *  byte-by-byte, so on a long web-accumulated session the newest reply takes many seconds to
 *  surface (or never). Clients open cold via `GET /events/page?tail=N` and then resume the SSE with
 *  `sinceSeq=<max>`, so this bound only affects the fallback/cursor-less path; older history is
 *  paged in over `/events/page`. Matches the client tail-page size (web `TAIL_PAGE`, iOS `tailPage`).
 *  A cursor'd connect replays its whole gap instead, up to SSE_GAP_CAP. */
export const SSE_REPLAY_CAP = 200;

/**
 * Cap the gap a cursor'd connect will replay. Sending the full gap is what keeps a resumed
 * transcript from holing, so this is deliberately far above SSE_REPLAY_CAP — a client an hour
 * behind should still be caught up in place, not reset. It exists because "the full gap" was
 * previously unbounded in both directions that matter: how many events, and how many bytes each
 * one carries. A cursor sitting just below two screenshots had to swallow ~580KB per attempt, and
 * a cursor that can never commit re-requests the same gap forever.
 *
 * MAX_IMAGE_PAYLOAD bounds the bytes; this bounds the count. Past it the replay is abandoned for a
 * `resync`, which costs the client one tail page — strictly less than replaying a thousand events
 * it would have to hold in memory anyway.
 */
export const SSE_GAP_CAP = 1000;

/**
 * Cap the live events held while the replay query is in flight (see `replayThenLive`). The window
 * is one DB round trip, so this sits far above anything a healthy one produces; it is here so a
 * stalled query cannot turn a per-connection buffer into unbounded memory. Past it the buffer is
 * abandoned for a `resync`, for the same reason an over-long gap is: handing over what survived
 * would leave a hole the client cannot see.
 */
export const SSE_LIVE_BUFFER_CAP = 500;

/** What the two halves of the transcript stream have in common: a replayed row carries
 *  `createdAt`, a live broadcast carries `ts`. */
export type StreamedEvent = {
  seq: number;
  type: string;
  payload: unknown;
  turnId?: string | null;
  ts?: string;
  createdAt?: Date;
};

/** The order to re-seed: drop the cached window, refetch a tail page, resume from its max seq.
 *  Rides seq 0 like the other live-only control events, so it lands ahead of the client's dedup. */
export const resyncEvent = (): StreamedEvent => ({
  seq: 0,
  type: RunEventType.RESYNC as string,
  payload: {},
  turnId: null,
  createdAt: new Date(),
});

/**
 * What this turn has already streamed, as the delta frames a client connecting now would otherwise
 * never see.
 *
 * The deltas are broadcast-only: ingest drops them and the replay query filters them again, so the
 * half-sentence a session has emitted before you opened it exists nowhere the replay can reach
 * (RealtimeService.turnPrefix holds it). One frame carries the whole prefix — clients append delta
 * text to the open bubble, so a single frame reads the same as the hundred it stands for.
 *
 * Seq 0 like every other live-only event: the prefix is animation, not history, and must not touch
 * the client's resume cursor.
 */
function prefixEvents(held: { text: string; thinking: string }): StreamedEvent[] {
  const frame = (type: string, text: string): StreamedEvent => ({ seq: 0, type, payload: { text } });
  // Thinking first: it precedes the text it reasoned toward, and the two drive separate drafts.
  return [
    ...(held.thinking ? [frame(RunEventType.THINKING_DELTA as string, held.thinking)] : []),
    ...(held.text ? [frame(RunEventType.TEXT_DELTA as string, held.text)] : []),
  ];
}

/**
 * What the window collected, minus what the replay already delivered.
 *
 * Only persisted events can arrive down both halves, and they are the ones carrying a real seq:
 * every live-only kind (approval, resync, tool_output, and the deltas) rides seq 0 and is exempt
 * from the comparison. A delta buffered *before* a duplicate goes with it — its text animates a
 * reply the replay has already handed over whole, so releasing it afterwards would repopulate a
 * streaming bubble nothing would clear again.
 */
function withoutReplayed(buffer: readonly StreamedEvent[], maxReplaySeq: number): StreamedEvent[] {
  const replayed = (event: StreamedEvent): boolean => event.seq > 0 && event.seq <= maxReplaySeq;
  const lastReplayed = buffer.reduce((last, event, i) => (replayed(event) ? i : last), -1);
  return buffer.filter(
    (event, i) => !replayed(event) && !(i < lastReplayed && isStreamingDelta(event.type)),
  );
}

/**
 * The replay, then the live hub — with the window between them closed.
 *
 * `concat` subscribed to the hub only once the history query had come back, so everything the
 * runner published during that round trip landed on nobody and nothing ever brought it back: the
 * hub is a bare Subject with no replay, and clients dedup by seq without assuming seq is
 * contiguous, so the loss was invisible to them. One round trip is a narrow window, but a session
 * mid-reply is exactly when events are densest — and losing the authoritative `assistant` there
 * leaves a streaming draft nothing clears until the turn ends, with the tool cards that follow
 * rendered underneath that half-finished bubble.
 *
 * So the hub is subscribed FIRST and what it emits is held; `history$` defers its query, which is
 * therefore issued from here, underneath that subscription. The stream ends when both halves do,
 * as it did under `concat`.
 *
 * The events are held as they came: the hub hands the *same* object to every subscriber on the
 * session, so writing through one would corrupt the other tabs' streams.
 *
 * The same handover is where the turn's already-streamed text is handed over (`streamedPrefix`).
 * The replay cannot carry it — deltas are never persisted — so a client that opens a session
 * mid-reply used to pick the text up from wherever the engine happened to be, i.e. mid-sentence,
 * until the turn's `assistant` event self-healed it.
 */
export function replayThenLive(
  history$: Observable<StreamedEvent>,
  live$: Observable<StreamedEvent>,
  streamedPrefix: () => { text: string; thinking: string },
): Observable<StreamedEvent> {
  return new Observable<StreamedEvent>((subscriber) => {
    let buffer: StreamedEvent[] = [];
    let buffering = true;
    let overflowed = false;
    let maxReplaySeq = 0;
    let liveDone = false;
    let historyDone = false;
    const finish = (): void => {
      if (liveDone && historyDone) subscriber.complete();
    };

    const liveSub = live$.subscribe({
      next: (event) => {
        if (!buffering) {
          subscriber.next(event);
          return;
        }
        if (buffer.length >= SSE_LIVE_BUFFER_CAP) {
          overflowed = true;
          buffer = [];
          return;
        }
        buffer.push(event);
      },
      error: (err) => subscriber.error(err),
      complete: () => {
        liveDone = true;
        finish();
      },
    });

    // Snapshotted here, on purpose: the hub subscription above is live and nothing can have been
    // published through it yet (publish() runs on another task, never between two statements). That
    // is what keeps the two halves disjoint — everything streamed BEFORE this line is in the
    // snapshot and in no buffer, everything after is in the buffer and not the snapshot — so the
    // prefix reaches the client exactly once.
    const snapshot = streamedPrefix();

    const historySub = history$.subscribe({
      next: (event) => {
        if (event.seq > maxReplaySeq) maxReplaySeq = event.seq;
        subscriber.next(event);
      },
      error: (err) => subscriber.error(err),
      complete: () => {
        // Re-read before handing the snapshot over. An ingest commits its rows and broadcasts them
        // a moment later, so a boundary event can be in the replay just delivered while the
        // broadcast that drops this buffer has not run yet; sending the prefix then would leave a
        // stray half-sentence under the full text the replay already carried. If the buffer no
        // longer starts with what was snapshotted, something superseded it and it is not ours to
        // send. (A turn past RealtimeService's cap reads as empty here, which fails the same test —
        // the deliberate fallback to the old behaviour.)
        const current = streamedPrefix();
        const superseded =
          !current.text.startsWith(snapshot.text) || !current.thinking.startsWith(snapshot.thinking);
        // The prefix goes ahead of the buffer: it was streamed before any of it. On an overflowed
        // buffer it is dropped with everything else — the client is re-seeding from a tail page, and
        // a resync it will act on says more than a draft it is about to discard.
        const prefix = superseded ? [] : prefixEvents(snapshot);
        const held = overflowed
          ? [resyncEvent()]
          : [...prefix, ...withoutReplayed(buffer, maxReplaySeq)];
        buffer = [];
        buffering = false;
        for (const event of held) subscriber.next(event);
        historyDone = true;
        finish();
      },
    });

    // Reached however this ends — including a replay that throws, which must not leave this
    // connection's hub subscription behind.
    return () => {
      historySub.unsubscribe();
      liveSub.unsubscribe();
    };
  });
}
