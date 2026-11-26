import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/session-listing.fixtures.json';
import type { SessionFolder } from '../api';
import {
  listingRowIsWorking, listingRowNeedsOwner, type ListingRowFacts,
} from '../../../apiserver/src/sessions/session-listing';
import { sessionIsWorking, sessionNeedsOwner, sessionTimeSections } from './sessionGrouping';
import { sessionProjectListing, type SessionProjectSession } from './sessionProjects';

// contracts/session-listing.fixtures.json: what GET /sessions/listing answers for each case
// (src/apiserver/src/sessions/session-listing.pg.spec.ts reads it through the route). The same cases go
// through the web's own grouping here, so the server's rules and the list the web draws today are pinned
// to one answer. In Open that is the order the column draws: sessionTimeSections' sections (Pinned, Needs you,
// Working, then the days), flattened.

interface FixtureSession {
  id: string;
  workspace?: string;
  lifecycle?: string;
  folder?: string;
  project?: string;
  role?: string;
  activity?: string;
  pinnedAt?: string;
  listedAt?: string;
  createdAt?: string;
  lastTurnAt?: string;
  completedAt?: string;
  archivedAt?: string;
}
interface Read {
  view: string;
  folderId: string | null;
  expected: {
    folders: Array<{ folderId: string; rowCount: number; needsYou: number; running: boolean; jobs: boolean }> | null;
    entries: Array<Record<string, unknown>>;
  };
}
interface Case {
  name: string;
  folders: Array<{ id: string; name: string }>;
  sessions: FixtureSession[];
  reads: Read[];
}

type Row = SessionProjectSession & {
  activity?: string; pendingApprovals?: number; completedAt?: string | null; archivedAt?: string | null;
  status?: string; phase?: string; released?: boolean;
};
const ROWS = fixture.rows as unknown as Record<string, { status: string; phase: string; released: boolean; pendingApprovals: number }>;

const row = (s: FixtureSession): Row => ({
  id: s.id,
  title: s.id,
  folderId: s.folder ?? null,
  pinnedAt: s.pinnedAt ?? null,
  listedAt: s.listedAt ?? null,
  createdAt: s.createdAt ?? fixture.defaultCreatedAt,
  lastTurnAt: s.lastTurnAt ?? null,
  workspace: { id: s.workspace ?? 'here' },
  projectMembership: s.project
    ? { projectId: s.project, projectTitle: s.project, projectStatus: 'IN_PROGRESS', role: s.role ?? 'TASK' } as Row['projectMembership']
    : null,
  activity: s.activity,
  // What the server's row carries for its activity (the pg spec holds the route to it); a Completed one is released.
  ...((s.lifecycle ?? 'open') === 'open'
    ? ROWS[s.activity ?? 'none']
    : { status: 'SUCCEEDED', phase: 'IDLE', released: true, pendingApprovals: 0 }),
  completedAt: s.lifecycle === 'completed' && !s.archivedAt ? (s.completedAt ?? s.listedAt ?? null) : null,
  archivedAt: s.archivedAt ?? null,
});

const at = (iso: string | null | undefined) => Date.parse(iso ?? '');

/** The order GET /sessions hands the list in, then id: Open, Pinned first, then listedAt and createdAt, descending;
 *  Completed, COALESCE(completedAt, archivedAt) and createdAt, descending, with no Pinned. */
