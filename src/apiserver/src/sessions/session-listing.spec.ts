import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildSessionListing, compareListingKeys, decodeListingCursor, encodeListingCursor, listingPage, listingRowIsWorking, listingRowNeedsOwner,
  type ListingCoordinator, type ListingRowFacts, type ListingSession,
} from './session-listing';

/**
 * session-listing.ts's rules against contracts/session-listing.fixtures.json with no database: the cases
 * session-listing.pg.spec.ts reads through the route and the web's sessionListingFixture.test.ts feeds
 * through sessionProjectListing. The pg spec is the one that proves the reads; this keeps the rules
 * themselves in the unit suite.
 */
const ROOT = path.resolve(__dirname, '../../../..');

interface FixtureSession {
  id: string; workspace?: string; lifecycle?: string; folder?: string; project?: string; role?: string;
  activity?: string; pinnedAt?: string; listedAt?: string; createdAt?: string; lastTurnAt?: string;
  completedAt?: string; archivedAt?: string;
}
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'contracts/session-listing.fixtures.json'), 'utf8')) as {
  defaultCreatedAt: string;
  rows: Record<string, ListingRowFacts>;
  cases: Array<{
    name: string;
    folders: Array<{ id: string; name: string }>;
    sessions: FixtureSession[];
    reads: Array<{
      view: 'open' | 'completed';
      folderId: string | null;
      expected: { folders: unknown[] | null; entries: Array<Record<string, unknown>> };
    }>;
  }>;
};

const date = (iso: string | undefined) => (iso ? new Date(iso) : null);

for (const c of FIXTURE.cases) {
  for (const read of c.reads) {
    test(`fixture: ${c.name} — ${read.view}${read.folderId ? ` in ${read.folderId}` : ''}`, () => {
      const session = (s: FixtureSession): ListingSession => ({
        id: s.id, folderId: s.folder ?? null, pinnedAt: date(s.pinnedAt), listedAt: date(s.listedAt),
        createdAt: new Date(s.createdAt ?? FIXTURE.defaultCreatedAt), lastTurnAt: date(s.lastTurnAt),
        projectId: s.project ?? null,
        completedAt: s.lifecycle === 'completed' ? date(s.completedAt ?? s.archivedAt ?? s.listedAt) : null,
        row: (s.lifecycle ?? 'open') === 'open' ? FIXTURE.rows[s.activity ?? 'none'] : null,
      });
      const coordinators = new Map<string, ListingCoordinator | null>(c.sessions
        .filter((s) => s.role === 'COORDINATOR')
        .map((s) => [s.project!, { ...session(s), workspaceId: s.workspace ?? 'here' }]));
      const scoped = c.sessions.filter((s) => (s.workspace ?? 'here') === 'here' && (s.lifecycle ?? 'open') === read.view);
      const having = (activity: string) => new Set(scoped.filter((s) => s.activity === activity).map((s) => s.id));
      const built = buildSessionListing({
        view: read.view,
        workspaceId: 'here',
        folderId: read.folderId,
        sessions: scoped.map(session),
        coordinators,
        folders: c.folders,
        activity: { needsYou: having('needsYou'), running: having('running'), jobs: having('jobs') },
      });
      assert.deepEqual(built.entries.map((entry) => entry.kind === 'session'
        ? { kind: 'session', id: entry.id }
        : {
            kind: 'project', id: entry.id, coordinator: entry.coordinatorId, memberCount: entry.memberCount,
            placedAt: entry.placedAtDate.toISOString(), spokeAt: entry.spokeAtDate.toISOString(),
            running: entry.running, jobs: entry.jobs,
          }), read.expected.entries);
      assert.deepEqual(built.folders, read.expected.folders ?? []);
    });
  }
}

