// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer's model chip on a task run whose model smart selection picked (docs/model-routing-
 * design.md §9; the web mock §4): a ✦ and a light blue ground, nothing wider — and its menu opens on
 * why it is this model and closes on the way to the task, where the model is fixed for every run.
 * A session opened by hand, and a task run on an Agent that has not turned smart selection on, keep
 * the chip exactly as it was.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    getSession: vi.fn(),
    updateSessionConfig: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, updateSessionConfig } =
  await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000f1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000f2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000f3');
const TASK = encodeId('0195c0de-0000-7000-8000-0000000000f4');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  modelCatalog: {
    claude: [
      { label: 'Opus 5.5', value: 'claude-opus-5-5', contextWindow: 1_000_000 },
      { label: 'Sonnet 5.5', value: 'claude-sonnet-5-5', contextWindow: 1_000_000 },
      { label: 'Fable 5.1', value: 'claude-fable-5-1', contextWindow: 1_000_000 },
    ],
  },
} as unknown as Runner;

/** The decision the run was planned with, as the session read carries it (§7.5). */
const ROUTE = {
  level: 'L',
  provider: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  applied: true,
  escalated: true,
  reasons: [
    'Tier L — raised after run 1 (M) failed its acceptance command',
    "Engine claude: this agent's own engine",
    'Opus weekly quota at 41% — no quota step-down needed',
  ],
  policyVersion: 1,
  decidedAt: '2026-10-03T02:24:00.000Z',
};

