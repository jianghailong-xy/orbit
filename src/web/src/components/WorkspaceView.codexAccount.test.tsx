// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A runner with two Codex accounts signed in. The New Session hero lists them under Codex, each with
 * its own quota; the one picked travels with the new session (`codexAccount`), and the composer's
 * quota gauge is that account's, and its popover names it — on a draft and on a session started on it.
 * Without a pick nothing travels, and the session runs on its workspace's account, as it always did. A
 * Claude session runs on its workspace's Claude account, and its gauge is that account's too.
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
    // Its POST goes through the module's own `api`, which the mock above cannot reach.
    createInteractiveSession: vi.fn(),
    // So does the account PATCH.
    switchSessionAccount: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const {
  api,
  createInteractiveSession,
  getSession,
  getSessionEventPage,
  getSessionRetryMessage,
  listQueuedTurns,
  switchSessionAccount,
} = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000e1';
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000e2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000e3');
const CREATED = encodeId('0195c0de-0000-7000-8000-0000000000e4');
const WORK = '3fa91c2e';
const WORK_HOME = '/root/.orbit/codex-accounts/3fa91c2e';
const RESETS = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

/** Default's 5-hour window is spent; Work reports a weekly window with room. */
const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 4,
  activeSessions: 0,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    {
      engine: 'codex',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
        { id: WORK, name: 'Work', home: WORK_HOME, codexHome: WORK_HOME, auth: 'yes' },
      ],
    },
  ],
  modelCatalog: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
  runtimeDefaultModels: { codex: 'gpt-5.5' },
  planUsage: {
    codex: {
      provider: 'codex',
      primary: { utilization: 100, windowDurationMins: 300, resetsAt: RESETS },
      accounts: {
        [WORK]: { provider: 'codex', primary: { utilization: 0, windowDurationMins: 10080, resetsAt: RESETS } },
      },
    },
  },
} as unknown as Runner;

