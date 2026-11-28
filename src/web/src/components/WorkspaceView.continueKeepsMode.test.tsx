// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * Continue on a stopped session resumes it in the mode its composer shows — and the server stores
 * that mode on the session.
 *
 * Seen on orbitd.io, 2026-11-23: two task runs that had worked in Auto for hours stopped on a usage
 * limit, the owner pressed Continue, and from then on every Bash call asked for approval. Both had
 * been resumed in Default. Opened after a Codex session, the composer's check "can this model run
 * Auto?" ran in the same commit as the new session's seeds, read the Codex session's model (which
 * Claude has no Auto for), and dropped Auto before the session's own model arrived.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    resumeSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, resumeSession } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const STOPPED_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a3');
const PREVIOUS_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');

const ALL_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
/** The Claude rows of the runner the report came from, plus one model that has no Auto. */
const CLAUDE_CATALOG = [
  ...['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((value) => ({
    value,
    label: value,
    permissionModes: ALL_MODES,
  })),
  { value: 'claude-no-auto', label: 'claude-no-auto', permissionModes: ALL_MODES.filter((m) => m !== 'auto') },
];

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
  ],
  modelCatalog: { claude: CLAUDE_CATALOG },
} as unknown as Runner;

/** A task run stopped by a usage limit: no mode of its own, so the account's (here: none, so Auto). */
const stoppedRun = (model: string) => ({
  id: STOPPED_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Task: migrate the stored tables',
  status: 'FAILED',
  provider: 'claude',
  engine: 'claude',
  model,
  numTurns: 244,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-11-23T03:34:26Z',
  createdAt: '2026-11-23T03:34:26Z',
  updatedAt: '2026-11-23T05:01:28Z',
});

const LIMIT_TAIL = [
  { seq: 871, type: 'tool_result', payload: { toolUseId: 't1', content: 'moved to the background' } },
  { seq: 873, type: 'assistant', payload: { text: "You've hit your 5-hour limit · resets 2pm (Asia/Singapore)" } },
];
const PREVIOUS_TAIL = [{ seq: 1, type: 'assistant', payload: { text: 'done' } }];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('Continue on a stopped session keeps its mode', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let stopped: Record<string, unknown> = {};
  let previous: Record<string, unknown> = {};

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const continueButton = (): HTMLElement | null =>
    mounted().querySelector<HTMLElement>('.chat-quota .chat-quota-retry');

  /** Opens the previous session, then the stopped one, presses Continue, and returns the mode sent. */
  const continueAfter = async (prev: Record<string, unknown>, run: Record<string, unknown>): Promise<unknown> => {
    previous = { ...run, ...prev, id: PREVIOUS_PUBLIC, title: 'Previous session', status: 'SUCCEEDED' };
    stopped = run;
    const router = createMemoryRouter([{ path: '*', element: <WorkspaceView runner={RUNNER} /> }], {
      initialEntries: [`/sessions/${PREVIOUS_PUBLIC}`],
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const shown = { root, client };
    await act(async () => {
      shown.root.render(
        <QueryClientProvider client={shown.client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    // The previous session settles in the composer first, as it had on the reader's screen.
    await act(async () => {
      await vi.waitFor(() => expect(mounted().textContent).toContain('done'), { timeout: 20_000, interval: 20 });
    });
    await act(async () => {
      await router.navigate(`/sessions/${STOPPED_PUBLIC}`);
    });
    await act(async () => {
      await vi.waitFor(() => expect(continueButton()?.textContent).toBe('Continue'), { timeout: 20_000, interval: 20 });
    });
    await act(async () => {
      continueButton()!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(vi.mocked(resumeSession).mock.calls.length).toBe(1), {
        timeout: 20_000,
        interval: 20,
      });
    });
    const [sessionId, content, config] = vi.mocked(resumeSession).mock.calls[0];
    expect(sessionId).toBe(STOPPED_PUBLIC);
    expect(content).toBe('Continue where you left off.');
    return (config as { permissionMode?: unknown }).permissionMode;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '', nothingToResend: true });
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async (id: string) => (id === PREVIOUS_PUBLIC ? previous : stopped) as never);
    vi.mocked(getSessionEventPage).mockReset();
    vi.mocked(getSessionEventPage).mockImplementation(
      async (id: string) =>
        (id === PREVIOUS_PUBLIC ? { events: PREVIOUS_TAIL, hasMore: false } : { events: LIMIT_TAIL, hasMore: true }) as never,
    );
    vi.mocked(resumeSession).mockReset();
    vi.mocked(resumeSession).mockResolvedValue({
      turnId: 'turn-continue', seq: 878, kind: 'message' as never, placement: 'accepted',
    } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({
          id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z',
          // The reporting account's own: last-picked models on both engines, no default mode.
          preferences: { defaultModels: { 'codex:codex': 'gpt-6-astra', 'claude:claude': 'claude-opus-5-5' } },
        });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'lakehouse', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      for (const [id, row, tail] of [
        [PREVIOUS_PUBLIC, () => previous, PREVIOUS_TAIL],
        [STOPPED_PUBLIC, () => stopped, LIMIT_TAIL],
      ] as const) {
        if (!path.startsWith(`/sessions/${id}`)) continue;
        if (path.includes('/events/page')) return reply({ events: tail, hasMore: id === STOPPED_PUBLIC });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(row());
      }
      if (path.startsWith('/sessions')) return reply([stopped, previous]);
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

  it('resumes in Auto when opened after a Codex session', async () => {
    const mode = await continueAfter(
      { engine: 'codex', provider: 'codex', model: 'gpt-6-astra' },
      stoppedRun('claude-opus-5-5'),
    );
    expect(mode, "the Codex session's model is not this session's").toBe('auto');
  });

  it('resumes in Auto when opened after another Claude session', async () => {
    expect(await continueAfter({ model: 'claude-sonnet-5-5' }, stoppedRun('claude-opus-5-5'))).toBe('auto');
  });

  // The intent is never rewritten here (docs/mocks/permission-mode-actual, C1): the server starts a model with no
  // Auto in Default, records that as the mode running, and keeps Auto for a model that has it.
  it('keeps Auto when its own model has no Auto, which the server runs as Default', async () => {
    expect(await continueAfter({ model: 'claude-opus-5-5' }, stoppedRun('claude-no-auto'))).toBe('auto');
  });
});
