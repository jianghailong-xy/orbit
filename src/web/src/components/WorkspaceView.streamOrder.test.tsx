// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The live stream, end to end through the handler that reads it.
 *
 * Transcript.streamingOrder pins where the drafts render for a given anchor and streamAnchor
 * pins what the anchor becomes; neither exercises the SSE handler that has to move it. This
 * mounts the real WorkspaceView, feeds it the frames of a real turn (session 01a07092,
 * 2026-09-05: a Bash call, a closing thinking block, a second Bash call, then the answer that
 * explains what the second call found) and asserts the one thing a user sees — the order the
 * rows come out in.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // getSessionEventPage lives in this module and calls the module-local `api`, so replacing the
  // exported `api` alone would never intercept the transcript seed.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, sessionEventsUrl } = await import('../api');
const apiMock = vi.mocked(api);
const seedMock = vi.mocked(getSessionEventPage);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000011';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000012';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000013';
// The wire carries public ids (the server's interceptor encodes every uuid on the way out), and
// the route id IS that public id — so every stub must speak it too.
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;

const FIRST_COMMAND = 'git commit --amend';
const SECOND_COMMAND = 'git status --short';
const ANSWER = 'blocked by the classifier — the checkout is still dirty';

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
  title: 'SSE ordering',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-05T13:00:00Z',
  updatedAt: '2026-09-05T13:27:00Z',
};

/** The two events already on screen when the stretch under test begins. */
const SEED = [
  { seq: 2900, type: 'tool_use', payload: { id: 't1', name: 'Bash', input: { command: FIRST_COMMAND } }, turnId: 'turn-1', ts: '2026-09-05T13:25:00Z' },
  { seq: 2901, type: 'tool_result', payload: { toolUseId: 't1', content: 'blocked', isError: true }, turnId: 'turn-1', ts: '2026-09-05T13:25:40Z' },
];

/**
 * What the runner then published, in order. The deltas carry seqs of their own (assigned by the
 * runner, never persisted — which is why the stored seqs of that turn jump 2935 → 3191), and the
 * stretch stops short of the authoritative `assistant`: mid-generation is the whole of the bug.
 */
const STREAM = [
  { seq: 2931, type: 'thinking', payload: { text: '' } },
  { seq: 2932, type: 'system', payload: { subtype: 'context', contextTokens: 291426 } },
  { seq: 2933, type: 'tool_use', payload: { id: 't2', name: 'Bash', input: { command: SECOND_COMMAND } } },
  { seq: 2934, type: 'tool_result', payload: { toolUseId: 't2', content: ' M package.json' } },
  { seq: 2935, type: 'system', payload: { subtype: 'status' } },
  { seq: 2936, type: 'thinking_delta', payload: { text: 'weighing it up' } },
  { seq: 2937, type: 'text_delta', payload: { text: ANSWER } },
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
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
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
    if (path.startsWith('/sessions/') && path.includes('/events/page')) {
      return reply({ events: SEED, hasMore: false });
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
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

/** Publish the frames the way the server does: one `message` per event, in seq order. */
async function publish(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));
  expect(stream, 'the session opened no event stream').toBeTruthy();
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

describe('the live stream renders in the order it arrived', { timeout: 20_000 }, () => {
  it('keeps a tool call the model ran above the reply that explains it', async () => {
    await mount();
    await waitForUi(() => {
      expect(mounted().querySelectorAll('.chat-tool-card')).toHaveLength(1);
    });
    expect(sessionEventsUrl(SESSION_PUBLIC)).toContain(`/api/sessions/${SESSION_PUBLIC}/events`);

    await publish(STREAM);

    await waitForUi(() => {
      expect(mounted().querySelector('.chat-streaming-md')?.textContent).toContain(ANSWER);
    });

    expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
    const cards = [...mounted().querySelectorAll('.chat-tool-card')];
    expect(cards, 'both tool calls are on screen').toHaveLength(2);
    expect(mounted().textContent).toContain(SECOND_COMMAND);

    // The whole of the bug, as a user sees it: the answer must come after the command it
    // describes, not between the two calls.
    const draft = mounted().querySelector('.chat-streaming-md')!;
    const secondCard = cards[1];
    expect(
      secondCard.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the streamed answer renders ABOVE the tool call it explains',
    ).toBeTruthy();
  });
});
