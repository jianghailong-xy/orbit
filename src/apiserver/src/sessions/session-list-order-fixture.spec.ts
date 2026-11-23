import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * contracts/session-list-order.fixtures.json is what the web, Apple and Android session lists are each tested
 * against. This holds the fixture to its own documented rule with a reference implementation, so a vector edited
 * out of step with the rule is caught here rather than by three clients disagreeing.
 */
const ROOT = path.resolve(__dirname, '../../../..');

interface Row {
  id: string; status: string; pinnedAt: string | null; pendingApprovals: number; retryAt: string | null;
  completedAt: string | null; deletedAt: string | null; needsOwner: boolean;
  listedAt: string | null; lastTurnAt: string | null; createdAt: string;
}
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'contracts/session-list-order.fixtures.json'), 'utf8')) as {
  rule: string[]; sectionTitles: string[]; now: string; timeZone: string; sessions: Row[];
  expected: Array<{ section: string; ids: string[] }>;
};

const DATE_TITLES = ['Today', 'Yesterday', '2–7 days ago', '8–30 days ago', 'Older'];
const needsOwner = (s: Row) => s.pendingApprovals > 0 || (s.status === 'FAILED' && s.retryAt == null);
const working = (s: Row) => s.status === 'RUNNING' || s.status === 'PENDING' || (s.status === 'FAILED' && s.retryAt != null);
const listed = (s: Row) => Date.parse(s.listedAt ?? s.createdAt);
// Calendar days in UTC, the fixture's time zone.
const day = (ms: number) => Math.floor(ms / 86_400_000);

function sections(rows: Row[], now: Date) {
  const out = new Map<string, Row[]>(FIXTURE.sectionTitles.map((t) => [t, []]));
  for (const s of rows) {
    if (s.completedAt || s.deletedAt) continue;
    let title: string;
    if (s.pinnedAt) title = 'Pinned';
    else if (needsOwner(s)) title = 'Needs you';
    else if (working(s)) title = 'Working';
    else {
      const back = day(now.getTime()) - day(listed(s));
      title = DATE_TITLES[back <= 0 ? 0 : back === 1 ? 1 : back <= 7 ? 2 : back <= 30 ? 3 : 4];
    }
    out.get(title)!.push(s);
  }
  return [...out].filter(([, list]) => list.length > 0).map(([section, list]) => ({
    section,
    ids: list
      .sort((a, b) => listed(b) - listed(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
      .map((s) => s.id),
  }));
}

test('the fixture documents its rule and covers every section', () => {
  assert.equal(FIXTURE.timeZone, 'UTC');
  assert.ok(FIXTURE.rule.length > 0);
  assert.deepEqual(FIXTURE.expected.map((e) => e.section), FIXTURE.sectionTitles);
});

test('each row\'s needsOwner flag is the one the rule derives', () => {
  for (const s of FIXTURE.sessions) assert.equal(s.needsOwner, needsOwner(s), s.id);
});

test('the expected sections and order are the rule applied to the rows', () => {
  assert.deepEqual(sections(FIXTURE.sessions, new Date(FIXTURE.now)), FIXTURE.expected);
});

test('lastTurnAt is never an order key: scrambling it changes nothing', () => {
  const scrambled = FIXTURE.sessions.map((s, i) => ({ ...s, lastTurnAt: new Date(Date.parse(FIXTURE.now) - i * 1000).toISOString() }));
  assert.deepEqual(sections(scrambled, new Date(FIXTURE.now)), FIXTURE.expected);
});
