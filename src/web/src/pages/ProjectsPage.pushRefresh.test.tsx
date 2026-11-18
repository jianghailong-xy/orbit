// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectChainPanoramaQuery, projectChainRankingQuery } from '../components/ProjectChainProgress';
import { projectPanoramaQuery } from '../components/ProjectPanoramaHeader';
import { encodeId } from '../lib/idCodec';
import { projectPanoramaBlockingQuery } from '../lib/queries';
import { ControlPlaneProvider } from '../lib/useControlPlane';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * The 2026-11-13 report: the owner switched a project's Automatic on, the dispatcher started a
 * task within the minute, and the page kept saying `ready` until it was reloaded. Push had no way
 * to reach the project page's reads — the control plane selected them by key shape, and the task
 * tree, its children and the project document were never on that list.
 *
 * S2 replaced the key-shape whitelists with `meta.entities` predicates. This file proves the push
 * actually ARRIVES at the seven reads the report named, and it counts REQUESTS rather than looking
 * at the screen: "this URL was read twice" is the thing a lost event cannot fake, while a row that
 * happens to re-render is not proof of anything.
 *
 * Two events, because the product has two ways for work to move and the report was the second one:
 *
 *  - `task.changed` names tasks, so every read that derives from a task is re-read;
 *  - a member `session.*` names no task — a run starting or ending writes no task row — so the
 *    reads that draw run state (the tree, the queue) have to declare `session` themselves to be
 *    reached. That is the half of the fixture that mirrors the report.
 *
 * Nothing here polls faster than it did: the reads must refresh because the event reached them,
 * not because a `refetchInterval` was added (criterion 5 of the task), so the whole test advances
 * fake time by seconds, far inside every poll's floor.
 */

vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-000000000001';
/** The spelling the route carries and every URL below is built from. */
const PROJECT = encodeId(P1);
const ROOT_TASK = encodeId('0195c0de-0000-7000-8000-000000000101');
const CHILD_TASK = encodeId('0195c0de-0000-7000-8000-000000000102');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000b1');

const BASE = `/api/projects/${PROJECT}`;

/** One row of the project's task page, in the endpoint's shape. The root row has a child so the
 *  page draws the disclosure this file presses to mount the children read. */
const task = (over: Record<string, unknown>) => ({
  title: 'Design the landing page',
  status: 'OPEN',
  parentTaskId: null,
  acceptanceCriteria: 'Passes design review',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  dueDate: null,
  assignee: null,
  childCount: 0,
  unmetCount: 0,
  blocksCount: 0,
  topoLevel: 0,
  dependencyState: 'READY',
  ...over,
});

const TASKS = {
  items: [task({ id: ROOT_TASK, childCount: 1 })],
  nextCursor: null,
};
const CHILDREN = {
  items: [task({ id: CHILD_TASK, title: 'Pick the hero image', parentTaskId: ROOT_TASK })],
  nextCursor: null,
};

/** `GET /projects/:id` — the document the page is built around, and read #3 in the list: its
 *  `tasksByStatus` counts are task state, so a task event has to reach it. */
const DETAIL = {
  id: P1,
  title: 'Website Revamp',
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  instructions: 'Land behind a flag, then flip it',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 2 },
  tasksByStatus: { OPEN: 1, DONE: 1 },
  acceptanceCriteriaItems: [],
  blockers: { open: [], resolved: [], resolvedCount: 0 },
  coordinatorEnabled: true,
  maxConcurrentTasks: 3,
  configRevision: '7',
  startedAt: '2026-09-07T06:00:00.000Z',
  pausedAt: null,
};

/** A chain with a running session: `running: 1` keeps the header out of its dispatch-health read,
 *  and `form: 'chain'` is what mounts the strip and its leaderboard. */
const PANORAMA = {
  buckets: { running: 1, ready: 1, blocked: 0, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0 },
  shape: { taskCount: 2, edgeCount: 1, ratio: 0.5, maxDepth: 1, form: 'chain' },
};

const RANKING = {
  remainingCount: 2,
  items: [{ taskId: ROOT_TASK, title: 'Design the landing page', status: 'OPEN', downstreamBlocked: 1 }],
  truncated: null,
};

