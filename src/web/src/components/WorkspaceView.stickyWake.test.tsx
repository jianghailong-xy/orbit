// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The bar pinned to the top of the transcript, on a turn nobody typed.
 *
 * It names the last turn that has scrolled above the fold so a reader halfway down an answer knows
 * what is being answered, and tapping it goes back to that turn. It scanned for `.chat-user`
 * bubbles — and a wake a watch queued is drawn as the watch's card, not as a bubble, so this end
 * walked straight past it and named the question *before* it: the bar credited the wake's answer to
 * an unrelated question and jumped somewhere else when tapped. (iOS had the other half of the same
 * bug and it was the louder one: it did pick the wake up, and labelled it "↑ Your question" with
 * the payload's raw UUID beside it, directly above a card reading "not typed by you".)
 *
 * So the wake is the turn the bar names, in the wake's own words: its card's title and the line
 * under it, which is the same sentence the card itself reads.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
const TASK = '0195c0de-0000-7000-8000-0000000000d4';

/** What the person actually typed, earlier in the same session. */
const TYPED = 'deploy the new build';
/** The condition as the server recorded it — the card reads it back as words. */
const REASON = 'ANY_OF(ALL TASK_TERMINAL 1/1, ANY TASK_FAILED 1/1)';
const IN_WORDS = '1 of 1 finished · 1 of 1 failed';

// The wake, built the way watch-delivery.service.ts `watchTurnContent` builds it (lib/watches.test.ts
// holds the two to the same words).
const WAKE = [
  `Orbit Watch ${WATCH} matched at generation 1: ${REASON}`,
  '',
  'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  '',
  '```json',
  JSON.stringify(
    {
      watchId: WATCH,
      generation: 1,
      matchedAt: '2026-09-17T06:00:00.000Z',
      reason: REASON,
      changedTargets: [{ kind: 'TASK', id: TASK, state: 'SATISFIED', observed: { status: 'FAILED' } }],
      latestSnapshot: { evaluatedAt: '2026-09-17T06:00:00.000Z', targets: [] },
    },
    null,
    2,
  ),
  '```',
].join('\n');

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
  createdAt: '2026-09-17T05:00:00Z',
  updatedAt: '2026-09-17T06:00:00Z',
};

/** The person's question, its answer, then the wake and the answer it drew. */
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: TYPED }, turnId: 'turn-typed', ts: '2026-09-17T05:00:00Z' },
  { seq: 2, type: 'assistant', payload: { text: 'deploying' }, turnId: 'turn-typed', ts: '2026-09-17T05:00:10Z' },
  { seq: 3, type: 'user', payload: { text: WAKE }, turnId: 'turn-wake', ts: '2026-09-17T06:00:00Z' },
  { seq: 4, type: 'assistant', payload: { text: 'that task failed; reading the logs' }, turnId: 'turn-wake', ts: '2026-09-17T06:00:20Z' },
];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
/** Every element `scrollIntoView` was called on, in order — what tapping the bar goes back to. */
let scrolledTo: Element[] = [];

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const text = (selector: string): string =>
  mounted().querySelector<HTMLElement>(selector)?.textContent?.trim() ?? '';

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  scrolledTo = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
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
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function scrollIntoView(this: Element) {
      scrolledTo.push(this);
    },
  });
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

/**
 * Mounts the session and waits for the bar to name something.
 *
 * jsdom lays nothing out, so every row reports the same empty rectangle and the scanner reads them
 * all as sitting above the fold — which is the state the bar exists for, with the LAST eligible
 * turn as the one it names. That is the wake here; before this fix the scanner could not see it and
 * named the question two turns earlier instead.
 */
async function mountTranscript(hasWake = true): Promise<void> {
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
    if (hasWake) expect(mounted().querySelector('.watch-wake'), 'the wake is drawn as its card').not.toBeNull();
    expect(mounted().querySelector('.chat-sticky-question'), 'the bar names a turn').not.toBeNull();
  });
}

describe('the sticky bar over a turn a watch queued', { timeout: 60_000 }, () => {
  it('names it in the watch’s own words, not as the person’s question', async () => {
    await mountTranscript();

    expect(text('.chat-sticky-label')).toBe('↑ Watch triggered');
    expect(text('.chat-sticky-text')).toBe(IN_WORDS);
    // The same sentence the card under it reads: one screen, one account of what happened.
    expect(text('.watch-wake-why')).toBe(IN_WORDS);
    // Not the payload the agent was handed, which is what the bar drew before: a head line with a
    // raw UUID in it, truncated to something no reader can place.
    const bar = text('.chat-sticky-question');
    expect(bar).not.toContain(WATCH);
    expect(bar).not.toContain('Orbit Watch');
    // And not the question two turns earlier, whose answer this is not.
    expect(bar).not.toContain(TYPED);
  });

  it('goes back to the wake’s own turn when tapped', async () => {
    await mountTranscript();

    const wake = mounted().querySelector<HTMLElement>('.watch-wake')!;
    expect(wake.getAttribute('data-seq'), 'the card is where that turn starts').toBe('3');
    await act(async () => {
      mounted()
        .querySelector<HTMLElement>('.chat-sticky-question')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(scrolledTo).toEqual([wake]);
  });

  it('still calls a turn the person typed their question', async () => {
    // The same session with the wake taken out: the bar names the last thing they typed, in the
    // words they typed it, exactly as it always has.
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS.slice(0, 2), hasMore: false } as never);
    await mountTranscript(false);

    expect(text('.chat-sticky-label')).toBe('↑ Your question');
    expect(text('.chat-sticky-text')).toBe(TYPED);
  });
});
