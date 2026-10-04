// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { openProjectsQuery } from './queries';

vi.mock('../api', () => ({ getToken: () => 'token' }));

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {
    this.closed = true;
  }
}

const PROJECTS: QueryKey = openProjectsQuery().queryKey;
const PROJECT_PAGE: QueryKey = ['projects', 'OPEN'];
const SESSIONS: QueryKey = ['sessions'];
const PROJECT_SESSIONS: QueryKey = ['project-sessions', 'P1', 'open'];
const COMPLETED_PROJECT_SESSIONS: QueryKey = ['project-sessions', 'P1', 'completed'];
const OTHER_PROJECT_SESSIONS: QueryKey = ['project-sessions', 'P2', 'open'];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Unobserved cache entries expose invalidation without any network request or polling.
  for (const key of [PROJECTS, PROJECT_PAGE, SESSIONS, PROJECT_SESSIONS, COMPLETED_PROJECT_SESSIONS, OTHER_PROJECT_SESSIONS]) client.setQueryData(key, []);
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider><div /></ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  return client;
}

async function publish(type: string, data: Record<string, unknown> = {}): Promise<void> {
  const stream = FakeEventSource.open.find((es) => !es.closed);
  expect(stream, 'the control plane opened no event stream').toBeTruthy();
  await act(async () => {
    stream!.onmessage?.({ data: JSON.stringify({ type, sessionId: 'S1', data }) });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const invalidated = (client: QueryClient, key: QueryKey): boolean =>
  client.getQueryState(key)?.isInvalidated === true;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(async () => {
  try {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
  } finally {
    container?.remove();
    container = null;
    root = null;
    FakeEventSource.open = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('project summaries ride the control-plane stream', () => {
  it('project.changed refreshes sidebar summaries and the session list', async () => {
    const client = await mount();
    await publish('project.changed', { id: 'P1' });
    await advance(500);
    expect(invalidated(client, PROJECTS)).toBe(true);
    expect(invalidated(client, SESSIONS)).toBe(true);
    expect(invalidated(client, PROJECT_PAGE)).toBe(false);
  });

  it('debounces member session.updated bursts for two seconds while sessions refresh sooner', async () => {
    const client = await mount();
    const data = { id: 'S1', projectMembership: { projectId: 'P1', role: 'TASK' } };
    await publish('session.updated', data);
    await advance(500);
    expect(invalidated(client, SESSIONS)).toBe(true);
    expect(invalidated(client, PROJECTS)).toBe(false);
    await advance(1_000);
    await publish('session.updated', data);
    await advance(1_999);
    expect(invalidated(client, PROJECTS)).toBe(false);
    await advance(1);
    expect(invalidated(client, PROJECTS)).toBe(true);
    expect(invalidated(client, PROJECT_PAGE)).toBe(false);
    client.setQueryData(PROJECTS, []);
    await advance(2_000);
    expect(invalidated(client, PROJECTS)).toBe(false);
  });

  it.each([{}, { projectMembership: null }])('ordinary and old-server updates leave project summaries alone (%j)', async (data) => {
    const client = await mount();
    await publish('session.updated', { id: 'S1', ...data });
    await advance(2_000);
    expect(invalidated(client, SESSIONS)).toBe(true);
    expect(invalidated(client, PROJECTS)).toBe(false);
  });

  it('reconciles project summaries when the stream reconnects', async () => {
    const client = await mount();
    await act(async () => { FakeEventSource.open[0].onopen?.(); });
    expect(invalidated(client, PROJECTS)).toBe(true);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(true);
  });

  it('debounces project member reads independently and leaves unrelated projects alone', async () => {
    const client = await mount();
    await publish('session.updated', { projectMembership: { projectId: 'P1' } });
    await advance(400);
    await publish('session.updated', { projectMembership: { projectId: 'P1' } });
    await advance(499);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(false);
    await advance(1);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, COMPLETED_PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it('refreshes a cached former member when membership is cleared', async () => {
    const client = await mount();
    client.setQueryData(PROJECT_SESSIONS, [{ id: 'S1' }]);
    await publish('session.updated', { id: 'S1', projectMembership: null });
    await advance(500);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it('unrelated session updates leave every project member query alone', async () => {
    const client = await mount();
    await publish('session.updated', { id: 'S1', projectMembership: { projectId: 'P3' } });
    await advance(2_000);
    expect(invalidated(client, SESSIONS)).toBe(true);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(false);
    expect(invalidated(client, COMPLETED_PROJECT_SESSIONS)).toBe(false);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it('reconciles a loaded member on lifecycle-ended frames without membership', async () => {
    const client = await mount();
    client.setQueryData(PROJECT_SESSIONS, [{ id: 'S1' }]);
    await publish('session.ended', { lifecycleState: 'COMPLETED', endReason: 'task_done' });
    await advance(500);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, COMPLETED_PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it.each(['workspace-list', 'session-detail'])('finds a newly Completed member through its cached %s', async (source) => {
    const client = await mount();
    const member = { id: 'S1', projectMembership: { projectId: 'P1', role: 'TASK' } };
    if (source === 'workspace-list') client.setQueryData(SESSIONS, [member]);
    else client.setQueryData(['session', 'S1'], member);
    await publish('session.ended', { lifecycleState: 'COMPLETED' });
    await advance(500);
    expect(invalidated(client, COMPLETED_PROJECT_SESSIONS)).toBe(true);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it('does not re-read a project for an unrelated lifecycle-ended frame', async () => {
    const client = await mount();
    await publish('session.ended', { lifecycleState: 'COMPLETED' });
    await advance(500);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(false);
    expect(invalidated(client, COMPLETED_PROJECT_SESSIONS)).toBe(false);
    expect(invalidated(client, OTHER_PROJECT_SESSIONS)).toBe(false);
  });

  it('cancels a pending member refresh when the provider unmounts', async () => {
    const client = await mount();
    await publish('session.updated', { projectMembership: { projectId: 'P1' } });
    const mounted = root!;
    await act(async () => mounted.unmount());
    root = null;
    await advance(2_000);
    expect(invalidated(client, PROJECTS)).toBe(false);
    expect(invalidated(client, PROJECT_SESSIONS)).toBe(false);
  });

  it('keeps the sidebar summary poll as the fallback for missed events', () => {
    expect(openProjectsQuery().refetchInterval).toBe(15_000);
  });
});
