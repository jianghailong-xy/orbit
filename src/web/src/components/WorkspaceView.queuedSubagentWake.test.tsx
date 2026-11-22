// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { SubagentRunView } from '@orbit/shared';
import type { Runner } from './TasksSidePanel';
import { SUBAGENT_INTERRUPTED } from '../lib/subagentFinished.fixtures';

/**
 * A SubAgent's end turn still on the queue (docs/mocks/subagent-card-and-end-line E1): the queued tail draws
 * no item for it. Its card says `Waiting for the agent to read it · Don't send`, and `Don't send` takes it off
 * the queue as the tail's Cancel did; once it is off the queue the line goes.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    cancelQueuedTurn: vi.fn(),
    // Like the queue's, a module-local call: only a mock of the export itself answers it.
    getSessionSubagents: vi.fn(async () => [RUN]),
    interruptSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, cancelQueuedTurn, getSessionEventPage, interruptSession, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const cancelMock = vi.mocked(cancelQueuedTurn);
const interruptMock = vi.mocked(interruptSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const RUN_ID = '34y5PintrRUNid0000003';
const WAKE = SUBAGENT_INTERRUPTED;
const TS = '2026-09-14T16:39:00.000Z';
const EVENTS = [
  { seq: 1, type: 'user', turnId: 'turn-1', ts: TS, payload: { text: 'Port the retry in the background.' } },
  {
    seq: 2,
    type: 'tool_use',
    turnId: 'turn-1',
    ts: TS,
    payload: {
      id: 'toolu_bg',
      name: 'mcp__orbit__delegate',
      input: { description: 'Port the retry to the Go runner', prompt: 'Port it.', type: 'general', background: true },
    },
  },
  {
    seq: 3,
    type: 'tool_result',
    turnId: 'turn-1',
    ts: TS,
    payload: { toolUseId: 'toolu_bg', content: [{ type: 'text', text: JSON.stringify({ runId: RUN_ID, status: 'running' }) }] },
  },
  { seq: 4, type: 'assistant', turnId: 'turn-1', ts: TS, payload: { text: 'Started it.' } },
  { seq: 5, type: 'turn_end', turnId: 'turn-1', ts: TS, payload: {} },
];
const RUN: SubagentRunView = {
  toolUseId: 'toolu_bg',
  type: 'general',
  background: true,
  status: 'INTERRUPTED',
  level: 'M',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5',
  effort: 'medium',
  reasons: [],
  why: null,
  removed: [],
  costUsd: 0,
  resultSummary: null,
  workspaceName: null,
  description: 'Port the retry to the Go runner',
  engine: 'claude',
  readonly: false,
  changedFiles: ['src/runner-go/retry.go'],
  createdAt: TS,
  endedAt: '2026-09-14T16:40:00.000Z',
};

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
  title: 'Coordinator: Watch project',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-14T16:00:00Z',
  updatedAt: '2026-09-14T16:40:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/** The server's queue: both turns wait behind the running one until something takes them off it. */
let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const composer = (): HTMLTextAreaElement | null =>
  mounted().querySelector<HTMLTextAreaElement>('.composer-field textarea');

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

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  queue = [
    { turnId: 'turn-wake', kind: 'message', placement: 'queued', content: WAKE, createdAt: '2026-09-14T16:40:01.000Z' },
  ];
  apiMock.mockReset();
  cancelMock.mockReset();
  cancelMock.mockImplementation(async (_session: string, turnId: string) => {
    queue = queue.filter((turn) => turn.turnId !== turnId);
    return {};
  });
  // An interrupt drops everything queued behind the turn it stops.
  interruptMock.mockReset();
  interruptMock.mockImplementation(async () => {
    queue = [];
    return {} as never;
  });
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS, hasMore: false } as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
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
}

const card = (): HTMLElement | null => mounted().querySelector<HTMLElement>(`[data-subagent-run="${RUN_ID}"]`);

describe('a SubAgent’s end turn on the queue', { timeout: 60_000 }, () => {
  it('waits on its card, not in the queued tail, and Don’t send takes it off the queue', async () => {
    await mountSession();
    await waitForUi(() => {
      expect(card()?.querySelector('.chat-subagent-end-chip')?.textContent).toBe('interrupted');
      expect(card()?.querySelector('.chat-subagent-queued')?.textContent).toBe(
        "Waiting for the agent to read it · Don't send",
      );
    });
    // The queued tail draws nothing for it: no line, no From Orbit line, no bubble, no queue row.
    expect(mounted().querySelector('.bgwake, .orbitwake, .chat-queued, .chat-queued-meta')).toBeNull();
    expect(mounted().querySelectorAll('.chat-user')).toHaveLength(1);
    expect(mounted().querySelectorAll('[data-subagent-run]')).toHaveLength(1);

    await click(card()!.querySelector('.chat-subagent-queued button')!);
    await waitForUi(() => {
      expect(cancelMock).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-wake');
      expect(card()?.querySelector('.chat-subagent-queued')).toBeNull();
    });
    // The card keeps its end.
    expect(card()?.querySelector('.chat-subagent-ending-reason')?.textContent).toContain('before it finished');
    expect(interruptMock).not.toHaveBeenCalled();
  });
});
