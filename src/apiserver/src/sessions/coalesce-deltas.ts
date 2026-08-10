import { Observable } from 'rxjs';
import { RunEventType } from '@orbit/shared';

/**
 * Merges consecutive streaming deltas into one SSE message per short window.
 *
 * The engines emit `text_delta` per token, and nothing between the runner and the browser used to
 * combine them — so one message crossed the wire per token. The envelope dwarfs the content it
 * carries: a 3-character token ships as ~142 bytes once the SSE framing, the type, the turn id and
 * the timestamp are counted, i.e. ~98% overhead. A 2000-character reply is ~500 messages and ~70KB
 * for 2KB of text.
 *
 * It costs the client too. Every message is its own task, so React can't batch across them: the
 * streaming bubble re-renders once per token, re-parsing the Markdown each time. (iOS hit exactly
 * this and had to cap its own redraw rate.) Merging at the source fixes both ends at once.
 *
 * The window is a latency bound, not a period: the timer starts at the first buffered chunk and is
 * not extended by later ones, so text is never delayed by more than `windowMs`. At 50ms that's
 * 20Hz — continuous to the eye, and smoother than 100Hz of full re-renders.
 */
export const DELTA_COALESCE_MS = 50;

const DELTA_TYPES: ReadonlySet<string> = new Set<string>([
  RunEventType.TEXT_DELTA,
  RunEventType.THINKING_DELTA,
]);

interface DeltaLike {
  type: string;
  payload?: unknown;
}

/** Whether this event type is one of the broadcast-only streaming deltas. */
export function isStreamingDelta(type: string): boolean {
  return DELTA_TYPES.has(type);
}

/** The delta's text, or null if this isn't a delta we can merge (so it passes straight through). */
function deltaText(event: DeltaLike): string | null {
  if (!DELTA_TYPES.has(event.type)) return null;
  const text = (event.payload as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : null;
}

/**
 * A copy carrying `text`. Never mutates the input: the realtime hub hands the *same* event object
 * to every subscriber on the session, so writing through it would corrupt the other tabs' streams.
 */
function withText<T extends DeltaLike>(event: T, text: string): T {
  return { ...event, payload: { ...(event.payload as object | null), text } };
}

export function coalesceDeltas<T extends DeltaLike>(
  windowMs: number = DELTA_COALESCE_MS,
): (source: Observable<T>) => Observable<T> {
  return (source) =>
    new Observable<T>((subscriber) => {
      let buffered: T | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (buffered === null) return;
        const out = buffered;
        buffered = null;
        subscriber.next(out);
      };

      const sub = source.subscribe({
        next: (event) => {
          const text = deltaText(event);
          if (text === null) {
            // Order is the whole correctness argument here. `assistant`, `turn_end`, `user`,
            // `interrupt` and `error` all tell the client to clear its streaming buffer, so
            // buffered text arriving *after* one of them would repopulate a bubble nothing will
            // ever clear again. Flush first, always.
            flush();
            subscriber.next(event);
            return;
          }
          if (buffered !== null && buffered.type === event.type) {
            buffered = withText(buffered, (deltaText(buffered) ?? '') + text);
          } else {
            // A different kind of delta (thinking → text): these drive separate buffers on the
            // client and must not be concatenated into each other.
            flush();
            buffered = withText(event, text);
          }
          if (timer === null) {
            timer = setTimeout(() => {
              timer = null;
              flush();
            }, windowMs);
          }
        },
        error: (err) => {
          flush();
          subscriber.error(err);
        },
        complete: () => {
          flush();
          subscriber.complete();
        },
      });

      return () => {
        if (timer !== null) clearTimeout(timer);
        sub.unsubscribe();
      };
    });
}
