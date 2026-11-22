// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { forgetOpenListCursors } from './openListDelta';
import {
  activeTasksQuery,
  ownerRequestsQuery,
  sessionCreatedTasksQuery,
  sessionQuery,
  sessionsQuery,
  taskCountsQuery,
} from './queries';
import { guestSessionsQuery } from '../components/SharedWithMe';
import { anySessionQuery } from '../components/WelcomeCard';
import { schedulesQuery, sessionScheduleCardsQuery } from './schedules';

/**
 * A session's event reads again only the views that can show that session (task 350wwd0BfOJPegSAOYpPY).
 *
 * On 2026-11-20 a web tab on one session's page read, about once a second under load, everything that declared
 * `session`: owner-requests, schedules, guest-sessions, another session's created-tasks and schedule-cards, and the
 * workspace's Scheduled runs folder, which the server builds whole on every read. Here a burst of events for one
 * session in workspace A reaches workspace A's list and nothing else on screen, once per coalescing window.
 */

// Every read goes through the recorder: `api` itself, and the two helpers that call api.ts's own copy of it.
const h = vi.hoisted(() => {
  const h = {
    asked: [] as string[],
    answer: (_path: string): unknown => null,
    // The owner requests the open list answers with.
    openRequests: [{ id: 'q1', state: 'PENDING', askedBySessionId: 'S3' }] as { id: string; state: string; askedBySessionId: string }[],
    record: async (path: string): Promise<unknown> => {
      h.asked.push(path);
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
  listGuestSessions: vi.fn(() => h.record('/guest-sessions')),
}));

const row = (id: string, lifecycleState = 'OPEN') => ({ id, title: id, status: 'IDLE', lifecycleState, createdAt: '2026-11-01T00:00:00Z' });

// What each workspace holds: S1 and the task run T1 are open in A, S9 (the other session, whose page is open) and S7 in B, R1 is a
// scheduled run in A's Scheduled runs folder.
function answer(path: string): unknown {
  if (path.startsWith('/sessions?')) {
    const q = new URLSearchParams(path.slice('/sessions?'.length));
    const ws = q.get('workspaceId');
    if (q.get('limit') === '1') return [row('S1')];
    if (q.get('scheduled') === '1') return [row('R1')];
    if (q.get('view') === 'completed') return [row(ws === 'A' ? 'C1' : 'C9', 'COMPLETED')];
    if (q.has('since')) {
      if (q.get('since')) return { full: false, upserts: [], removedIds: [], cursor: 'c1' };
      return { full: true, sessions: ws === 'A' ? [row('S1'), row('T1')] : [row('S9'), row('S7')], cursor: 'c1' };
    }
    return [];
  }
  if (path.startsWith('/tasks/active')) return { queuedCount: 0, runningCount: 1, items: [] };
  if (path.startsWith('/tasks/counts')) return { total: 1, running: 1, queued: 0, done: 0, failed: 0 };
  if (path === '/owner-requests?state=open') return { requests: h.openRequests };
  if (path.startsWith('/owner-requests')) return { requests: [] };
  if (path.startsWith('/schedules')) return { schedules: [] };
  if (path.startsWith('/guest-sessions')) return { sessions: [] };
  if (path.endsWith('/created-tasks')) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] };
  if (path.endsWith('/schedule-cards')) return { cards: [] };
  if (path.startsWith('/sessions/')) return { id: path.split('/')[2], workspace: { id: 'B' } };
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
let visibility: DocumentVisibilityState = 'visible';

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function publish(type: string, sessionId: string, agentId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    latest().onmessage?.({ data: JSON.stringify({ type, sessionId, agentId, ts: '2026-11-20T15:40:00Z', data }) });
  });
}

/** One session's event, as the server sends it: the envelope names the session and its workspace. */
const sessionEvent = (type: string, id: string, workspace: string) =>
  publish(type, id, workspace, type.startsWith('session.') ? { id, agentId: workspace } : {});

