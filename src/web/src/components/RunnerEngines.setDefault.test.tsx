// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerClaudeAccountSwapState, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { EngineRows } from './RunnerEngines.test-rows';
import { dialogDescription, dialogName, openAccountGroups, openDialog, openRunnerMenu } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';
import { hoverTooltip } from '../test/tooltipHover';

/**
 * Set as default on a runner's Claude Code accounts: an added account's ⋯ menu offers it, a
 * confirmation says what the swap does, a line under the account says what it waits on, and a swap
 * that failed says so the way a refused removal does. Once it is done, the runner reports the two
 * accounts in each other's folders and the list draws that: the DEFAULT chip on the account chosen.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../lib/toast', async (original) => ({ ...(await original<typeof import('../lib/toast')>()), useToast: () => toast }));
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): links encode it, and a placeholder would fail the render.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const SWAP_CAPABILITIES = ['claude-account-swap/v1', 'claude-account-move/v1'];

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.claude', auth: 'yes' };
const WORK: RunnerEngineAccount = { id: '3fa91c2e', name: 'Work', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' };

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({ engine: 'claude', installed: true, auth: 'yes', ...over });

const runner = (accounts: RunnerEngineAccount[], over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  capabilities: SWAP_CAPABILITIES,
  engines: [health({ engine: 'claude', version: '2.0.44', accounts }), health({ engine: 'codex', version: '0.156.0' })],
  ...over,
});

const swap = (over: Partial<RunnerClaudeAccountSwapState>): RunnerClaudeAccountSwapState => ({
  account: WORK.id,
  status: 'pending',
  message: null,
  waitingOn: [],
  foreignProcesses: [],
  ...over,
});
const session = (id: string) => ({ id, title: `Session ${id}`, status: 'RUNNING' as const });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient | null = null;

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
  root = host = qc = null;
  apiMock.mockReset();
  toast.error.mockReset();
  localStorage.clear();
});

/** These runners' engine rows. `answer` is what the set-default request gets; `/runners` reads `list()`. */
function mount(initial: Runner[], answer: () => Promise<unknown> = async () => swap({}), list: () => Runner[] = () => initial) {
  openAccountGroups(initial);
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return list();
    if (path.endsWith('/set-default')) return answer();
    if (path.endsWith('/login')) return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    return {};
  });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], initial);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/providers']}>
        <QueryClientProvider client={qc!}>
          <EngineRows />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const claudeRows = (page: ParentNode) => [...page.querySelectorAll<HTMLElement>('.re-acct')];
const setDefaults = () => apiMock.mock.calls.filter(([path]) => String(path).endsWith('/set-default'));

/** The Set as default item in this row's menu, or undefined when the menu has none. */
async function setDefaultItem(row: HTMLElement): Promise<HTMLElement | undefined> {
  const menu = await openRunnerMenu(row);
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.querySelector('.re-menu-label')?.firstElementChild?.textContent === 'Set as default',
  );
}
const hintOf = (item: HTMLElement) => item.querySelector('.re-menu-hint')?.textContent;

