// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemDeliveryCard as Delivery } from '@orbit/shared';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * An exception item's delivery reaches the tab twice: first as a QUEUED TURN the client reads from
 * the active snapshot, then seconds later as the runner's echo of it — the only thing that carries
 * `openItemDelivery` (runner-api.controller.ts). When only the echo carried the card, the delivery
 * appeared as a message somebody typed and then redrew itself as a card in the same place: the
 * flicker the owner reported on 2026-09-21.
 *
 * What holds it shut is that both readings are the same reading. The queue projection now carries
 * the card too, read by the same function on the same rows, so:
 *
 *   - the placeholder painted while the turn waits is drawn as THE CARD, not as its prose (that is
 *     what `data-seq` and the field-by-field comparison below are about, before and after the swap);
 *   - a delivery still waiting behind a running turn is drawn as the card in the queue as well,
 *     because the flicker simply moves to the moment it reaches the head otherwise;
 *   - and a turn that is NOT a delivery is untouched: it is read off the payload, never off the
 *     text's shape, so an ordinary queued message stays the bubble it has always been.
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

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { acceptedUserTurnEvent } = await import('../lib/acceptedUserTurn');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');
const ITEM_TURN = 'turn-item';
const TYPED_TURN = 'turn-typed';
const TS = '2026-09-21T12:26:47.307Z';

/** The paragraph a delivery really carries (project-open-item.ts `openItemMessage`), Chinese because
 *  the agent reads it, with the item's id and the doors in it. */
const TOLD = [
  '【例外待办】Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  '',
  '项目 34ODoUKJGEsfbgcJDGS4q 的一次集成没有把工作放进集成线：',
  '合并冲突（LAND_TASK），目标分支 refs/heads/project/34ODoUKJGEsfbgcJDGS4q 没有动。',
].join('\n');

/** The same item as fields, as both reads take it (`readOpenItemDeliveryCard`). */
const CARD: Delivery = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  task: {
    id: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e',
    title: '回填历史 user 事件的 controlPlaneNote',
    sessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f',
  },
  files: ['src/web/src/components/Transcript.tsx', 'src/apiserver/src/projects/project-open-item.ts'],
  targetRef: 'refs/heads/project/34ODoUKJGEsfbgcJDGS4q',
  check: null,
  errorCode: null,
  failure: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'main' },
};

const TYPED = 'and check the dark theme too';

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
  title: 'Coordinator: exception items',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-21T12:00:00Z',
  updatedAt: '2026-09-21T12:26:00Z',
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

/** The delivery as the active snapshot serves it: the paragraph, and the card beside it. */
const itemRow = (placement: 'accepted' | 'queued', createdAt: string): ActiveSessionTurn => ({
  turnId: ITEM_TURN,
  kind: 'message',
  placement,
  content: TOLD,
  createdAt,
  openItemDelivery: CARD,
});

let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 10_000, interval: 20 });
  });
};

/**
 * The card's own field values, read off what is on the page. Two renderings are the same card
 * exactly when these are equal — which is what makes the replacement invisible rather than merely
 * present. `data-seq` is deliberately not among them: a queued turn has no event yet and the
 * placeholder's synthetic seq is not the echo's, and neither is a field of the item.
 */
const cardFields = (el: Element) => ({
  kind: el.querySelector('.oic-kind')?.textContent,
  title: el.querySelector('.oic-title')?.textContent,
  task: el.querySelector('.oic-where')?.textContent,
  headline: el.querySelector('.oic-why')?.textContent,
  files: [...el.querySelectorAll('.oic-files li')].map((li) => li.textContent),
  landing: el.querySelector('.oic-facts')?.textContent,
  doors: [...el.querySelectorAll('.oic-chip')].map((chip) => chip.textContent),
  links: [...el.querySelectorAll('.oic-links a')].map((a) => a.textContent),
  meta: el.querySelector('.oic-meta')?.textContent,
});

const card = (): Element | null => mounted().querySelector('.oic');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.open = [];
  queue = [];
  apiMock.mockReset();
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
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Publish the frames the way the server does: one `message` per event. The stream opens behind
 *  WorkspaceView's session-switch debounce, a real timer `act` does not run, so whether an
 *  EventSource exists yet is a question about how long the mount took, not about the page —
 *  waiting for it is the same assertion, held until the machine can answer it. */
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

