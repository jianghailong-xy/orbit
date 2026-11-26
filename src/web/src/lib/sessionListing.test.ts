import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/session-listing.fixtures.json';
import type { SessionFolder, SessionListItem } from '../api';
import { sessionTimeSections } from './sessionGrouping';
import { sessionListingView } from './sessionListing';
import type { SessionListingEntry, SessionListingPage } from './sessionListingData';
import { sessionProjectListing, type SessionProjectEntry } from './sessionProjects';

// The list drawn from GET /sessions/listing against the list drawn from the whole Open list, case by case
// over contracts/session-listing.fixtures.json: the server's answer (`expected`, which its pg spec reads
// through the route) fed through sessionListingView, and the same sessions fed whole through
// sessionProjectListing, give the same folder rows, entries and sections — on one page or cut into many.

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
  view: 'open' | 'completed';
  folderId: string | null;
  expected: {
    folders: Array<{ folderId: string; rowCount: number; needsYou: number; running: boolean; jobs: boolean }> | null;
    entries: Array<{
      kind: string; id: string; coordinator?: string | null; memberCount?: number; placedAt?: string; spokeAt?: string;
      running?: boolean; jobs?: boolean;
    }>;
  };
}
interface Case {
  name: string;
  folders: Array<{ id: string; name: string }>;
  sessions: FixtureSession[];
  reads: Read[];
}

type Row = SessionListItem & { activity?: string };

const row = (s: FixtureSession): Row => ({
  id: s.id,
  title: s.id,
  folderId: s.folder ?? null,
  pinnedAt: s.pinnedAt ?? null,
  listedAt: s.listedAt ?? null,
  createdAt: s.createdAt ?? fixture.defaultCreatedAt,
  lastTurnAt: s.lastTurnAt ?? null,
  lifecycleState: s.lifecycle === 'completed' ? 'COMPLETED' : 'OPEN',
  workspace: { id: s.workspace ?? 'here', name: s.workspace ?? 'here' },
  projectMembership: s.project
    ? { projectId: s.project, projectTitle: s.project, projectStatus: 'OPEN', role: s.role ?? 'TASK' } as Row['projectMembership']
    : null,
  activity: s.activity,
  completedAt: s.lifecycle === 'completed' && !s.archivedAt ? (s.completedAt ?? s.listedAt ?? null) : null,
  archivedAt: s.archivedAt ?? null,
}) as Row;

const at = (iso: string | null | undefined) => Date.parse(iso ?? '');
/** GET /sessions's own order, as the fixture's web spec reads it. */
const serverOrder = (view: string) => (a: Row, b: Row) =>
  (view === 'open'
    ? Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || at(b.listedAt ?? b.createdAt) - at(a.listedAt ?? a.createdAt)
    : at(b.completedAt ?? b.archivedAt) - at(a.completedAt ?? a.archivedAt))
  || at(b.createdAt) - at(a.createdAt)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const readings = {
  needsYou: (s: Row) => s.activity === 'needsYou',
  motion: (s: Row) => s.activity === 'running' ? 'spinner' as const : s.activity === 'jobs' ? 'pulse' as const : null,
  line: (s: Row) => ({ text: s.title ?? '', tone: s.activity === 'needsYou' ? 'approval' as const : 'preview' as const }),
};

/** The server's answer for one read, cut into pages of `size` entries, its rows as GET /sessions's. */
function listingPages(c: Case, read: Read, size: number): SessionListingPage[] {
  const byId = new Map(c.sessions.map((s) => [s.id, row(s)]));
  const entries = read.expected.entries.map((entry): SessionListingEntry => entry.kind === 'session'
    ? { kind: 'session', session: byId.get(entry.id)! }
    : {
        kind: 'project',
        projectId: entry.id,
        placedAt: entry.placedAt!,
        spokeAt: entry.spokeAt!,
        memberCount: entry.memberCount!,
        running: entry.running,
        jobs: entry.jobs,
        coordinator: entry.coordinator ? byId.get(entry.coordinator)! : null,
      });
  const pages: SessionListingPage[] = [];
  for (let i = 0; i === 0 || i < entries.length; i += size) {
    pages.push({
      ...(i === 0 && read.expected.folders ? { folders: read.expected.folders } : {}),
      entries: entries.slice(i, i + size),
      next: i + size < entries.length ? `after-${i + size}` : null,
    });
  }
  return pages;
}

