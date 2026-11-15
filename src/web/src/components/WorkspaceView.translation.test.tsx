// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Settings › Translation in the session page (docs/mocks/session-translation/01-board.png, frames 3–6):
 * the composer's "<Language> → English" tag that opens the setting, a message held for its translation
 * drawn in the conversation with its chip or its failure — whose Retry and Send as written call the
 * A1 doors — and a reply swapped for its translation when the live `translation` event comes.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    retryTurnTranslation: vi.fn(),
    sendTurnAsWritten: vi.fn(),
    retryReplyTranslation: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns, retryTurnTranslation, sendTurnAsWritten } = await import('../api');
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
let preferences: Record<string, unknown> = {};
let translationAvailable = true;
let queue: unknown[] = [];
let locations: string[] = [];
let stored: Record<string, string> = {};

const SEED = [
  { seq: 10, type: 'user', payload: { text: 'fix the flaky socket test' }, turnId: 'turn-1', ts: '2026-10-08T03:04:00Z' },
  { seq: 11, type: 'assistant', payload: { text: 'Fixed: the retry now waits for the socket to close.' }, turnId: 'turn-1', ts: '2026-10-08T03:04:50Z' },
  { seq: 12, type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId: 'turn-1', ts: '2026-10-08T03:04:51Z' },
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

const HELD_TEXT = '再跑一遍全部测试';

/** Every place the router has been, written down on each render. */
function LocationProbe() {
  const at = useLocation();
  locations.push(`${at.pathname}${at.hash}`);
  return null;
}

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


beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  session = PARKED;
  preferences = { translationEnabled: true, translationLanguage: 'zh-Hans' };
  translationAvailable = true;
  queue = [];
  locations = [];
  vi.mocked(listQueuedTurns).mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue as never);
  vi.mocked(retryTurnTranslation).mockReset();
  vi.mocked(retryTurnTranslation).mockImplementation(async (_s, turnId) => ({
    turnId,
    translation: { state: 'TRANSLATING', from: 'zh-Hans', original: HELD_TEXT },
  }));
  vi.mocked(sendTurnAsWritten).mockReset();
  vi.mocked(sendTurnAsWritten).mockImplementation(async (_s, turnId) => ({
    turnId,
    translation: { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: HELD_TEXT },
  }));
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
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences, translationAvailable });
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
          <WorkspaceView runner={RUNNER} />
          <LocationProbe />
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


const tag = (): HTMLButtonElement | null => mounted().querySelector<HTMLButtonElement>('.composer-translation-tag');

describe('the composer tag (6A)', () => {
  it('reads "Chinese → English" with translation on, and opens Settings › Translation', async () => {
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English'));
    await act(async () => tag()!.click());
    expect(locations).toContain('/settings/general');
  });

  it('names the language the account picked', async () => {
    preferences = { translationEnabled: true, translationLanguage: 'ja' };
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('Japanese → English'));
  });

  it('is not there with translation off, or on a server that cannot translate', async () => {
    preferences = {};
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    expect(tag()).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    preferences = { translationEnabled: true };
    translationAvailable = false;
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    expect(tag()).toBeNull();
  });
});

describe('a message held for its translation', () => {
  const held = (state: 'TRANSLATING' | 'FAILED') => ({
    turnId: 'turn-held',
    kind: 'message',
    placement: 'queued',
    content: HELD_TEXT,
    createdAt: '2026-10-08T03:06:00Z',
    attachments: [],
    translation: { state, from: 'zh-Hans', original: HELD_TEXT },
  });

  it('is drawn in the conversation with the "Translating…" chip, not in the tray', async () => {
    queue = [held('TRANSLATING')];
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-chip')?.textContent).toBe('Translating…'));
    const bubble = mounted().querySelector('.chat-user.chat-queued')!;
    expect(bubble.textContent).toContain(HELD_TEXT);
    expect(bubble.textContent).not.toContain('Queued for next turn');
    expect(mounted().querySelector('.pending-tray')).toBeNull();
  });

  it("failed: Retry and Send as written call the A1 doors for that turn", async () => {
    queue = [held('FAILED')];
    await mount();
    await waitForUi(() =>
      expect(mounted().querySelector('.chat-translate-foot.is-error')?.textContent).toBe(
        "Couldn't translate, so it wasn't sent·Retry·Send as written",
      ),
    );
    const action = (label: string) =>
      [...mounted().querySelectorAll<HTMLButtonElement>('.chat-translate-foot button')].find((b) => b.textContent === label)!;
    await act(async () => action('Retry').click());
    await waitForUi(() => expect(vi.mocked(retryTurnTranslation)).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-held'));
    // The answer is written into the row at once: the failure gives way to the chip.
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-chip')?.textContent).toBe('Translating…'));

    queue = [held('FAILED')];
    await act(async () => root!.unmount());
    root = null;
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-foot.is-error')).toBeTruthy());
    await act(async () =>
      [...mounted().querySelectorAll<HTMLButtonElement>('.chat-translate-foot button')].find((b) => b.textContent === 'Send as written')!.click(),
    );
    await waitForUi(() => expect(vi.mocked(sendTurnAsWritten)).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-held'));
  });
});

describe('a live translation event', () => {
  it('swaps the reply for its translation, with its foot', async () => {
    await mount();
    await waitForUi(() => expect(mounted().textContent).toContain('Fixed: the retry now waits for the socket to close.'));
    await publish([{ seq: 0, type: 'translation', payload: { of: 11, lang: 'zh-Hans', text: '修好了：重试现在会等 socket 关闭。' } }]);
    await waitForUi(() => expect(mounted().textContent).toContain('修好了：重试现在会等 socket 关闭。'));
    expect(mounted().querySelector('.chat-translate-foot.is-reply')?.textContent).toBe('Translated·Show original');
  });
});
