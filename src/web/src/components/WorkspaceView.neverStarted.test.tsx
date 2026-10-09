// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { dispatchRefusalNextStep } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A conversation whose run never became one, drawn through the session page itself.
 *
 * The page used to say one thing about such a session — "Getting the session ready … usually
 * seconds" — which is a promise the wait will end. It does not: the runner refused the start
 * before any engine existed, and nothing but the reader's own press changes that. Both kinds are
 * held here on the real page: a task session whose SOURCE was refused (the code, the ref and the
 * runner's words are all on the row, and the next step is the shared sentence), and an ordinary
 * session whose cause is the machine's (read out of `session.error`, which is the vocabulary the
 * transcript's repair cards already speak).
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

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView, sessionLine, statusGlyphMotion, statusLabel } = await import('./WorkspaceView');
const { waitingNoticeFor } = await import('../lib/runnerSlots');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000a3');
const TASK_PUBLIC = '34bhbVgdYajslnz4aXvVA';
const REF = 'refs/heads/project/34bZ3i4AvgJaaoaw5E9tH';

const RUNNER = {
  id: RUNNER_ID,
  name: 'longdeMac-mini.local',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const BASE = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  provider: 'claude',
  createdAt: '2026-10-07T07:45:28Z',
  updatedAt: '2026-10-07T07:45:43Z',
  prompt: '请开始执行任务「两端引擎牌常驻 OpenCode 行」',
};

/** The refused start of 2026-10-07, as the session detail carries it after the run was settled. */
/** The same refusal on a row whose run status was never settled — the shape the card is for first. */
const REFUSED_RUNNING = {
  status: 'RUNNING',
  engineStartedAt: null,
  sourceState: 'REFUSED',
  sourceRefusalCode: 'BASE_REF_NOT_FOUND',
};

const REFUSED_SESSION = {
  ...BASE,
  title: '执行任务：两端引擎牌常驻 OpenCode 行',
  status: 'FAILED',
  taskId: TASK_PUBLIC,
  numTurns: 0,
  engineStartedAt: null,
  error: `BASE_REF_NOT_FOUND: git: fatal: couldn't find remote ref ${REF}`,
  sourceState: 'REFUSED',
  sourceRef: REF,
  sourceRefusalCode: 'BASE_REF_NOT_FOUND',
  sourceRefusalDetail: {
    ref: REF,
    refAuthority: 'REMOTE',
    remoteName: 'origin',
    stderr: `git: fatal: couldn't find remote ref ${REF}`,
    fixAction: 'FIX_REF',
  },
};

/** An ordinary conversation whose runner vanished while the run was starting. */
const OFFLINE_SESSION = {
  ...BASE,
  title: '帮我看看今天的抓取日志',
  status: 'FAILED',
  numTurns: 0,
  engineStartedAt: null,
  error: 'runner offline',
};

