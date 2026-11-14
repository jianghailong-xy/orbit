/**
 * When a schedule fires next (docs/scheduled-tasks-design.md §5.1), as a pure function of its rule, its IANA time
 * zone and a moment.
 *
 *   * A slot is a local wall-clock time in the schedule's zone, never a number of seconds, so 10:00 stays 10:00
 *     across a daylight-saving change.
 *   * A local time that does not exist that day (the clocks jump over it) moves to the first valid minute after it:
 *     the instant the clocks jumped.
 *   * A local time that happens twice (the clocks fall back over it) fires on the first one.
 *
 * Offsets are read from the runtime's IANA database through Intl, so nothing here carries its own zone data.
 */

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** `at` is a local date-time `YYYY-MM-DDTHH:mm`; `time` a local `HH:mm`. Both are read in the schedule's zone. */
export type ScheduleRule =
  | { kind: 'ONCE'; at: string }
  | { kind: 'DAILY'; time: string }
  | { kind: 'WEEKLY'; time: string; weekdays: Weekday[] };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Why a rule or a zone was refused; the service turns it into a 400 with this code. */
export class ScheduleRuleError extends Error {
  constructor(
    readonly code: 'SCHEDULE_RULE_INVALID' | 'SCHEDULE_TIMEZONE_INVALID',
    message: string,
  ) {
    super(message);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new ScheduleRuleError('SCHEDULE_TIMEZONE_INVALID', `"${timezone}" is not an IANA time zone.`);
    }
    formatters.set(timezone, f);
  }
  return f;
}

/** Throws SCHEDULE_TIMEZONE_INVALID unless the runtime knows this zone. */
export function assertTimezone(timezone: string): void {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new ScheduleRuleError('SCHEDULE_TIMEZONE_INVALID', 'A schedule needs an IANA time zone.');
  }
  formatter(timezone);
}

/** The wall clock in `timezone` at instant `t`, as if it were UTC (ms). */
function wallClock(t: number, timezone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(t))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The zone's offset from UTC at instant `t`, in ms (east positive). */
export function offsetAt(t: number, timezone: string): number {
  const whole = Math.floor(t / 1000) * 1000;
  return wallClock(whole, timezone) - whole;
}

/**
 * The instant a local wall-clock time (given as if it were UTC, ms) happens in `timezone`: the earlier of two when
 * it happens twice, and the instant the clocks jumped when it does not happen at all.
 */
export function instantOfLocal(local: number, timezone: string): number {
  const offsets = new Set([offsetAt(local - DAY, timezone), offsetAt(local, timezone), offsetAt(local + DAY, timezone)]);
  const valid = [...offsets].map((o) => local - o).filter((t) => offsetAt(t, timezone) === local - t);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the clocks jumped over this time. The first valid local minute after it is the jump itself, which lies
  // between the instant the time would have been under the later offset and under the earlier one.
  const before = offsetAt(local - DAY, timezone);
  let lo = local - Math.max(...offsets); // still on the earlier offset
  let hi = local - before; // already on the later offset
  if (offsetAt(lo, timezone) !== before) lo = hi - DAY;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, timezone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

function parseTime(time: unknown): { h: number; m: number } {
  const match = typeof time === 'string' ? TIME.exec(time) : null;
  if (!match) throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', 'A rule\'s time is a local "HH:mm".');
  return { h: Number(match[1]), m: Number(match[2]) };
}

function parseLocalDateTime(at: unknown): number {
  const match = typeof at === 'string' ? LOCAL_DATE_TIME.exec(at) : null;
  if (!match) throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', 'A ONCE rule\'s "at" is a local "YYYY-MM-DDTHH:mm".');
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(local);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', `"${at}" is not a calendar date.`);
  }
  return local;
}

/** Validates a rule as it arrives from a caller and returns it in its canonical shape. */
export function parseRule(raw: unknown): ScheduleRule {
  const rule = raw as Partial<Record<string, unknown>> | null;
  switch (rule?.kind) {
    case 'ONCE':
      parseLocalDateTime(rule.at);
      return { kind: 'ONCE', at: rule.at as string };
    case 'DAILY':
      parseTime(rule.time);
      return { kind: 'DAILY', time: rule.time as string };
    case 'WEEKLY': {
      parseTime(rule.time);
      const days = rule.weekdays;
      if (!Array.isArray(days) || days.length === 0 || days.some((d) => !WEEKDAYS.includes(d as Weekday))) {
        throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', `A WEEKLY rule names one or more of ${WEEKDAYS.join(', ')}.`);
      }
      const weekdays = WEEKDAYS.filter((d) => days.includes(d));
      return { kind: 'WEEKLY', time: rule.time as string, weekdays };
    }
    default:
      throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', 'A rule is ONCE, DAILY or WEEKLY.');
  }
}

/** How many times a week a rule fires: what the envelope's "runs per week" counts (§4). */
export function runsPerWeek(rule: ScheduleRule): number {
  switch (rule.kind) {
    case 'ONCE':
      return 1;
    case 'DAILY':
      return 7;
    case 'WEEKLY':
      return new Set(rule.weekdays).size;
  }
}

export interface SlotWindow {
  /** No slot before this instant. */
  startAt?: Date | null;
  /** No slot after this instant. */
  endAt?: Date | null;
}

/**
 * The first slot strictly after `after`, inside the window; null when the rule has none left (a ONCE rule whose slot
 * has passed, or a rule past its end).
 */
export function nextDueAt(rule: ScheduleRule, timezone: string, after: Date, window: SlotWindow = {}): Date | null {
  assertTimezone(timezone);
  const floor = Math.max(after.getTime() + 1, window.startAt ? window.startAt.getTime() : -Infinity);
  const end = window.endAt ? window.endAt.getTime() : Infinity;
  const within = (t: number) => (t >= floor && t <= end ? new Date(t) : null);

  if (rule.kind === 'ONCE') return within(instantOfLocal(parseLocalDateTime(rule.at), timezone));

  const { h, m } = parseTime(rule.time);
  const days = rule.kind === 'WEEKLY' ? new Set(rule.weekdays) : null;
  // Start from the local day before `floor`, so a slot that falls early on floor's UTC date is not skipped.
  const startLocal = new Date(wallClock(floor, timezone));
  const first = Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate()) - DAY;
  for (let i = 0; i <= 9; i++) {
    const day = first + i * DAY;
    if (days && !days.has(WEEKDAYS[(new Date(day).getUTCDay() + 6) % 7])) continue;
    const t = instantOfLocal(day + (h * 60 + m) * MINUTE, timezone);
    if (t > end) return null;
    if (t >= floor) return new Date(t);
  }
  return null;
}
