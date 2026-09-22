// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Getting back to a session's first message.
 *
 * The transcript is tail-first: it opens holding only the newest page and pulls in 200 more
 * whenever the reader comes within 400px of the top. Each page that lands is anchored to what the
 * reader was looking at — correct while reading, and fatal as a way back, because it leaves them a
 * page BELOW the top again. So the top recedes once per page and the first message of a long
 * session is, in practice, unreachable: the account owner photographed a session stopped
 * mid-conversation and asked why it would not scroll any further up. (Their session's start was
 * six pages back, and every page they pulled in pushed it one further away.)
 *
 * The way back is therefore a control, not a gesture: it walks the pages until the server says
 * there are no older events, and leaves the reader at the top of what it loaded.
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
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
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

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
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
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => expect(shown(), 'the tail page is on screen').toContain(LATEST));
}

describe('the way back to a session’s first message', { timeout: 60_000 }, () => {
  it('walks every older page in and lands at the top', async () => {
    await mountTranscript();

    // The tail page is all there is so far, and the session plainly starts somewhere above it.
    expect(shown()).not.toContain(FIRST);
    const jump = mounted().querySelector<HTMLElement>('.chat-jump-start');
    expect(jump, 'the top of the window offers the way back').not.toBeNull();

    await act(async () => {
      jump!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForUi(() => expect(shown(), 'the first message is loaded').toContain(FIRST));

    // Both older pages, each asked for from the boundary the one before it established — not one
    // page and a promise to fetch the rest if the reader scrolls again.
    expect(asked).toEqual([undefined, 5, 3]);
    // Nothing older remains, so the control has nothing left to offer and stands down.
    expect(mounted().querySelector('.chat-jump-start')).toBeNull();
    // And the reader is left looking at the start, not anchored where they were before the walk.
    expect(scrolls.at(-1)).toEqual({ top: 0 });
    expect(scrollTop).toBe(0);
    // Every page the walk pulled in was pinned to the top as it landed. The last one is the one
    // that bites: it commits after the walk has finished, so a walk that decides this from "am I
    // still walking?" restores the pre-walk position instead and drops the reader a page below the
    // beginning it just loaded (measured in a real browser: 1,759px below it).
    expect(scrollTopsSet.filter((v) => v !== 0)).toEqual([]);
  });

  it('is not offered once the whole session is loaded', async () => {
    vi.mocked(getSessionEventPage).mockImplementation((async (_id: string, opts: { before?: number }) => {
      asked.push(opts.before);
      return { events: PAGES.flat(), hasMore: false };
    }) as never);

    await mountTranscript();

    expect(shown(), 'the first message came with the only page there was').toContain(FIRST);
    expect(mounted().querySelector('.chat-jump-start')).toBeNull();
  });
});