const views = {
  openA: sessionsQuery({ runnerId: 'R', workspaceId: 'A', view: 'open' }),
  openB: sessionsQuery({ runnerId: 'R', workspaceId: 'B', view: 'open' }),
  completedA: sessionsQuery({ runnerId: 'R', workspaceId: 'A', view: 'completed' }),
  completedB: sessionsQuery({ runnerId: 'R', workspaceId: 'B', view: 'completed' }),
  scheduledA: sessionsQuery({ runnerId: 'R', workspaceId: 'A', view: 'open', scheduled: true }),
  ownerRequests: ownerRequestsQuery('all'),
  schedules: schedulesQuery(),
  guestSessions: guestSessionsQuery(),
  // The page of another session, S9, in workspace B.
  otherDetail: sessionQuery('S9'),
  otherCreatedTasks: sessionCreatedTasksQuery('S9'),
  otherScheduleCards: sessionScheduleCardsQuery('S9'),
  // The task page's reads, every project's and project P1's, and the welcome card's.
  activeTasks: activeTasksQuery(),
  taskCounts: taskCountsQuery(),
  activeTasksP1: activeTasksQuery(undefined, 'P1'),
  taskCountsP2: taskCountsQuery(undefined, [], undefined, 'P2'),
  welcomeOpen: anySessionQuery('open'),
  welcomeCompleted: anySessionQuery('completed'),
  // Waiting on you, and the badge: the open owner requests. Mounted only where a case says so.
  ownerRequestsOpen: ownerRequestsQuery('open'),
};
type View = keyof typeof views;

/** The request each view makes, so a recorded path names the view that made it. */
function viewOf(path: string): string {
  if (path.startsWith('/sessions?')) {
    const q = new URLSearchParams(path.slice('/sessions?'.length));
    const ws = q.get('workspaceId');
    if (q.get('limit') === '1') return `welcome-${q.get('view')}`;
    if (q.get('scheduled') === '1') return `scheduled${ws}`;
    return `${q.get('view')}${ws}`;
  }
  if (path.startsWith('/tasks/active')) return path.includes('projectId=P1') ? 'activeTasksP1' : 'activeTasks';
  if (path.startsWith('/tasks/counts')) return path.includes('projectId=P2') ? 'taskCountsP2' : 'taskCounts';
  if (path === '/owner-requests?state=open') return 'ownerRequestsOpen';
  if (path.startsWith('/owner-requests')) return 'ownerRequests';
  if (path.startsWith('/schedules')) return 'schedules';
  if (path.startsWith('/guest-sessions')) return 'guestSessions';
  if (path === '/sessions/S9/created-tasks') return 'otherCreatedTasks';
  if (path === '/sessions/S9/schedule-cards') return 'otherScheduleCards';
  if (path === '/sessions/S9') return 'otherDetail';
  return path;
}
const reads = (): string[] => h.asked.map(viewOf).sort();

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

/** The views on screen, each as its factory defines it (its own poll included). */
async function onScreen(client: QueryClient, which: View[] = (Object.keys(views) as View[]).filter((view) => view !== 'ownerRequestsOpen')): Promise<void> {
  for (const name of which) {
    const observer = new QueryObserver(client, views[name] as unknown as QueryObserverOptions);
    observers.push(observer.subscribe(() => {}));
  }
  await advance(0);
}

/** The stream opens; `hinted` delivers the Open list's hint the server sends a connection that declared it. */
async function openStream(hinted: boolean): Promise<void> {
  await act(async () => latest().onopen?.());
  if (hinted) await publish('sessions.list_changed', '', null, { version: 'v1' });
  await advance(1_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  FakeEventSource.open = [];
  h.asked = [];
  h.answer = answer;
  h.openRequests = [{ id: 'q1', state: 'PENDING', askedBySessionId: 'S3' }];
  forgetOpenListCursors();
});

