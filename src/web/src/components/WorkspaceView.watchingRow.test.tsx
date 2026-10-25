// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The session list's row for a session a live watch will resume, on the real WorkspaceView: the
 * screenshot this started from had the list read it as "Waiting for your reply" over the last reply,
 * while the header and the Watching strip in the same window said Watching. The words are
 * lib/watches' and the branching is `sessionLine` / `StatusIcon`'s, each tested on its own; what is
 * asserted here is that the list hands every row the watches the header reads.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const WATCHING_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c3');
const PLAIN_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c4');
const TARGET_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c5');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const WORKSPACE = { id: WORKSPACE_PUBLIC, name: 'orbit', model: null, effort: null };

/** A parked list row, as GET /sessions answers it. */
const row = (id: string, title: string, reply: string) => ({
  id,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-10-02T05:00:00Z',
  lastTurnAt: '2026-10-02T05:34:00Z',
  lastAssistantText: reply,
});
const WATCHING = row(WATCHING_PUBLIC, '会话间消息参数与回复设计', '你需要做的只有一件事：等我说可以确认。');
const PLAIN = row(PLAIN_PUBLIC, '排队区的 watch 唤醒卡片', '改好了：要我合并吗？');
const TARGET_TITLE = '执行任务：会话间请求与回复：修复 P1 审查发现的问题';

/** session_await's watch, as GET /watches answers it: the first row is its observer. */
const WATCH = {
  id: 'watch-1',
  observerType: 'SESSION',
  observerSessionId: WATCHING_PUBLIC,
  predicateVersion: 1,
  predicate: {
    kind: 'ANY_OF',
    operands: [
      { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_NEEDS_ATTENTION' },
    ],
  },
  mode: 'ONE_SHOT',
  action: 'RESUME_SESSION',
  state: 'ACTIVE',
  generation: 0,
  expiresAt: '2026-10-03T05:00:00Z',
  nextEvaluateAt: '2026-10-02T05:35:00Z',
  lastEvaluatedAt: '2026-10-02T05:34:30Z',
  idempotencyKey: null,
  createdAt: '2026-10-02T05:34:00Z',
  updatedAt: '2026-10-02T05:34:00Z',
  targets: [
    {
      targetKind: 'SESSION',
      targetResourceId: TARGET_PUBLIC,
      state: 'OBSERVED',
      targetEpoch: 0,
      lastEvaluatedAt: '2026-10-02T05:34:30Z',
      targetTitle: TARGET_TITLE,
      targetStatus: { status: 'RUNNING', running: true, queued: false },
    },
  ],
  matches: [],
  expiryDeliveries: [],
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const listRow = (title: string): HTMLElement => {
  const found = [...mounted().querySelectorAll<HTMLElement>('.session-row')].find(
    (el) => el.querySelector('.session-title')?.textContent === title,
  );
  if (!found) throw new Error(`no list row titled ${title}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (id: string) => (id === PLAIN_PUBLIC ? PLAIN : WATCHING) as never);
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply(undefined);
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    // All four of the watches query's reads: the live ones carry it, the merged list keeps it once.
    if (path.startsWith('/watches')) return reply(path.includes('needsAttention') ? [] : [WATCH]);
    for (const session of [WATCHING, PLAIN]) {
      if (path.startsWith(`/sessions/${session.id}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(session);
      }
    }
    if (path.startsWith('/sessions')) return reply([WATCHING, PLAIN]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof api);
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

describe('the session list over a session a watch will resume', { timeout: 60_000 }, () => {
  it('draws its row as Watching, in the strip’s words, and leaves a plain reply alone', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const nextContainer = document.createElement('div');
    const nextRoot = createRoot(nextContainer);
    client = nextClient;
    container = nextContainer;
    root = nextRoot;
    document.body.appendChild(nextContainer);
    // The plain one is open, so the watched row is drawn from the list's own copy of it.
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${PLAIN_PUBLIC}`]}>
            <WorkspaceView runner={RUNNER} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(listRow(WATCHING.title).querySelector('.session-icon .anticon-eye')).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });

    const watching = listRow(WATCHING.title);
    const line = watching.querySelector('.session-preview');
    expect(line?.textContent).toBe(`Watching ${TARGET_TITLE}`);
    expect(line?.classList.contains('tone-watching')).toBe(true);
    expect(watching.querySelector('.session-icon .anticon-message')).toBeNull();

    // The other parked session is waiting for a reply, and still says so.
    const plain = listRow(PLAIN.title);
    expect(plain.querySelector('.session-icon .anticon-message')).not.toBeNull();
    expect(plain.querySelector('.session-icon .anticon-eye')).toBeNull();
    expect(plain.querySelector('.session-preview')?.textContent).toBe(PLAIN.lastAssistantText);
  });
});
