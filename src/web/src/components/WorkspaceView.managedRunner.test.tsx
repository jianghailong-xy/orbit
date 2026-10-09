// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A managed runner's workspace in the real console (WorkspaceConsole → WorkspaceView), driven by
 * the server state samples every client is rendered from. Its state stands above the composer;
 * asleep, a message is accepted rather than refused as offline, and sending it shows the runner
 * waking; before the runner was ever ready, its default workspace offers no engine for a first
 * session (the server would refuse it with MODEL_UNAVAILABLE); a failure's Retry calls the server's
 * retry. A self-managed runner's offline console, and the console of a server without the
 * capability, are what they were.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These call api.ts's own `api`, so each is replaced on its own.
  return {
    ...actual,
    api: vi.fn(),
    createInteractiveSession: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    resumeSession: vi.fn(),
  };
});
// jsdom has no IndexedDB.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, createInteractiveSession, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, resumeSession } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceConsole } = await import('./WorkspaceConsole');
const { encodeId } = await import('../lib/idCodec');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as {
  capabilities: { name: string; body: unknown }[];
  states: { name: string; status: ManagedRunnerStatus }[];
};
const state = (name: string) => fixture.states.find((c) => c.name === name)!.status;
const capability = (name: string) => fixture.capabilities.find((c) => c.name === name)!.body;

const MANAGED_RUNNER = state('sleeping').runnerId!;
const MANAGED_WORKSPACE = state('sleeping').workspaceId!;
const OWN_RUNNER = encodeId('0195c0de-0000-7000-8000-0000000000b1');
const OWN_WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const NEW_SESSION = encodeId('0195c0de-0000-7000-8000-0000000000b3');
const ENDED_SESSION = encodeId('0195c0de-0000-7000-8000-0000000000b4');

/** A conversation that ended while its managed runner slept: the server says RUNNER_OFFLINE. */
const ENDED = {
  id: ENDED_SESSION,
  title: 'Tidy the release notes',
  status: 'SUCCEEDED',
  runStatus: 'SUCCEEDED',
  runState: 'SUCCEEDED',
  lifecycleState: 'OPEN',
  provider: 'claude',
  startedAt: '2026-10-09T06:00:00Z',
  createdAt: '2026-10-09T06:00:00Z',
  lastTurnAt: '2026-10-09T06:05:00Z',
  numTurns: 2,
  runtimeSessionId: 'runtime-1',
  assignedRunnerId: MANAGED_RUNNER,
  runnerId: MANAGED_RUNNER,
  workspaceId: MANAGED_WORKSPACE,
  workspace: { id: MANAGED_WORKSPACE, name: 'Default' },
  capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'RUNNER_OFFLINE', canComplete: true, canRestore: false },
};

const runner = (id: string, name: string) => ({
  id,
  name,
  online: false,
  status: 'OFFLINE',
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
});