afterEach(() => {
  for (const stop of observers) stop();
  observers = [];
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a session event reads only the views that can show that session', () => {
  it('a burst for one session in workspace A reads workspace A\'s list once, and nothing else on screen', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    // A turn of S1: status, an approval asked and answered, a background job ending, the turn's end.
    await sessionEvent('session.updated', 'S1', 'A');
    await advance(100);
    await sessionEvent('approval.requested', 'S1', 'A');
    await advance(100);
    await sessionEvent('approval.resolved', 'S1', 'A');
    await advance(100);
    await sessionEvent('background.task', 'S1', 'A');
    await advance(100);
    await sessionEvent('session.updated', 'S1', 'A');
    await advance(1_000);

    // The Open list follows its hint, not the events; the Completed list of A is the one read S1 can be in.
    expect(reads()).toEqual(['completedA']);
  });

  it('reads at most once per coalescing window however long the burst lasts', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    for (let i = 0; i < 30; i += 1) {
      await sessionEvent(i % 3 === 0 ? 'approval.requested' : 'session.updated', 'S1', 'A');
      await advance(100);
    }
    await advance(1_000);

    // 3 s of events, one window a second: three reads of workspace A's list at most, and nothing else.
    const made = reads();
    expect(new Set(made)).toEqual(new Set(['completedA']));
    expect(made.length).toBeGreaterThanOrEqual(1);
    expect(made.length).toBeLessThanOrEqual(3);
  });

  it('an event of the session whose page is open reads that page and its workspace\'s list, and no other', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    await sessionEvent('session.updated', 'S9', 'B');
    await advance(1_000);

    // Not its schedule cards: an ordinary session's cards move on `schedule_cards.changed`, never on its session
    // events (useControlPlane.readOwners.test.tsx, task 351uKarlHnsbndjGV4n7i).
    expect(reads()).toEqual(['completedB', 'otherCreatedTasks', 'otherDetail']);
  });

  it('a task run\'s events read the task page once a window, its own project\'s and not another\'s', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    // T1 runs task K1 of project P1, in workspace A: its summary names both. A turn's events, then an approval,
    // which names neither (the stream remembers what the summary said).
    const summary = { id: 'T1', agentId: 'A', taskId: 'K1', projectMembership: { projectId: 'P1', role: 'TASK' } };
    await publish('session.updated', 'T1', 'A', summary);
    await advance(200);
    await publish('session.updated', 'T1', 'A', summary);
    await advance(200);
    await publish('approval.requested', 'T1', 'A', { approvalId: 'ap1' });
    await advance(1_000);

    expect(reads()).toEqual(['activeTasks', 'activeTasksP1', 'completedA', 'taskCounts']);

    // The approval alone, in a window of its own: the run it is about is still known.
    h.asked = [];
    await publish('approval.resolved', 'T1', 'A', { approvalId: 'ap1' });
    await advance(1_000);
    expect(reads()).toEqual(['activeTasks', 'activeTasksP1', 'completedA', 'taskCounts']);

    // A run busy for 3 s: each task read at most once a window.
    h.asked = [];
    for (let i = 0; i < 30; i += 1) {
      await publish('session.updated', 'T1', 'A', summary);
      await advance(100);
    }
    await advance(1_000);
    const made = reads();
    for (const view of ['activeTasks', 'activeTasksP1', 'taskCounts']) {
      const times = made.filter((read) => read === view).length;
      expect(times).toBeGreaterThanOrEqual(1);
      expect(times).toBeLessThanOrEqual(3);
    }
    expect(new Set(made)).toEqual(new Set(['activeTasks', 'activeTasksP1', 'completedA', 'taskCounts']));
  });

  it('the open owner requests follow only owner_requests.changed; the whole history only a request coming or going', async () => {
    const client = await mount();
    await onScreen(client, ['ownerRequestsOpen', 'ownerRequests']);
    await openStream(true);
    h.asked = [];

    // 3 s of other sessions' turns: neither the open list nor the history is read.
    for (let i = 0; i < 30; i += 1) {
      await sessionEvent('session.updated', i % 2 ? 'S1' : 'S9', i % 2 ? 'A' : 'B');
      await advance(100);
    }
    await advance(1_000);
    expect(reads().filter((view) => view.startsWith('ownerRequests'))).toEqual([]);

    // S5 files a request: the server says so. The open list is read once, shows the new request, and the history
    // is read once after it.
    h.asked = [];
    h.openRequests = [...h.openRequests, { id: 'q2', state: 'PENDING', askedBySessionId: 'S5' }];
    await publish('owner_requests.changed', '', null, { version: 'r2' });
    await publish('owner_requests.changed', '', null, { version: 'r3' });
    await advance(1_000);
    expect(reads().filter((view) => view.startsWith('ownerRequests'))).toEqual(['ownerRequests', 'ownerRequestsOpen']);

    // The owner answers it elsewhere: the request leaves the open list.
    h.asked = [];
    h.openRequests = h.openRequests.filter((request) => request.id !== 'q2');
    await publish('owner_requests.changed', '', null, { version: 'r4' });
    await advance(1_000);
    expect(reads().filter((view) => view.startsWith('ownerRequests'))).toEqual(['ownerRequests', 'ownerRequestsOpen']);
  });

  it('only a session entering or leaving the lists reads the welcome card', async () => {
    const client = await mount();
    await onScreen(client, ['welcomeOpen', 'welcomeCompleted']);
    await openStream(true);
    h.asked = [];

    await sessionEvent('session.updated', 'S1', 'A');
    await sessionEvent('approval.requested', 'S1', 'A');
    await advance(1_000);
    expect(reads()).toEqual([]);

    await sessionEvent('session.created', 'S2', 'A');
    await advance(1_000);
    expect(reads()).toEqual(['welcome-completed', 'welcome-open']);

    h.asked = [];
    await publish('session.ended', 'S2', 'A', { status: 'SUCCEEDED', lifecycleState: 'COMPLETED' });
    await advance(1_000);
    expect(reads()).toEqual(['welcome-completed', 'welcome-open']);
  });

  it('before the hint, the Open list of the session\'s workspace is read, not another workspace\'s', async () => {
    const client = await mount();
    await onScreen(client, ['openA', 'openB']);
    await openStream(false);
    h.asked = [];

    await sessionEvent('session.updated', 'S1', 'A');
    await advance(1_000);
    expect(reads()).toEqual(['openA']);

    // A session that moved from B to A: B still holds it, so B's list is read too.
    h.asked = [];
    await sessionEvent('session.updated', 'S7', 'A');
    await advance(1_000);
    expect(reads()).toEqual(['openA', 'openB']);
  });

  it('the Scheduled runs folder is read only for an event that can change it', async () => {
    const client = await mount();
    await onScreen(client, ['openA', 'scheduledA']);
    await openStream(true);

    // A session the Open list holds is not a scheduled run.
    h.asked = [];
    await sessionEvent('session.updated', 'S1', 'A');
    await advance(1_000);
    expect(reads()).toEqual([]);

    // A run the folder holds.
    await sessionEvent('session.updated', 'R1', 'A');
    await advance(1_000);
    expect(reads()).toEqual(['scheduledA']);

    // A session of workspace A that no list holds may be a new scheduled run.
    h.asked = [];
    await sessionEvent('session.updated', 'R2', 'A');
    await advance(1_000);
    expect(reads()).toEqual(['scheduledA']);

    // A scheduled run's creation publishes nothing, so a creation is never one; nor is another workspace's session.
    h.asked = [];
    await sessionEvent('session.created', 'S5', 'A');
    await sessionEvent('session.updated', 'S6', 'B');
    await advance(1_000);
    expect(reads()).toEqual([]);
  });

  it('owner-wide reads keep their safety read: once a minute while the stream is live, whatever the events', async () => {
    const client = await mount();
    await onScreen(client, ['ownerRequests', 'schedules', 'guestSessions']);
    await openStream(true);
    h.asked = [];

    // 61 s of a busy account, with the server's keepalive every 20 s.
    for (let s = 1; s <= 61; s += 1) {
      await sessionEvent('session.updated', `S${s % 4}`, s % 2 ? 'A' : 'B');
      if (s % 20 === 0) await publish('ping', '', null);
      await advance(1_000);
    }

    expect(reads()).toEqual(['guestSessions', 'ownerRequests', 'schedules']);
  });

  it('a hidden tab reads nothing on a session event, and reads the reached views once when it is back', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    visibility = 'hidden';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await sessionEvent('session.updated', 'S9', 'B');
    await sessionEvent('session.updated', 'S1', 'A');
    await advance(5_000);
    expect(reads()).toEqual([]);

    visibility = 'visible';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(1_000);
    // Its schedule cards are not among them, as above.
    expect(reads()).toEqual(['completedA', 'completedB', 'otherCreatedTasks', 'otherDetail']);
  });

  it('an event type the client does not map reads nothing', async () => {
    const client = await mount();
    await onScreen(client);
    await openStream(true);
    h.asked = [];

    await publish('runner.changed', 'S1', 'A', { id: 'R' });
    await publish('notification', 'S1', 'A', {});
    await publish('something.new', 'S1', 'A', {});
    await advance(2_000);

    expect(reads()).toEqual([]);
  });
});

describe('no list read is a bare GET /sessions', () => {
  // The "bare poller" of 2026-11-20 (Chrome/158 on /sessions/350NHHdJEaTpbqypVQOi9) was no bare read: the production
  // access log has no `GET /api/sessions` without a query string from that tab. Grouped by query string, its
  // `/sessions/counts`, `/sessions/:id/created-tasks` and `/sessions/:id/schedule-cards` reads (all without one)
  // looked like it. The two cards are the session-event over-reads above. This pins that the list reader cannot
  // send one either: with no view it reads the Open list, the server's default, as the Open list is read.
  it.each([
    ['no options', {}],
    ['every option null', { runnerId: null, workspaceId: null, view: null, tagId: null, limit: null }],
  ])('with %s, the list reader names its view', async (_name, opts) => {
    const query = sessionsQuery(opts);
    await (query.queryFn as () => Promise<unknown>)();
    expect(h.asked).toEqual(['/sessions?view=open&since=']);
  });
});
