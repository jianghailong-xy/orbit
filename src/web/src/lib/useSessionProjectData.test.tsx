// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../api';
import { projectSessionsQuery, type ProjectPlacement } from './queries';
import { ControlPlaneProvider } from './useControlPlane';
import { sessionProjectIds, useSessionProjectData } from './useSessionProjectData';

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
const opts = (sessions: SessionListItem[], view: 'open' | 'completed' = 'open') => ({
  sessions, view, enabled: true, controlLive: true,
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
let answers: Record<string, Omit<ProjectPlacement, 'projectId'>> = {};
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
  answers = {};
  calls = [];
  result = null;
  vi.mocked(api).mockImplementation(async (path) => {
    calls.push(path);
    const url = new URL(path, 'http://orbit.test');
    const params = url.searchParams;
    if (url.pathname === '/sessions') {
      // The project page's own read.
      return rows.filter((session) => session.projectMembership?.projectId === params.get('projectId')) as never;
    }
    expect(url.pathname).toBe('/sessions/project-placement');
    const ids = (params.get('projectIds') ?? '').split(',').filter(Boolean);
    return { projects: ids.flatMap((id) => answers[id] ? [{ projectId: id, ...answers[id] }] : []) } as never;
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

const placed = (coordinatorRow: SessionListItem | null, waiting: SessionListItem[] = [], sessionCount = 1) =>
  ({ coordinator: coordinatorRow, waiting, sessionCount });
const PLACEMENT = (view: string, ...ids: string[]) =>
  `/sessions/project-placement?${new URLSearchParams({ view, projectIds: [...ids].sort().join(',') })}`;

describe('the workspace list’s project placement', () => {
  it('reads every project the list shows in one read, and answers coordinators, waiting members and counts', async () => {
    const local = [
      coordinator('P1'), member('W1', 'P1', 'TASK', { pendingApprovals: 1 }),
      member('W2', 'P2', 'TASK', { pendingApprovals: 1 }), coordinator('P3'),
      { id: 'ordinary', lifecycleState: 'OPEN' } as SessionListItem,
    ];
    answers = {
      P1: placed(coordinator('P1'), [member('W1', 'P1', 'TASK', { pendingApprovals: 1 })], 4),
      P2: placed({ ...coordinator('P2'), lifecycleState: 'COMPLETED' }, [], 2),
      P3: placed(coordinator('P3'), [member('remoteWait', 'P3', 'TASK', { pendingApprovals: 1 })], 7),
    };
    await mount(opts(local));
    expect(calls).toEqual([PLACEMENT('open', 'P1', 'P2', 'P3')]);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP1', 'CP2', 'CP3']);
    expect(result?.contentSessions.map((session) => session.id)).toEqual(['W1', 'remoteWait']);
    expect([...result!.sessionCounts]).toEqual([['P1', 4], ['P2', 2], ['P3', 7]]);
    expect(result?.placing).toBe(false);
    // Nothing else reads it while the stream says nothing, before its safety read is due.
    await advance(15_000);
    expect(calls).toHaveLength(1);
  });

  // Owner 2026-11-07: where a coordinator the list does not hold runs decides whether its project is a row
  // there, so the list is still being placed until the read answers.
  it('is placing only while it looks for a coordinator the list does not hold', async () => {
    let answer = (): void => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const fixture = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (...args) => {
      await held;
      return fixture(...args);
    });
    answers = { P1: placed({ ...coordinator(), lifecycleState: 'COMPLETED' }) };
    await mount(opts([member('local')]));
    expect(result?.placing).toBe(true);
    await act(async () => answer());
    await advance();
    await advance();
    expect(calls).toEqual([PLACEMENT('open', 'P1')]);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP1']);
    expect(result?.placing).toBe(false);
  });

  it('is not placing while every coordinator is already in the list', async () => {
    const fixture = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(((...args: Parameters<typeof fixture>) => {
      void fixture(...args);
      return new Promise(() => {});
    }) as typeof fixture);
    await mount(opts([coordinator(), member('local')]));
    expect(calls).toEqual([PLACEMENT('open', 'P1')]);
    expect(result?.placing).toBe(false);
  });

  it('places a Completed list with a Completed read', async () => {
    const completed = member('done', 'P1', 'TASK', { lifecycleState: 'COMPLETED' });
    answers = { P1: placed(coordinator(), [], 2) };
    await mount(opts([completed], 'completed'));
    expect(calls).toEqual([PLACEMENT('completed', 'P1')]);
    expect(result?.coordinators.map((session) => session.id)).toEqual(['CP1']);
  });

  it('ignores broad list invalidation and unrelated events, then reads once a window for its projects', async () => {
    rows = [coordinator(), member('remote', 'P1', 'TASK', { pendingApprovals: 1 })];
    answers = { P1: placed(coordinator()), P2: placed(coordinator('P2')) };
    const client = await mount(opts([coordinator(), coordinator('P2')]), 'P1');
    // The page's own read and the placement.
    expect(calls).toEqual([PLACEMENT('open', 'P1', 'P2'), '/sessions?projectId=P1&view=open']);
    await act(async () => { await client.invalidateQueries({ queryKey: ['sessions'] }); });
    await publish('P3', 'other');
    await publish(null, 'ordinary');
    await advance(2_000);
    expect(calls).toHaveLength(2);
    await publish('P1');
    await advance(400);
    await publish('P2');
    await advance(599);
    expect(calls.filter((path) => path.startsWith('/sessions/project-placement'))).toHaveLength(1);
    await advance(1);
    expect(calls.filter((path) => path.startsWith('/sessions/project-placement'))).toHaveLength(2);
  });

  it('reads again for a session it holds whose event names no project any more', async () => {
    answers = { P1: placed(coordinator(), [member('remote', 'P1', 'TASK', { pendingApprovals: 1 })]) };
    await mount(opts([member('local')]));
    expect(calls).toHaveLength(1);
    await publish(null, 'remote');
    await advance(1_000);
    expect(calls).toEqual([PLACEMENT('open', 'P1'), PLACEMENT('open', 'P1')]);
  });

  it('reads once a minute while the stream is live', async () => {
    answers = { P1: placed(coordinator()) };
    await mount(opts([member('local')]));
    expect(calls).toHaveLength(1);
    answers = { P1: placed({ ...coordinator(), workspace: { id: 'W2' } } as SessionListItem) };
    await advance(59_000);
    expect(calls).toHaveLength(1);
    await advance(1_100);
    expect(calls).toHaveLength(2);
    expect(result?.coordinators[0]).toMatchObject({ workspace: { id: 'W2' } });
  });

  it('places nothing for a Trash or disabled list', () => {
    expect(sessionProjectIds([member('local')], { view: 'trash', enabled: true })).toEqual([]);
    expect(sessionProjectIds([member('local')], { view: 'open', enabled: false })).toEqual([]);
    expect(sessionProjectIds([member('b', 'P2'), member('a', 'P1'), member('c', 'P2')], { view: 'open', enabled: true }))
      .toEqual(['P1', 'P2']);
  });
});
