// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A message typed into a session that exists leaves the composer at the press and waits in the
 * transcript as its own bubble (lib/pendingSend, docs/mocks/composer-sending-bubble): `Sending…`
 * until the server takes it, then the ordinary bubble; `Not sent` with Retry and Put back when the
 * server refused it or did not answer in time. Nothing typed after the press is touched by the answer.
 */

// A short wait for the answer, so the timeout case runs in real time.
vi.mock('../lib/pendingSend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pendingSend')>();
  return { ...actual, answerDeadline: () => actual.answerDeadline(60) };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    cancelQueuedTurn: vi.fn(),
    steerQueuedTurn: vi.fn(),
    sendTurn: vi.fn(),
    createInteractiveSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, ApiError, cancelQueuedTurn, getSessionEventPage, listQueuedTurns, sendTurn, steerQueuedTurn } = await import('../api');
void ApiError;
const apiMock = vi.mocked(api);
const cancelMock = vi.mocked(cancelQueuedTurn);
const steerMock = vi.mocked(steerQueuedTurn);
const sendMock = vi.mocked(sendTurn);
const { createInteractiveSession } = await import('../api');
const createMock = vi.mocked(createInteractiveSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { ToastViewport } = await import('./ToastViewport');
const { clearToasts } = await import('../lib/toastStore');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');
const WORDS = 'Check the cluster load every half hour';

const RUNNER = {
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Fix the export script',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-10-15T09:00:00Z',
  updatedAt: '2026-10-15T09:40:00Z',
};

/** A finished exchange: the session waits for the next message. */
const IDLE: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 'turn-1', ts: '2026-10-15T09:40:00Z', payload: { text: 'export last night' } },
  { seq: 2, type: 'assistant', turnId: 'turn-1', ts: '2026-10-15T09:41:00Z', payload: { text: 'Done, the export finished.' } },
  { seq: 3, type: 'turn_end', turnId: 'turn-1', ts: '2026-10-15T09:41:01Z', payload: {} },
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

let events: RunEvent[] = IDLE;
let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const composer = (): HTMLTextAreaElement | null => mounted().querySelector<HTMLTextAreaElement>('.composer-field textarea');
const bubble = (): HTMLElement | undefined =>
  [...mounted().querySelectorAll<HTMLElement>('.chat-user-wrap')].find((w) => w.textContent?.includes(WORDS));
const buttonIn = (scope: Element | undefined, label: string): HTMLElement | undefined =>
  [...(scope?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === label);
const toasts = (): string => document.body.querySelector('.toast-viewport, [class*="toast"]')?.textContent ?? '';

const waitForUi = async (assertion: () => void): Promise<void> => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
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
  events = IDLE;
  FakeEventSource.open = [];
  queue = [];
  apiMock.mockReset();
  cancelMock.mockReset();
  steerMock.mockReset();
  sendMock.mockReset();
  createMock.mockReset();
  where = '';
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events, hasMore: false }) as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'dp', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events, hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(SESSION);
    }
    // The session a first message opens: its own detail, an empty conversation, nothing else yet.
    const other = /^\/sessions\/([^/?]+)(\/[^?]*)?/.exec(path);
    if (other && other[1] !== SESSION_PUBLIC && !['listing', 'counts'].includes(other[1])) {
      if (!other[2]) return reply({ ...SESSION, id: other[1], status: 'PENDING' });
      if (other[2] === '/events/page') return reply({ events: [], hasMore: false });
      if (other[2] === '/created-tasks') return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply([]);
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
    await act(async () => clearToasts());
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

let where = '';
function Where() {
  where = useLocation().pathname;
  return null;
}

async function mountSession(ready: () => void, entry = `/sessions/${SESSION_PUBLIC}`): Promise<void> {
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
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="*" element={<WorkspaceView runner={RUNNER} />} />
          </Routes>
          <Where />
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(ready);
}


/** Types into the composer, as the reader does. */
async function type(words: string): Promise<HTMLTextAreaElement> {
  const box = composer()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.focus();
  return box;
}
async function pressEnter(box: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}
const accepted = { turnId: 'turn-2', seq: 4, kind: 'message', placement: 'accepted' } as never;

describe('a message sent from the composer', { timeout: 60_000 }, () => {
  it('leaves the box at the press and waits as a Sending… bubble, then becomes the ordinary bubble', async () => {
    let answer: (value: never) => void = () => {};
    sendMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mountSession(() => expect(composer()).not.toBeNull());
    const box = await type(WORDS);
    await pressEnter(box);

    await waitForUi(() => expect(bubble()?.textContent).toContain('Sending…'));
    expect(composer()!.value).toBe('');
    expect(bubble()!.querySelector('.chat-sending')).not.toBeNull();
    // Nothing is working yet: the server has not taken it, so no turn clock runs under it.
    expect([...mounted().querySelectorAll('.chat-turn-head')].some((h) => h.textContent?.startsWith('Working'))).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toBe(WORDS);

    // Typed while it is on its way: the answer leaves it alone.
    await type('and post a summary');
    await act(async () => answer(accepted));
    await waitForUi(() => expect(bubble()?.textContent).not.toContain('Sending…'));
    expect(bubble()!.querySelector('.chat-sending')).toBeNull();
    expect(mounted().querySelectorAll('.chat-user-wrap').length).toBe(2);
    expect(composer()!.value).toBe('and post a summary');
  });

  it('says Not sent on the bubble when refused, and Retry sends the same message under the same key', async () => {
    sendMock.mockRejectedValueOnce(new Error('The control plane is restarting'));
    sendMock.mockResolvedValueOnce(accepted);
    await mountSession(() => expect(composer()).not.toBeNull());
    await pressEnter(await type(WORDS));

    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));
    expect(toasts()).not.toContain("Couldn't send");
    expect([...mounted().querySelectorAll('.chat-turn-head')].some((h) => h.textContent?.startsWith('Working'))).toBe(false);
    expect(composer()!.value).toBe('');

    await click(buttonIn(bubble(), 'Retry')!);
    await waitForUi(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1][1]).toBe(WORDS);
    expect(sendMock.mock.calls[1][5]).toBe(sendMock.mock.calls[0][5]);
    await waitForUi(() => expect(bubble()?.textContent).not.toContain('Not sent'));
    expect(mounted().querySelectorAll('.chat-user-wrap').length).toBe(2);
  });

  it('puts the words back in the composer on Put back, and the bubble goes', async () => {
    sendMock.mockRejectedValueOnce(new Error('Session is busy'));
    await mountSession(() => expect(composer()).not.toBeNull());
    await pressEnter(await type(WORDS));
    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));

    await click(buttonIn(bubble(), 'Put back in the composer')!);
    await waitForUi(() => expect(composer()!.value).toBe(WORDS));
    expect(bubble()).toBeUndefined();
  });

  it('gives up on a late answer: the request is ended and the bubble says Not sent', async () => {
    let seen: AbortSignal | undefined;
    sendMock.mockImplementation((...args: unknown[]) => {
      seen = args[7] as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        seen?.addEventListener('abort', () => reject(seen?.reason));
      });
    });
    await mountSession(() => expect(composer()).not.toBeNull());
    await pressEnter(await type(WORDS));

    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));
    expect(seen?.aborted).toBe(true);
    // Send is free again: the next message can go.
    await type('next one');
    await waitForUi(() =>
      expect(mounted().querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false),
    );
  });

  it("drops a Not sent bubble when the message's echo arrives after all", async () => {
    sendMock.mockRejectedValueOnce(new Error('Gateway timeout'));
    await mountSession(() => expect(composer()).not.toBeNull());
    await pressEnter(await type(WORDS));
    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));

    // The server did take it: its user event comes in on the conversation's stream.
    let stream: FakeEventSource | undefined;
    await waitForUi(() => {
      stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));
      expect(stream).toBeTruthy();
    });
    const echo = { seq: 4, type: 'user', turnId: 'turn-2', ts: '2026-10-15T09:43:00Z', payload: { text: WORDS } };
    await act(async () => stream!.onmessage?.({ data: JSON.stringify(echo) }));
    await waitForUi(() => expect(bubble()?.textContent ?? '').not.toContain('Not sent'));
    expect(mounted().querySelectorAll('.chat-user-wrap').length).toBe(2);
  });
});

