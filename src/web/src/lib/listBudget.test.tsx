// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, useQueries, useQuery, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionListItem } from '../api';
import {
  openProjectsQuery,
  projectSessionsQuery,
  sessionDiffQuery,
  sessionQuery,
  sessionsQuery,
  sessionTagsQuery,
  watchesQuery,
  workspaceSessionCountsQuery,
  workspacesQuery,
} from './queries';
import { createAppQueryClient } from './queryClient';
import { listPollMs } from './listBudget';
import { forgetOpenListCursors } from './openListDelta';
import { ControlPlaneProvider, useControlPlaneLive } from './useControlPlane';
import { useSessionProjectData } from './useSessionProjectData';

/**
 * The list budget (docs/list-freshness-design.md §4), one rule a case, over the reads the console
 * makes: what the tab asks the server for, counted by a request recorder, on a fake clock, as the
 * control-plane stream comes and goes and the tab is shown and hidden.
 *
 * R2 — while the stream is down every gated poll backs off together, 4 s, 8 s, 16 s, then every
 *      30 s, starts over only once a reopened stream has delivered a message, and is not retried.
 * R3 — a hidden tab reads nothing, on the stream's word or on a reconnect; back in view, it reads
 *      once what changed and what came due.
 * R5 — an event type no list is for reads nothing, and the watches are read once a window and only
 *      for an event about what a watch follows.
 * W6 — a reopened stream reads what is on screen once, a few at a time, a browser back online too.
 * W7 — a workspace changed (`agent.changed`) re-reads the workspaces.
 * W4 — a workspace list places its projects with one read: once on load, once a window for an event about
 *      one of them, the safety read once a minute, nothing while hidden.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; at: number }>,
  /** Requests whose answer has not come back yet. */
  out: 0,
  /** Fake milliseconds every answer takes. */
  latency: 0,
  failing: (_path: string): boolean => false,
  watches: [] as unknown[],
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  const answer = async (path: string, value: () => unknown): Promise<unknown> => {
    h.calls.push({ path, at: Date.now() });
    h.out += 1;
    try {
      if (h.latency > 0) await new Promise((resolve) => setTimeout(resolve, h.latency));
      if (h.failing(path)) throw new Error('unavailable');
      return value();
    } finally {
      h.out -= 1;
    }
  };
  return {
    ...actual,
    getToken: () => 'token',
    api: vi.fn((path: string) => answer(path, () => {
      if (path.startsWith('/watches')) return h.watches;
      if (path.startsWith('/sessions/project-placement')) return { projects: [] };
      // The Open list's delta read (lib/openListDelta): a first read is answered whole, and every read after it
      // finds nothing moved, an empty delta under the same cursor — what the browser hands back for a 304.
      const since = path.startsWith('/sessions?') ? new URLSearchParams(path.split('?')[1]).get('since') : null;
      if (since === '') return { full: true, sessions: [], cursor: 'c1' };
      if (since) return { full: false, upserts: [], removedIds: [], cursor: since };
      return [];
    })),
    getSession: vi.fn((id: string) => answer(`/sessions/${id}`, () => ({ id, status: 'RUNNING' }))),
    getSessionDiff: vi.fn((id: string) => answer(`/sessions/${id}/diff`, () => ({ files: [] }))),
  };
});

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/** The provider's stream: the newest one it has not closed. A closed EventSource fires nothing. */
const current = (): FakeEventSource | undefined => FakeEventSource.all.filter((es) => !es.closed).at(-1);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let visibility: DocumentVisibilityState = 'visible';
let random: MockInstance | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(children: ReactNode): Promise<QueryClient> {
  const client = createAppQueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider>{children}</ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  await advance(10);
  return client;
}

/** The provider's stream, once its reconnect backoff has asked for one. */
async function stream(): Promise<FakeEventSource> {
  for (let waited = 0; !current() && waited < 120_000; waited += 500) await advance(500);
  const es = current();
  if (!es) throw new Error('the provider asked for no stream');
  return es;
}

/** The stream opens; with `message`, something comes down it, which is what makes it healthy. */
async function open({ message = true } = {}): Promise<void> {
  const es = await stream();
  await act(async () => es.onopen?.());
  if (message) await publish('ping');
  await advance(10);
}

async function publish(type: string, data: Record<string, unknown> = {}, sessionId = ''): Promise<void> {
  const es = await stream();
  await act(async () => {
    es.onmessage?.({ data: JSON.stringify({ type, sessionId, agentId: null, ts: new Date().toISOString(), data }) });
  });
}

