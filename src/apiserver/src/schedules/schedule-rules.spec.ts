/**
 * The two pure rules under scheduled tasks: when a schedule fires next (schedule-time.ts, design §5.1) and how the
 * envelope judges a change (schedule-envelope.ts, design §4).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeEnvelopeChange, widenedParts, type Envelope } from './schedule-envelope';
import { instantOfLocal, nextDueAt, parseRule, runsPerWeek } from './schedule-time';

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
  assert.throws(() => parseRule({ kind: 'CRON', expr: '* * * * *' }), /ONCE, DAILY or WEEKLY/);
  assert.throws(() => nextDueAt(parseRule({ kind: 'DAILY', time: '10:00' }), 'Mars/Olympus', new Date()), /IANA/);
});

test('runsPerWeek: ONCE 1, DAILY 7, WEEKLY the number of its weekdays', () => {
  assert.equal(runsPerWeek(parseRule({ kind: 'ONCE', at: '2026-11-20T10:00' })), 1);
  assert.equal(runsPerWeek(parseRule({ kind: 'DAILY', time: '10:00' })), 7);
  assert.equal(runsPerWeek(parseRule({ kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'WED', 'WED'] })), 2);
});

const env = (over: Partial<Envelope> = {}): Envelope => ({
  workspaceId: 'w1', accessLevel: 'CHECK_ONLY', runsPerWeek: 7, runLimitMinutes: 30, ...over,
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
