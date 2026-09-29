// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A link to one record of a session (`/sessions/<id>?at=<record>`, lib/transcriptDeepLink), end to
 * end through the real WorkspaceView: what it asks the server for, what it draws, and when it streams.
 *
 *   - opened at a record, the session shows the page around that record — not its tail — with the
 *     record's row marked, and keeps the live stream closed while the window stops short of the tail;
 *   - paging down to the latest event joins the stream; "Jump to latest" trades the window for the
 *     tail at once and takes the record out of the URL;
 *   - a record that is not the session's opens the session as it would open anyway, and says so;
 *   - a link to a record of the session already open scrolls when the record is loaded, and re-opens
 *     the window around it when it is not.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // The page readers live in the api module and call its module-local `api`, so each is replaced
  // by name — replacing the exported `api` alone would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionEventPageAround: vi.fn(),
    getSessionEventPageAfter: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stubs.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, getSessionEventPageAround, getSessionEventPageAfter } = await import('../api');
const apiMock = vi.mocked(api);
const tailMock = vi.mocked(getSessionEventPage);
const aroundMock = vi.mocked(getSessionEventPageAround);
const afterMock = vi.mocked(getSessionEventPageAfter);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
const { ApiError } = await import('../api');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000021';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000022';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000023';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;
/** The turn a footnote links to, deep below the tail — and a reply further on, already loaded. */
const LINKED_TURN = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const LOADED_REPLY = encodeId('0195c0de-0000-7000-8000-0000000000a2');

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Deep link',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-20T09:00:00Z',
  updatedAt: '2026-09-28T09:00:00Z',
};

const ask = (seq: number, text: string, turnId = `turn-${seq}`) =>
  ({ seq, type: 'user', payload: { text }, turnId, ts: '2026-09-20T10:00:00Z' });
const answer = (seq: number, text: string) =>
  ({ seq, type: 'assistant', payload: { text }, turnId: `turn-${seq - 1}`, ts: '2026-09-20T10:00:01Z' });

/** The page around the linked turn: its message at seq 42, with the conversation either side. */
const AROUND = [
  ask(40, 'an earlier question'),
  answer(41, 'an earlier answer'),
  ask(42, 'the question the footnote quotes', LINKED_TURN),
  answer(42 + 1, 'the answer to it'),
  ask(44, 'a later question'),
  answer(45, 'a later answer'),
];
const AROUND_PAGE = {
  events: AROUND,
  hasMore: false,
  before: null,
  after: 45,
  anchor: { kind: 'turn' as const, id: LINKED_TURN, seq: 42 },
};
/** The newest events: what the session opens on without a link. */
const TAIL = [ask(300, 'the latest question'), answer(301, 'the latest answer')];

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

const streams = (): FakeEventSource[] =>
  FakeEventSource.open.filter((es) => es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));

const unstubbed: string[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
let navigateTo: ((to: string) => void) | null = null;
let currentSearch = '';

/** Where the router is, and a way to follow a link the way an in-app `<Link>` does. */
function RouterProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  navigateTo = (to) => navigate(to);
  currentSearch = location.search;
  return null;
}

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

/** Past the session switch's debounce, after which a session that will stream has opened its stream. */
const pastStreamDebounce = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
};

