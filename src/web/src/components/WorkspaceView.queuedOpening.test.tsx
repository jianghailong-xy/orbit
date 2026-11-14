// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * A session no runner has claimed yet opens on its first message, not on an empty page.
 *
 * The opening prompt is laid down as a turn when the session is created, and
 * `GET /sessions/:id/turns?view=active` lists it as the accepted head, marked `opening`, until the
 * runner's echo of it lands (apiserver session-create-attachments-alone.pg.spec.ts). The console
 * draws it from that row, beside the Queued state, and when the claimed turn's `user` event arrives
 * the transcript holds the one copy.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const TS = '2026-11-14T09:30:00.000Z';
const OPENING = 'Fix: Codex update failed on orbit@austin. Read the install log and fix it.';
const OPENING_TURN = '0195c0de-0000-7000-8000-0000000000a1';

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000051';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000052');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000053');

const RUNNER = {
  id: RUNNER_ID,
  name: 'austin',
  online: false,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** Created, and no runner has claimed it. */
const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Fix: Codex update failed on orbit@austin',
  prompt: OPENING,
  status: 'PENDING',
  runState: 'QUEUED',
  provider: 'claude',
  numTurns: 0,
  // The server names no gate: it is simply not claimed yet (runnerSlots `queuedLabel`).
  queuedReason: null,
  createdAt: TS,
  updatedAt: TS,
};

const openingRow: ActiveSessionTurn = {
  turnId: OPENING_TURN,
  kind: 'message',
  placement: 'accepted',
  content: OPENING,
  createdAt: TS,
  attachments: [],
  opening: true,
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

const mounted: { root: Root; el: HTMLDivElement }[] = [];
let client: QueryClient;
/** What the active view lists now: the opening until the echo lands, then nothing. */
let activeRows: ActiveSessionTurn[] = [];

async function openConsole(): Promise<HTMLDivElement> {
  vi.mocked(listQueuedTurns).mockImplementation(async () => activeRows);
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return el;
}

async function drawn(check: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(check, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await act(async () => {});
}

async function publish(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await drawn(() => {
    stream = FakeEventSource.open.find(
      (es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`),
    );
    expect(stream, 'the session opened no event stream').toBeTruthy();
  });
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** The reader's own bubbles, by what they say. */
const bubbles = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.chat-user .md')].map((md) => md.textContent?.trim() ?? '');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  activeRows = [openingRow];
  FakeEventSource.open = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
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
  for (const { root, el } of mounted.splice(0)) {
    await act(async () => root.unmount());
    el.remove();
  }
  await client.cancelQueries();
  client.clear();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('a session no runner has claimed yet', { timeout: 60_000 }, () => {
  it('shows its first message in the transcript, beside the Queued state', async () => {
    const el = await openConsole();
    await drawn(() => expect(bubbles(el)).toEqual([OPENING]));

    expect(el.textContent, 'the session no longer says it is queued').toContain('Queued');
    expect(el.textContent).not.toContain('Working for');
    // The accepted head: nothing for the reader to cancel, and no line of the queue's own.
    expect(el.querySelector('.chat-queued-meta')).toBeNull();
  });

  it('once the claimed turn’s echo arrives, the first message is there exactly once', async () => {
    const el = await openConsole();
    await drawn(() => expect(bubbles(el)).toEqual([OPENING]));

    // The runner claims it: the active view stops listing the opening once its echo is stored.
    activeRows = [];
    await publish([
      { seq: 1, type: 'system', turnId: OPENING_TURN, ts: TS, payload: { subtype: 'init' } },
      { seq: 2, type: 'user', turnId: OPENING_TURN, ts: TS, payload: { text: OPENING } },
      { seq: 3, type: 'assistant', turnId: OPENING_TURN, ts: TS, payload: { text: 'Reading the install log.' } },
    ]);
    await drawn(() => expect(el.textContent).toContain('Reading the install log.'));

    expect(bubbles(el)).toEqual([OPENING]);
    expect(el.querySelectorAll('[data-seq]').length, 'the bubble is the echo, not the placeholder').toBeGreaterThan(0);
  });
});
