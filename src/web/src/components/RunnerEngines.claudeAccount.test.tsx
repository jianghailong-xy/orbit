// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { formatResetTime } from '../lib/providerPools';
import { RunnerEngines, summaryOf } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * More than one Claude account on one runner, on the Providers page: the same rows Codex has had,
 * for the engine whose CLI keeps one login per CLAUDE_CONFIG_DIR.
 *
 * What is being pinned is that the rows, their buttons and the requests they send belong to the
 * CLAUDE engine — a page that drew the right row but signed in, or removed, a Codex account would
 * look identical in a static render.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  home: '/root/.claude',
  auth: 'yes',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  home: '/root/.orbit/claude-accounts/3fa91c2e',
  auth: 'no',
};

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

/** Default's five-hour window, and Work's own under the Claude snapshot's `accounts` — resetting
 *  ahead of whenever this runs: a window past its reset reads as a fresh one (currentPlanUsageRows). */
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const CLAUDE_USAGE = {
  claude: {
    provider: 'claude',
    fiveHour: { utilization: 12, resetsAt: inHours(3) },
    accounts: {
      [WORK.id]: { provider: 'claude', fiveHour: { utilization: 44, resetsAt: inHours(4) } },
    },
  },
} as PlanUsage;

const runner = (claude: Partial<RunnerEngineHealth>, over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  planUsage: CLAUDE_USAGE,
  engines: [
    health({ engine: 'claude', version: '2.1.283 (Claude Code)', ...claude }),
    health({ engine: 'codex', version: 'codex-cli 0.157.1' }),
    health({ engine: 'kimi', version: '2.1.1' }),
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Remove asks in an antd popup, which measures itself with a ResizeObserver jsdom does not have.
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

function mount(runners: Runner[]) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return runners;
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    return { status: 'pending', engine: 'claude', url: null, userCode: null, message: null };
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
const tags = (row: Element) => rows(row, '.ant-tag').map((tag) => tag.textContent?.trim());
/** A button's words, or the name of a mark that has none (Re-sign in, Remove). */
const labelOf = (b: Element) => b.textContent?.trim() || b.getAttribute('aria-label');
const button = (el: ParentNode, label: string) => {
  const found = rows(el, 'button').find((b) => labelOf(b) === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found as HTMLButtonElement;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
/** The confirmation's own Remove, once its popup is drawn (a portal, a few frames late on a slow host). */
const confirmation = async () => {
  let ok: HTMLButtonElement | undefined;
  await act(async () => {
    await vi.waitFor(
      () => {
        ok = [...document.querySelectorAll<HTMLButtonElement>('.ant-popconfirm button')].find(
          (b) => b.textContent?.trim() === 'Remove',
        );
        expect(ok).toBeDefined();
      },
      { timeout: 20_000, interval: 20 },
    );
  });
  return ok!;
};
const loginPosts = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
    .map(([, options]) => options?.body);
const deleteCalls = () =>
  apiMock.mock.calls.filter(
    ([path, options]) => String(path).includes('/accounts/') && options?.method === 'DELETE',
  );

describe('a runner with two Claude accounts', () => {
  it('draws a group head and one row per account, in the order the runner reported them', () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const head = rows(page, '.re-grp')[0];
    expect(head.querySelector('.re-name')?.textContent).toBe('Claude Code');
    // Its version as a number, and how many of its accounts could take a session now.
    expect(head.querySelector('.re-meta')?.textContent).toBe('2.1.283 · 1 of 2 accounts available');
    // The head keeps what the engine owns and says nothing for its accounts: no tag, no quota.
    expect(tags(head)).toEqual([]);
    expect(head.querySelector('.re-quota')).toBeNull();

    const accounts = rows(page, '.re-acct');
    expect(accounts).toHaveLength(2);
    // Default is where a session nobody picked an account for starts: Work is signed out.
    expect(accounts.map((row) => row.querySelector('.re-name')?.textContent)).toEqual([
      'DefaultNEXT',
      'Work',
    ]);
    expect(accounts.map(tags)).toEqual([['Available'], ['Signed out']]);
    // Where each account's login lives — the CLAUDE_CONFIG_DIR, not a CODEX_HOME.
    expect(accounts[0].querySelector('.re-meta')?.textContent).toBe('~/.claude');
    expect(accounts[1].querySelector('.re-meta')?.textContent).toBe(
      '~/.orbit/claude-accounts/3fa91c2e',
    );
    // Each account's own quota: Default's is the snapshot's own window, Work's its entry.
    expect(accounts[0].querySelector('.re-quota')?.textContent).toContain('12%');
    expect(accounts[1].querySelector('.re-quota')?.textContent).toBe('Sign in to see quota');
  });

  it('offers + Account on the Claude row, and signs a new one in as a Claude account', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const head = rows(page, '.re-grp')[0];
    await click(button(head, '+ Account'));
    const name = page.querySelector<HTMLInputElement>('.re-add input');
    expect(name).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name!, 'Personal');
      name!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(page, 'Sign in to Claude Code'));
    expect(loginPosts()).toEqual([{ engine: 'claude', accountName: 'Personal' }]);
  });

  it('re-signs in a signed-out account of its own, naming the account', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const workRow = rows(page, '.re-acct')[1];
    await click(button(workRow, 'Sign in'));
    await click(button(page, 'Sign in to Claude Code'));
    expect(loginPosts()).toEqual([{ engine: 'claude', account: WORK.id }]);
  });

  it('removes an added account on its own route once asked, and never Default', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const [defaultRow, workRow] = rows(page, '.re-acct');
    // Default can be renamed like any other account, but never removed: it is the machine's own login.
    expect(rows(defaultRow, 'button').map(labelOf)).toEqual(['Rename', 'Re-sign in']);

    // The press asks first: the slot's sign-in is deleted from the machine, and nothing is sent until
    // the question is answered.
    await click(button(workRow, 'Remove'));
    const ok = await confirmation();
    expect(document.querySelector('.ant-popconfirm')?.textContent).toContain('Remove Work?');
    expect(deleteCalls()).toEqual([]);

    await click(ok);
    expect(deleteCalls().map(([path]) => path)).toEqual([
      `/runners/${RUNNER_ID}/accounts/claude/${WORK.id}`,
    ]);
  });

  it('says what the machine answered when it refused a removal', () => {
    const page = mount([
      runner(
        { accounts: [DEFAULT, WORK] },
        {
          accountRemove: {
            engine: 'claude',
            account: WORK.id,
            status: 'failed',
            message: 'claude account 3fa91c2e is in use by a session running on this machine',
          },
        },
      ),
    ]);
    const workRow = rows(page, '.re-acct')[1];
    expect(workRow.querySelector('.re-panel.bad')?.textContent).toContain('in use by a session');
    // And the engine it is about, not merely the slot id: a Codex removal in flight says nothing
    // about a Claude row.
    expect(workRow.querySelector('.re-panel.bad')?.textContent).toContain(
      '~/.orbit/claude-accounts/3fa91c2e',
    );
  });

  it('counts a signed-out account against the card, and shows nothing on an engine without', () => {
    const box = runner({ accounts: [DEFAULT, WORK] });
    expect(summaryOf(box)).toBe('2 of 3 signed in');
    const page = mount([box]);
    // Kimi keeps one login for the machine: no group, no rows, and no + Account anywhere near it.
    const kimiRow = rows(page, '.re-row').find(
      (el) => el.querySelector('.re-name')?.textContent === 'Kimi Code',
    )!;
    expect(kimiRow.className).not.toContain('re-grp');
    expect(rows(kimiRow, 'button').map((b) => b.textContent?.trim())).not.toContain('+ Account');
  });
});