describe("a new session's first message", { timeout: 60_000 }, () => {
  const NEW_PAGE = `/workspaces/${WORKSPACE_PUBLIC}/new`;
  const NEW_SESSION = encodeId('0195c0de-0000-7000-8000-000000000044');

  it('leaves the box at the press and waits on the new-session page as a Sending… bubble, then opens the session', async () => {
    let answer: (value: { id: string }) => void = () => {};
    createMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mountSession(() => expect(composer()).not.toBeNull(), NEW_PAGE);
    await pressEnter(await type(WORDS));

    await waitForUi(() => expect(bubble()?.textContent).toContain('Sending…'));
    expect(composer()!.value).toBe('');
    expect(createMock).toHaveBeenCalledTimes(1);
    const body = createMock.mock.calls[0][0];
    expect(body.prompt).toBe(WORDS);
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createMock.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    await act(async () => answer({ id: NEW_SESSION }));
    await waitForUi(() => expect(where).toBe(`/sessions/${NEW_SESSION}`));
  });

  it('says Not sent when refused, and Retry sends the same request key, so a lost answer opens no second session', async () => {
    createMock.mockRejectedValueOnce(new Error('The control plane is restarting'));
    createMock.mockResolvedValueOnce({ id: NEW_SESSION });
    await mountSession(() => expect(composer()).not.toBeNull(), NEW_PAGE);
    await pressEnter(await type(WORDS));

    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));
    expect(toasts()).not.toContain("Couldn't send");
    // One first message at a time: a second one waits until this one is retried or put back.
    await type('something else');
    expect(mounted().querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true);

    await click(buttonIn(bubble(), 'Retry')!);
    await waitForUi(() => expect(createMock).toHaveBeenCalledTimes(2));
    expect(createMock.mock.calls[1][0].clientRequestId).toBe(createMock.mock.calls[0][0].clientRequestId);
    await waitForUi(() => expect(where).toBe(`/sessions/${NEW_SESSION}`));
  });

  it('puts the words back in the composer on Put back, and the page is the new-session page again', async () => {
    createMock.mockRejectedValueOnce(new Error('Workspace is busy'));
    await mountSession(() => expect(composer()).not.toBeNull(), NEW_PAGE);
    await pressEnter(await type(WORDS));
    await waitForUi(() => expect(bubble()?.textContent).toContain('Not sent'));

    await click(buttonIn(bubble(), 'Put back in the composer')!);
    await waitForUi(() => expect(composer()!.value).toBe(WORDS));
    expect(bubble()).toBeUndefined();
    expect(where).toBe(NEW_PAGE);
  });
});
