// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KIMI_LOGIN_REGION_V1,
  type KimiRegion,
  type PlanUsageSnapshot,
  type RunnerEngineAccount,
  type RunnerEngineHealth,
  type RunnerLoginState,
} from '@orbit/shared';
import { KIMI_ACCOUNT_LOGIN_CAPABILITY } from '../lib/engineAccounts';
import { RunnerEngines, summaryOf } from './RunnerEngines';
import { clickRunnerMenuItem, openRunnerCards } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Several Kimi Code accounts on one runner (docs/mocks/kimi-accounts/01-web.png): "+ Add account" on
 * the Kimi row where the runner keeps Kimi accounts apart (kimi-account-login/v1), a panel that asks
 * for the site before it signs anything in, a device code that names the site of the account being
 * added, each account's row saying its site before its directory, Re-sign in marking the account's own
 * site Current, and each account's own quota — its 5-hour, weekly and monthly windows — in the same
 * quota column Claude Code's and Codex's accounts use.
 *
 * Mounted into a real DOM and pressed through to the mocked `api()`: what a press sends — which name,
 * which account, which site — is what matters, and a static render cannot press anything.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const KEEPS_KIMI_ACCOUNTS = [KIMI_LOGIN_REGION_V1, KIMI_ACCOUNT_LOGIN_CAPABILITY, 'kimi-account-remove/v1'];

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.kimi-code', auth: 'yes', kimiRegion: 'global' };
const WORK: RunnerEngineAccount = {
  id: '5c2e91a0',
  name: 'Work',
  home: '/root/.orbit/kimi-accounts/5c2e91a0',
  auth: 'yes',
  kimiRegion: 'mainland-cn',
};

/** Kimi Code as the runner reports it: Default's site is the engine's own. */
const kimi = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'kimi',
  installed: true,
  version: '2.1.1',
  auth: 'yes',
  kimiRegion: 'global',
  accounts: [DEFAULT, WORK],
  ...over,
});

const runner = (engine: RunnerEngineHealth = kimi(), over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'HPC',
  online: true,
  capabilities: KEEPS_KIMI_ACCOUNTS,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.294' },
    { engine: 'codex', installed: true, auth: 'yes', version: '0.161.0' },
    engine,
  ],
  ...over,
});

/** Ahead of whenever this runs, so no reading is about a window already over. */
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
/** One Kimi account's four windows, as used shares (`used_ratio × 100`), from the managed /usages. */
const usages = (fiveHour: number, sevenDay: number, month: number, monthCode: number): PlanUsageSnapshot => ({
  provider: 'kimi',
  fetchedAt: inHours(-0.05),
  fiveHour: { utilization: fiveHour, resetsAt: inHours(3) },
  sevenDay: { utilization: sevenDay, resetsAt: inHours(70) },
  month: { utilization: month, resetsAt: inHours(400) },
  monthCode: { utilization: monthCode, resetsAt: inHours(400) },
});
/** The heartbeat's planUsage.kimi: Default's windows as the snapshot's own, Work's under `accounts`. */
const withQuota = (own: PlanUsageSnapshot, work: PlanUsageSnapshot, r: Runner = runner()): Runner => ({
  ...r,
  planUsage: { kimi: { ...own, accounts: { [WORK.id]: work } } },
});

const IDLE: RunnerLoginState = { status: null, engine: null, url: null, userCode: null, message: null, account: null };
/** The device step a start on `region` reaches: the page of that site, with its one-time code. */
const deviceStep = (region: KimiRegion | undefined): RunnerLoginState => ({
  ...IDLE,
  status: 'awaiting_approval',
  engine: 'kimi',
  url: `https://www.${region === 'global' ? 'kimi.ai' : 'kimi.com'}/code/authorize_device?user_code=7K06-QP86`,
  userCode: '7K06-QP86',
});

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

/** The Providers section over this runner, its card open — and its accounts too, unless `folded`. A
 *  start reaches the device step of the site it names at once, as the runner reports it a beat later. */
function mount(r: Runner, { folded = false } = {}) {
  if (folded) localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([r.id]));
  else openRunnerCards([r]);
  let login = IDLE;
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/runners') return [r];
    if (path.endsWith('/login')) {
      if (options?.method === 'POST') login = deviceStep((options.body as { region?: KimiRegion }).region);
      if (options?.method === 'DELETE') login = IDLE;
      return login;
    }
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [r]);
  qc.setQueryData(['runner-login', r.id], IDLE);
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

