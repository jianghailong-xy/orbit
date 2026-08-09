/**
 * How the transcript pane paints while it is catching up: what stands in for an empty pane, and
 * how much of a freshly fetched page to render in the first frame.
 *
 * Both decisions used to live as sprawling inline conditions in AgentView's JSX, where the four
 * empty-pane cases could only be told apart by reading three overlapping boolean chains. They are
 * here so each case can be stated once and tested.
 */

/**
 * What to render in place of an empty transcript.
 *
 * - `queued` — the session is waiting for a runner slot; the centered "waiting for a slot" pane
 *   states that, and outranks everything else because it is a real status, not a loading state.
 * - `skeleton` — a tail page is in flight for a session with no cached transcript. Not knowing yet
 *   whether the session is empty or merely unloaded, the honest placeholder is "loading".
 * - `waiting` — the load finished and the session really is empty, but it is live: the agent has
 *   genuinely not said anything yet.
 * - `null` — nothing to say (there are events, or the session is ended and empty).
 */
export type TranscriptPlaceholder = 'queued' | 'skeleton' | 'waiting' | null;

export function transcriptPlaceholder(view: {
  /** A session row has resolved, from either the list or its detail. */
  hasSession: boolean;
  /** The session is in Trash — its status pane is the deletion notice, not any of these. */
  trashed: boolean;
  /** Run state of the open session, e.g. 'QUEUED' | 'RUNNING' | 'AWAITING_INPUT'. */
  runState: string | null;
  /** Whether that run state is a live one (see isSessionLive). */
  live: boolean;
  eventCount: number;
  /** A tail page is in flight for a session with no cached transcript. */
  seeding: boolean;
  /** A partial assistant bubble (streamed text or thinking) is already on screen. */
  streaming: boolean;
}): TranscriptPlaceholder {
  if (view.eventCount > 0) return null;
  // The queued and waiting states describe a session we have resolved and that isn't in Trash.
  // The skeleton doesn't: it describes OUR fetch, which is in flight either way — including on a
  // deep link, where the transcript loads before any row has resolved.
  const known = view.hasSession && !view.trashed;
  if (known && view.runState === 'QUEUED') return 'queued';
  if (view.seeding) return 'skeleton';
  if (known && view.live && !view.streaming) return 'waiting';
  return null;
}

/**
 * How many of a tail page's events to put on screen in the first frame. The page is sized to
 * cover a scroll-up (TAIL_PAGE), not a viewport — rendering all of it before the first paint
 * means parsing a few hundred Markdown bodies and syntax-highlighting every code block in one
 * synchronous burst, with the pane still blank throughout. This is comfortably more than a tall
 * screen shows, so the deferred remainder only ever lands above the viewport.
 */
export const FIRST_PAINT_EVENTS = 50;

/**
 * Split a freshly fetched tail page into what to paint now (the newest events — the transcript
 * opens at the latest message) and whether anything was held back.
 *
 * Returns the input array itself when it fits, so React can skip the second render entirely.
 */
export function firstPaintSlice<T>(
  events: T[],
  limit: number = FIRST_PAINT_EVENTS,
): { now: T[]; deferred: boolean } {
  if (events.length <= limit) return { now: events, deferred: false };
  return { now: events.slice(-limit), deferred: true };
}
