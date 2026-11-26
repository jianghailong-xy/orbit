// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Settings › Translation in the session page (docs/mocks/session-translation/01-board.png, frames 3–6):
 * the composer's "<Language> → <Agent language>" tag that opens the setting, a message held for its translation
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
    sendTurn: vi.fn(),
    retryTurnTranslation: vi.fn(),
    sendTurnAsWritten: vi.fn(),
    retryReplyTranslation: vi.fn(),
    cancelQueuedTurn: vi.fn(async () => undefined),
    fetchAttachmentFile: vi.fn(async () => new File(['png'], 'attachment', { type: 'image/png' })),
    uploadAttachment: vi.fn(async () => ({ id: 'att-new' })),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns, sendTurn, retryTurnTranslation, sendTurnAsWritten, cancelQueuedTurn, fetchAttachmentFile } = await import('../api');
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
let translationUnavailableUntil: string | null = null;
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
  translationUnavailableUntil = null;
  queue = [];
  locations = [];
  vi.mocked(listQueuedTurns).mockReset();
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue as never);
  vi.mocked(sendTurn).mockReset();
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
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences, translationAvailable, translationUnavailableUntil });
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

  it('names the agent language the account picked, both without their parenthesis', async () => {
    preferences = { translationEnabled: true, translationLanguage: 'en', translationAgentLanguage: 'zh-Hant' };
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('English → Chinese'));
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

describe('the composer tag while translation is unavailable (policy board frame 6)', () => {
  it('reads "Chinese → English · unavailable, messages will wait" in the warning style until the instant passes', async () => {
    translationUnavailableUntil = new Date(Date.now() + 2_000).toISOString();
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English · unavailable, messages will wait'));
    expect(tag()!.classList.contains('is-unavailable')).toBe(true);
    // Nothing is announced when the 60 s simply run out: the tag goes back by itself, with no refetch.
    const reads = apiMock.mock.calls.filter(([path]) => path === '/users/me').length;
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English'));
    expect(tag()!.classList.contains('is-unavailable')).toBe(false);
    expect(apiMock.mock.calls.filter(([path]) => path === '/users/me').length).toBe(reads);
  });

  it('reads the ordinary tag once the instant has passed, or with none', async () => {
    translationUnavailableUntil = new Date(Date.now() - 1_000).toISOString();
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English'));
    expect(tag()!.classList.contains('is-unavailable')).toBe(false);
  });

  it('follows /users/me when it is read again (translation.status_changed)', async () => {
    await mount();
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English'));
    translationUnavailableUntil = new Date(Date.now() + 60_000).toISOString();
    await act(async () => client!.invalidateQueries({ queryKey: ['user', 'me'], exact: true }));
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English · unavailable, messages will wait'));
    translationUnavailableUntil = null;
    await act(async () => client!.invalidateQueries({ queryKey: ['user', 'me'], exact: true }));
    await waitForUi(() => expect(tag()?.textContent).toBe('Chinese → English'));
  });
});

describe('the tray, for a translated message', () => {
  it('says what the reader wrote, not the English delivered', async () => {
    session = { ...PARKED, status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', engineTurnActive: true };
    const steer = {
      seq: 13, type: 'user', turnId: 'turn-steer', ts: '2026-10-08T03:05:10Z',
      payload: {
        text: 'lfs belongs to another repository', steer: true, delivery: 'written', withdrawable: true,
        translation: { state: 'DONE', from: 'zh-Hans', original: 'lfs 属于另一个仓库' },
      },
    };
    seedMock.mockImplementation(async () => ({ events: [...SEED, steer], hasMore: false }));
    queue = [{
      turnId: 'turn-next', kind: 'message', placement: 'queued', content: 'and update the changelog',
      createdAt: '2026-10-08T03:06:00Z', attachments: [],
      translation: { state: 'DONE', from: 'zh-Hans', original: '顺便更新变更日志' },
    }];
    await mount();
    const rows = () => [...mounted().querySelectorAll('.pending-tray-text')].map((n) => n.textContent);
    await waitForUi(() => expect(rows()).toEqual(['lfs 属于另一个仓库', '顺便更新变更日志']));
  });
});

describe('a message held for its translation', () => {
  const held = (state: 'TRANSLATING' | 'FAILED', why: { failureReason?: string; httpStatus?: number } = {}, turnId = 'turn-held') => ({
    turnId,
    kind: 'message',
    placement: 'queued',
    content: HELD_TEXT,
    createdAt: '2026-10-08T03:06:00Z',
    attachments: [],
    translation: { state, from: 'zh-Hans', original: HELD_TEXT, ...why },
  });

  // docs/ux/translation-failure-policy.html, frame 7, B column; the generic line without a reason.
  const REASONS: Array<[{ failureReason?: string; httpStatus?: number }, string]> = [
    [{ failureReason: 'TIMEOUT' }, "The translator didn't answer in time, so it wasn't sent"],
    [{ failureReason: 'NETWORK' }, "The translator was unreachable, so it wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 429 }, "The translator was unreachable, so it wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 503 }, "The translator was unreachable, so it wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 401 }, "The translator refused the message, so it wasn't sent"],
    [{ failureReason: 'TRUNCATED' }, "Too long to translate, so it wasn't sent"],
    [{ failureReason: 'MANGLED' }, "The translation came back damaged, so it wasn't sent"],
    [{ failureReason: 'EMPTY' }, "The translation came back damaged, so it wasn't sent"],
    [{ failureReason: 'UNAVAILABLE' }, "Translation is unavailable right now, so it wasn't sent"],
    [{}, "Couldn't translate, so it wasn't sent"],
    [{ failureReason: 'NO_KEY' }, "Couldn't translate, so it wasn't sent"],
  ];

  it('failed with a reason: the reason-specific sentence, then Retry and Send as written; the generic one without', async () => {
    queue = REASONS.map(([why], i) => held('FAILED', why, `turn-held-${i}`));
    await mount();
    const feet = () => [...mounted().querySelectorAll('.chat-translate-foot.is-error')].map((n) => n.textContent);
    await waitForUi(() => expect(feet()).toHaveLength(REASONS.length));
    expect(feet()).toEqual(REASONS.map(([, sentence]) => `${sentence}·Retry·Send as written·Cancel`));
    // Each line's row grows below the bubble when it wraps (indexCss.failureFoot.test.ts).
    for (const foot of mounted().querySelectorAll('.chat-translate-foot.is-error')) {
      expect(foot.parentElement?.classList.contains('has-failure-foot')).toBe(true);
    }
  });

  it('failed TIMEOUT: Retry and Send as written still call the A1 doors for that turn', async () => {
    queue = [held('FAILED', { failureReason: 'TIMEOUT' })];
    await mount();
    await waitForUi(() =>
      expect(mounted().querySelector('.chat-translate-foot.is-error')?.textContent).toBe(
        "The translator didn't answer in time, so it wasn't sent·Retry·Send as written·Cancel",
      ),
    );
    const action = (label: string) =>
      [...mounted().querySelectorAll<HTMLButtonElement>('.chat-translate-foot button')].find((b) => b.textContent === label)!;
    await act(async () => action('Retry').click());
    await waitForUi(() => expect(vi.mocked(retryTurnTranslation)).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-held'));
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-chip')?.textContent).toBe('Translating…'));
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

  it.each([false, true])('clears the chip when the held message becomes the accepted head (opening: %s)', async (opening) => {
    const row = { ...held('TRANSLATING'), opening };
    if (opening) seedMock.mockResolvedValue({ events: [], hasMore: false });
    queue = [row];
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-chip')?.textContent).toBe('Translating…'));

    queue = [{ ...row, placement: 'accepted', content: 'Run all the tests again', translation: { ...row.translation, state: 'DONE' } }];
    await publish([{ seq: 0, type: 'queued_turns_changed' }]);

    await waitForUi(() => {
      expect(mounted().querySelector('.chat-translate-chip')).toBeNull();
      expect([...mounted().querySelectorAll('.chat-user:not(.chat-queued)')].at(-1)?.textContent).toContain(HELD_TEXT);
    });
  });

  it('keeps a translated follow-up in the tray when the older send response arrives', async () => {
    session = { ...PARKED, status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', engineTurnActive: true };
    const response = Promise.withResolvers<Awaited<ReturnType<typeof sendTurn>>>();
    vi.mocked(sendTurn).mockReturnValueOnce(response.promise);
    const row = held('TRANSLATING');
    await mount();
    await waitForUi(() => expect(box()).toBeTruthy());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), HELD_TEXT);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    });
    await waitForUi(() => expect(sendTurn).toHaveBeenCalledOnce());

    queue = [row];
    await publish([{ seq: 0, type: 'queued_turns_changed' }]);
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-chip')?.textContent).toBe('Translating…'));

    queue = [{ ...row, content: 'Run all the tests again', translation: { ...row.translation, state: 'DONE' } }];
    await publish([{ seq: 0, type: 'queued_turns_changed' }]);
    const trayText = () => mounted().querySelector('.pending-tray-text')?.textContent;
    await waitForUi(() => expect(trayText()).toBe(HELD_TEXT));

    await act(async () => response.resolve({
      turnId: row.turnId, seq: 2, kind: 'message', placement: 'queued',
      translation: { state: 'TRANSLATING', from: 'zh-Hans', original: HELD_TEXT },
    }));
    expect(mounted().querySelector('.chat-translate-chip')).toBeNull();
    expect(trayText()).toBe(HELD_TEXT);
  });

  it("failed: Retry and Send as written call the A1 doors for that turn", async () => {
    queue = [held('FAILED')];
    await mount();
    await waitForUi(() =>
      expect(mounted().querySelector('.chat-translate-foot.is-error')?.textContent).toBe(
        "Couldn't translate, so it wasn't sent·Retry·Send as written·Cancel",
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

  it('failed: Cancel withdraws the turn and puts what the owner wrote back in the composer', async () => {
    queue = [held('FAILED')];
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-foot.is-error')).toBeTruthy());
    queue = [];
    await act(async () =>
      [...mounted().querySelectorAll<HTMLButtonElement>('.chat-translate-foot button')].find((b) => b.textContent === 'Cancel')!.click(),
    );
    await waitForUi(() => expect(vi.mocked(cancelQueuedTurn)).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-held'));
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-foot.is-error')).toBeNull());
    await waitForUi(() => expect(box().value).toBe(HELD_TEXT));
  });

  it("failed with a file: Cancel reads the file's bytes before withdrawing, and withdraws nothing if it can't", async () => {
    const withFile = { ...held('FAILED'), attachments: [{ id: 'att-old', mimeType: 'image/png' }] };
    const cancelPress = () =>
      act(async () =>
        [...mounted().querySelectorAll<HTMLButtonElement>('.chat-translate-foot button')].find((b) => b.textContent === 'Cancel')!.click(),
      );
    vi.mocked(cancelQueuedTurn).mockClear();
    vi.mocked(fetchAttachmentFile).mockRejectedValueOnce(new Error('attachment att-old: 404'));
    queue = [withFile];
    await mount();
    await waitForUi(() => expect(mounted().querySelector('.chat-translate-foot.is-error')).toBeTruthy());
    await cancelPress();
    await waitForUi(() => expect(vi.mocked(fetchAttachmentFile)).toHaveBeenCalledWith('att-old', undefined, 'image/png'));
    expect(vi.mocked(cancelQueuedTurn)).not.toHaveBeenCalled();
    expect(mounted().querySelector('.chat-translate-foot.is-error')).toBeTruthy();

    await cancelPress();
    await waitForUi(() => expect(vi.mocked(cancelQueuedTurn)).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-held'));
    expect(vi.mocked(fetchAttachmentFile)).toHaveBeenCalledTimes(2);
  });

  it('failed opening prompt: no Cancel, since the server keeps a session\'s opening', async () => {
    seedMock.mockResolvedValue({ events: [], hasMore: false });
    queue = [{ ...held('FAILED'), opening: true }];
    await mount();
    await waitForUi(() =>
      expect(mounted().querySelector('.chat-translate-foot.is-error')?.textContent).toBe(
        "Couldn't translate, so it wasn't sent·Retry·Send as written",
      ),
    );
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
