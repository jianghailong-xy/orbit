/**
 * The two pure rules under scheduled tasks: when a schedule fires next (schedule-time.ts, design §5.1) and how the
 * envelope judges a change (schedule-envelope.ts, design §4).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeEnvelopeChange, widenedParts, type Envelope } from './schedule-envelope';
import { instantOfLocal, mergeRule, nextDueAt, parseRule, ruleCommandHash, runsPerWeek, type ScheduleRule } from './schedule-time';

const iso = (d: Date | null) => d?.toISOString() ?? null;

test('nextDueAt: a daily slot stays at its local time across the spring-forward change', () => {
  const rule = parseRule({ kind: 'DAILY', time: '10:00' });
  // New York: EST (UTC-5) before 2026-03-08, EDT (UTC-4) from it.
  assert.equal(iso(nextDueAt(rule, 'America/New_York', new Date('2026-03-07T16:00:00Z'))), '2026-03-08T14:00:00.000Z');
  assert.equal(iso(nextDueAt(rule, 'America/New_York', new Date('2026-03-06T16:00:00Z'))), '2026-03-07T15:00:00.000Z');
});

test('nextDueAt: a local time the clocks skip moves to the first valid minute after it', () => {
  const rule = parseRule({ kind: 'DAILY', time: '02:30' });
  assert.equal(iso(nextDueAt(rule, 'America/New_York', new Date('2026-03-07T12:00:00Z'))), '2026-03-08T07:00:00.000Z');
  // Europe/Berlin, 2026-03-29: 02:00 CET jumps to 03:00 CEST.
  assert.equal(iso(nextDueAt(rule, 'Europe/Berlin', new Date('2026-03-28T12:00:00Z'))), '2026-03-29T01:00:00.000Z');
  // The day after, 02:30 exists again.
  assert.equal(iso(nextDueAt(rule, 'Europe/Berlin', new Date('2026-03-29T12:00:00Z'))), '2026-03-30T00:30:00.000Z');
});

test('nextDueAt: a local time that happens twice fires on the first one', () => {
  const rule = parseRule({ kind: 'DAILY', time: '01:30' });
  assert.equal(iso(nextDueAt(rule, 'America/New_York', new Date('2026-10-31T12:00:00Z'))), '2026-11-01T05:30:00.000Z');
  // And it is not fired again on the second one.
  assert.equal(iso(nextDueAt(rule, 'America/New_York', new Date('2026-11-01T05:30:00Z'))), '2026-11-02T06:30:00.000Z');
  assert.equal(iso(nextDueAt(parseRule({ kind: 'DAILY', time: '02:30' }), 'Europe/Berlin', new Date('2026-10-24T12:00:00Z'))), '2026-10-25T00:30:00.000Z');
});

test('nextDueAt: strictly after the moment, inside start and end, WEEKLY on its weekdays, ONCE once', () => {
  const daily = parseRule({ kind: 'DAILY', time: '10:00' });
  // Exactly at a slot: the next one.
  assert.equal(iso(nextDueAt(daily, 'Asia/Shanghai', new Date('2026-11-15T02:00:00Z'))), '2026-11-16T02:00:00.000Z');
  assert.equal(iso(nextDueAt(daily, 'Asia/Shanghai', new Date('2026-11-15T01:59:00Z'))), '2026-11-15T02:00:00.000Z');
  assert.equal(
    iso(nextDueAt(daily, 'Asia/Shanghai', new Date('2026-11-14T00:00:00Z'), { startAt: new Date('2026-11-20T00:00:00Z') })),
    '2026-11-20T02:00:00.000Z',
  );
  assert.equal(nextDueAt(daily, 'Asia/Shanghai', new Date('2026-11-14T03:00:00Z'), { endAt: new Date('2026-11-15T01:00:00Z') }), null);
  // 2026-11-14 is a Saturday.
  const weekly = parseRule({ kind: 'WEEKLY', time: '09:00', weekdays: ['FRI', 'MON'] });
  assert.deepEqual(weekly, { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'FRI'] });
  assert.equal(iso(nextDueAt(weekly, 'UTC', new Date('2026-11-14T12:00:00Z'))), '2026-11-16T09:00:00.000Z');
  assert.equal(iso(nextDueAt(weekly, 'UTC', new Date('2026-11-16T09:00:00Z'))), '2026-11-20T09:00:00.000Z');
  const once = parseRule({ kind: 'ONCE', at: '2026-11-14T18:00' });
  assert.equal(iso(nextDueAt(once, 'Asia/Shanghai', new Date('2026-11-14T08:00:00Z'))), '2026-11-14T10:00:00.000Z');
  assert.equal(nextDueAt(once, 'Asia/Shanghai', new Date('2026-11-14T10:00:00Z')), null);
  // Across a date line: the local day differs from the UTC one.
  assert.equal(iso(nextDueAt(parseRule({ kind: 'DAILY', time: '07:00' }), 'Pacific/Auckland', new Date('2026-11-14T17:00:00Z'))), '2026-11-14T18:00:00.000Z');
});

test('instantOfLocal and parseRule refuse what is not a rule or a zone', () => {
  assert.equal(new Date(instantOfLocal(Date.UTC(2026, 0, 1, 12, 0), 'UTC')).toISOString(), '2026-01-01T12:00:00.000Z');
  assert.throws(() => parseRule({ kind: 'DAILY', time: '24:00' }), /HH:mm/);
  assert.throws(() => parseRule({ kind: 'WEEKLY', time: '10:00', weekdays: [] }), /WEEKLY/);
  assert.throws(() => parseRule({ kind: 'ONCE', at: '2026-02-30T10:00' }), /calendar/);
  assert.throws(() => parseRule({ kind: 'CRON', expr: '* * * * *' }), /ONCE, DAILY, WEEKLY, EVERY or WHEN/);
  assert.throws(() => nextDueAt(parseRule({ kind: 'DAILY', time: '10:00' }), 'Mars/Olympus', new Date()), /IANA/);
});

test('runsPerWeek: ONCE 1, DAILY 7, WEEKLY the number of its weekdays', () => {
  assert.equal(runsPerWeek(parseRule({ kind: 'ONCE', at: '2026-11-20T10:00' })), 1);
  assert.equal(runsPerWeek(parseRule({ kind: 'DAILY', time: '10:00' })), 7);
  assert.equal(runsPerWeek(parseRule({ kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'WED', 'WED'] })), 2);
});

test('a WHEN rule: defaults written out, no slot, its runs a week, a change merged onto it, and no change of kind', () => {
  const rule = parseRule({ kind: 'WHEN', condition: { text: 'Raw used above 90%', command: 'ceph df', compare: { op: 'GT', value: 90 } } });
  assert.deepEqual(rule, {
    kind: 'WHEN', conditionId: null, runsPerWeek: 3,
    condition: {
      text: 'Raw used above 90%', command: 'ceph df', compare: { op: 'GT', value: 90 }, holdSeconds: 0, rearm: null,
      intervalSeconds: 300, unit: null, timeoutSeconds: 20, repeatSeconds: null,
    },
  });
  assert.equal(nextDueAt(rule, 'UTC', new Date()), null, 'the time worker has nothing to fire');
  assert.equal(runsPerWeek(rule), 3);
  assert.throws(() => parseRule({ ...rule, condition: { ...(rule as { condition: object }).condition, intervalSeconds: 59 } }), /intervalSeconds/);
  assert.throws(() => parseRule({ kind: 'WHEN', condition: { text: 'x', command: 'y', compare: { op: 'GT' } } }), /needs a number/);
  const merged = parseRule(mergeRule({ ...(rule as Extract<ScheduleRule, { kind: 'WHEN' }>), conditionId: 'c1' }, { kind: 'WHEN', condition: { command: 'ceph df -f json' } }));
  assert.equal(merged.kind === 'WHEN' && merged.condition.command, 'ceph df -f json');
  assert.equal(merged.kind === 'WHEN' && merged.condition.text, 'Raw used above 90%', 'what the change does not name stays');
  assert.equal(merged.kind === 'WHEN' && merged.conditionId, 'c1');
  assert.throws(() => mergeRule(rule, { kind: 'DAILY', time: '10:00' }), /cannot take a time/);
  assert.notEqual(ruleCommandHash(rule), ruleCommandHash(merged));
  assert.equal(ruleCommandHash(parseRule({ kind: 'DAILY', time: '10:00' })), null);
});

// ----- EVERY (design §3, §4, §5.1) -----

/** Every slot of `rule` from `from` up to `to`, by walking nextDueAt as the worker does. */
function slotsBetween(rule: ScheduleRule, timezone: string, from: string, to: string): Date[] {
  const out: Date[] = [];
  let at = new Date(from);
  for (;;) {
    const next = nextDueAt(rule, timezone, at);
    if (!next || next.getTime() > new Date(to).getTime()) return out;
    out.push(next);
    at = next;
  }
}