test('pages neither skip nor repeat entries that share a place, and a cursor round-trips', () => {
  const at = 1_700_000_000_000;
  const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
  const entries = Array.from({ length: 7 }, (_, i) => ({
    kind: 'session' as const, order: 'placed' as const, rank: 0 as const, id: id(i + 1),
    section: (i < 4 ? i : 3) as 0 | 1 | 2 | 3, placedAt: at, createdAt: at,
  }));
  const seen: string[] = [];
  let after = null;
  for (let pages = 0; pages < 10; pages += 1) {
    const { page, next } = listingPage(entries, after, 3, 'placed');
    seen.push(...page.map((entry) => entry.id));
    if (!next) break;
    after = decodeListingCursor(next);
  }
  assert.deepEqual(seen, entries.map((entry) => entry.id));
  assert.deepEqual(decodeListingCursor(encodeListingCursor(entries[3])), {
    order: 'placed', section: 3, placedAt: at, rank: 0, createdAt: at, id: entries[3].id,
  });
  assert.equal(decodeListingCursor(encodeListingCursor(entries[2])).section, 2, 'Working');
  // A session with neither completion clock sorts last under `completed`, and its cursor reads back.
  const last = { ...entries[2], order: 'completed' as const, section: 3 as const, placedAt: Number.NEGATIVE_INFINITY };
  assert.deepEqual(decodeListingCursor(encodeListingCursor(last)), {
    order: 'completed', section: 3, placedAt: Number.NEGATIVE_INFINITY, rank: 0, createdAt: at, id: last.id,
  });
  // Written under one order and read under the other, a cursor starts again from the top: never a mixed page.
  assert.deepEqual(listingPage(entries, last, 3, 'placed').page.map((e) => e.id), entries.slice(0, 3).map((e) => e.id));
  for (const bad of ['', 'x', 'p.1.2.3.4', 'p.4.1.0.1.abc', 'p.-1.1.0.1.abc', 'p.0.1.0.1.!!', 'p.0.NaN.0.1.abc', 'x.0.1.0.1.abc',
    'p.0.-Infinity.0.1.abc', '0.1.0.1.abc']) {
    assert.throws(() => decodeListingCursor(bad), /after is not a cursor/, bad);
  }
});

test('at the same place, Completed puts a session before a project; Open goes by createdAt as compareListed does', () => {
  const at = 1_700_000_000_000;
  const session = { order: 'placed' as const, section: 3 as const, placedAt: at, rank: 0 as const, createdAt: at - 1,
    id: '00000000-0000-7000-8000-00000000000b' };
  const project = { ...session, rank: 1 as const, createdAt: at, id: '00000000-0000-7000-8000-00000000000a' };
  assert.ok(compareListingKeys(session, project) < 0, 'placed: the session first');
  assert.ok(compareListingKeys({ ...session, order: 'sectioned' }, { ...project, order: 'sectioned' }) > 0,
    'sectioned: the project, created later, first');
  const cursor = encodeListingCursor({ ...project, order: 'sectioned', section: 1 });
  assert.ok(cursor.startsWith('s.1.'), cursor);
});

test('the attention sections read a row as sessionGrouping.ts does', () => {
  const row = (facts: ListingRowFacts) => ({ needs: listingRowNeedsOwner(facts), working: listingRowIsWorking(facts) });
  // With the phase fields: a release by a failed turn nobody ended needs you, unless a retry is armed (Working).
  assert.deepEqual(row({ phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', status: 'FAILED' }), { needs: true, working: false });
  assert.deepEqual(row({ phase: 'RUNNING', released: true, lastTurnOutcome: 'FAILED', status: 'FAILED', retryAt: new Date() }),
    { needs: false, working: true });
  // A release somebody asked for is no failure, whatever the last turn did.
  assert.deepEqual(row({ phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', endReason: 'user', status: 'CANCELLED' }),
    { needs: false, working: false });
  assert.deepEqual(row({ phase: 'PENDING', released: false, status: 'QUEUED' }), { needs: false, working: true });
  // Without them (an unknown phase reads as none), the status word decides.
  assert.deepEqual(row({ phase: 'LATER', status: 'PENDING' }), { needs: false, working: true });
  assert.deepEqual(row({ status: 'FAILED' }), { needs: true, working: false });
  assert.deepEqual(row({ status: 'AWAITING_INPUT', pendingApprovals: 2 }), { needs: true, working: false });
});
