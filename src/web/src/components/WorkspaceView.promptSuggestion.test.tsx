// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The engine's guess at the next message, as the composer offers it (lib/promptSuggestion,
 * docs/prompt-suggestions-design.md §4): a grey line in the empty box, taken with Tab (a double-tap
 * on a touch screen, Use for a screen reader), which fills the box and sends nothing, and which goes
 * the moment anything newer is said.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const seedMock = vi.mocked(getSessionEventPage);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000021';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000022';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000023';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;

const SUGGESTION = 'run the tests';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const PARKED = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Flaky socket test',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  engineTurnActive: false,
  pendingApprovals: 0,
  provider: 'claude',
  createdAt: '2026-10-08T03:00:00Z',
  updatedAt: '2026-10-08T03:05:00Z',
};
let session: Record<string, unknown> = PARKED;
let stored: Record<string, string> = {};

const SEED = [
  { seq: 10, type: 'user', payload: { text: 'fix the flaky socket test' }, turnId: 'turn-1', ts: '2026-10-08T03:04:00Z' },
  { seq: 11, type: 'assistant', payload: { text: 'Fixed: the retry now waits for the socket to close.' }, turnId: 'turn-1', ts: '2026-10-08T03:04:50Z' },
  { seq: 12, type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId: 'turn-1', ts: '2026-10-08T03:04:51Z' },
  { seq: 13, type: 'prompt_suggestion', payload: { text: SUGGESTION, source: 'engine' }, turnId: 'turn-1', ts: '2026-10-08T03:04:52Z' },
];

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

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const box = (): HTMLTextAreaElement => mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
const offered = (): string | null =>
  mounted().querySelector('.composer-suggestion-text')?.textContent ?? null;

const waitForUi = async (assertion: () => void): Promise<void> => {
  // Off while waiting, as in WorkspaceView.streamOrder.test.tsx: renders queued inside an
  // in-flight act callback are not flushed until it settles.
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

const type = async (value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), value);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

