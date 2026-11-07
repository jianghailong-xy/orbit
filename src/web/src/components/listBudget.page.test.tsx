// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, useQuery, type QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { CREATED_RENAME } from '../lib/machineSetupCopy';
import { sessionsQuery, watchesQuery } from '../lib/queries';
import { createAppQueryClient } from '../lib/queryClient';
import { ControlPlaneProvider } from '../lib/useControlPlane';

/**
 * The list budget (docs/list-freshness-design.md §4) on the console's own pages, counted by a request
 * recorder:
 *
 * W4 — with the stream live and nothing happening, the sidebar (counts, runners, projects), the Tasks
 *      page, a coordinator card and the watches read each of their lists at most once a minute.
 * W5 — a page load reads the Open list once: the splash's read is the console's (BootGate), and the
 *      stream's first opening reads nothing again; and a write this tab made, with the server's event
 *      for it, reads the list once between them.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getToken: () => 'token',
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
  };
});
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const apiModule = await import('../api');
const { BootGate } = await import('./BootGate');
const { AppShell } = await import('./AppShell');
const { WorkspaceConsole } = await import('./WorkspaceConsole');
const { TasksSidePanel } = await import('./TasksSidePanel');
const { TaskListView } = await import('../pages/TaskListView');
const { CoordinatorQuestions } = await import('./CoordinatorQuestionCard');
const { CreatedWorkspaceLine } = await import('./CreatedWorkspaceLine');

const uuid = (n: number): string => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const pid = (n: number): string => encodeId(uuid(n));
const RUNNER_ID = pid(901);
const WORKSPACE_ID = pid(902);
const PROJECT_ID = pid(903);
const WORKSPACE = { id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' };
const RUNNER = {
  id: RUNNER_ID, name: 'wikova', online: true, maxConcurrent: 2, activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
};
const session = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
  id: pid(n),
  title,
  workspaceId: WORKSPACE_ID,
  workspace: { id: WORKSPACE_ID, name: 'orbit' },
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-10-01T09:00:00Z',
  lastTurnAt: '2026-10-03T08:00:00Z',
  folderId: null,
  ...extra,
});
const COORDINATOR = session(911, 'Plan the release', {
  projectMembership: { projectId: PROJECT_ID, projectTitle: 'Alpha', projectStatus: 'OPEN', role: 'COORDINATOR' },
});
const LOOSE = session(912, 'Loose conversation');
const SIDEBAR_PROJECT = {
  id: PROJECT_ID, title: 'Alpha', status: 'OPEN', createdAt: '2026-10-01T09:00:00Z',
  lastActivityAt: '2026-10-04T08:00:00Z', buckets: { running: 1 }, taskCounts: { done: 1, failed: 0, total: 3 },
  attention: { ownerItems: [], startRequest: null, coordinatorItems: null },
  coordinatorActivity: { working: false, lastTurnAt: COORDINATOR.lastTurnAt },
};

let calls: Array<{ path: string; at: number }> = [];
let sidebarProjects: unknown[] = [];
let rows: unknown[] = [];

function answer(path: string): unknown {
  if (path === '/runners') return [RUNNER];
  if (path === '/workspaces') return [WORKSPACE];
  if (path === '/users/me') return { id: 'user-1', email: 'reader@example.com', name: 'Reader', preferences: {} };
  if (path === '/projects/sidebar') return sidebarProjects;
  if (path === '/sessions/counts') return [{ workspaceId: WORKSPACE_ID, active: 1, running: 1, jobs: 0, needsYou: 0 }];
  if (path.startsWith('/sessions?')) {
    const params = new URLSearchParams(path.split('?')[1]);
    if (params.has('projectId')) return [];
    return params.get('view') === 'open' || !params.get('view') ? rows : [];
  }
  if (path.startsWith('/tasks/page')) {
    return { items: [{ id: pid(950), title: 'A running task', status: 'IN_PROGRESS', running: true, queued: false, dependencyState: 'NONE', assignee: null }], nextCursor: null, total: 1 };
  }
  if (path.startsWith('/tasks/counts')) return { total: 1, open: 0, inProgress: 1, done: 0, failed: 0, cancelled: 0, running: 1, queued: 0, runnable: 0 };
  if (path.startsWith('/tasks/active')) return { items: [], total: 0, truncated: false };
  if (path.startsWith('/tasks/labels')) return { items: [], labelTotal: 0, truncated: false };
  if (path.endsWith('/open-items')) return { needsYou: [], withCoordinator: [], startRequest: null };
  if (path.startsWith('/tasks/evidence-decisions/pending')) return { decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] };
  if (path.endsWith('/acceptance/criteria-decisions/pending')) {
    return { projectId: PROJECT_ID, readAt: new Date().toISOString(), count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] };
  }
  if (path.startsWith('/sessions/search?')) return { q: '', contentSearched: false, total: 0, hits: [] };
  if (path.startsWith('/sessions/') && path.includes('/events/page')) return { events: [], hasMore: false };
  if (path.startsWith('/sessions/') && path.includes('/created-tasks')) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] };
  return [];
}

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

/** The control-plane stream (the console opens per-session streams of its own besides). */
const controlStream = (): FakeEventSource | undefined =>
  FakeEventSource.all.filter((es) => !es.closed && es.url.startsWith('/api/events')).at(-1);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(node: ReactNode, client: QueryClient = createAppQueryClient()): Promise<QueryClient> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  return client;
}