const shape = (entries: readonly SessionProjectEntry<Row>[]) =>
  entries.map((entry) => entry.kind === 'project'
    ? { kind: 'project', id: entry.projectId, coordinator: entry.coordinator?.id ?? null, listedAt: entry.listedAt,
        lastTurnAt: entry.lastTurnAt, pinned: !!entry.pinnedAt, needsYou: entry.needsYou, running: entry.running, jobs: entry.jobs,
        indicator: entry.indicator }
    : { kind: 'session', id: entry.id, mark: entry.projectMark?.projectId ?? null });

describe('the list drawn from GET /sessions/listing (contracts/session-listing.fixtures.json)', () => {
  for (const c of fixture.cases as Case[]) {
    for (const read of c.reads) {
      for (const size of [40, 1]) {
        it(`${c.name} — ${read.view}${read.folderId ? ` in ${read.folderId}` : ''}, ${size === 1 ? 'a page per entry' : 'one page'}`, () => {
          const all = c.sessions.map(row);
          const listed = all
            .filter((s) => s.workspace?.id === 'here' && sessionView(s) === read.view)
            .sort(serverOrder(read.view));
          const coordinators = all.filter((s) => s.projectMembership?.role === 'COORDINATOR');
          // What GET /sessions/project-placement hands both: each project's coordinator, and its members waiting on you.
          const contentSessions = all.filter((s) => s.activity === 'needsYou' && sessionView(s) === read.view);
          const folders: SessionFolder[] = c.folders.map((f) => ({ ...f, workspaceId: 'here' }));
          const opts = { view: read.view, folderId: read.folderId, workspaceId: 'here', coordinators, contentSessions, ...readings };
          const whole = sessionProjectListing(listed, folders, [], { ...opts, byTag: false });
          const paged = sessionListingView(listingPages(c, read, size), folders, [], opts);

          const folderRows = (rows: typeof whole.folders) =>
            rows.map((f) => ({ id: f.folder.id, count: f.sessionCount, needsYou: f.needsYou, running: f.running, jobs: f.jobs }));
          expect(folderRows(paged.folders)).toEqual(folderRows(whole.folders));
          // In Open the column draws the sections below, each sorted as compareListed sorts it, so the flat order is
          // the drawn one only in Completed; in Open it is the same entries, and the sections are compared next.
          const flat = (entries: readonly SessionProjectEntry<Row>[]) => read.view === 'open'
            ? shape(entries).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
            : shape(entries);
          expect(flat(paged.entries)).toEqual(flat(whole.entries));
          const sections = (entries: readonly SessionProjectEntry<Row>[]) =>
            sessionTimeSections(entries, { pinnedFirst: read.view === 'open', attention: read.view === 'open' })
              .map((s) => ({ title: s.title, ids: s.sessions.map((entry) => entry.id) }));
          expect(sections(paged.entries)).toEqual(sections(whole.entries));
        });
      }
    }
  }
});

function sessionView(s: Row): 'open' | 'completed' {
  return s.lifecycleState === 'COMPLETED' ? 'completed' : 'open';
}

