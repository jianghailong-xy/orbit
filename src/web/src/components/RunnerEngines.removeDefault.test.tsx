// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { ownSignInPanel, RunnerEngines } from './RunnerEngines';
import {
  clickRunnerMenuItem,
  dialogDescription,
  dialogName,
  openRunnerCards,
  openRunnerMenu,
  runnerMenuItem,
} from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Removing a runner's Default from Orbit, from the Providers page, and bringing it back.
 *
 * Default is the directory the machine's own environment selects (~/.codex for Codex), the one the CLI
 * typed in a terminal there shares. Removing it changes Orbit alone: the control plane records it at
 * once, and while the runner reports another account of that engine it serves the engine without
 * Default, marked with what the page names it by (`removedDefault`), and with the engine's sign-in and
 * quota the remaining accounts'. Nothing goes to the machine, so it works with the runner offline.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../lib/toast', async (original) => ({ ...(await original<typeof import('../lib/toast')>()), useToast: () => toast }));
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Details link encodes it, and a
// placeholder would fail the render rather than an assertion.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  home: '/root/.codex',
  codexHome: '/root/.codex',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_2b7e9013',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  home: '/root/.orbit/codex-accounts/3fa91c2e',
  codexHome: '/root/.orbit/codex-accounts/3fa91c2e',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const PERSONAL: RunnerEngineAccount = {
  id: '7c21de40',
  name: 'Personal',
  home: '/root/.orbit/codex-accounts/7c21de40',
  codexHome: '/root/.orbit/codex-accounts/7c21de40',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_4d5c8b26',
};

/** One login's 5-hour window, `used` percent of it gone. */
const window5h = (used: number) => ({ provider: 'codex', primary: { utilization: used, windowDurationMins: 300 } });
/** What each account has used: Default's window is the Codex snapshot's own, the others' sit under their ids. */
const USED: Record<string, number> = { default: 62, [WORK.id]: 8, [PERSONAL.id]: 30 };
const usageOf = (accounts: RunnerEngineAccount[]) =>
  Object.fromEntries(accounts.filter((a) => a.id !== 'default').map((a) => [a.id, window5h(USED[a.id])]));

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const runner = (codex: Partial<RunnerEngineHealth>, over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [
    health({ engine: 'claude', version: '2.0.44' }),
    health({ engine: 'codex', version: '0.156.0', ...codex }),
    health({ engine: 'kimi', version: '0.41.0' }),
  ],
  ...over,
});

/** Codex with Default listed first, as the runner reports it, beside `others`. */
const withDefault = (others: RunnerEngineAccount[], over: Partial<Runner> = {}) =>
  runner({ accounts: [DEFAULT, ...others] }, { planUsage: { ...window5h(USED.default), accounts: usageOf(others) } as PlanUsage, ...over });

/** Codex as the control plane serves it with Default removed (usedRunnerEngines): the remaining accounts,
 *  the marker, the engine's sign-in read from one of them (the first signed in), and Default's windows
 *  gone from its quota — one remaining account's becoming the snapshot's own. */
const removed = (remaining: RunnerEngineAccount[], over: Partial<Runner> = {}, name?: string) =>
  runner(
    {
      accounts: remaining,
      auth: (remaining.find((a) => a.auth === 'yes') ?? remaining[0]).auth,
      removedDefault: { home: DEFAULT.home, ...(name ? { name } : {}), fingerprintPrefix: DEFAULT.fingerprintPrefix },
    },
    {
      planUsage: {
        provider: 'codex',
        ...(remaining.length === 1 ? window5h(USED[remaining[0].id]) : {}),
        accounts: usageOf(remaining),
      } as PlanUsage,
      ...over,
    },
  );

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The account menu measures its button with a ResizeObserver, which jsdom does not have.
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
  toast.error.mockReset();
  localStorage.clear();
});

