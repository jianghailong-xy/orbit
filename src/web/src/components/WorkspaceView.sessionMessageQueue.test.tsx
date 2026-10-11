// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageCard as Card } from '@orbit/shared';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * Another Orbit session's message waits in the queue like any follow-up until a runner takes it
 * (docs/session-request-reply-contract.md §2.3, §8 criterion 12). Until then the only reading of it
 * is the queue's, and drawn as a queued message it was the reader's own bubble — another agent's words
 * in their name, for as long as the turn waited. The queue snapshot carries the card its echo will
 * carry, so it is drawn "From [that session]" there too. And the reader did not type it: withdrawing
 * it, or a Stop that drops it, hands none of its words to the reader's composer.
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000051';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000052');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000053');
const SENT_TURN = 'turn-sent';
const TYPED_TURN = 'turn-typed';
const TS = '2026-10-02T03:30:26.000Z';

/** What the other session wrote. */
const SENT = 'please review the migration before I merge it';
const TYPED = 'and check the dark theme too';

/** Who sent it, as both reads take it (`readSessionMessageCard`). */
const CARD: Card = {
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  fromTitle: 'Worker: migration review',
  fromAgentName: 'orbit',
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
  title: 'Coordinator: migrations',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-02T03:00:00Z',
  updatedAt: '2026-10-02T03:30:00Z',
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

/** The other session's message as the active snapshot serves it: its words, and the card beside them. */
const sentRow = (placement: 'accepted' | 'queued'): ActiveSessionTurn => ({
  turnId: SENT_TURN,
  kind: 'message',
  placement,
  content: SENT,
  createdAt: TS,
  sessionMessage: CARD,
});

/** The server's queue, until something takes a turn off it. */
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

const card = (): Element | null => mounted().querySelector('.smc');

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
  FakeEventSource.open = [];
  queue = [
    sentRow('queued'),
    { turnId: TYPED_TURN, kind: 'message', placement: 'queued', content: TYPED, createdAt: '2026-10-02T03:30:30.000Z' },
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
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
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

/** Mounts the session and waits for the card to be drawn. */
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
  await waitForUi(() => {
    expect(card(), 'no card was drawn').not.toBeNull();
  });
}

/** Publish the frames the way the server does: one `message` per event, once the stream is open. */
async function publish(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await waitForUi(() => {
    stream = FakeEventSource.open.find(
      (es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`),
    );
    expect(stream, 'the session opened no event stream').toBeTruthy();
  });
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

const cancelIn = (row: Element | null | undefined): Element => {
  const link = [...(row?.querySelectorAll('.chat-queued-meta a') ?? [])].find((a) => a.textContent === 'Cancel');
  expect(link, 'the row offers Cancel').toBeDefined();
  return link!;
};

describe('another session’s message, waiting in the queue', { timeout: 60_000 }, () => {
  it('is the "From" card with the queue’s line, not the reader’s own bubble', async () => {
    await mountSession();

    const waiting = card()!;
    expect(waiting.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(waiting.querySelector('.smc-from')?.textContent).toBe('Worker: migration review');
    expect(waiting.querySelector('.smc-body .md')?.textContent).toBe(SENT);
    expect(waiting.querySelector('.smc-meta')?.textContent).toContain('Sent by another Orbit session, not by you');
    // The queue's own line: it is waiting, and Cancel withdraws it. No Put back — its words are not
    // the reader's to take back.
    const line = waiting.querySelector('.smc-queued .chat-queued-meta')!;
    expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...line.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((bubble) => bubble.textContent?.includes(SENT)),
      'the other session’s words are drawn as the reader’s message',
    ).toBe(false);

    // The negative control: the message the reader typed behind it is drawn as it always was.
    const bubbles = mounted().querySelectorAll<HTMLElement>('.chat-msg.chat-user.chat-queued');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].querySelector('.md')?.textContent?.trim()).toBe(TYPED);
  });

  it('is withdrawn without putting any of its words in the reader’s composer', async () => {
    await mountSession();

    await click(cancelIn(card()));
    await waitForUi(() => {
      expect(cancelMock).toHaveBeenCalledWith(SESSION_PUBLIC, SENT_TURN);
      expect(card(), 'the withdrawn message is still drawn').toBeNull();
    });
    expect(composer()?.value).toBe('');

    // The same Cancel on the message the reader typed still hands it back, so the empty composer above
    // is the rule and not a Cancel that restores nothing.
    await click(cancelIn(mounted().querySelector('.chat-queued')));
    await waitForUi(() => expect(composer()?.value).toBe(TYPED));
  });

  it('is left out when Stop folds the queue back into the composer', async () => {
    await mountSession();

    let stop: Element | null = null;
    await waitForUi(() => {
      stop = mounted().querySelector('[aria-label="Stop"]');
      expect(stop, 'a running session offers Stop').not.toBeNull();
    });
    await click(stop!);

    await waitForUi(() => {
      expect(interruptMock).toHaveBeenCalledWith(SESSION_PUBLIC);
      // What the reader typed comes back to be edited and resent; the other session's words do not.
      expect(composer()?.value).toBe(TYPED);
    });
  });

  it('is the card with no Cancel when it was written into the running turn as a steer', async () => {
    // `session_send` into a running turn is filed as a steer: on its way into that turn, not waiting,
    // and the server refuses to withdraw it — so the card offers no way to.
    queue = [{ ...sentRow('queued'), kind: 'steer', placement: 'steer' }];
    await mountSession();

    const line = card()!.querySelector('.smc-queued .chat-queued-meta');
    expect(line, 'the steer has no line of its own').not.toBeNull();
    expect([...line!.querySelectorAll('a')].map((a) => a.textContent)).toEqual([]);
    expect(mounted().querySelectorAll('.chat-user')).toHaveLength(0);
  });

  it('is already the card when the runner has it, and its echo replaces it with the same card', async () => {
    queue = [sentRow('accepted')];
    await mountSession();

    // The placeholder the client paints before the echo exists: nobody's event yet.
    expect(card()!.getAttribute('data-seq'), 'drawn from the queue snapshot, not from an echo').toBe('0.5');
    expect(card()!.classList.contains('is-queued'), 'the runner has it: it waits for nothing').toBe(false);
    expect(mounted().querySelectorAll('.chat-user'), 'drawn as the reader’s own bubble').toHaveLength(0);

    await publish([{
      seq: 1,
      type: 'user',
      turnId: SENT_TURN,
      ts: TS,
      payload: { text: SENT, sessionMessage: CARD },
    }]);

    await waitForUi(() => {
      expect(card()?.getAttribute('data-seq'), 'the echo is the event the card is now drawn from').toBe('1');
    });
    expect(mounted().querySelectorAll('.smc')).toHaveLength(1);
    expect(card()!.querySelector('.smc-from')?.textContent).toBe('Worker: migration review');
    expect(mounted().querySelectorAll('.chat-user')).toHaveLength(0);
  });
});
