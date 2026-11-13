// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A transcript stream that stops must not stay stopped.
 *
 * The account owner's report: a tab left open, the machine asleep, and on waking the console sits
 * frozen — the running session's spinner still painted — until the page is reloaded. The socket a
 * slept-on machine leaves behind is half-open: no frame arrives, `onerror` never fires, and
 * EventSource has no read timeout, so nothing notices it. A stream that dropped a dozen times was
 * given up on outright, which leaves the same dead console.
 *
 * So: a silent stream is noticed and reconnected, the retries never stop, and a tab in the
 * background holds no stream at all — it reopens from the last seq when the tab is back in view.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000061';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000062');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000063');

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
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
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

describe('the transcript stream after a long idle', { timeout: 60_000 }, () => {
  it('keeps asking for the stream instead of giving up after a run of failures', async () => {
    let stream = await mountStream();
    // Twenty-four drops with nothing arriving in between: the old twelve-failure budget ran out
    // part-way through and the console stayed dead until a reload. Every backoff is waited out,
    // including the one-a-minute slow retry a long run of failures settles into.
    for (let i = 1; i <= 24; i += 1) {
      const asked = streams().length;
      await drop(stream);
      await waitForReconnect(asked);
      expect(streams().length, `drop ${i}: the stream was not asked for again`).toBeGreaterThan(asked);
      stream = latest();
    }
  });

  it('notices a socket that went silent without an error, and reconnects it', async () => {
    const first = await mountStream();
    expect(first.closed).toBe(false);
    // No frames at all: no keepalive, no onerror. The server pings every ~20s, so the silence is a
    // dead socket; the watchdog drops it at 60s and the retry opens a new one.
    await advance(63_000);
    expect(first.closed, 'the silent stream was left open').toBe(true);
    expect(streams().length, 'the silent stream was never retried').toBeGreaterThan(1);
    expect(streams().at(-1)?.closed).toBe(false);
  });

  it('holds no stream while the tab is in the background, and reopens it from where it stopped', async () => {
    const first = await mountStream();
    await setVisibility('hidden');
    expect(first.closed, 'a background tab kept its stream open').toBe(true);
    // Nothing retries it behind a tab nobody is looking at.
    await advance(120_000);
    expect(streams().filter((es) => !es.closed), 'a background tab opened another stream').toHaveLength(0);

    await setVisibility('visible');
    const reopened = streams().at(-1);
    expect(reopened, 'coming back into view opened no stream').not.toBe(first);
    expect(reopened?.closed).toBe(false);
    // And it resumes after what was already loaded, not from the beginning of the session.
    expect(reopened?.url).toContain('sinceSeq=2');
  });
});
