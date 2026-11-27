// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { EngineRows } from './RunnerEngines.test-rows';
import { clickRunnerMenuItem, dialogDescription, dialogName, openAccountGroups, openDialog, openRunnerMenu } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Sign out… on Default's More menu (docs/default-sign-out-design.md): shown for Default alone, while it
 * is signed in and the runner declares `<engine>-default-sign-out/v1`; asked first; relayed to the
 * runner, whose refusal for running sessions asks again and resends with `force`.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' };
const WORK: RunnerEngineAccount = { id: '3fa91c2e', name: 'Work', home: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes' };

const health = (engine: 'claude' | 'codex', accounts: RunnerEngineAccount[]): RunnerEngineHealth => ({
  engine,
  installed: true,
  auth: 'yes',
  version: '1.0.0',
  accounts,
});

const runner = (accounts: RunnerEngineAccount[], over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  capabilities: ['codex-default-sign-out/v1'],
  engines: [health('codex', accounts)],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

/** `runners` is what GET /runners answers; a test swaps it to play the runner's report coming in. */
function mount(runners: Runner[], post: () => unknown = () => ({ engine: 'codex', account: 'default', status: 'pending', message: null })) {
  const state = { runners };
  openAccountGroups(runners);
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return state.runners;
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    if (options?.method === 'POST' && path.endsWith('/default/sign-out')) return post();
    return {};
  });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], state.runners);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/providers']}>
        <QueryClientProvider client={qc}>
          <EngineRows />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return { page: host, state };
}

const signOuts = () =>
  apiMock.mock.calls.filter(([path, options]) => options?.method === 'POST' && String(path).endsWith('/default/sign-out'));
const labels = async (row: ParentNode) =>
  [...(await openRunnerMenu(row)).querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
const press = async (dialog: HTMLElement, label: string) => {
  const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  await act(async () => button.click());
};
const engineRow = (page: ParentNode) => page.querySelector<HTMLElement>('.re-row[data-engine="codex"]')!;
const accountRows = (page: ParentNode) => [...page.querySelectorAll<HTMLElement>('.re-acct')];

describe('Sign out… on Default’s More menu', () => {
  it('is on the lone engine row’s menu when Default is signed in and the runner declares it', async () => {
    const { page } = mount([runner([DEFAULT])]);
    expect(await labels(engineRow(page))).toContain('Sign out…');
  });

  it('is on a group’s Default row and not on an added account’s', async () => {
    const { page } = mount([runner([DEFAULT, WORK])]);
    const [defaultRow, workRow] = accountRows(page);
    expect(await labels(defaultRow)).toContain('Sign out…');
    expect(await labels(workRow)).not.toContain('Sign out…');
  });

  it('is absent when the runner does not declare it', async () => {
    const { page } = mount([runner([DEFAULT], { capabilities: [] })]);
    expect(await labels(engineRow(page))).not.toContain('Sign out…');
  });

  it('is absent once Default is signed out', async () => {
    const out = { ...DEFAULT, auth: 'no' as const };
    const { page } = mount([runner([out], { engines: [{ ...health('codex', [out]), auth: 'no' }] })]);
    // A signed-out lone row has nothing to offer in More, Sign out… included.
    expect(engineRow(page).querySelector('button[aria-label="More actions"]')).toBeNull();
  });

  it('is disabled while the machine is offline', async () => {
    const { page } = mount([runner([DEFAULT, WORK], { online: false })]);
    const menu = await openRunnerMenu(accountRows(page)[0]);
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === 'Sign out…');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('signing Default out', () => {
  it('asks first, naming the machine and what stays, then posts the route on Sign out', async () => {
    const { page } = mount([runner([DEFAULT, WORK])]);
    await clickRunnerMenuItem(accountRows(page)[0], 'Sign out…');
    const dialog = await openDialog('Sign out of Default?');
    expect(dialogName(dialog)).toBe('Sign out of Default?');
    expect(dialogDescription(dialog)).toBe(
      'Its login is deleted from wikova. Its history and settings stay. codex in a terminal on wikova is signed out too.',
    );
    expect(signOuts()).toEqual([]);
    await press(dialog, 'Sign out');
    expect(signOuts().map(([path, options]) => [path, options?.body])).toEqual([
      [`/runners/${RUNNER_ID}/accounts/codex/default/sign-out`, { force: false }],
    ]);
  });

  it('says nothing about a terminal CLI for an engine that has none sharing the login', async () => {
    const { page } = mount([runner([DEFAULT], { capabilities: ['kimi-default-sign-out/v1'], engines: [{ engine: 'kimi', installed: true, auth: 'yes', accounts: [DEFAULT] } as RunnerEngineHealth] })]);
    await clickRunnerMenuItem(page.querySelector<HTMLElement>('.re-row[data-engine="kimi"]')!, 'Sign out…');
    const dialog = await openDialog('Sign out of Default?');
    expect(dialogDescription(dialog)).toBe('Its login is deleted from wikova. Its history and settings stay.');
  });

  it('shows the row signing out while the runner works on it', async () => {
    const pending = runner([DEFAULT, WORK], { accountRemove: { engine: 'codex', account: 'default', status: 'pending', message: null } });
    const { page } = mount([pending]);
    expect(accountRows(page)[0].querySelector('.re-status')?.textContent).toContain('Signing out…');
    const menu = await openRunnerMenu(accountRows(page)[0]);
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === 'Sign out…');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
  });

  it('asks again when sessions are running, and the second Sign out resends with force', async () => {
    const { page, state } = mount([runner([DEFAULT, WORK])]);
    await clickRunnerMenuItem(accountRows(page)[0], 'Sign out…');
    await press(await openDialog('Sign out of Default?'), 'Sign out');
    expect(signOuts()).toHaveLength(1);

    // The runner refuses, naming two sessions; the next read of the runners carries it.
    state.runners = [runner([DEFAULT, WORK], {
      accountRemove: {
        engine: 'codex', account: 'default', status: 'failed', message: 'Sessions are running',
        sessions: [{ id: 's1', title: 'One', status: 'RUNNING' }, { id: 's2', title: 'Two', status: 'RUNNING' }],
      },
    })];
    await act(async () => { await qc.invalidateQueries({ queryKey: ['runners'] }); });

    await vi.waitFor(() => expect(document.body.textContent).toContain('2 sessions are running on Default'), { timeout: 20_000 });
    const again = await openDialog('2 sessions are running on Default. Sign out anyway?');
    expect(dialogDescription(again)).toBe('They will stop working until you sign in again.');
    // The removal's own "can't be removed" panel is not drawn for a sign-out's refusal.
    expect(accountRows(page)[0].querySelector('.re-panel.bad')).toBeNull();
    await press(again, 'Sign out');
    expect(signOuts().map(([, options]) => options?.body)).toEqual([{ force: false }, { force: true }]);
  });

  it('toasts a failure that names no sessions', async () => {
    const { page } = mount([runner([DEFAULT, WORK])], () => { throw new Error('wikova is offline. Sign out once it is back.'); });
    await clickRunnerMenuItem(accountRows(page)[0], 'Sign out…');
    await press(await openDialog('Sign out of Default?'), 'Sign out');
    await vi.waitFor(() => expect(document.body.textContent).toContain('wikova is offline. Sign out once it is back.'));
    expect(signOuts()).toHaveLength(1);
  });
});