describe('Set as default in an account’s menu', () => {
  it('is offered on an added Claude Code account, saying what it does, and not on Default’s own', async () => {
    const page = mount([runner([DEFAULT, WORK])]);
    const [defaultRow, workRow] = claudeRows(page);

    const item = await setDefaultItem(workRow);
    expect(item).toBeDefined();
    expect(item!.getAttribute('aria-disabled')).not.toBe('true');
    expect(hintOf(item!)).toBe('Moves this login into ~/.claude, so the terminal uses it too');

    expect(await setDefaultItem(defaultRow)).toBeUndefined();
  });

  it('is not offered on another engine’s accounts', async () => {
    const codexDefault: RunnerEngineAccount = { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' };
    const codexWork: RunnerEngineAccount = { id: '7c21de40', name: 'Personal', home: '/root/.orbit/codex-accounts/7c21de40', auth: 'yes' };
    const page = mount([
      runner([DEFAULT], {
        engines: [health({ engine: 'claude', version: '2.0.44' }), health({ engine: 'codex', version: '0.156.0', accounts: [codexDefault, codexWork] })],
      }),
    ]);
    const [, personalRow] = claudeRows(page);
    expect(await setDefaultItem(personalRow)).toBeUndefined();
  });

  it.each([
    ['offline', { online: false }, 'The runner is offline'],
    ['too old to swap logins', { capabilities: ['claude-account-move/v1'] }, 'Update the runner to set a default Claude Code account on it'],
    ['already swapping', { claudeAccountSwap: swap({ account: 'aa11bb22' }) }, 'A default is already being set on this runner'],
  ] as const)('is disabled with its reason on a runner that is %s', async (_, over, reason) => {
    const page = mount([runner([DEFAULT, WORK], over as Partial<Runner>)]);
    const [, workRow] = claudeRows(page);
    const item = (await setDefaultItem(workRow))!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(hintOf(item)).toBe(reason);
    // The reason is the app's tip beside the menu, not the browser's title (docs/mocks/web-tooltips-c, Q4).
    expect(item.hasAttribute('title')).toBe(false);
    expect(await hoverTooltip(item, 200)).toBe(reason);
  });
});

describe('its confirmation', () => {
  it('names the swap, the terminal, the sessions and the workspaces, and sends nothing until confirmed', async () => {
    const page = mount([runner([DEFAULT, WORK])]);
    const [, workRow] = claudeRows(page);
    const item = (await setDefaultItem(workRow))!;
    await act(async () => item.click());

    const dialog = await openDialog('Make Work the default?');
    expect(dialogName(dialog)).toBe('Make Work the default?');
    expect(dialogDescription(dialog)).toBe(
      'Work’s login moves to ~/.claude, and Default’s to ~/.orbit/claude-accounts/3fa91c2e. Claude Code in a ' +
        'terminal on wikova uses Work from then on — restart any that are open. Sessions stay on their accounts, ' +
        'and a turn in progress finishes first. Workspaces keep their account.',
    );
    expect(setDefaults()).toEqual([]);

    const ok = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Make default')!;
    await act(async () => ok.click());
    expect(setDefaults().map(([path, options]) => [path, (options as { method?: string }).method])).toEqual([
      [`/runners/${RUNNER_ID}/accounts/claude/${WORK.id}/set-default`, 'POST'],
    ]);
  });

  it('names a renamed Default by its name', async () => {
    const page = mount([runner([{ ...DEFAULT, name: 'Personal' }, WORK])]);
    const [, workRow] = claudeRows(page);
    await act(async () => (await setDefaultItem(workRow))!.click());
    const dialog = await openDialog('Make Work the default?');
    expect(dialogDescription(dialog)).toContain('and Personal’s to ~/.orbit/claude-accounts/3fa91c2e.');
  });
});

describe('while the swap waits', () => {
  it.each([
    [[], 'Making Work the default'],
    [[session('a')], 'Making Work the default — waiting for 1 session to finish its turn'],
    [[session('a'), session('b'), session('c')], 'Making Work the default — waiting for 3 sessions to finish their turns'],
  ])('says under the account what it waits on (%#)', (waitingOn, line) => {
    const page = mount([runner([DEFAULT, WORK], { claudeAccountSwap: swap({ waitingOn }) })]);
    const [defaultRow, workRow] = claudeRows(page);
    expect(workRow.querySelector('.re-swapping')?.textContent).toBe(line);
    expect(defaultRow.querySelector('.re-swapping')).toBeNull();
    expect(workRow.querySelector('.re-panel.bad')).toBeNull();
  });

  it('says it waits for Claude Code in a terminal too', () => {
    const page = mount([runner([DEFAULT, WORK], { claudeAccountSwap: swap({ foreignProcesses: [{ pid: 4242, command: 'claude' }] }) })]);
    const [, workRow] = claudeRows(page);
    expect(workRow.querySelector('.re-swapping')?.textContent).toBe(
      'Making Work the default It also waits for Claude Code running in a terminal there to exit.',
    );
  });

  it('draws the line once the control plane answers pending', async () => {
    let swapped = false;
    const before = runner([DEFAULT, WORK]);
    const page = mount([before], async () => { swapped = true; return swap({}); }, () =>
      [swapped ? runner([DEFAULT, WORK], { claudeAccountSwap: swap({ waitingOn: [session('a'), session('b')] }) }) : before]);
    const [, workRow] = claudeRows(page);
    await act(async () => (await setDefaultItem(workRow))!.click());
    const dialog = await openDialog('Make Work the default?');
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Make default')!.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(claudeRows(page)[1].querySelector('.re-swapping')?.textContent).toBe(
          'Making Work the default — waiting for 2 sessions to finish their turns',
        ),
      );
    });
  });
});

