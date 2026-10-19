// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer of a session on a Codex pool of one's own ChatGPT accounts (a login pool): the
 * account pill names THE account the session runs on — the masked view the session detail carries
 * (`poolCodexLogin`) — and the quota gauge is that account's own. Not the pool's `next` member,
 * which is the answer for a session STARTING now: with the pool's oldest account spent there is no
 * next, while the session runs on that very account — the production failure this fixes (the pool's
 * oldest account, jianghailong.rd@gmail.com, spent until 2026-10-11, left every codex-pool session's
 * composer blank).
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
    updateSessionConfig: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, updateSessionConfig } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
// The two pure reads the composer makes: the account the session detail names (as its member), and
// the words the pill's tooltip says about it. The tooltip itself opens on a hover, which this mount
// never makes — so the copy is asserted here, on the same values the mounted composer reads.
const { poolAccountHelp } = await import('../lib/providerPools');
const { poolSessionLoginMember } = await import('../lib/codexLogin');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000f1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000f2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000f3');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  modelCatalog: {
    claude: [
      { label: 'Opus 5.5', value: 'claude-opus-5-5', contextWindow: 1_000_000 },
      { label: 'Sonnet 5.5', value: 'claude-sonnet-5-5', contextWindow: 1_000_000 },
    ],
  },
} as unknown as Runner;

const IN_AN_HOUR = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const IN_THREE_DAYS = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

/** A ChatGPT account of the pool, as GET /providers/pools serves it — email and `…AB12`, never an id. */
function account(email: string, fingerprint: string, utilization: number): import('../lib/codexLogin').CodexLogin {
  return {
    state: 'ACTIVE',
    email,
    plan: 'plus',
    fingerprint,
    lastError: null,
    expiresAt: IN_THREE_DAYS,
    linkedAt: '2026-09-28T10:00:00.000Z',
    usage: {
      provider: 'codex',
      primary: { utilization, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
      secondary: { utilization, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
    },
    usageUnavailable: null,
  };
}

/** The pool: no members (the server's shape), its ChatGPT accounts beside it, oldest first. */
function codexPool(logins: import('../lib/codexLogin').CodexLogin[]) {
  return {
    id: '0195c0de-0000-7000-8000-000000000070',
    slug: 'my-codex',
    label: 'My Codex',
    engine: 'codex',
    login: logins[0] ?? null,
    logins,
    resetsAt: null,
    unavailable: null,
    members: [],
  };
}

/** The session, on the pool, running on `poolCodexLogin` — the detail's masked view of it. */
function session(poolCodexLogin: import('../lib/codexLogin').CodexLogin) {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    runnerId: RUNNER_ID,
    title: 'Pool session',
    status: 'AWAITING_INPUT',
    provider: 'my-codex',
    model: null,
    effort: 'high',
    permissionMode: 'auto',
    poolMemberProviderId: null,
    poolKeyId: null,
    poolCodexLogin,
    numTurns: 3,
    retryAt: null,
    retryAttempts: 0,
    startedAt: '2026-10-03T02:24:05Z',
    capabilities: { canSend: true, canResume: true },
    createdAt: '2026-10-03T02:24:00Z',
    updatedAt: '2026-10-03T02:30:00Z',
  };
}

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the composer account pill on a login-pool session', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const pill = () => mounted().querySelector<HTMLElement>('.composer-account');

  /** Mount over this session with this pool, and wait for the account pill to appear. */
  const mount = async (
    pool: ReturnType<typeof codexPool>,
    detail: ReturnType<typeof session>,
    pillText: string,
  ): Promise<void> => {
    vi.mocked(getSession).mockImplementation(async () => detail as never);
    apiMock.mockImplementation((p: string, options?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (options?.method === 'PATCH') return reply({});
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/providers') return reply([]);
      if (p === '/providers/pools') return reply([pool]);
      if (p === '/providers/shared-pools') return reply([]);
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z' }]);
      }
      if (p.startsWith(`/sessions/${SESSION}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/created-tasks')) return reply({ items: [] });
        if (p.includes('/diff')) return reply({ files: [] });
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
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const nextClient = client;
    const nextRoot = root;
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${SESSION}`]}>
            <Routes>
              <Route path="/sessions/:id" element={<WorkspaceView runner={RUNNER} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(
        () => expect(mounted().querySelector<HTMLElement>('.composer-account-name')?.textContent).toBe(pillText),
        { timeout: 20_000, interval: 20 },
      );
    });
  };

  /** The pill's tooltip words, read the way the mounted composer reads them: the session detail's
   *  masked account as the pool's member of it (`poolSessionLoginMember`), then `poolAccountHelp` —
   *  which must read as the claim's pick ("is running"), never as a session starting now. */
  const accountWords = (pool: ReturnType<typeof codexPool>, login: import('../lib/codexLogin').CodexLogin): string => {
    const picked = poolSessionLoginMember(pool, login);
    if (!picked) throw new Error('the session account did not resolve to a member of the pool');
    expect(picked.current).toBe(true);
    return poolAccountHelp(pool, picked);
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
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
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(updateSessionConfig).mockReset();
    vi.mocked(updateSessionConfig).mockResolvedValue({} as never);
    apiMock.mockReset();
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
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('names the account the session runs on — not the pool’s next one — and its own quota', async () => {
    // Two accounts, oldest first; the session runs on the newer one. The pool's `next` answer would
    // be the oldest — the wrong account, with the "starts on" words.
    const older = account('oldest@example.com', '…AAAA', 40);
    const newer = account('newest@example.com', '…BBBB', 7);
    const pool = codexPool([older, newer]);
    await mount(pool, session(newer), 'newest@example.com');

    const el = pill()!;
    expect(el.getAttribute('data-pool-account')).toBe('login:…BBBB');
    // Its own quota, not the oldest account's 40%.
    expect(mounted().querySelector('.composer-usage-pct')?.textContent).toBe('7%');
    // The claim's pick: "is running", never "starts on".
    expect(accountWords(pool, newer)).toBe('My Codex is running this session on newest@example.com');
  });

  it('still renders when the pool’s oldest account is spent — the production failure', async () => {
    // The oldest account is spent (both windows at 100%), so the pool marks NO member `next`; the
    // session runs on that very account. The pill and its quota have to render all the same.
    const spent = account('oldest@example.com', '…AAAA', 100);
    const fresh = account('newest@example.com', '…BBBB', 7);
    const pool = codexPool([spent, fresh]);
    await mount(pool, session(spent), 'oldest@example.com');

    const el = pill()!;
    expect(el.getAttribute('data-pool-account')).toBe('login:…AAAA');
    expect(mounted().querySelector('.composer-usage-pct')?.textContent).toBe('100%');
    expect(accountWords(pool, spent)).toBe('My Codex is running this session on oldest@example.com');
  });
});