async function drop(): Promise<void> {
  const es = await stream();
  await act(async () => es.onerror?.());
}

/** Time passing with the stream live: the server's keepalive comes every 20 s (events.controller.ts),
 *  which is what keeps the 45 s watchdog from dropping it. */
async function live(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20_000) {
    await advance(Math.min(20_000, left));
    await publish('ping');
  }
}

async function show(state: DocumentVisibilityState): Promise<void> {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await advance(10);
}

/** Requests since `from` (an index into the recorder) whose path passes `match`. */
const reads = (match: (path: string) => boolean, from = 0): number =>
  h.calls.slice(from).filter((call) => match(call.path)).length;
const mark = (): number => h.calls.length;
const exactly = (path: string) => (candidate: string): boolean => candidate === path;
const startsWith = (prefix: string) => (candidate: string): boolean => candidate.startsWith(prefix);
const projectRead = (projectId: string) => (path: string): boolean =>
  path.startsWith('/sessions?') && new URLSearchParams(path.split('?')[1]).get('projectId') === projectId;
/** The workspace list's placement read (useSessionProjectData), naming exactly these projects when given. */
const placementRead = (...projectIds: string[]) => (path: string): boolean =>
  path.startsWith('/sessions/project-placement?') &&
  (projectIds.length === 0 || new URLSearchParams(path.split('?')[1]).get('projectIds') === [...projectIds].sort().join(','));
const WATCH_READS = 1; // one watches read is one request (queries.ts watchesQuery, GET /watches?following=true)

const OPEN_LIST = sessionsQuery({ runnerId: 'R1', workspaceId: 'W1', view: 'open', limit: 40 });
const isOpenList = (path: string): boolean => path.startsWith('/sessions?runnerId=R1&workspaceId=W1');

/** Lists on screen, as the console's components hold them. */
function OnScreen({ queries }: { queries: UseQueryOptions<any, any, any, any>[] }): null {
  useQueries({ queries });
  return null;
}

/** A workspace list's project reads, as WorkspaceView makes them (useSessionProjectData). */
function ProjectReads({ sessions }: { sessions: SessionListItem[] }): null {
  const controlLive = useControlPlaneLive();
  useSessionProjectData({ sessions, view: 'open', enabled: true, controlLive });
  return null;
}

const member = (id: string, projectId: string, role = 'TASK'): SessionListItem => ({
  id,
  lifecycleState: 'OPEN',
  pendingApprovals: 0,
  projectMembership: { projectId, role, projectTitle: projectId, projectStatus: 'OPEN' },
} as SessionListItem);

