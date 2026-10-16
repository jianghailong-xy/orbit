// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer's Stop, and the one thing that makes it more than an interrupt: it also ends the
 * session's background work. The ask has to travel on the SAME request — one press, one decision —
 * and it has to be EXPLICIT, because an interrupt that kills nothing is what every other caller of
 * this endpoint gets (the engine's own session_interrupt, the MCP tool, the CLI): omitting the flag
 * is what keeps `interrupt` from silently becoming an `end`'s little brother.
 *
 * The wire shape itself is pinned in lib/interruptAndSend.test.ts. What is pinned HERE is the
 * wiring that a unit test of the API helper cannot see: that the button the person presses is the
 * one caller that asks for it.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    // interruptSession calls api.ts's own module-local `api`, so replacing that export would never
    // intercept the Stop button's request — the helper itself is what this test stands in for.
    // What the helper puts on the wire is pinned beside it, in lib/interruptAndSend.test.ts.
    interruptSession: vi.fn(),
  };
});

const { api, getSessionEventPage, listQueuedTurns, interruptSession } = await import('../api');
const apiMock = vi.mocked(api);
const interruptMock = vi.mocked(interruptSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a3');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** Mid-turn, with a background process the runner is hosting: the state Stop is for. */
const RUNNING_SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'start the dev server and run the suite',
  status: 'RUNNING',
  provider: 'claude',
  numTurns: 2,
  retryAt: null,
  retryAttempts: 0,
  runningBgCount: 1,
  createdAt: '2026-10-05T06:00:00Z',
  updatedAt: '2026-10-05T06:05:00Z',
};

const TAIL = [
  { seq: 1, type: 'user', payload: { text: 'start the dev server and run the suite' } },
  {
    seq: 2,
    type: 'tool_use',
    payload: {
      id: 'bg1',
      name: 'Bash',
      input: { command: 'npm run dev', run_in_background: true },
    },
  },
  {
    seq: 3,
    type: 'tool_result',
    payload: {
      toolUseId: 'bg1',
      content: 'Command running in background with ID: bei1. Output is being written to: /tmp/bei1.output.',
    },
  },
];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe("the composer's Stop ends the session's background work with the turn", { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const stopButton = (): HTMLElement | null =>
    mounted().querySelector<HTMLElement>('.composer-send[aria-label="Stop"]');
  const sendButton = (): HTMLElement | null =>
    mounted().querySelector<HTMLElement>('.composer-send[aria-label="Send"]');

  /** Every Stop this view asked for, as the helper received it. */
  const interrupts = (): unknown[][] => interruptMock.mock.calls.map((args) => [...args]);

  const mount = async (): Promise<void> => {
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: TAIL, hasMore: true } as never);
    const nextClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
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
      await vi.waitFor(() => expect(stopButton()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    interruptMock.mockReset();
    interruptMock.mockResolvedValue({ ok: true } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    apiMock.mockImplementation((path: string, init?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: TAIL, hasMore: true });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(RUNNING_SESSION);
      }
      if (path.startsWith('/sessions')) return reply([RUNNING_SESSION]);
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

  it('is offered on a session that is running, and asks for the background work in the same POST', async () => {
    await mount();
    // The composer is empty and the session is generating: this is the Stop the person sees.
    expect(sendButton(), 'the send button still morphs into Stop while a turn generates').toBeNull();

    await act(async () => {
      stopButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => expect(interrupts()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    });

    // One request, for THIS session, with the explicit flag — the whole of what makes this Stop
    // more than an interrupt. No follow-up rides along: the composer was empty, and a follow-up
    // would be its own argument.
    expect(interrupts()).toEqual([[SESSION_PUBLIC, undefined, { stopBackgroundWork: true }]]);
  });
});
