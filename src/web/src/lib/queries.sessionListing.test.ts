import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../api';
import { SESSION_PAGE_SIZE, sessionListingQuery } from './queries';
import {
  dropListingProject,
  fileInListings,
  fileListingEntry,
  latestListingPages,
  listingRows,
  patchListingRows,
  type SessionListingData,
  type SessionListingPage,
} from './sessionListingData';

// GET /sessions/listing read a page at a time (docs/session-list-scale-design.md §3.2): what the query
// asks for, how it pages, how a `restarted` answer replaces the pages, and the optimistic edits.

const h = vi.hoisted(() => ({ paths: [] as string[], answers: [] as unknown[] }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(async (path: string) => {
    h.paths.push(path);
    return h.answers.shift();
  }),
}));

afterEach(() => {
  h.paths = [];
  h.answers = [];
});

const row = (id: string, extra: Partial<SessionListItem> = {}): SessionListItem =>
  ({ id, title: id, folderId: null, workspace: { id: 'w1', name: 'W' }, ...extra }) as SessionListItem;
const page = (ids: string[], extra: Partial<SessionListingPage> = {}): SessionListingPage => ({
  entries: ids.map((id) => ({ kind: 'session', session: row(id) })),
  next: null,
  ...extra,
});
const ids = (data: unknown) => listingRows(data).map((session) => session.id);
const query = (qs: string) => Object.fromEntries(new URLSearchParams(qs.split('?')[1]));

describe('sessionListingQuery', () => {
  it('is keyed per runner, workspace, view and folder, under the session lists', () => {
    expect(sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'open', folderId: 'f1' }).queryKey)
      .toEqual(['sessions', 'r1', 'w1', 'open', 'listing', 'f1']);
    expect(sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'completed' }).queryKey)
      .toEqual(['sessions', 'r1', 'w1', 'completed', 'listing', null]);
  });

  it('reads one page of entries, then the next with the page\'s `next`, and stops where `next` is null', async () => {
    const qc = new QueryClient();
    const opts = sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'open', folderId: 'f1' });
    h.answers.push(page(['a', 'b'], { next: 'cursor-1' }), page(['c'], { next: null }));
    const observer = new InfiniteQueryObserver(qc, opts);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    expect(h.paths[0].startsWith('/sessions/listing?')).toBe(true);
    expect(query(h.paths[0])).toEqual({ workspaceId: 'w1', view: 'open', folderId: 'f1', limit: String(SESSION_PAGE_SIZE) });
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    await observer.fetchNextPage();
    expect(query(h.paths[1])).toMatchObject({ after: 'cursor-1', limit: '40' });
    expect(ids(qc.getQueryData(opts.queryKey))).toEqual(['a', 'b', 'c']);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
    unsubscribe();
  });

  it('a `restarted: true` answer replaces every loaded page and is read on from as the first page', async () => {
    const qc = new QueryClient();
    const opts = sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'completed' });
    h.answers.push(
      page(['a', 'b'], { next: 'p1', folders: [] }),
      page(['c', 'd'], { next: 'p2' }),
      // The Completed view switched order between the two reads: the server starts again.
      page(['d', 'a', 'c'], { next: 'r1', restarted: true, folders: [{ folderId: 'f1', rowCount: 2, needsYou: 0, running: false, jobs: false }] }),
      page(['b'], { next: null }),
    );
    const observer = new InfiniteQueryObserver(qc, opts);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    expect(query(h.paths[2]).after).toBe('p2');
    const data = qc.getQueryData<SessionListingData>(opts.queryKey)!;
    // Never appended: the restarted page is the only page, with its folder rows, and a first page's param.
    expect(data.pages).toHaveLength(1);
    expect(ids(data)).toEqual(['d', 'a', 'c']);
    expect(data.pages[0].folders).toEqual([{ folderId: 'f1', rowCount: 2, needsYou: 0, running: false, jobs: false }]);
    expect(data.pageParams).toEqual([null]);
    expect(ids(observer.getCurrentResult().data)).toEqual(['d', 'a', 'c']);
    // The next page follows the restarted page's own `next`.
    await observer.fetchNextPage();
    expect(query(h.paths[3]).after).toBe('r1');
    expect(ids(qc.getQueryData(opts.queryKey))).toEqual(['d', 'a', 'c', 'b']);
    unsubscribe();
  });

  it('a refetch whose later page restarts keeps only the restarted page', async () => {
    const qc = new QueryClient();
    const opts = sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'completed' });
    h.answers.push(page(['a'], { next: 'p1' }), page(['b'], { next: null }));
    const observer = new InfiniteQueryObserver(qc, opts);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    await observer.fetchNextPage();
    h.answers.push(page(['a'], { next: 'p1' }), page(['b', 'a'], { next: null, restarted: true }));
    await observer.refetch();
    expect(qc.getQueryData<SessionListingData>(opts.queryKey)!.pages).toHaveLength(1);
    expect(ids(qc.getQueryData(opts.queryKey))).toEqual(['b', 'a']);
    unsubscribe();
  });
});