/** A watch on hand that follows session S1 and task T1. */
const FOLLOWING = [{ id: 'W1', targets: [
  { targetKind: 'SESSION', targetResourceId: 'S1' },
  { targetKind: 'TASK', targetResourceId: 'T1' },
] }];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  h.calls = [];
  h.out = 0;
  h.latency = 0;
  h.failing = () => false;
  h.watches = [];
  forgetOpenListCursors();
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
    FakeEventSource.all = [];
    random?.mockRestore();
    random = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('R2: while the stream is down, the gated polls back off together', () => {
  it('reads 4 s, 8 s and 16 s after the drop, then every 30 s', async () => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter, so the steps read exactly
    await mount(<ProjectReads sessions={[member('C1', 'P1', 'COORDINATOR')]} />);
    await open();
    expect(reads(placementRead('P1')), 'the project was never read').toBeGreaterThan(0);

    const droppedAt = Date.now();
    const from = mark();
    await drop();
    await advance(150_000);
    const times = h.calls.slice(from).filter((call) => placementRead('P1')(call.path)).map((call) => call.at - droppedAt);
    const gaps = times.map((at, i) => at - (i === 0 ? 0 : times[i - 1]));
    expect(gaps.slice(0, 5), 'the polls did not back off 4 → 8 → 16 → 30 s').toEqual([4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(Math.min(...gaps.slice(3)), 'a poll came faster than once in 30 s after the backoff capped').toBeGreaterThanOrEqual(30_000);
  });

  it('spreads the polls by their own jitter, never faster than the step', async () => {
    let draw = 0;
    random = vi.spyOn(Math, 'random').mockImplementation(() => [0.9, 0.1, 0.5][draw++ % 3]);
    // Two workspace lists, so two placement reads.
    await mount(<>
      <ProjectReads sessions={[member('C1', 'P1', 'COORDINATOR')]} />
      <ProjectReads sessions={[member('C2', 'P2', 'COORDINATOR')]} />
    </>);
    await open();
    const droppedAt = Date.now();
    const from = mark();
    await drop();
    await advance(10_000);
    const first = (projectId: string): number =>
      h.calls.slice(from).find((call) => placementRead(projectId)(call.path))!.at - droppedAt;
    for (const projectId of ['P1', 'P2']) {
      expect(first(projectId)).toBeGreaterThanOrEqual(4_000);
      expect(first(projectId)).toBeLessThanOrEqual(4_800);
    }
    expect(first('P1'), 'two polls fell due in the same instant').not.toBe(first('P2'));
  });

  it('starts over only once a reopened stream has delivered its first message', async () => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0);
    await mount(<ProjectReads sessions={[member('C1', 'P1', 'COORDINATOR')]} />);
    await open();
    await drop();
    await advance(60_000); // past 4 + 8 + 16 s: the polls are at 30 s

    // A stream that opens and dies before anything comes down it is the same outage.
    await open({ message: false });
    let from = mark();
    let droppedAt = Date.now();
    await drop();
    await advance(30_000);
    let next = h.calls.slice(from).filter((call) => placementRead('P1')(call.path)).map((call) => call.at - droppedAt);
    expect(next[0], 'a stream that never delivered a message reset the backoff').toBe(30_000);

    // One that delivers a message ends it: the next outage starts again at 4 s.
    await advance(2_000);
    await open();
    from = mark();
    droppedAt = Date.now();
    await drop();
    await advance(5_000);
    next = h.calls.slice(from).filter((call) => placementRead('P1')(call.path)).map((call) => call.at - droppedAt);
    expect(next[0]).toBe(4_000);
  });

  it('does not retry a poll that failed while the stream is down', async () => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0);
    await mount(<ProjectReads sessions={[member('C1', 'P1', 'COORDINATOR')]} />);
    await open();
    await drop();
    const from = mark();
    h.failing = placementRead('P1');
    await advance(11_000); // the 4 s poll, and well past the second it would have been retried at
    expect(reads(placementRead('P1'), from), 'a failed poll was asked for twice').toBe(1);
  });
});

describe('R3: a hidden tab reads nothing', () => {
  const lists = [OPEN_LIST, workspaceSessionCountsQuery(), workspacesQuery()];

  it('on the stream’s word, and reads each list that changed once it is back in view', async () => {
    await mount(<OnScreen queries={lists} />);
    await open();
    const from = mark();

    await show('hidden');
    await publish('session.updated', { id: 'S1', status: 'IDLE' }, 'S1');
    await publish('approval.requested', { id: 'A1' }, 'S1');
    await publish('agent.changed', { agentId: 'W1' });
    await publish('drive.sync', {});
    await advance(10_000);
    expect(h.calls.slice(from).map((call) => call.path), 'a hidden tab read on the stream’s word').toEqual([]);

    await show('visible');
    await advance(1_000);
    expect(reads(isOpenList, from)).toBe(1);
    expect(reads(exactly('/sessions/counts'), from)).toBe(1);
    expect(reads(exactly('/workspaces'), from)).toBe(1);
  });

  it('when the stream reopens, and reconciles once back in view', async () => {
    await mount(<OnScreen queries={lists} />);
    await open();
    const from = mark();

    await show('hidden');
    await drop();
    await advance(1_500);
    await open();
    await advance(10_000);
    expect(h.calls.slice(from).map((call) => call.path), 'a hidden tab read when its stream reopened').toEqual([]);

    await show('visible');
    await advance(1_000);
    expect(reads(isOpenList, from)).toBe(1);
    expect(reads(exactly('/sessions/counts'), from)).toBe(1);
    expect(reads(exactly('/workspaces'), from)).toBe(1);
  });

  it('on a poll that came due while it was hidden, and reads that once on its return', async () => {
    await mount(<OnScreen queries={[watchesQuery()]} />);
    await open();
    const from = mark();

    await show('hidden');
    await live(5 * 60_000 + 30_000);
    expect(reads(startsWith('/watches'), from)).toBe(0);

    await show('visible');
    expect(reads(startsWith('/watches'), from), 'the overdue safety read waited for its next tick').toBe(WATCH_READS);
    await live(59_000);
    expect(reads(startsWith('/watches'), from), 'the return read the watches twice').toBe(WATCH_READS);
  });
});

