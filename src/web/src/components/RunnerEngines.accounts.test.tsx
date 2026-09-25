// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { RunnerEngines, summaryOf, tildePath } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * More than one Codex account on one runner, on the Providers page.
 *
 * Mounted into a real DOM so every claim is about a row: which rows exist, which one holds which
 * status tag, and — pressed through to the mocked `api()` — which account a row's button signs in.
 * A row's button that signed in the wrong account would look exactly right in a static render.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it, and a
// placeholder would fail the render rather than an assertion.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  codexHome: '/root/.codex',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  codexHome: '/root/.orbit/codex-accounts/3fa91c2e',
  auth: 'no',
};

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

// Default's 5h window: the runner's usage probe reads Default, so this is Default's quota.
const CODEX_USAGE = {
  provider: 'codex',
  primary: { utilization: 62, windowDurationMins: 300 },
} as PlanUsage;

const runner = (codex: Partial<RunnerEngineHealth>, over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  planUsage: CODEX_USAGE,
  engines: [
    health({ engine: 'claude', version: '2.0.44' }),
    health({ engine: 'codex', version: '0.156.0', ...codex }),
    health({ engine: 'kimi', version: '0.41.0' }),
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

// Tells React this is a test that drives updates through act(), so it flushes them there.
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

/** Mount the section over these runners, their cards open, the way a user who opened them sees it. */
function mount(runners: Runner[]) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return runners;
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
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
const tags = (row: Element) => rows(row, '.ant-tag').map((tag) => tag.textContent?.trim());
const button = (el: ParentNode, label: string) => {
  const found = rows(el, 'button').find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found as HTMLButtonElement;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
/** The bodies POSTed to the sign-in relay, in order. */
const loginPosts = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
    .map(([, options]) => options?.body);

describe('a runner with two Codex accounts', () => {
  it('draws a row per account, each with its own status, under a Codex head that has none', () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);

    const accounts = rows(page, '.re-acct');
    expect(accounts).toHaveLength(2);
    // One tag per account row, and they are that account's own: Work is signed out even though
    // the engine — whose `auth` is Default's answer — says signed in.
    expect(accounts.map(tags)).toEqual([['Signed in'], ['Signed out']]);

    const [head] = rows(page, '.re-grp');
    expect(head).toBeDefined();
    // The head is Codex's row, and it no longer draws a status of its own: signed in or out is
    // each account's, not the engine's.
    expect(head.querySelector('.re-name')?.textContent).toBe('Codex');
    expect(tags(head)).toEqual([]);
    expect(head.querySelector('.re-quota')?.textContent).toBe('');
    expect(head.querySelector('.re-meta')?.textContent).toContain('2 accounts');
    expect(button(head, '+ Account')).toBeTruthy();
    expect(head.textContent).not.toContain('Re-sign in');

    // The other engines are untouched rows, each still with its own tag.
    const engineRows = rows(page, '.re-row:not(.re-acct)');
    expect(engineRows.map((row) => row.querySelector('.re-name')?.textContent)).toEqual([
      'Claude Code',
      'Codex',
      'Kimi Code',
    ]);
    expect(tags(engineRows[0])).toEqual(['Signed in']);
    expect(tags(engineRows[2])).toEqual(['Signed in']);
  });

  it('names each account by what the user called it and where it lives, never by who it is', () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const [defaultRow, workRow] = rows(page, '.re-acct');

    expect(defaultRow.querySelector('.re-name')?.textContent).toBe('DefaultDEFAULT');
    expect(defaultRow.querySelector('.re-chip')?.textContent).toBe('DEFAULT');
    expect(defaultRow.querySelector('.re-meta')?.textContent).toBe('~/.codex · account cxa1_9f3a41c7…');
    expect(defaultRow.querySelector('.re-meta')?.getAttribute('title')).toBe('/root/.codex');

    expect(workRow.querySelector('.re-name')?.textContent).toBe('Work');
    expect(workRow.querySelector('.re-chip')).toBeNull();
    // No fingerprint read for Work yet: the line says where it lives and nothing it doesn't know.
    expect(workRow.querySelector('.re-meta')?.textContent).toBe('~/.orbit/codex-accounts/3fa91c2e');
    // Each account hangs off the head on its rail.
    expect(rows(page, '.re-acct .re-rail')).toHaveLength(2);
  });

  it("puts Default's quota on Default's row and on no other", () => {
    const page = mount([runner({ accounts: [DEFAULT, { ...WORK, auth: 'yes' }] })]);
    const [defaultRow, workRow] = rows(page, '.re-acct');

    expect(defaultRow.querySelector('.re-quota')?.textContent).toBe('5h limit62%');
    // The usage probe reads Default. Showing its limit on Work would be one account's quota
    // passed off as another's.
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('No quota reported');
  });

  it('draws each account its own quota bar from its own report', () => {
    // The runner reads every account in its own CODEX_HOME: Default's windows are the Codex
    // snapshot's own, Work's sit under its id.
    const WORK_USAGE = { provider: 'codex', primary: { utilization: 8, windowDurationMins: 300 } } as const;
    const bar = (row: Element) => row.querySelector<HTMLElement>('.runner-util-fill')?.style.width;
    for (const planUsage of [
      { ...CODEX_USAGE, accounts: { [WORK.id]: WORK_USAGE } },
      // Beside a Claude snapshot, as a runner with both runtimes nests them.
      {
        claude: { provider: 'claude', fiveHour: { utilization: 38 } },
        codex: { ...CODEX_USAGE, accounts: { [WORK.id]: WORK_USAGE } },
      },
    ] as PlanUsage[]) {
      const page = mount([runner({ accounts: [DEFAULT, { ...WORK, auth: 'yes' }] }, { planUsage })]);
      const [defaultRow, workRow] = rows(page, '.re-acct');

      expect(defaultRow.querySelector('.re-quota')?.textContent).toBe('5h limit62%');
      expect(bar(defaultRow)).toBe('62%');
      expect(workRow.querySelector('.re-quota')?.textContent).toBe('5h limit8%');
      expect(bar(workRow)).toBe('8%');
      // The group's head speaks for neither account.
      expect(rows(page, '.re-grp')[0].querySelector('.re-quota')?.textContent).toBe('');
      act(() => root?.unmount());
      host?.remove();
      root = host = null;
    }
  });

  it("shows no quota on Default when only Work has been read, and none for a signed-out account", () => {
    const WORK_USAGE = { provider: 'codex', primary: { utilization: 8, windowDurationMins: 300 } } as const;
    // A report that holds nothing of Default's: the runner has read Work, and not Default yet.
    const onlyWork = { provider: 'codex', accounts: { [WORK.id]: WORK_USAGE } } as PlanUsage;
    let page = mount([runner({ accounts: [DEFAULT, { ...WORK, auth: 'yes' }] }, { planUsage: onlyWork })]);
    let [defaultRow, workRow] = rows(page, '.re-acct');
    expect(defaultRow.querySelector('.re-quota')?.textContent).toBe('No quota reported');
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('5h limit8%');
    act(() => root?.unmount());
    host?.remove();
    root = host = null;

    // Work signed out since its last read: its old numbers are not shown as if they still applied.
    page = mount([runner({ accounts: [DEFAULT, WORK] }, { planUsage: { ...CODEX_USAGE, accounts: { [WORK.id]: WORK_USAGE } } as PlanUsage })]);
    [defaultRow, workRow] = rows(page, '.re-acct');
    expect(defaultRow.querySelector('.re-quota')?.textContent).toBe('5h limit62%');
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('Sign in to see quota');
  });

  it("signs in the account whose row was pressed, and only that one", async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);

    await click(button(rows(page, '.re-acct')[1], 'Sign in'));
    await click(button(page, 'Sign in to Codex'));
    expect(loginPosts()).toEqual([{ engine: 'codex', account: '3fa91c2e' }]);
  });

  it('re-signs in Default by name, not as whatever the runner defaults to', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);

    await click(button(rows(page, '.re-acct')[0], 'Re-sign in'));
    await click(button(page, 'Sign in to Codex'));
    expect(loginPosts()).toEqual([{ engine: 'codex', account: 'default' }]);
  });

  it('adds an account under the name typed for it, and not before there is one', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);

    await click(button(rows(page, '.re-grp')[0], '+ Account'));
    const start = button(page, 'Sign in to Codex');
    // A blank name would read as no account at all — the runner's own login.
    expect(start.disabled).toBe(true);

    const input = page.querySelector<HTMLInputElement>('.re-add input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, '  Personal ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(page, 'Sign in to Codex').disabled).toBe(false);
    await click(button(page, 'Sign in to Codex'));
    expect(loginPosts()).toEqual([{ engine: 'codex', accountName: 'Personal' }]);
  });

  it('lets a folded card say an account still needs signing in', () => {
    // Every engine's own answer is yes — Default's, for Codex. Folding the card must not turn a
    // signed-out Work into "All signed in".
    expect(summaryOf(runner({ accounts: [DEFAULT, WORK] }))).toBe('2 of 3 signed in');
    expect(summaryOf(runner({ accounts: [DEFAULT, { ...WORK, auth: 'yes' }] }))).toBe('All signed in');
  });
});