const READY = {
  readyCount: 1,
  queuedCount: 0,
  runningCount: 0,
  pausedCount: 0,
  items: [
    {
      taskId: ROOT_TASK,
      title: 'Design the landing page',
      status: 'OPEN',
      runState: 'READY',
      sessionId: null,
      pausedList: null,
    },
  ],
  impactTruncated: null,
};

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (statusCode: number, body: unknown) =>
  ({ ok: false, status: statusCode, statusText: 'Error', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * The page's wire. Every endpoint this file counts is answered; anything else — the cards this
 * test is not about — gets a 500 the way `ProjectsPage.automatic.test.tsx` serves them, so one
 * card's failure stays that card's and the page keeps standing.
 */
function serve(): void {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (method !== 'GET') return failJson(500, { message: `unstubbed write: ${method} ${url}` });
    if (url === BASE) return okJson(DETAIL);
    if (url === `${BASE}/panorama`) return okJson(PANORAMA);
    if (url === `${BASE}/panorama/blocking?limit=5`) return okJson(RANKING);
    if (url === `${BASE}/panorama/ready?limit=5`) return okJson(READY);
    if (url === `${BASE}/tasks/page?limit=100`) return okJson(TASKS);
    if (url === `${BASE}/tasks/page?parentId=${ROOT_TASK}&limit=100`) return okJson(CHILDREN);
    return failJson(500, { message: `unstubbed endpoint: ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** How many times the client asked the server for exactly this URL. */
const requestsTo = (url: string): number =>
  fetchMock.mock.calls.filter(([called]) => String(called) === url).length;

const TREE_URL = `${BASE}/tasks/page?limit=100`;
const CHILDREN_URL = `${BASE}/tasks/page?parentId=${ROOT_TASK}&limit=100`;
const DETAIL_URL = BASE;
const PANORAMA_URL = `${BASE}/panorama`;
const BLOCKING_URL = `${BASE}/panorama/blocking?limit=5`;
const READY_URL = `${BASE}/panorama/ready?limit=5`;

/**
 * The seven reads the task names, each with the key its own site declares and the URL that key
 * reads.
 *
 * Two pairs share a cache entry and therefore a URL, and that is the point rather than a
 * shortcut: `ProjectPanoramaHeader` and `ProjectChainProgress` both declare
 * `['project', id, 'panorama']`, and `ProjectChainProgress`'s inline ranking query and the
 * exported `projectPanoramaBlockingQuery` in `lib/queries.ts` are the same key and the same
 * request. Neither pair is collapsed into one row. Each row takes its key from that site's own
 * declaration, so a site re-keyed away from the shared entry still fails its own row — the entry
 * the row names is no longer on screen — while the other site's row keeps passing.
 */
const SEVEN_READS: Array<{ what: string; url: string; key: readonly unknown[] }> = [
  { what: 'the project task tree (ProjectsPage)', url: TREE_URL, key: ['project', PROJECT, 'tasks', 'root'] },
  {
    what: "a task's children (ProjectsPage)",
    url: CHILDREN_URL,
    key: ['project', PROJECT, 'tasks', 'children', ROOT_TASK],
  },
  { what: 'the project document and its tasksByStatus counts (ProjectsPage)', url: DETAIL_URL, key: ['project', PROJECT] },
  {
    what: 'the panorama (ProjectPanoramaHeader)',
    url: PANORAMA_URL,
    key: projectPanoramaQuery(PROJECT).queryKey,
  },
  {
    what: 'the panorama (ProjectChainProgress)',
    url: PANORAMA_URL,
    key: projectChainPanoramaQuery(PROJECT).queryKey,
  },
  {
    what: 'the blocking leaderboard (ProjectChainProgress)',
    url: BLOCKING_URL,
    key: projectChainRankingQuery(PROJECT).queryKey,
  },
  {
    what: 'the blocking leaderboard (projectPanoramaBlockingQuery)',
    url: BLOCKING_URL,
    key: projectPanoramaBlockingQuery(PROJECT).queryKey,
  },
];

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const controlStream = (): FakeEventSource => FakeEventSource.all[FakeEventSource.all.length - 1];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Fake timers, because the project page's reads are floored at PROJECT_PAGE_MIN_INTERVAL_MS
  // (5s): what the stream asks for waits in a coalescing window, and the assertions only mean
  // something once that window has passed.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // Node ≥24 defines its own `localStorage` on globalThis, and vitest's jsdom environment leaves
  // that one in place — where it is `undefined`. The page reads a token on every request, and the
  // stream only opens when there is one, so this stub is what makes the provider connect at all.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'orbit_token' ? 'token' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  FakeEventSource.all = [];
  serve();
});

afterEach(async () => {
  try {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
  } finally {
    container?.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Advance fake time, flushing the promises the fetches behind it resolve with. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      const seen = [TREE_URL, CHILDREN_URL, DETAIL_URL, PANORAMA_URL, BLOCKING_URL, READY_URL]
        .map((url) => `${requestsTo(url)} ${url}`)
        .join('\n');
      throw new Error(`timed out waiting for ${what}\nrequests:\n${seen}\npage:\n${container?.textContent ?? ''}`);
    }
    await flush(10);
  }
}

/** Render the project detail page inside the control plane, as AppShell mounts it. */
async function mount(): Promise<QueryClient> {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        // A read with an answer on screen is not read again just because another observer of the
        // same key mounted — the acceptance card joins `['project', id]` a tick after the page
        // itself does, and with the app's zero staleTime that second mount is a second request.
        // That mount-time duplicate is not what this file is about: everything counted below has
        // to be the stream's explicit refetch, which invalidates and fetches regardless of
        // staleness, so holding unanswered-for reads fresh only removes the noise.
        staleTime: Infinity,
      },
      mutations: { retry: false },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider>
          <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
            <Routes>
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  // The stream opens as it does in a tab: `onopen` marks it live. Nothing is re-read for that
  // (the page's first stream follows the snapshot it just read), so every count below is the
  // event's doing.
  await act(async () => controlStream().onopen?.());
  return client;
}

/** Open the root task's subtask level, which is the only way that read mounts (and the only way
 *  the page ever asks for it). */
async function expand(): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show subtasks for Design the landing page"]',
  );
  expect(button, 'the task row has no disclosure to open its children with').not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await waitFor(() => requestsTo(CHILDREN_URL) === 1, "the task's children to be read once");
}

/** Mount the page with every one of the seven reads on screen, each read exactly once. */
async function mountWithTheSevenReadsOnScreen(): Promise<QueryClient> {
  const client = await mount();
  await waitFor(
    () => [TREE_URL, DETAIL_URL, PANORAMA_URL, BLOCKING_URL, READY_URL].every((url) => requestsTo(url) === 1),
    'the page to read its project, tree, panorama and queue once each',
  );
  await expand();
  for (const read of SEVEN_READS) {
    expect(
      client.getQueryCache().find({ queryKey: read.key, exact: true }),
      `${read.what} is not on screen — its key was never read`,
    ).toBeTruthy();
    expect(requestsTo(read.url), `${read.what} was not read exactly once on mount`).toBe(1);
  }
  return client;
}

async function publish(type: string, data: Record<string, unknown>, sessionId = ''): Promise<void> {
  await act(async () => {
    controlStream().onmessage?.({ data: JSON.stringify({ type, sessionId, data }) });
  });
}

describe('the project page re-reads through the control plane, not a poll', () => {
  it('mounts every read the report named exactly once, and nothing has refreshed yet', async () => {
    // The precondition the seven cases below rest on: one read each before any event, no poll in
    // the seconds this file advances (the fastest interval on this page is 15s).
    await mountWithTheSevenReadsOnScreen();
    await flush(10_000);
    for (const read of SEVEN_READS) {
      expect(requestsTo(read.url), `${read.what} polled instead of waiting for the stream`).toBe(1);
    }
  });

  it.each(SEVEN_READS)('re-reads $what on task.changed', async (read) => {
    await mountWithTheSevenReadsOnScreen();
    expect(requestsTo(read.url), `${read.what} was not read before the event`).toBe(1);

    await publish('task.changed', { taskIds: [ROOT_TASK] });
    await flush(1_100); // the stream's REFRESH_DEBOUNCE_MS window
    await waitFor(() => requestsTo(read.url) === 2, `${read.what} to be read again`);

    // And no more than once: the event asks for one read, not a storm of them.
    await flush(5_100);
    expect(requestsTo(read.url), `${read.what} was read more than once for one event`).toBe(2);
  });

  it('re-reads the task tree when a member session event names this project', async () => {
    // The report itself: the Automatic dispatcher starts a task, which writes a session and no
    // task row, so `task.changed` may never arrive. The tree has to be reached by the session.
    await mountWithTheSevenReadsOnScreen();

    await publish('task.changed', { taskIds: [ROOT_TASK] });
    await flush(1_100);
    await waitFor(() => requestsTo(TREE_URL) === 2, 'the tree to answer the task event');

    await publish(
      'session.updated',
      { id: SESSION, projectMembership: { projectId: PROJECT, role: 'TASK' } },
      SESSION,
    );
    await flush(5_100); // the project page's PROJECT_PAGE_MIN_INTERVAL_MS floor
    await waitFor(() => requestsTo(TREE_URL) === 3, 'the tree to answer the member session event');
  });

  it('re-reads the run queue when a member session event names this project', async () => {
    // The queue draws `runState` off the session carrying each task — READY becomes RUNNING with
    // no task row written — so it, too, must declare `session` and not only `task`.
    await mountWithTheSevenReadsOnScreen();

    await publish('task.changed', { taskIds: [ROOT_TASK] });
    await flush(1_100);
    await waitFor(() => requestsTo(READY_URL) === 2, 'the queue to answer the task event');

    await publish(
      'session.updated',
      { id: SESSION, projectMembership: { projectId: PROJECT, role: 'TASK' } },
      SESSION,
    );
    await flush(5_100);
    await waitFor(() => requestsTo(READY_URL) === 3, 'the queue to answer the member session event');
  });

  it('leaves reads that declare no session alone on a session event', async () => {
    // The negative control that keeps the session cases from passing on a blanket project
    // refresh: the document declares `project` and `task`, the leaderboard declares `task`, and
    // neither derives from a session.
    await mountWithTheSevenReadsOnScreen();

    await publish('task.changed', { taskIds: [ROOT_TASK] });
    await flush(1_100);
    await waitFor(() => requestsTo(DETAIL_URL) === 2, 'the document to answer the task event');
    await waitFor(() => requestsTo(BLOCKING_URL) === 2, 'the leaderboard to answer the task event');

    await publish(
      'session.updated',
      { id: SESSION, projectMembership: { projectId: PROJECT, role: 'TASK' } },
      SESSION,
    );
    await flush(5_100);
    await flush(1_000);
    expect(requestsTo(DETAIL_URL), 'the project document was re-read for a session event').toBe(2);
    expect(requestsTo(BLOCKING_URL), 'the leaderboard was re-read for a session event').toBe(2);
  });
});
