// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { listPollMs } from './listBudget';
import { projectIntegrationQuery, sessionCreatedTasksQuery, sessionQuery } from './queries';
import { sessionScheduleCardsQuery } from './schedules';
import { ProjectIntegrationLine } from '../components/ProjectIntegrationLine';
import { LandingJobsSheet } from '../components/LandingJobsSheet';
import * as scheduleCards from '../components/ScheduleCards';

/**
 * What a busy session page reads while the control-plane stream is online (task 351uKarlHnsbndjGV4n7i, project
 * criterion 5H45pvgKd1UpxD5Lg4Oi4Y): created tasks, schedule cards, the project's integration line and the session's
 * detail are read only on an event that can change their answer, each with a safety read at most once a minute, and
 * one read serves every part of the page that shows them — no request repeats exactly within a second.
 *
 * On 2026-11-22 the owner's tab read created tasks every 15 s while one of them ran (127 of 139 answered 304), schedule
 * cards on every session, approval and background event of the session (112 of 120 were 304), and the integration line
 * and the detail once per component that drew them, 17 exact repeats within a second.
 */

const h = vi.hoisted(() => {
  const h = {
    asked: [] as Array<{ path: string; at: number }>,
    answer: (_path: string): unknown => null,
    record: async (path: string): Promise<unknown> => {
      h.asked.push({ path, at: Date.now() });
      return h.answer(path);
    },
  };
  return h;
});
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  api: vi.fn((path: string) => h.record(path)),
  getSession: vi.fn((id: string) => h.record(`/sessions/${id}`)),
}));

/** S1's agent created T1 (running) and T2; R5 is the run of T1. */
const createdTasks = {
  total: 2,
  running: 1,
  failed: 0,
  done: 0,
  items: [
    { id: 'T1', title: 'One', status: 'OPEN', running: true, queued: false, createdAt: '2026-11-22T07:00:00Z', projectId: null, replaces: null },
    { id: 'T2', title: 'Two', status: 'OPEN', running: false, queued: false, createdAt: '2026-11-22T06:00:00Z', projectId: null, replaces: null },
  ],
  projects: [],
};
const openRun = { id: 'run1', scheduleId: 'sch1', sessionId: 'R1', state: 'RUNNING', endedAt: null, plannedAt: '2026-11-22T07:00:00Z', trigger: 'SCHEDULED' };
let runEnded = false;
const integration = {
  projectId: 'P1',
  line: { mode: 'LAND' },
  ref: 'orbit/p1',
  upstreamRef: 'main',
  inFlight: null,
  inFlightJobs: [],
  queued: 0,
  integrated: [],
};

function answer(path: string): unknown {
  if (path.startsWith('/sessions?')) return [];
  if (path.endsWith('/created-tasks')) return createdTasks;
  if (path === '/sessions/R1/schedule-cards') {
    return { cards: [], records: [], run: runEnded ? { ...openRun, state: 'NO_CHANGE', endedAt: '2026-11-22T07:10:00Z' } : openRun };
  }
  if (path.endsWith('/schedule-cards')) return { cards: [], records: [], run: null };
  if (path.startsWith('/projects/P1/integration')) return integration;
  if (path.startsWith('/projects/P1/open-items')) return { items: [] };
  if (path.startsWith('/sessions/')) return { id: path.split('/')[2], status: 'IDLE', lifecycleState: 'OPEN', workspace: { id: 'A' } };
  return {};
}

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
const latest = (): FakeEventSource => FakeEventSource.open[FakeEventSource.open.length - 1];

let root: Root | null = null;
let observers: Array<() => void> = [];
let client: QueryClient;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function publish(type: string, sessionId: string, agentId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    latest().onmessage?.({ data: JSON.stringify({ type, sessionId, agentId, ts: '2026-11-22T07:30:00Z', data }) });
  });
}

/** Time passing with the stream online: the server's keepalive comes every 20 s, as it does (EventsController). */
async function online(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20_000) {
    await advance(Math.min(20_000, left));
    await publish('ping', '', null);
  }
}

/** A session's own `session.updated`, as the server sends it: the summary names its task when it runs one. */
const sessionUpdated = (id: string, taskId: string | null = null) =>
  publish('session.updated', id, 'A', { id, agentId: 'A', taskId, status: 'RUNNING', runStatus: 'RUNNING', lifecycleState: 'OPEN' });

