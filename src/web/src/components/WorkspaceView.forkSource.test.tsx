// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // The detail is read by the module-local `getSession`, so it is stubbed beside `api`.
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
  };
});

const { api, getSession, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const getSessionMock = vi.mocked(getSession);
const { encodeId } = await import('../lib/idCodec');
const { WorkspaceView } = await import('./WorkspaceView');

/**
 * A run of a task forked from a session (docs/task-fork-from-session-design.md §2.3) says where its
 * checkout came from: the session header draws the detail's `forkSource` sentence verbatim under its
 * subtitle, and draws nothing when the field is null or — on an older server — absent.
 */

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000011';
const SESSION_ID = '0195c0de-0000-7000-8000-0000000000f1';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-0000000000f2';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const TITLE = 'Split the claim path';
const SOURCE = 'Forked from session «Fix login» at aaaaaaa';
const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const sessionRow = () => ({
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: null,
  title: TITLE,
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  sessionState: 'AWAITING_INPUT',
  engineTurnActive: false,
  provider: 'claude',
  createdAt: '2026-09-13T03:00:00Z',
  updatedAt: '2026-09-13T03:10:00Z',
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  // The act environment is off while the window is waited out (see the commitResultMessage test).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  getSessionMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events: [], hasMore: false }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ patches: [] });
      return reply([]);
    }
    if (path.startsWith('/sessions')) return reply([sessionRow()]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    mountedNode?.remove();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Mount the session whose detail carries `over`, and wait for the detail to have landed. */
async function mountSession(over: Record<string, unknown>): Promise<void> {
  getSessionMock.mockImplementation(async () => ({ ...sessionRow(), ...over }) as never);
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(mounted().querySelector('.workspace-header .workspace-name')?.textContent).toBe(TITLE);
    expect(getSessionMock).toHaveBeenCalled();
  });
  await waitForUi(() => {});
}

const sourceLine = () => mounted().querySelector('.workspace-header [data-fork-source]');

describe('the session header’s SOURCE line', { timeout: 60_000 }, () => {
  it('draws the server’s sentence verbatim under the subtitle', async () => {
    await mountSession({ forkSource: SOURCE });
    await waitForUi(() => {
      expect(sourceLine()?.textContent).toBe(SOURCE);
    });
  });

  it('draws nothing when the task the session runs was not forked', async () => {
    await mountSession({ forkSource: null });
    expect(sourceLine()).toBeNull();
  });

  it('draws nothing when an older server leaves the field out', async () => {
    await mountSession({});
    expect(sourceLine()).toBeNull();
  });
});
