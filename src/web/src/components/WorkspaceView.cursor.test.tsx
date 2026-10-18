// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A Cursor CLI session's composer (the owner's board, docs/mocks/cursor-engine Web 5 and Web 6): the model
 * menu titled Cursor CLI, Auto with no effort or context to set and a line on why, a model's own efforts,
 * context sizes and fast lane — written into the session's model value — and the chip that names them; a context
 * gauge that is unavailable rather than 0%; a placeholder that says a message written mid-turn waits; and
 * the account rule the server keeps (P6b, D5) — a session that has talked lists its other accounts and
 * keys but can't move to them on a runner that can't carry its conversation, and says why; one that has
 * not talked moves on any runner.
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
    createInteractiveSession: vi.fn(),
    switchSessionAccount: vi.fn(),
    updateSessionConfig: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage, getSessionRetryMessage, listQueuedTurns, updateSessionConfig } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000f1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000f2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000f3');
const TEAM = '5c2e91a0';
const RESETS = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

const RUNNER = {
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  maxConcurrent: 4,
  activeSessions: 0,
  capabilities: ['provider:cursor', 'cursor-account-login/v1', 'cursor-account-remove/v1'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    {
      engine: 'cursor',
      installed: true,
      auth: 'yes',
      version: '2026.10.14-941492e',
      accounts: [
        { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
        { id: TEAM, name: 'Team', home: `/root/.orbit/cursor-accounts/${TEAM}`, auth: 'yes' },
      ],
    },
  ],
  // As the runner reports Cursor CLI's parameterized picker (testdata/cursor/parameterized-model-picker).
  modelCatalog: {
    cursor: [
      { value: 'default', label: 'Auto' },
      {
        value: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningLevel: 'medium',
        parameters: [
          { id: 'context', label: 'Context', category: 'model_config', default: '300k', values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] },
          { id: 'effort', label: 'Effort', category: 'thought_level', default: 'medium', values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })) },
          { id: 'fast', label: 'Fast', category: 'model_config', default: 'false', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }] },
        ],
      },
      {
        value: 'composer-2.5',
        label: 'Composer 2.5',
        parameters: [{ id: 'fast', label: 'Fast', category: 'model_config', default: 'true', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'Fast' }] }],
      },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    ],
    claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', fastMode: true }],
  },
  planUsage: {
    cursor: {
      provider: 'cursor',
      account: 'default',
      planName: 'Free',
      accounts: { [TEAM]: { provider: 'cursor', planName: 'Pro', includedUsage: { resetsAt: RESETS, percentUsed: 34 } } },
    },
  },
} as unknown as Runner;

/** A Cursor key, as GET /providers lists it for the pickers: Cursor CLI alone. */
const CURSOR_KEY = {
  slug: 'cursor-api',
  label: 'Cursor',
  runtime: 'cursor',
  models: [],
  presetSlug: 'cursor-api',
  modelsFromRuntime: true,
  engines: ['cursor'],
};

