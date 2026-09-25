// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The Retry button on a provider-outage card, for a session that is a RUN.
 *
 * The card offers to re-send the message the failure killed, and used to decide whether it had one
 * by looking through the events this page holds — its newest 200. That is the answer for a
 * conversation and the wrong one for a run: a task session is a single message followed by
 * thousands of tool events. The session this was reported on held 1,740 events with its only user
 * event at seq 1, so the window held no message, the card concluded there was nothing to re-send,
 * and it rendered with no button at all — on exactly the sessions a provider outage kills, where
 * the only thing left to do IS retry.
 *
 * So a card that finds nothing asks the server, which chooses with the same code the automatic
 * retry re-sends with. Both halves are held here: it asks when its window cannot answer, and it
 * does NOT ask when the window already did — that second one is what keeps this from becoming a
 * request on every long session anybody opens.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, getSessionRetryMessage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a3');

/** The failure exactly as this deployment reported it, screenshot and all. */
const RATE_LIMITED =
  "API Error: Request rejected (429) · This request would exceed your account's rate limit. " +
  'Please try again later.';
/** What the run was actually asked to do, thousands of events above the failure. */
const BURIED_MESSAGE = '请开始执行任务「平台自动集成进项目集成线」。';

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** Parked the way a provider error leaves a task's run: failed, with nothing armed. */
const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: '执行任务：平台自动集成进项目集成线',
  status: 'FAILED',
  provider: 'claude',
  numTurns: 277,
  retryAt: null,
  retryAttempts: 0,
  createdAt: '2026-09-17T18:32:15Z',
  updatedAt: '2026-09-17T23:44:18Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/** The tail this page paints: tool traffic, then the failure. No user message anywhere in it. */
const TAIL_WITHOUT_THE_MESSAGE = [
  { seq: 2_998, type: 'tool_use', payload: { id: 't1', name: 'Bash', input: { command: 'go test ./...' } } },
  { seq: 2_999, type: 'tool_result', payload: { toolUseId: 't1', content: 'ok' } },
  { seq: 3_000, type: 'assistant', payload: { text: '红跑重启了。等它和单测跑完。' } },
  { seq: 3_004, type: 'assistant', payload: { text: RATE_LIMITED } },
];

describe('the Retry button on a run that a provider outage killed', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const card = (): HTMLElement => {
    const found = mounted().querySelector<HTMLElement>('.chat-quota');
    if (!found) throw new Error(`no auto-retry card on screen:\n${mounted().innerHTML.slice(0, 2000)}`);
    return found;
  };
  const retryButton = (): HTMLElement | null =>
    card().querySelector<HTMLElement>('.chat-quota-retry');

  const mount = async (events: unknown[]): Promise<void> => {
    vi.mocked(getSessionEventPage).mockResolvedValue({ events, hasMore: true } as never);
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
      await vi.waitFor(() => expect(mounted().querySelector('.chat-quota')).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: BURIED_MESSAGE });
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
        if (path.includes('/events/page')) return reply({ events: TAIL_WITHOUT_THE_MESSAGE, hasMore: true });
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

  it('asks the server for the words its window never held, and offers them', async () => {
    await mount(TAIL_WITHOUT_THE_MESSAGE);

    expect(card().textContent).toContain('Provider unavailable');
    await act(async () => {
      await vi.waitFor(() => expect(retryButton()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });

    // Asked for THIS session, and the button says what it would re-send rather than promising
    // "your last message" with nothing behind it.
    expect(vi.mocked(getSessionRetryMessage).mock.calls.map(([id]) => id)).toContain(SESSION_PUBLIC);
    expect(retryButton()!.textContent).toBe('Retry now');
    expect(card().textContent).toContain(BURIED_MESSAGE);
  });

  it('asks nobody when the message is right there in the window', async () => {
    await mount([
      { seq: 3_001, type: 'user', payload: { text: 'try that again' } },
      { seq: 3_004, type: 'assistant', payload: { text: RATE_LIMITED } },
    ]);

    await act(async () => {
      await vi.waitFor(() => expect(retryButton()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });

    // (Not quoted back: the bubble is the line directly above, see `afterUserMsg`.)
    expect(retryButton()!.textContent).toBe('Retry now');
    expect(
      vi.mocked(getSessionRetryMessage).mock.calls.length,
      'the window answered — a second answer would be a request per session opened',
    ).toBe(0);
  });
});