async function render(children: ReactNode): Promise<void> {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ControlPlaneProvider>{children}</ControlPlaneProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function observe(options: unknown): Promise<void> {
  const observer = new QueryObserver(client, options as QueryObserverOptions);
  observers.push(observer.subscribe(() => {}));
  await advance(0);
}

/** The stream opens and the server's first Open-list hint arrives, as it does about a second after connecting. */
async function openStream(): Promise<void> {
  await act(async () => latest().onopen?.());
  await publish('sessions.list_changed', '', null, { version: 'v1' });
  await advance(1_000);
}

const readsOf = (path: string): number[] => h.asked.filter((r) => r.path === path).map((r) => r.at);

/** Every request that went out again, exactly, within a second of the same one. */
function repeatsWithinASecond(): string[] {
  const last = new Map<string, number>();
  const repeats: string[] = [];
  for (const { path, at } of h.asked) {
    const before = last.get(path);
    if (before !== undefined && at - before < 1_000) repeats.push(`${path} after ${at - before} ms`);
    last.set(path, at);
  }
  return repeats;
}

/** How many observers of a cached read poll it on an interval of their own. */
function intervalsOn(queryKey: readonly unknown[]): number {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  return (query?.observers ?? []).filter((observer) => {
    const every = observer.options.refetchInterval;
    const ms = typeof every === 'function' ? every(query as never) : every;
    return observer.options.enabled !== false && typeof ms === 'number' && ms > 0;
  }).length;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T07:30:00Z'));
  vi.stubGlobal('EventSource', FakeEventSource);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  FakeEventSource.open = [];
  h.asked = [];
  h.answer = answer;
  runEnded = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render(<div />);
  await openStream();
  h.asked = [];
});