describe('a runner with one Codex account', () => {
  it('draws no account rows, and the Codex row keeps its own status', () => {
    for (const codex of [
      // A runner that lists its accounts, and has only Default.
      { accounts: [DEFAULT] },
      // An older runner, which reports no accounts at all.
      {},
    ]) {
      const page = mount([runner(codex)]);

      expect(rows(page, '.re-acct')).toHaveLength(0);
      expect(rows(page, '.re-grp')).toHaveLength(0);
      const codexRow = rows(page, '.re-row').find((row) => row.querySelector('.re-name')?.textContent === 'Codex')!;
      expect(tags(codexRow)).toEqual(['Signed in']);
      expect(codexRow.querySelector('.re-meta')?.textContent).toBe('codex 0.156.0');
      // Not the group's: it is how one account gets to two, so the Codex row holds it too.
      expect(button(codexRow, '+ Account')).toBeTruthy();
      expect(codexRow.textContent).not.toContain('DEFAULT');
      act(() => root?.unmount());
      host?.remove();
      root = host = null;
    }
  });

  it("signs in the runner's own login from the Codex row, exactly as before accounts", async () => {
    const page = mount([runner({ accounts: [DEFAULT] })]);
    const codexRow = rows(page, '.re-row').find((row) => row.querySelector('.re-name')?.textContent === 'Codex')!;

    await click(button(codexRow, 'Re-sign in'));
    await click(button(page, 'Sign in to Codex'));
    expect(loginPosts()).toEqual([{ engine: 'codex' }]);
  });
});

describe('where an account lives, as a terminal would spell it', () => {
  it("abbreviates the machine's home directory and leaves every other path whole", () => {
    expect(tildePath('/root/.codex')).toBe('~/.codex');
    expect(tildePath('/home/ada/.orbit/codex-accounts/3fa91c2e')).toBe('~/.orbit/codex-accounts/3fa91c2e');
    expect(tildePath('/Users/ada/.codex')).toBe('~/.codex');
    expect(tildePath('/srv/codex')).toBe('/srv/codex');
    expect(tildePath('/rootless/.codex')).toBe('/rootless/.codex');
  });
});