/** A slot as the schedule's zone reads it: "Mon 09:30". */
function local(t: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(t).replace(',', '');
}

const WORKDAY_HALF_HOURS = Array.from({ length: 19 }, (_, i) => {
  const m = 9 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

test('EVERY 30 from 09:00 until 18:00 on Mon-Fri: :00 and :30 inside the window on weekdays, none elsewhere', () => {
  const rule = parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  const tz = 'Asia/Shanghai';
  // Sat 2026-11-14 00:00 local through Sun 2026-11-22 23:59 local: one whole week and both weekends around it.
  const slots = slotsBetween(rule, tz, '2026-11-13T16:00:00Z', '2026-11-22T15:59:00Z');
  const expected = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].flatMap((d) => WORKDAY_HALF_HOURS.map((t) => `${d} ${t}`));
  assert.deepEqual(slots.map((t) => local(t, tz)), expected);
  assert.equal(slots.length, 95, '19 a day × 5 days');
  // The window edges: until is inclusive, nothing before time, and Friday 18:00:01 waits for Monday 09:00 (§5.1).
  assert.equal(iso(nextDueAt(rule, tz, new Date('2026-11-20T09:40:00Z'))), '2026-11-20T10:00:00.000Z', 'Fri 17:40 → 18:00');
  assert.equal(iso(nextDueAt(rule, tz, new Date('2026-11-20T10:00:01Z'))), '2026-11-23T01:00:00.000Z', 'Fri 18:00:01 → Mon 09:00');
  assert.equal(iso(nextDueAt(rule, tz, new Date('2026-11-16T00:59:00Z'))), '2026-11-16T01:00:00.000Z', 'Mon 08:59 → 09:00');
  assert.equal(iso(nextDueAt(rule, tz, new Date('2026-11-16T01:10:00Z'))), '2026-11-16T01:30:00.000Z', 'Mon 09:10 → 09:30');
  // Inside startAt / endAt like every rule.
  assert.equal(nextDueAt(rule, tz, new Date('2026-11-20T10:00:01Z'), { endAt: new Date('2026-11-22T00:00:00Z') }), null);
});

test('EVERY without until runs round the clock from time, and every day starts again at time', () => {
  const hourly = parseRule({ kind: 'EVERY', minutes: 60 });
  assert.deepEqual(hourly, { kind: 'EVERY', minutes: 60, time: '00:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] });
  const day = slotsBetween(hourly, 'UTC', '2026-11-15T23:59:00Z', '2026-11-16T23:59:00Z');
  assert.equal(day.length, 24);
  assert.equal(iso(day[0]!), '2026-11-16T00:00:00.000Z');
  assert.equal(iso(day[23]!), '2026-11-16T23:00:00.000Z');
  // "Every 3 hours from 10:00" is 10, 13, 16, 19, 22, then 10:00 the next day (§3).
  const threes = parseRule({ kind: 'EVERY', minutes: 180, time: '10:00' });
  assert.deepEqual(
    slotsBetween(threes, 'Europe/Berlin', '2026-11-15T23:00:00Z', '2026-11-17T09:00:00Z').map((t) => local(t, 'Europe/Berlin')),
    ['Mon 10:00', 'Mon 13:00', 'Mon 16:00', 'Mon 19:00', 'Mon 22:00', 'Tue 10:00'],
  );
});

test('EVERY across DST: wall-clock slots, a skipped hour moves to the jump once, a repeated hour fires once', () => {
  const tz = 'America/New_York';
  // Spring forward, Sun 2026-03-08: 02:00 EST jumps to 03:00 EDT. 02:00 and 02:30 move to 03:00 and run once there.
  const round = parseRule({ kind: 'EVERY', minutes: 30 });
  const spring = slotsBetween(round, tz, '2026-03-08T05:00:00Z', '2026-03-09T03:59:00Z'); // local Sun 00:00 EST .. 23:59 EDT
  assert.equal(spring.length, 48 - 1 - 2, 'the 00:00 slot is the starting instant itself, and that day has two runs fewer');
  assert.deepEqual(spring.slice(0, 5).map((t) => local(t, tz)), ['Sun 00:30', 'Sun 01:00', 'Sun 01:30', 'Sun 03:00', 'Sun 03:30']);
  assert.equal(iso(spring[3]!), '2026-03-08T07:00:00.000Z');
  assert.ok(spring.every((t) => t.getUTCMinutes() % 30 === 0));
  // Fall back, Sun 2026-11-01: 02:00 EDT falls back to 01:00 EST. 01:00 and 01:30 fire once, on their first occurrence.
  const fall = slotsBetween(round, tz, '2026-11-01T04:00:00Z', '2026-11-02T04:59:00Z'); // local Sun 00:00 .. 23:59
  assert.equal(fall.length, 47, '48 wall-clock slots, the 00:00 one is the starting instant itself');
  const labels = fall.map((t) => local(t, tz));
  assert.deepEqual(labels.slice(0, 4), ['Sun 00:30', 'Sun 01:00', 'Sun 01:30', 'Sun 02:00']);
  assert.equal(new Set(labels).size, labels.length, 'one slot per wall-clock time, never one per elapsed half hour');
  assert.equal(iso(fall[1]!), '2026-11-01T05:00:00.000Z', '01:00 EDT, the first occurrence');
  assert.equal(iso(fall[3]!), '2026-11-01T07:00:00.000Z', '02:00 EST, an hour of elapsed time after 01:30 EDT');

  // The project's rule on a DST transition: 09:00-18:00 Mon-Fri in Europe/London across the Sunday 2026-10-25
  // fall back and Sunday 2026-03-29 spring forward. The weekday window keeps its wall-clock slots either side.
  const work = parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  for (const [from, to, days] of [
    ['2026-10-23T00:00:00Z', '2026-10-27T00:00:00Z', ['Fri', 'Mon']], // BST Friday, GMT Monday
    ['2026-03-27T00:00:00Z', '2026-03-31T00:00:00Z', ['Fri', 'Mon']], // GMT Friday, BST Monday
  ] as const) {
    const got = slotsBetween(work, 'Europe/London', from, to);
    assert.deepEqual(got.map((t) => local(t, 'Europe/London')), days.flatMap((d) => WORKDAY_HALF_HOURS.map((x) => `${d} ${x}`)));
  }
  assert.equal(iso(nextDueAt(work, 'Europe/London', new Date('2026-10-23T17:00:01Z'))), '2026-10-26T09:00:00.000Z', 'Fri 18:00:01 BST → Mon 09:00 GMT');
  assert.equal(iso(nextDueAt(work, 'Europe/London', new Date('2026-03-27T18:00:01Z'))), '2026-03-30T08:00:00.000Z', 'Fri 18:00:01 GMT → Mon 09:00 BST');
  // A window that straddles the jump itself, on the transition day: every slot is :00 or :30 local, none repeated.
  const night = parseRule({ kind: 'EVERY', minutes: 30, time: '00:00', until: '04:00', weekdays: ['SUN'] });
  assert.deepEqual(
    slotsBetween(night, tz, '2026-11-01T03:00:00Z', '2026-11-02T03:00:00Z').map((t) => local(t, tz)),
    ['Sun 00:00', 'Sun 00:30', 'Sun 01:00', 'Sun 01:30', 'Sun 02:00', 'Sun 02:30', 'Sun 03:00', 'Sun 03:30', 'Sun 04:00'],
  );
  assert.deepEqual(
    slotsBetween(night, tz, '2026-03-08T04:00:00Z', '2026-03-09T04:00:00Z').map((t) => local(t, tz)),
    ['Sun 00:00', 'Sun 00:30', 'Sun 01:00', 'Sun 01:30', 'Sun 03:00', 'Sun 03:30', 'Sun 04:00'],
  );
});

test('EVERY: invalid minutes, until and weekdays are refused', () => {
  for (const minutes of [15, 45, 90, 1440, 0, -30, '30', null, undefined]) {
    assert.throws(() => parseRule({ kind: 'EVERY', minutes, time: '09:00' }), /minutes is one of 30, 60, 120, 180, 240, 360, 480, 720/);
  }
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '9:00' }), /HH:mm/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '09:00' }), /until is later than its time/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '08:00' }), /until is later than its time/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '22:00', until: '02:00' }), /until is later than its time/, 'never across midnight');
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '24:00' }), /HH:mm/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', weekdays: [] }), /weekdays/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', weekdays: ['MON', 'FUNDAY'] }), /weekdays/);
  assert.throws(() => parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', weekdays: 'MON' }), /weekdays/);
});

