import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../api';
import { sessionListingQuery } from './queries';
import { sessionListingView } from './sessionListing';
import type { SessionListingData, SessionListingEntry, SessionListingPage } from './sessionListingData';

// A re-read of GET /sessions/listing must leave every row it did not change as the object it was, or every
// memoized row of the column redraws on it (docs/session-list-scale-design.md §4): in the cached pages, and
// in the entries the list draws from them.

const h = vi.hoisted(() => ({ answers: [] as unknown[] }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(async () => h.answers.shift()),
}));

const session = (id: string, extra: Partial<SessionListItem> = {}): SessionListItem =>
  ({
    id, title: id, folderId: null, workspace: { id: 'w1', name: 'W' }, createdAt: '2026-11-20T00:00:00.000Z',
    listedAt: '2026-11-20T10:00:00.000Z', ...extra,
  }) as SessionListItem;
const member = (id: string, projectId: string) => session(id, {
  projectMembership: { projectId, projectTitle: 'P', projectStatus: 'OPEN', role: 'TASK' },
});
const loose = (id: string, extra: Partial<SessionListItem> = {}): SessionListingEntry =>
  ({ kind: 'session', session: session(id, extra) });
const project = (projectId: string, coordinatorId: string): SessionListingEntry => ({
  kind: 'project', projectId, placedAt: '2026-11-20T10:00:00.000Z', spokeAt: '2026-11-20T09:00:00.000Z', memberCount: 2,
  coordinator: session(coordinatorId, {
    projectMembership: { projectId, projectTitle: 'P', projectStatus: 'OPEN', role: 'COORDINATOR' },
  }),
});

// Each read answers the whole list again, as the server does: fresh objects all the way down.
const answer = (entries: SessionListingEntry[], next: string | null): SessionListingPage =>
  structuredClone({ entries, next });
const first = (): SessionListingEntry[] => [loose('a'), loose('b'), project('p1', 'c'), { kind: 'session', session: member('m', 'p2') }];
const second = (): SessionListingEntry[] => [loose('d'), loose('e')];

const projects = [{ id: 'p2', title: 'Two', status: 'OPEN', buckets: { running: 1 }, taskCounts: { done: 1, failed: 0, total: 2 } }];
const opts = {
  view: 'open' as const, folderId: null, workspaceId: 'w1',
  needsYou: () => false, motion: () => null, line: () => ({ text: '', tone: 'preview' as const }),
};
const drawn = (data: SessionListingData) =>
  new Map(sessionListingView(data.pages, [], projects as never, opts).entries.map((entry) => [entry.id, entry]));
const rawEntries = (data: SessionListingData) => new Map(data.pages.flatMap((page) => page.entries)
  .map((entry) => [entry.kind === 'session' ? entry.session.id : entry.projectId, entry]));

/** The query as the column reads it: two pages, then whatever the next read answers. */
async function reread(next: [SessionListingEntry[], SessionListingEntry[]]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = sessionListingQuery({ runnerId: 'r', workspaceId: 'w1', view: 'open' });
  h.answers = [answer(first(), 'cursor'), answer(second(), null)];
  const observer = new InfiniteQueryObserver(qc, options);
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeDefined());
  await observer.fetchNextPage();
  const before = observer.getCurrentResult().data as SessionListingData;
  h.answers = [answer(next[0], 'cursor'), answer(next[1], null)];
  await observer.refetch();
  const after = observer.getCurrentResult().data as SessionListingData;
  unsubscribe();
  qc.clear();
  return { before, after };
}

describe('a listing re-read', () => {
  it('keeps the pages, and every drawn entry, as they were when nothing changed', async () => {
    const { before, after } = await reread([first(), second()]);
    expect(after).toBe(before);
    const was = drawn(before);
    for (const [id, entry] of drawn(after)) {
      if (entry.kind === 'session') expect(entry, id).toBe(was.get(id));
    }
  });

  it('keeps every other row the same object when one entry changed', async () => {
    const changed = first();
    changed[1] = loose('b', { title: 'b, renamed' });
    const { before, after } = await reread([changed, second()]);
    const [was, is] = [drawn(before), drawn(after)];
    expect(is.get('b')).not.toBe(was.get('b'));
    expect(is.get('b')).toMatchObject({ title: 'b, renamed' });
    for (const id of ['a', 'm', 'd', 'e']) expect(is.get(id), id).toBe(was.get(id));
    // The cached rows too, the project's coordinator included.
    const [wasRaw, isRaw] = [rawEntries(before), rawEntries(after)];
    for (const id of ['a', 'p1', 'm', 'd', 'e']) expect(isRaw.get(id), id).toBe(wasRaw.get(id));
    expect(after.pages[1]).toBe(before.pages[1]);
  });

  it('keeps a row the same object when it moved, within its page or across pages', async () => {
    // `e` changes and goes to the top; every other entry shifts by one, `m` over the page boundary.
    const [a, b, p1, m] = first();
    const [d] = second();
    const { before, after } = await reread([[loose('e', { title: 'e, again', listedAt: '2026-11-21T00:00:00.000Z' }), a, b, p1], [m, d]]);
    const [was, is] = [drawn(before), drawn(after)];
    expect([...is.keys()]).toEqual(['e', 'a', 'b', 'p1', 'm', 'd']);
    expect(is.get('e')).not.toBe(was.get('e'));
    for (const id of ['a', 'b', 'm', 'd']) expect(is.get(id), id).toBe(was.get(id));
    const [wasRaw, isRaw] = [rawEntries(before), rawEntries(after)];
    for (const id of ['a', 'b', 'p1', 'm', 'd']) expect(isRaw.get(id), id).toBe(wasRaw.get(id));
  });

  it('draws a member entry anew when its project mark reads differently', async () => {
    const { before } = await reread([first(), second()]);
    const was = drawn(before).get('m');
    const moved = [{ ...projects[0], buckets: { running: 2 } }];
    const is = sessionListingView(before.pages, [], moved as never, opts).entries.find((entry) => entry.id === 'm');
    expect(is).not.toBe(was);
    expect(is).toMatchObject({ projectMark: { runningCount: 2 } });
  });
});
