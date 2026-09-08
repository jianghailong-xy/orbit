// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { STRIP_LABEL } from './DecisionRail';

/**
 * A card that arrived on the live stream, after the question it was raised for is over.
 *
 * `SessionsService.listApprovals` already drops a dead card before returning it, on two committed
 * facts and no clock (`stillBeingAsked`). That filter is only reachable by a FETCH, and the web
 * console fetches approvals twice: when a session is selected, and after one is answered. The card
 * a person actually sees mid-turn came neither way — it was pushed as an `approval_request` frame
 * and put straight into React state. When the engine abandons the call it publishes no
 * `approval_resolved` and writes nothing anywhere, so nothing takes that card back out: it stays on
 * screen, still pressable, and an answer to it reaches nobody, because the poll loop that would
 * have consumed the decision died with the turn (`docs/completion-input-routing.md` §A2 D1).
 *
 * So this mounts the real WorkspaceView and delivers the cards the way that path delivers them —
 * over the stream, never through `listApprovals`, which is stubbed empty here precisely so a card
 * that survives can only have come from a frame. Then it ends the question the two ways the server
 * recognises, one per test, and asserts the same pair each time: the card that died stops offering
 * an answer and says where the decision can still be made, and a card on the same screen whose turn
 * is still alive is untouched. The second half is not decoration — without it an ApprovalPanel that
 * rendered nothing at all would satisfy the first.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // getSessionEventPage calls the module-local `api`, so replacing the exported `api`
  // alone would never intercept the transcript seed.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
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
// The wire carries public ids (the server's interceptor encodes every uuid on the way out), and
// the route id IS that public id — so every stub must speak it too.
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;

/** The call the engine gives up on, and the one it is still waiting on. Distinct commands, because
 *  the card renders its input verbatim and that is how a test tells two cards apart. */
const ABANDONED_COMMAND = 'rg --files-with-matches stillBeingAsked src/apiserver';
const LIVE_COMMAND = 'npm run build --workspace @orbit/web';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const GENERATING = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'a turn holding two permission prompts',
  status: 'RUNNING',
  runStatus: 'RUNNING',
  runState: 'RUNNING',
  engineTurnActive: true,
  provider: 'claude',
  createdAt: '2026-09-07T13:00:00Z',
  updatedAt: '2026-09-07T13:27:00Z',
};

/** The same row after the turn ended: the one committed fact the abandon leaves behind when the
 *  whole turn is what went away. Nothing on the approval itself changes — it never does. */
const PARKED = {
  ...GENERATING,
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  engineTurnActive: false,
};

/** The two calls, already in the transcript when their permission prompts arrive. */
const TOOL_CALLS = [
  { seq: 10, type: 'tool_use', payload: { id: 'call-abandoned', name: 'Bash', input: { command: ABANDONED_COMMAND } }, turnId: 'turn-1', ts: '2026-09-07T13:25:00Z' },
  { seq: 11, type: 'tool_use', payload: { id: 'call-live', name: 'Bash', input: { command: LIVE_COMMAND } }, turnId: 'turn-1', ts: '2026-09-07T13:25:01Z' },
];

/** Live-only nudges, seq 0, exactly as `runner-api.controller.ts` publishes them. */
const APPROVAL_FRAMES = [
  { seq: 0, type: 'approval_request', payload: { id: 'approval-abandoned', toolName: 'Bash', input: { command: ABANDONED_COMMAND }, toolUseId: 'call-abandoned' }, ts: '2026-09-07T13:25:02Z' },
  { seq: 0, type: 'approval_request', payload: { id: 'approval-live', toolName: 'Bash', input: { command: LIVE_COMMAND }, toolUseId: 'call-live' }, ts: '2026-09-07T13:25:03Z' },
];

/** The engine giving up on one call while the turn runs on — the only trace it leaves. */
const ABANDONED_RESULT = {
  seq: 12,
  type: 'tool_result',
  payload: { toolUseId: 'call-abandoned', content: 'permission request expired', isError: true },
  turnId: 'turn-1',
  ts: '2026-09-07T13:55:00Z',
};

const TURN_END = { seq: 13, type: 'turn_end', payload: {}, turnId: 'turn-1', ts: '2026-09-07T13:55:00Z' };

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

