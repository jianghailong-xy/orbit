// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A background job that ends while its session is running a turn is written INTO that turn: the
 * control plane files its wake as a steer aimed at the running turn (runner-api/background-job-wake.ts,
 * createTurn's `steerIfLive`) instead of queueing it behind the turn, where it used to wait minutes
 * and then open a whole turn of its own.
 *
 * So the same wake now has a steer's two states to be drawn in, and both have to keep the wake's own
 * shape — the one event line in the agent's stream that replaced the card on the reader's side on
 * 2026-09-29:
 *
 *   - while it waits for the runner, the queued tail draws the line with a steer's state under it.
 *     A steer is on its way into the turn and the server refuses to withdraw it (409), so there is no
 *     Cancel and no Withdraw wake — only how far it has got.
 *   - once the runner has written it, its echo (`steer: true`, the block in `controlPlaneNote`) is the
 *     line, inside the running turn's stream where it landed, saying how far it got — and never a
 *     bubble in the reader's name. The block is the note, not the text: the text minus the note is
 *     empty, which is exactly what would draw an empty bubble if the note were not read.
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
const { Transcript } = await import('./Transcript');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

// Built the way runner-api/background-job-wake.ts `buildBackgroundWakeBlock` builds a steer's block.
const STEERED = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for. It ended while you were working, so this message was added to the turn you are in:',
  '    bgj_5e1f0c2a9b7d｜job｜npm run build｜the release build',
  '      ended｜failed｜exit code 2',
  '      output /root/.orbit/runs/4f50733a/bgj_5e1f0c2a9b7d.output｜this covers bytes 0–4096',
  '      output tail:',
  '        make: *** [build] Error 2',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

// And a job's new output, which still waits for the next turn however busy the session is.
const NEXT_TURN = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_77aa00cc11ee｜watch｜gh run watch 4242 --exit-status｜watch main CI',
  '      new output｜running',
  '      output /root/.orbit/runs/4f50733a/bgj_77aa00cc11ee.output｜this covers bytes 0–512',
  '      output tail:',
  '        * lint (ubuntu-latest) in progress',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

const TYPED = 'refactor the parser';
const TS = '2026-10-03T07:00:00.000Z';

// ── waiting for the runner, in the queued tail ─────────────────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');

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
  title: 'Refactor the parser',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-03T06:50:00Z',
  updatedAt: '2026-10-03T07:00:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a wake written into the running turn, while it waits for the runner', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    // What GET /sessions/:id/turns?view=active answers for the exit steered into the running turn,
    // beside an output wake that waits for the next one.
    const queue: ActiveSessionTurn[] = [
      {
        turnId: 'turn-steered-wake',
        kind: 'steer',
        placement: 'steer',
        targetTurnId: 'turn-running',
        content: STEERED,
        createdAt: '2026-10-03T07:00:01.000Z',
        authoredByOrbit: true,
      },
      {
        turnId: 'turn-next-wake',
        kind: 'message',
        placement: 'queued',
        content: NEXT_TURN,
        createdAt: '2026-10-03T07:00:02.000Z',
        authoredByOrbit: true,
      },
    ];
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

  it('is the wake’s line with a steer’s state under it, and nothing to cancel or withdraw', async () => {
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
    await act(async () => {
      await vi.waitFor(
        () => expect(mounted().querySelectorAll('.bgwake')).toHaveLength(2),
        { timeout: 20_000, interval: 20 },
      );
    });

    const [steered, nextTurn] = [...mounted().querySelectorAll<HTMLElement>('.bgwake')];
    expect(steered.querySelector('.bgwake-title')?.textContent).toBe('Background job failed');
    expect(steered.querySelector('.bgwake-name')?.textContent).toBe('the release build');
    expect(steered.classList.contains('is-queued'), 'drawn as not yet an event').toBe(true);

    // How far it has got, in a steer's own words — and no way to take it back, because there is none.
    const steerLine = steered.querySelector('.bgwake-queued .chat-queued-meta')!;
    expect(steerLine.querySelector('.chat-queued-tag')?.textContent).toBe('Sending…');
    expect(steerLine.textContent).not.toContain('Queued for next turn');
    expect(steered.querySelectorAll('a')).toHaveLength(0);
    expect(steered.textContent).not.toContain('Cancel');
    expect(steered.textContent).not.toContain('Withdraw wake');

    // The output wake beside it still waits for the next turn, and still leaves by an ordinary Cancel.
    const nextLine = nextTurn.querySelector('.bgwake-queued .chat-queued-meta')!;
    expect(nextLine.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...nextLine.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    // Neither is drawn as something the reader typed.
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((bubble) => bubble.textContent?.includes('bgj_')),
      'no part of either wake is a user bubble',
    ).toBe(false);
  });
});