describe('R5: an event reads only the lists it is about', () => {
  it('reads nothing for an event type no list is for', async () => {
    await mount(<OnScreen queries={[OPEN_LIST, workspaceSessionCountsQuery(), watchesQuery()]} />);
    await open();
    const from = mark();

    await publish('notification', { title: 'Hello' });
    await publish('runner.changed', { id: 'R1' });
    await advance(5_000);
    expect(h.calls.slice(from).map((call) => call.path), 'an unmapped event read a list').toEqual([]);
  });

  it('reads the watches once a window, and only for an event about what a watch follows', async () => {
    h.watches = FOLLOWING;
    await mount(<OnScreen queries={[OPEN_LIST, watchesQuery()]} />);
    await open();
    let from = mark();

    await publish('session.updated', { id: 'S9', status: 'IDLE' }, 'S9');
    await advance(5_000);
    expect(reads(isOpenList, from), 'the session event did not reach the session list').toBe(1);
    expect(reads(startsWith('/watches'), from), 'a session no watch follows read the watches').toBe(0);

    from = mark();
    await publish('session.updated', { id: 'S1', status: 'RUNNING' }, 'S1');
    await publish('session.updated', { id: 'S1', status: 'IDLE' }, 'S1');
    await publish('approval.requested', { id: 'A1' }, 'S1');
    await publish('task.changed', { taskId: 'T1', taskIds: ['T1'], resync: false });
    await publish('watch.changed', { id: 'W1' });
    await advance(1_000);
    expect(reads(startsWith('/watches'), from)).toBe(WATCH_READS);
    await advance(10_000);
    expect(reads(startsWith('/watches'), from), 'the watches were read twice for one burst').toBe(WATCH_READS);
  });
});

describe('W7: a workspace changed re-reads the workspace list', () => {
  it('reads /workspaces on agent.changed, the event a workspace edit publishes', async () => {
    await mount(<OnScreen queries={[workspacesQuery(), OPEN_LIST]} />);
    await open();
    const from = mark();

    await publish('agent.changed', { agentId: 'W1', affectsTaskRows: false }, 'S1');
    await advance(1_000);
    expect(reads(exactly('/workspaces'), from), 'a renamed workspace kept its old name').toBe(1);
    expect(reads(isOpenList, from), 'the rows that show its name were not read').toBe(1);
  });

  // A heartbeat moved a workspace's checkout (a commit, push, move or clean-up): the Main checkout bar draws the
  // workspace list's repoHealth, so that list is read — and only that list, since these come with every change.
  it('reads only /workspaces when the event says the checkout health moved', async () => {
    await mount(<OnScreen queries={[workspacesQuery(), OPEN_LIST]} />);
    await open();
    const from = mark();

    await publish('agent.changed', { agentId: 'W1', affectsTaskRows: false, repoHealth: true });
    await advance(1_000);
    expect(reads(exactly('/workspaces'), from), 'the Main checkout bar kept its old counts').toBe(1);
    expect(reads(isOpenList, from), 'a checkout change read the session lists').toBe(0);
  });
});

describe('W6: a reopened stream reads what is on screen once, a few at a time', () => {
  it('after the browser was offline and came back online', async () => {
    h.watches = FOLLOWING;
    h.latency = 100;
    const projects = Array.from({ length: 6 }, (_, i) => projectSessionsQuery({ projectId: `P${i}`, view: 'open' }));
    const client = await mount(
      <OnScreen queries={[
        OPEN_LIST, workspaceSessionCountsQuery(), watchesQuery(), sessionQuery('S1'), sessionDiffQuery('S1'),
        workspacesQuery(), openProjectsQuery(), sessionTagsQuery(), ...projects,
      ]} />,
    );
    await advance(2_000);
    await open();
    const from = mark();
    let busiest = 0;
    const unsubscribe = client.getQueryCache().subscribe(() => {
      busiest = Math.max(busiest, client.isFetching());
    });

    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    await drop();
    await advance(40_000);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(1_000);
    await open();
    await advance(10_000);
    unsubscribe();

    const once = (what: string, match: (path: string) => boolean, n = 1): void => {
      expect(reads(match, from), `${what} was not read exactly once`).toBe(n);
    };
    once('the Open list', isOpenList);
    once('the counts', exactly('/sessions/counts'));
    once('the watches', startsWith('/watches'), WATCH_READS);
    once('the open session', exactly('/sessions/S1'));
    once('the workspaces', exactly('/workspaces'));
    once('the sidebar', exactly('/projects/sidebar'));
    once('the tags', exactly('/session-tags'));
    for (let i = 0; i < 6; i += 1) once(`project P${i}`, projectRead(`P${i}`));
    expect(reads(exactly('/sessions/S1/diff'), from), 'the diff is the console’s own read').toBe(0);
    expect(busiest, 'the reopened stream sent its reads all at once').toBeLessThanOrEqual(4);
  });
});