interface Server {
  capabilities: unknown;
  /** What GET /managed-runner answers, in turn: the last one repeats. */
  statuses: ManagedRunnerStatus[];
  /** What the managed default workspace says it starts a session on. */
  lastProvider: string;
}
let server: Server;
let statusReads = 0;
let posted: { path: string; body: Record<string, unknown> }[] = [];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  statusReads = 0;
  posted = [];
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockResolvedValue(ENDED as never);
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
  vi.mocked(resumeSession).mockReset();
  vi.mocked(resumeSession).mockImplementation(async (sessionId: string) => {
    posted.push({ path: `/sessions/${sessionId}/resume`, body: {} });
    return { turnId: 'turn-3', placement: 'accepted' } as never;
  });
  vi.mocked(createInteractiveSession).mockReset();
  vi.mocked(createInteractiveSession).mockImplementation(async (body) => {
    posted.push({ path: '/sessions', body: body as unknown as Record<string, unknown> });
    return { id: NEW_SESSION };
  });
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
    if (options?.method === 'POST') {
      posted.push({ path, body: options.body ?? {} });
      if (path === '/managed-runner/retry') return Promise.resolve(state('preparing: requested'));
      return Promise.reject(new Error(`unstubbed POST ${path}`));
    }
    if (path === '/auth/capabilities') return Promise.resolve(server.capabilities);
    if (path === '/managed-runner') {
      const answer = server.statuses[Math.min(statusReads, server.statuses.length - 1)];
      statusReads += 1;
      return Promise.resolve(answer);
    }
    if (path === '/users/me') {
      return Promise.resolve({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/runners') return Promise.resolve([runner(MANAGED_RUNNER, 'Managed runner'), runner(OWN_RUNNER, 'mac-01')]);
    if (path === '/workspaces') {
      return Promise.resolve([
        { id: OWN_WORKSPACE, name: 'orbit', runnerId: OWN_RUNNER, createdAt: '2026-01-01T00:00:00Z', position: 0, lastProvider: 'claude' },
        { id: MANAGED_WORKSPACE, name: 'Default', runnerId: MANAGED_RUNNER, createdAt: '2026-10-09T00:00:00Z', position: null, lastProvider: server.lastProvider },
      ]);
    }
    if (['/providers', '/providers/pools', '/providers/shared-pools', '/session-tags', '/session-folders'].includes(path)) return Promise.resolve([]);
    if (path.startsWith('/sessions?')) return Promise.resolve([]);
    if (path.startsWith(`/sessions/${ENDED_SESSION}`)) {
      if (path.includes('/diff')) return Promise.resolve({ files: [] });
      if (path.includes('/created-tasks')) return Promise.resolve({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return Promise.resolve([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return Promise.resolve({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return Promise.resolve({ items: [], nextCursor: null });
    return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
  }) as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} addEventListener() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
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
    mountedNode?.remove();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
}

const mounted = () => {
  if (!container) throw new Error('not mounted');
  return container;
};
const composer = () => mounted().querySelector<HTMLTextAreaElement>('.workspace-composer textarea')!;
const sendButton = () => mounted().querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
const notice = () => mounted().querySelector<HTMLElement>('.workspace-composer .managed-runner-notice');
const noticeTitle = () => notice()?.querySelector('.managed-runner-notice-title')?.textContent ?? null;

/** Open the New Session draft of a workspace in the console, the way its route does (or `entry`). */
async function open(workspaceId: string, entry = `/workspaces/${workspaceId}/new`): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={[entry]}>
          <AntApp>
            <Routes>
              <Route element={<WorkspaceConsole />}>
                <Route path="workspaces/:id/*" />
                <Route path="sessions/:id" />
              </Route>
            </Routes>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => expect(composer()).toBeTruthy());
}

async function type(text: string): Promise<void> {
  const area = composer();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a managed workspace in the console', () => {
  it('asleep: says so, takes a message instead of refusing it as offline, and shows the runner waking', async () => {
    server = {
      capabilities: capability('switched on'),
      statuses: [state('sleeping'), state('waking: a message asked the sleeping runner')],
      lastProvider: 'claude',
    };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(noticeTitle()).toBe('Managed runner asleep'));
    // Not "Runner offline", no registration anywhere, and the engine it was ready with is offered.
    expect(composer().placeholder).toBe('Send this workspace a task…');
    expect(mounted().textContent?.toLowerCase()).not.toContain('register');
    expect(mounted().querySelector('.np-hero')).toBeTruthy();

    await type('Pick up where we left off');
    await waitForUi(() => expect(sendButton().disabled).toBe(false));
    await act(async () => sendButton().click());

    await waitForUi(() => expect(posted.map(({ path }) => path)).toEqual(['/sessions']));
    expect(posted[0].body.workspaceId).toBe(MANAGED_WORKSPACE);
    // The send asks the status again at once: the message is what woke it.
    await waitForUi(() => expect(noticeTitle()).toBe('Waking your managed runner'));
  });

  it('before it was ever ready: no default engine for a first session, and nothing to send', async () => {
    server = { capabilities: capability('switched on'), statuses: [state('preparing: starting')], lastProvider: 'claude' };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(noticeTitle()).toBe('Preparing your managed runner'));
    expect(mounted().querySelector('.np-hero')).toBeNull();
    expect(composer().placeholder).toBe('Preparing your managed runner');
    await type('Hello');
    expect(sendButton().disabled).toBe(true);
  });

  it('started without a signed-in runtime: says so, points at Infrastructure, and still offers no engine', async () => {
    server = {
      capabilities: capability('switched on'),
      statuses: [state('model unavailable: started without a signed-in runtime')],
      lastProvider: 'claude',
    };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(noticeTitle()).toBe('Your managed runner needs a model'));
    const link = [...notice()!.querySelectorAll('a')].find((a) => a.textContent === 'Open Infrastructure');
    expect(link?.getAttribute('href')).toBe(`/infrastructure?runner=${encodeId(MANAGED_RUNNER)}`);
    expect(mounted().querySelector('.np-hero')).toBeNull();
    await type('Hello');
    expect(sendButton().disabled).toBe(true);
  });

  it('failed: Retry calls the server’s retry with the revision it read, and the console follows the answer', async () => {
    server = { capabilities: capability('switched on'), statuses: [state('failed: retryable')], lastProvider: 'claude' };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(noticeTitle()).toBe('Managed runner failed'));
    expect(composer().placeholder).toBe('Managed runner failed');
    const retry = [...notice()!.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    await waitForUi(() => expect(posted.map(({ path }) => path)).toEqual(['/managed-runner/retry']));
    expect(posted[0].body.revision).toBe(state('failed: retryable').revision);
    expect(typeof posted[0].body.idempotencyKey).toBe('string');
    await waitForUi(() => expect(noticeTitle()).toBe('Preparing your managed runner'));
  });

  it('asleep, a conversation that ended: its message resumes it rather than being refused as offline', async () => {
    server = {
      capabilities: capability('switched on'),
      statuses: [state('sleeping'), state('waking: a message asked the sleeping runner')],
      lastProvider: 'claude',
    };
    await open(MANAGED_WORKSPACE, `/sessions/${ENDED_SESSION}`);
    await waitForUi(() => expect(noticeTitle()).toBe('Managed runner asleep'));
    await waitForUi(() => expect(mounted().textContent).toContain('Send a message to resume this session.'));
    expect(mounted().textContent).not.toContain('cannot accept messages');

    await type('One more thing');
    await waitForUi(() => expect(sendButton().disabled).toBe(false));
    await act(async () => sendButton().click());
    await waitForUi(() => expect(posted.map(({ path }) => path)).toEqual([`/sessions/${ENDED_SESSION}/resume`]));
    expect(vi.mocked(resumeSession).mock.calls[0].slice(0, 2)).toEqual([ENDED_SESSION, 'One more thing']);
    expect(createInteractiveSession).not.toHaveBeenCalled();
    await waitForUi(() => expect(noticeTitle()).toBe('Waking your managed runner'));
  });

  it('removed: says so and takes nothing', async () => {
    server = { capabilities: capability('switched on'), statuses: [state('removed')], lastProvider: 'claude' };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(noticeTitle()).toBe('Managed runner removed'));
    expect(composer().placeholder).toBe('Managed runner removed');
    await type('Hello');
    expect(sendButton().disabled).toBe(true);
  });
});