// A finger lifting off the box at (x, y), `at` ms into the page's life — the event the composer
// counts double-taps on.
const lift = async (x: number, y: number, at: number): Promise<TouchEvent> => {
  const ev = new Event('touchend', { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(ev, 'changedTouches', { value: [{ identifier: 0, clientX: x, clientY: y }] });
  Object.defineProperty(ev, 'timeStamp', { value: at });
  await act(async () => {
    box().dispatchEvent(ev);
  });
  return ev;
};
const tapHint = (): string | null => mounted().querySelector('.composer-suggestion-tap')?.textContent ?? null;

const posted = (): unknown[] =>
  apiMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  session = PARKED;
  stored = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  seedMock.mockReset();
  seedMock.mockImplementation(async () => ({ events: SEED, hasMore: false }));
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith('/sessions/') && path.includes('/events/page')) return reply({ events: SEED, hasMore: false });
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(session);
    }
    if (path.startsWith('/sessions')) return reply([session]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
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
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mount(): Promise<void> {
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
        <MemoryRouter initialEntries={[SESSION_PATH]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function publish(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await waitForUi(() => {
    stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));
    expect(stream, 'the session opened no event stream').toBeTruthy();
  });
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

describe('the composer offers the engine’s suggested next message', () => {
  it('shows it where the placeholder would be, and Use (a screen reader’s) fills the box without sending', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    expect(box().placeholder, 'the suggestion takes the placeholder’s place').toBe('');
    expect(mounted().querySelector('.composer-suggestion-use')?.getAttribute('aria-label')).toBe(
      `Use suggestion: ${SUGGESTION}`,
    );

    await act(async () => {
      mounted().querySelector<HTMLButtonElement>('.composer-suggestion-use')!.click();
    });
    await waitForUi(() => expect(box().value).toBe(SUGGESTION));
    expect(offered(), 'a filled box offers nothing more').toBeNull();
    expect(posted(), 'Use only fills the box').toEqual([]);
  });

  // Which of the key and Use shows is index.css's call (hover / focus), which jsdom does not apply:
  // pinned here is the markup it chooses between, and what a screen reader is told instead.
  it('names Tab right after the words, outside Use, and describes the box to a screen reader', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    const key = mounted().querySelector('.composer-suggestion-key');
    expect(key?.textContent).toBe('Tab');
    expect(key?.previousElementSibling, 'the key follows the words').toBe(
      mounted().querySelector('.composer-suggestion-text'),
    );
    expect(mounted().querySelector('.composer-suggestion-use')?.textContent, 'Use carries no key').toBe('Use');

    const described = box().getAttribute('aria-describedby');
    expect(described, 'the box points at its description').toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe(
      `Suggested reply: ${SUGGESTION}. Press Tab to use it.`,
    );
    await type('no — check the docs first');
    await waitForUi(() => expect(box().getAttribute('aria-describedby')).toBeNull());
  });

  it('takes it on a double-tap on a touch screen, holding the idle box’s first tap', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    expect(tapHint(), 'the hint follows the words').toBe('Double-tap to use');
    expect(mounted().querySelector('.composer-suggestion-tap')?.getAttribute('aria-hidden')).toBe('true');

    const first = await lift(120, 30, 1_000);
    expect(first.defaultPrevented, 'held: a keyboard raised now would lift the box from under the second tap').toBe(true);
    expect(document.activeElement).not.toBe(box());
    expect(box().value, 'one tap fills nothing').toBe('');
    expect(offered()).toBe(SUGGESTION);

    const second = await lift(126, 33, 1_220);
    expect(second.defaultPrevented, 'the second is kept from the page: no zoom, no caret in the words').toBe(true);
    await waitForUi(() => expect(box().value).toBe(SUGGESTION));
    expect(offered()).toBeNull();
    expect(posted(), 'a double-tap only fills the box').toEqual([]);
    expect(stored['orbit.suggestionDoubleTapLearned'], 'learned on this device').toBe('1');

    await type('');
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    expect(tapHint(), 'and the hint is gone for good').toBeNull();
  });

  it('hands a lone tap on the idle box on as its focus once the double-tap window passes', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    expect((await lift(120, 30, 1_000)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(box());
    await waitForUi(() => expect(document.activeElement).toBe(box()));
    expect(box().value).toBe('');
    expect(offered(), 'a tap to type something else leaves the guess where it was').toBe(SUGGESTION);
  });

  it('leaves a focused box its taps, and counts two apart in time or place as two', async () => {
    stored['orbit.suggestionDoubleTapLearned'] = '1';
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    expect(tapHint(), 'learned before: the words alone').toBeNull();
    box().focus();

    expect((await lift(120, 30, 1_000)).defaultPrevented, 'a focused box keeps its first tap').toBe(false);
    expect((await lift(122, 31, 1_400)).defaultPrevented, 'too slow').toBe(false);
    expect((await lift(200, 31, 1_550)).defaultPrevented, 'too far').toBe(false);
    expect(box().value).toBe('');

    await type('no — check the docs first');
    await waitForUi(() => expect(offered()).toBeNull());
    await lift(120, 30, 3_000);
    expect((await lift(121, 30, 3_150)).defaultPrevented, 'with words in the box a double-tap is the box’s').toBe(false);
    expect(box().value).toBe('no — check the docs first');
  });

  it('takes it on Tab in the empty box', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    box().focus();
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    await waitForUi(() => expect(box().value).toBe(SUGGESTION));
    expect(posted()).toEqual([]);
  });

  it('steps aside while you type, and comes back when the box is empty again', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    await type('no — check the docs first');
    await waitForUi(() => expect(offered()).toBeNull());
    await type('');
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
  });

  it('goes once a newer message arrives — from this device or another', async () => {
    await mount();
    await waitForUi(() => expect(offered()).toBe(SUGGESTION));
    await publish([{ seq: 14, type: 'user', payload: { text: 'ship it' }, turnId: 'turn-2', ts: '2026-10-08T03:06:00Z' }]);
    await waitForUi(() => expect(offered()).toBeNull());
    expect(box().placeholder).not.toBe('');
  });

  it('offers nothing while a card waits on you', async () => {
    session = { ...PARKED, pendingApprovals: 1, waitingKind: 'OWNER_ITEM' };
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.composer-box textarea')).toBeTruthy());
    // Long enough for the seed to have landed: the transcript shows the turn's reply.
    await waitForUi(() => expect(mounted().textContent).toContain('the retry now waits for the socket'));
    expect(offered()).toBeNull();
  });
});
