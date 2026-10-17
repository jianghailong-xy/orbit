// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../api';
import { projectSessionsQuery } from './queries';
import { ControlPlaneProvider } from './useControlPlane';
import { sessionProjectRequests, useSessionProjectData } from './useSessionProjectData';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getToken: () => 'token' };
});
const { api } = await import('../api');

const member = (id: string, projectId = 'P1', role = 'TASK', extra: Record<string, unknown> = {}): SessionListItem => ({
  id, lifecycleState: 'OPEN', pendingApprovals: 0,
  projectMembership: { projectId, role, projectTitle: projectId, projectStatus: 'OPEN' },
  ...extra,
});
const coordinator = (projectId = 'P1') => member(`C${projectId}`, projectId, 'COORDINATOR');
const needsYou = (session: SessionListItem) => session.pendingApprovals > 0;
const opts = (sessions: SessionListItem[], view: 'open' | 'completed' = 'open') => ({
  sessions, view, enabled: true, controlLive: true, needsYou,
});

class FakeEventSource {
  static streams: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeEventSource.streams.push(this); }
  close() {}
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let rows: SessionListItem[] = [];
let calls: string[] = [];
let result: ReturnType<typeof useSessionProjectData> | null = null;

async function advance(ms = 1): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function mount(props: Parameters<typeof useSessionProjectData>[0], pageProjectId?: string): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  function Probe() {
    result = useSessionProjectData(props);
    useQuery({ ...projectSessionsQuery({ projectId: pageProjectId ?? '', view: props.view }), enabled: !!pageProjectId });
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><ControlPlaneProvider><Probe /></ControlPlaneProvider></QueryClientProvider>);
  });
  await advance();
  await advance();
  return client;
}

async function publish(projectId: string | null, sessionId = 'remote'): Promise<void> {
  await act(async () => {
    FakeEventSource.streams[0].onmessage?.({ data: JSON.stringify({
      type: 'session.updated', sessionId,
      data: { id: sessionId, projectMembership: projectId ? { projectId, role: 'TASK' } : null },
    }) });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rows = [];
  calls = [];
  result = null;
  vi.mocked(api).mockImplementation(async (path) => {
    calls.push(path);
    const params = new URL(path, 'http://orbit.test').searchParams;
    expect(params.get('projectId'), 'all supplemental requests must name a project').toBeTruthy();
    expect(params.has('limit')).toBe(false);
    return rows.filter((session) => session.projectMembership?.projectId === params.get('projectId') &&
      session.lifecycleState === (params.get('view') === 'completed' ? 'COMPLETED' : 'OPEN')) as never;
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  container?.remove();
  container = null;
  FakeEventSource.streams = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('targeted supplemental project sessions', () => {
  it('does not read another workspace when the coordinator and waiting target are already local', async () => {
    await mount(opts([coordinator(), member('waiting', 'P1', 'TASK', { pendingApprovals: 1 })]));
    expect(calls).toEqual([]);
    expect(result).toEqual({ coordinators: [], contentSessions: [] });
  });

  it('reads just visible projects missing a coordinator or a waiting member', async () => {
    const local = [
      coordinator('P1'), member('W1', 'P1', 'TASK', { pendingApprovals: 1 }),
      member('W2', 'P2', 'TASK', { pendingApprovals: 1 }), coordinator('P3'),
      { id: 'ordinary', lifecycleState: 'OPEN' },
    ];
    rows = [coordinator('P2'), member('remoteWait', 'P3', 'TASK', { pendingApprovals: 1 })];
    await mount(opts(local));
    expect(calls).toEqual(['/sessions?projectId=P2&view=open', '/sessions?projectId=P3&view=open']);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP2']);
    expect(result?.contentSessions.map((session) => session.id)).toEqual(['CP2', 'remoteWait']);
    // Supplement arrival keeps eligibility anchored to the local list, so it stays mounted.
    await advance(15_000);
    expect(calls).toHaveLength(2);
  });

  it('looks in Completed for the missing coordinator only after the project Open read ruled it out', async () => {
    rows = [member('local'), { ...coordinator(), lifecycleState: 'COMPLETED' }];
    await mount(opts([member('local')]));
    await advance();
    expect(calls).toEqual(['/sessions?projectId=P1&view=open', '/sessions?projectId=P1&view=completed']);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP1']);
    expect(result?.contentSessions.map((session) => session.id)).toEqual(['local']);
  });

  it('keeps Completed content in its view and resolves its coordinator through project-scoped Open', async () => {
    const completed = member('done', 'P1', 'TASK', { lifecycleState: 'COMPLETED' });
    rows = [completed, coordinator(), member('unrelated', 'P2', 'TASK', { lifecycleState: 'COMPLETED' })];
    await mount(opts([completed], 'completed'));
    expect(calls).toEqual(['/sessions?projectId=P1&view=completed', '/sessions?projectId=P1&view=open']);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP1']);
    expect(result?.contentSessions.map((session) => session.id)).toEqual(['done']);
  });

  it('ignores broad list invalidation and unrelated events, then debounces only the updated project', async () => {
    rows = [coordinator(), member('remote', 'P1', 'TASK', { pendingApprovals: 1 }), coordinator('P2')];
    const client = await mount(opts([coordinator(), coordinator('P2')]), 'P1');
    expect(calls).toHaveLength(2); // The page shares P1's scoped read with its supplement.
    await act(async () => { await client.invalidateQueries({ queryKey: ['sessions'] }); });
    await publish('P3', 'other');
    await publish(null, 'ordinary');
    await advance(2_000);
    expect(calls).toHaveLength(2);
    await publish('P1');
    await advance(400);
    await publish('P1');
    await advance(499);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toEqual([
      '/sessions?projectId=P1&view=open', '/sessions?projectId=P2&view=open', '/sessions?projectId=P1&view=open',
    ]);
  });

  it('reconciles only the requested project once per minute even with a live control plane', async () => {
    rows = [coordinator(), member('initial')];
    await mount(opts([coordinator()]));
    expect(calls).toEqual(['/sessions?projectId=P1&view=open']);
    rows.push(member('newRemoteMember'));
    await advance(59_000);
    expect(calls).toHaveLength(1);
    expect(result?.contentSessions.map((session) => session.id)).not.toContain('newRemoteMember');
    await advance(1_100);
    expect(calls).toEqual(['/sessions?projectId=P1&view=open', '/sessions?projectId=P1&view=open']);
    expect(result?.contentSessions.map((session) => session.id)).toContain('newRemoteMember');
  });

  it('does not supplement flat or disabled lists', () => {
    expect(sessionProjectRequests([member('local')], { view: 'trash', enabled: true, needsYou })).toEqual([]);
    expect(sessionProjectRequests([member('local')], { view: 'open', enabled: false, needsYou })).toEqual([]);
  });
});