// ── written into the turn: its echo, in the running turn's stream ──────────────────────────────

/** The running turn: the reader's message, the reply it is in the middle of, and a tool call. */
const RUNNING_TURN: RunEvent[] = [
  { seq: 1, type: 'user', turnId: 'turn-running', ts: TS, payload: { text: TYPED } },
  { seq: 2, type: 'assistant', turnId: 'turn-running', ts: TS, payload: { text: 'Starting with the tokenizer.' } },
  { seq: 3, type: 'tool_use', turnId: 'turn-running', ts: TS, payload: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } } },
];

/** What ingest stores for the steer's echo: the whole block is the control plane's note. */
const steeredEcho = (delivery: string): RunEvent => ({
  seq: 4,
  type: 'user',
  turnId: 'turn-steered-wake',
  ts: TS,
  payload: { text: STEERED, controlPlaneNote: STEERED, steer: true, delivery },
});

const delivered = (seq: number, delivery: string): RunEvent => ({
  seq,
  type: 'user_delivery',
  turnId: 'turn-running',
  ts: TS,
  payload: { turnId: 'turn-steered-wake', delivery },
});

/** The rest of the same turn, after the engine read the wake. */
const AFTER: RunEvent[] = [
  { seq: 6, type: 'tool_result', turnId: 'turn-running', ts: TS, payload: { toolUseId: 'tool-1', content: '2 passed' } },
  { seq: 7, type: 'assistant', turnId: 'turn-running', ts: TS, payload: { text: 'The release build failed; fixing the import first.' } },
];

describe('a wake written into the running turn, once the runner has written it', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(events: RunEvent[]) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>,
      );
    });
  }

  const line = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.bgwake');
    if (!el) throw new Error(`no wake line was rendered:\n${container.innerHTML}`);
    return el;
  };

  it('is the wake’s event line inside the running turn, never a bubble in the reader’s name', async () => {
    await mount([...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'written'), ...AFTER]);

    expect(line().getAttribute('data-seq')).toBe('4');
    expect(line().classList.contains('is-queued'), 'an event now, not a queued row').toBe(false);
    expect(line().querySelector('.bgwake-title')?.textContent).toBe('Background job failed');
    expect(line().querySelector('.bgwake-status')?.textContent).toBe('exit 2');
    // A failure's tail stays out of the fold, as for any wake line.
    expect(line().querySelector('.bgwake-tail')?.textContent).toContain('make: *** [build] Error 2');

    // The reader's own message is the only bubble: the wake's echo has no words of anybody's in it.
    const bubbles = [...container.querySelectorAll<HTMLElement>('.chat-user')];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toContain(TYPED);
    expect(container.textContent).not.toContain('Orbit attached');

    // In the turn it was written into: after the reply and the tool call it interrupted, before the
    // rest of that same reply, with no turn boundary in between.
    const reply = container.querySelector('[data-seq="2"]')!;
    const rest = container.querySelector('[data-seq="7"]')!;
    expect(reply.compareDocumentPosition(line()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line().compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.chat-turn-divider')).toBeNull();

    // How far it got, in the words a steer's bubble uses.
    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Delivering…');
  });

  it('says how far it got, from the runner taking it to the engine reading it', async () => {
    await mount([...RUNNING_TURN, steeredEcho('enqueued')]);
    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Sending…');

    await mount([...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'written')]);
    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Delivering…');

    await mount([...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'written'), delivered(6, 'acknowledged')]);
    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Sent into this turn');
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
  });

  it('missed, says it comes back as a turn of its own; re-delivered, is the same one line', async () => {
    await mount([...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'requeued')]);
    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Queued for next turn instead');

    // The same row, delivered as the wake turn it became: one line, no longer a steer's.
    const redelivered: RunEvent = {
      seq: 9,
      type: 'user',
      turnId: 'turn-steered-wake',
      ts: TS,
      payload: { text: STEERED, controlPlaneNote: STEERED, delivery: 'enqueued' },
    };
    await mount([
      ...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'requeued'),
      { seq: 8, type: 'turn_end', turnId: 'turn-running', ts: TS, payload: {} },
      redelivered,
    ]);
    expect(container.querySelectorAll('.bgwake')).toHaveLength(1);
    expect(line().querySelector('.bgwake-steer')).toBeNull();
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
  });

  it('that never arrived says so, and nothing else', async () => {
    await mount([...RUNNING_TURN, steeredEcho('enqueued'), delivered(5, 'failed')]);
    expect(line().querySelector('.bgwake-undelivered')?.textContent).toBe('The session has not confirmed it received this.');
    expect(line().querySelector('.bgwake-steer')).toBeNull();
  });
});
