// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // The readers below close over the *module-local* client, so replacing the exported `api` alone
  // would leave the real `getSession` running and fetch nothing in jsdom — the session detail is
  // what this test commits from, so it has to be stubbed here too (same trap the settlement-pointer
  // test documents for its own readers).
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    commitSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
  };
});

const { api, getSession, commitSession, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const getSessionMock = vi.mocked(getSession);
const commitMock = vi.mocked(commitSession);
const { encodeId } = await import('../lib/idCodec');
const { WorkspaceView } = await import('./WorkspaceView');

/**
 * What a finished commit says besides "Changes committed".
 *
 * The runner sends a line alongside a successful commit — which background jobs were running while
 * it committed, what it did about them — and the control plane keeps it as `commitResultMessage`.
 * Both clients read that field; neither showed it, so the one sentence that explains the state the
 * user is about to find (a cold engine, a file committed mid-write) was dropped on the floor.
 *
 * The claim is about what the card SAYS, so nothing here calls the notice builder or inspects the
 * detail payload directly: the real WorkspaceView is mounted, Commit is clicked, the real toast
 * lands, and the assertions are made on the card the user reads. A `commitResultMessage` the
 * client failed to pass through fails here exactly as the user would see it — as a missing line.
 */

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000011';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000081';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000082';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
/** A stand-in for whatever the runner sends — deliberately not one of the wordings in flight, so
 *  the test cannot pass by matching copy that happens to live in the component. */
const RUNNER_MESSAGE =
  'this commit ran while a background job was still writing in the checkout (bgj_01a02fe3)';
const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** What the stubbed server reports for the commit right now. A click flips it to the outcome the
 *  case is about; the runner's own copy arrives with the terminal status, as it does in production. */
const server: {
  commitStatus: string | null;
  commitError: string | null;
  commitResultMessage: string | null;
} = { commitStatus: null, commitError: null, commitResultMessage: null };

const sessionRow = () => ({
  // The client asks for `X-Orbit-Id-Format: public`, so what it holds — and compares — is the
  // base62 id; the route param above is normalized to the same spelling by `routeId`.
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: null,
  title: 'commit while a build is running',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  sessionState: 'AWAITING_INPUT',
  engineTurnActive: false,
  provider: 'claude',
  createdAt: '2026-09-13T03:00:00Z',
  updatedAt: '2026-09-13T03:10:00Z',
});

/** A live session with uncommitted work: the worktree bar offers Commit, and the commit outcome
 *  lands on this same detail a heartbeat later. */
const sessionDetail = () => ({
  ...sessionRow(),
  isolationStatus: 'worktree',
  branch: 'orbit/commit-while-building-1a2b3c',
  changedFiles: [{ path: 'src/web/src/api.ts', additions: 2, deletions: 0 }],
  worktreeDirty: true,
  commitStatus: server.commitStatus,
  commitError: server.commitError,
  commitResultMessage: server.commitResultMessage,
});

class FakeEventSource {
  static open: FakeEventSource[] = [];
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

/** The card the user reads, as rendered — not the payload it was built from. */
const toastStatus = (): string | null =>
  document.body.querySelector('.session-lifecycle-toast-status')?.textContent ?? null;
const toastDetail = (): string | null =>
  document.body.querySelector('.session-lifecycle-toast-detail')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  server.commitStatus = null;
  server.commitError = null;
  server.commitResultMessage = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockImplementation(async () => sessionDetail() as never);
  commitMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events: [], hasMore: false }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({
        id: 'user-1',
        email: 'reader@example.com',
        name: 'Reader',
        createdAt: '2026-01-01T00:00:00Z',
        preferences: {},
      });
    }
    if (path === '/workspaces') {
      return reply([
        {
          id: WORKSPACE_PUBLIC,
          name: 'orbit',
          runnerId: RUNNER_ID,
          createdAt: '2026-01-01T00:00:00Z',
          lastProvider: 'claude',
        },
      ]);
    }
    // Session-scoped sub-resources (background shells, diff, transcript pages) — the detail itself
    // never arrives here: it is read by the stubbed module-local `getSession` above.
    if (path.startsWith('/sessions/')) {
      if (path.includes('/background')) return reply([]);
      if (path.includes('/diff')) return reply({ patches: [] });
      return reply([]);
    }
    if (path.startsWith('/sessions')) return reply([sessionRow()]);
    if (path === '/providers' || path === '/session-tags' || path === '/runners' || path === '/task-lists') {
      return reply([]);
    }
    // The decision strip renders from this queue and has nothing to draw here; it must still be a
    // queue, or the page throws on the way to the worktree bar this test is about.
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({
        decidingSessionId: SESSION_ID,
        count: 0,
        oldestAgeSeconds: null,
        pending: [],
        waitingOnYou: [],
      });
    }
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    // Answer anything else benignly rather than rejecting: an unrelated background query failing
    // must not be able to take the session detail down with it and turn this into a test about
    // error handling instead of about what the commit card says.
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
    try {
      if (mountedClient) {
        await mountedClient.cancelQueries();
        mountedClient.clear();
      }
    } finally {
      mountedNode?.remove();
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  }
});