const all = (el: ParentNode, selector: string) => [...el.querySelectorAll<HTMLElement>(selector)];
const kimiRow = (page: ParentNode) => {
  const row = page.querySelector<HTMLElement>('[data-engine="kimi"]');
  if (!row) throw new Error('no Kimi row');
  return row;
};
const accountRows = (page: ParentNode) => all(page, '.re-acct');
const accountRow = (page: ParentNode, name: string) => {
  const row = accountRows(page).find((r) => r.querySelector('.re-name-text')?.textContent === name);
  if (!row) throw new Error(`no ${name} row`);
  return row;
};
/** What a row says of its state: the words in its status slot. */
const tags = (row: Element) => all(row, '.re-status').map((status) => status.textContent?.trim()).filter(Boolean);
const labelOf = (b: Element) => b.textContent?.trim() || b.getAttribute('aria-label');
/** The row's own buttons: its action column, not a panel open under it. */
const buttons = (row: Element) => all(row, ':scope > .re-act button').map(labelOf);
const button = (el: ParentNode, label: string) => {
  const found = all(el, 'button').find((b) => labelOf(b) === label);
  if (!found) throw new Error(`no "${label}" button in ${(el as Element).textContent}`);
  return found as HTMLButtonElement;
};
/** A site's button, by its domain. */
const site = (el: ParentNode, domain: string) => {
  const found = all(el, '.rsi-site').find((b) => b.querySelector('.rsi-site-name')?.firstChild?.textContent === domain);
  if (!found) throw new Error(`no ${domain} in ${(el as Element).textContent}`);
  return found as HTMLButtonElement;
};
/** Which site the card marks Current, if any. */
const current = (el: ParentNode) =>
  all(el, '.rsi-site').filter((b) => b.querySelector('.rsi-site-tag')).map((b) => b.querySelector('.rsi-site-name')?.firstChild?.textContent);
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
/** Types into an input as a user does, through React's own value tracking. */
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const loginPosts = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
    .map(([, options]) => options?.body);
/** The device step's hint, once the start that leads to it has landed: the relay's answer reaches the
 *  card a notification later than the press, which a loaded host can push past the press's own act. */
const showsHint = async (panel: ParentNode, hint: string) => {
  await act(async () => {
    await vi.waitFor(() => expect(panel.querySelector('.rsi > .rsi-hint')?.textContent).toBe(hint), {
      timeout: 20_000,
      interval: 20,
    });
  });
};
/** Each window a row draws: its name and how much of it is used. */
const windows = (row: Element) =>
  all(row, '.re-window').map((w) => all(w, '.re-quota-head').map((head) => head.textContent).join(' '));