/** The section over these runners, their cards open — and, unless `folded`, every group of accounts. */
function mount(runners: Runner[], { folded = false } = {}) {
  openRunnerCards(runners);
  if (folded) localStorage.removeItem('orbit:providers-open-accounts');
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return runners;
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    if (options?.method === 'DELETE') return { engine: 'codex', account: 'default', status: 'done', message: null };
    if (path.endsWith('/default/restore')) return { ok: true };
    return { status: 'pending', engine: 'codex', url: null, userCode: null, message: null };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/providers']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const rows = (el: ParentNode, selector: string) => [...el.querySelectorAll<HTMLElement>(selector)];
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
const button = (el: ParentNode, label: string) => {
  const found = rows(el, 'button').find((b) => (b.textContent?.trim() || b.getAttribute('aria-label')) === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found as HTMLButtonElement;
};
/** Codex's own row: a group's head, or the engine on its own. */
const codexRow = (page: ParentNode) => page.querySelector<HTMLElement>('.re-row[data-engine="codex"]')!;
/** The account rows under Codex, in the order the page drew them. */
const accountsOf = (page: ParentNode) => rows(page, '.re-acct:not(.re-removed)');
const nameOf = (row: Element) => row.querySelector('.re-name-text')?.textContent;
/** The line a removed Default ends its group with. */
const removedLine = (page: ParentNode) => page.querySelector<HTMLElement>('.re-removed');
/** The confirmation's own Remove, once its popup — a dialog named by its question — is drawn (a portal,
 *  a few frames late on a slow host). */
const confirmation = async () => {
  let ok: HTMLButtonElement | undefined;
  await act(async () => {
    await vi.waitFor(
      () => {
        ok = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
          (b) => b.textContent?.trim() === 'Remove',
        );
        expect(ok).toBeDefined();
      },
      { timeout: 20_000, interval: 20 },
    );
  });
  return ok!;
};
/** Every request the page made with `method`, by path, in order. */
const requests = (method: string) =>
  apiMock.mock.calls.filter(([, options]) => (options?.method ?? 'GET') === method).map(([path]) => path);

describe('Remove account on Default', () => {
  it('is offered after the separator, as a danger, while another account of the engine is on the runner', async () => {
    const page = mount([withDefault([WORK])]);
    const [defaultRow] = accountsOf(page);
    expect(nameOf(defaultRow)).toBe('Default');

    const menu = await openRunnerMenu(defaultRow);
    const item = rows(menu, '[role="menuitem"]').at(-1)!;
    expect(item.textContent?.trim()).toBe('Remove account');
    expect(item.hasAttribute('data-danger')).toBe(true);
    expect(item.previousElementSibling?.getAttribute('role')).toBe('separator');
  });

  it('is not offered when Default is the only account, which the engine’s own row stands for', async () => {
    const page = mount([runner({ accounts: [DEFAULT] })]);
    expect(accountsOf(page)).toHaveLength(0);
    expect(codexRow(page).classList.contains('re-grp')).toBe(false);
    expect((await openRunnerMenu(codexRow(page))).textContent).not.toContain('Remove account');
  });

  it('is not offered while the only other account is on its way off the machine', async () => {
    const page = mount([
      withDefault([WORK], { accountRemove: { engine: 'codex', account: WORK.id, status: 'pending', message: null } }),
    ]);
    const [defaultRow] = accountsOf(page);
    expect((await openRunnerMenu(defaultRow)).textContent).not.toContain('Remove account');
  });

  it('stays enabled with the runner offline — nothing goes to the machine — where an added account’s is not', async () => {
    const page = mount([withDefault([WORK], { online: false })]);
    const [defaultRow, workRow] = accountsOf(page);

    expect((await runnerMenuItem(defaultRow, 'Remove account')).getAttribute('aria-disabled')).not.toBe('true');
    expect((await runnerMenuItem(workRow, 'Remove account')).getAttribute('aria-disabled')).toBe('true');
  });

  it('asks first, saying the machine keeps its sign-in, then removes it from Orbit and reads the runners again', async () => {
    const page = mount([withDefault([WORK, PERSONAL])]);
    const [defaultRow] = accountsOf(page);

    await clickRunnerMenuItem(defaultRow, 'Remove account');
    const ok = await confirmation();
    const dialog = ok.closest('[role="dialog"]')!;
    expect(dialogName(dialog)).toBe('Remove Default?');
    expect(dialogDescription(dialog)).toBe(
      'Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex in a terminal there ' +
        'keeps working. Workspaces set to it run on Automatic.',
    );
    expect(requests('DELETE')).toEqual([]);
    const reads = requests('GET').filter((path) => path === '/runners').length;

    await click(ok);
    expect(requests('DELETE')).toEqual([`/runners/${RUNNER_ID}/accounts/codex/default`]);
    await act(async () => {
      await vi.waitFor(() => expect(requests('GET').filter((path) => path === '/runners').length).toBeGreaterThan(reads));
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('names a renamed Default, and the CLI of its own engine', async () => {
    const claude = (accounts: RunnerEngineAccount[]) => health({ engine: 'claude', version: '2.0.44', accounts });
    const page = mount([
      runner(
        {},
        {
          engines: [
            claude([
              { id: 'default', name: 'jianghailong.main', home: '/root/.claude', auth: 'yes' },
              { id: 'a1b2c3d4', name: 'Work', home: '/root/.orbit/claude-accounts/a1b2c3d4', auth: 'yes' },
            ]),
            health({ engine: 'codex', version: '0.156.0' }),
          ],
        },
      ),
    ]);
    const [defaultRow] = rows(page, '.re-row[data-engine="claude"] ~ .re-acct');

    await clickRunnerMenuItem(defaultRow, 'Remove account');
    const dialog = (await confirmation()).closest('[role="dialog"]')!;
    expect(dialogName(dialog)).toBe('Remove jianghailong.main?');
    expect(dialogDescription(dialog)).toContain('and Claude Code in a terminal there keeps working.');
  });

  it('says what the control plane answered when it refused', async () => {
    const page = mount([withDefault([WORK])]);
    const answer = apiMock.getMockImplementation()!;
    const refusal = 'Add another Codex account to this machine before removing Default.';
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') throw new Error(refusal);
      return answer(path, options);
    });
    const [defaultRow] = accountsOf(page);

    await clickRunnerMenuItem(defaultRow, 'Remove account');
    await click(await confirmation());
    expect(requests('DELETE')).toEqual([`/runners/${RUNNER_ID}/accounts/codex/default`]);
    await act(async () => {
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't remove the account", refusal));
    });
  });
});

describe('an engine whose Default is removed from Orbit', () => {
  it('lists the two accounts that remain, each with its own sign-in and quota, and ends with Default’s line', () => {
    const page = mount([removed([WORK, { ...PERSONAL, auth: 'no' }])]);

    const head = codexRow(page);
    expect(head.classList.contains('re-grp')).toBe(true);
    // The head counts the accounts that remain, and only those.
    expect(head.querySelector('.re-meta')?.textContent).toBe('0.156.0 · 1 of 2 accounts available');

    const [workRow, personalRow] = accountsOf(page);
    expect(accountsOf(page).map(nameOf)).toEqual(['Work', 'Personal']);
    expect(workRow.querySelector('.re-status')?.textContent).toBe('Available');
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('5h limit8%');
    expect(personalRow.querySelector('.re-status')?.textContent).toBe('Signed out');
    expect(personalRow.querySelector('.re-quota')?.textContent).toBe('Sign in to see quota');
    // Automatic starts the next session on one of them, never on Default.
    expect(workRow.querySelector('.re-chip')?.textContent).toBe('NEXT');
    expect(page.textContent).not.toContain('62%');

    // The group ends with Default, where it lives on the machine, and the way back. The rail runs on to it.
    const line = removedLine(page)!;
    expect(line.previousElementSibling).toBe(personalRow);
    expect(line.querySelector('.re-removed-line')?.textContent).toBe('Default · ~/.codex isn’t used by Orbit');
    expect(rows(line, 'button').map((b) => b.textContent?.trim())).toEqual(['Use again']);
    expect(personalRow.classList.contains('re-acct-end')).toBe(false);
    expect(line.classList.contains('re-acct-end')).toBe(true);
  });

  it('keeps one remaining account a group of its own, with its own sign-in — never the engine’s row', async () => {
    const page = mount([removed([{ ...WORK, auth: 'no' }])]);

    const head = codexRow(page);
    expect(head.classList.contains('re-grp')).toBe(true);
    expect(head.querySelector('.re-meta')?.textContent).toBe('0.156.0 · 0 of 1 accounts available');
    // The head itself offers no sign-in: on the machine the engine's own is Default's.
    expect(rows(head, 'button').map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))).not.toContain('Sign in');
    expect(head.querySelector('[aria-label="More actions"]')).toBeNull();

    const [workRow] = accountsOf(page);
    expect(nameOf(workRow)).toBe('Work');
    expect(workRow.querySelector('.re-meta')?.textContent).toContain('~/.orbit/codex-accounts/3fa91c2e');
    expect(workRow.querySelector('.re-status')?.textContent).toBe('Signed out');
    expect(removedLine(page)?.querySelector('.re-removed-line')?.textContent).toBe('Default · ~/.codex isn’t used by Orbit');

    // Its Sign in is its own account's, by id, not the engine's.
    await click(button(workRow, 'Sign in'));
    await click(button(page, 'Sign in to Codex'));
    expect(
      apiMock.mock.calls
        .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
        .map(([, options]) => options?.body),
    ).toEqual([{ engine: 'codex', account: WORK.id }]);
  });

  it('draws the one remaining account’s quota from its own report, and Automatic starting there', () => {
    const page = mount([removed([WORK])]);
    const [workRow] = accountsOf(page);
    expect(workRow.querySelector('.re-status')?.textContent).toBe('Available');
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('5h limit8%');
    expect(workRow.querySelector('.re-chip')?.textContent).toBe('NEXT');
    expect(codexRow(page).querySelector('.re-meta')?.textContent).toBe('0.156.0 · 1 of 1 accounts available');
  });

  it('folded, says what the remaining accounts come to, and nothing of Default', () => {
    const page = mount([removed([WORK])], { folded: true });
    const head = codexRow(page);
    expect(head.classList.contains('folded')).toBe(true);
    expect(head.querySelector('.re-status')?.textContent).toBe('Available');
    expect(head.querySelector('.re-quota-next')?.textContent).toBe('Next: Work');
    expect(head.querySelector('.re-quota')?.textContent).toContain('8%');
    expect(accountsOf(page)).toHaveLength(0);
    expect(removedLine(page)).toBeNull();
  });

  it('names a renamed Default by its name on its line', () => {
    const page = mount([removed([WORK, PERSONAL], {}, 'jianghailong.main')]);
    expect(removedLine(page)?.querySelector('.re-removed-line')?.textContent).toBe(
      'jianghailong.main · ~/.codex isn’t used by Orbit',
    );
  });

  it('no longer offers Default anything — its row is gone', async () => {
    const page = mount([removed([WORK, PERSONAL])]);
    expect(accountsOf(page).map(nameOf)).not.toContain('Default');
    // Each remaining account still has its own menu, Remove account included.
    expect(await runnerMenuItem(accountsOf(page)[0], 'Remove account')).toBeTruthy();
  });
});

describe('removing an added account while Default is removed', () => {
  it('says its workspaces run on Automatic, not on Default', async () => {
    const page = mount([removed([WORK, PERSONAL])]);
    const [, personalRow] = accountsOf(page);

    await clickRunnerMenuItem(personalRow, 'Remove account');
    const ok = await confirmation();
    const dialog = ok.closest('[role="dialog"]')!;
    expect(dialogName(dialog)).toBe('Remove Personal?');
    expect(dialogDescription(dialog)).toBe(
      'Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic.',
    );
    await click(ok);
    expect(requests('DELETE')).toEqual([`/runners/${RUNNER_ID}/accounts/codex/${PERSONAL.id}`]);
  });

  it('says Orbit goes back to Default when it is the last account Orbit uses there', async () => {
    const page = mount([removed([WORK], {}, 'jianghailong.main')]);
    const [workRow] = accountsOf(page);

    await clickRunnerMenuItem(workRow, 'Remove account');
    const dialog = (await confirmation()).closest('[role="dialog"]')!;
    expect(dialogDescription(dialog)).toBe(
      'Its sign-in is deleted from wikova. Without it, Orbit uses jianghailong.main there again, and ' +
        'workspaces set to this account run on it.',
    );
  });

  it('still says Default while Default is in use', async () => {
    const page = mount([withDefault([WORK])]);
    const [, workRow] = accountsOf(page);

    await clickRunnerMenuItem(workRow, 'Remove account');
    const dialog = (await confirmation()).closest('[role="dialog"]')!;
    expect(dialogDescription(dialog)).toBe('Its sign-in is deleted from wikova. Workspaces set to this account run on Default.');
  });
});

describe('Use again', () => {
  it('brings Default back on the restore route, and reads the runners again', async () => {
    const page = mount([removed([WORK])]);
    const reads = requests('GET').filter((path) => path === '/runners').length;

    await click(button(removedLine(page)!, 'Use again'));
    expect(requests('POST')).toEqual([`/runners/${RUNNER_ID}/accounts/codex/default/restore`]);
    await act(async () => {
      await vi.waitFor(() => expect(requests('GET').filter((path) => path === '/runners').length).toBeGreaterThan(reads));
    });
  });

  it('works with the runner offline: it is Orbit’s own record', async () => {
    const page = mount([removed([WORK, PERSONAL], { online: false })]);
    const useAgain = button(removedLine(page)!, 'Use again');
    expect(useAgain.disabled).toBe(false);

    await click(useAgain);
    expect(requests('POST')).toEqual([`/runners/${RUNNER_ID}/accounts/codex/default/restore`]);
  });

  it('says so when it could not', async () => {
    const page = mount([removed([WORK])]);
    const answer = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.endsWith('/default/restore')) throw new Error('runner not found');
      return answer(path, options);
    });

    await click(button(removedLine(page)!, 'Use again'));
    await act(async () => {
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t use Default again', 'runner not found'));
    });
  });
});

describe('the sign-in Needs Attention opens for a signed-out engine', () => {
  it('is a remaining account’s while Default is removed, and Default’s while it is in use', () => {
    expect(ownSignInPanel(removed([{ ...WORK, auth: 'no' }, { ...PERSONAL, auth: 'no' }]), 'codex')).toBe(`codex/${WORK.id}`);
    expect(ownSignInPanel(removed([WORK, { ...PERSONAL, auth: 'no' }]), 'codex')).toBe(`codex/${PERSONAL.id}`);
    expect(ownSignInPanel(removed([{ ...WORK, auth: 'no' }]), 'codex')).toBe(`codex/${WORK.id}`);
    expect(ownSignInPanel(withDefault([WORK]), 'codex')).toBe('codex/default');
    expect(ownSignInPanel(runner({ accounts: [DEFAULT] }), 'codex')).toBe('codex');
  });
});
