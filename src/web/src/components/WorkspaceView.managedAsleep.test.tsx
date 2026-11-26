// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MANAGED_RUNNER_COPY, managedRunnerDisplay, type ManagedRunnerStatus } from '@orbit/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManagedRunner } from '../lib/managedRunner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A workspace whose runner is the account's managed runner, asleep (docs/managed-runner-existing-account-entry-design.md;
 * the owner's 2026-11-14 ask to optimise the sleep UI): the column head's dot reads Asleep rather than an offline
 * runner's dot, the composer carries the shared one-line note that sending wakes it instead of the notice, and the
 * box still takes a message: no "Runner offline". Any other state keeps its notice; any other runner is unchanged.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    getSessionMoveTargets: vi.fn(),
    listQueuedTurns: vi.fn(),
    resumeSession: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionMoveTargets, getSessionRetryMessage, listQueuedTurns } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView, sessionLine, statusLabel } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000b1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as { states: { name: string; status: ManagedRunnerStatus }[] };
const managedIn = (name: string): ManagedRunner => {
  const status = { ...fixture.states.find((s) => s.name === name)!.status, runnerId: RUNNER_ID };
  return { status, display: managedRunnerDisplay(status)! };
};

const RUNNER = {
  id: RUNNER_ID,
  name: 'managed',
  displayName: 'managed',
  online: false,
  maxConcurrent: 4,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const T1 = 't-0001';
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: 'Now do the same for the sign-up test.' }, turnId: T1, ts: '2026-10-31T11:20:00Z' },
  { seq: 2, type: 'assistant', payload: { text: 'Done.' }, turnId: T1, ts: '2026-10-31T11:24:00Z' },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success' }, turnId: T1, ts: '2026-10-31T11:24:00Z' },
];

const HELD = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: { id: WORKSPACE_PUBLIC, name: 'orbit-develop' },
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title: 'Fix the flaky login test',
  provider: 'claude',
  engine: 'claude',
  status: 'IDLE',
  runState: 'IDLE',
  lifecycleState: 'OPEN',
  numTurns: 1,
  createdAt: '2026-10-31T11:20:00Z',
  updatedAt: '2026-10-31T11:24:00Z',
  startedAt: '2026-10-31T11:20:00Z',
  lastTurnAt: '2026-10-31T11:24:00Z',
  engineStartedAt: '2026-10-31T11:20:02Z',
  error: null,
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a workspace on the account\'s managed runner', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const waitFor = (check: () => void) =>
    act(async () => {
      await vi.waitFor(check, { timeout: 20_000, interval: 20 });
    });

  const mount = async (managed: ManagedRunner | null, runner: Runner = RUNNER): Promise<void> => {
    const session = HELD;
    vi.mocked(getSession).mockResolvedValue(session as never);
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
            <WorkspaceView runner={runner} managed={managed} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(mounted().textContent).toContain('Now do the same for the sign-up test.');
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSession).mockReset();
    vi.mocked(getSessionEventPage).mockReset();
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS, hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' });
    vi.mocked(getSessionMoveTargets).mockReset();
    vi.mocked(getSessionMoveTargets).mockResolvedValue({ folders: [], targets: [] } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit-develop', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z',
          lastProvider: 'claude', lastEngine: 'claude', runner: { id: RUNNER_ID, name: 'HPC', displayName: 'HPC' } }]);
      }
            if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: EVENTS, hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      }
      // The workspace's list holds the held session.
      if (path.startsWith('/sessions?')) return reply([HELD]);
      if (path.startsWith('/sessions')) return reply([]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  });

  afterEach(async () => {
    const mountedRoot = root;
    const mountedClient = client;
    const node = container;
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
      node?.remove();
      document.body.innerHTML = '';
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  const headDot = () => mounted().querySelector('.session-col-head .workspace-status-dot');
  const composerLine = () => mounted().querySelector('.managed-runner-composer-line');
  const placeholder = () => mounted().querySelector('textarea')?.getAttribute('placeholder') ?? '';

  it('asleep: Asleep on the head dot, the shared composer line, no notice, and the box takes a message', async () => {
    await mount(managedIn('sleeping'));
    expect(headDot()?.getAttribute('data-managed-kind')).toBe('sleeping');
    expect(headDot()?.getAttribute('aria-label')).toBe(MANAGED_RUNNER_COPY.short.sleeping);
    expect(headDot()?.classList.contains('online')).toBe(false);
    expect(composerLine()?.textContent).toBe(MANAGED_RUNNER_COPY.asleep.composer);
    expect(mounted().querySelector('.managed-runner-notice')).toBeNull();
    expect(placeholder()).not.toContain('offline');
    expect(mounted().textContent).not.toMatch(/runner offline/i);
  });

  it('waking: Waking up… on the head dot and the notice, not the asleep line', async () => {
    await mount(managedIn('waking: starting again'));
    expect(headDot()?.getAttribute('aria-label')).toBe(MANAGED_RUNNER_COPY.short.waking);
    expect(composerLine()).toBeNull();
    expect(mounted().querySelector('.managed-runner-notice')?.getAttribute('data-kind')).toBe('waking');
    expect(placeholder()).not.toContain('offline');
  });

  it('failed with its slow retry scheduled: the box takes a message, which queues and wakes it; with no next try it does not', async () => {
    await mount(managedIn('failed: kept running out of memory, its slow retry scheduled'));
    expect(headDot()?.getAttribute('aria-label')).toBe(MANAGED_RUNNER_COPY.short.failed);
    const notice = mounted().querySelector('.managed-runner-notice');
    expect(notice?.getAttribute('data-kind')).toBe('failed');
    expect(notice?.querySelector('.managed-runner-notice-next')?.textContent).toMatch(/^Attempt 6 · next automatic try /);
    expect(placeholder()).not.toContain('offline');
    expect(placeholder()).not.toBe(MANAGED_RUNNER_COPY.title.failed);
    expect(mounted().querySelector('textarea')?.disabled).toBe(false);
    expect(mounted().textContent).not.toMatch(/runner offline/i);
    await act(async () => root!.unmount());
    root = null;
    container?.remove();

    // No next try: it waits for the owner's Retry, and the box says it failed instead of taking a message.
    await mount(managedIn('failed: kept running out of memory'));
    expect(placeholder()).toBe(MANAGED_RUNNER_COPY.title.failed);
  });

  it('any other runner offline: the heartbeat dot and Runner offline, as before', async () => {
    await mount(null);
    expect(headDot()?.hasAttribute('data-managed-kind')).toBe(false);
    expect(composerLine()).toBeNull();
    expect(placeholder()).toBe('Runner offline');
  });
});
