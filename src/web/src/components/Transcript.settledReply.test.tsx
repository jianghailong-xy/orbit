// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A reply that has finished is its words and nothing else: no row of actions under it. The only row
 * a conversation's messages carry is the user bubble's, the copy button and the time.
 *
 * The wiki is written by the agent's `wiki_propose` and by its own import and maintenance jobs, not
 * by hand from a message (owner, 2026-09-26), so the session page offers no way to file one into it.
 * The page is mounted whole, with the wiki switched on for the account, because that is the one
 * arrangement in which such an entry point could be drawn at all.
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
const { Transcript } = await import('./Transcript');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const ASKED = 'Does an update wait for the turn in flight?';
const ANSWERED = 'It does. A runner update never evicts a turn that is still running.';

const EVENTS: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 'turn-1', ts: '2026-09-26T09:00:00.000Z', payload: { text: ASKED } },
  { seq: 2, type: 'assistant', turnId: 'turn-1', ts: '2026-09-26T09:00:30.000Z', payload: { text: ANSWERED } },
];

/** Anything on the page offering to put a message into the wiki, by its words or by its label. */
const WIKI_ENTRY_POINT = /add\s+to\s+wiki/i;

function expectTheTwoMessagesAsTheyWere(page: HTMLElement) {
  const reply = page.querySelector<HTMLElement>('.chat-assistant[data-seq="2"]');
  expect(reply, 'the reply is on screen').not.toBeNull();
  expect(reply!.className, 'settled, not a draft').toBe('chat-msg chat-assistant');
  expect([...reply!.children].map((el) => el.className), 'the reply is its words alone').toEqual(['md']);
  expect(reply!.textContent).toBe(ANSWERED);

  // One copy button and one time on the page, both in the user bubble's row: nothing drew a row of
  // its own under the reply, inside its box or around it.
  const meta = page.querySelector<HTMLElement>('.chat-user-meta');
  expect(meta, "the user bubble's row").not.toBeNull();
  expect([...meta!.children].map((el) => el.className)).toEqual(['chat-copy', 'chat-time']);
  expect(page.querySelectorAll('.chat-copy')).toHaveLength(1);
  expect(page.querySelectorAll('.chat-time')).toHaveLength(1);
}

function expectNoWikiEntryPoint(page: HTMLElement) {
  expect(page.textContent ?? '').not.toMatch(WIKI_ENTRY_POINT);
  const labelled = [...page.querySelectorAll('[aria-label], [title]')].filter((el) =>
    WIKI_ENTRY_POINT.test(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`),
  );
  expect(labelled.map((el) => el.outerHTML)).toEqual([]);
}

describe('a settled reply in the transcript', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('carries no row of actions under it', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={EVENTS} />
        </MemoryRouter>,
      );
    });

    expectTheTwoMessagesAsTheyWere(container);
    expectNoWikiEntryPoint(container);
  });
});

// ── the whole session page, with the wiki switched on ──────────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Runner updates and turns in flight',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-26T08:59:00Z',
  updatedAt: '2026-09-26T09:00:30Z',
};

/** A wiki space of this account's own: what the owner's space list answers when the wiki is on. */
const SPACE = { id: encodeId('0195c0de-0000-7000-8000-000000000044'), slug: 'orbit', name: 'orbit', pendingCount: 0 };

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the session page', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(listQueuedTurns).mockResolvedValue([]);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS, hasMore: false } as never);
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      // The wiki is on for this account: its spaces answer, rather than 404 WIKI_DISABLED.
      if (path.startsWith('/wiki/spaces')) return reply(path === '/wiki/spaces' ? [SPACE] : SPACE);
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: EVENTS, hasMore: false });
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

  it('offers no way to put a message into the wiki', async () => {
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
    await act(async () => {
      await vi.waitFor(
        () => expect(mounted().querySelector('.chat-assistant[data-seq="2"]')).not.toBeNull(),
        { timeout: 20_000, interval: 20 },
      );
    });
    // Whatever the page asks of the server once the conversation is up has had its answer before
    // anything below is read, so an entry point that waits on one would be on screen by now.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expectTheTwoMessagesAsTheyWere(mounted());
    // The whole page, not only the transcript: the header, the composer and every strip around them.
    expectNoWikiEntryPoint(document.body);
  });
});