describe('W4: a workspace list places its projects with one read', () => {
  // Thirty projects, none of whose coordinators the list holds: on a page load that was an Open read a
  // project and a Completed one after it, some sixty requests (2026-11-21).
  const thirty = Array.from({ length: 30 }, (_, i) => member(`M${i}`, `P${i}`));
  const memberEvent = (i: number) =>
    publish('session.updated', { id: `M${i}`, projectMembership: { projectId: `P${i}`, role: 'TASK' } }, `M${i}`);

  it('reads once on load for 30 projects, not 30 to 60', async () => {
    await mount(<ProjectReads sessions={thirty} />);
    await open();
    await advance(5_000);
    expect(reads(startsWith('/sessions?projectId=')), 'a project was read on its own').toBe(0);
    expect(reads(placementRead(...thirty.map((s) => s.projectMembership!.projectId))), 'not one placement read').toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('re-reads at most once a window for member events, and not for a project it does not show', async () => {
    await mount(<ProjectReads sessions={thirty} />);
    await open();
    await advance(2_000);
    let from = mark();

    // A burst about one project: one read, a window after the first event.
    for (let n = 0; n < 5; n += 1) {
      await memberEvent(3);
      await advance(150);
    }
    await advance(1_000);
    expect(reads(placementRead(), from), 'a burst for one project was not read exactly once').toBe(1);

    // Events every 300 ms for 6 s: never two reads inside one window, and never put off for good.
    from = mark();
    for (let n = 0; n < 20; n += 1) {
      await memberEvent(n % 2 === 0 ? 3 : 7);
      await advance(300);
    }
    await advance(1_000);
    const times = h.calls.slice(from).filter((call) => placementRead()(call.path)).map((call) => call.at);
    expect(times.length, 'six seconds of events were never read').toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1], 'two placement reads inside one window').toBeGreaterThanOrEqual(1_000);
    }

    // A project this list does not show.
    from = mark();
    await publish('session.updated', { id: 'X', projectMembership: { projectId: 'P99', role: 'TASK' } }, 'X');
    await advance(2_000);
    expect(reads(placementRead(), from), 'another project’s event read the placement').toBe(0);
  });

  it('reads once a minute while the stream is live and nothing happens', async () => {
    await mount(<ProjectReads sessions={thirty} />);
    await open();
    const from = mark();
    await live(5 * 60_000);
    const n = reads(placementRead(), from);
    expect(n, 'the safety read did not come').toBeGreaterThanOrEqual(4);
    expect(n, 'the safety read came more than once a minute').toBeLessThanOrEqual(5);
    expect(reads(startsWith('/sessions?projectId='), from)).toBe(0);
  });

  it('reads nothing while the tab is hidden, and once when it is back in view', async () => {
    await mount(<ProjectReads sessions={thirty} />);
    await open();
    await advance(2_000);
    await show('hidden');
    const from = mark();
    for (let n = 0; n < 5; n += 1) await memberEvent(n);
    await live(5 * 60_000);
    expect(reads(placementRead(), from), 'a hidden tab read the placement').toBe(0);
    await show('visible');
    await advance(2_000);
    expect(reads(placementRead(), from), 'back in view, the placement was not read exactly once').toBe(1);
  });
});

/**
 * A tab hidden long enough for the browser to freeze it: its clock moves on, and no timer of its own
 * fires (on 2026-11-22 one tab made no request at all for two hours, its stream killed by a deploy in
 * between). Whatever the browser held for it is delivered when it wakes.
 */
async function freeze(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
}

/** The console's reads of one workspace as WorkspaceView makes them: its whole Open list (the `since=` delta
 *  read) and the selected session's detail, both on the list budget's interval. */
