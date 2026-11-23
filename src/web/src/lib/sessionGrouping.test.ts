import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/session-list-order.fixtures.json';
import {
  sessionNeedsOwner,
  sessionTagSections,
  sessionTimeSections,
  sessionsWithTag,
  type SessionTagRef,
} from './sessionGrouping';

// Mirrors OrbitKitTests/SessionTimeGroupingTests so both clients are held to the same bucketing.
// Timestamps are built from *local* wall-clock parts (then serialized) so `startOfDay` boundaries
// are deterministic whatever timezone CI runs in — the Swift suite pins Calendar to UTC for the
// same reason.
const NOW = new Date(2026, 6, 8, 12, 0, 0); // 2026-07-08 12:00 local
const at = (y: number, m: number, d: number, h = 12): string =>
  new Date(y, m - 1, d, h).toISOString();

const session = (
  id: string,
  o: { listedAt?: string; createdAt?: string; pinnedAt?: string; tags?: SessionTagRef[] } = {},
) => ({ id, ...o });

const titles = (s: Parameters<typeof sessionTimeSections>[0]) =>
  sessionTimeSections(s, { now: NOW }).map((x) => x.title);

describe('sessionTimeSections', () => {
  it('buckets by calendar day', () => {
    const out = sessionTimeSections(
      [
        session('today', { listedAt: at(2026, 7, 8, 9) }),
        session('yesterday', { listedAt: at(2026, 7, 7, 23) }),
        session('prev7', { listedAt: at(2026, 7, 5) }), // 3 days
        session('prev30', { listedAt: at(2026, 6, 18) }), // 20 days
        session('older', { listedAt: at(2026, 5, 9) }), // 60 days
      ],
      { now: NOW },
    );
    expect(out.map((s) => s.title)).toEqual([
      'Today',
      'Yesterday',
      '2–7 days ago',
      '8–30 days ago',
      'Older',
    ]);
    expect(out.map((s) => s.sessions.map((x) => x.id))).toEqual([
      ['today'],
      ['yesterday'],
      ['prev7'],
      ['prev30'],
      ['older'],
    ]);
  });

  it('lifts pinned sessions to a leading section regardless of date', () => {
    const out = sessionTimeSections(
      [
        session('pin-old', { listedAt: at(2026, 5, 1), pinnedAt: at(2026, 1, 1) }),
        session('today', { listedAt: at(2026, 7, 8, 9) }),
      ],
      { now: NOW },
    );
    expect(out.map((s) => s.title)).toEqual(['Pinned', 'Today']);
    expect(out[0].sessions.map((s) => s.id)).toEqual(['pin-old']);
  });

  it('buckets pinned by time when pinnedFirst is off', () => {
    // Completed/Trash: a stale pinnedAt must NOT spawn a "Pinned" section.
    const s = [session('pin', { listedAt: at(2026, 7, 8, 9), pinnedAt: at(2026, 1, 1) })];
    expect(sessionTimeSections(s, { pinnedFirst: false, now: NOW }).map((x) => x.title)).toEqual([
      'Today',
    ]);
  });

  it('drops empty buckets', () => {
    expect(titles([session('a', { listedAt: at(2026, 7, 8, 8) })])).toEqual(['Today']);
  });

  it('preserves order within a bucket', () => {
    // Input is already recency-sorted; the bucket must keep that order.
    const out = sessionTimeSections(
      [
        session('newer', { listedAt: at(2026, 7, 8, 11) }),
        session('older', { listedAt: at(2026, 7, 8, 7) }),
      ],
      { now: NOW },
    );
    expect(out[0].sessions.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('falls back to createdAt, then to Older', () => {
    expect(titles([session('queued', { createdAt: at(2026, 7, 8, 6) })])).toEqual(['Today']);
    expect(titles([session('ghost')])).toEqual(['Older']);
    expect(titles([session('bad', { listedAt: 'not-a-date' })])).toEqual(['Older']);
  });

  it('puts a future timestamp in Today', () => {
    expect(titles([session('skew', { listedAt: at(2026, 7, 20) })])).toEqual(['Today']);
  });

  it('splits on the 7- and 30-day boundaries', () => {
    expect(
      titles([
        session('d7', { listedAt: at(2026, 7, 1) }), // exactly 7 days → 2–7 days ago
        session('d8', { listedAt: at(2026, 6, 30) }), // 8 days → 8–30 days ago
        session('d31', { listedAt: at(2026, 6, 7) }), // 31 days → Older
      ]),
    ).toEqual(['2–7 days ago', '8–30 days ago', 'Older']);
  });
});

const tag = (id: string, o: Partial<SessionTagRef> = {}): SessionTagRef => ({
  id,
  name: id,
  color: '#888888',
  isSystem: false,
  position: 0,
  ...o,
});

describe('sessionTagSections', () => {
  it('orders sections system-first, then position, then name; untagged last', () => {
    const sys = tag('sys', { isSystem: true, position: 9 });
    const p0 = tag('p0', { position: 0 });
    const p1 = tag('p1', { position: 1 });
    const out = sessionTagSections([
      session('c', { tags: [p1] }),
      session('u'),
      session('a', { tags: [sys] }),
      session('b', { tags: [p0] }),
    ]);
    expect(out.map((s) => s.tag?.id ?? null)).toEqual(['sys', 'p0', 'p1', null]);
    expect(out[3].sessions.map((s) => s.id)).toEqual(['u']);
  });

  it('files a multi-tag session under its primary tag only', () => {
    const out = sessionTagSections([session('m', { tags: [tag('first'), tag('second')] })]);
    expect(out).toHaveLength(1);
    expect(out[0].tag?.id).toBe('first');
  });

  it('keeps input order within a section and omits Untagged when every session is tagged', () => {
    const t = tag('t');
    const out = sessionTagSections([session('1', { tags: [t] }), session('2', { tags: [t] })]);
    expect(out).toHaveLength(1);
    expect(out[0].sessions.map((s) => s.id)).toEqual(['1', '2']);
  });
});

describe('sessionsWithTag', () => {
  it('matches a non-primary tag too', () => {
    const s = [
      session('m', { tags: [tag('a'), tag('b')] }),
      session('n', { tags: [tag('a')] }),
      session('u'),
    ];
    expect(sessionsWithTag(s, 'b').map((x) => x.id)).toEqual(['m']);
    expect(sessionsWithTag(s, 'a').map((x) => x.id)).toEqual(['m', 'n']);
  });
});

// The shared contract every client is tested against (contracts/session-list-order.fixtures.json).
// The fixture is stated in UTC, so the day buckets are computed in UTC here.
process.env.TZ = 'UTC';

describe('session list order fixture', () => {
  const open = fixture.sessions.filter((s) => !s.completedAt && !s.deletedAt);
  const sections = (rows: typeof open) =>
    sessionTimeSections(rows, { pinnedFirst: true, attention: true, now: new Date(fixture.now) });
  const shape = (rows: typeof open) => sections(rows).map((s) => ({ section: s.title, ids: s.sessions.map((x) => x.id) }));

  it('groups and orders the Open list as the fixture expects', () => {
    expect(shape(open)).toEqual(fixture.expected);
    expect(fixture.expected.map((e) => e.section)).toEqual(
      fixture.sectionTitles.filter((t) => fixture.expected.some((e) => e.section === t)),
    );
  });

  it('gives the same sections whatever order the rows arrive in', () => {
    expect(shape([...open].reverse())).toEqual(fixture.expected);
  });

  it('derives needsOwner as the fixture states it', () => {
    for (const s of open) expect(sessionNeedsOwner(s), s.id).toBe(s.needsOwner);
  });

  it('never moves a row for activity alone (lastTurnAt, status text, pending preview)', () => {
    // Every row streams: lastTurnAt jumps to now, and a preview-only field changes. listedAt,
    // pinnedAt, status and approvals — the things that mean something to the owner — stay put.
    const busy = open.map((s, i) => ({
      ...s,
      lastTurnAt: new Date(Date.parse(fixture.now) + (i + 1) * 1000).toISOString(),
      lastAssistantText: `streaming ${i}`,
    }));
    expect(shape(busy)).toEqual(fixture.expected);
    const quiet = open.map((s) => ({ ...s, lastTurnAt: null }));
    expect(shape(quiet)).toEqual(fixture.expected);
  });

  it('moves a row when its listedAt moves: a turn that ends on the owner lands in Needs you', () => {
    const asked = open.map((s) => (s.id === 'work-ci' ? { ...s, pendingApprovals: 1, listedAt: fixture.now } : s));
    const out = shape(asked);
    expect(out.find((s) => s.section === 'Needs you')?.ids[0]).toBe('work-ci');
    expect(out.find((s) => s.section === 'Working')?.ids).not.toContain('work-ci');
  });
});