/** A task's run, live and waiting for a reply, on the model and effort smart selection picked. */
const TASK_RUN = {
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  title: 'Freeze the run target at v2',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  permissionMode: 'auto',
  taskId: TASK,
  taskTitle: 'Freeze the run target at v2',
  route: ROUTE,
  numTurns: 3,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-10-03T02:24:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-10-03T02:24:00Z',
  updatedAt: '2026-10-03T02:30:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let where = '';
/** Where the router is, so the menu's way to the task can be followed. */
function Where() {
  where = useLocation().pathname;
  return null;
}

describe('the model chip on a task run smart selection picked', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const chip = () => mounted().querySelector<HTMLButtonElement>('.composer-model-chip');

  /** Mount over this session, and wait for the chip to read what the session runs on. */
  const mount = async (session: Record<string, unknown>, chipText: string): Promise<void> => {
    vi.mocked(getSession).mockImplementation(async () => session as never);
    apiMock.mockImplementation((p: string, options?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (options?.method === 'PATCH') return reply({});
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/providers') return reply([]);
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z' }]);
      }
      if (p.startsWith(`/sessions/${SESSION}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/created-tasks')) return reply({ items: [] });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        return reply(session);
      }
      if (p.startsWith('/sessions')) return reply([session]);
      if (p.includes('/owner-confirmation')) return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const nextClient = client;
    const nextRoot = root;
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${SESSION}`]}>
            <AntApp>
              <Where />
              {/* As the app routes them: the console holds a session, and the task page is apart. */}
              <Routes>
                <Route path="/sessions/:id" element={<WorkspaceView runner={RUNNER} />} />
                <Route path="/tasks/:id" element={<div className="task-page-probe" />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(chip()?.textContent).toBe(chipText), { timeout: 20_000, interval: 20 });
    });
  };

  const click = async (el: HTMLElement | undefined | null, what: string) => {
    if (!el) throw new Error(`nothing to click: ${what}`);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  /** Menu rows by the key rc-menu stamps into `data-menu-id`. */
  const row = (key: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('.composer-model-menu .ant-dropdown-menu-item')).find((el) =>
      el.getAttribute('data-menu-id')?.endsWith(`-${key}`),
    );
  /** Open the chip's menu, and wait for antd's portal to hold its model rows. */
  const open = async () => {
    await click(chip(), 'the model chip');
    await act(async () => {
      await vi.waitFor(() => expect(row('model:claude-opus-5-5')).toBeDefined(), { timeout: 20_000, interval: 20 });
    });
  };
  const note = () => document.querySelector<HTMLElement>('.composer-model-menu .composer-route-note');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
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
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(updateSessionConfig).mockReset();
    vi.mocked(updateSessionConfig).mockResolvedValue({} as never);
    apiMock.mockReset();
    where = '';
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

  it('marks the chip with ✦ on a light blue ground, adding no words to it', async () => {
    await mount(TASK_RUN, '✦Opus 5.5High');
    expect(chip()?.classList.contains('is-smart')).toBe(true);
    expect(chip()?.querySelector('.composer-model-spark')?.textContent).toBe('✦');
    expect(chip()?.querySelector('.composer-model-name')?.textContent).toBe('Opus 5.5');
    expect(chip()?.querySelector('.composer-model-effort')?.textContent).toBe('High');
    expect(chip()?.getAttribute('aria-label')).toBe('Model Opus 5.5, effort High, picked by smart selection');
  });

  it('opens its menu on why, keeps the models under it, and ends on the way to the task', async () => {
    await mount(TASK_RUN, '✦Opus 5.5High');
    await open();
    expect(note()).not.toBeNull();
    expect(note()!.querySelector('.composer-route-head')?.textContent).toBe('✦Picked by smart selection · tier L');
    expect([...note()!.querySelectorAll('.composer-route-reason')].map((el) => el.textContent?.replace(/\s+/g, ' '))).toEqual([
      'Tier L — raised after run 1 (M) failed its acceptance command',
      'Changing the model here applies to this run only. To fix the model for every run, set it on the task.',
    ]);
    // The models are still the ones to change it to, for this run.
    expect(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'].map((m) => row(`model:${m}`)?.textContent))
      .toEqual(['Opus 5.5', 'Sonnet 5.5', 'Fable 5.1']);
    // The way to the task is the menu's last row.
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.composer-model-menu > .ant-dropdown-menu-item'));
    expect(rows.at(-1)?.getAttribute('data-menu-id')?.endsWith('-open-task')).toBe(true);
    expect(row('open-task')?.textContent).toBe('Open task ›');

    await click(row('open-task'), 'Open task');
    await act(async () => {
      await vi.waitFor(() => expect(where).toBe(`/tasks/${TASK}`), { timeout: 20_000, interval: 20 });
    });
    expect(document.querySelector('.task-page-probe')).not.toBeNull();
  });

  it('leaves a session opened by hand exactly as it was', async () => {
    const byHand = { ...TASK_RUN, taskId: null, taskTitle: null, route: null };
    await mount(byHand, 'Opus 5.5High');
    expect(chip()?.classList.contains('is-smart')).toBe(false);
    expect(chip()?.querySelector('.composer-model-spark')).toBeNull();
    expect(chip()?.getAttribute('aria-label')).toBe('Model Opus 5.5, effort High');
    await open();
    expect(note()).toBeNull();
    expect(row('open-task')).toBeUndefined();
  });

  it('leaves a task run on an Agent without smart selection as it was, though it records what it would pick', async () => {
    const shadow = {
      ...TASK_RUN,
      route: { ...ROUTE, applied: false, level: 'S', model: 'claude-sonnet-5-5', effort: 'low', escalated: false },
    };
    await mount(shadow, 'Opus 5.5High');
    expect(chip()?.classList.contains('is-smart')).toBe(false);
    await open();
    expect(note()).toBeNull();
    expect(row('open-task')).toBeUndefined();
  });

  it('drops the mark once this run is on a model smart selection did not pick', async () => {
    // Changed here, for this run: the session's model is no longer the routed one.
    const changed = { ...TASK_RUN, model: 'claude-fable-5-1' };
    await mount(changed, 'Fable 5.1High');
    expect(chip()?.classList.contains('is-smart')).toBe(false);
    await open();
    expect(note()).toBeNull();
  });
});
