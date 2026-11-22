// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider, useRefreshSessionLists } from './useControlPlane';
import { workspaceSessionCountsQuery } from './queries';
import { streamPoll } from './listBudget';

/**
 * `GET /sessions/counts` is read when a session's share of a tally moves (active, running, jobs, needsYou), decided
 * at the end of the 1 s window, and not for the stream's other session events (production, 2026-11-21: 8.2 reads a
 * minute on the earlier rule, 59–81% answered 304).
 */

const h = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  api: vi.fn(async (path: string) => {
    h.asked.push(path);
    return [];
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
let client: QueryClient;
let stops: Array<() => void> = [];
let refreshLists: (() => void) | null = null;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const send = (type: string, data: Record<string, unknown>, sessionId = 'S1', agentId = 'W1') =>
  act(async () => { latest().onmessage?.({ data: JSON.stringify({ type, sessionId, agentId, data }) }); });
const counts = () => h.asked.filter((path) => path === '/sessions/counts').length;
const summary = (over: Record<string, unknown> = {}) => ({
  status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'IDLE', lifecycleState: 'OPEN', agentId: 'W1',
  pendingApprovals: 0, waitingKind: null, title: 'x', ...over,
});
const updated = (over: Record<string, unknown> = {}, sessionId = 'S1') => send('session.updated', summary(over), sessionId);
const job = (status: string, over: Record<string, unknown> = {}) =>
  send('background.task', { name: 'npm test', status, toolUseId: 'bgj_1', kind: 'job', ...over });
/** The stream describes S1 as `over` says, and whatever that reads is done with. */
const settle = async (over: Record<string, unknown> = {}) => {
  await updated(over);
  await advance(1_000);
  h.asked = [];
};

function Writer() {
  refreshLists = useRefreshSessionLists();
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.open = [];
  h.asked = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider><Writer /></ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  const observer = new QueryObserver(client, { ...workspaceSessionCountsQuery(), refetchInterval: streamPoll(60_000) } as never);
  stops.push(observer.subscribe(() => {}));
  await advance(0);
  await act(async () => latest().onopen?.());
  await send('sessions.list_changed', { version: 'v1' }, '', '');
  await settle();
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  act(() => root?.unmount());
  root = null;
  refreshLists = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('session-counts: transitions that move no tally', () => {
  it.each([
    ['a runState change inside one status', { runState: 'IDLE' }, { runState: 'RECOVERING' }],
    ['AWAITING_INPUT to INTERRUPTED', {}, { status: 'INTERRUPTED', runStatus: 'INTERRUPTED', runState: 'INTERRUPTED' }],
    ['FAILED to CANCELLED', { status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED' }, { status: 'CANCELLED', runStatus: 'CANCELLED', runState: 'ENDED' }],
    ['a released session moving from Open to Completed', { status: 'FAILED', runStatus: 'FAILED' }, { status: 'FAILED', runStatus: 'FAILED', lifecycleState: 'COMPLETED' }],
    ['pendingApprovals 1 to 2', { pendingApprovals: 1 }, { pendingApprovals: 2 }],
    ['pendingApprovals 2 to 1', { pendingApprovals: 2 }, { pendingApprovals: 1 }],
    ['a start request added beside nothing', {}, { pendingApprovals: 1, waitingKind: 'START_REQUEST' }],
    ['a title, preview or recap change', { status: 'RUNNING', runStatus: 'RUNNING' }, { status: 'RUNNING', runStatus: 'RUNNING', title: 'y', recapText: 'r' }],
  ])('%s', async (_name, from, to) => {
    await settle(from);
    await updated(to);
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('repeated identical summaries', async () => {
    await settle({ status: 'RUNNING', runStatus: 'RUNNING' });
    for (let i = 0; i < 10; i += 1) {
      await updated({ status: 'RUNNING', runStatus: 'RUNNING' });
      await advance(1_500);
    }
    expect(counts()).toBe(0);
  });

  it.each([
    ['requested 1 to 2', 'approval.requested', { pendingApprovals: 1 }, 2],
    ['resolved 2 to 1', 'approval.resolved', { pendingApprovals: 2 }, 1],
  ])('an approval %s', async (_name, type, from, to) => {
    await settle(from);
    await send(type, { approvalId: 'A1', pendingApprovals: to });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('an approval requested and resolved inside one window', async () => {
    await send('approval.requested', { approvalId: 'A1', pendingApprovals: 1 });
    await advance(300);
    await send('approval.resolved', { approvalId: 'A1', pendingApprovals: 0 });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it("a job's once-a-minute running report", async () => {
    await job('running');
    await advance(1_000);
    h.asked = [];
    for (let i = 0; i < 3; i += 1) {
      await job('running', { idleMs: i * 1000 });
      await advance(1_000);
    }
    expect(counts()).toBe(0);
  });

  it("an older server's running reports, named by their command", async () => {
    await send('background.task', { name: 'npm run build', status: 'running' });
    await advance(1_000);
    h.asked = [];
    await send('background.task', { name: 'npm run build', status: 'running' });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('a service starting, reporting and ending', async () => {
    await job('running', { kind: 'service', toolUseId: 'bgj_dev' });
    await advance(1_000);
    await job('running', { kind: 'service', toolUseId: 'bgj_dev' });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it("a Monitor's events, which carry no status", async () => {
    await send('background.task', { name: 'background task', status: '' });
    await send('background.task', { name: 'background task', status: 'unknown' });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it("a session's first summary after the page loaded, when it says what the Open list read", async () => {
    client.setQueryData(['sessions', null, null, 'open', null, null], [
      { id: 'S2', ...summary({ status: 'RUNNING', runStatus: 'RUNNING' }) },
    ]);
    await updated({ status: 'RUNNING', runStatus: 'RUNNING', title: 'renamed' }, 'S2');
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('a session created that counts in nothing (a released one restored to Open)', async () => {
    await send('session.created', summary({ status: 'FAILED', runStatus: 'FAILED' }), 'S3');
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('a released session filed away (session.ended)', async () => {
    await settle({ status: 'SUCCEEDED', runStatus: 'SUCCEEDED' });
    await send('session.ended', { status: 'SUCCEEDED', runStatus: 'SUCCEEDED', lifecycleState: 'COMPLETED' });
    await advance(2_000);
    expect(counts()).toBe(0);
  });

  it('all of them for 40 s read nothing beyond the safety read', async () => {
    for (let i = 0; i < 20; i += 1) {
      await send('sessions.list_changed', { version: `v${i + 2}` }, '', '');
      await updated({ runState: i % 2 ? 'IDLE' : 'RECOVERING', title: `t${i}` });
      await send('approval.requested', { approvalId: `A${i}`, pendingApprovals: 1 });
      await send('approval.resolved', { approvalId: `A${i}`, pendingApprovals: 0 });
      await job('running', { idleMs: i });
      await advance(2_000);
    }
    // The first running report is a job this tab had not heard of: one read. Nothing else reads until the minute.
    expect(counts()).toBe(1);
    await advance(30_000);
    expect(counts()).toBeLessThanOrEqual(2);
  });
});

describe('session-counts: real moves read once inside the 1 s window', () => {
  it.each([
    ['AWAITING_INPUT to RUNNING', {}, { status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING' }],
    ['RUNNING to AWAITING_INPUT', { status: 'RUNNING', runStatus: 'RUNNING' }, {}],
    ['AWAITING_INPUT to PENDING', {}, { status: 'PENDING', runStatus: 'PENDING' }],
    ['PENDING to RUNNING', { status: 'PENDING', runStatus: 'PENDING' }, { status: 'RUNNING', runStatus: 'RUNNING' }],
    ['RUNNING to FAILED', { status: 'RUNNING', runStatus: 'RUNNING' }, { status: 'FAILED', runStatus: 'FAILED' }],
    ['AWAITING_INPUT to FAILED, which takes its jobs off it', {}, { status: 'FAILED', runStatus: 'FAILED' }],
    ['a session coming to need you', {}, { pendingApprovals: 1 }],
    ['a session ceasing to need you', { pendingApprovals: 1 }, {}],
    ['a start request joined by an approval', { pendingApprovals: 1, waitingKind: 'START_REQUEST' }, { pendingApprovals: 2 }],
    ['a workspace move', {}, { agentId: 'W2' }],
  ])('%s', async (_name, from, to) => {
    await settle(from);
    await updated(to);
    await updated(to);
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a workspace move the envelope alone says', async () => {
    await send('session.updated', summary({ agentId: undefined }), 'S1', 'W2');
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it.each([
    ['requested 0 to 1', 'approval.requested', {}, 1],
    ['resolved 1 to 0', 'approval.resolved', { pendingApprovals: 1 }, 0],
  ])('an approval %s', async (_name, type, from, to) => {
    await settle(from);
    await send(type, { approvalId: 'A1', pendingApprovals: to });
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a counted job starting', async () => {
    await job('running');
    await job('running');
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a counted job ending', async () => {
    await job('running');
    await advance(1_000);
    h.asked = [];
    await job('completed', { exitCode: 0 });
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a second job starting beside a running one', async () => {
    await job('running');
    await advance(1_000);
    h.asked = [];
    await job('running', { toolUseId: 'bgj_2' });
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a session created that counts', async () => {
    await send('session.created', summary({ status: 'PENDING', runStatus: 'PENDING' }), 'S2');
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a session ended', async () => {
    await send('session.ended', { status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', lifecycleState: 'COMPLETED' });
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it("a session's first summary that differs from what the Open list read", async () => {
    client.setQueryData(['sessions', null, null, 'open', null, null], [{ id: 'S2', ...summary() }]);
    await updated({ status: 'RUNNING', runStatus: 'RUNNING' }, 'S2');
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('a session the tab has neither heard of nor read', async () => {
    await updated({}, 'S9');
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it("a write's own refresh", async () => {
    await act(async () => refreshLists?.());
    await advance(1_000);
    expect(counts()).toBe(1);
  });

  it('the reconnect, and after it the same summary judged afresh', async () => {
    await act(async () => latest().onerror?.());
    await advance(2_000);
    await act(async () => latest().onopen?.());
    await advance(0);
    expect(counts()).toBe(1);
    h.asked = [];
    // What the stream said before the gap no longer stands: a session it described is read for again.
    await updated();
    await advance(1_000);
    expect(counts()).toBe(1);
  });
});
