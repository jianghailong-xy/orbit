// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Which "something is still running" states the composer offers Stop in.
 *
 * Stop used to be gated on the raw status being RUNNING, which left two states with no way to
 * interrupt at all: a turn the engine started for itself (the session stays parked at
 * AWAITING_INPUT for its whole duration — engineTurnActive) and a parked turn whose background
 * work is still in flight. The runner asks the engine to interrupt unconditionally, precisely so
 * those are stoppable; the client gate was what made the button absent. The header already draws
 * both as working, so the button and the glyph must read the same facts.
 *
 * All four states are pinned here, the last one only to hold the line the other way: a genuinely
 * idle session still gets Send, not a Stop that would do nothing.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // The list/detail readers live in api.ts and call its module-local `api`, so overriding the
  // export is what intercepts them. `interruptSession` is deliberately left REAL: the press test
  // below wants the actual request on the wire, not a stub of the function that would make it.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    cancelQueuedTurn: vi.fn(),
  };
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

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** The one row every case mounts; each test states only what it is about — the four fields the
 *  Stop predicate reads start parked and idle. */
let session: Record<string, unknown>;
const parkedAndIdle = (): Record<string, unknown> => ({
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'composer Stop',
  provider: 'claude',
  createdAt: '2026-10-05T08:00:00Z',
  updatedAt: '2026-10-05T08:10:00Z',
  status: 'AWAITING_INPUT',
  engineTurnActive: false,
  runningSubagentCount: 0,
  runningBgCount: 0,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
const fetchMock = vi.fn();

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const stop = (): Element | null => mounted().querySelector('[aria-label="Stop"]');

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  // A few readers in api.ts (background shells among them) call the module-local `api`, so they
  // reach this stub rather than the mocked export. Answer every one of them: the interrupt with
  // the server's own receipt, everything else with an empty list, which is the shape those
  // readers iterate.
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    const body = String(url).includes('/interrupt') ? { ok: true } : [];
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  session = parkedAndIdle();
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(session);
    }
    if (path.startsWith('/sessions')) return reply([session]);
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

/** Mounts the session at `/sessions/:id` and hands back the mounted pane. */
async function mountSession(): Promise<void> {
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
  // A pane with no session draws a composer too, so waiting for the box alone would let an
  // unloaded row answer the assertions below. The title is what says this session's own row is in
  // hand — and the idle case, which asserts the ABSENCE of Stop, is the one that would otherwise
  // pass for the wrong reason.
  await waitForUi(() => {
    expect(mounted().querySelector('.composer-field'), 'the composer is drawn').not.toBeNull();
    expect(mounted().textContent, 'the session row is in hand').toContain('composer Stop');
  });
}

describe('Stop in the composer', { timeout: 60_000 }, () => {
  it('is offered while the dispatched turn is RUNNING', async () => {
    session = { ...parkedAndIdle(), status: 'RUNNING' };
    await mountSession();
    await waitForUi(() => expect(stop(), 'a RUNNING session offers Stop').not.toBeNull());
  });

  it('is offered for a turn the engine started for itself (AWAITING_INPUT + engineTurnActive)', async () => {
    session = { ...parkedAndIdle(), engineTurnActive: true };
    await mountSession();
    // Parked status, engine working: that turn never reaches /turn-complete, so without reading
    // engineTurnActive there is no moment at which this session has a Stop.
    await waitForUi(() => expect(stop(), 'a self-driven turn is stoppable').not.toBeNull());
  });

  it('is offered when only background work is left running', async () => {
    // Either spelling of "still running behind the parked turn" earns the button: a sub-agent, and
    // a background process. Deliberate — see the predicate's comment; the press's own effect on
    // that work is a separate piece of work, the button appearing is this one's.
    for (const parked of [
      { runningSubagentCount: 1, runningBgCount: 0 },
      { runningSubagentCount: 0, runningBgCount: 2 },
    ]) {
      session = { ...parkedAndIdle(), ...parked };
      await mountSession();
      await waitForUi(() =>
        expect(stop(), `parked with ${JSON.stringify(parked)} offers Stop`).not.toBeNull(),
      );
      await act(async () => root?.unmount());
      container?.remove();
      document.body.innerHTML = '';
    }
  });

  it('is not offered on a genuinely idle session, which keeps Send', async () => {
    session = parkedAndIdle();
    await mountSession();
    expect(stop(), 'nothing to stop: no Stop').toBeNull();
    expect(mounted().querySelector('[aria-label="Send"]'), 'the send arrow is what is offered').not.toBeNull();
  });

  it('posts the interrupt for the session it was pressed on', async () => {
    session = { ...parkedAndIdle(), engineTurnActive: true };
    await mountSession();
    await waitForUi(() => expect(stop()).not.toBeNull());

    await click(stop()!);

    await waitForUi(() => {
      const posted = fetchMock.mock.calls.map(([url, init]) => ({
        url: url as string,
        method: (init as RequestInit | undefined)?.method,
      }));
      expect(posted).toContainEqual({ url: `/api/sessions/${SESSION_PUBLIC}/interrupt`, method: 'POST' });
    });
  });
});
