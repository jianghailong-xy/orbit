// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEER_WITHDRAW_ERRORS } from '@orbit/shared';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * Taking back a message sent into the running turn while nothing has read it (lib/steerDelivery,
 * WorkspaceView `withdrawSteer`). The bubble offers it beside "Waiting to be read" when its runner
 * said the engine can drop it unread; the press asks the server, which asks the engine; only its
 * answer removes the bubble, and then the words are back in the composer. Too late, it says so and
 * the bubble stays. A steer the runner has not taken yet is offered the same way from the queue.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
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

const { api, ApiError, cancelQueuedTurn, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const cancelMock = vi.mocked(cancelQueuedTurn);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');
const STEER = 'dp/tea_data_helper 的代码在 ~/dp/tea_data_helper 修复后 push into main，然后发布';

const RUNNER = {
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Fix the export script',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-15T09:00:00Z',
  updatedAt: '2026-10-15T09:40:00Z',
};

/** A turn busy in a long Bash call, and the message written into it while it runs. */
const RUNNING: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 'turn-run', ts: '2026-10-15T09:40:00Z', payload: { text: 'fix the export script' } },
  {
    seq: 2,
    type: 'tool_use',
    turnId: 'turn-run',
    ts: '2026-10-15T09:41:00Z',
    payload: { id: 'b1', name: 'Bash', input: { command: 'python -m pytest -q', description: 'Run the full test suite' } },
  },
  {
    seq: 3,
    type: 'user',
    turnId: 'turn-steer',
    ts: '2026-10-15T09:42:00Z',
    payload: { text: STEER, delivery: 'enqueued', steer: true, withdrawable: true },
  },
  { seq: 4, type: 'user_delivery', turnId: 'turn-steer', ts: '2026-10-15T09:42:01Z', payload: { turnId: 'turn-steer', delivery: 'written' } },
];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let events: RunEvent[] = RUNNING;
let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const composer = (): HTMLTextAreaElement | null => mounted().querySelector<HTMLTextAreaElement>('.composer-field textarea');
const steerBubble = (): HTMLElement | undefined =>
  [...mounted().querySelectorAll<HTMLElement>('.chat-user-wrap')].find((w) => w.textContent?.includes('push into main'));

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
  events = RUNNING;
  queue = [];
  apiMock.mockReset();
  cancelMock.mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events, hasMore: false }) as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'dp', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events, hasMore: false });
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

async function mountSession(ready: () => void): Promise<void> {
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
  await waitForUi(ready);
}

const withdrawButton = (scope: Element | undefined): HTMLElement | undefined =>
  [...(scope?.querySelectorAll<HTMLElement>('button, a') ?? [])].find((b) => b.textContent === 'Withdraw');

describe('a message sent into the running turn, taken back', { timeout: 60_000 }, () => {
  it('goes when the engine drops it, and its words are back in the composer', async () => {
    cancelMock.mockResolvedValue({ ok: true, withdrawn: true });
    await mountSession(() => {
      expect(steerBubble()?.querySelector('.chat-steer-state')?.textContent).toBe('Waiting to be readWithdraw');
    });

    await click(withdrawButton(steerBubble())!);

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock.mock.calls[0][1]).toBe('turn-steer');
    await waitForUi(() => {
      expect(steerBubble()).toBeUndefined();
      expect(composer()?.value).toBe(STEER);
    });
  });

  it('stays when the engine had already read it, and says it was too late', async () => {
    cancelMock.mockRejectedValue(
      new ApiError('Claude has already read this message, so it can no longer be withdrawn.', 409, STEER_WITHDRAW_ERRORS.ALREADY_READ),
    );
    await mountSession(() => {
      expect(withdrawButton(steerBubble())).toBeDefined();
    });

    await click(withdrawButton(steerBubble())!);

    await waitForUi(() => {
      expect(document.body.textContent).toContain('Too late to withdraw');
      expect(document.body.textContent).toContain('Claude has already read it.');
      // The bubble is where it was, and the way out is back for whatever happens next.
      expect(steerBubble()?.querySelector('.chat-steer-state')?.textContent).toBe('Waiting to be readWithdraw');
    });
    expect(composer()?.value).toBe('');
  });

  it('is offered from the queue too, while no runner has it yet', async () => {
    events = RUNNING.slice(0, 2);
    queue = [{ turnId: 'turn-queued', kind: 'steer', placement: 'steer', content: 'and the docs too', createdAt: '2026-10-15T09:43:00Z' }];
    cancelMock.mockImplementation(async (_session: string, turnId: string) => {
      queue = queue.filter((turn) => turn.turnId !== turnId);
      return { ok: true };
    });
    await mountSession(() => {
      const row = mounted().querySelector('.chat-queued');
      expect(row?.querySelector('.chat-queued-tag')?.textContent).toBe('Sending…');
      expect([...(row?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual(['Withdraw']);
    });

    await click([...mounted().querySelectorAll('.chat-queued a')].find((a) => a.textContent === 'Withdraw')!);

    expect(cancelMock.mock.calls[0][1]).toBe('turn-queued');
    await waitForUi(() => {
      expect(mounted().querySelector('.chat-queued')).toBeNull();
      expect(composer()?.value).toBe('and the docs too');
    });
  });
});