/** The engine this machine cannot run yet: the session is still queued for a newer one. */
const UPGRADE_SESSION = {
  ...BASE,
  title: '帮我看看今天的抓取日志',
  provider: 'opencode',
  status: 'QUEUED',
  numTurns: 0,
  engineStartedAt: null,
  error: 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

/**
 * The refused reading, on the surfaces that choose a WORD. A refusal is terminal for the source
 * machine (SR34), so no surface may keep saying the engine is coming up or working — which is what
 * every one of these did while a row still carried RUNNING under a refusal.
 */
describe('a refused run reads as over', () => {
  it('draws no waiting notice, and no working glyph, whatever the run status says', () => {
    expect(waitingNoticeFor(REFUSED_RUNNING)).toBeNull();
    expect(statusGlyphMotion(REFUSED_RUNNING)).toBeNull();
    expect(sessionLine(REFUSED_RUNNING, true)).toEqual({ text: 'Failed', tone: 'preview' });
    expect(statusLabel(REFUSED_RUNNING)).toBe('Failed');
  });

  it('reads a session whose refusal names only the code the same way', () => {
    expect(waitingNoticeFor({ status: 'RUNNING', sourceRefusalCode: 'BASE_REF_NOT_FOUND' })).toBeNull();
  });

  it('leaves a session with no refusal to the waits it has', () => {
    const starting = { status: 'RUNNING', engineStartedAt: null };
    expect(waitingNoticeFor(starting)).toEqual({ kind: 'starting', since: null });
    expect(statusLabel(starting)).toBe('Starting');
  });
});

describe('a session whose run never started', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const card = (): HTMLElement | null => mounted().querySelector<HTMLElement>('[data-run-never-started]');
  const button = (label: string): HTMLButtonElement | null =>
    [...mounted().querySelectorAll<HTMLButtonElement>('.chat-authfix button')]
      .find((b) => (b.textContent ?? '').trim() === label) ?? null;

  const mount = async (session: { title: string }, expectCard = true): Promise<void> => {
    vi.mocked(getSession).mockResolvedValue(session as never);
    const nextClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
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
            <AntApp>
              <WorkspaceView runner={RUNNER} />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      // Either way the page has resolved the session before the assertions run: one half waits for
      // the card, the other for the title it must NOT be standing under.
      await vi.waitFor(
        () => {
          if (expectCard) expect(card()).not.toBeNull();
          else expect(mounted().textContent).toContain(session.title);
        },
        { timeout: 20_000, interval: 20 },
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    vi.mocked(getSession).mockReset();
    vi.mocked(getSessionEventPage).mockReset();
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockReset();
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' });
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
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
      }
      if (path.startsWith('/sessions')) return reply([]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      // The confirmation read `WorkspaceView` makes for a session that has a task; a bare array
      // here is what made the receipt fold read `.decisions` off an array.
      if (/^\/tasks\/[^/]+\/owner-confirmation$/.test(path)) {
        return reply({ decisions: [], waiting: null });
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

  it('says why the refusal happened, with the server’s ref and the shared next step', async () => {
    await mount(REFUSED_SESSION);

    const found = card();
    expect(found?.getAttribute('data-run-never-started')).toBe('SOURCE_REFUSED');
    const text = found!.textContent ?? '';
    expect(text).toContain('This run never started');
    expect(text).toContain('BASE_REF_NOT_FOUND');
    expect(text).toContain(REF);
    expect(text).toContain(`git: fatal: couldn't find remote ref ${REF}`);
    // The same sentence the task's timeline and the coordinator's message carry.
    expect(text).toContain(dispatchRefusalNextStep({ fixAction: 'FIX_REF', ref: REF }));
    // …and not one word of the wait it replaces.
    expect(mounted().textContent).not.toContain('Getting the session ready');

    expect(button('Start it again')).not.toBeNull();
    expect(button('Chat about this')).not.toBeNull();
  });

  it('starts a NEW run of the task when Start it again is pressed', async () => {
    await mount(REFUSED_SESSION);

    await act(async () => {
      button('Start it again')!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(apiMock.mock.calls.some(([path]) => String(path).includes('/execute'))).toBe(true), {
        timeout: 20_000,
        interval: 20,
      });
    });
    const call = apiMock.mock.calls.find(([path]) => String(path).includes('/execute'))!;
    expect(String(call[0])).toBe(`/tasks/${TASK_PUBLIC}/execute`);
    expect((call[1] as { method?: string }).method).toBe('POST');
    expect(typeof (call[1] as { body?: { triggerId?: string } }).body?.triggerId).toBe('string');
  });

  it('names the machine when the runner went offline, and offers the message again', async () => {
    await mount(OFFLINE_SESSION);

    const found = card();
    expect(found?.getAttribute('data-run-never-started')).toBe('RUNNER_OFFLINE');
    const text = found!.textContent ?? '';
    expect(text).toContain('The runner holding this session went offline');
    expect(text).toContain('longdeMac-mini.local stopped reporting while this run was starting');
    expect(text).toContain('Disconnected — runner went offline');
    expect(button('Send it again')).not.toBeNull();
    expect(button('Open the runner')).not.toBeNull();
  });

  it('waits for a newer runner instead of promising a start that is seconds away', async () => {
    await mount(UPGRADE_SESSION);

    const found = card();
    expect(found?.getAttribute('data-run-never-started')).toBe('RUNNER_UPGRADE');
    const text = found!.textContent ?? '';
    expect(text).toContain('Waiting for a newer runner');
    expect(text).toContain('OpenCode requires Orbit runner 0.1.82 or newer; update this runner first');
    // The queued notice this card replaces was a claim about a slot; neither it nor the starting
    // notice may stand beside the card.
    expect(mounted().textContent).not.toContain('Getting the session ready');
    expect(mounted().querySelector('.chat-queued-state')).toBeNull();
  });

  // The rows the fix has to reach first: a session whose SOURCE was refused while its run status
  // still says RUNNING (the control plane settles the run a moment later, and rows from before that
  // are still out there). The refusal is already in the row's own columns, so the page must not keep
  // drawing the wait it promises to end.
  it('outranks the waiting notice while the row still says RUNNING', async () => {
    await mount({ ...REFUSED_SESSION, status: 'RUNNING' });

    expect(card()?.getAttribute('data-run-never-started')).toBe('SOURCE_REFUSED');
    const page = mounted().textContent ?? '';
    expect(page).toContain('This run never started');
    expect(page).not.toContain('Getting the session ready');
    expect(page).not.toContain('Starting');
    // …and the header wears the word a run that is over wears, not the wait's.
    expect(page).toContain('Failed');
  });

  it('draws nothing of the sort for a run whose engine spoke', async () => {
    await mount({
      ...BASE,
      title: '修复登录跳转',
      status: 'RUNNING',
      numTurns: 3,
      engineStartedAt: '2026-10-07T07:45:43.000Z',
      error: null,
    }, false);

    expect(card()).toBeNull();
  });
});
