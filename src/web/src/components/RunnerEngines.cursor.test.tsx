// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsageSnapshot, RunnerEngineAccount, RunnerEngineHealth, RunnerLoginState } from '@orbit/shared';
import { RunnerEngines, summaryOf } from './RunnerEngines';
import { openRunnerCards } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Cursor CLI on a machine's card (the owner's board, docs/mocks/cursor-engine Web 2 and Web 3): its row
 * last, after DeepSeek Harness, once a runner of the account knows it; the pinned version; each account
 * with the plan Cursor names and what Cursor reports of it — a reading only above 0, "Usage unavailable"
 * otherwise, never 0% — and the states a machine can be in: a runner that predates Cursor CLI, a build
 * other than the pinned one, a platform it doesn't run on, none installed, signed out.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const OLD_ID = '33zx0JhRhJo8rd25d3qAN';
const PIN = '2026.10.14-941492e';
const TEAM = '5c2e91a0';
const CAPS = ['provider:dsh', 'provider:cursor', 'cursor-account-login/v1', 'cursor-account-remove/v1'];

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' };
const TEAM_ACCOUNT: RunnerEngineAccount = { id: TEAM, name: 'Team', home: `/root/.orbit/cursor-accounts/${TEAM}`, auth: 'yes' };

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const inHours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

const cursor = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'cursor',
  installed: true,
  version: PIN,
  auth: 'yes',
  update: { status: 'checked', at: minutesAgo(6), okAt: minutesAgo(6), latest: PIN },
  accounts: [DEFAULT, TEAM_ACCOUNT],
  ...over,
});

/** P6a's reading: Default on the Free plan, which reports no share used; Team on Pro at 34%. */
const usage = (defaultOver: Partial<PlanUsageSnapshot> = {}): Runner['planUsage'] => ({
  cursor: {
    provider: 'cursor' as never,
    account: 'default',
    planName: 'Free',
    includedUsage: { startsAt: minutesAgo(20 * 1440), resetsAt: inHours(120) },
    fetchedAt: minutesAgo(4),
    ...defaultOver,
    accounts: {
      [TEAM]: {
        provider: 'cursor' as never,
        account: TEAM,
        planName: 'Pro',
        includedUsage: { period: 'monthly', startsAt: minutesAgo(10 * 1440), resetsAt: inHours(100), percentUsed: 34 },
        fetchedAt: minutesAgo(4),
      },
    },
  },
});

const runner = (engine: RunnerEngineHealth | null = cursor(), over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  capabilities: CAPS,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.302' },
    { engine: 'codex', installed: true, auth: 'yes', version: '0.164.0' },
    { engine: 'kimi', installed: true, auth: 'yes', version: '2.1.4' },
    { engine: 'dsh', installed: true, auth: 'unknown', version: '0.2.0' },
    ...(engine ? [engine] : []),
  ],
  planUsage: usage(),
  ...over,
});

const IDLE: RunnerLoginState = { status: null, engine: null, url: null, userCode: null, message: null, account: null };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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
  document.body.innerHTML = '';
});

