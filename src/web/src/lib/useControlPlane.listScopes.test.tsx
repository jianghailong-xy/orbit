// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidToBase62 } from '@orbit/shared';
import { ControlPlaneProvider } from './useControlPlane';
import { forgetOpenListCursors } from './openListDelta';
import { sessionsQuery } from './queries';
import { streamPoll } from './listBudget';

/**
 * `sessions.list_changed` with `scopes` (docs/realtime-control-plane-stream.md §4.8, `hints=list_scopes`;
 * docs/list-freshness-scope-hints.md §6): a list filtered to one workspace is read only when a hint names its
 * workspace, or names none; a list with no workspace filter on every hint. The scopes of every hint in the 1 s
 * window are unioned, and the 60 s safety read and the hidden-tab rule stay as they were.
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
let visibility: DocumentVisibilityState = 'visible';

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

async function hint(data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    latest().onmessage?.({ data: JSON.stringify({ type: 'sessions.list_changed', sessionId: '', agentId: null, data }) });
  });
}

let version = 0;
const next = (): string => `v${++version}`;

/** The stream opens and delivers the first hint, which names no workspace. */
async function openHinted(): Promise<void> {
  await act(async () => latest().onopen?.());
  await hint({ version: next() });
  await advance(1_000);
}

// The shown workspace's id as the list is keyed by it (a uuid), and the public spelling the server names it by.
const MINE = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f708192';
const OTHER = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f7081a3';
const THIRD = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f7081b4';
const mine = sessionsQuery({ runnerId: 'R', workspaceId: MINE, view: 'open' });
const other = sessionsQuery({ runnerId: 'R', workspaceId: OTHER, view: 'open' });
const flat = sessionsQuery({ view: 'open' });

const readsOf = (workspaceId: string | null): string[] => h.asked.filter((path) => {
  if (!path.startsWith('/sessions?') || !path.includes('view=open')) return false;
  const query = new URLSearchParams(path.split('?')[1]);
  return workspaceId === null ? !query.has('workspaceId') : query.get('workspaceId') === workspaceId;
});

/** A list on screen as WorkspaceView puts it: with the safety read while the stream is live. */
async function onScreen(client: QueryClient, query: { queryKey: readonly unknown[] }): Promise<void> {
  const observer = new QueryObserver(client, { ...(query as typeof mine), refetchInterval: streamPoll() });
  observers.push(observer.subscribe(() => {}));
  await advance(0);
}

const row = (id: string) => ({ id, status: 'IDLE', title: id, createdAt: '2026-11-01T00:00:00Z' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  FakeEventSource.open = [];
  h.asked = [];
  version = 0;
  forgetOpenListCursors();
  h.answer = (path) => {
    if (path.includes('since=&') || path.endsWith('since=')) return { full: true, sessions: [row('a')], cursor: 'c1' };
    if (path.includes('since=')) return { full: false, upserts: [], removedIds: [], cursor: 'c1' };
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

describe('Open lists and the workspaces a hint names', () => {
  it('declares list_scopes beside list_changed on the stream it opens', async () => {
    await mount();
    const hints = new URL(latest().url, 'http://x').searchParams.get('hints')!.split(',');
    expect(hints).toEqual(expect.arrayContaining(['list_changed', 'owner_requests', 'list_scopes']));
  });

  it('with hints every second for other workspaces, reads the shown workspace no more often than its 60 s safety read', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];

    for (let s = 0; s < 180; s += 1) {
      await hint({ version: next(), scopes: [uuidToBase62(s % 2 ? OTHER : THIRD)] });
      await advance(1_000);
    }

    // 180 s: the safety read at most three times, and nothing for the hints.
    expect(readsOf(MINE).length).toBeLessThanOrEqual(3);
  });

  it('reads a hint naming the shown workspace within one merge window, and only that list', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await onScreen(client, other);
    await openHinted();
    h.asked = [];

    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(1);
    expect(readsOf(MINE)[0]).toContain('since=c1');
    expect(readsOf(OTHER)).toHaveLength(0);
  });

  it('matches a workspace named in either spelling', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];

    await hint({ version: next(), scopes: [MINE] });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(1);
  });

  it('a hint naming another workspace reads no filtered list, and the list with no workspace filter once', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await onScreen(client, flat);
    await openHinted();
    h.asked = [];

    await hint({ version: next(), scopes: [uuidToBase62(THIRD)] });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(0);
    expect(readsOf(null)).toHaveLength(1);
  });

  it('a hint naming no workspace reads every list', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await onScreen(client, other);
    await onScreen(client, flat);
    await openHinted();
    h.asked = [];

    await hint({ version: next() });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(1);
    expect(readsOf(OTHER)).toHaveLength(1);
    expect(readsOf(null)).toHaveLength(1);
  });

  it('unions the scopes of the hints in one window, and reads each named list once', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await onScreen(client, other);
    await openHinted();
    h.asked = [];

    await hint({ version: next(), scopes: [uuidToBase62(OTHER)] });
    await advance(300);
    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(300);
    await hint({ version: next(), scopes: [uuidToBase62(OTHER), uuidToBase62(THIRD)] });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(1);
    expect(readsOf(OTHER)).toHaveLength(1);
  });

  it('a hint naming no workspace in the window reads every list, whatever the others named', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await onScreen(client, other);
    await openHinted();
    h.asked = [];

    await hint({ version: next(), scopes: [uuidToBase62(THIRD)] });
    await advance(300);
    await hint({ version: next() });
    await advance(1_000);

    expect(readsOf(MINE)).toHaveLength(1);
    expect(readsOf(OTHER)).toHaveLength(1);
  });

  it('a hint naming the workspace while its read is out is read once that read lands', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];
    let land: (() => void) | null = null;
    const answer = h.answer;
    h.answer = (path) => new Promise((resolve) => {
      land = () => resolve(answer(path));
    });

    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(1_000);
    expect(readsOf(MINE)).toHaveLength(1);
    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(3_000);
    expect(readsOf(MINE), 'a second read went out beside the first').toHaveLength(1);
    await act(async () => land?.());
    await advance(0);
    expect(readsOf(MINE)).toHaveLength(2);
  });

  it('a hint for another workspace while the read is out reads nothing more once it lands', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];
    let land: (() => void) | null = null;
    const answer = h.answer;
    h.answer = (path) => new Promise((resolve) => {
      land = () => resolve(answer(path));
    });

    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(1_000);
    await hint({ version: next(), scopes: [uuidToBase62(OTHER)] });
    await advance(1_000);
    await act(async () => land?.());
    await advance(1_000);
    expect(readsOf(MINE)).toHaveLength(1);
  });

  it('the 60 s safety read still runs when no hint names the workspace', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];

    await advance(61_000);

    expect(readsOf(MINE).length).toBeGreaterThanOrEqual(1);
  });

  it('a hidden tab reads nothing on a hint naming its workspace, and reads it once it is back', async () => {
    const client = await mount();
    await onScreen(client, mine);
    await openHinted();
    h.asked = [];

    visibility = 'hidden';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await hint({ version: next(), scopes: [uuidToBase62(MINE)] });
    await advance(5_000);
    expect(readsOf(MINE)).toHaveLength(0);

    visibility = 'visible';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(1_000);
    expect(readsOf(MINE)).toHaveLength(1);
  });
});