describe('the listing cache', () => {
  const data = (pages: SessionListingPage[]): SessionListingData => ({ pages, pageParams: pages.map((_, i) => (i ? `p${i}` : null)) });

  it('leaves pages with no restart as they are', () => {
    const plain = data([page(['a'], { next: 'p1' }), page(['b'])]);
    expect(latestListingPages(plain)).toBe(plain);
    // A first page that says restarted is a first page already.
    const first = data([page(['a'], { restarted: true })]);
    expect(latestListingPages(first)).toBe(first);
  });

  it('holds each session entry\'s row and each project entry\'s coordinator', () => {
    const listing = data([{
      entries: [
        { kind: 'session', session: row('s1') },
        { kind: 'project', projectId: 'p1', placedAt: '', spokeAt: '', memberCount: 2, coordinator: row('c1') },
        { kind: 'project', projectId: 'p2', placedAt: '', spokeAt: '', memberCount: 1, coordinator: null },
      ],
      next: null,
    }]);
    expect(ids(listing)).toEqual(['s1', 'c1']);
    expect(listingRows([row('flat')])).toEqual([]);
  });

  it('patches rows in place, drops a session entry, and keeps a project when its coordinator is dropped', () => {
    const listing = data([{
      entries: [
        { kind: 'session', session: row('s1') },
        { kind: 'session', session: row('s2') },
        { kind: 'project', projectId: 'p1', placedAt: '', spokeAt: '', memberCount: 2, coordinator: row('c1') },
      ],
      next: null,
    }]);
    const renamed = patchListingRows(listing, (s) => (s.id === 's2' ? { ...s, title: 'New' } : s));
    expect(listingRows(renamed).find((s) => s.id === 's2')?.title).toBe('New');
    const dropped = patchListingRows(listing, (s) => (s.id === 's1' || s.id === 'c1' ? null : s));
    expect((dropped as SessionListingData).pages[0].entries.map((e) => e.kind === 'session' ? e.session.id : e.projectId))
      .toEqual(['s2', 'p1']);
    expect(ids(dropListingProject(listing, 'p1'))).toEqual(['s1', 's2']);
    // Anything that is not a listing passes through.
    const flat = [row('s1')];
    expect(patchListingRows(flat, () => null)).toBe(flat);
  });

  it('a move into a folder takes the entry off the top-level pages and bumps the folder\'s count', () => {
    const top = data([
      page(['s1', 's2'], { next: 'p1', folders: [
        { folderId: 'f1', rowCount: 3, needsYou: 0, running: false, jobs: false },
        { folderId: 'f2', rowCount: 1, needsYou: 0, running: false, jobs: false },
      ] }),
      page(['s3']),
    ]);
    const moved = fileListingEntry(top, null, { id: 's3', from: null, to: 'f1', entry: true }) as SessionListingData;
    expect(ids(moved)).toEqual(['s1', 's2']);
    expect(moved.pages[0].folders!.map((f) => [f.folderId, f.rowCount])).toEqual([['f1', 4], ['f2', 1]]);
    // Out of one folder into another, from that folder's page: it leaves the page; the top list's counts follow.
    const f1Page = data([page(['s4', 's5'])]);
    expect(ids(fileListingEntry(f1Page, 'f1', { id: 's4', from: 'f1', to: 'f2', entry: true }))).toEqual(['s5']);
    const counts = fileListingEntry(top, null, { id: 's4', from: 'f1', to: 'f2', entry: true }) as SessionListingData;
    expect(counts.pages[0].folders!.map((f) => [f.folderId, f.rowCount])).toEqual([['f1', 2], ['f2', 2]]);
    // Back out of a folder: refiled where it is listed; where it now belongs it waits for the next read.
    const back = fileListingEntry(f1Page, null, { id: 's5', from: 'f1', to: null, entry: true }) as SessionListingData;
    expect(ids(back)).toEqual(['s4', 's5']);
    // A folder made since the page was read gets a row.
    const fresh = fileListingEntry(top, null, { id: 's1', from: null, to: 'f9', entry: true }) as SessionListingData;
    expect(fresh.pages[0].folders!.find((f) => f.folderId === 'f9')?.rowCount).toBe(1);
  });

  it('a coordinator filed in a folder takes its project\'s entry with it', () => {
    const top = data([{
      folders: [{ folderId: 'f1', rowCount: 0, needsYou: 0, running: false, jobs: false }],
      entries: [{ kind: 'project', projectId: 'p1', placedAt: '', spokeAt: '', memberCount: 2, coordinator: row('c1') }],
      next: null,
    }]);
    const moved = fileListingEntry(top, null, { id: 'c1', from: null, to: 'f1', entry: true }) as SessionListingData;
    expect(moved.pages[0].entries).toEqual([]);
    expect(moved.pages[0].folders![0].rowCount).toBe(1);
  });

  it('counts a move only in the workspaces that list the session as an entry', () => {
    const qc = new QueryClient();
    const mine = sessionListingQuery({ runnerId: 'r1', workspaceId: 'w1', view: 'open' }).queryKey;
    const other = sessionListingQuery({ runnerId: 'r1', workspaceId: 'w2', view: 'open' }).queryKey;
    const tallies = [{ folderId: 'f1', rowCount: 1, needsYou: 0, running: false, jobs: false }];
    qc.setQueryData(mine, data([page(['s1'], { folders: tallies })]));
    qc.setQueryData(other, data([page(['x1'], { folders: tallies })]));
    // A member held by a project row is no entry: nothing is counted for it.
    fileInListings(qc, { id: 'held', from: null, to: 'f1' });
    expect(qc.getQueryData<SessionListingData>(mine)!.pages[0].folders![0].rowCount).toBe(1);
    fileInListings(qc, { id: 's1', from: null, to: 'f1' });
    expect(ids(qc.getQueryData(mine))).toEqual([]);
    expect(qc.getQueryData<SessionListingData>(mine)!.pages[0].folders![0].rowCount).toBe(2);
    expect(qc.getQueryData<SessionListingData>(other)!.pages[0].folders![0].rowCount).toBe(1);
  });
});
