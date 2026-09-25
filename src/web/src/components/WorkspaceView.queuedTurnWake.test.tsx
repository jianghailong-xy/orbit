// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * A wake a watch queued waits in the queued tail like any follow-up (docs/watch-contract.md §6). Drawn
 * as a queued message it put the watch's head line, raw id and whole JSON payload under the user's
 * name and filled the pane (owner's report, 2026-09-14). It is the watch's card there too — the one the
 * transcript draws once a runner takes it — with the words the agent will read folded away. And
 * nobody typed it: withdrawing it is not Cancel, and neither that nor Stop hands its words to the
 * composer as if they were the user's.
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
const TASKS = ['0195c0de-0000-7000-8000-0000000000d4', '0195c0de-0000-7000-8000-0000000000d5'];

// The wake from the report, built the way watch-delivery.service.ts `watchTurnContent` builds it
// (lib/watches.test.ts holds the two to the same words).
const WAKE = [
  `Orbit Watch ${WATCH} matched at generation 1: ALL TASK_DONE 2/2`,
  '',
  'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  '',
  '```json',
  JSON.stringify(
    {
      watchId: WATCH,
      generation: 1,
      matchedAt: '2026-09-14T16:40:00.000Z',
      reason: 'ALL TASK_DONE 2/2',
      changedTargets: TASKS.map((id) => ({ kind: 'TASK', id, state: 'SATISFIED', observed: { status: 'DONE' } })),
      latestSnapshot: { evaluatedAt: '2026-09-14T16:40:00.000Z', targets: [] },
    },
    null,
    2,
  ),
  '```',
].join('\n');
const TYPED = 'and check the dark theme too';

const CONSEQUENCE = "If withdrawn, this session is not woken this time, and the watch won't send it again.";

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
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
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
    { turnId: 'turn-typed', kind: 'message', placement: 'queued', content: TYPED, createdAt: '2026-09-14T16:40:05.000Z' },
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

/** Mounts the session and waits for both queued turns to be drawn. */
async function mountQueue(): Promise<void> {
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
  await waitForUi(() => {
    expect(mounted().querySelector('.watch-wake')).not.toBeNull();
    expect(mounted().querySelector('.chat-queued')).not.toBeNull();
  });
}

describe('a wake a watch queued, in the queued tail', { timeout: 60_000 }, () => {
  it('is the watch’s card with the queue’s line, and its JSON stays folded', async () => {
    await mountQueue();

    const card = mounted().querySelector<HTMLElement>('.watch-wake')!;
    expect(card.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(card.querySelector('.watch-wake-title')?.textContent?.trim()).toBe('Watch triggered');
    expect(card.querySelectorAll('.watch-wake-changed li')).toHaveLength(2);
    expect(card.querySelector('.watch-wake-meta')?.textContent).toBe('Queued by a watch, not typed by you · generation 1');
    expect(card.hasAttribute('data-seq'), 'a queued wake is no event for ⌘F to land on').toBe(false);

    // What the agent will read is kept whole, one closed disclosure away.
    const raw = card.querySelector('details.watch-wake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('pre')?.textContent).toBe(WAKE);
    // Outside it, none of the head line, the raw id or the payload is on the page.
    const shown = card.cloneNode(true) as HTMLElement;
    shown.querySelector('details')!.remove();
    expect(shown.textContent).not.toContain('Orbit Watch');
    expect(shown.textContent).not.toContain(WATCH);
    expect(shown.textContent).not.toContain('latestSnapshot');
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((bubble) => bubble.textContent?.includes('Orbit Watch')),
      'no part of the wake is drawn as something the user typed',
    ).toBe(false);

    // The queue's own line: its state, the action named for what it does, and what that costs.
    const line = card.querySelector('.watch-wake-queued .chat-queued-meta')!;
    expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect(line.querySelector('.chat-queued-why')?.textContent).toBe(CONSEQUENCE);
    expect([...line.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Withdraw wake']);

    // The message typed behind it is drawn as it always was.
    const bubbles = mounted().querySelectorAll<HTMLElement>('.chat-queued');
    expect(bubbles).toHaveLength(1);
    const bubble = bubbles[0];
    expect(bubble.className).toBe('chat-msg chat-user chat-queued');
    expect(bubble.querySelector('.md')?.textContent?.trim()).toBe(TYPED);
    const meta = bubble.querySelector('.chat-queued-meta')!;
    expect(meta.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect(meta.querySelector('.chat-queued-why')).toBeNull();
    expect([...meta.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);
  });

  it('asks before withdrawing it, withdraws only it, and puts none of it in the composer', async () => {
    await mountQueue();

    const withdraw = [...mounted().querySelectorAll('.watch-wake-queued a')].find((a) => a.textContent === 'Withdraw wake')!;
    await click(withdraw);

    let dialog: HTMLElement | null = null;
    await waitForUi(() => {
      dialog = document.querySelector<HTMLElement>('.ant-modal-confirm');
      expect(dialog, 'withdrawing asks first').not.toBeNull();
    });
    expect(dialog!.querySelector('.ant-modal-confirm-title')?.textContent).toBe('Withdraw this wake?');
    expect(dialog!.textContent).toContain(CONSEQUENCE);
    expect(cancelMock, 'nothing is withdrawn until the owner confirms').not.toHaveBeenCalled();

    const confirm = [...dialog!.querySelectorAll('button')].find((b) => b.textContent === 'Withdraw wake')!;
    await click(confirm);

    await waitForUi(() => {
      expect(cancelMock).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-wake');
      expect(mounted().querySelector('.watch-wake')).toBeNull();
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    // The watch's words were never the user's to edit and send again.
    expect(composer()?.value).toBe('');
    expect(mounted().querySelector('.chat-queued')?.textContent).toContain(TYPED);
  });

  it('is left out when Stop folds the queue back into the composer', async () => {
    await mountQueue();

    let stop: Element | null = null;
    await waitForUi(() => {
      stop = mounted().querySelector('[aria-label="Stop"]');
      expect(stop, 'a running session offers Stop').not.toBeNull();
    });
    await click(stop!);

    await waitForUi(() => {
      expect(interruptMock).toHaveBeenCalledWith(SESSION_PUBLIC);
      // What was typed comes back to be edited and resent; the watch's words do not come with it.
      expect(composer()?.value).toBe(TYPED);
    });
  });
});