/** The Infrastructure section over these runners, every card open — and its accounts, unless `folded`. */
function mount(runners: Runner[], { folded = false } = {}) {
  if (folded) localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  else openRunnerCards(runners);
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/runners') return runners;
    if (path.endsWith('/login')) return IDLE;
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  for (const r of runners) qc.setQueryData(['runner-login', r.id], IDLE);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/infrastructure']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const all = (el: ParentNode, selector: string) => [...el.querySelectorAll<HTMLElement>(selector)];
const cursorRow = (page: ParentNode) => {
  const row = page.querySelector<HTMLElement>('[data-engine="cursor"]');
  if (!row) throw new Error('no Cursor CLI row');
  return row;
};
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const tags = (row: Element) => all(row, ':scope > .re-status').map((status) => text(status)).filter(Boolean);
const labelOf = (b: Element) => b.textContent?.trim() || b.getAttribute('aria-label');
const buttons = (row: Element) => all(row, ':scope > .re-act button').map(labelOf);
/** Each window a row draws: its name and how much of it is used. */
const windows = (row: Element) =>
  all(row, '.re-window').map((w) => all(w, '.re-quota-head > *').map((el) => text(el)).join(' '));
const accountRow = (page: ParentNode, name: string) => {
  const row = all(page, '.re-acct').find((r) => r.querySelector('.re-name-text')?.textContent === name);
  if (!row) throw new Error(`no ${name} row`);
  return row;
};

describe('Cursor CLI on a machine’s card', () => {
  it('has no row while no runner of the account knows it, and the card is what it was', () => {
    const old = runner(null, { capabilities: ['provider:dsh'] });
    const page = mount([old]);
    expect(page.querySelector('[data-engine="cursor"]')).toBeNull();
    expect(summaryOf(old)).toBe('All signed in');
  });

  it('comes last, after DeepSeek Harness, with the pinned version, the accounts it can run on and Add account', () => {
    const page = mount([runner()], { folded: true });
    const rows = all(page, '.re-row:not(.re-acct)').map((r) => r.getAttribute('data-engine') ?? r.textContent);
    expect(rows.at(-1)).toBe('cursor');
    const row = cursorRow(page);
    expect(text(row.querySelector('.re-meta'))).toContain(`${PIN} · 2 of 2 accounts available`);
    // Cursor CLI does not follow Cursor's releases: the build is Orbit's pin.
    expect(text(row.querySelector('.re-upd'))).toBe('pinned · checked 6m ago');
    // Folded, the head speaks for the account a new session starts on: Team, which has a reading.
    expect(text(row.querySelector('.re-quota-next'))).toBe('Next: Team');
    expect(windows(row)).toEqual(['Monthly limit 34%']);
    expect(buttons(row)).toContain('Add account');
  });

  it('lists each account with its plan first, and Cursor’s reading only above 0 — “Usage unavailable”, never 0%', () => {
    const page = mount([runner()]);
    const def = accountRow(page, 'Default');
    expect(text(def.querySelector('.re-meta'))).toBe('Free plan · ~/.orbit/cursor/default');
    expect(tags(def)).toEqual(['Signed in']);
    expect(all(def, '.re-quota > *').map((el) => text(el))).toEqual(['Free plan', 'Usage unavailable']);
    expect(def.querySelector('.re-quota')?.textContent).not.toContain('0%');
    const team = accountRow(page, 'Team');
    expect(text(team.querySelector('.re-meta'))).toBe(`Pro plan · ~/.orbit/cursor-accounts/${TEAM}`);
    expect(tags(team)).toEqual(['Available']);
    expect(windows(team)).toEqual(['Monthly limit 34%']);
  });

  it('says an account is spent once a turn on it met Cursor’s limit, until its usage comes back', () => {
    const page = mount([runner(cursor(), { planUsage: usage({ includedUsage: { startsAt: minutesAgo(20 * 1440), resetsAt: inHours(120), limitReachedAt: minutesAgo(30) } }) })]);
    const def = accountRow(page, 'Default');
    expect(tags(def)[0]).toMatch(/^Spent · resets /);
    // …and the folded head counts it out.
    expect(text(cursorRow(page).querySelector('.re-meta'))).toContain('1 of 2 accounts available');
  });

  it('offers Add account only on a runner that signs a named Cursor account into its own directory', () => {
    const page = mount([runner(cursor({ accounts: [DEFAULT] }), { capabilities: ['provider:cursor'] })]);
    expect(buttons(cursorRow(page))).not.toContain('Add account');
  });

  it('says a machine that predates Cursor CLI needs its runner updated, beside one that knows it', () => {
    const old = { ...runner(null, { capabilities: ['provider:dsh'] }), id: OLD_ID, name: 'mac-studio' };
    const page = mount([runner(), old]);
    const row = all(page, '[data-engine="cursor"]')[1];
    expect(tags(row)).toEqual(['Update runner']);
    expect(text(row.querySelector('.re-quota'))).toBe('—');
    expect(buttons(row)).toEqual([]);
    expect(text(row.querySelector('.re-login-note'))).toBe(
      'This runner predates Cursor CLI. It updates itself when no session is running on it.',
    );
    // A machine with nothing of Cursor CLI to sign in counts none.
    expect(summaryOf(old)).toBe('All signed in');
  });

  it('offers to install the pinned build where none is, and to put it back over another build', async () => {
    const missing = runner(
      { engine: 'cursor', installed: false, auth: 'unknown', installationError: `CURSOR_NOT_INSTALLED: Cursor CLI ${PIN} is not installed in Orbit's version directory` },
      { capabilities: ['provider:dsh'] },
    );
    let page = mount([missing]);
    let row = cursorRow(page);
    expect(text(row.querySelector('.re-meta'))).toBe('Not installed — Orbit can install it here');
    expect(tags(row)).toEqual(['Not installed']);
    // Not signed in on the machine, as any engine it hasn't installed.
    expect(summaryOf(missing)).toBe('3 of 4 signed in');
    await act(async () => all(row, 'button').find((b) => labelOf(b) === 'Install')!.click());
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER_ID}/install`, { method: 'POST', body: { engine: 'cursor' } });

    act(() => root?.unmount());
    host?.remove();
    const other = runner(
      cursor({
        version: '2026.10.16-e3cb207',
        auth: 'unknown',
        installationError: `CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly ${PIN}`,
        accounts: [{ ...DEFAULT, auth: 'unknown' }],
      }),
      { capabilities: ['provider:dsh', 'cursor-account-login/v1'] },
    );
    page = mount([other]);
    row = cursorRow(page);
    expect(text(row.querySelector('.re-meta'))).toBe('2026.10.16-e3cb207 · pinned · checked 6m ago');
    expect(tags(row)).toEqual(['Unsupported version']);
    expect(buttons(row)).toContain('Reinstall');
    expect(buttons(row)).not.toContain('Sign in');
    expect(text(row.querySelector('.re-login-note'))).toBe(
      `Orbit runs Cursor CLI ${PIN}. Reinstall puts that version back on this runner; sessions here can’t start until then.`,
    );
  });

  it('names a platform the pinned build doesn’t run on in the runner’s own words', () => {
    const mac = runner(
      {
        engine: 'cursor',
        installed: false,
        auth: 'unknown',
        installationError: `CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI ${PIN} only on linux/amd64 runners; this runner is darwin/arm64`,
      },
      { capabilities: ['provider:dsh'] },
    );
    const page = mount([mac]);
    const row = cursorRow(page);
    expect(tags(row)).toEqual(['Not supported here']);
    // Nothing of Cursor CLI to sign in there, so the machine's count leaves it out.
    expect(summaryOf(mac)).toBe('All signed in');
    expect(buttons(row)).toEqual([]);
    expect(text(row.querySelector('.re-login-note'))).toBe(
      `Orbit runs Cursor CLI ${PIN} only on linux/amd64 runners; this runner is darwin/arm64.`,
    );
  });

  it('says a signed-out Default costs the machine its Cursor CLI sessions, with its Sign in', () => {
    const r = runner(cursor({ auth: 'no', accounts: [{ ...DEFAULT, auth: 'no' }] }));
    const page = mount([r]);
    const row = cursorRow(page);
    expect(tags(row)).toEqual(['Signed out']);
    expect(text(row.querySelector('.re-quota'))).toBe('Sign in to see quota');
    expect(buttons(row)).toEqual(expect.arrayContaining(['Add account', 'Sign in']));
    expect(text(row.querySelector('.re-dup'))).toBe('Sessions on this runner can’t use Cursor CLI until you sign in again.');
    expect(summaryOf(r)).toBe('3 of 4 signed in');
  });
});