describe('an exception item’s delivery, on its way into the transcript', () => {
  it('is drawn as the card from the snapshot, and the runner’s echo replaces it invisibly', async () => {
    queue = [itemRow('accepted', TS)];
    await mountSession();

    await waitForUi(() => {
      expect(card(), 'no card was drawn').not.toBeNull();
    });
    // The placeholder the client paints before the echo exists. Fractional seq: it is nobody's
    // event yet — which is exactly the window the delivery used to appear as prose in.
    expect(card()!.getAttribute('data-seq'), 'drawn from the queue snapshot, not from an echo').toBe('0.5');
    expect(
      mounted().querySelectorAll('.chat-user'),
      'the paragraph is folded behind the card, never drawn as a message',
    ).toHaveLength(0);
    const placeholder = cardFields(card()!);
    expect(placeholder.title).toBe(CARD.title);
    expect(placeholder.files).toEqual(CARD.files);
    expect(placeholder.doors).toEqual([
      'Retry the task', 'Cancel the task',
    ]);

    // …and then the runner leases the turn and echoes it, carrying the same card the ingest path
    // recorded (withOpenItemDelivery). Nothing about the delivery may change shape at that moment.
    await publish([{
      seq: 1,
      type: 'user',
      turnId: ITEM_TURN,
      ts: TS,
      payload: { text: TOLD, openItemDelivery: CARD },
    }]);

    await waitForUi(() => {
      expect(card(), 'the echo drew no card').not.toBeNull();
      expect(card()!.getAttribute('data-seq'), 'the echo is the event the card is now drawn from').toBe('1');
    });
    expect(cardFields(card()!), 'the delivery redrew itself as the echo landed').toEqual(placeholder);
    expect(mounted().querySelectorAll('.oic')).toHaveLength(1);
    expect(mounted().querySelectorAll('.chat-user')).toHaveLength(0);
  });

  it('is already the card in the queued tail, with the queue’s line at its foot', async () => {
    queue = [
      { turnId: 'turn-running', kind: 'message', placement: 'accepted', content: 'working now', createdAt: TS },
      itemRow('queued', TS),
      { turnId: TYPED_TURN, kind: 'message', placement: 'queued', content: TYPED, createdAt: TS },
    ];
    await mountSession();

    await waitForUi(() => {
      expect(card(), 'no card was drawn').not.toBeNull();
    });
    const queued = card()!;
    expect(queued.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(queued.hasAttribute('data-seq'), 'a queued delivery is no event for ⌘F to land on').toBe(false);
    const waiting = cardFields(queued);
    expect(waiting.title).toBe(CARD.title);
    // The queue's own line: it is waiting, and withdrawing it is still the way out.
    const line = queued.querySelector('.oic-queued')!;
    expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...line.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    // The negative control: a turn that is not a delivery is drawn exactly as it always was, from
    // its own words — the card is read off the payload, never off what the text looks like.
    const bubbles = mounted().querySelectorAll<HTMLElement>('.chat-msg.chat-user.chat-queued');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].querySelector('.md')?.textContent?.trim()).toBe(TYPED);
    expect(bubbles[0].querySelector('.oic')).toBeNull();
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((bubble) =>
        bubble.textContent?.includes('【例外待办】')),
      'the delivery’s paragraph is drawn as nobody’s message',
    ).toBe(false);
    expect(mounted().querySelectorAll('.oic')).toHaveLength(1);

    // Taking the turn off the queue changes nothing about it but the queue's own line: the card the
    // echo is drawn from is the card that was waiting here.
    await publish([{
      seq: 1,
      type: 'user',
      turnId: ITEM_TURN,
      ts: TS,
      payload: { text: TOLD, openItemDelivery: CARD },
    }]);

    await waitForUi(() => {
      expect(card()!.getAttribute('data-seq'), 'the echo is the event the card is now drawn from').toBe('1');
    });
    expect(card()!.classList.contains('is-queued')).toBe(false);
    expect(cardFields(card()!), 'the delivery redrew itself as it left the queue').toEqual(waiting);
    expect(mounted().querySelectorAll('.oic')).toHaveLength(1);
    expect(
      mounted().querySelectorAll('.chat-msg.chat-user.chat-queued'),
      'the message typed behind it is still waiting its turn',
    ).toHaveLength(1);
  });

  it('carries the card whichever read recovered the row', () => {
    // The two sources a placeholder can come from. Only the snapshot has ever read a delivery, but
    // the render must not depend on which one built the row: both go out as one payload.
    const base = {
      key: ITEM_TURN,
      sessionId: 'session-1',
      turnId: ITEM_TURN,
      text: TOLD,
      acceptedAt: TS,
      attachments: [],
    };
    for (const source of ['activeSnapshot', 'local'] as const) {
      const event = acceptedUserTurnEvent({ ...base, source, openItemDelivery: CARD }, 0.5);
      expect(event.payload).toEqual({ text: TOLD, openItemDelivery: CARD });
    }
    // And an ordinary accepted turn carries no key at all, as the control plane stores none.
    const typed = acceptedUserTurnEvent({ ...base, source: 'local' }, 0.5);
    expect(typed.payload).toEqual({ text: TOLD });
  });
});