describe("three Claude accounts, one of them out for the week (wikova, 2026-10-02)", () => {
  const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  const RD: RunnerEngineAccount = {
    id: 'fad98727',
    name: 'jianghailong.rd',
    home: '/root/.orbit/claude-accounts/fad98727',
    auth: 'yes',
  };
  const ORBIT: RunnerEngineAccount = {
    id: '29e631a9',
    name: 'jianghailong.orbit',
    home: '/root/.orbit/claude-accounts/29e631a9',
    auth: 'yes',
  };
  const rdWeek = at(66);
  const rdRead = at(-7.2);
  const orbitFiveHour = at(0.55);
  const usage = {
    claude: {
      provider: 'claude',
      fiveHour: { utilization: 1, resetsAt: at(4.7) },
      sevenDay: { utilization: 0, resetsAt: at(155) },
      fetchedAt: at(-0.07),
      accounts: {
        // Read before its 5-hour window rolled over, and not since (its token expired with nothing
        // running on it): the 6% is about a window that is over, the spent week is not.
        [RD.id]: {
          provider: 'claude',
          fiveHour: { utilization: 6, resetsAt: at(-5.5) },
          sevenDay: { utilization: 100, resetsAt: rdWeek },
          fetchedAt: rdRead,
        },
        [ORBIT.id]: {
          provider: 'claude',
          fiveHour: { utilization: 100, resetsAt: orbitFiveHour },
          sevenDay: { utilization: 59, resetsAt: at(101) },
          fetchedAt: at(-0.05),
        },
      },
    },
  } as PlanUsage;
  const box = (over: Partial<Runner> = {}) =>
    runner(
      { version: '2.1.287 (Claude Code)', accounts: [{ ...DEFAULT }, RD, ORBIT] },
      { planUsage: usage, ...over },
    );
  /** Each window a row draws: its label, how much of it is used, and when it resets. */
  const windows = (row: Element) =>
    rows(row, '.re-window').map((w) => [
      w.querySelector('.re-quota-head b')?.textContent,
      w.querySelector('.re-quota-head span')?.textContent,
      w.querySelector('.re-reset')?.textContent ?? null,
    ]);

  it('says which accounts can take a session, and when the others can', () => {
    const page = mount([box()]);
    const [head] = rows(page, '.re-grp');
    expect(head.querySelector('.re-meta')?.textContent).toBe('2.1.287 · 1 of 3 accounts available');

    const [defaultRow, rdRow, orbitRow] = rows(page, '.re-acct');
    // Default is the one with room, so a session nobody picked an account for starts there.
    expect([defaultRow, rdRow, orbitRow].map((row) => row.querySelector('.re-name')?.textContent)).toEqual([
      'DefaultNEXT',
      'jianghailong.rd',
      'jianghailong.orbit',
    ]);
    // Spent until the window that stops it resets: rd's week, orbit's five hours.
    expect([defaultRow, rdRow, orbitRow].map(tags)).toEqual([
      ['Available'],
      [`Spent · resets ${formatResetTime(rdWeek)}`],
      [`Spent · resets ${formatResetTime(orbitFiveHour)}`],
    ]);
  });

  it('draws every window with its reset, the spent week included', () => {
    const page = mount([box()]);
    const [defaultRow, rdRow, orbitRow] = rows(page, '.re-acct');
    expect(windows(defaultRow)).toEqual([
      ['5-hour limit', '1%', `resets ${formatResetTime(at(4.7))}`],
      ['Weekly · all models', '0%', `resets ${formatResetTime(at(155))}`],
    ]);
    // Its 5-hour window has rolled over since the reading: a fresh window, with no reset to name.
    expect(windows(rdRow)).toEqual([
      ['5-hour limit', '0%', null],
      ['Weekly · all models', '100%', `resets ${formatResetTime(rdWeek)}`],
    ]);
    expect(windows(orbitRow)).toEqual([
      ['5-hour limit', '100%', `resets ${formatResetTime(orbitFiveHour)}`],
      ['Weekly · all models', '59%', `resets ${formatResetTime(at(101))}`],
    ]);
    // Spent windows are drawn amber, as nearly spent ones are.
    expect(rows(rdRow, '.runner-util.full')).toHaveLength(1);
    expect(rows(orbitRow, '.runner-util.full')).toHaveLength(1);
  });

  it('says when a reading stopped keeping up, and only on that row', () => {
    const page = mount([box()]);
    const [defaultRow, rdRow, orbitRow] = rows(page, '.re-acct');
    expect(rdRow.querySelector('.re-stale')?.textContent).toBe(`Usage as of ${formatResetTime(rdRead)} · 7h ago`);
    expect(defaultRow.querySelector('.re-stale')).toBeNull();
    expect(orbitRow.querySelector('.re-stale')).toBeNull();
  });

  it('leaves the age of a reading to the card when the machine is offline', () => {
    const page = mount([box({ online: false })]);
    expect(rows(page, '.re-stale')).toHaveLength(0);
  });
});
