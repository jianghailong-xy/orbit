import type { EventPageEvent } from '../api';

// One session's memoized `getSessionEventFull` — the untrimmed payload of an event the server
// clipped to a preview (see MAX_EVENT_PAYLOAD, /sessions/:id/events/:seq/full).
//
// The card that asks for one keeps its copy in its own component state, and a remount throws that
// away: scrolling far enough re-mounts the row, and a card that paged back in with older history is
// a brand-new component. Without this the transcript asks again — 400KB of screenshot again — for an
// event that is immutable once ingested, and the picture blinks back to its placeholder on the way.
//
// In-memory only, and scoped by whoever builds it: seqs are per session, so a map that outlived a
// session switch would answer this session's 99323 with another session's. The id in the closure is
// therefore the session's, and the caller makes a new one when it changes.
export function memoizeEventFull(
  fetchOne: (seq: number) => Promise<EventPageEvent>,
): (seq: number) => Promise<EventPageEvent> {
  const cache = new Map<number, Promise<EventPageEvent>>();
  return (seq) => {
    const hit = cache.get(seq);
    if (hit) return hit;
    // The promise, not the payload: two cards asking in the same tick are one request, and the
    // first render after a remount resolves in a microtask rather than a round trip.
    const pending = fetchOne(seq);
    cache.set(seq, pending);
    // A rejection is not this event's answer — drop it, so a card that asks again gets a real try
    // instead of the same failure forever.
    pending.catch(() => cache.delete(seq));
    return pending;
  };
}