const session = (codexAccount: string | null, workspaceAccount: string | null) => ({
  id: SESSION,
  workspaceId: WORKSPACE,
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title: 'on codex',
  status: 'AWAITING_INPUT',
  provider: 'codex',
  model: 'gpt-5.5',
  codexAccount,
  workspace: { id: WORKSPACE, codexAccount: workspaceAccount },
  numTurns: 1,
  retryAt: null,
  retryAttempts: 0,
  startedAt: '2026-09-29T01:10:05Z',
  capabilities: { canSend: true, canResume: true },
  createdAt: '2026-09-29T01:10:00Z',
  updatedAt: '2026-09-29T01:18:00Z',
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the runner account a session runs on', { timeout: 60_000 }, () => {
  let runner: Runner = RUNNER;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;
  let detail: Record<string, unknown> = session(null, null);
  let workspaceAccount: string | null = null;
  let creates: Array<Record<string, unknown>> = [];

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  const mount = async (entry: string, ready: string): Promise<void> => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    root = createRoot(container);
    document.body.appendChild(container);
    const nextClient = client;
    const nextRoot = root;
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[entry]}>
            <AntApp>
              <Routes>
                <Route path="*" element={<WorkspaceView runner={runner} />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelector(ready)).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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
  // The plan gauge, not the context ring beside it (which shares the pill class).
  const usage = () => mounted().querySelector<HTMLElement>('button.composer-usage[aria-label^="Plan usage"]');
  /** The open list's account rows (portaled out of the mount), as "name quota". */
  const accountRows = () =>
    [...document.querySelectorAll<HTMLElement>('.np-account')].map((row) =>
      [...row.querySelectorAll('.np-row-name, .np-row-model')].map((part) => part.textContent).join(' '),
    );
  const pickedRow = () => document.querySelector<HTMLElement>('.np-account.picked .np-row-name')?.textContent;
  /** Which Codex account the quota gauge's popover names (portaled out of the mount), and the note
   *  under it: opened by a press, as on a phone. */
  const gaugeAccount = async () => {
    if (!document.querySelector('.ant-popover:not(.ant-popover-hidden) .cu-pop')) await click(usage());
    return {
      name: document.querySelector('.cu-account-name')?.textContent ?? null,
      note: document.querySelector('.cu-account .cu-reset')?.textContent ?? null,
    };
  };
  /** Named in the composer's own row it crowds the model out on a phone: it lives in the popover. */
  const composerRowNamesNoAccount = () =>
    expect(mounted().querySelector('.composer-toolbar .composer-account')).toBeNull();

  const sendMessage = async (text: string) => {
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(mounted().querySelector('button[aria-label="Send"]'));
    await act(async () => {
      await vi.waitFor(() => expect(creates).toHaveLength(1), { timeout: 20_000, interval: 20 });
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    detail = session(null, null);
    workspaceAccount = null;
    runner = RUNNER;
    creates = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
    vi.mocked(listQueuedTurns).mockImplementation(async () => []);
    vi.mocked(getSession).mockReset();
    vi.mocked(getSession).mockImplementation(async () => detail as never);
    vi.mocked(createInteractiveSession).mockReset();
    vi.mocked(createInteractiveSession).mockImplementation(async (body) => {
      creates.push(body as Record<string, unknown>);
      return { id: CREATED };
    });
    apiMock.mockReset();
    apiMock.mockImplementation(((p: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (p === '/users/me') {
        return reply({ id: 'user-1', email: 'r@example.com', name: 'R', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (p === '/workspaces') {
        return reply([
          {
            id: WORKSPACE,
            name: 'orbit',
            runnerId: RUNNER_ID,
            createdAt: '2026-01-01T00:00:00Z',
            lastProvider: 'codex',
            codexAccount: workspaceAccount,
          },
        ]);
      }
      if (p.startsWith(`/sessions/${SESSION}`) || p.startsWith(`/sessions/${CREATED}`)) {
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

  const accountNamed = (name: string) =>
    [...document.querySelectorAll('.np-account')].find((row) => row.querySelector('.np-row-name')?.textContent === name);

  it('with no account picked, a new session starts on the one with the most room, and says which', async () => {
    await mount(`/workspaces/${WORKSPACE}/new`, '.np-card');
    // Default's 5-hour window is spent, so Automatic would start it on Work, whose quota the gauge shows.
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 0%');
    expect(await gaugeAccount()).toEqual({ name: 'Work', note: 'Automatic — the account with the most room right now' });
    composerRowNamesNoAccount();

    await click(mounted().querySelector('.np-card'));
    expect(accountRows()).toEqual(['Automatic most room', 'Default 5h 100%', 'Work Weekly 0%']);
    expect(pickedRow()).toBe('Automatic');
    await click(mounted().querySelector('.np-card'));

    await sendMessage('fix the flaky test');
    // Nothing is sent: the server makes the same choice when it creates the session, and stores it.
    expect(creates[0]).toMatchObject({ prompt: 'fix the flaky test' });
    expect('codexAccount' in creates[0]).toBe(false);
    // The provider was not changed, so it is not sent: the server starts where the project last ran.
    expect(creates[0].provider).toBeUndefined();
  });

  it('starts the new session on an account picked under Codex, and Automatic takes the pick back', async () => {
    await mount(`/workspaces/${WORKSPACE}/new`, '.np-card');
    await click(mounted().querySelector('.np-card'));
    await click(accountNamed('Default'));
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 100%');
    // Picked, so no note: it starts where the pick says.
    expect(await gaugeAccount()).toEqual({ name: 'Default', note: null });

    await click(mounted().querySelector('.np-card'));
    expect(pickedRow()).toBe('Default');
    await click(accountNamed('Automatic'));
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 0%');

    await click(mounted().querySelector('.np-card'));
    await click(accountNamed('Default'));
    await sendMessage('fix the flaky test');
    expect(creates[0]).toMatchObject({ prompt: 'fix the flaky test', codexAccount: 'default' });
  });

  it("on a workspace that picked an account, offers no Automatic, starts there, and sends nothing", async () => {
    workspaceAccount = WORK;
    await mount(`/workspaces/${WORKSPACE}/new`, '.np-card');
    expect(usage()?.getAttribute('aria-label')).toBe('Plan usage 0%');
    await click(mounted().querySelector('.np-card'));
    expect(accountRows()).toEqual(['Default 5h 100%', 'Work Weekly 0%']);
    expect(pickedRow()).toBe('Work');
    await click(mounted().querySelector('.np-card'));

    await sendMessage('hello');
    expect('codexAccount' in creates[0]).toBe(false);
  });

  /** The gauge once the session's detail row — which says its account — is in. */
  const settlesOn = async (label: string) => {
    await act(async () => {
      await vi.waitFor(() => expect(vi.mocked(getSession)).toHaveBeenCalled(), { timeout: 20_000, interval: 20 });
      await vi.waitFor(() => expect(usage()?.getAttribute('aria-label')).toBe(label), { timeout: 20_000, interval: 20 });
    });
  };

  it("shows the quota of the account a session was started on, over its workspace's", async () => {
    detail = session(WORK, null);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 0%');
    // Named in the gauge's popover, so whose quota it is can be read off the session.
    expect(await gaugeAccount()).toEqual({ name: 'Work', note: null });
    composerRowNamesNoAccount();
  });

  it('a session that picked Default shows Default’s quota on a workspace set to another account', async () => {
    detail = session('default', WORK);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 100%');
    expect(await gaugeAccount()).toEqual({ name: 'Default', note: null });
  });

  it("a session with no pick of its own shows its workspace's account's quota", async () => {
    detail = session(null, WORK);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 0%');
  });

  it("a Claude session shows the quota of its workspace's Claude account", async () => {
    const claudeWork = { id: WORK, name: 'Work', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' };
    runner = {
      ...RUNNER,
      engines: [
        { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }, claudeWork] },
      ],
      planUsage: {
        claude: {
          provider: 'claude',
          fiveHour: { utilization: 100, resetsAt: RESETS },
          accounts: { [WORK]: { provider: 'claude', fiveHour: { utilization: 30, resetsAt: RESETS } } },
        },
      },
    } as unknown as Runner;
    detail = {
      ...session(null, null),
      provider: 'claude',
      model: 'claude-opus-5',
      workspace: { id: WORKSPACE, codexAccount: null, claudeAccount: WORK },
    };
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 30%');
    // Named for Claude as for Codex; its workspace picked it, so there is nothing automatic to say.
    expect(await gaugeAccount()).toEqual({ name: 'Work', note: null });
  });

  it('starts a new Claude session on the Claude account picked under Claude', async () => {
    const claudeWork = { id: WORK, name: 'Work', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' };
    runner = {
      ...RUNNER,
      engines: [
        { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }, claudeWork] },
        ...(RUNNER.engines ?? []).filter((engine) => engine.engine !== 'claude'),
      ],
    } as unknown as Runner;
    await mount(`/workspaces/${WORKSPACE}/new`, '.np-card');
    await click(mounted().querySelector('.np-card'));
    const claudeWorkRow = [...document.querySelectorAll('.np-account')].filter(
      (row) => row.querySelector('.np-row-name')?.textContent === 'Work',
    )[0];
    await click(claudeWorkRow);
    await sendMessage('fix the flaky test');
    expect(creates[0]).toMatchObject({ provider: 'claude', claudeAccount: WORK });
    expect('codexAccount' in creates[0]).toBe(false);
  });

  /** The composer's model menu, opened, with its Provider submenu open: that submenu's rows. */
  const providerMenuRows = async () => {
    await click(mounted().querySelector('button.composer-model-chip'));
    const provider = [...document.querySelectorAll<HTMLElement>('.ant-dropdown-menu-submenu-title')].find((el) =>
      el.textContent?.startsWith('Provider'),
    );
    if (!provider) return null;
    await click(provider);
    return [...document.querySelectorAll<HTMLElement>('.ant-dropdown-menu-submenu-popup .ant-dropdown-menu-item')];
  };
  /** A row as it reads: its text, and ✓ where it is ticked. */
  const rowText = (row: HTMLElement) =>
    `${row.querySelector('.scope-menu-row')?.textContent ?? ''}${row.querySelector('.scope-menu-check svg') ? ' ✓' : ''}`;

  it('a live Codex session moves to another account from the Provider menu, and back onto Automatic', async () => {
    runner = { ...RUNNER, capabilities: ['codex-account-move/v1'] } as unknown as Runner;
    detail = { ...session('default', null), codexAccountPinned: false };
    vi.mocked(switchSessionAccount).mockResolvedValue({ ok: true } as never);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 100%');
    const rows = (await providerMenuRows())!;
    // Nothing picked it by hand, so the tick is on Automatic, not on the account it happens to be on.
    expect(rows.map(rowText)).toEqual(['Codex', 'AutomaticMost room ✓', 'Default5h 100%', 'WorkWeekly 0%']);
    await click(rows.find((row) => row.textContent?.startsWith('Work')));
    expect(vi.mocked(switchSessionAccount)).toHaveBeenCalledWith(SESSION, WORK);
  });

  it('a session pinned to an account is ticked there, and Automatic puts it back', async () => {
    runner = { ...RUNNER, capabilities: ['codex-account-move/v1'] } as unknown as Runner;
    detail = { ...session(WORK, null), codexAccountPinned: true };
    vi.mocked(switchSessionAccount).mockResolvedValue({ ok: true } as never);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 0%');
    const rows = (await providerMenuRows())!;
    expect(rows.map(rowText)).toEqual(['Codex', 'AutomaticMost room', 'Default5h 100%', 'WorkWeekly 0% ✓']);
    await click(rows.find((row) => row.textContent?.startsWith('Automatic')));
    expect(vi.mocked(switchSessionAccount)).toHaveBeenCalledWith(SESSION, 'automatic');
  });

  it('offers no account in the menu on a runner that cannot carry a conversation to another one', async () => {
    detail = session('default', null);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    await settlesOn('Plan usage 100%');
    // Codex alone, and no account to move to: there is no Provider row to open at all.
    expect(await providerMenuRows()).toBeNull();
  });

  it("a live Claude session lists its runner's Claude accounts under Claude", async () => {
    const claudeWork = { id: WORK, name: 'Work', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' };
    runner = {
      ...RUNNER,
      capabilities: ['claude-account-move/v1'],
      engines: [
        { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }, claudeWork] },
      ],
      planUsage: {
        claude: {
          provider: 'claude',
          fiveHour: { utilization: 0, resetsAt: RESETS },
          sevenDay: { utilization: 100, resetsAt: RESETS },
          accounts: { [WORK]: { provider: 'claude', fiveHour: { utilization: 30, resetsAt: RESETS } } },
        },
      },
    } as unknown as Runner;
    detail = {
      ...session(null, null),
      provider: 'claude',
      model: 'claude-opus-5',
      claudeAccount: 'default',
      claudeAccountPinned: true,
      workspace: { id: WORKSPACE, codexAccount: null, claudeAccount: null },
    };
    vi.mocked(switchSessionAccount).mockResolvedValue({ ok: true } as never);
    await mount(`/sessions/${SESSION}`, '.composer-box textarea');
    // The gauge reads the first window, the 5-hour one.
    await settlesOn('Plan usage 0%');
    const rows = (await providerMenuRows())!;
    // The row reads the window that stops it: Default's weekly one, though its 5-hour one reads 0%.
    expect(rows.map(rowText)).toEqual(['Claude', 'AutomaticMost room', 'DefaultWeekly 100% ✓', 'Work5h 30%']);
    await click(rows.find((row) => row.textContent?.startsWith('Work')));
    expect(vi.mocked(switchSessionAccount)).toHaveBeenCalledWith(SESSION, WORK);
  });
});
