/**
 * What a retry re-sends, and when it may fire — for both failures that arm one: an exhausted
 * account quota, and a transient provider error ("API Error: 529 … overloaded_error").
 *
 * All of it is shared because two callers must agree on it: the transcript card (which shows
 * the user what will happen) and the server's sweeper (which does it). A card promising one
 * message while the server sends another is worse than no card.
 */

/** The minimum an event needs for {@link lastUserMessageText} — RunEvent, structurally. */
export interface RetryEvent {
  type: string;
  payload?: unknown;
}

/**
 * The user event a retry re-sends: the latest one that carries text.
 *
 * Exposed next to the text because a message is not only its words — the images sent with it
 * hang off the turn that carried it, and the server needs THIS event to find them. Choosing the
 * text here and the attachments from anywhere else is how a retry ends up re-sending one
 * message's words under another message's screenshot.
 */
export function lastUserMessage<T extends RetryEvent>(events: T[]): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'user') continue;
    const text = (events[i].payload as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string' && text.trim()) return events[i];
  }
  return undefined;
}

/**
 * The message a retry should re-send: the latest user message in the stream.
 *
 * Falls back to the session's opening prompt only on a first run (`numTurns === 0`), where
 * the failure landed before any user event existed — the whole session is the card. For an
 * established session the opening prompt is history, not the thing to re-send, so an empty
 * result (no retry offered) is the honest answer.
 */
export function lastUserMessageText(
  events: RetryEvent[],
  openingPrompt?: string | null,
  numTurns?: number,
): string {
  const text = (lastUserMessage(events)?.payload as { text?: string } | undefined)?.text;
  if (text) return text;
  return numTurns === 0 && openingPrompt?.trim() ? openingPrompt : '';
}

/**
 * How long to wait before re-sending a message a transient provider error killed
 * (`isRetryableApiErrorText`), indexed by how many auto-retries this run of failures has
 * already spent.
 *
 * Seconds, not the quota's minutes: an overloaded API is usually back within one, and a
 * failure the user is watching should not sit visibly idle for longer than the thing it is
 * waiting on. The length is also the cap — an error that survived three spaced retries is not
 * the transient kind this exists for, so the session goes back to the user rather than
 * spending more of their quota on it.
 */
export const API_ERROR_RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000];

/** How many auto-retries a transient provider error gets before it is handed back. */
export const MAX_API_ERROR_RETRIES = API_ERROR_RETRY_BACKOFF_MS.length;

/**
 * When to re-send after a transient provider error, or null once the attempts are spent.
 *
 * The jitter is the same precaution as the quota retry's, for the same reason: an overload is
 * a fact about the provider, so every session that hit it comes due at once and releasing them
 * in lockstep reproduces it. Scaled to the step, so the 30-second one is not smeared into
 * minutes.
 */
export function apiErrorRetryAt(
  attempts: number,
  now: Date,
  rand: () => number = Math.random,
): Date | null {
  const step = API_ERROR_RETRY_BACKOFF_MS[attempts];
  if (step === undefined) return null;
  return new Date(now.getTime() + step + Math.floor(rand() * step * 0.25));
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * Claude Code's own rendering of when the quota comes back, e.g.
 *   "You've hit your session limit · resets 6:20pm (Europe/Berlin)"
 *   "You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)"
 * The date appears only when the reset is not today; the parenthesised zone is an IANA name.
 */
const RESETS_AT = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\(([^)]+)\)/i;

/** What `tz` was offset from UTC at `at`, in ms (positive east of Greenwich). */
function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // hourCycle 'h23' vs 'h24': midnight comes back as 24 in some ICU builds.
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) -
    at.getTime()
  );
}

/** The UTC instant of a wall-clock time in `tz`. Two passes settle DST: the first offset is
 *  read at the wrong instant when the guess lands on the far side of a transition. */
function fromZoned(
  y: number, mo: number, d: number, h: number, mi: number, tz: string,
): Date {
  const wall = Date.UTC(y, mo, d, h, mi);
  const once = wall - zoneOffsetMs(new Date(wall), tz);
  return new Date(wall - zoneOffsetMs(new Date(once), tz));
}

/** Today's calendar date in `tz`, at `at`. */
function zonedDateParts(at: Date, tz: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), mo: get('month') - 1, d: get('day') };
}

/**
 * When the quota comes back, read out of the runtime's own message. Returns null when the
 * text carries no parsable reset time — including every Codex phrasing, which names no time
 * zone ("try again at Aug 9th, 2026 1:26 PM") and so cannot be pinned to an instant.
 *
 * This is the *fallback* source. The authoritative one is the runner's quota snapshot
 * (`planUsageBlockedUntil`), which reports a machine-readable `resetsAt` — but it refreshes on
 * its own cadence and can lag a limit by a couple of minutes, and this text is available the
 * instant the message lands. So: parse this to show the user a time immediately, and let the
 * snapshot correct it before anything is actually retried.
 *
 * The runtime omits the date when the reset is today, so a bare time that has already passed
 * in its zone means tomorrow. A dated one that has already passed means next year (the year
 * is never printed).
 */
export function parseQuotaResetAt(text: string | null | undefined, now: Date): Date | null {
  const m = text?.match(RESETS_AT);
  if (!m) return null;
  const [, monName, dayStr, hourStr, minStr, meridiem, tz] = m;

  const hour12 = Number(hourStr);
  if (hour12 < 1 || hour12 > 12) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  const minute = minStr ? Number(minStr) : 0;
  if (minute > 59) return null;

  try {
    if (monName) {
      const mo = MONTHS.indexOf(monName.toLowerCase());
      if (mo < 0) return null;
      const day = Number(dayStr);
      const year = zonedDateParts(now, tz).y;
      const at = fromZoned(year, mo, day, hour, minute, tz);
      // A printed date that already passed is next year's — the runtime never prints one.
      return at.getTime() >= now.getTime() ? at : fromZoned(year + 1, mo, day, hour, minute, tz);
    }
    const today = zonedDateParts(now, tz);
    const at = fromZoned(today.y, today.mo, today.d, hour, minute, tz);
    return at.getTime() > now.getTime()
      ? at
      : fromZoned(today.y, today.mo, today.d + 1, hour, minute, tz);
  } catch {
    return null; // unknown IANA zone — Intl throws rather than guessing
  }
}
