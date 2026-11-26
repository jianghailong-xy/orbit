import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/session-listing.fixtures.json';
import type { SessionFolder } from '../api';
import { sessionProjectListing, type SessionProjectSession } from './sessionProjects';

// contracts/session-listing.fixtures.json: what GET /sessions/listing answers for each case
// (src/apiserver/src/sessions/session-listing.pg.spec.ts reads it through the route). The same cases go
// through the web's own grouping here, so the server's rules and the list the web draws today are pinned
// to one answer.

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

type Row = SessionProjectSession & { activity?: string };

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
});

const at = (iso: string | null | undefined) => Date.parse(iso ?? '');

/** The order GET /sessions hands the list in: Pinned first (Open), listedAt, then createdAt, descending; then id. */
const serverOrder = (view: string) => (a: Row, b: Row) =>
  (view === 'open' ? Number(!!b.pinnedAt) - Number(!!a.pinnedAt) : 0)
  || at(b.listedAt ?? b.createdAt) - at(a.listedAt ?? a.createdAt)
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
          needsYou: (s) => s.activity === 'needsYou',
          motion: (s) => s.activity === 'running' ? 'spinner' : s.activity === 'jobs' ? 'pulse' : null,
          line: () => ({ text: '', tone: 'preview' }),
        });
        expect(listing.folders.map((f) => ({
          folderId: f.folder.id, rowCount: f.sessionCount, needsYou: f.needsYou, running: f.running, jobs: f.jobs,
        }))).toEqual(read.expected.folders ?? []);
        expect(listing.entries.map((entry) => entry.kind === 'project'
          ? {
              kind: 'project',
              id: entry.projectId,
              coordinator: entry.coordinator?.id ?? null,
              memberCount: entry.members.length,
              placedAt: entry.listedAt,
              spokeAt: entry.lastTurnAt,
            }
          : { kind: 'session', id: entry.id })).toEqual(read.expected.entries);
      });
    }
  }
});
