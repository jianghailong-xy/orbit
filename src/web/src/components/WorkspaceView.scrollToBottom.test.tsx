// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEAR_BOTTOM } from '../lib/tailPinning';
import type { Runner } from './TasksSidePanel';

/**
 * When the jump-to-bottom button (`.scroll-to-bottom`) is on screen.
 *
 * It used to read the pin alone, and the pin lets go on a scroll UP alone — on purpose
 * (tailPinning.ts), so a streaming reply can't read as the reader leaving. So whenever the tail
 * left the view some other way — the last card opened under a reader sitting at the bottom, a link
 * card landing — the transcript still counted itself at the bottom and the button never showed:
 * the account owner's report was that it only ever appeared after a scroll up. The clients had the
 * same gap and close it the same way (ConsoleView's `stranded`).
 *
 * A pinned transcript whose tail has sat out of view for 400ms, with no content update in between,
 * is stranded, and that shows the button too. The wait is what keeps it from flashing while a reply
 * streams: the rows grow a moment before the follow catches up with them.
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

/** How long a pinned transcript's tail has to sit out of view before the button offers it. */
const STRAND_MS = 400;

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000051';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000052');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000053');

const LATEST = 'the reply the reader is sitting under';

const SEED = [
  { seq: 1, type: 'user', payload: { text: 'why does the build fail?' }, turnId: 't1', ts: '2026-10-02T09:00:00Z' },
  { seq: 2, type: 'tool_use', payload: { id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }, turnId: 't1', ts: '2026-10-02T09:00:10Z' },
  { seq: 3, type: 'tool_result', payload: { toolUseId: 'tu1', content: 'error TS2322', isError: true }, turnId: 't1', ts: '2026-10-02T09:00:20Z' },
  { seq: 4, type: 'assistant', payload: { text: LATEST }, turnId: 't1', ts: '2026-10-02T09:00:30Z' },
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
  title: 'a reply still being written',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-02T08:59:00Z',
  updatedAt: '2026-10-02T09:00:30Z',
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

/** jsdom lays nothing out, so no ResizeObserver ever fires on its own: the test fires them, for the
 *  elements a browser would report as having changed size. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  report(resized: Element[]) {
    const entries = resized
      .filter((target) => this.targets.has(target))
      .map((target) => ({ target }) as ResizeObserverEntry);
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
  }
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

/** The transcript's geometry, faked: a viewport, and content that grows with the rows on screen and
 *  with `grown` — height the content gained with no event behind it, like a card opened at the tail. */
const VIEWPORT = 800;
let grown = 0;
let scrollTop = 0;
const contentHeight = (): number =>
  2000 + 1000 * document.querySelectorAll('.workspace-scroll-wrap [data-seq]').length + grown;
/** How far below the viewport the tail sits: zero at the very end. */
const gap = (): number => contentHeight() - scrollTop - VIEWPORT;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

// The sidebar's session list carries the same class, so the scroller is taken from the pane.
const scroller = (): HTMLElement => {
  const el = mounted().querySelector<HTMLElement>('.workspace-scroll-wrap .workspace-sessions');
  if (!el) throw new Error('the transcript scroller is not mounted');
  return el;
};

const button = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.scroll-to-bottom');

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
};

/** The clock is the test's once the page is up (see mountTranscript). */
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** The last row of the transcript gets `px` taller — no scroll, no event. What a browser reports is
 *  that row and everything holding it inside the scroller; the scroller's own box keeps its size. */
const grow = async (px: number): Promise<void> => {
  grown += px;
  const el = scroller();
  const resized: Element[] = [];
  for (let n = [...el.querySelectorAll('[data-seq]')].at(-1) ?? null; n && n !== el; n = n.parentElement) {
    resized.push(n);
  }
  await act(async () => {
    for (const observer of FakeResizeObserver.all) observer.report(resized);
  });
};

/** One frame from the live stream, the way the server sends it. */
const publish = async (stream: FakeEventSource, event: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify(event) });
  });
};