describe('Add account on the Kimi row', () => {
  it('is offered beside the one account’s menu on a runner that keeps Kimi accounts apart', () => {
    const page = mount(runner(kimi({ accounts: [DEFAULT] })));
    const row = kimiRow(page);
    expect(row.className).not.toContain('re-grp');
    // One account is still one row, saying its site as it always has.
    expect(row.querySelector('.re-meta')?.textContent).toBe('2.1.1 · kimi.ai');
    expect(buttons(row)).toEqual(['Add account', 'More actions']);
  });

  it.each([
    ['signed in', 'yes', ['More actions']],
    ['signed out', 'no', ['Sign in']],
  ] as const)('is not offered on a runner too old to keep Kimi accounts apart (%s)', (_name, auth, expected) => {
    // Such a runner would take a named sign-in for a sign-in again, over Default.
    const page = mount(
      runner(kimi({ auth, accounts: [{ ...DEFAULT, auth }] }), { capabilities: [KIMI_LOGIN_REGION_V1] }),
    );
    expect(buttons(kimiRow(page))).toEqual(expected);
  });

  it('asks for the site before it starts, and the press on one starts it under the name', async () => {
    const page = mount(runner(kimi({ accounts: [DEFAULT] })));
    await click(button(kimiRow(page), 'Add account'));
    const panel = kimiRow(page).querySelector<HTMLElement>('.re-panel')!;
    expect(panel.querySelector<HTMLInputElement>('.re-add input')?.value).toBe('Account 2');
    expect(panel.querySelector('.rsi-q')?.textContent).toBe('Which Kimi account are you signing in with?');
    // Nothing starts on its own, and neither site is picked or marked: a new account has none yet.
    expect(loginPosts()).toEqual([]);
    expect(current(panel)).toEqual([]);
    expect(button(panel, 'Cancel')).toBeTruthy();

    await click(site(panel, 'kimi.com'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', accountName: 'Account 2', region: 'mainland-cn' }]);
  });

  it('leaves both sites unpressable while the account has no name', async () => {
    const page = mount(runner(kimi({ accounts: [DEFAULT] })));
    await click(button(kimiRow(page), 'Add account'));
    const panel = kimiRow(page).querySelector<HTMLElement>('.re-panel')!;
    const name = panel.querySelector<HTMLInputElement>('.re-add input')!;
    await type(name, '  ');
    expect([site(panel, 'kimi.com').disabled, site(panel, 'kimi.ai').disabled]).toEqual([true, true]);
    await type(name, 'Personal');
    expect([site(panel, 'kimi.com').disabled, site(panel, 'kimi.ai').disabled]).toEqual([false, false]);
    await click(site(panel, 'kimi.ai'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', accountName: 'Personal', region: 'global' }]);
  });

  it('names the site in the device code, and starts over on the other site under the same name', async () => {
    const page = mount(runner(kimi({ accounts: [DEFAULT] })));
    await click(button(kimiRow(page), 'Add account'));
    await click(site(kimiRow(page), 'kimi.com'));
    const panel = kimiRow(page).querySelector<HTMLElement>('.re-panel')!;
    await showsHint(panel, 'Sign in with the kimi.com account you are adding, then enter this one-time code:');
    expect(panel.querySelector('.rsi-usercode')?.textContent).toBe('7K06-QP86');
    expect(panel.querySelector('.rsi-open')?.textContent?.trim()).toBe('Copy Code & Open kimi.com');

    await click(button(panel, 'Use kimi.ai instead'));
    expect(loginPosts()).toEqual([
      { engine: 'kimi', accountName: 'Account 2', region: 'mainland-cn' },
      { engine: 'kimi', accountName: 'Account 2', region: 'global' },
    ]);
    await showsHint(panel, 'Sign in with the kimi.ai account you are adding, then enter this one-time code:');
  });
});

describe('two Kimi accounts on one runner', () => {
  it('groups them under Kimi Code, each row saying its site before its directory', () => {
    const page = mount(runner());
    const head = kimiRow(page);
    expect(head.className).toContain('re-grp');
    // The site is each account's now, so the head no longer says one.
    expect(head.querySelector('.re-meta')?.textContent).toBe('2.1.1 · 2 of 2 accounts available');
    expect(buttons(head)).toEqual(['Add account']);
    expect(head.querySelector(':scope > .re-quota')).toBeNull();

    const rows = accountRows(page);
    expect(rows.map((row) => row.querySelector('.re-name')?.textContent)).toEqual(['DefaultNEXT', 'Work']);
    expect(rows.map((row) => row.querySelector('.re-meta')?.textContent)).toEqual([
      'kimi.ai · ~/.kimi-code',
      'kimi.com · ~/.orbit/kimi-accounts/5c2e91a0',
    ]);
    expect(rows.map(tags)).toEqual([['Signed in'], ['Signed in']]);
    expect(rows.map((row) => row.querySelector('.re-quota')?.textContent)).toEqual(['No quota reported', 'No quota reported']);
    expect(rows.map(buttons)).toEqual([['More actions'], ['More actions']]);
  });

  it('folded, the head speaks for the account a new session starts on', () => {
    const page = mount(runner(), { folded: true });
    const head = kimiRow(page);
    expect(accountRows(page)).toHaveLength(0);
    expect(tags(head)).toEqual(['Signed in']);
    expect(head.querySelector('.re-quota')?.textContent).toBe('Next: DefaultNo quota reported');
  });

  it('signs an account in again on its own site: Current is Work’s kimi.com', async () => {
    const page = mount(runner());
    await clickRunnerMenuItem(accountRow(page, 'Work'), 'Re-sign in');
    const work = accountRow(page, 'Work');
    expect(work.querySelector('.rsi-q')?.textContent).toBe('Which Kimi account are you signing in with?');
    expect(current(work)).toEqual(['kimi.com']);
    // Moving it to the other site is the other press, naming the account.
    await click(site(work, 'kimi.ai'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', account: WORK.id, region: 'global' }]);
  });

  it('marks Default’s Current from the engine’s own site', async () => {
    // Default's login is the one the engine reports for itself: its row reads it from there.
    const page = mount(runner(kimi({ accounts: [{ ...DEFAULT, kimiRegion: undefined }, WORK] })));
    await clickRunnerMenuItem(accountRow(page, 'Default'), 'Re-sign in');
    expect(current(accountRow(page, 'Default'))).toEqual(['kimi.ai']);
  });

  it('a signed-out account has its own Sign in, on its own site, and is counted out', async () => {
    const out = runner(kimi({ accounts: [DEFAULT, { ...WORK, auth: 'no' }] }));
    const page = mount(out);
    expect(kimiRow(page).querySelector('.re-meta')?.textContent).toBe('2.1.1 · 1 of 2 accounts available');
    const work = accountRow(page, 'Work');
    expect(tags(work)).toEqual(['Signed out']);
    expect(work.querySelector('.re-quota')?.textContent).toBe('Sign in to see quota');
    expect(buttons(work)).toEqual(['Sign in', 'More actions']);
    expect(work.textContent).toContain('Sessions can’t use this account until you sign in again.');
    // Default's sessions carry on.
    expect(tags(accountRow(page, 'Default'))).toEqual(['Signed in']);

    await click(button(work, 'Sign in'));
    expect(current(work)).toEqual(['kimi.com']);
    await click(site(work, 'kimi.com'));
    expect(loginPosts()).toEqual([{ engine: 'kimi', account: WORK.id, region: 'mainland-cn' }]);
    expect(summaryOf(out)).toBe('2 of 3 signed in');
  });
});

describe('each Kimi account’s own quota', () => {
  it('shows its 5-hour, weekly and monthly windows in the quota column', () => {
    const page = mount(withQuota(usages(12, 34, 41, 30), usages(97, 20, 10, 5)));
    expect(kimiRow(page).querySelector('.re-meta')?.textContent).toBe('2.1.1 · 2 of 2 accounts available');
    const [defaultRow, workRow] = accountRows(page);
    expect(windows(defaultRow)).toEqual(['5h limit12%', 'Weekly limit34%', 'Monthly limit41%', 'Monthly · code30%']);
    expect(windows(workRow)).toEqual(['5h limit97%', 'Weekly limit20%', 'Monthly limit10%', 'Monthly · code5%']);
    expect(all(defaultRow, '.re-reset')).toHaveLength(4);
    // Work's 5-hour window is nearly spent: its bar says so, and a new session starts on Default.
    expect(all(workRow, '.runner-util.full')).toHaveLength(1);
    expect(all(defaultRow, '.runner-util.full')).toHaveLength(0);
    expect([defaultRow, workRow].map((row) => row.querySelector('.re-name')?.textContent)).toEqual(['DefaultNEXT', 'Work']);
    expect([defaultRow, workRow].map(tags)).toEqual([['Available'], ['Available']]);
  });

  it('folded, the head shows the next account’s window nearest its limit', () => {
    const page = mount(withQuota(usages(12, 34, 41, 30), usages(97, 20, 10, 5)), { folded: true });
    const head = kimiRow(page);
    expect(tags(head)).toEqual(['Available']);
    expect(head.querySelector('.re-quota-next')?.textContent).toBe('Next: Default');
    expect(windows(head)).toEqual(['Monthly limit41%']);
  });

  it('counts a spent account out of the head, and says when it comes back', () => {
    const page = mount(withQuota(usages(12, 34, 41, 30), usages(40, 100, 60, 20)));
    expect(kimiRow(page).querySelector('.re-meta')?.textContent).toBe('2.1.1 · 1 of 2 accounts available');
    expect(tags(accountRow(page, 'Work'))[0]).toMatch(/^Spent · resets /);
  });

  it('shows the windows on the one-account row too', () => {
    const page = mount({ ...runner(kimi({ accounts: [DEFAULT] })), planUsage: { kimi: usages(12, 34, 41, 30) } });
    const row = kimiRow(page);
    expect(tags(row)).toEqual(['Available']);
    expect(windows(row)).toEqual(['5h limit12%', 'Weekly limit34%', 'Monthly limit41%', 'Monthly · code30%']);
  });
});
