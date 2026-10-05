// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The failure card's Retry, when the message it re-sends is another Orbit session's
 * (docs/session-request-reply-contract.md §2.1, §8 criterion 15).
 *
 * The card used to re-send whatever the transcript's last message was through this page's own send
 * — the owner's door. For another session's message that is the wrong voice: the words went out
 * again in the owner's name, signed by nobody, the request they were left behind on the turn that
 * failed. So when the words carry the sending session's card — on the bubble the page holds, or on
 * the server's answer when the page holds none — Retry asks the server to re-send them, and the
 * server sends them as that session's. The owner's own message still goes the way it always did.
 *
 * It names no key of its own any more, and it is not offered again while it is in flight (§2.1, §8
 * criterion 19): the key is the server's, derived from the failed message, and the button is drawn
 * disabled for as long as the request it made is unanswered — a double tap is one attempt.
 *
 * And once that request has been answered, whatever it came to, the button is offered again and asks
 * the same door (§8 criterion 22): a re-send that then failed before its echo is re-sent by the next
 * press, and a press whose response was lost is answered with the turn it already queued — both the
 * server's to tell apart, by the failure the session is stopped on.
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
    resendSessionRetryMessage: vi.fn(),
    // The owner's own send: the fresh read it takes first, and the two doors it can post to.
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

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000b1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');
const WORKER_SESSION = '0195c0de-0000-7000-8000-0000000000b4';

const RATE_LIMITED =
  "API Error: Request rejected (429) · This request would exceed your account's rate limit. " +
  'Please try again later.';
const SIGNED_OUT = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}';
const WORDS = 'criterion 3 is ready — merge now or wait for review?';
/** Who sent them: the card the control plane stored beside the echo. */
const FROM_WORKER = {
  fromSessionId: WORKER_SESSION,
  fromTitle: 'Worker: criterion 3',
  fromAgentName: 'orbit-worker',
  requestId: '7nZQb2kQGx3v9pWm1aLrT',
};

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** Failed and resumable: the shape the card offers Retry on, and the owner's send would revive. */
const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Coordinator: decides',
  status: 'FAILED',
  provider: 'claude',
  numTurns: 3,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-10-02T07:00:00Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-10-02T07:00:00Z',
  updatedAt: '2026-10-02T07:30:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/** Another session's message, echoed with its card, and then the failure the card is about. */
const theirs = (failure: string) => [
  { seq: 40, type: 'user', payload: { text: WORDS, sessionMessage: FROM_WORKER } },
  { seq: 41, type: 'assistant', payload: { text: failure } },
];
/** The same words, typed by the owner. */
const own = (failure: string) => [
  { seq: 40, type: 'user', payload: { text: WORDS } },
  { seq: 41, type: 'assistant', payload: { text: failure } },
];

