// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The sign-in card, when the run it reports was refused for one of the runner's accounts.
 *
 * On 2026-10-31 a session sat on Account 3 after that account's login lapsed. The runner took the
 * next message and ended the run at its own sign-in check, before any engine started, so the
 * message was never echoed. The card that came up had two problems:
 *
 *   - Its Retry quoted the answered Watch notice above the failure, which is what the window's last
 *     bubble was. The message that failed was one the window never saw, and only the server can say
 *     which (`getSessionRetryMessage`).
 *   - Its sign-in signed in the runner's own login (Default), which was signed in already. The
 *     session stayed on Account 3.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    resendSessionRetryMessage: vi.fn(),
    getSession: vi.fn(),
    resumeSession: vi.fn(),
    sendTurn: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const {
  api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, resendSessionRetryMessage,
  resumeSession, sendTurn,
} = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c3');
const ACCOUNT_3 = '44bf2acd';

/** The runner's own words when its sign-in check refuses a run (runner-go engineSignedOutMessage). */
const REFUSED =
  'Failed to authenticate: Claude Code is installed on this runner but not signed in — sign in from here, or run `claude auth login` on that machine.';
const WATCH_NOTICE = 'Orbit Watch 01a17e1a EXPIRED at 2026-10-30T16:03:19.458Z without its condition ever holding.';
const LOST = 'Can it be shown as a message card? If there is a better idea, draw it first.';

/** Default signed in, Account 3 signed out — the runner's report after Account 3's login lapsed. */
const RUNNER = {
  id: RUNNER_ID,
  name: 'workstation-gpu',
  displayName: 'HPC',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{
    engine: 'claude',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.claude', auth: 'yes' },
      { id: ACCOUNT_3, name: 'Account 3', home: `/root/.orbit/claude-accounts/${ACCOUNT_3}`, auth: 'no' },
    ],
  }],
} as unknown as Runner;

const sessionOn = (claudeAccount: string) => ({
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Landings in one window',
  status: 'FAILED',
  provider: 'claude',
  engine: 'claude',
  claudeAccount,
  claudeAccountPinned: false,
  numTurns: 3,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-10-27T14:54:11Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-10-27T14:52:36Z',
  updatedAt: '2026-10-31T06:54:20Z',
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/** The answered Watch notice, then the refusal of a message that never reached the window. */
const AFTER_ANSWERED = [
  { seq: 5842, type: 'user', payload: { text: WATCH_NOTICE } },
  { seq: 5871, type: 'assistant', payload: { text: 'No action needed.' } },
  { seq: 5872, type: 'turn_end', payload: { subtype: 'success', numTurns: 1 } },
  { seq: 5873, type: 'error', payload: { message: REFUSED } },
];

describe('the sign-in card, for a run one of the runner’s accounts refused', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let session = sessionOn(ACCOUNT_3);

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

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
            <WorkspaceView runner={RUNNER} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.chat-authfix')).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });
  };

  const waitFor = async (check: () => void): Promise<void> => {
    await act(async () => {
      await vi.waitFor(check, { timeout: 20_000, interval: 20 });
    });
  };

  const press = async (find: () => HTMLElement | null | undefined): Promise<void> => {
    await waitFor(() => expect(find()).toBeTruthy());
    await act(async () => {
      find()!.click();
    });
  };

  const signInButton = () =>
    [...mounted().querySelectorAll<HTMLElement>('.chat-authfix .rsi-btn')].find((b) => b.textContent === 'Sign in to Claude Code');
  const title = () => mounted().querySelector('.chat-authfix-title')?.textContent;
  /** The bodies this page posted to start a sign-in on the runner. */
  const signInsStarted = () =>
    apiMock.mock.calls
      .filter(([path, init]) => path === `/runners/${RUNNER_ID}/login` && (init as { method?: string } | undefined)?.method === 'POST')
      .map(([, init]) => (init as { body?: unknown }).body);
  /** What this page sent through the owner's own doors: a turn, or a revive. */
  const ownersSends = () => [...vi.mocked(sendTurn).mock.calls, ...vi.mocked(resumeSession).mock.calls];

  beforeEach(() => {
    session = sessionOn(ACCOUNT_3);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('open', () => null);
    apiMock.mockReset();
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: LOST });
    vi.mocked(resendSessionRetryMessage).mockReset();
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => session as never);
    vi.mocked(resumeSession).mockReset();
    vi.mocked(resumeSession).mockResolvedValue(
      { turnId: 'owner-turn', seq: 5874, kind: 'message', placement: 'accepted', revived: true } as never,
    );
    vi.mocked(sendTurn).mockReset();
    vi.mocked(sendTurn).mockResolvedValue({ turnId: 'owner-turn', seq: 5874, kind: 'message', placement: 'accepted' } as never);
    apiMock.mockImplementation((path: string, init?: unknown) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit-develop', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (path === `/runners/${RUNNER_ID}/login`) {
        return reply((init as { method?: string } | undefined)?.method === 'POST' ? { status: 'starting' } : { status: 'idle' });
      }
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
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

  it('quotes and re-sends the message the run ended under, not the answered notice above it', async () => {
    await mount(AFTER_ANSWERED);
    await waitFor(() => expect(vi.mocked(getSessionRetryMessage)).toHaveBeenCalled());
    await waitFor(() => expect(mounted().querySelector('.chat-authfix-last')?.textContent).toBe(LOST));

    await press(() => mounted().querySelector<HTMLElement>('.chat-authfix-retry'));
    await waitFor(() => expect(ownersSends().length).toBeGreaterThan(0));
    const sent = JSON.stringify(ownersSends());
    expect(sent).toContain(LOST);
    expect(sent, 'the answered Watch notice went out again').not.toContain('Orbit Watch');
  });

  it('names the signed-out account the session is on, and signs that one in', async () => {
    await mount(AFTER_ANSWERED);
    expect(title()).toBe('Sign-in expired for Account 3 on “HPC”');

    await press(signInButton);
    await waitFor(() => expect(signInsStarted()).toEqual([{ engine: 'claude', account: ACCOUNT_3 }]));
  });

  it('is as before once the session is on a signed-in account: the runner’s own login', async () => {
    session = sessionOn('default');
    await mount(AFTER_ANSWERED);
    expect(title()).toBe('Sign-in expired on “HPC”');

    await press(signInButton);
    await waitFor(() => expect(signInsStarted()).toEqual([{ engine: 'claude' }]));
  });
});
