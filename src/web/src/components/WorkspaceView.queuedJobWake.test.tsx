// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * A background job's wake that waits on the queue (job-card board E1): the queued tail draws no row for it, and the
 * job's own card says the agent has not read it yet, with Don't send, which takes it off the queue as the tail's
 * Cancel did (JobCard, WorkspaceView `jobQueuedWakes`).
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

const { api, cancelQueuedTurn, getSessionEventPage, interruptSession, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const cancelMock = vi.mocked(cancelQueuedTurn);
const interruptMock = vi.mocked(interruptSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const JOB = 'bgj_9f3a21c07d55';
const TS = '2026-09-14T16:39:00.000Z';
const ENDED = '2026-09-14T16:51:40.000Z';
const COMMAND = 'gh run watch 19632123456 --exit-status';
const TITLE = 'Wait for CI JavaScript job on 4c8f5a8a1b';
const WAKE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  `    ${JOB}｜watch｜${COMMAND}｜${TITLE}`,
  '      ended｜failed｜exit code 1',
  `      output /root/.orbit/runs/s/${JOB}.output｜this covers bytes 0–120`,
  '      output tail:',
  '        run ended before JavaScript finished: completed cancelled',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');
const at = (seq: number, type: string, payload: Record<string, unknown>, ts = TS) => ({ seq, type, turnId: 'turn-1', ts, payload });
const EVENTS = [
  at(1, 'user', { text: 'Watch the CI run in the background.' }),
  at(2, 'tool_use', { id: 'toolu_bg', name: 'mcp__orbit__bg_run', input: { command: COMMAND, description: TITLE, kind: 'watch', wakeOnExit: true } }),
  at(3, 'tool_use', { id: JOB, name: 'Bash', input: { command: COMMAND, description: TITLE, run_in_background: true } }),
  at(4, 'tool_result', { toolUseId: JOB, content: `Command running in background with ID: ${JOB}. Output is being written to: /root/.orbit/runs/s/${JOB}.output.` }),
  at(5, 'tool_result', { toolUseId: 'toolu_bg', content: [{ type: 'text', text: JSON.stringify({ ok: true, entity: { jobId: JOB, startedAt: TS } }) }] }),
  at(6, 'background_task', { shellId: JOB, toolUseId: JOB, status: 'running', kind: 'watch', command: COMMAND }),
  at(7, 'assistant', { text: 'Watching it.' }),
  at(8, 'turn_end', {}),
  at(9, 'background_task', { shellId: JOB, toolUseId: JOB, status: 'failed', exitCode: 1, kind: 'watch', command: COMMAND }, ENDED),
];

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
  title: 'Coordinator: Watch project',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-14T16:00:00Z',
  updatedAt: '2026-09-14T16:40:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/** The server's queue: both turns wait behind the running one until something takes them off it. */
let queue: ActiveSessionTurn[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const composer = (): HTMLTextAreaElement | null =>
  mounted().querySelector<HTMLTextAreaElement>('.composer-field textarea');

// Below the test budget, so a wait that runs out fails its test instead of outliving it.
const waitForUi = async (assertion: () => void): Promise<void> => {
  // The act environment is off while the window is waited out, as RTL's own asyncWrapper
  // does it: React queues every render scheduled inside an in-flight act callback and flushes
  // none of them until that callback settles, so a page that answers inside the window can
  // never draw what the window exists to see — the wait times out with the data already in
  // the cache (workstation-gpu: e85b63ee9's second full run; the merge check reds here).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  // And one act to close the window: the last commit the wait saw leaves its passive effects
  // scheduled, and what they carry — React Query's mutation options among it — is what the
  // test's next press runs on. The old act-wrapped wait flushed them on its way out; this
  // keeps that, without the freeze that made the wait itself blind.
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
  queue = [
    { turnId: 'turn-wake', kind: 'message', placement: 'queued', content: WAKE, createdAt: '2026-09-14T16:40:01.000Z' },
  ];
  apiMock.mockReset();
  cancelMock.mockReset();
  cancelMock.mockImplementation(async (_session: string, turnId: string) => {
    queue = queue.filter((turn) => turn.turnId !== turnId);
    return {};
  });
  // An interrupt drops everything queued behind the turn it stops.
  interruptMock.mockReset();
  interruptMock.mockImplementation(async () => {
    queue = [];
    return {} as never;
  });
  vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: EVENTS, hasMore: false } as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: EVENTS, hasMore: false });
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

async function mountSession(): Promise<void> {
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
}

const card = (): HTMLElement | null => mounted().querySelector<HTMLElement>(`[data-bg-job="${JOB}"]`);

describe('a background job’s wake on the queue', { timeout: 60_000 }, () => {
  it('waits on the job’s card, not in the queued tail, and Don’t send takes it off the queue', async () => {
    await mountSession();
    await waitForUi(() => {
      expect(card()?.querySelector('.chat-subagent-end-chip.is-failed')?.textContent).toBe('exit 1');
      expect(card()?.querySelector('.chat-subagent-queued')?.textContent).toBe(
        "Waiting for the agent to read it · Don't send",
      );
    });
    // The queued tail draws nothing for it: no line, no From Orbit line, no bubble, no queue row.
    expect(mounted().querySelector('.bgwake, .orbitwake, .chat-queued, .chat-queued-meta')).toBeNull();
    expect(mounted().querySelectorAll('.chat-user')).toHaveLength(1);
    expect(mounted().querySelectorAll('[data-bg-job]')).toHaveLength(1);

    await click(card()!.querySelector('.chat-subagent-queued button')!);
    await waitForUi(() => {
      expect(cancelMock).toHaveBeenCalledWith(SESSION_PUBLIC, 'turn-wake');
      expect(card()?.querySelector('.chat-subagent-queued')).toBeNull();
    });
    // The card keeps its end.
    expect(card()?.querySelector('.chat-subagent-end-chip.is-failed')?.textContent).toBe('exit 1');
    expect(interruptMock).not.toHaveBeenCalled();
  });
});