describe('the failure card’s Retry, for another session’s message', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const button = (selector: string): HTMLElement | null => mounted().querySelector<HTMLElement>(selector);

  const mount = async (events: unknown[], cardSelector: string): Promise<void> => {
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
      await vi.waitFor(() => expect(mounted().querySelector(cardSelector)).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });
  };

  const press = async (selector: string): Promise<void> => {
    await act(async () => {
      await vi.waitFor(() => expect(button(selector)).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    await act(async () => {
      button(selector)!.click();
    });
  };

  /** What this page sent through the owner's own doors: a turn, or a revive. */
  const ownersSends = () => [...vi.mocked(sendTurn).mock.calls, ...vi.mocked(resumeSession).mock.calls];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' });
    vi.mocked(resendSessionRetryMessage).mockReset();
    vi.mocked(resendSessionRetryMessage).mockResolvedValue({ turnId: 'resent-turn', placement: 'accepted' });
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockResolvedValue(SESSION as never);
    vi.mocked(resumeSession).mockReset();
    vi.mocked(resumeSession).mockResolvedValue(
      { turnId: 'owner-turn', seq: 42, kind: 'message', placement: 'accepted', revived: true } as never,
    );
    vi.mocked(sendTurn).mockReset();
    vi.mocked(sendTurn).mockResolvedValue({ turnId: 'owner-turn', seq: 42, kind: 'message', placement: 'accepted' } as never);
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

  it('the provider-failure card asks the server to re-send it, not the owner’s send', async () => {
    await mount(theirs(RATE_LIMITED), '.chat-quota');
    await press('.chat-quota-retry');

    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));
    // Nothing picked in the composer, so the identity is empty and the re-send goes where the
    // session already is.
    expect(vi.mocked(resendSessionRetryMessage).mock.calls[0] as unknown[]).toEqual([SESSION_PUBLIC, {}]);
    expect(ownersSends(), 'the words went out again through the owner’s own send').toEqual([]);
  });

  it('the sign-in card does the same', async () => {
    await mount(theirs(SIGNED_OUT), '.chat-authfix');
    await press('.chat-authfix-retry');

    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resendSessionRetryMessage).mock.calls[0][0]).toBe(SESSION_PUBLIC);
    expect(ownersSends()).toEqual([]);
  });

  it('a window that holds no message learns whose words they are from the server’s answer', async () => {
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: WORDS, sessionMessage: FROM_WORKER });
    await mount([
      { seq: 2_998, type: 'tool_use', payload: { id: 't1', name: 'Bash', input: { command: 'go test ./...' } } },
      { seq: 2_999, type: 'tool_result', payload: { toolUseId: 't1', content: 'ok' } },
      { seq: 3_004, type: 'assistant', payload: { text: RATE_LIMITED } },
    ], '.chat-quota');
    await press('.chat-quota-retry');

    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));
    expect(ownersSends()).toEqual([]);
  });

  it('a re-send already in flight is not offered a second one', async () => {
    // Never settles: this is the state the criterion is about — the button's request is out and no
    // answer has come back, so a second press must not make a second one (§2.1, criterion 19).
    vi.mocked(resendSessionRetryMessage).mockImplementation(() => new Promise(() => {}));
    await mount(theirs(RATE_LIMITED), '.chat-quota');
    await press('.chat-quota-retry');
    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));

    const retry = button('.chat-quota-retry');
    expect(retry, 'the button left the card while its own re-send was in flight').not.toBeNull();
    await act(async () => {
      await vi.waitFor(() => expect(retry!.hasAttribute('disabled')).toBe(true), { timeout: 5_000, interval: 10 });
    });
    // …and it is not only the attribute: a press that reaches the handler anyway — a stale render,
    // a keyboard, this test taking the attribute off — is refused there too.
    retry!.removeAttribute('disabled');
    await act(async () => {
      retry!.click();
    });
    expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1);
    expect(ownersSends()).toEqual([]);
  });

  // §8 criterion 22: what a press over a failed message means is the server's to decide — the re-send it
  // already queued for this failure, a new one when that re-send itself failed (even before its echo),
  // nothing when it went through. The page's half is to ASK again once a press has been answered,
  // whatever it came to, and to name nothing a second press could spell differently.

  it('a re-send that failed before its echo is offered again, and the next press asks the server again', async () => {
    vi.mocked(resendSessionRetryMessage).mockResolvedValueOnce({ turnId: 'resent-turn', placement: 'accepted' });
    await mount(theirs(RATE_LIMITED), '.chat-quota');
    await press('.chat-quota-retry');
    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));

    // The runtime refused the re-send before writing it: no echo, the runner's receipt, the run FAILED
    // with the ladder armed again. Nothing new above the card says the outage is over, so it stays the
    // live one — and its Retry comes back once the press it made has been answered.
    vi.mocked(getSessionEventPage).mockResolvedValue({
      events: [
        ...theirs(RATE_LIMITED),
        { seq: 42, type: 'user_delivery', payload: { turnId: 'resent-turn', delivery: 'failed', reason: 'write |1: broken pipe' } },
      ],
      hasMore: true,
    } as never);
    await act(async () => {
      await vi.waitFor(() => expect(button('.chat-quota-retry')?.hasAttribute('disabled')).toBe(false), {
        timeout: 5_000, interval: 10,
      });
    });
    await press('.chat-quota-retry');
    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resendSessionRetryMessage).mock.calls as unknown[][]).toEqual([
      [SESSION_PUBLIC, {}],
      [SESSION_PUBLIC, {}],
    ]);
    expect(ownersSends(), 'the words went out again through the owner’s own send').toEqual([]);
  });

  it('a press whose answer was lost can be pressed again: the same door, naming nothing', async () => {
    // The re-send went out, and its response never came back — what the server keys on is the failure,
    // so asking again is safe, and it answers with the turn the first press queued.
    vi.mocked(resendSessionRetryMessage).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await mount(theirs(RATE_LIMITED), '.chat-quota');
    await press('.chat-quota-retry');
    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.waitFor(() => expect(button('.chat-quota-retry')?.hasAttribute('disabled')).toBe(false), {
        timeout: 5_000, interval: 10,
      });
    });
    await press('.chat-quota-retry');
    await vi.waitFor(() => expect(vi.mocked(resendSessionRetryMessage)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resendSessionRetryMessage).mock.calls as unknown[][]).toEqual([
      [SESSION_PUBLIC, {}],
      [SESSION_PUBLIC, {}],
    ]);
    expect(ownersSends()).toEqual([]);
  });

  it('the owner’s own message is still the owner’s to re-send', async () => {
    await mount(own(RATE_LIMITED), '.chat-quota');
    await press('.chat-quota-retry');

    await vi.waitFor(() => expect(ownersSends().length).toBeGreaterThan(0));
    expect(vi.mocked(resendSessionRetryMessage)).not.toHaveBeenCalled();
  });
});
