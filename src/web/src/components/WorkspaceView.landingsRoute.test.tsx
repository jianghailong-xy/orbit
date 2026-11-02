// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A project's Landings window opened by its bare address, `/projects/<id>/landings`: nothing in the
 * address names a workspace, so the list beside the window is the runner's whole list. The app's own
 * way in carries `?project=`; a pasted link, a bookmark or a reload of one does not. Two things went
 * wrong on that address, both into the error boundary with React's update limit (#185):
 *
 * - the default landing, which opens a session so that a workspace's right pane is never blank, took
 *   the address away from the window;
 * - a session opened from that list narrowed the list to its workspace, a list not read yet. With the
 *   session's detail not read yet either, nothing named the workspace, so the list widened again and
 *   found the row again, and the two traded places without yielding to the reads that end it.
 *
 * Whether the project has a coordinator made no difference to either: both are here for each.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getToken: () => 'token', getSession: vi.fn(), getSessionEventPage: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { ErrorBoundary } = await import('./ErrorBoundary');
const { encodeId } = await import('../lib/idCodec');

const pid = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const RUNNER = {
  id: pid(801),
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
const WORKSPACE = { id: pid(802), name: 'orbit' };
const PROJECT = pid(803);
const WINDOW = `/projects/${PROJECT}/landings`;
const SESSION = {
  id: pid(811),
  workspaceId: WORKSPACE.id,
  workspace: WORKSPACE,
  runnerId: RUNNER.id,
  assignedRunnerId: RUNNER.id,
  title: 'A conversation on this runner',
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-10-01T09:00:00Z',
  lastTurnAt: '2026-10-03T08:00:00Z',
  folderId: null,
};

const CASES = [
  { coordinator: 'no coordinator session', status: { coordination: null } },
  { coordinator: 'a coordinator session', status: { coordination: { sessionId: pid(812) } } },
];

let root: Root | null = null;
let client: QueryClient | null = null;
let container: HTMLDivElement | null = null;
let address = '';
let coordinatorStatus: unknown = null;
/** The reads held back, by what they read: the scoped list and the session's detail, until released. */
let held: Array<() => void> = [];
let holdScopedReads = false;

function LocationProbe() {
  const location = useLocation();
  address = location.pathname + location.search;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path: string): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={[path]}>
          <ErrorBoundary fallback={<p data-testid="boundary">Something went wrong</p>}>
            <WorkspaceView runner={RUNNER} />
          </ErrorBoundary>
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const page = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const crashed = (): boolean => page().querySelector('[data-testid="boundary"]') != null;
const landingsWindow = (): Element | null => page().querySelector('.landings-window');
const sessionRow = (): HTMLElement | null =>
  [...page().querySelectorAll<HTMLElement>('.session-row')]
    .find((row) => row.querySelector('.session-title')?.textContent === SESSION.title) ?? null;

async function until(assertion: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  address = '';
  coordinatorStatus = null;
  held = [];
  holdScopedReads = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', class { onopen = null; onmessage = null; onerror = null; close() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)', media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  const hold = <T,>(value: T): Promise<T> => holdScopedReads
    ? new Promise((resolve) => { held.push(() => resolve(value)); })
    : Promise.resolve(value);
  vi.mocked(apiModule.getSessionEventPage).mockReset().mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getSession).mockReset().mockImplementation((() => hold(SESSION)) as never);
  vi.mocked(apiModule.api).mockReset().mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', preferences: {} });
    if (path === '/workspaces') return reply([{ ...WORKSPACE, runnerId: RUNNER.id, lastProvider: 'claude', createdAt: '2026-01-01T00:00:00Z' }]);
    if (path === `/projects/${PROJECT}`) return reply({ id: PROJECT, title: 'Project Alpha', status: 'OPEN' });
    if (path === `/projects/${PROJECT}/coordinator/status`) return reply(coordinatorStatus);
    if (path === `/projects/${PROJECT}/promotions/merged`) return reply([]);
    if (path.startsWith('/sessions?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      // The window's own two reads: this project has had no landing.
      if (query.has('projectId')) return reply([]);
      if (query.get('view') !== 'open') return reply([]);
      return query.has('workspaceId') ? hold([SESSION]) as Promise<never> : reply([SESSION]);
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) return reply({ decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] });
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof apiModule.api);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  try {
    if (mounted) await act(async () => mounted.unmount());
  } finally {
    await client?.cancelQueries();
    client?.clear();
    client = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe.each(CASES)('the bare Landings address of a project with $coordinator', { timeout: 60_000 }, ({ status }) => {
  it('stays on the window beside the runner’s list, however many sessions that list has', async () => {
    coordinatorStatus = status;
    await mount(WINDOW);
    await until(() => expect(sessionRow()).not.toBeNull());
    await settle();

    expect(crashed()).toBe(false);
    expect(address).toBe(WINDOW);
    expect(landingsWindow()?.querySelector('.landing-page-title')?.textContent).toBe('Landings');
    // The window, and no conversation: no composer is put under it.
    expect(page().querySelector('.workspace-composer')).toBeNull();
  });

  it('opens a session from that list while its workspace’s list and its detail are still being read', async () => {
    coordinatorStatus = status;
    await mount(WINDOW);
    await until(() => expect(sessionRow()).not.toBeNull());

    holdScopedReads = true;
    await act(async () => sessionRow()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    // Both reads are out and neither has answered: this is the moment nothing names the workspace.
    expect(address).toBe(`/sessions/${SESSION.id}`);
    expect(held.length).toBeGreaterThanOrEqual(2);
    expect(crashed()).toBe(false);

    // When they answer, the session is open and its list is its workspace's.
    await act(async () => {
      for (const release of held) release();
    });
    await settle();
    expect(crashed()).toBe(false);
    await until(() => expect(page().querySelector('.workspace-composer')).not.toBeNull());
    expect(address).toBe(`/sessions/${SESSION.id}`);
    expect(sessionRow()).not.toBeNull();
    const reads = vi.mocked(apiModule.api).mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith('/sessions?'));
    expect(reads.some((path) => new URLSearchParams(path.split('?')[1]).get('workspaceId') === WORKSPACE.id)).toBe(true);
  });
});

describe('the workspace’s own default landing', { timeout: 60_000 }, () => {
  it('still opens a session when no window holds the right pane', async () => {
    await mount(`/workspaces/${WORKSPACE.id}`);
    await until(() => expect(address).toBe(`/sessions/${SESSION.id}`));
    expect(crashed()).toBe(false);
  });
});
