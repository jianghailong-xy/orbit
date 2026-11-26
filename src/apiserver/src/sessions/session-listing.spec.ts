import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildSessionListing, decodeListingCursor, encodeListingCursor, listingPage,
  type ListingCoordinator, type ListingSession,
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
}
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'contracts/session-listing.fixtures.json'), 'utf8')) as {
  defaultCreatedAt: string;
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
          }), read.expected.entries);
      assert.deepEqual(built.folders, read.expected.folders ?? []);
    });
  }
}

test('pages neither skip nor repeat entries that share a place, and a cursor round-trips', () => {
  const at = 1_700_000_000_000;
  const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
  const entries = Array.from({ length: 7 }, (_, i) => ({
    kind: 'session' as const, rank: 0 as const, id: id(i + 1), pinned: i === 0, placedAt: at, createdAt: at,
  }));
  const seen: string[] = [];
  let after = null;
  for (let pages = 0; pages < 10; pages += 1) {
    const { page, next } = listingPage(entries, after, 3);
    seen.push(...page.map((entry) => entry.id));
    if (!next) break;
    after = decodeListingCursor(next);
  }
  assert.deepEqual(seen, entries.map((entry) => entry.id));
  assert.deepEqual(decodeListingCursor(encodeListingCursor(entries[3])), {
    pinned: false, placedAt: at, rank: 0, createdAt: at, id: entries[3].id,
  });
  for (const bad of ['', 'x', '1.2.3.4', '2.1.0.1.abc', '0.1.0.1.!!', '0.NaN.0.1.abc']) {
    assert.throws(() => decodeListingCursor(bad), /after is not a cursor/, bad);
  }
});