test('a written EVERY rule always has time and weekdays, in canonical order', () => {
  for (const raw of [
    { kind: 'EVERY', minutes: 60 },
    { kind: 'EVERY', minutes: 120, time: null, weekdays: null },
    { kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['FRI', 'MON', 'MON'] },
  ]) {
    const rule = parseRule(raw);
    assert.equal(rule.kind, 'EVERY');
    const written = JSON.parse(JSON.stringify(rule)) as Record<string, unknown>;
    assert.match(String(written.time), /^\d\d:\d\d$/, 'shipped Apple clients throw without time');
    assert.ok(Array.isArray(written.weekdays) && written.weekdays.length > 0, 'shipped clients read it as weekly on weekdays');
  }
  assert.deepEqual(
    parseRule({ kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['FRI', 'MON', 'MON'] }),
    { kind: 'EVERY', minutes: 30, time: '09:00', until: '18:00', weekdays: ['MON', 'FRI'] },
  );
  // Parsing a written rule again gives the same rule: what the worker reads back is what was written.
  const rule = parseRule({ kind: 'EVERY', minutes: 240, time: '06:00' });
  assert.deepEqual(parseRule(JSON.parse(JSON.stringify(rule))), rule);
  // A timed schedule may change to EVERY and back.
  assert.deepEqual(parseRule(mergeRule(parseRule({ kind: 'DAILY', time: '10:00' }), { kind: 'EVERY', minutes: 60 })).kind, 'EVERY');
});