let sessionRow: Record<string, unknown> = GENERATING;
const unstubbed: string[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  unstubbed.length = 0;
  sessionRow = GENERATING;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  seedMock.mockReset();
  seedMock.mockImplementation(async () => ({ events: TOOL_CALLS, hasMore: false }));
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith('/sessions/') && path.includes('/events/page')) {
      return reply({ events: TOOL_CALLS, hasMore: false });
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      // The fetch path, answering the way the server answers it — and the reason a card on screen
      // here can only have arrived as a frame.
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(sessionRow);
    }
    if (path.startsWith('/sessions')) return reply([sessionRow]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    if (path === '/providers' || path === '/session-tags' || path === '/task-lists' || path === '/runners') return reply([]);
    unstubbed.push(path);
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

/** Publish the frames the way the server does: one `message` per event, in order.
 *
 *  The stream is opened behind WorkspaceView's session-switch debounce (`SWITCH_DEBOUNCE_MS`), a
 *  real timer that `act` does not run — so whether an EventSource exists the instant `mount()`
 *  returns is a question about how long the mount happened to take, not about the page. Waiting
 *  for it is the same assertion, held until the machine can answer it. */
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

/** The card rendering a given call — the input is echoed verbatim, so the command names it. */
const cardFor = (command: string): HTMLElement => {
  const found = [...mounted().querySelectorAll('.approval-card')].find((card) =>
    card.textContent?.includes(command),
  );
  if (!found) throw new Error(`no approval card on screen for: ${command}`);
  return found as HTMLElement;
};

const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
  ...card.querySelectorAll<HTMLButtonElement>('button'),
];

/** The card's own primary action — Approve here, Submit on a question. */
const primaryOf = (card: HTMLElement): HTMLButtonElement => {
  const button = card.querySelector<HTMLButtonElement>('button.card-action--primary');
  if (!button) throw new Error('the approval card rendered no primary action');
  return button;
};

/** Both cards on screen, having arrived only as frames. */
async function bothCardsArriveLive(): Promise<void> {
  await mount();
  await publish([...TOOL_CALLS, ...APPROVAL_FRAMES]);
  await waitForUi(() => {
    expect(mounted().querySelectorAll('.approval-card')).toHaveLength(2);
  });
  // Both start answerable. Asserted before anything ends, so a later `disabled` is the abandon
  // being noticed rather than a card that was never pressable in the first place.
  expect(primaryOf(cardFor(ABANDONED_COMMAND)).disabled).toBe(false);
  expect(primaryOf(cardFor(LIVE_COMMAND)).disabled).toBe(false);
  expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
}

describe('an approval that arrived live outlives the question it was raised for', { timeout: 30_000 }, () => {
  it('stops offering an answer once the call it asks about has a result', async () => {
    await bothCardsArriveLive();

    // The engine gave up on one call and ran on. Nothing is written to the approval row, here or
    // on the server — the result of the call it was raised for is the entire trace.
    await publish([ABANDONED_RESULT]);

    await waitForUi(() => {
      expect(primaryOf(cardFor(ABANDONED_COMMAND)).disabled).toBe(true);
    });
    // Every action, not just the first: "Always allow" and "Reject" go through the same dead poll
    // loop, and so does the reply "Chat about this" sends back as a deny.
    for (const action of actionsOf(cardFor(ABANDONED_COMMAND))) {
      expect(action.disabled, `a dead card still offers: ${action.textContent}`).toBe(true);
    }

    // The positive control, in the same render: the other call has no result, the turn is still
    // generating, and that card is exactly as pressable as it was.
    expect(
      primaryOf(cardFor(LIVE_COMMAND)).disabled,
      'a live question was disabled along with the dead one',
    ).toBe(false);
  });

  it('stops offering an answer once the turn that asked has ended', async () => {
    await bothCardsArriveLive();

    // The other half of the abandon: the whole turn went away. The session row is the committed
    // fact; the approval rows are still exactly as the runner wrote them.
    sessionRow = PARKED;
    await publish([TURN_END]);

    await waitForUi(() => {
      expect(primaryOf(cardFor(ABANDONED_COMMAND)).disabled).toBe(true);
    });
    // Both cards were raised by the turn that ended, so both go — which is the same rule, not a
    // second one. The paired control for this half is the assertion inside the fixture above:
    // while the session was generating, both of these were pressable.
    expect(primaryOf(cardFor(LIVE_COMMAND)).disabled).toBe(true);
    expect(mounted().querySelectorAll('.approval-card')).toHaveLength(2);
  });

  it('says where the decision can still be made instead of going quiet', async () => {
    await bothCardsArriveLive();
    // Neither card points anywhere while both are answerable — otherwise the assertion below
    // would pass on a card that always says it.
    expect(cardFor(ABANDONED_COMMAND).textContent).not.toContain(STRIP_LABEL);

    await publish([ABANDONED_RESULT]);

    await waitForUi(() => {
      expect(primaryOf(cardFor(ABANDONED_COMMAND)).disabled).toBe(true);
    });
    // The pinned strip is the fallback D1 chose: answering it writes a decision directly and needs
    // no live turn. Named by the strip's own label, so renaming it cannot leave this pointing at a
    // heading that is no longer on screen.
    expect(cardFor(ABANDONED_COMMAND).textContent).toContain(STRIP_LABEL);
    expect(cardFor(LIVE_COMMAND).textContent).not.toContain(STRIP_LABEL);
  });
});
