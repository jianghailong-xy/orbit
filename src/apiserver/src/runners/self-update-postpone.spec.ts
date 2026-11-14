import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postponeUntil, tomorrowNineIn } from './self-update-postpone';

// D2: a Later lasts at most until 09:00 tomorrow in the owner's zone.
test('tomorrowNineIn is 09:00 on the next calendar day in the zone, across a DST change', () => {
  // 23:30 in Shanghai on 11-12 (15:30Z): tomorrow is 11-13.
  assert.equal(tomorrowNineIn(new Date('2026-11-12T15:30:00Z'), 'Asia/Shanghai').toISOString(), '2026-11-13T01:00:00.000Z');
  // 00:30 in Shanghai on 11-13 (16:30Z on 11-12): tomorrow is 11-14.
  assert.equal(tomorrowNineIn(new Date('2026-11-12T16:30:00Z'), 'Asia/Shanghai').toISOString(), '2026-11-14T01:00:00.000Z');
  // New York, the evening before clocks go back (EDT -4 today, EST -5 tomorrow, 2026-11-01).
  assert.equal(tomorrowNineIn(new Date('2026-10-31T22:00:00-04:00'), 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  // ... and the evening before they go forward (2026-03-08).
  assert.equal(tomorrowNineIn(new Date('2026-03-07T22:00:00-05:00'), 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(tomorrowNineIn(new Date('2026-11-12T23:59:00Z'), 'UTC').toISOString(), '2026-11-13T09:00:00.000Z');
});

test('postponeUntil keeps a time within the cap, caps a later one, and refuses a bad one', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.deepEqual(postponeUntil(now, { until: '2026-11-12T11:00:00Z', timeZone: 'UTC' }),
    { until: new Date('2026-11-12T11:00:00Z'), capped: false });
  assert.deepEqual(postponeUntil(now, { until: '2026-11-20T00:00:00Z', timeZone: 'Asia/Shanghai' }),
    { until: new Date('2026-11-13T01:00:00Z'), capped: true });
  // No zone: capped in UTC.
  assert.deepEqual(postponeUntil(now, { until: '2026-11-20T00:00:00Z' }), { until: new Date('2026-11-13T09:00:00Z'), capped: true });
  assert.throws(() => postponeUntil(now, { until: '2026-11-12T09:00:00Z' }), /in the future/);
  assert.throws(() => postponeUntil(now, {}), /ISO time/);
  assert.throws(() => postponeUntil(now, undefined), /ISO time/);
  assert.throws(() => postponeUntil(now, { until: '2026-11-12T11:00:00Z', timeZone: 'Nowhere/Else' }), /IANA/);
  assert.throws(() => postponeUntil(now, { until: '2026-11-12T11:00:00Z', timeZone: 7 }), /IANA/);
});