test('runsPerWeek(EVERY) is slots per day × distinct weekdays', () => {
  const r = (raw: object) => runsPerWeek(parseRule({ kind: 'EVERY', ...raw }));
  assert.equal(r({ minutes: 30, time: '09:00', until: '18:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }), 95, '19 × 5');
  assert.equal(r({ minutes: 60 }), 168, '24 × 7');
  assert.equal(r({ minutes: 30 }), 336, '48 × 7');
  assert.equal(r({ minutes: 720, time: '09:00' }), 14, '2 × 7');
  assert.equal(r({ minutes: 180, time: '10:00' }), 35, '10, 13, 16, 19, 22 × 7');
  assert.equal(r({ minutes: 60, time: '09:00', until: '17:30', weekdays: ['SAT', 'SUN', 'SAT'] }), 18, '9 × 2');
});

const env = (over: Partial<Envelope> = {}): Envelope => ({
  workspaceId: 'w1', accessLevel: 'CHECK_ONLY', runsPerWeek: 7, runLimitMinutes: 30, ...over,
});

test('envelope: a WHEN rule\'s command other than the approved one widens it; the same one is inside', () => {
  assert.deepEqual(widenedParts(env({ commandHash: 'a' }), env({ commandHash: 'b' })), ['PROBE_COMMAND']);
  assert.deepEqual(widenedParts(env({ commandHash: 'a' }), env({ commandHash: 'a' })), []);
  assert.deepEqual(widenedParts(env(), env({ commandHash: null })), [], 'a timed schedule has no command');
  const judged = judgeEnvelopeChange(env({ commandHash: 'a' }), env({ commandHash: 'a' }), env({ commandHash: 'b' }), 'SESSION');
  assert.equal(judged.inside, false);
  assert.equal(judged.next.commandHash, 'b', 'Allow approves the new command');
});

test('envelope: each of the four parts widens, and narrower values are inside', () => {
  assert.deepEqual(widenedParts(env(), env({ workspaceId: 'w2' })), ['WORKSPACE']);
  assert.deepEqual(widenedParts(env(), env({ accessLevel: 'OPEN_PR' })), ['ACCESS_LEVEL']);
  assert.deepEqual(widenedParts(env({ runsPerWeek: 1 }), env()), ['RUNS_PER_WEEK']);
  assert.deepEqual(widenedParts(env(), env({ runLimitMinutes: 31 })), ['RUN_LIMIT']);
  assert.deepEqual(widenedParts(env({ accessLevel: 'OPEN_PR' }), env({ runsPerWeek: 1, runLimitMinutes: 10 })), []);
});

test('envelope: a person narrows it, a run does not, and only the parts the change narrowed', () => {
  const wide = env({ accessLevel: 'OPEN_PR' });
  const person = judgeEnvelopeChange(wide, wide, env({ runsPerWeek: 1 }), 'SESSION');
  assert.equal(person.inside, true);
  assert.deepEqual(person.next, env({ runsPerWeek: 1 }));
  const run = judgeEnvelopeChange(wide, wide, env({ runsPerWeek: 1 }), 'RUN');
  assert.deepEqual(run.next, wide);
  // The schedule already runs once a week under a 7-a-week envelope: a prompt-only change shrinks nothing.
  const untouched = judgeEnvelopeChange(wide, env({ runsPerWeek: 1, accessLevel: 'OPEN_PR' }), env({ runsPerWeek: 1, accessLevel: 'OPEN_PR' }), 'SESSION');
  assert.deepEqual(untouched.next, wide);
  // Outside: on Allow the widened part takes what is needed, a narrowed one shrinks.
  const mixed = judgeEnvelopeChange(env(), env(), env({ runLimitMinutes: 60, runsPerWeek: 2 }), 'SESSION');
  assert.equal(mixed.inside, false);
  assert.deepEqual(mixed.widens, ['RUN_LIMIT']);
  assert.deepEqual(mixed.next, env({ runLimitMinutes: 60, runsPerWeek: 2 }));
});


test('envelope order: CHECK_ONLY < OPEN_PR < LAND; widening needs Allow, narrowing is immediate', () => {
  for (const accessLevel of ['CHECK_ONLY', 'OPEN_PR'] as const) {
    assert.deepEqual(widenedParts(env({ accessLevel }), env({ accessLevel: 'LAND' })), ['ACCESS_LEVEL']);
    assert.equal(judgeEnvelopeChange(env({ accessLevel }), env({ accessLevel }), env({ accessLevel: 'LAND' }), 'SESSION').inside, false);
    assert.equal(judgeEnvelopeChange(env({ accessLevel: 'LAND' }), env({ accessLevel: 'LAND' }), env({ accessLevel }), 'SESSION').inside, true);
  }
});