const row = (seq: number): HTMLElement | null => mounted().querySelector<HTMLElement>(`[data-seq="${seq}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  unstubbed.length = 0;
  navigateTo = null;
  currentSearch = '';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  tailMock.mockReset();
  aroundMock.mockReset();
  afterMock.mockReset();
  tailMock.mockImplementation(async () => ({ events: TAIL, hasMore: false }));
  aroundMock.mockImplementation(async () => AROUND_PAGE);
  // Held until a test answers it: jsdom has no geometry, so a detached window is always "near the
  // bottom" and asks for its newer page at once.
  afterMock.mockImplementation(() => new Promise(() => {}));
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    if (path === '/providers' || path === '/providers/pools' || path === '/providers/shared-pools' || path === '/session-tags' || path === '/task-lists' || path === '/runners' || path === '/watches' || path === '/watches?state=ACTIVE' || path === '/watches?state=PAUSED' || path === '/watches?needsAttention=true') return reply([]);
    unstubbed.push(path);
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
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(path: string): Promise<void> {
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
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
            <RouterProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function follow(to: string): Promise<void> {
  await act(async () => {
    navigateTo!(to);
  });
}

describe('a session opened at one record', () => {
  it('shows the page around the record, marks it, and does not stream while the window stops short of the tail', async () => {
    await mount(`${SESSION_PATH}?at=${LINKED_TURN}`);

    await waitForUi(() => {
      expect(row(42)?.textContent).toContain('the question the footnote quotes');
      expect(row(42)?.classList.contains('record-flash'), 'the linked record is marked').toBe(true);
    });
    expect(aroundMock).toHaveBeenCalledWith(SESSION_PUBLIC, LINKED_TURN, expect.objectContaining({ limit: 200 }));
    // The tail is never asked for: the link opens where the record is, not at the latest message.
    expect(tailMock).not.toHaveBeenCalled();
    expect(mounted().textContent).not.toContain('the latest answer');
    // The rows either side of the record are on screen, in order.
    expect(row(40)?.textContent).toContain('an earlier question');
    expect(row(45)?.textContent).toContain('a later answer');
    // Paging down continues from the page's own newer cursor.
    await waitForUi(() => {
      expect(afterMock).toHaveBeenCalledWith(SESSION_PUBLIC, 45, { limit: 200 });
    });

    await pastStreamDebounce();
    expect(streams(), 'a window short of the tail must not stream events onto its bottom').toEqual([]);
    expect(mounted().querySelector('button[aria-label="Jump to latest"]')).not.toBeNull();
    expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
  });

  it('joins the live stream once paging down reaches the latest event', async () => {
    let answerNewer: (page: unknown) => void = () => {};
    afterMock.mockImplementation(() => new Promise((resolve) => { answerNewer = resolve as never; }));
    await mount(`${SESSION_PATH}?at=${LINKED_TURN}`);
    await waitForUi(() => {
      expect(afterMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      answerNewer({ events: [ask(46, 'the newest question'), answer(47, 'the newest answer')], hasMore: true, before: 46, after: null });
    });

    await waitForUi(() => {
      expect(row(47)?.textContent).toContain('the newest answer');
      expect(streams().filter((es) => !es.closed)).toHaveLength(1);
    });
    // The stream resumes right after the last event the pages brought in.
    expect(streams()[0].url).toContain('sinceSeq=47');
    expect(mounted().querySelector('button[aria-label="Jump to latest"]')).toBeNull();
    expect(row(42), 'the record stays where the reader was').not.toBeNull();
  });

  it('trades the window for the tail on "Jump to latest", and drops the record from the URL', async () => {
    await mount(`${SESSION_PATH}?at=${LINKED_TURN}`);
    await waitForUi(() => {
      expect(mounted().querySelector('button[aria-label="Jump to latest"]')).not.toBeNull();
    });
    expect(currentSearch).toBe(`?at=${LINKED_TURN}`);

    await act(async () => {
      mounted().querySelector<HTMLButtonElement>('button[aria-label="Jump to latest"]')!.click();
    });

    await waitForUi(() => {
      expect(row(301)?.textContent).toContain('the latest answer');
      expect(streams().filter((es) => !es.closed)).toHaveLength(1);
    });
    expect(tailMock).toHaveBeenCalledWith(SESSION_PUBLIC, expect.objectContaining({ tail: 200 }));
    expect(row(42), 'the window around the record is gone').toBeNull();
    expect(streams()[0].url).toContain('sinceSeq=301');
    expect(currentSearch, 'a reload now opens at the latest message').toBe('');
  });

  it('opens a record that is not the session\'s at the latest message, and says so', async () => {
    aroundMock.mockImplementation(async () => {
      throw new ApiError('record not found in this session', 404);
    });
    await mount(`${SESSION_PATH}?at=${LINKED_TURN}`);

    await waitForUi(() => {
      expect(row(301)?.textContent).toContain('the latest answer');
      expect(document.body.textContent).toContain('That message is not in this session');
    });
    await waitForUi(() => {
      expect(streams().filter((es) => !es.closed)).toHaveLength(1);
    });
  });
});

describe('a link to a record of the session already open', () => {
  it('scrolls to a record already loaded, and re-opens the window around one that is not', async () => {
    await mount(SESSION_PATH);
    await waitForUi(() => {
      expect(row(301)?.textContent).toContain('the latest answer');
      expect(streams().filter((es) => !es.closed)).toHaveLength(1);
    });
    expect(aroundMock).not.toHaveBeenCalled();
    const live = streams()[0];

    // A reply that is on screen already: marked where it is, the window and the stream untouched.
    aroundMock.mockImplementationOnce(async () => ({
      events: TAIL,
      hasMore: false,
      before: null,
      after: null,
      anchor: { kind: 'event' as const, id: LOADED_REPLY, seq: 301 },
    }));
    await follow(`${SESSION_PATH}?at=${LOADED_REPLY}`);
    await waitForUi(() => {
      expect(row(301)?.classList.contains('record-flash')).toBe(true);
    });
    expect(aroundMock).toHaveBeenLastCalledWith(SESSION_PUBLIC, LOADED_REPLY, expect.objectContaining({ limit: 200 }));
    expect(live.closed).toBe(false);
    expect(row(300)).not.toBeNull();

    // A turn far below the loaded window: the window becomes the page around it, off the stream.
    await follow(`${SESSION_PATH}?at=${LINKED_TURN}`);
    await waitForUi(() => {
      expect(row(42)?.classList.contains('record-flash')).toBe(true);
    });
    expect(row(301), 'the tail window was replaced').toBeNull();
    expect(live.closed, 'the stream closed with the window it was feeding').toBe(true);
    expect(streams().filter((es) => !es.closed)).toEqual([]);
  });
});
