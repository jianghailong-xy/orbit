// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEER_WITHDRAW_ERRORS } from '@orbit/shared';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * The tray above the composer (PendingTray, docs/mocks/steer-tray): the reader's messages nothing has
 * read yet, one row each, out of the conversation until the engine reads them.
 *
 * Taking one back (lib/steerDelivery, WorkspaceView `withdrawSteer`): the row offers it beside
 * "Waiting to be read" when its runner said the engine can drop it unread; the press asks the server,
 * which asks the engine; only its answer removes the row, and then the words are back in the
 * composer. Too late, it says so and the row stays. A steer the runner has not taken yet is offered
 * the same way. Once read, the message leaves the tray and is drawn where it was read.
 *
 * Sending one the other way: a queued row's Steer sends it into the running turn; ⌥Enter, or holding
 * Send, queues a message instead of sending it into the turn.
 */

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
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, ApiError, cancelQueuedTurn, getSessionEventPage, listQueuedTurns, sendTurn, steerQueuedTurn } = await import('../api');
const apiMock = vi.mocked(api);
const cancelMock = vi.mocked(cancelQueuedTurn);
const steerMock = vi.mocked(steerQueuedTurn);
const sendMock = vi.mocked(sendTurn);
const { WorkspaceView } = await import('./WorkspaceView');
const { ToastViewport } = await import('./ToastViewport');
const { clearToasts } = await import('../lib/toastStore');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');
const STEER = 'dp/tea_data_helper 的代码在 ~/dp/tea_data_helper 修复后 push into main，然后发布';

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
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-15T09:00:00Z',
  updatedAt: '2026-10-15T09:40:00Z',
};

/** A turn busy in a long Bash call, and the message written into it while it runs. */
const RUNNING: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 'turn-run', ts: '2026-10-15T09:40:00Z', payload: { text: 'fix the export script' } },
  {
    seq: 2,
    type: 'tool_use',
    turnId: 'turn-run',
    ts: '2026-10-15T09:41:00Z',
    payload: { id: 'b1', name: 'Bash', input: { command: 'python -m pytest -q', description: 'Run the full test suite' } },
  },
  {
    seq: 3,
    type: 'user',
    turnId: 'turn-steer',
    ts: '2026-10-15T09:42:00Z',
    payload: { text: STEER, delivery: 'enqueued', steer: true, withdrawable: true },
  },
  { seq: 4, type: 'user_delivery', turnId: 'turn-steer', ts: '2026-10-15T09:42:01Z', payload: { turnId: 'turn-steer', delivery: 'written' } },
];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let events: RunEvent[] = RUNNING;
let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const composer = (): HTMLTextAreaElement | null => mounted().querySelector<HTMLTextAreaElement>('.composer-field textarea');
const steerBubble = (): HTMLElement | undefined =>
  [...mounted().querySelectorAll<HTMLElement>('.chat-user-wrap')].find((w) => w.textContent?.includes('push into main'));
const trayRow = (words: string): HTMLElement | undefined =>
  [...mounted().querySelectorAll<HTMLElement>('.pending-tray-row')].find((r) => r.textContent?.includes(words));
const rowState = (row: HTMLElement | undefined) => row?.querySelector('.pending-tray-state')?.textContent;

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
  events = RUNNING;
  queue = [];
  apiMock.mockReset();
  cancelMock.mockReset();
  steerMock.mockReset();
  sendMock.mockReset();
  sendMock.mockImplementation(async (_session: string, content: string, _ids?: string[], _kind?: string, intent?: string) =>
    ({ turnId: 'turn-sent', seq: 9, kind: intent === 'CURRENT_WORK' ? 'steer' : 'message', placement: intent === 'CURRENT_WORK' ? 'steer' : 'queued' }) as never);
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

async function mountSession(ready: () => void): Promise<void> {
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
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(ready);
}

const withdrawButton = (scope: Element | undefined): HTMLElement | undefined =>
  scope?.querySelector<HTMLElement>('[aria-label="Withdraw"]') ?? undefined;