describe('sessionListingView', () => {
  const base = { id: 's', title: 's', workspace: { id: 'here', name: 'here' }, createdAt: '2026-11-20T00:00:00.000Z' };
  const session = (id: string, extra: Partial<SessionListItem> = {}): SessionListItem =>
    ({ ...base, id, title: id, listedAt: '2026-11-20T10:00:00.000Z', ...extra }) as SessionListItem;
  const opts = {
    view: 'open' as const, folderId: null, workspaceId: 'here',
    needsYou: () => false, motion: () => null, line: () => ({ text: '', tone: 'preview' as const }),
  };

  it('draws every folder of the workspace in Open, one made since the read too, and none of them busy with the Runner offline', () => {
    const folders: SessionFolder[] = [
      { id: 'f2', name: 'Sprint 10', workspaceId: 'here' },
      { id: 'f1', name: 'Sprint 2', workspaceId: 'here' },
      { id: 'f3', name: 'New', workspaceId: 'here' },
    ];
    const pages: SessionListingPage[] = [{
      folders: [
        { folderId: 'f1', rowCount: 4, needsYou: 1, running: true, jobs: false },
        { folderId: 'f2', rowCount: 2, needsYou: 0, running: false, jobs: true },
        // A folder deleted since: no row.
        { folderId: 'gone', rowCount: 9, needsYou: 0, running: false, jobs: false },
      ],
      entries: [],
      next: null,
    }];
    const rows = sessionListingView(pages, folders, [], opts).folders;
    expect(rows.map((r) => [r.folder.id, r.sessionCount, r.needsYou, r.running, r.jobs])).toEqual([
      ['f3', 0, 0, false, false], ['f1', 4, 1, true, false], ['f2', 2, 0, false, true],
    ]);
    const offline = sessionListingView(pages, folders, [], { ...opts, runnerOffline: true }).folders;
    expect(offline.some((r) => r.running || r.jobs)).toBe(false);
    const completed = sessionListingView(pages, folders, [], { ...opts, view: 'completed' }).folders;
    expect(completed.map((r) => r.folder.id)).toEqual(['f1', 'f2']);
  });

  it('moves a row pinned since the read to the top of the loaded entries, and keeps the server order otherwise', () => {
    const pages: SessionListingPage[] = [
      { entries: [{ kind: 'session', session: session('a') }, { kind: 'session', session: session('b') }], next: 'n' },
      { entries: [{ kind: 'session', session: session('c', { pinnedAt: '2026-11-21T00:00:00.000Z' }) }], next: null },
    ];
    expect(sessionListingView(pages, [], [], opts).entries.map((e) => e.id)).toEqual(['c', 'a', 'b']);
    // Completed is the server's order, verbatim.
    expect(sessionListingView(pages, [], [], { ...opts, view: 'completed' }).entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('places a project row by the server, names it by its sidebar row, and reads its waiting members', () => {
    const coordinator = session('c1', {
      projectMembership: { projectId: 'p1', projectTitle: 'Old title', projectStatus: 'OPEN', role: 'COORDINATOR' },
    });
    const waiting = session('m1', {
      title: 'Member', projectMembership: { projectId: 'p1', projectTitle: 'Old title', projectStatus: 'OPEN', role: 'TASK' },
    });
    const pages: SessionListingPage[] = [{
      entries: [{ kind: 'project', projectId: 'p1', placedAt: '2026-11-22T00:00:00.000Z', spokeAt: '2026-11-22T01:00:00.000Z', memberCount: 5, coordinator }],
      next: null,
    }];
    const summary = { id: 'p1', title: 'Project one', status: 'OPEN', buckets: { running: 2 }, taskCounts: { done: 1, failed: 0, total: 3 } };
    const view = sessionListingView(pages, [], [summary as never], {
      ...opts,
      contentSessions: [waiting],
      line: (s) => ({ text: s.id, tone: s.id === 'm1' ? 'approval' as const : 'preview' as const }),
    });
    const entry = view.entries[0];
    expect(entry.kind).toBe('project');
    if (entry.kind !== 'project') return;
    expect(entry).toMatchObject({
      title: 'Project one', listedAt: '2026-11-22T00:00:00.000Z', lastTurnAt: '2026-11-22T01:00:00.000Z',
      sessionCount: 5, needsYou: true, running: false, target: { kind: 'session', id: 'm1' },
    });
    expect(entry.members.map((m) => m.id)).toEqual(['c1', 'm1']);
    // A member it holds runs, or has a job moving, though the list holds no row of it: the server's entry says so.
    const busy = (flags: { running?: boolean; jobs?: boolean }, runnerOffline = false) =>
      sessionListingView([{ entries: [{ ...pages[0].entries[0], ...flags } as SessionListingEntry], next: null }], [], [],
        { ...opts, runnerOffline }).entries[0];
    expect(busy({ running: true, jobs: true })).toMatchObject({ running: true, jobs: true, indicator: 'running' });
    expect(busy({ jobs: true })).toMatchObject({ running: false, jobs: true, indicator: 'jobs' });
    expect(busy({ running: true, jobs: true }, true)).toMatchObject({ running: false, jobs: false, indicator: null });
    // A project with no coordinator, no sidebar row and no member the list holds still has a name.
    const bare = sessionListingView([{ entries: [{ ...pages[0].entries[0], coordinator: null } as SessionListingEntry], next: null }], [], [], opts);
    expect(bare.entries[0]).toMatchObject({ kind: 'project', title: 'Project', line: { text: 'No coordinator' } });
  });
});
