// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
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

/** Default's five-hour window, and Work's own under the Claude snapshot's `accounts`. */
const CLAUDE_USAGE = {
  claude: {
    provider: 'claude',
    fiveHour: { utilization: 12, resetsAt: '2026-09-26T20:00:00.000Z' },
    accounts: {
      [WORK.id]: { provider: 'claude', fiveHour: { utilization: 44, resetsAt: '2026-09-26T21:00:00.000Z' } },
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
    expect(head.querySelector('.re-meta')?.textContent).toContain('2 accounts');
    // The head keeps what the engine owns and says nothing for its accounts: no tag, no quota.
    expect(tags(head)).toEqual([]);
    expect(head.querySelector('.re-quota')?.textContent).toBe('');

    const accounts = rows(page, '.re-acct');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((row) => row.querySelector('.re-name')?.textContent)).toEqual([
      'DefaultDEFAULT',
      'Work',
    ]);
    expect(accounts.map(tags)).toEqual([['Signed in'], ['Signed out']]);
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

  it('removes an added account on its own route, and never Default', async () => {
    const page = mount([runner({ accounts: [DEFAULT, WORK] })]);
    const [defaultRow, workRow] = rows(page, '.re-acct');
    expect(button(defaultRow, 'Re-sign in')).toBeTruthy();
    expect(rows(defaultRow, 'button').map((b) => b.textContent?.trim())).not.toContain('Remove');

    await click(button(workRow, 'Remove'));
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
