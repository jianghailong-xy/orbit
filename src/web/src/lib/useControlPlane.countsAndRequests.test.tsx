// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { ownerRequestsQuery, workspaceSessionCountsQuery } from './queries';
import { streamPoll } from './listBudget';

/**
 * The sidebar's tallies are read when an event can move one, and the open owner requests when the server says a
 * request changed; everything else waits for the safety read (production, 2026-11-21: 38 and 16 reads a minute,
 * 85% and 96% answered 304).
 */

const h = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  api: vi.fn(async (path: string) => {
    h.asked.push(path);
    return path.startsWith('/owner-requests') ? { requests: [] } : [];
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
let stops: Array<() => void> = [];
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const publish = (type: string, data: Record<string, unknown> = {}, sessionId = 'S1') =>
  act(async () => { latest().onmessage?.({ data: JSON.stringify({ type, sessionId, agentId: 'W1', data }) }); });
const counts = () => h.asked.filter((path) => path === '/sessions/counts').length;
const openRequests = () => h.asked.filter((path) => path === '/owner-requests?state=open').length;
const summary = (over: Record<string, unknown> = {}) => ({
  status: 'RUNNING', runState: 'RUNNING', lifecycleState: 'OPEN', pendingApprovals: 0, title: 'x', ...over,
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.open = [];
  h.asked = [];
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
  for (const options of [workspaceSessionCountsQuery(), ownerRequestsQuery('open')]) {
    const observer = new QueryObserver(client, { ...options, refetchInterval: streamPoll(60_000) } as never);
    stops.push(observer.subscribe(() => {}));
  }
  await advance(0);
  await act(async () => latest().onopen?.());
  await publish('sessions.list_changed', { version: 'v1' }, '');
  await advance(1_000);
  await publish('session.updated', summary());
  await advance(1_000);
  h.asked = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('session-counts', () => {
  it('is not read for hints and session events that move no tally, beyond the safety read', async () => {
    for (let i = 0; i < 20; i += 1) {
      await publish('sessions.list_changed', { version: `v${i + 2}` }, '');
      await publish('session.updated', summary({ title: `t${i}` }));
      await publish('session.error', {});
      await advance(2_000);
    }
    // 40 s of events: no read. The safety read comes at the minute.
    expect(counts()).toBe(0);
    await advance(30_000);
    expect(counts()).toBeLessThanOrEqual(1);
  });

  it.each([
    ['a status change', 'session.updated', summary({ status: 'AWAITING_INPUT', runState: 'IDLE' })],
    ['a session created', 'session.created', summary()],
    ['an approval asked', 'approval.requested', {}],
    ['a job starting', 'background.task', { status: 'running' }],
    ['a job ending', 'background.task', { status: 'completed' }],
    ['a session ended', 'session.ended', {}],
  ])('is read once, inside the 1 s window, for %s', async (_name, type, data) => {
    await publish(type, data);
    await publish(type, data);
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('is read when a summary moves a session to another workspace', async () => {
    await act(async () => {
      latest().onmessage?.({ data: JSON.stringify({ type: 'session.updated', sessionId: 'S1', agentId: 'W2', data: summary() }) });
    });
    await advance(1_000);
    expect(counts()).toBe(1);
  });
});

describe('owner-requests?state=open', () => {
  it('is not read for session events', async () => {
    await publish('session.updated', summary({ status: 'IDLE', runState: 'IDLE' }));
    await publish('session.created', summary(), 'S2');
    await publish('approval.requested', {});
    await advance(5_000);
    expect(openRequests()).toBe(0);
  });

  it('is read once for owner_requests.changed', async () => {
    await publish('owner_requests.changed', { version: 'r2' }, '');
    await publish('owner_requests.changed', { version: 'r3' }, '');
    await advance(1_000);
    expect(openRequests()).toBe(1);
  });

  it('declares the hint on the stream', () => {
    expect(latest().url).toContain('owner_requests');
  });
});