/** The browser telling the transcript it has scrolled — jsdom fires no scroll event of its own. */
const reportScroll = async (): Promise<void> => {
  await act(async () => {
    scroller().dispatchEvent(new Event('scroll'));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  FakeResizeObserver.all = [];
  grown = 0;
  scrollTop = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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
  // Lands where a browser would: a scroll past the end stops at the end.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: (opts?: { top?: number }) => {
      if (typeof opts?.top === 'number') scrollTop = Math.max(0, Math.min(opts.top, contentHeight() - VIEWPORT));
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: contentHeight });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT });
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
    for (const prop of ['scrollTo', 'scrollIntoView', 'scrollTop', 'scrollHeight', 'clientHeight']) {
      delete (HTMLElement.prototype as Record<string, unknown>)[prop];
    }
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Opens the session and waits until it sits at its tail with its live stream open; from then on
 *  the clock only moves when the test moves it. */
async function mountTranscript(): Promise<FakeEventSource> {
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
  await waitForUi(() => expect(mounted().textContent, 'the transcript is on screen').toContain(LATEST));
  // The stream opens behind the session-switch debounce, a real timer, so it is waited for before
  // the clock is taken over.
  let stream: FakeEventSource | undefined;
  await waitForUi(() => {
    stream = FakeEventSource.open.find(
      (es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`),
    );
    expect(stream, 'the session opened no event stream').toBeTruthy();
  });
  expect(gap(), 'an opened session sits at its tail').toBe(0);
  expect(button(), 'and at the tail there is nothing to jump to').toBeNull();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return stream!;
}

describe('the jump-to-bottom button', { timeout: 60_000 }, () => {
  it('shows once the tail has sat out of view under a pinned reader, and goes once it is back', async () => {
    await mountTranscript();

    // The reader, sitting at the bottom, opens the last card, and it grows below the viewport. They
    // never scrolled, and the transcript still follows its tail — but the tail is out of view.
    await grow(600);
    expect(gap()).toBeGreaterThan(NEAR_BOTTOM);
    expect(button(), 'not on the frame the gap opened').toBeNull();
    advance(STRAND_MS - 1);
    expect(button(), 'nor before the gap has lasted').toBeNull();
    advance(1);
    expect(button(), 'the tail is out of view, so the way back to it is on screen').not.toBeNull();
    expect(button()!.getAttribute('aria-label')).toBe('Scroll to bottom');

    // Pressed, it takes the reader to the tail, and goes once the browser reports the scroll there.
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(gap(), 'the press scrolled to the tail').toBe(0);
    await reportScroll();
    expect(button(), 'back at the tail, there is nothing to jump to').toBeNull();
    advance(STRAND_MS * 3);
    expect(button(), 'and it stays gone').toBeNull();
  });

  it('never flashes while a streaming reply grows under the reader and the follow catches up', async () => {
    const stream = await mountTranscript();

    // Each update grows the reply, and the browser reports the taller rows before the follow has
    // caught up with them: for that moment the tail is out of view under a reader who is still
    // pinned. Here the follow is up to 300ms behind, and the reply streams for well over 400ms.
    for (let i = 0; i < 6; i++) {
      await grow(300);
      expect(gap(), `update ${i}: the gap the follow is about to close`).toBeGreaterThan(NEAR_BOTTOM);
      advance(STRAND_MS - 100);
      expect(button(), `update ${i}: before the follow`).toBeNull();

      await publish(stream, { seq: 100 + i, type: 'text_delta', payload: { text: `chunk ${i} ` } });
      expect(gap(), `update ${i}: the follow took the reader back to the tail`).toBe(0);
      expect(button(), `update ${i}: after the follow`).toBeNull();
    }

    advance(STRAND_MS * 3);
    expect(button(), 'nor once the reply has come to rest at the tail').toBeNull();
  });

  it('still shows the moment the reader scrolls up', async () => {
    await mountTranscript();

    // A wheel up off the tail: the reader's own hand on the scroller, then the scroll it made.
    await act(async () => {
      scroller().dispatchEvent(new Event('wheel'));
      scrollTop -= 1500;
      scroller().dispatchEvent(new Event('scroll'));
    });
    expect(button(), 'no wait for a reader who left the tail themselves').not.toBeNull();
  });
});