/** Mount the session, commit its worktree, and let the runner's outcome land. */
async function commitAndAwaitOutcome(outcome: {
  status: 'committed' | 'nochange' | 'error';
  message?: string | null;
  error?: string | null;
}): Promise<void> {
  commitMock.mockImplementation(async () => {
    server.commitStatus = outcome.status;
    server.commitResultMessage = outcome.message ?? null;
    server.commitError = outcome.error ?? null;
    return undefined as never;
  });
  const nextClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
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
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(mounted().querySelector('.wt-bar')).toBeTruthy();
  });
  const commit = [...mounted().querySelectorAll<HTMLButtonElement>('.wt-bar button')].find(
    (button) => button.textContent === 'Commit',
  );
  expect(commit, 'the worktree bar offers Commit').toBeTruthy();
  await act(async () => commit!.click());
  await waitForUi(() => {
    expect(toastStatus()).toBeTruthy();
  });
}

// A real WorkspaceView/AntD mount is seconds, not milliseconds, and these cases cover the mount plus
// the commit round-trip — a slow render against the suite's budget, not a sleep.
describe('a finished commit reports the runner line', () => {
  it('shows the runner message under "Changes committed"', async () => {
    await commitAndAwaitOutcome({ status: 'committed', message: RUNNER_MESSAGE });

    expect(toastStatus()).toBe('Changes committed');
    expect(toastDetail()).toBe(RUNNER_MESSAGE);
  });

  it('shows it under "No changes to commit" too', async () => {
    await commitAndAwaitOutcome({ status: 'nochange', message: RUNNER_MESSAGE });

    expect(toastStatus()).toBe('No changes to commit');
    expect(toastDetail()).toBe(RUNNER_MESSAGE);
  });

  it('leaves the card exactly as it was when the runner said nothing', async () => {
    await commitAndAwaitOutcome({ status: 'committed', message: null });

    expect(toastStatus()).toBe('Changes committed');
    expect(toastDetail()).toBeNull();
  });

  it('adds no blank line for a message that is only whitespace', async () => {
    await commitAndAwaitOutcome({ status: 'committed', message: '  \n ' });

    expect(toastStatus()).toBe('Changes committed');
    expect(toastDetail()).toBeNull();
  });

  it('still reports a failed commit with the error, not the runner line', async () => {
    await commitAndAwaitOutcome({
      status: 'error',
      message: RUNNER_MESSAGE,
      error: 'error: Your local changes to the following files would be overwritten by merge',
    });

    expect(toastStatus()).toBe('Commit failed');
    expect(toastDetail()).toBe(
      'error: Your local changes to the following files would be overwritten by merge',
    );
  });
});