const serverOrder = (view: string) => (a: Row, b: Row) =>
  (view === 'open'
    ? Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || at(b.listedAt ?? b.createdAt) - at(a.listedAt ?? a.createdAt)
    : at(b.completedAt ?? b.archivedAt) - at(a.completedAt ?? a.archivedAt))
  || at(b.createdAt) - at(a.createdAt)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe('session listing fixture (contracts/session-listing.fixtures.json)', () => {
  for (const c of fixture.cases as Case[]) {
    for (const read of c.reads) {
      it(`${c.name} — ${read.view}${read.folderId ? ` in ${read.folderId}` : ''}`, () => {
        const all = c.sessions.map(row);
        const listed = all
          .filter((s, i) => (c.sessions[i].workspace ?? 'here') === 'here' && (c.sessions[i].lifecycle ?? 'open') === read.view)
          .sort(serverOrder(read.view));
        // What GET /sessions/project-placement hands the web: each project's coordinator, wherever and
        // in whichever lifecycle it is.
        const coordinators = all.filter((s) => s.projectMembership?.role === 'COORDINATOR');
        const folders: SessionFolder[] = c.folders.map((f) => ({ ...f, workspaceId: 'here' }));
        const listing = sessionProjectListing(listed, folders, [], {
          view: read.view as 'open' | 'completed',
          byTag: false,
          folderId: read.folderId,
          coordinators,
          workspaceId: 'here',
          needsYou: (s) => (s.pendingApprovals ?? 0) > 0,
          motion: (s) => s.activity === 'running' ? 'spinner' : s.activity === 'jobs' ? 'pulse' : null,
          // sessionLine: a row somebody waits on reads in the approval tone, which is what lights a project row.
          line: (s) => ({ text: '', tone: (s.pendingApprovals ?? 0) > 0 ? 'approval' : 'preview' }),
        });
        expect(listing.folders.map((f) => ({
          folderId: f.folder.id, rowCount: f.sessionCount, needsYou: f.needsYou, running: f.running, jobs: f.jobs,
        }))).toEqual(read.expected.folders ?? []);
        // The order the column draws: in Open its sections flattened, in Completed the listing's own.
        const drawn = read.view === 'open'
          ? sessionTimeSections(listing.entries, { pinnedFirst: true, attention: true }).flatMap((section) => section.sessions)
          : listing.entries;
        expect(drawn.map((entry) => entry.kind === 'project'
          ? {
              kind: 'project',
              id: entry.projectId,
              coordinator: entry.coordinator?.id ?? null,
              memberCount: entry.members.length,
              placedAt: entry.listedAt,
              spokeAt: entry.lastTurnAt,
              running: entry.running,
              jobs: entry.jobs,
            }
          : { kind: 'session', id: entry.id })).toEqual(read.expected.entries);
      });
    }
  }
});

// session-listing.ts ports sessionNeedsOwner and sessionIsWorking for the server's order; every combination of the
// fields they read answers the same on both sides.
describe('the server reads a row into the attention sections as sessionGrouping.ts does', () => {
  const phases = [undefined, null, 'IDLE', 'RUNNING', 'PENDING', 'LATER'];
  const statuses = [undefined, 'AWAITING_INPUT', 'RUNNING', 'PENDING', 'QUEUED', 'FAILED', 'CANCELLED', 'SUCCEEDED'];
  const released = [undefined, null, true, false];
  const outcomes = [undefined, null, 'FAILED', 'ANSWERED', 'INTERRUPTED'];
  const endReasons = [undefined, null, '', 'user'];
  const retries = [undefined, null, '2026-11-26T00:00:00.000Z'];
  const approvals = [undefined, null, 0, 1];
  it('over every combination', () => {
    let n = 0;
    for (const phase of phases) for (const status of statuses) for (const rel of released) for (const lastTurnOutcome of outcomes)
      for (const endReason of endReasons) for (const retryAt of retries) for (const pendingApprovals of approvals) {
        const facts = { phase, status, released: rel, lastTurnOutcome, endReason, retryAt, pendingApprovals };
        const web = { id: 'x', ...facts } as Parameters<typeof sessionNeedsOwner>[0];
        expect([listingRowNeedsOwner(facts as ListingRowFacts), listingRowIsWorking(facts as ListingRowFacts)], JSON.stringify(facts))
          .toEqual([sessionNeedsOwner(web), sessionIsWorking(web)]);
        n += 1;
      }
    expect(n).toBe(phases.length * statuses.length * released.length * outcomes.length * endReasons.length * retries.length * approvals.length);
  });
});
