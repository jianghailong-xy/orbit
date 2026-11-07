// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { forgetOpenListCursors } from './openListDelta';
import {
  projectCoordinatorStatusQuery,
  projectDependencyGraphQuery,
  projectReadyToRunQuery,
  sessionsQuery,
} from './queries';
import { streamPoll } from './listBudget';
import { projectPanoramaQuery } from '../components/ProjectPanoramaHeader';
import { projectChainRankingQuery } from '../components/ProjectChainProgress';

/**
 * The Open list follows `sessions.list_changed` (docs/list-freshness-design.md §3–§4): the hint is
 * read with one `since=` read, nothing else the stream carries reads the Open list, and with the
 * stream live and quiet the Open list and the project page are read once a minute at most.
 */

const h = vi.hoisted(() => ({
  asked: [] as string[],
  answer: (_path: string): unknown => [],
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  api: vi.fn(async (path: string) => {
    h.asked.push(path);
    return h.answer(path);
  }),
}));

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {}
}

const latest = (): FakeEventSource => FakeEventSource.open[FakeEventSource.open.length - 1];

let root: Root | null = null;
let observers: Array<() => void> = [];

async function mount(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider><div /></ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  return client;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function publish(type: string, data: Record<string, unknown> = {}, sessionId = 'S1'): Promise<void> {
  await act(async () => {
    latest().onmessage?.({ data: JSON.stringify({ type, sessionId, data }) });
  });
}

/** The stream opens and delivers the hint the server sends every connection that declared it. */
async function openHinted(): Promise<void> {
  await act(async () => latest().onopen?.());
  await publish('sessions.list_changed', { version: 'v1' }, '');
  await advance(1_000);
}

const open = sessionsQuery({ runnerId: 'R', workspaceId: 'W', view: 'open' });
const openReads = (): string[] => h.asked.filter((path) => path.startsWith('/sessions?') && path.includes('view=open'));

/** The workspace list on screen as WorkspaceView puts it: the safety read while the stream is live. */
async function openListOnScreen(client: QueryClient): Promise<void> {
  const observer = new QueryObserver(client, { ...open, refetchInterval: streamPoll() });
  observers.push(observer.subscribe(() => {}));
  await advance(0);
}

const row = (id: string, status = 'IDLE') => ({ id, status, title: id, createdAt: '2026-11-01T00:00:00Z' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.open = [];
  h.asked = [];
  forgetOpenListCursors();
  // A server with the delta read: a first read whole, then whatever the test says.
  h.answer = (path) => {
    if (path.includes('since=&') || path.endsWith('since=')) {
      return { full: true, sessions: [row('a'), row('b')], cursor: 'c1' };
    }
    if (path.includes('since=')) return { full: false, upserts: [], removedIds: [], cursor: 'c1' };
    if (path.startsWith('/projects/')) {
      return path.includes('/panorama/ready') ? { queuedCount: 0, runningCount: 1, items: [] } : {};
    }
    return [];
  };
});

afterEach(() => {
  for (const stop of observers) stop();
  observers = [];
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Open list and sessions.list_changed', () => {
  it('declares the hint on the stream it opens', async () => {
    await mount();
    expect(latest().url).toContain('hints=list_changed');
  });

  it('reads the Open list exactly once, with since=, for a burst of hints', async () => {
    const client = await mount();
    await openListOnScreen(client);
    await openHinted();
    h.asked = [];

    await publish('sessions.list_changed', { version: 'v2' }, '');
    await advance(300);
    await publish('sessions.list_changed', { version: 'v3' }, '');
    await advance(1_000);

    expect(openReads()).toHaveLength(1);
    expect(openReads()[0]).toContain('since=c1');
  });

  it('never has two Open list reads out at once', async () => {
    const client = await mount();
    await openListOnScreen(client);
    await openHinted();
    h.asked = [];
    let land: (() => void) | null = null;
    const answer = h.answer;
    h.answer = (path) => new Promise((resolve) => {
      land = () => resolve(answer(path));
    });

    await publish('sessions.list_changed', { version: 'v2' }, '');
    await advance(1_000);
    expect(openReads()).toHaveLength(1);
    await publish('sessions.list_changed', { version: 'v3' }, '');
    await advance(3_000);
    expect(openReads(), 'a second read went out beside the first').toHaveLength(1);
    await act(async () => land?.());
    await advance(0);
    // The hint that came while the read was out is read once that read lands.
    expect(openReads()).toHaveLength(2);
  });

  it('keeps the list it holds when the delta is empty', async () => {
    const client = await mount();
    await openListOnScreen(client);
    await openHinted();
    const before = client.getQueryData(open.queryKey);
    expect(before).toEqual([row('a'), row('b')]);

    await publish('sessions.list_changed', { version: 'v2' }, '');
    await advance(1_000);

    expect(openReads().at(-1)).toContain('since=c1');
    expect(client.getQueryData(open.queryKey)).toBe(before);
  });

  it('applies a delta to the list the server sent last', async () => {
    const client = await mount();
    await openListOnScreen(client);
    await openHinted();
    // An optimistic edit on the screen's copy, which the delta must not be applied over.
    client.setQueryData(open.queryKey, (old: ReturnType<typeof row>[] | undefined) =>
      old?.map((r) => (r.id === 'a' ? { ...r, title: 'edited here' } : r)));
    h.answer = () => ({ full: false, upserts: [row('b', 'RUNNING')], removedIds: [], cursor: 'c2' });

    await publish('sessions.list_changed', { version: 'v2' }, '');
    await advance(1_000);

    expect(client.getQueryData(open.queryKey)).toEqual([row('a'), row('b', 'RUNNING')]);
  });

  it('reads the Open list no more than once a minute on session events alone', async () => {
    const client = await mount();
    await openListOnScreen(client);
    await openHinted();
    h.asked = [];

    for (let s = 0; s < 180; s += 5) {
      await publish('session.updated', { id: 'S1', status: s % 10 ? 'RUNNING' : 'IDLE' });
      await publish('approval.requested', { id: 'A1' });
      await advance(5_000);
    }

    expect(openReads().length).toBeLessThanOrEqual(3);
  });
});

describe('the project page while the stream is live', () => {
  it('reads each panorama read no more than once a minute when nothing happens', async () => {
    const client = await mount();
    await openHinted();
    const reads = [
      projectReadyToRunQuery('P1'),
      projectDependencyGraphQuery('P1'),
      projectCoordinatorStatusQuery('P1'),
      projectPanoramaQuery('P1'),
      projectChainRankingQuery('P1'),
    ];
    for (const read of reads) observers.push(new QueryObserver(client, read as never).subscribe(() => {}));
    await advance(0);
    h.asked = [];

    for (let s = 0; s < 180; s += 15) {
      await publish('ping');
      await advance(15_000);
    }

    const count = (fragment: string) => h.asked.filter((path) => path.startsWith('/projects/P1') && path.includes(fragment)).length;
    expect(count('/panorama/ready')).toBeLessThanOrEqual(3);
    expect(count('/dependency-graph')).toBeLessThanOrEqual(3);
    expect(count('/coordinator/status')).toBeLessThanOrEqual(3);
    expect(h.asked.filter((path) => path === '/projects/P1/panorama').length).toBeLessThanOrEqual(3);
    expect(count('/panorama/blocking')).toBeLessThanOrEqual(3);
  });

  it('reads the panorama on a task event, once for a burst', async () => {
    const client = await mount();
    await openHinted();
    observers.push(new QueryObserver(client, projectPanoramaQuery('P1') as never).subscribe(() => {}));
    await advance(0);
    h.asked = [];

    await publish('task.changed', { taskIds: ['T1'] }, '');
    await publish('task.changed', { taskIds: ['T2'] }, '');
    await advance(6_000);

    expect(h.asked.filter((path) => path === '/projects/P1/panorama')).toHaveLength(1);
  });
});