describe('what stays as it was', () => {
  it('a self-managed runner offline: no managed notice, and "Runner offline" as before', async () => {
    server = { capabilities: capability('switched on'), statuses: [state('failed: retryable')], lastProvider: 'claude' };
    await open(OWN_WORKSPACE);
    await waitForUi(() => expect(composer().placeholder).toBe('Runner offline'));
    expect(notice()).toBeNull();
    await type('Hello');
    expect(sendButton().disabled).toBe(true);
  });

  it('without the capability, a conversation that ended on it is refused as offline, as before', async () => {
    server = { capabilities: capability('switched off'), statuses: [state('sleeping')], lastProvider: 'claude' };
    await open(MANAGED_WORKSPACE, `/sessions/${ENDED_SESSION}`);
    await waitForUi(() => expect(mounted().textContent).toContain(ENDED.title));
    await waitForUi(() => expect(composer().placeholder).toBe('Runner offline'));
    expect(notice()).toBeNull();
    expect(statusReads).toBe(0);
  });

  it('without the capability the managed workspace is one more offline runner, and its status is never read', async () => {
    server = { capabilities: capability('switched off'), statuses: [state('sleeping')], lastProvider: 'claude' };
    await open(MANAGED_WORKSPACE);
    await waitForUi(() => expect(composer().placeholder).toBe('Runner offline'));
    expect(notice()).toBeNull();
    expect(statusReads).toBe(0);
    await type('Hello');
    expect(sendButton().disabled).toBe(true);
  });
});