const steerButton = (scope: Element | undefined): HTMLElement | undefined =>
  [...(scope?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === 'Steer');

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

describe('a message sent into the running turn, taken back', { timeout: 60_000 }, () => {
  it('waits in the tray, not the conversation, and goes when the engine drops it — its words back in the composer', async () => {
    cancelMock.mockResolvedValue({ ok: true, withdrawn: true });
    await mountSession(() => {
      expect(rowState(trayRow('push into main'))).toBe('Waiting to be read');
      expect(withdrawButton(trayRow('push into main'))).toBeDefined();
    });
    // Nothing has read it, so the conversation has nothing of it, and it is headed into this turn.
    expect(steerBubble()).toBeUndefined();
    expect(trayRow('push into main')?.querySelector('.pending-tray-icon.is-current')).not.toBeNull();
    expect(steerButton(trayRow('push into main'))).toBeUndefined();

    await click(withdrawButton(trayRow('push into main'))!);

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock.mock.calls[0][1]).toBe('turn-steer');
    await waitForUi(() => {
      expect(trayRow('push into main')).toBeUndefined();
      expect(composer()?.value).toBe(STEER);
    });
  });

  it('stays when the engine had already read it, and says it was too late', async () => {
    cancelMock.mockRejectedValue(
      new ApiError('Claude has already read this message, so it can no longer be withdrawn.', 409, STEER_WITHDRAW_ERRORS.ALREADY_READ),
    );
    await mountSession(() => {
      expect(withdrawButton(trayRow('push into main'))).toBeDefined();
    });

    await click(withdrawButton(trayRow('push into main'))!);

    await waitForUi(() => {
      expect(document.body.textContent).toContain('Too late to withdraw');
      expect(document.body.textContent).toContain('Claude has already read it.');
      // The row is where it was, and the way out is back for whatever happens next.
      expect(rowState(trayRow('push into main'))).toBe('Waiting to be read');
      expect(withdrawButton(trayRow('push into main'))).toBeDefined();
    });
    expect(composer()?.value).toBe('');
  });

  it('is offered while no runner has it yet, and the words return under a draft', async () => {
    events = RUNNING.slice(0, 2);
    queue = [{ turnId: 'turn-queued', kind: 'steer', placement: 'steer', content: 'and the docs too', createdAt: '2026-10-15T09:43:00Z' }];
    cancelMock.mockImplementation(async (_session: string, turnId: string) => {
      queue = queue.filter((turn) => turn.turnId !== turnId);
      return { ok: true };
    });
    await mountSession(() => {
      expect(rowState(trayRow('and the docs too'))).toBe('Sending…');
    });
    expect(mounted().querySelector('.chat-queued')).toBeNull();
    await type('one more thing');

    await click(withdrawButton(trayRow('and the docs too'))!);

    expect(cancelMock.mock.calls[0][1]).toBe('turn-queued');
    await waitForUi(() => {
      expect(trayRow('and the docs too')).toBeUndefined();
      expect(composer()?.value).toBe('one more thing\n\nand the docs too');
    });
  });

  it('leaves the tray once read, drawn where it was read', async () => {
    events = [
      ...RUNNING,
      { seq: 5, type: 'tool_result', turnId: 'turn-run', ts: '2026-10-15T09:58:00Z', payload: { toolUseId: 'b1', content: '412 passed' } },
      { seq: 6, type: 'user_delivery', turnId: 'turn-steer', ts: '2026-10-15T09:58:01Z', payload: { turnId: 'turn-steer', delivery: 'acknowledged' } },
    ];
    await mountSession(() => {
      expect(steerBubble()?.querySelector('.chat-steer-state')?.textContent).toBe('Read in this turn');
    });
    expect(mounted().querySelector('.pending-tray')).toBeNull();
    // After the test run it was read at the end of, not before it.
    const order = [...mounted().querySelectorAll('[data-seq]')].map((el) => el.getAttribute('data-seq'));
    expect(order.indexOf('3')).toBeGreaterThan(order.indexOf('2'));
  });
});

