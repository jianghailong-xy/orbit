// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A question answered on another client must not stay open here.
 *
 * The account owner's report: a question answered on the phone was still on the web, still
 * answerable. The card leaves on an `approval_resolved` frame, which is live-only — never stored,
 * never replayed — so a stream that was closed when the answer landed (a tab in the background, a
 * dropped socket) never hears of it. Each time the stream opens, the pending cards are read again.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn(), listApprovals: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000071';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000072');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000073');

const SEED = [
  { seq: 1, type: 'user', payload: { text: 'run the build' }, turnId: 't1', ts: '2026-10-02T09:00:00Z' },
  { seq: 2, type: 'assistant', payload: { text: 'building now' }, turnId: 't1', ts: '2026-10-02T09:00:10Z' },
];

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
  title: 'a turn still running',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-02T08:59:00Z',
  updatedAt: '2026-10-02T09:00:10Z',
};

const QUESTION = 'Which database should the migration target?';
const LATER_QUESTION = 'Should the old table be dropped afterwards?';

const card = (n: number, question: string) => ({
  id: encodeId(`0195c0de-0000-7000-8000-00000000008${n}`),
  sessionId: SESSION_PUBLIC,
  toolName: 'AskUserQuestion',
  toolUseId: `toolu_q${n}`,
  status: 'PENDING',
  createdAt: '2026-10-02T09:00:20Z',
  input: {
    questions: [{
      question,
      header: 'Choice',
      multiSelect: false,
      options: [{ label: 'Yes', description: 'Go ahead' }, { label: 'No', description: 'Leave it' }],
    }],
  },
});
const FIRST_CARD = card(1, QUESTION);
const LATER_CARD = card(2, LATER_QUESTION);

/** What `listApprovals` answers; a case swaps it to say what the server holds now. */
let pendingApprovals: () => Promise<unknown>;

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
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

const streams = (): FakeEventSource[] =>
  FakeEventSource.open.filter((es) => es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));
const latest = (): FakeEventSource => {
  const stream = streams().at(-1);
  if (!stream) throw new Error('the session opened no event stream');
  return stream;
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {});
};

const drop = async (stream: FakeEventSource): Promise<void> => {
  if (stream.closed) return;
  await act(async () => {
    stream.onerror?.();
  });
};

/** Moves the clock until a stream is asked for again, so the watchdog's own silence budget never
 *  gets a vote: while a retry is pending no stream is open and it stays out of the way. */
const waitForReconnect = async (asked: number): Promise<void> => {
  for (let waited = 0; waited < 62_000 && streams().length === asked; waited += 5_000) {
    await advance(5_000);
  }
};

/** The browser telling the page its tab changed visibility — jsdom fires none of its own. */
const setVisibility = async (state: 'visible' | 'hidden'): Promise<void> => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeEventSource.open = [];
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  apiMock.mockReset();
  pendingApprovals = async () => [FIRST_CARD];
  vi.mocked(listApprovals).mockImplementation((() => pendingApprovals()) as never);
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
  vi.mocked(getSessionEventPage).mockImplementation((async () => ({ events: SEED, hasMore: false })) as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: SEED, hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
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
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  // Before anything else: tearing the page down waits on timers of its own.
  vi.useRealTimers();
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
    delete (document as unknown as Record<string, unknown>).visibilityState;
    for (const prop of ['scrollTo', 'scrollIntoView']) {
      delete (HTMLElement.prototype as Record<string, unknown>)[prop];
    }
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Opens the session and waits until its live transcript stream is on the wire. */
async function mountStream(): Promise<FakeEventSource> {
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
  // The seed fetch and the session-switch debounce both sit between the mount and the connect.
  for (let attempt = 0; attempt < 10 && streams().length === 0; attempt += 1) {
    await advance(250);
  }
  return latest();
}

const shown = (text: string): boolean => (container?.textContent ?? '').includes(text);
const approvalReads = (): number =>
  vi.mocked(listApprovals).mock.calls.length;

/** The new stream reaches the server, then the frames it carries arrive. */
const opens = async (stream: FakeEventSource): Promise<void> => {
  await act(async () => {
    stream.onopen?.();
  });
  await act(async () => {});
};
const frame = async (stream: FakeEventSource, event: unknown): Promise<void> => {
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify(event) });
  });
  await act(async () => {});
};

/** The tab leaves and comes back: the stream it held is closed and a new one is opened. */
const awayAndBack = async (first: FakeEventSource): Promise<FakeEventSource> => {
  await setVisibility('hidden');
  expect(first.closed, 'a background tab kept its stream open').toBe(true);
  await setVisibility('visible');
  const reopened = latest();
  expect(reopened).not.toBe(first);
  return reopened;
};

describe('a question answered while this tab was not listening', { timeout: 60_000 }, () => {
  it('leaves once the stream is back, as the server no longer holds it', async () => {
    const first = await mountStream();
    await opens(first);
    await advance(0);
    expect(shown(QUESTION), 'the pending question was never drawn').toBe(true);

    // Answered on the phone while this tab was in the background: no frame reaches it.
    pendingApprovals = async () => [];
    const reopened = await awayAndBack(first);
    await opens(reopened);
    await advance(0);
    expect(shown(QUESTION), 'the answered question is still open on the web').toBe(false);
  });

  it('reads the cards again on every reopen, including one raised while the tab was away', async () => {
    const first = await mountStream();
    await opens(first);
    await advance(0);
    const before = approvalReads();

    pendingApprovals = async () => [FIRST_CARD, LATER_CARD];
    const reopened = await awayAndBack(first);
    await opens(reopened);
    await advance(0);
    expect(approvalReads()).toBeGreaterThan(before);
    expect(shown(QUESTION)).toBe(true);
    expect(shown(LATER_QUESTION), 'a card raised while the tab was away never appeared').toBe(true);
  });

  it('lets the frames that arrive during the read win over its older snapshot', async () => {
    const first = await mountStream();
    await opens(first);
    await advance(0);
    expect(shown(QUESTION)).toBe(true);

    // The read is answered late, with a snapshot taken before either frame below.
    let answer: (rows: unknown) => void = () => {};
    pendingApprovals = () => new Promise((resolve) => { answer = resolve; });
    const reopened = await awayAndBack(first);
    await opens(reopened);
    await frame(reopened, { seq: 0, type: 'approval_resolved', payload: { id: FIRST_CARD.id, behavior: 'allow' } });
    await frame(reopened, {
      seq: 0,
      type: 'approval_request',
      payload: { id: LATER_CARD.id, toolName: LATER_CARD.toolName, input: LATER_CARD.input, toolUseId: LATER_CARD.toolUseId },
    });
    await act(async () => {
      answer([FIRST_CARD]);
    });
    await advance(0);
    expect(shown(QUESTION), 'a stale read brought back a card resolved after it was taken').toBe(false);
    expect(shown(LATER_QUESTION), 'a stale read dropped a card raised after it was taken').toBe(true);
  });
});
