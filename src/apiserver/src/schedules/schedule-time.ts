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

import { createHash } from 'node:crypto';

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WHEN_COMPARE_OPS = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'EXIT_ZERO'] as const;
export type WhenCompareOp = (typeof WHEN_COMPARE_OPS)[number];

/**
 * A WHEN rule's condition (docs/condition-triggers-design.md §3, §8): the probe the owner approves on the card and the
 * comparison its readings are held to. The schedule's rule carries it, so a change to it is a revision like any other
 * and Undo puts it back; the Condition row (conditions/) is kept equal to it by SchedulesService.
 */
export interface WhenCondition {
  /** The condition in words, written by the agent: "Raw used above 90%". */
  text: string;
  command: string;
  compare: { op: WhenCompareOp; value: number | null };
  holdSeconds: number;
  rearm: { op: WhenCompareOp; value: number | null } | null;
  intervalSeconds: number;
  unit: string | null;
  timeoutSeconds: number;
  /**
   * Fire again every this many seconds while it still holds and has not re-armed (§5.1); null fires on the crossing
   * only. Absent on a rule stored before it existed, which reads as null.
   */
  repeatSeconds?: number | null;
}

/**
 * `at` is a local date-time `YYYY-MM-DDTHH:mm`; `time` a local `HH:mm`. Both are read in the schedule's zone.
 * A WHEN rule has no time at all: its runs start when its condition fires. `conditionId` is null only on a create
 * card, before the owner's Create writes the condition; `runsPerWeek` is what its Costs line and envelope count.
 */
export type ScheduleRule =
  | { kind: 'ONCE'; at: string }
  | { kind: 'DAILY'; time: string }
  | { kind: 'WEEKLY'; time: string; weekdays: Weekday[] }
  /**
   * Sub-daily (§3, §5.1): slots at `time`, `time + minutes`, … on the local wall clock, through `until` (inclusive)
   * or 23:59, on each of `weekdays`. `time` and `weekdays` are always written out: shipped clients read an unknown
   * kind as WEEKLY and need both (§9.3).
   */
  | { kind: 'EVERY'; minutes: number; time: string; weekdays: Weekday[]; until?: string }
  | { kind: 'WHEN'; conditionId: string | null; runsPerWeek: number; condition: WhenCondition };

/** A WHEN rule's limits (§3): checked at least every 60 s, a probe timeout of 1 to 60 s, up to 7 runs a week. */
export const WHEN_MIN_INTERVAL_SECONDS = 60;
export const WHEN_DEFAULT_INTERVAL_SECONDS = 300;
export const WHEN_DEFAULT_TIMEOUT_SECONDS = 20;
export const WHEN_MAX_TIMEOUT_SECONDS = 60;
export const WHEN_DEFAULT_RUNS_PER_WEEK = 3;
export const WHEN_MAX_RUNS_PER_WEEK = 7;
/** A repeat is at least 15 minutes, and at least the interval (conditions.service.ts CONDITION_MIN_REPEAT_SECONDS). */
export const WHEN_MIN_REPEAT_SECONDS = 900;
const WHEN_MAX_SECONDS = 7 * 24 * 3600;

/** The intervals an EVERY rule may take, in minutes; each divides a day (§3). */
export const EVERY_MINUTES = [30, 60, 120, 180, 240, 360, 480, 720] as const;
/** Without `until`, an EVERY rule's window runs to the end of the day. */
const EVERY_DAY_END = 23 * 60 + 59;

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

/** How far out a sub-daily rule's suggested end is (§8.5). */
export const SUGGESTED_END_DAYS = 7;

/**
 * An EVERY create card's suggested end (§8.5): the same local time `SUGGESTED_END_DAYS` days after `now`, in
 * `timezone`, so a week across a daylight-saving change is still a week.
 */
export function suggestedEndAt(now: Date, timezone: string): Date {
  const wall = now.getTime() + offsetAt(now.getTime(), timezone);
  return new Date(instantOfLocal(wall + SUGGESTED_END_DAYS * DAY, timezone));
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
    case 'EVERY':
      return parseEveryRule(rule);
    case 'WHEN':
      return parseWhenRule(rule);
    default:
      throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', 'A rule is ONCE, DAILY, WEEKLY, EVERY or WHEN.');
  }
}

/**
 * `{ kind: 'EVERY', minutes, time?, weekdays?, until? }`: `time` defaults to 00:00 and `weekdays` to all seven, and
 * both are always written out (§3, §9.3).
 */