describe('a queued message, sent into the running turn', { timeout: 60_000 }, () => {
  const queued = (): ActiveSessionTurn[] => [
    { turnId: 'turn-next', kind: 'message', placement: 'queued', content: 'then update the changelog', createdAt: '2026-10-15T09:43:00Z' },
  ];

  it('is sent into it by Steer, and is on its way from then on', async () => {
    events = RUNNING.slice(0, 2);
    queue = queued();
    steerMock.mockImplementation(async () => {
      queue = [{ ...queued()[0], kind: 'steer', placement: 'steer', targetTurnId: 'turn-run' }];
      return { turnId: 'turn-next', seq: 5, kind: 'steer', placement: 'steer', targetTurnId: 'turn-run' };
    });
    await mountSession(() => {
      expect(rowState(trayRow('then update the changelog'))).toBe('Queued for next turn');
      expect(steerButton(trayRow('then update the changelog'))).toBeDefined();
    });

    await click(steerButton(trayRow('then update the changelog'))!);

    expect(steerMock).toHaveBeenCalledTimes(1);
    expect(steerMock.mock.calls[0][1]).toBe('turn-next');
    await waitForUi(() => {
      expect(rowState(trayRow('then update the changelog'))).toBe('Sending…');
      expect(trayRow('then update the changelog')?.querySelector('.pending-tray-icon.is-current')).not.toBeNull();
      expect(steerButton(trayRow('then update the changelog'))).toBeUndefined();
    });
  });

  it('stays queued when there is no turn left to join, and says so', async () => {
    events = RUNNING.slice(0, 2);
    queue = queued();
    steerMock.mockRejectedValue(
      new ApiError('there is no live message turn to receive CURRENT_WORK', 409, 'CURRENT_WORK_UNAVAILABLE', {
        code: 'CURRENT_WORK_UNAVAILABLE', reason: 'NO_CURRENT_WORK',
      }),
    );
    await mountSession(() => {
      expect(steerButton(trayRow('then update the changelog'))).toBeDefined();
    });

    await click(steerButton(trayRow('then update the changelog'))!);

    await waitForUi(() => {
      expect(document.body.textContent).toContain("Couldn't send it into this turn");
      expect(document.body.textContent).toContain('It stays queued for the next turn.');
      expect(rowState(trayRow('then update the changelog'))).toBe('Queued for next turn');
    });
  });

  it('is withdrawn with its words back under a draft', async () => {
    events = RUNNING.slice(0, 2);
    queue = queued();
    cancelMock.mockImplementation(async () => {
      queue = [];
      return { ok: true };
    });
    await mountSession(() => {
      expect(withdrawButton(trayRow('then update the changelog'))).toBeDefined();
    });
    await type('and the docs');

    await click(withdrawButton(trayRow('then update the changelog'))!);

    await waitForUi(() => {
      expect(trayRow('then update the changelog')).toBeUndefined();
      expect(composer()?.value).toBe('and the docs\n\nthen update the changelog');
    });
  });
});

describe('a message sent the other way while a turn runs', { timeout: 60_000 }, () => {
  it('goes into the turn on Enter, and is queued for the next turn on ⌥Enter', async () => {
    events = RUNNING.slice(0, 2);
    await mountSession(() => {
      expect(composer()).not.toBeNull();
    });

    const box = await type('then push it to main');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    });
    await waitForUi(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0][4]).toBe('NEXT_TURN');

    await type('and tag the release');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitForUi(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1][4]).toBe('CURRENT_WORK');
  });

  it('is queued for the next turn from a held Send, and the hold sends nothing itself', async () => {
    events = RUNNING.slice(0, 2);
    await mountSession(() => {
      expect(composer()).not.toBeNull();
    });
    await type('then push it to main');
    const send = mounted().querySelector<HTMLElement>('.composer-send')!;

    await act(async () => {
      send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await waitForUi(() => expect(mounted().querySelector('.composer-queue-offer')).not.toBeNull());
    await act(async () => {
      send.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    await click(send);
    expect(sendMock).not.toHaveBeenCalled();

    await click([...mounted().querySelectorAll('.composer-queue-offer button')].find((b) => b.textContent === 'Queue for next turn')!);

    await waitForUi(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0][4]).toBe('NEXT_TURN');
    expect(mounted().querySelector('.composer-queue-offer')).toBeNull();
  });
});

describe('where the tray stands', { timeout: 60_000 }, () => {
  // docs/mocks/pending-tray-above-parking (decided 2026-10-28): the conversation's next lines, so the
  // band's first card, right under the conversation and above the parking strip — no longer on the
  // composer's top edge, under it.
  it('is the first card above the composer, over the parking strip', async () => {
    events = [
      RUNNING[0],
      {
        seq: 2,
        type: 'tool_use',
        turnId: 'turn-run',
        ts: '2026-10-15T09:40:30Z',
        payload: { id: 'bg1', name: 'Bash', input: { command: 'make backfill', description: 'Backfill the events', run_in_background: true } },
      },
      {
        seq: 3,
        type: 'tool_result',
        turnId: 'turn-run',
        ts: '2026-10-15T09:40:31Z',
        payload: { toolUseId: 'bg1', content: 'Command running in background with ID: bq1x7m. Output is being written to: /tmp/bq1x7m.output' },
      },
      ...RUNNING.slice(1).map((event) => ({ ...event, seq: event.seq + 2 })),
    ];
    await mountSession(() => {
      expect(rowState(trayRow('push into main'))).toBe('Waiting to be read');
      expect(mounted().querySelector('.bg-tray')?.textContent).toContain('Background processes');
    });
    const band = mounted().querySelector('.workspace-composer')!;
    const tray = band.querySelector('.pending-tray')!;
    expect(band.firstElementChild).toBe(tray);
    expect(tray.compareDocumentPosition(band.querySelector('.bg-tray')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tray.nextElementSibling?.classList.contains('composer-box')).toBe(false);
  });
});