const session = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title: 'Fix the flaky export test',
  status: 'AWAITING_INPUT',
  engine: 'cursor',
  provider: 'cursor',
  model: 'default',
  permissionMode: 'acceptEdits',
  cursorAccount: 'default',
  workspace: { id: WORKSPACE, cursorAccount: null },
  numTurns: 1,
  runtimeSessionId: '7f3b0c1e-2d4a-4e5f-9a8b-0c1d2e3f4a5b',
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-09-29T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-09-29T01:10:00Z',
  updatedAt: '2026-09-29T01:18:00Z',
  ...over,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a Cursor CLI session’s composer', { timeout: 60_000 }, () => {
  let runner: Runner = RUNNER;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let detail: Record<string, unknown> = session();

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };
  const mount = async (model: RegExp = /Auto|Claude Opus 5.5/) => {
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
            <Routes>
              <Route path="*" element={<WorkspaceView runner={runner} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.composer-box textarea')).not.toBeNull(), { timeout: 20_000, interval: 20 });
      await vi.waitFor(() => expect(vi.mocked(getSession)).toHaveBeenCalled(), { timeout: 20_000, interval: 20 });
    });
    // The detail row — the session's account, its engine — and the providers list land a beat later.
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector('.composer-model-name')?.textContent).toMatch(model), {
        timeout: 20_000,
        interval: 20,
      });
    });
  };
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const render = async (what: () => Element | null) => {
    await act(async () => {
      await vi.waitFor(() => expect(what()).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
  };
  const openModelMenu = async () => {
    if (!document.querySelector('[role="menu"]:not([data-closed])')) await click(mounted().querySelector('button.composer-model-chip'));
    await render(() => document.querySelector('[role="menu"]:not([data-closed])'));
    return document.querySelector<HTMLElement>('[role="menu"]:not([data-closed])')!;
  };
  const providerMenuRows = async () => {
    await openModelMenu();
    const provider = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')].find((el) =>
      el.textContent?.startsWith('Provider'),
    );
    if (!provider) return null;
    await click(provider);
    await render(() => document.querySelector('[role="menu"][data-nested] [role="menuitem"]'));
    return [...document.querySelectorAll<HTMLElement>('[role="menu"][data-nested] [role="menuitem"]')];
  };
  const rowName = (row: HTMLElement): string => {
    const words = row.querySelector('.scope-menu-row')?.cloneNode(true) as HTMLElement | undefined;
    words?.querySelectorAll('.np-mark').forEach((mark) => mark.remove());
    return words?.textContent ?? '';
  };
  const foot = () => document.querySelector('[role="menu"][data-nested] .composer-provider-foot')?.textContent ?? null;
  /** The model menu's own rows, by what each says: its label, then the value it shows on its right. */
  const modelMenuRows = async () => {
    const menu = await openModelMenu();
    return [...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
  };
  /** Opens the row of the model menu that starts with `title`, and returns the rows a level down. */
  const subMenuRows = async (title: string) => {
    await openModelMenu();
    const row = [...document.querySelectorAll<HTMLElement>('.composer-model-menu [role="menuitem"][aria-haspopup="menu"]')].find((el) =>
      el.textContent?.startsWith(title),
    );
    if (!row) return null;
    await click(row);
    await render(() => document.querySelector('[role="menu"][data-nested] [role="menuitem"]'));
    return [...document.querySelectorAll<HTMLElement>('[role="menu"][data-nested] [role="menuitem"]')];
  };
  const checked = (row: HTMLElement) => !!row.querySelector('.scope-menu-check .anticon');
  const configCalls = () => vi.mocked(updateSessionConfig).mock.calls.map(([, cfg]) => cfg);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runner = RUNNER;
    detail = session();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => detail as never);
    apiMock.mockReset();
    apiMock.mockImplementation(((p: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/providers') return reply([CURSOR_KEY]);
      if (p === '/workspaces') {
        return reply([{ id: WORKSPACE, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'cursor', lastEngine: 'cursor' }]);
      }
      if (p.startsWith(`/sessions/${SESSION}`)) {
        if (p.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (p.includes('/diff')) return reply({ files: [] });
        if (p.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        if (p.includes('/turns') || p.includes('/approvals') || p.includes('/background')) return reply([]);
        return reply(detail);
      }
      if (p.startsWith('/sessions')) return reply([detail]);
      if (p.includes('/owner-confirmation')) return reply({ task: null, waiting: null, decisions: [], criteria: [] });
      if (p.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (p.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (p.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    }) as never);
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

  it('titles its model menu Cursor CLI, offers Auto with a line instead of an effort, and no Default effort label', async () => {
    await mount();
    const menu = await openModelMenu();
    expect(menu.querySelector('.composer-engine-title-name')?.textContent).toBe('Cursor CLI');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(['Auto', 'Claude Opus 5.5', 'Composer 2.5']));
    expect(items.some((item) => item?.startsWith('Effort'))).toBe(false);
    expect(items.some((item) => item?.startsWith('Context') || item?.startsWith('Speed'))).toBe(false);
    expect(menu.querySelector('.composer-route-reason')?.textContent).toBe(
      'Auto picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set.',
    );
    expect(mounted().querySelector('.composer-model-chip')?.textContent).toBe('Auto');
    expect(mounted().querySelector('.composer-model-chip .composer-model-effort')).toBeNull();
  });

  it('offers a model’s own efforts on a model that has them', async () => {
    detail = session({ model: 'claude-opus-5-5', effort: 'high' });
    await mount();
    expect(mounted().querySelector('.composer-model-chip')?.textContent).toBe('Claude Opus 5.5High');
    const menu = await openModelMenu();
    const effort = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith('Effort'));
    expect(effort?.textContent).toBe('EffortHigh');
    expect(menu.querySelector('.composer-route-reason')).toBeNull();
  });

  it('reads its context as unavailable, never as 0% or a token count', async () => {
    await mount();
    const gauge = mounted().querySelector<HTMLElement>('.composer-usage[aria-label^="Context"]');
    expect(gauge?.getAttribute('aria-label')).toBe('Context window unavailable');
    expect(gauge?.textContent).toBe('—');
    // The ring is drawn empty and dashed, apart from the solid ring of a reading still to come.
    expect(gauge?.querySelector('.context-ring-track')?.getAttribute('stroke-dasharray')).toBe('2.2 2.2');
    expect(gauge?.querySelector('.context-ring-fill')).toBeNull();
  });

  it('says a message written while a turn runs goes to Cursor CLI once the turn ends', async () => {
    detail = session({ status: 'RUNNING' });
    await mount();
    expect(mounted().querySelector('.composer-box textarea')?.getAttribute('placeholder')).toBe(
      'Reply — it goes to Cursor CLI when this turn ends…',
    );
  });

  it('lists its other accounts and keys, greyed with why, once it has talked on a runner that can’t carry it', async () => {
    await mount();
    const rows = (await providerMenuRows())!;
    expect(rows.map((row) => rowName(row))).toEqual(['AutomaticSwitches to soonest reset', 'Default', 'TeamMonthly 34%', 'Cursor']);
    expect(rows.map((row) => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', 'true']);
    expect(foot()).toBe('Cursor CLI can’t carry a conversation to another account or key yet. Start a new session to use one of these.');
  });

  it('moves as before on a runner that carries a Cursor conversation, and before it has talked on any', async () => {
    runner = { ...RUNNER, capabilities: [...(RUNNER.capabilities ?? []), 'cursor-account-move/v1'] } as Runner;
    await mount();
    let rows = (await providerMenuRows())!;
    expect(rows.map((row) => row.getAttribute('aria-disabled'))).toEqual([null, null, null, null]);
    expect(foot()).toBeNull();

    await act(async () => root?.unmount());
    container?.remove();
    runner = RUNNER;
    detail = session({ numTurns: 0, runtimeSessionId: null });
    await mount();
    rows = (await providerMenuRows())!;
    expect(rows.map((row) => row.getAttribute('aria-disabled'))).toEqual([null, null, null, null]);
    expect(foot()).toBeNull();
  });
  it('Cursor variants: a model with a context size and a fast lane offers Context and Speed under Effort, and the chip names them', async () => {
    detail = session({ model: 'claude-opus-5-5[context=1m,fast=true]', effort: 'high' });
    await mount();
    // The board's chip (Web 5 ⑤): the model, then its effort, context and fast lane.
    const chip = mounted().querySelector('.composer-model-chip');
    expect(chip?.querySelector('.composer-model-name')?.textContent).toBe('Claude Opus 5.5');
    expect(chip?.querySelector('.composer-model-effort')?.textContent).toBe('High · 1M · Fast');
    const rows = await modelMenuRows();
    // Under the models, in the board's order (Web 5 ①): Effort, Context, Speed.
    expect(rows.slice(-3)).toEqual(['EffortHigh', 'Context1M', 'SpeedFast']);
    const menu = document.querySelector<HTMLElement>('[role="menu"]:not([data-closed])')!;
    const opus = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Claude Opus 5.5');
    expect(opus && checked(opus)).toBe(true);
    // Each row offers the values the runner's catalogue lists for the model, by their own names.
    const context = (await subMenuRows('Context'))!;
    expect(context.map((row) => [row.textContent?.trim(), checked(row)])).toEqual([['300K', false], ['1M', true]]);
  });

  it("Cursor variants: picking a context or a speed writes it into the session's model value", async () => {
    vi.mocked(updateSessionConfig).mockReset();
    vi.mocked(updateSessionConfig).mockResolvedValue({} as never);
    detail = session({ model: 'claude-opus-5-5', effort: 'high' });
    await mount();
    expect(mounted().querySelector('.composer-model-chip .composer-model-effort')?.textContent).toBe('High');
    // The model's own 300K and fast lane off are what it shows, and picking them again changes nothing.
    let context = (await subMenuRows('Context'))!;
    expect(context.map((row) => [row.textContent?.trim(), checked(row)])).toEqual([['300K', true], ['1M', false]]);
    await click(context[0]);
    expect(configCalls()).toEqual([]);
    context = (await subMenuRows('Context'))!;
    await click(context.find((row) => row.textContent?.trim() === '1M'));
    expect(configCalls()).toEqual([{ model: 'claude-opus-5-5[context=1m]' }]);

    vi.mocked(updateSessionConfig).mockClear();
    await act(async () => root?.unmount());
    container?.remove();
    detail = session({ model: 'claude-opus-5-5[context=1m]', effort: 'high' });
    await mount();
    expect(mounted().querySelector('.composer-model-chip .composer-model-effort')?.textContent).toBe('High · 1M');
    const speed = (await subMenuRows('Speed'))!;
    expect(speed.map((row) => [row.textContent?.trim(), checked(row)])).toEqual([['Standard', true], ['Fast', false]]);
    await click(speed.find((row) => row.textContent?.trim() === 'Fast'));
    expect(configCalls()).toEqual([{ model: 'claude-opus-5-5[context=1m,fast=true]' }]);
    // Back at the model's own default, a setting leaves the model value: the runner sets the default.
    vi.mocked(updateSessionConfig).mockClear();
    await act(async () => root?.unmount());
    container?.remove();
    detail = session({ model: 'claude-opus-5-5[context=1m,fast=true]', effort: 'high' });
    await mount();
    context = (await subMenuRows('Context'))!;
    await click(context.find((row) => row.textContent?.trim() === '300K'));
    expect(configCalls()).toEqual([{ model: 'claude-opus-5-5[fast=true]' }]);
    await click((await subMenuRows('Speed'))!.find((row) => row.textContent?.trim() === 'Standard'));
    expect(configCalls()).toEqual([{ model: 'claude-opus-5-5[fast=true]' }, { model: 'claude-opus-5-5[context=1m]' }]);
    // Another model starts on its own settings: its bare name.
    vi.mocked(updateSessionConfig).mockClear();
    await openModelMenu();
    const composer = [...document.querySelectorAll<HTMLElement>('.composer-model-menu [role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Composer 2.5',
    );
    await click(composer);
    expect(configCalls()).toEqual([expect.objectContaining({ model: 'composer-2.5' })]);
  });

  it('Cursor variants: a model shows only the rows its catalogue lists, and Fast only while it is on', async () => {
    // Composer 2.5 has a fast lane, on by default, and no context sizes.
    detail = session({ model: 'composer-2.5' });
    await mount(/Composer 2.5/);
    expect(mounted().querySelector('.composer-model-chip .composer-model-effort')?.textContent).toBe('Default · Fast');
    let rows = await modelMenuRows();
    expect(rows.some((row) => row.startsWith('Context'))).toBe(false);
    expect(rows.at(-1)).toBe('SpeedFast');

    await act(async () => root?.unmount());
    container?.remove();
    detail = session({ model: 'composer-2.5[fast=false]' });
    await mount(/Composer 2.5/);
    expect(mounted().querySelector('.composer-model-chip .composer-model-effort')?.textContent).toBe('Default');
    expect((await modelMenuRows()).at(-1)).toBe('SpeedStandard');

    // A model with neither offers neither; a value the model does not offer shows what it runs on.
    await act(async () => root?.unmount());
    container?.remove();
    detail = session({ model: 'gemini-3.1-pro[context=1m,fast=true]' });
    await mount(/Gemini 3.1 Pro/);
    expect(mounted().querySelector('.composer-model-chip')?.textContent).toBe('Gemini 3.1 ProDefault');
    rows = await modelMenuRows();
    expect(rows.some((row) => row.startsWith('Context') || row.startsWith('Speed'))).toBe(false);
  });

  it('Cursor variants: another engine keeps its own Speed row and menu, with no Context row', async () => {
    detail = session({ engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', fastMode: true, cursorAccount: null });
    await mount(/Opus 5.5/);
    const chip = mounted().querySelector('.composer-model-chip');
    expect(chip?.querySelector('.composer-model-name')?.textContent).toBe('Opus 5.5');
    expect(chip?.querySelector('.composer-model-effort')?.textContent).toBe('High · Fast');
    const rows = await modelMenuRows();
    expect(rows.some((row) => row.startsWith('Context'))).toBe(false);
    expect(rows.at(-1)).toBe('SpeedFast');
    // The engine's fast mode, Standard or Fast, as it always was.
    const speed = (await subMenuRows('Speed'))!;
    expect(speed.map((row) => [row.textContent?.trim(), checked(row)])).toEqual([['Standard', false], ['Fast', true]]);
  });
});