function parseEveryRule(rule: Partial<Record<string, unknown>>): ScheduleRule {
  const minutes = rule.minutes;
  if (typeof minutes !== 'number' || !(EVERY_MINUTES as readonly number[]).includes(minutes)) {
    throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', `An EVERY rule's minutes is one of ${EVERY_MINUTES.join(', ')}.`);
  }
  const time = rule.time === undefined || rule.time === null ? '00:00' : rule.time;
  const start = parseTime(time);
  let days = rule.weekdays;
  if (days === undefined || days === null) days = [...WEEKDAYS];
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !WEEKDAYS.includes(d as Weekday))) {
    throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', `An EVERY rule's weekdays name one or more of ${WEEKDAYS.join(', ')}.`);
  }
  const weekdays = WEEKDAYS.filter((d) => (days as unknown[]).includes(d));
  const out: ScheduleRule = { kind: 'EVERY', minutes, time: time as string, weekdays };
  if (rule.until !== undefined && rule.until !== null) {
    const end = parseTime(rule.until);
    if (end.h * 60 + end.m <= start.h * 60 + start.m) {
      throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', "An EVERY rule's until is later than its time on the same day.");
    }
    out.until = rule.until as string;
  }
  return out;
}

/** An EVERY rule's slots on one day, as minutes after local midnight: time, time + minutes, … through the window end. */
export function everySlotMinutes(rule: Extract<ScheduleRule, { kind: 'EVERY' }>): number[] {
  const { h, m } = parseTime(rule.time);
  const end = rule.until ? parseTime(rule.until) : null;
  const last = end ? end.h * 60 + end.m : EVERY_DAY_END;
  const slots: number[] = [];
  for (let t = h * 60 + m; t <= last; t += rule.minutes) slots.push(t);
  return slots;
}

function whenInvalid(message: string): never {
  throw new ScheduleRuleError('SCHEDULE_RULE_INVALID', message);
}

function wholeNumber(raw: unknown, fallback: number, min: number, max: number, what: string): number {
  const v = raw === undefined || raw === null ? fallback : raw;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) whenInvalid(`${what} is a whole number from ${min} to ${max}.`);
  return v;
}

function comparison(raw: unknown, what: string): { op: WhenCompareOp; value: number | null } {
  const c = raw as Partial<Record<string, unknown>> | null;
  if (!c || typeof c !== 'object' || !WHEN_COMPARE_OPS.includes(c.op as WhenCompareOp)) {
    whenInvalid(`A WHEN rule's ${what} is { op, value? } with op one of ${WHEN_COMPARE_OPS.join(', ')}.`);
  }
  const op = c.op as WhenCompareOp;
  if (op === 'EXIT_ZERO') return { op, value: null };
  if (typeof c.value !== 'number' || !Number.isFinite(c.value)) whenInvalid(`A WHEN rule's ${what} ${op} needs a number to compare with.`);
  return { op, value: c.value };
}

/**
 * `{ kind: 'WHEN', condition: { text, command, compare, holdSeconds?, rearm?, intervalSeconds?, unit?,
 * timeoutSeconds?, repeatSeconds? }, runsPerWeek?, conditionId? }`, with every default written out.
 */
function parseWhenRule(rule: Partial<Record<string, unknown>>): ScheduleRule {
  const c = rule.condition as Partial<Record<string, unknown>> | null | undefined;
  if (!c || typeof c !== 'object') whenInvalid('A WHEN rule carries its condition: { text, command, compare, … }.');
  if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 200) {
    whenInvalid("A WHEN rule's condition text is the condition in words, at most 200 characters.");
  }
  if (typeof c.command !== 'string' || !c.command.trim() || c.command.length > 4000) {
    whenInvalid("A WHEN rule's command is the probe's shell command, at most 4000 characters.");
  }
  if (c.unit !== undefined && c.unit !== null && (typeof c.unit !== 'string' || c.unit.length > 20)) {
    whenInvalid("A WHEN rule's unit is how a reading is shown (\"%\", \"GiB\"), at most 20 characters.");
  }
  const intervalSeconds = wholeNumber(
    c.intervalSeconds, WHEN_DEFAULT_INTERVAL_SECONDS, WHEN_MIN_INTERVAL_SECONDS, WHEN_MAX_SECONDS, 'intervalSeconds',
  );
  let repeatSeconds: number | null = null;
  if (c.repeatSeconds !== undefined && c.repeatSeconds !== null) {
    repeatSeconds = wholeNumber(c.repeatSeconds, 0, WHEN_MIN_REPEAT_SECONDS, WHEN_MAX_SECONDS, 'repeatSeconds');
    if (repeatSeconds < intervalSeconds) whenInvalid('repeatSeconds is at least the intervalSeconds it is checked at.');
  }
  const conditionId = rule.conditionId ?? null;
  if (conditionId !== null && typeof conditionId !== 'string') whenInvalid('conditionId is set by Orbit.');
  return {
    kind: 'WHEN',
    conditionId: conditionId as string | null,
    runsPerWeek: wholeNumber(rule.runsPerWeek, WHEN_DEFAULT_RUNS_PER_WEEK, 1, WHEN_MAX_RUNS_PER_WEEK, "A WHEN rule's runsPerWeek"),
    condition: {
      text: c.text.trim(),
      command: c.command.trim(),
      compare: comparison(c.compare, 'compare'),
      holdSeconds: wholeNumber(c.holdSeconds, 0, 0, WHEN_MAX_SECONDS, 'holdSeconds'),
      rearm: c.rearm === undefined || c.rearm === null ? null : comparison(c.rearm, 'rearm'),
      intervalSeconds,
      unit: typeof c.unit === 'string' && c.unit.trim() ? c.unit.trim() : null,
      timeoutSeconds: wholeNumber(c.timeoutSeconds, WHEN_DEFAULT_TIMEOUT_SECONDS, 1, WHEN_MAX_TIMEOUT_SECONDS, 'timeoutSeconds'),
      repeatSeconds,
    },
  };
}