afterEach(() => {
  for (const off of observers) off();
  observers = [];
  act(() => root?.unmount());
  root = null;
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('created tasks, while the stream is online', () => {
  it('are read at most once a minute while one of them runs', async () => {
    await observe(sessionCreatedTasksQuery('S1'));
    await online(5 * 60_000);
    const reads = readsOf('/sessions/S1/created-tasks');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < reads.length; i += 1) expect(reads[i] - reads[i - 1]).toBeGreaterThanOrEqual(60_000);
  });

  it('are not read for a task another session created, and are for one of their own', async () => {
    await observe(sessionCreatedTasksQuery('S1'));
    h.asked = [];
    await publish('task.changed', '', null, { taskId: 'T9', taskIds: ['T9'], resync: false, creatorSessionIds: ['S9'] });
    await advance(2_000);
    expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(0);

    // A task S1's agent created, which this read does not hold yet.
    await publish('task.changed', '', null, { taskId: 'T7', taskIds: ['T7'], resync: false, creatorSessionIds: ['S1'] });
    await advance(2_000);
    expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(1);

    // A row it draws, created elsewhere (the task that took one of S1's over).
    h.asked = [];
    await publish('task.changed', '', null, { taskId: 'T2', taskIds: ['T2'], resync: false, creatorSessionIds: ['S9'] });
    await advance(2_000);
    expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(1);

    // A server that does not say who created the rows, and a resync: either may be about S1's.
    for (const data of [{ taskId: 'T9', taskIds: ['T9'], resync: false }, { taskIds: [], resync: true }]) {
      h.asked = [];
      await publish('task.changed', '', null, data);
      await advance(2_000);
      expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(1);
    }
  });

  it('are read when the run of one of their rows moves, and not for another session\'s', async () => {
    await observe(sessionCreatedTasksQuery('S1'));
    h.asked = [];
    await sessionUpdated('S8', 'T8');
    await advance(2_000);
    expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(0);
    await sessionUpdated('R5', 'T1');
    await advance(2_000);
    expect(readsOf('/sessions/S1/created-tasks')).toHaveLength(1);
  });
});

describe('schedule cards, while the stream is online', () => {
  it('the stream asks for the schedule-card event', () => {
    expect(latest().url).toContain('schedule_cards');
  });

  it('are not read for the session\'s own session, approval or background events, and are when its cards change', async () => {
    await observe(sessionScheduleCardsQuery('S1'));
    h.asked = [];
    await sessionUpdated('S1');
    await publish('approval.requested', 'S1', 'A', { approvalId: 'ap1', pendingApprovals: 1 });
    await publish('approval.resolved', 'S1', 'A', { approvalId: 'ap1', pendingApprovals: 0 });
    await publish('background.task', 'S1', 'A', { name: 'npm test', status: 'running', toolUseId: 'tu1' });
    await advance(2_000);
    expect(readsOf('/sessions/S1/schedule-cards')).toHaveLength(0);

    await publish('schedule_cards.changed', '', null, { cardSessionIds: ['S9'], resync: false });
    await advance(2_000);
    expect(readsOf('/sessions/S1/schedule-cards')).toHaveLength(0);

    await publish('schedule_cards.changed', '', null, { cardSessionIds: ['S9', 'S1'], resync: false });
    await advance(2_000);
    expect(readsOf('/sessions/S1/schedule-cards')).toHaveLength(1);

    h.asked = [];
    await publish('schedule_cards.changed', '', null, { cardSessionIds: [], resync: true });
    await advance(2_000);
    expect(readsOf('/sessions/S1/schedule-cards')).toHaveLength(1);
  });

  it('a scheduled run\'s session follows its own session events while its run is open, and only then', async () => {
    await observe(sessionScheduleCardsQuery('R1'));
    h.asked = [];
    await publish('approval.requested', 'R1', 'A', { approvalId: 'ap2', pendingApprovals: 1 });
    await advance(2_000);
    expect(readsOf('/sessions/R1/schedule-cards')).toHaveLength(0);
    runEnded = true;
    await sessionUpdated('R1');
    await advance(2_000);
    expect(readsOf('/sessions/R1/schedule-cards')).toHaveLength(1);
    // Its run has ended: what it reported is settled.
    await sessionUpdated('R1');
    await advance(2_000);
    expect(readsOf('/sessions/R1/schedule-cards')).toHaveLength(1);
  });

  it('a conversation\'s cards and its run are drawn from one observer', async () => {
    function Page() {
      const cards = scheduleCards.useSessionScheduleCards('R1');
      const run = scheduleCards.useScheduleRunOfSession('R1', cards);
      scheduleCards.useSessionScheduleInserts('R1', cards, [], run);
      return null;
    }
    await render(<Page />);
    await advance(0);
    const query = client.getQueryCache().find({ queryKey: sessionScheduleCardsQuery('R1').queryKey, exact: true });
    expect(query?.observers.length).toBe(1);
    expect(readsOf('/sessions/R1/schedule-cards')).toHaveLength(1);
  });
});

describe('one read serves the page', () => {
  it('the project integration line has one interval however many parts draw it, and no read repeats within a second', async () => {
    function Page() {
      const [more, setMore] = useState(false);
      const line = useQuery(projectIntegrationQuery('P1'));
      // The landings list mounts once the line has answered, as a sheet opened from it does.
      if (line.data && !more) setTimeout(() => setMore(true), 300);
      return (
        <>
          <ProjectIntegrationLine projectId="P1" started />
          <LandingJobsSheet projectId="P1" open={false} onClose={() => {}} />
          {more ? <ProjectIntegrationLine projectId="P1" started /> : null}
          {more ? <LandingJobsSheet projectId="P1" open={false} onClose={() => {}} /> : null}
        </>
      );
    }
    await render(<Page />);
    await advance(1_000);
    expect(intervalsOn(projectIntegrationQuery('P1').queryKey)).toBe(1);
    // A project page's own event, and the minute's safety read.
    await publish('project.changed', '', null, { id: 'P1' });
    await online(3 * 60_000);
    expect(readsOf('/projects/P1/integration').length).toBeGreaterThanOrEqual(2);
    expect(readsOf('/projects/P1/integration').length).toBeLessThanOrEqual(5);
    expect(repeatsWithinASecond()).toEqual([]);
  });

  it('a task change reads the integration line of the project its rows are in, and no other\'s', async () => {
    await render(<ProjectIntegrationLine projectId="P1" started />);
    await advance(1_000);
    h.asked = [];
    await publish('task.changed', '', null, { taskIds: ['T9'], resync: false, creatorSessionIds: ['S9'], rowProjectIds: ['P2'] });
    await advance(6_000);
    expect(readsOf('/projects/P1/integration')).toHaveLength(0);
    await publish('task.changed', '', null, { taskIds: ['T3'], resync: false, creatorSessionIds: ['S9'], rowProjectIds: ['P1'] });
    await advance(6_000);
    expect(readsOf('/projects/P1/integration')).toHaveLength(1);
    // A server that does not say where its rows are.
    await publish('task.changed', '', null, { taskIds: ['T9'], resync: false });
    await advance(6_000);
    expect(readsOf('/projects/P1/integration')).toHaveLength(2);
  });

  it('no component reads the integration line with useQuery of its own, which would be an interval of its own', () => {
    // The web suite runs from `src/web`; a runner may run it from the repository's root.
    const src = ['src', 'src/web/src'].map((dir) => resolve(process.cwd(), dir)).find((dir) => existsSync(join(dir, 'lib/queries.ts')))!;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(src);
    const direct = files.filter((file) =>
      /useQuery\(\s*(?:\{\s*\.\.\.\s*)?projectIntegrationQuery\(/.test(readFileSync(file, 'utf8')));
    expect(direct.map((file) => relative(src, file))).toEqual([]);
  });

  it('the session detail has one interval however many parts draw it, and no read repeats within a second', async () => {
    // WorkspaceView's own read, which keeps the detail current; the splash's, the side panel's, the console's and the
    // settings drawer's, each mounted as the page comes together.
    function Owner() {
      useQuery({ ...sessionQuery('S1'), refetchInterval: (q) => listPollMs(true, q, 5_000) });
      return null;
    }
    function Reader({ enabled = true }: { enabled?: boolean }) {
      useQuery({ ...sessionQuery('S1'), enabled });
      return null;
    }
    function Page({ step }: { step: number }) {
      return (
        <>
          <Reader />
          {step >= 1 ? <Owner /> : null}
          {step >= 2 ? <Reader /> : null}
          {step >= 3 ? <Reader /> : null}
          <Reader enabled={step >= 4} />
        </>
      );
    }
    for (let step = 0; step <= 4; step += 1) {
      await render(<Page step={step} />);
      await advance(400);
    }
    expect(intervalsOn(sessionQuery('S1').queryKey)).toBe(1);
    await sessionUpdated('S1');
    await online(3 * 60_000);
    expect(readsOf('/sessions/S1').length).toBeGreaterThanOrEqual(2);
    expect(readsOf('/sessions/S1').length).toBeLessThanOrEqual(5);
    expect(repeatsWithinASecond()).toEqual([]);
  });
});
