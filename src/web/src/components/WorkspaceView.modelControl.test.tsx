// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The composer's model control: provider, model, effort and speed as ONE button in the card's
 * toolbar — "Opus 5.5 Max" — whose menu lists the provider's models and keeps the provider and the
 * effort one level down. Mounted for real, so the rows are the ones the view builds from its own
 * reads, and a pick is judged by the request it makes (or does not make).
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

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000e1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000e2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000e3');

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
      { label: 'Opus 5', value: 'claude-opus-5', contextWindow: 1_000_000 },
      { label: 'Sonnet 5', value: 'claude-sonnet-5', contextWindow: 1_000_000 },
    ],
  },
} as unknown as Runner;

const DETAIL = {
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  title: 'the model control',
  status: 'AWAITING_INPUT',
  provider: 'anthropic-2',
  model: 'claude-opus-5-5',
  effort: 'max',
  permissionMode: 'auto',
  numTurns: 3,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-09-25T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-09-25T01:10:00Z',
  updatedAt: '2026-09-25T01:18:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the composer model control', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  const mount = async (): Promise<void> => {
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
              <Routes>
                <Route path="*" element={<WorkspaceView runner={RUNNER} />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // The provider row needs the configured providers read; the effort's name, the session's.
    await act(async () => {
      await vi.waitFor(
        () => expect(chip()?.textContent).toBe('Opus 5.5Max'),
        { timeout: 20_000, interval: 20 },
      );
    });
  };

  const chip = () => mounted().querySelector<HTMLButtonElement>('.composer-model-chip');
  /** What the view asked the server to change, pick by pick (PATCH /sessions/:id/config). */
  const configCalls = () => vi.mocked(updateSessionConfig).mock.calls.map(([, cfg]) => cfg);
  /** Menu rows by the key rc-menu stamps into `data-menu-id`. */
  const row = (key: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')).find((el) =>
      el.getAttribute('data-menu-id')?.endsWith(`-${key}`),
    );
  const submenu = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('.composer-model-menu .ant-dropdown-menu-submenu-title')).find(
      (el) => el.textContent?.startsWith(label),
    );
  const click = async (el: HTMLElement | undefined | null, what: string) => {
    if (!el) throw new Error(`nothing to click: ${what}`);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  const open = async () => {
    await click(chip(), 'the model control');
    await act(async () => {
      await vi.waitFor(() => expect(row('model:claude-opus-5-5')).toBeDefined(), { timeout: 20_000, interval: 20 });
    });
  };
  const openSub = async (label: string, key: string) => {
    await click(submenu(label), `the ${label} row`);
    await act(async () => {
      await vi.waitFor(() => expect(row(key)).toBeDefined(), { timeout: 20_000, interval: 20 });
    });
  };
  /** Let a mutation that was going to fire, fire. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => DETAIL as never);
    vi.mocked(updateSessionConfig).mockReset();
    vi.mocked(updateSessionConfig).mockResolvedValue({} as never);
    apiMock.mockReset();
    apiMock.mockImplementation((p: string, options?: { method?: string }) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (options?.method === 'PATCH') return reply({});
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/providers') {
        return reply([
          { slug: 'anthropic-2', label: 'orbitd@Claude', runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
          {
            slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', presetSlug: 'deepseek',
            models: [{ label: 'DeepSeek V4 Flash', value: 'deepseek-flash' }],
          },
        ]);
      }
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z' }]);
      }
      if (p.startsWith(`/sessions/${SESSION}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/created-tasks')) return reply({ items: [] });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        return reply(DETAIL);
      }
      if (p.startsWith('/sessions')) return reply([DETAIL]);
      if (p.includes('/owner-confirmation')) return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
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

  it('writes the model and its effort as one control, with the provider and the effort a level down', async () => {
    await mount();
    expect(chip()?.querySelector('.composer-model-name')?.textContent).toBe('Opus 5.5');
    expect(chip()?.querySelector('.composer-model-effort')?.textContent).toBe('Max');
    // The toolbar carries no provider, model or effort Select of its own: Mode is its one Select
    // on a session that already has its workspace.
    expect(mounted().querySelectorAll('.composer-toolbar .ant-select')).toHaveLength(1);
    // …and the toolbar is inside the card, with the text above it.
    const box = mounted().querySelector('.composer-box')!;
    expect(box.lastElementChild?.classList.contains('composer-toolbar')).toBe(true);
    expect(box.querySelector('.composer-field + .composer-toolbar')).not.toBeNull();

    await open();
    expect(submenu('Provider')?.textContent).toBe('Providerorbitd@Claude');
    expect(submenu('Effort')?.textContent).toBe('EffortMax');
    const models = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5'].map((m) => row(`model:${m}`));
    expect(models.map((el) => el?.textContent)).toEqual(['Opus 5.5', 'Opus 5', 'Sonnet 5']);
    // The check marks the model that is running, and only that one.
    expect(models.map((el) => !!el?.querySelector('.scope-menu-check .anticon'))).toEqual([true, false, false]);

    await openSub('Provider', 'provider:deepseek');
    expect(row('provider:anthropic-2')?.querySelector('.scope-menu-check .anticon')).not.toBeNull();
    expect(row('provider:deepseek')?.textContent).toContain('DeepSeek');
  });

  it('asks nothing of the server when the pick is what is already running, and one PATCH when it is not', async () => {
    await mount();

    // Unlike a Select, a menu reports a click on the row already chosen. Re-picking the running
    // model, effort or provider is not a change, and must not reach the server as one — a
    // provider PATCH re-spawns the engine.
    await open();
    await click(row('model:claude-opus-5-5'), 'the running model');
    await settle();
    await open();
    await openSub('Effort', 'effort:max');
    await click(row('effort:max'), 'the running effort');
    await settle();
    await open();
    await openSub('Provider', 'provider:anthropic-2');
    await click(row('provider:anthropic-2'), 'the running provider');
    await settle();
    expect(configCalls()).toHaveLength(0);

    await open();
    await click(row('model:claude-sonnet-5'), 'another model');
    await act(async () => {
      await vi.waitFor(() => expect(configCalls()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    });
    expect(configCalls()[0]).toMatchObject({ model: 'claude-sonnet-5' });

    await open();
    await openSub('Effort', 'effort:high');
    await click(row('effort:high'), 'another effort');
    await act(async () => {
      await vi.waitFor(() => expect(configCalls()).toHaveLength(2), { timeout: 20_000, interval: 20 });
    });
    expect(configCalls()[1]).toEqual({ effort: 'high' });
  });
});