function ConsoleReads(): null {
  const controlLive = useControlPlaneLive();
  useQuery({ ...sessionsQuery({ runnerId: 'R1', workspaceId: 'W1', view: 'open' }), refetchInterval: (query) => listPollMs(controlLive, query) });
  useQuery({ ...sessionQuery('S9'), refetchInterval: (query) => listPollMs(controlLive, query, 5_000) });
  return null;
}
const isSinceRead = (path: string): boolean =>
  path.startsWith('/sessions?runnerId=R1&workspaceId=W1&view=open&since=');
const isDetail = exactly('/sessions/S9');

/** The server is still down: every stream asked for fails at once, for `ms`. */
async function streamsFailFor(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) {
    const es = current();
    if (es) await act(async () => es.onerror?.());
    await advance(Math.min(250, left));
  }
}

describe('a stream lost while the tab was hidden', () => {
  for (const how of ['its error is delivered as the tab wakes', 'the socket just went silent'] as const) {
    it(`is asked for again as the tab comes back into view, and keeps being asked for with its backoff (${how})`, async () => {
      await mount(<ConsoleReads />);
      await open();
      const asked = FakeEventSource.all.length;
      await show('hidden');
      await freeze(60 * 60_000);
      if (how === 'its error is delivered as the tab wakes') await drop();

      await show('visible');
      expect(FakeEventSource.all.length, 'back in view, the stream was not asked for again').toBe(asked + 1);
      expect(current(), 'the stream asked for on return was closed').toBeDefined();

      // The server is still restarting: each failure waits out the next step of the backoff, which counts on from
      // the drop the tab woke to (1 s, 2 s, 3 s … plus up to 0.5 s of jitter).
      for (let failure = 2; failure <= 4; failure += 1) {
        const before = FakeEventSource.all.length;
        await drop();
        await advance(1_000 * failure - 20);
        expect(FakeEventSource.all.length, `asked again before the backoff of failure ${failure} was up`).toBe(before);
        await advance(520);
        expect(FakeEventSource.all.length, `not asked again after failure ${failure}`).toBe(before + 1);
      }
    });
  }

  it('reads the Open list and the session once on return, then at most once in 30 s while it stays down', async () => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0.5); // every poll 10 % past its step
    await mount(<ConsoleReads />);
    await open();
    await show('hidden');
    await freeze(60 * 60_000);
    await drop();

    const from = mark();
    const returnedAt = Date.now();
    await show('visible');
    await streamsFailFor(25_000);
    expect(reads(isSinceRead, from), 'the Open list was not read exactly once on return').toBe(1);
    expect(reads(isDetail, from), 'the session was not read exactly once on return').toBe(1);

    await streamsFailFor(5 * 60_000);
    for (const [what, match] of [['the Open list', isSinceRead], ['the session', isDetail]] as const) {
      const times = h.calls.slice(from).filter((call) => match(call.path)).map((call) => call.at - returnedAt);
      expect(times[0], `${what} was not read on return`).toBeLessThan(1_000);
      const gaps = times.slice(1).map((at, i) => at - times[i]);
      expect(gaps.length, `${what} was not polled while the stream stayed down`).toBeGreaterThanOrEqual(8);
      expect(Math.min(...gaps), `${what} was read more often than once in 30 s`).toBeGreaterThanOrEqual(30_000);
      expect(Math.max(...gaps), `${what} was not read by its jittered 30 s step`).toBeLessThanOrEqual(33_500);
    }
  });

  it('reads each list once on return when the stream reopens at once', async () => {
    await mount(<ConsoleReads />);
    await open();
    await show('hidden');
    await freeze(60 * 60_000);
    await drop();

    const from = mark();
    await show('visible');
    await open();
    await live(50_000);
    expect(reads(isSinceRead, from), 'the return and the reopened stream each read the Open list').toBe(1);
    expect(reads(isDetail, from), 'the return and the reopened stream each read the session').toBe(1);
  });

  it('does not read the Open list again because its answer was unchanged (a 304)', async () => {
    await mount(<ConsoleReads />);
    await open();
    await publish('sessions.list_changed', { version: 'v1' });
    await advance(1_500);
    const from = mark();
    await publish('sessions.list_changed', { version: 'v2' });
    await advance(1_500);
    expect(reads(isSinceRead, from), 'the hint was not read once').toBe(1);
    await live(55_000);
    expect(reads(isSinceRead, from), 'an unchanged answer was read again').toBe(1);
  });
});