/**
 * A change to a WHEN rule names only what it changes: `{ kind: 'WHEN', condition: { command } }` keeps the text, the
 * comparison and the rest, and the condition the schedule already has. A rule cannot change kind between WHEN and a
 * time: that is another schedule.
 */
export function mergeRule(current: ScheduleRule, raw: unknown): unknown {
  const next = raw as Partial<Record<string, unknown>> | null;
  const isWhen = next?.kind === 'WHEN';
  if ((current.kind === 'WHEN') !== isWhen) {
    throw new ScheduleRuleError(
      'SCHEDULE_RULE_INVALID',
      current.kind === 'WHEN'
        ? 'This schedule starts when its condition holds; it cannot take a time instead. End it and create a timed one.'
        : 'A timed schedule cannot take a condition instead. End it and create one with a WHEN rule.',
    );
  }
  if (current.kind !== 'WHEN') return raw;
  const condition = (next!.condition ?? {}) as Record<string, unknown>;
  return {
    kind: 'WHEN',
    conditionId: current.conditionId,
    runsPerWeek: next!.runsPerWeek ?? current.runsPerWeek,
    condition: { ...current.condition, ...condition },
  };
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
    case 'EVERY':
      return everySlotMinutes(rule).length * new Set(rule.weekdays).size;
    case 'WHEN':
      return rule.runsPerWeek;
  }
}

/**
 * What a rule puts in the envelope beside its runs a week: a WHEN rule's probe command, as the sha256 the condition
 * stores as approved (conditions.service.ts conditionCommandHash); null for a timed rule.
 */
export function ruleCommandHash(rule: ScheduleRule): string | null {
  return rule.kind === 'WHEN' ? createHash('sha256').update(rule.condition.command, 'utf8').digest('hex') : null;
}

export interface SlotWindow {
  /** No slot before this instant. */
  startAt?: Date | null;
  /** No slot after this instant. */
  endAt?: Date | null;
}

/**
 * The first slot strictly after `after`, inside the window; null when the rule has none left (a ONCE rule whose slot
 * has passed, or a rule past its end). A WHEN rule has no slots: its condition starts its runs, and the time worker
 * passes over it.
 */
export function nextDueAt(rule: ScheduleRule, timezone: string, after: Date, window: SlotWindow = {}): Date | null {
  assertTimezone(timezone);
  if (rule.kind === 'WHEN') return null;
  const floor = Math.max(after.getTime() + 1, window.startAt ? window.startAt.getTime() : -Infinity);
  const end = window.endAt ? window.endAt.getTime() : Infinity;
  const within = (t: number) => (t >= floor && t <= end ? new Date(t) : null);

  if (rule.kind === 'ONCE') return within(instantOfLocal(parseLocalDateTime(rule.at), timezone));

  // A day's slots as minutes after local midnight: one for DAILY and WEEKLY, the window's for EVERY.
  let slots: number[];
  if (rule.kind === 'EVERY') slots = everySlotMinutes(rule);
  else {
    const { h, m } = parseTime(rule.time);
    slots = [h * 60 + m];
  }
  const days = rule.kind === 'DAILY' ? null : new Set(rule.weekdays);
  // Start from the local day before `floor`, so a slot that falls early on floor's UTC date is not skipped.
  const floorLocal = wallClock(floor, timezone);
  const startLocal = new Date(floorLocal);
  const first = Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate()) - DAY;
  for (let i = 0; i <= 9; i++) {
    const day = first + i * DAY;
    if (days && !days.has(WEEKDAYS[(new Date(day).getUTCDay() + 6) % 7])) continue;
    for (const slot of slots) {
      const local = day + slot * MINUTE;
      // Far enough before floor on the wall clock that no offset change brings it after: skip without the zone.
      if (local < floorLocal - DAY / 4) continue;
      // Each slot turns into an instant as DAILY's does: a skipped time moves to the jump, a repeated one fires on
      // its first occurrence. Slots that land on the same instant are one: the next is strictly after `floor`.
      const t = instantOfLocal(local, timezone);
      if (t > end) return null;
      if (t >= floor) return new Date(t);
    }
  }
  return null;
}
