// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer's status bar for a session on an account pool: it names the ACCOUNT the session is
 * spending and shows that account's quota — not the pool's name, which says nothing about whose
 * quota is going, and not the pool's next pick, which is where a new session would start.
 *
 * Mounted for real: the account comes from the session's detail row (`poolMemberProviderId`) matched
 * against GET /providers/pools, and both of those are reads the view makes itself.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    getSession: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000c3');
const WORK = encodeId('0195c0de-0000-7000-8000-0000000000c4');
const HOME = encodeId('0195c0de-0000-7000-8000-0000000000c5');
const GONE = encodeId('0195c0de-0000-7000-8000-0000000000c6');
const POOL_SLUG = 'claude-accounts';

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const fiveHour = (utilization: number) => ({
  provider: 'claude',
  fiveHour: { utilization, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
});
/** Work is the pool's next pick; Home is where the session below actually runs. */
const POOL = {
  id: encodeId('0195c0de-0000-7000-8000-0000000000c7'),
  slug: POOL_SLUG,
  label: 'Claude accounts',
  resetsAt: null,
  members: [
    {
      id: WORK, slug: 'anthropic', label: 'Work', presetSlug: 'anthropic', enabled: true,
      planUsage: fiveHour(12), state: 'AVAILABLE', resetsAt: null, next: true,
    },
    {
      id: HOME, slug: 'anthropic-2', label: 'Home', presetSlug: 'anthropic', enabled: true,
      planUsage: fiveHour(64), state: 'RUNNING', resetsAt: null, next: false,
    },
  ],
};

const session = (poolMemberProviderId: string | null) => ({
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  title: 'on the pool',
  status: 'RUNNING',
  provider: POOL_SLUG,
  poolMemberProviderId,
  numTurns: 3,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-09-25T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-09-25T01:10:00Z',
  updatedAt: '2026-09-25T01:18:00Z',
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the status bar of a session on an account pool', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let detail = session(HOME);

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  const mount = async (entry: string, ready: string): Promise<void> => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const nextClient = client;
    const nextRoot = root;
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[entry]}>
            <AntApp>
              <Routes>
                <Route path="*" element={<WorkspaceView runner={RUNNER} />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector(ready)).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    // What the settle started: one more macrotask so the late reads land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  /** The composer's status: which account, and its quota. */
  const account = () => mounted().querySelector<HTMLElement>('.composer-account');
  // The plan gauge, not the context ring beside it (which shares the pill class).
  const usage = () => mounted().querySelector<HTMLElement>('button.composer-usage[aria-label^="Plan usage"]');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    detail = session(HOME);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => detail as never);
    apiMock.mockReset();
    apiMock.mockImplementation((p: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      // The pool's accounts are also providers in their own right, each with its own slug.
      if (p === '/providers') {
        return reply([
          { slug: 'anthropic', label: 'Work', runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true, planUsage: fiveHour(12) },
          { slug: 'anthropic-2', label: 'Home', runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true, planUsage: fiveHour(64) },
        ]);
      }
      if (p === '/providers/pools') return reply([POOL]);
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: POOL_SLUG }]);
      }
      if (p.startsWith(`/sessions/${SESSION}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        return reply(detail);
      }
      if (p.startsWith('/sessions')) return reply([detail]);
      if (p.includes('/owner-confirmation')) return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
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

  it('names the account the session runs on and shows its quota — not the pool', async () => {
    await mount(`/sessions/${SESSION}`, '.composer-account');
    expect(account()?.textContent).toBe('Home');
    // Home's own 5-hour gauge — not Work's (the pool's next pick) and not the pool's.
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 64%');
    expect(usage()?.querySelector<HTMLElement>('.composer-usage-fill')?.style.width).toBe('64%');
    for (const status of [account(), usage()]) {
      expect(status?.textContent).not.toContain('Claude accounts');
      expect(status?.textContent).not.toContain('Work');
    }
  });

  it('follows the session onto another account once a claim moves it', async () => {
    detail = session(WORK);
    await mount(`/sessions/${SESSION}`, '.composer-account');
    expect(account()?.textContent).toBe('Work');
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 12%');
  });

  it('names nobody once the recorded account has left the pool, rather than guess', async () => {
    detail = session(GONE);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    // The session itself is on screen (its detail read, no New Session hero) — not a view still loading.
    await act(async () => {
      await vi.waitFor(() => expect(vi.mocked(getSession)).toHaveBeenCalled(), { timeout: 20_000, interval: 20 });
      await vi.waitFor(() => expect(mounted().textContent).toContain('on the pool'), { timeout: 20_000, interval: 20 });
    });
    expect(mounted().querySelector('.np-hero')).toBeNull();
    expect(account()).toBeNull();
    expect(usage()).toBeNull();
  });

  it('on a new session, names the account the claim will pick, and offers the pool as one tile', async () => {
    await mount(`/workspaces/${WORKSPACE}/new`, '.composer-account');
    expect(account()?.textContent).toBe('Work');
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 12%');
    const card = mounted().querySelector<HTMLElement>('.np-card')!;
    expect(card.getAttribute('aria-label')).toBe('Provider: Claude accounts');
    expect(card.querySelector('.np-pool-badge')?.textContent).toBe('2');
  });
});