async function publish(type: string, data: Record<string, unknown> = {}, sessionId = ''): Promise<void> {
  await act(async () => {
    controlStream()!.onmessage?.({ data: JSON.stringify({ type, sessionId, agentId: null, ts: new Date().toISOString(), data }) });
  });
}

const reads = (match: (path: string) => boolean, from = 0): number =>
  calls.slice(from).filter((call) => match(call.path)).length;
const isOpenList = (path: string): boolean => {
  if (!path.startsWith('/sessions?')) return false;
  const params = new URLSearchParams(path.split('?')[1]);
  return params.get('workspaceId') === WORKSPACE_ID && !params.has('projectId') && (params.get('view') ?? 'open') === 'open';
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  sidebarProjects = [];
  rows = [LOOSE];
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  // jsdom lays nothing out; the console scrolls its list and its transcript.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  localStorage.clear();
  vi.mocked(apiModule.api).mockImplementation(((path: string) => {
    calls.push({ path, at: Date.now() });
    return Promise.resolve(answer(path));
  }) as never);
  vi.mocked(apiModule.getSession).mockImplementation(((id: string) => {
    calls.push({ path: `/sessions/${id}`, at: Date.now() });
    return Promise.resolve((rows as Array<{ id: string }>).find((row) => row.id === id) ?? LOOSE);
  }) as never);
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
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
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(apiModule.api).mockReset();
    vi.mocked(apiModule.getSession).mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

function Watches(): null {
  useQuery(watchesQuery());
  return null;
}

describe('W4: with the stream live and nothing happening, each list is read once a minute at most', () => {
  it('the sidebar, the Tasks page, a coordinator card and the watches', async () => {
    vi.useFakeTimers();
    sidebarProjects = [SIDEBAR_PROJECT];
    window.history.replaceState(null, '', '/tasks');
    await render(
      <MemoryRouter initialEntries={['/tasks']}>
        <ControlPlaneProvider>
          <TasksSidePanel />
          <Routes>
            <Route path="/tasks" element={<TaskListView />} />
          </Routes>
          <CoordinatorQuestions projectId={PROJECT_ID} />
          <Watches />
        </ControlPlaneProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => controlStream()!.onopen?.());
    await publish('ping');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const lists: Array<[string, (path: string) => boolean]> = [
      ['the counts', (path) => path === '/sessions/counts'],
      ['the runners', (path) => path === '/runners'],
      ['the sidebar projects', (path) => path === '/projects/sidebar'],
      ['the Tasks page', (path) => path.startsWith('/tasks/page')],
      ['the coordinator card', (path) => path === `/projects/${PROJECT_ID}/open-items`],
      ['the watches', (path) => path === '/watches'],
    ];
    for (const [what, match] of lists) expect(reads(match), `${what} were never read`).toBeGreaterThan(0);

    for (let minute = 1; minute <= 10; minute += 1) {
      const from = calls.length;
      for (let tick = 0; tick < 3; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        await publish('ping'); // the server's keepalive, every 20 s
      }
      for (const [what, match] of lists) {
        expect(reads(match, from), `${what} were read more than once in minute ${minute}`).toBeLessThanOrEqual(1);
      }
    }
  }, 60_000);
});

describe('W5: a page load reads the Open list once', () => {
  async function load(path: string): Promise<void> {
    await render(
      <MemoryRouter initialEntries={[path]}>
        <BootGate>
          <Routes>
            <Route element={<AppShell />}>
              <Route element={<WorkspaceConsole />}>
                <Route path="workspaces/:id/*" element={null} />
                <Route path="sessions/:id" element={null} />
              </Route>
            </Route>
          </Routes>
        </BootGate>
      </MemoryRouter>,
    );
    await vi.waitFor(() => {
      expect(container?.querySelector('.session-row .session-title'), 'the session list never drew').toBeTruthy();
      expect(controlStream(), 'the control-plane stream was never asked for').toBeTruthy();
    }, { timeout: 20_000, interval: 20 });
    // The stream opens, its first message comes, and its window would have closed.
    await act(async () => controlStream()!.onopen?.());
    await publish('ping');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
  }

  it('on a workspace that shows its projects (the whole list)', async () => {
    rows = [LOOSE, COORDINATOR];
    sidebarProjects = [SIDEBAR_PROJECT];
    await load(`/workspaces/${WORKSPACE_ID}`);
    expect(calls.filter((call) => isOpenList(call.path)).map((call) => call.path), 'the Open list was read more than once').toHaveLength(1);
    expect(new URLSearchParams(calls.find((call) => isOpenList(call.path))!.path.split('?')[1]).has('limit'),
      'the splash warmed a page while the console reads the whole list').toBe(false);
  }, 30_000);

  it('on a workspace with neither projects nor folders (one page)', async () => {
    await load(`/workspaces/${WORKSPACE_ID}`);
    expect(calls.filter((call) => isOpenList(call.path)).map((call) => call.path)).toEqual([
      `/sessions?runnerId=${RUNNER_ID}&workspaceId=${WORKSPACE_ID}&view=open&limit=40`,
    ]);
  }, 30_000);

  it('on a reload of a session’s page', async () => {
    rows = [LOOSE, COORDINATOR];
    sidebarProjects = [SIDEBAR_PROJECT];
    await load(`/sessions/${LOOSE.id}`);
    const lists = calls.filter((call) => call.path.startsWith('/sessions?') && !call.path.includes('projectId='));
    expect(lists.map((call) => call.path), 'the session page read a list it does not show, or its own twice').toHaveLength(1);
    expect(isOpenList(lists[0].path)).toBe(true);
  }, 30_000);
});

describe('W5: a write this tab made and the server’s event for it read the list once', () => {
  it('renaming the workspace a conversation made', async () => {
    vi.useFakeTimers();
    const openList = sessionsQuery({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, view: 'open', limit: 40 });
    function OpenList(): null {
      useQuery(openList);
      return null;
    }
    await render(
      <MemoryRouter>
        <ControlPlaneProvider>
          <OpenList />
          <CreatedWorkspaceLine sessionId={LOOSE.id} workspace={{ id: WORKSPACE_ID, name: 'orbit' }} machine="wikova" runnerId={RUNNER_ID} />
        </ControlPlaneProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => controlStream()!.onopen?.());
    await publish('ping');
    const from = calls.length;

    const rename = [...container!.querySelectorAll('button')].find((button) => button.textContent === CREATED_RENAME)!;
    await act(async () => rename.click());
    const input = container!.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'orbit-web');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(reads((path) => path === `/workspaces/${WORKSPACE_ID}`, from), 'the rename was never sent').toBe(1);
    // The server announces the renamed workspace a moment later.
    await publish('agent.changed', { agentId: WORKSPACE_ID, affectsTaskRows: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads(isOpenList, from), 'one rename read the session list more than once').toBe(1);
  });
});