describe('what a swap comes to', () => {
  it('says a failed swap failed, why, and that both logins are as they were', () => {
    const page = mount([
      runner([DEFAULT, WORK], { claudeAccountSwap: swap({ status: 'failed', message: 'Its sessions did not finish their turns in time.' }) }),
    ]);
    const [, workRow] = claudeRows(page);
    const panel = workRow.querySelector('.re-panel.bad.re-swap-failed');
    expect([...panel!.querySelectorAll('.re-panel-row')].map((row) => row.textContent)).toEqual([
      'Couldn’t make Work the default',
      'Its sessions did not finish their turns in time.',
    ]);
    expect(panel!.querySelector('.re-panel-hint')?.textContent).toBe('Both logins are as they were.');
    expect(workRow.querySelector('.re-swapping')).toBeNull();
  });

  it('closes a failed swap with its ✕: the runner forgets it, and the panel goes', async () => {
    let dismissed = false;
    const failed = runner([DEFAULT, WORK], { claudeAccountSwap: swap({ status: 'failed', message: 'No claudeAiOauth entry' }) });
    const page = mount([failed], async () => { dismissed = true; return { ok: true }; }, () => [dismissed ? runner([DEFAULT, WORK]) : failed]);
    const close = claudeRows(page)[1].querySelector<HTMLButtonElement>('.re-swap-failed button[aria-label="Dismiss"]');
    expect(close?.textContent).toBe('✕');
    await act(async () => close!.click());
    const [path, options] = setDefaults()[0];
    expect(path).toBe(`/runners/${failed.id}/accounts/claude/${WORK.id}/set-default`);
    expect(options).toEqual({ method: 'DELETE' });
    await act(async () => {
      await vi.waitFor(() => expect(page.querySelector('.re-swap-failed')).toBeNull());
    });
  });

  it('says a refusal from the control plane the same way, as a toast', async () => {
    const page = mount([runner([DEFAULT, WORK])], async () => {
      throw new Error('A default is already being set on this runner. Wait for it to finish.');
    });
    const [, workRow] = claudeRows(page);
    await act(async () => (await setDefaultItem(workRow))!.click());
    const dialog = await openDialog('Make Work the default?');
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Make default')!.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Couldn’t make Work the default', 'A default is already being set on this runner. Wait for it to finish.'),
      );
    });
  });

  it('moves the DEFAULT chip once done: the runner reports the accounts in each other’s folders', async () => {
    let swapped = false;
    const before = runner([DEFAULT, WORK]);
    // Done: Orbit's records followed their accounts, so the name Work is now on the default slot, and the
    // former Default (unnamed) is in Work's folder, served as the former Default with its email.
    const after = runner([{ ...DEFAULT, name: 'Work' }, { ...WORK, name: undefined, formerDefault: true, email: 'me@home.example' }], {
      claudeAccountSwap: swap({ status: 'done' }),
    });
    const page = mount([before], async () => { swapped = true; return swap({}); }, () => [swapped ? after : before]);
    const chips = (row: Element) => [...row.querySelectorAll('.re-chip')].map((chip) => chip.textContent);
    expect(chips(claudeRows(page)[0])).not.toContain('DEFAULT');

    await act(async () => (await setDefaultItem(claudeRows(page)[1]))!.click());
    const dialog = await openDialog('Make Work the default?');
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Make default')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(claudeRows(page)[0].querySelector('.re-name')?.textContent).toContain('Work'));
    });
    const [defaultRow, addedRow] = claudeRows(page);
    expect(chips(defaultRow)).toContain('DEFAULT');
    expect(defaultRow.querySelector('.re-meta')?.textContent).toContain('~/.claude');
    expect(addedRow.querySelector('.re-meta')?.textContent).toContain('~/.orbit/claude-accounts/3fa91c2e');
    // The former Default is called by its email, never "Default": that is the label of the slot it left.
    expect(addedRow.querySelector('.re-name')?.textContent).toContain('me@home.example');
    expect(addedRow.querySelector('.re-name')?.textContent).not.toContain('Default');
    expect(chips(addedRow)).not.toContain('DEFAULT');
    // Nothing left under either account: done says nothing.
    expect(page.querySelector('.re-swapping')).toBeNull();
    expect(page.querySelector('.re-swap-failed')).toBeNull();
  });
});

describe('the former Default, after the swap', () => {
  const nameOfRow = (page: ParentNode, index: number) => claudeRows(page)[index].querySelector('.re-name')?.textContent ?? '';
  const done = { claudeAccountSwap: swap({ status: 'done' }) };

  it('is named by its email when Claude reported one', () => {
    const page = mount([runner([{ ...DEFAULT, name: 'Work' }, { ...WORK, name: undefined, formerDefault: true, email: 'me@home.example' }], done)]);
    expect(nameOfRow(page, 0)).toContain('Work');
    expect(nameOfRow(page, 1)).toContain('me@home.example');
    expect(nameOfRow(page, 1)).not.toContain('Default');
  });

  it('is "Former default" when no email is known', () => {
    const page = mount([runner([{ ...DEFAULT, name: 'Work' }, { ...WORK, name: undefined, formerDefault: true }], done)]);
    expect(nameOfRow(page, 1)).toContain('Former default');
  });

  it('keeps the name the owner gave it', () => {
    const page = mount([runner([{ ...DEFAULT, name: 'Work' }, { ...WORK, name: 'Personal', formerDefault: true, email: 'me@home.example' }], done)]);
    expect(nameOfRow(page, 1)).toContain('Personal');
    expect(nameOfRow(page, 1)).not.toContain('me@home.example');
  });
});
