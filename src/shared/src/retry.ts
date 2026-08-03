/**
 * What a retry re-sends, and when a quota-blocked one may fire.
 *
 * Both halves are shared because two callers must agree on them: the transcript card (which
 * shows the user what will happen) and the server's quota sweeper (which does it). A card
 * promising one message while the server sends another is worse than no card.
 */

/** The minimum an event needs for {@link lastUserMessageText} — RunEvent, structurally. */
export interface RetryEvent {
  type: string;
  payload?: unknown;
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
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'user') continue;
    const text = (events[i].payload as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return numTurns === 0 && openingPrompt?.trim() ? openingPrompt : '';
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
