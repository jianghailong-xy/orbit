// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A transcript whose tail page failed still knows it has a beginning above it.
 *
 * When the tail page cannot be fetched (the apiserver restarting, say), the transcript falls back
 * to the stream's cursor-less replay, which starts mid-conversation. That window used to be marked
 * "nothing older", and the transcript cache kept it that way across reloads: the account owner's
 * session stopped at its 36th event and would scroll no further up (2026-11-16). The replay's first
 * event is the window's older edge, with history above it to page in.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');

const FIRST = 'the first thing I ever asked here';
const LATEST = 'the answer nobody has to scroll for';

/** Three pages, oldest first — the session as the server holds it. */
const PAGES = [
  [
    { seq: 1, type: 'user', payload: { text: FIRST }, turnId: 't1', ts: '2026-09-16T11:16:03Z' },
    { seq: 2, type: 'assistant', payload: { text: 'answering it' }, turnId: 't1', ts: '2026-09-16T11:16:30Z' },
  ],
  [
    { seq: 3, type: 'user', payload: { text: 'something in the middle' }, turnId: 't2', ts: '2026-09-17T09:00:00Z' },
    { seq: 4, type: 'assistant', payload: { text: 'the middle answer' }, turnId: 't2', ts: '2026-09-17T09:01:00Z' },
  ],
  [
    { seq: 5, type: 'user', payload: { text: 'the latest question' }, turnId: 't3', ts: '2026-09-18T18:00:00Z' },
    { seq: 6, type: 'assistant', payload: { text: LATEST }, turnId: 't3', ts: '2026-09-18T18:01:00Z' },
  ],
];

/** `tail` serves the newest page; `before` serves the page just older than the seq asked for. */
const pageFor = (opts: { tail?: number; before?: number }) => {
  const index =
    opts.before == null ? PAGES.length - 1 : PAGES.findIndex((p) => p[0].seq === opts.before) - 1;
  if (index < 0) return { events: [], hasMore: false };
  return { events: PAGES[index], hasMore: index > 0 };
};

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {}
}

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
  title: 'a session long enough to have a beginning',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-16T11:15:48Z',
  updatedAt: '2026-09-18T18:01:00Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
/** The `before` seq of every page the transcript asked for, in order. */
let asked: (number | undefined)[] = [];
/** Every `scrollTo` the transcript made, so the landing position is observable. */
let scrolls: { top?: number }[] = [];
/** jsdom lays nothing out; the transcript's own geometry is faked so it reads as scrolled well
 *  clear of the top — otherwise every render would look like "at the top" and pull pages in on
 *  its own, which is the very thing this control exists because the reader cannot do. */
let scrollTop = 5000;
/** Every scrollTop the transcript assigned, in order. A page that lands during the walk is pinned
 *  to the top; a page that lands with its reading position restored instead assigns the height it
 *  just added, which is how the walk used to strand the reader a page below the start. */
let scrollTopsSet: number[] = [];

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const shown = (): string => mounted().textContent ?? '';

/** The reader drags the transcript up off its live tail — the state the way back is offered in.
 *  Opening a session pins it to the bottom, and jsdom fires no scroll of its own, so this moves
 *  the faked geometry and then tells the transcript to look. Assigned to the backing value rather
 *  than through the element, so the move the reader made is not mistaken for one the walk made. */
const scrollUpOffTail = async (): Promise<void> => {
  // The sidebar's session list carries the same class, so the scroller is taken from the pane.
  const el = mounted().querySelector<HTMLElement>('.workspace-scroll-wrap .workspace-sessions');
  if (!el) throw new Error('the transcript scroller is not mounted');
  scrollTop = 5000; // still well clear of the top: reading history, not asking for a page
  await act(async () => {
    el.dispatchEvent(new Event('scroll'));
  });
};

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  // The act environment is off while the window is waited out, as RTL's own asyncWrapper
  // does it: React queues every render scheduled inside an in-flight act callback and flushes
  // none of them until that callback settles, so a page that answers inside the window can
  // never draw what the window exists to see — the wait times out with the data already in
  // the cache (workstation-gpu: e85b63ee9's second full run; the merge check reds here).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  // And one act to close the window: the last commit the wait saw leaves its passive effects
  // scheduled, and what they carry — React Query's mutation options among it — is what the
  // test's next press runs on. The old act-wrapped wait flushed them on its way out; this
  // keeps that, without the freeze that made the wait itself blind.
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  FakeEventSource.all = [];
  scrolls = [];
  scrollTop = 5000;
  scrollTopsSet = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
  vi.mocked(getSessionEventPage).mockImplementation((async (_id: string, opts: { tail?: number; before?: number }) => {
    asked.push(opts.before);
    return pageFor(opts);
  }) as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function scrollTo(this: Element, opts: { top?: number }) {
      scrolls.push(opts ?? {});
      if (typeof opts?.top === 'number') scrollTop = opts.top;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTopsSet.push(value);
      scrollTop = value;
    },
  });
  // Grows with the transcript, so restoring a reading position is distinguishable from pinning to
  // the top: the restore assigns the height the page just added, the pin assigns zero.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 20000 + 1000 * document.querySelectorAll('[data-seq]').length,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
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
    for (const prop of ['scrollTo', 'scrollIntoView', 'scrollTop', 'scrollHeight', 'clientHeight']) {
      delete (HTMLElement.prototype as Record<string, unknown>)[prop];
    }
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mountTranscript(): Promise<void> {
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
}

describe('a transcript seeded by the stream’s replay', { timeout: 60_000 }, () => {
  it('pages back to the first message from where the replay began', async () => {
    // Every tail page fails; older pages answer. The stream is what fills the window.
    vi.mocked(getSessionEventPage).mockImplementation((async (_id: string, opts: { tail?: number; before?: number }) => {
      asked.push(opts.before);
      if (opts.before == null) throw new Error('502');
      return pageFor(opts);
    }) as never);

    await mountTranscript();
    await waitForUi(() => expect(FakeEventSource.all.length, 'the stream opens after the tail page gave up').toBeGreaterThan(0));
    const es = FakeEventSource.all.at(-1)!;
    expect(es.url, 'a cursor-less connect: the server replays its capped tail').not.toContain('sinceSeq');
    await act(async () => {
      for (const ev of PAGES[2]) es.onmessage?.({ data: JSON.stringify(ev) });
    });
    await waitForUi(() => expect(shown()).toContain(LATEST));
    expect(shown()).not.toContain(FIRST);

    await scrollUpOffTail();
    const jump = mounted().querySelector<HTMLElement>('.chat-jump-start');
    expect(jump, 'history above the replay is offered').not.toBeNull();
    await act(async () => {
      jump!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForUi(() => expect(shown(), 'the first message is loaded').toContain(FIRST));
    // Paged from the replay's first event, after the three failed tail attempts.
    expect(asked).toEqual([undefined, undefined, undefined, 5, 3]);
  });
});
