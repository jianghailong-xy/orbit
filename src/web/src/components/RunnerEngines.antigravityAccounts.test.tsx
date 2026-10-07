// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsageBucket, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { MachineEngines, RunnerEngines, summaryOf } from './RunnerEngines';
import { openRunnerMenu, clickRunnerMenuItem } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * Several Antigravity (Google) accounts on one runner, kept the way Claude Code's and Codex's are
 * (docs/mocks/antigravity-accounts/04-web-providers.png): Default and every account added, each its
 * own row with its own sign-in and its own quota — agy's buckets, read as what is left — NEXT on the
 * one Automatic starts, and "Add account" only where the runner can add a Google account at all. The
 * runner's own page draws the same rows.
 *
 * Built here rather than in the clients' shared fixtures, which describe a runner before accounts.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

/** Ahead of whenever this runs, so no reading is about a window already over. */
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const bucket = (id: string, window: string, remainingFraction: number, hours: number): PlanUsageBucket => ({
  id,
  window,
  remainingFraction,
  resetTime: inHours(hours),
});

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.orbit/antigravity/google', auth: 'yes' };
const WORK: RunnerEngineAccount = {
  id: '5c2e91a0',
  name: 'Work',
  home: '/root/.orbit/antigravity-accounts/5c2e91a0',
  auth: 'yes',
};

/** Default's four buckets, its week resetting first; Work's gemini-5h has 4% left. */
const DEFAULT_BUCKETS = [
  bucket('gemini-weekly', 'weekly', 1, 30),
  bucket('gemini-5h', '5h', 1, 3),
  bucket('3p-weekly', 'weekly', 0.98, 30),
  bucket('3p-5h', '5h', 1, 3),
];
const WORK_BUCKETS = [
  bucket('gemini-weekly', 'weekly', 0.61, 60),
  bucket('gemini-5h', '5h', 0.04, 2),
  bucket('3p-weekly', 'weekly', 1, 60),
  bucket('3p-5h', '5h', 1, 2),
];

/** The engine as the runner reports it: every account, and their quota on the engine's own health. */
const antigravity = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'antigravity',
  installed: true,
  version: '1.3.0',
  auth: 'yes',
  authSource: 'google',
  accounts: [DEFAULT, WORK],
  planUsage: {
    provider: 'antigravity',
    fetchedAt: inHours(-0.1),
    buckets: DEFAULT_BUCKETS,
    accounts: { [WORK.id]: { provider: 'antigravity', fetchedAt: inHours(-0.1), buckets: WORK_BUCKETS } },
  },
  ...over,
});

/** A runner that runs agy on its own GEMINI_API_KEY: the engine is in on the key, its Default — the
 *  Google sign-in alone — is not, and Default has no buckets (only a signed-in Default reports any). */
const envKey = (accounts: RunnerEngineAccount[]): RunnerEngineHealth =>
  antigravity({
    authSource: 'env_key',
    accounts,
    planUsage: {
      provider: 'antigravity',
      accounts: { [WORK.id]: { provider: 'antigravity', fetchedAt: inHours(-0.1), buckets: WORK_BUCKETS } },
    },
  });

const LOGIN_CAPABILITIES = ['antigravity-google-login/v1', 'antigravity-account-login/v1', 'antigravity-account-remove/v1'];

const runner = (engine: RunnerEngineHealth = antigravity(), over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'HPC',
  online: true,
  capabilities: LOGIN_CAPABILITIES,
  antigravity: {
    supported: true,
    installed: true,
    version: '1.3.0',
    envKeyAvailable: true,
    authSource: engine.authSource ?? null,
    googleLogin: 'available',
  },
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.291' },
    { engine: 'codex', installed: true, auth: 'yes', version: '0.160.1' },
    { engine: 'kimi', installed: true, auth: 'yes', version: '2.1.1' },
    engine,
  ],
  ...over,
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

function mount(r: Runner) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([r.id]));
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/runners') return [r];
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    return { status: 'pending', engine: 'antigravity', url: null, userCode: null, message: null };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [r]);
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
const engineRow = (page: ParentNode) => page.querySelector<HTMLElement>('[data-engine="antigravity"]')!;
const accountRows = (page: ParentNode) => all(page, '.re-acct');
const tags = (row: Element) => all(row, '.ant-tag').map((tag) => tag.textContent?.trim());
const labelOf = (b: Element) => b.textContent?.trim() || b.getAttribute('aria-label');
const buttons = (row: Element) => all(row, ':scope > .re-act button').map(labelOf);
const button = (el: ParentNode, label: string) => {
  const found = all(el, 'button').find((b) => labelOf(b) === label);
  if (!found) throw new Error(`no "${label}" button in ${(el as Element).textContent}`);
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
/** Each window a row draws: agy's bucket, its window and what is left of it. */
const windows = (row: Element) =>
  all(row, '.re-window').map((w) => all(w, '.re-quota-head').map((head) => head.textContent).join(' '));

describe('two Google accounts on one runner', () => {
  it('groups them under Antigravity like Claude Code’s, each with its own quota, NEXT on the one Automatic starts', () => {
    const page = mount(runner());
    const head = engineRow(page);
    expect(head.className).toContain('re-grp');
    expect(head.querySelector('.re-meta')?.textContent).toBe('1.3.0 · 2 of 2 accounts available');
    // The head owns what is the engine's: no tag, no quota of its own, and the Google terms note under it.
    expect(tags(head)).toEqual([]);
    expect(head.querySelector(':scope > .re-quota')).toBeNull();
    expect(head.querySelector('.re-login-note a')?.getAttribute('href')).toBe('https://antigravity.google/terms');
    expect(head.textContent).not.toContain('Google account');
    expect(buttons(head)).toEqual(['Add account']);

    const [defaultRow, workRow] = accountRows(page);
    expect(accountRows(page)).toHaveLength(2);
    // Work's gemini-5h is nearly spent, so a session nobody picked an account for starts on Default.
    expect([defaultRow, workRow].map((row) => row.querySelector('.re-name')?.textContent)).toEqual(['DefaultNEXT', 'Work']);
    expect([defaultRow, workRow].map((row) => row.querySelector('.re-meta')?.textContent)).toEqual([
      '~/.orbit/antigravity/google',
      '~/.orbit/antigravity-accounts/5c2e91a0',
    ]);
    expect([defaultRow, workRow].map(tags)).toEqual([['Available'], ['Available']]);
    // Each its own four buckets, by what is left: Default's from the engine's own, Work's from its entry.
    expect(windows(defaultRow)).toEqual([
      'gemini-weekly Weekly100% remaining',
      'gemini-5h 5-hour100% remaining',
      '3p-weekly Weekly98% remaining',
      '3p-5h 5-hour100% remaining',
    ]);
    expect(windows(workRow)).toEqual([
      'gemini-weekly Weekly61% remaining',
      'gemini-5h 5-hour4% remaining',
      '3p-weekly Weekly100% remaining',
      '3p-5h 5-hour100% remaining',
    ]);
    expect(all(workRow, '.runner-util.full')).toHaveLength(1);
    expect(all(defaultRow, '.runner-util.full')).toHaveLength(0);
  });

  it('counts a spent account out of the head, and says when it comes back', () => {
    const spent = WORK_BUCKETS.map((b) => (b.id === 'gemini-5h' ? { ...b, remainingFraction: 0 } : b));
    const page = mount(
      runner(
        antigravity({
          planUsage: {
            provider: 'antigravity',
            buckets: DEFAULT_BUCKETS,
            accounts: { [WORK.id]: { provider: 'antigravity', buckets: spent } },
          },
        }),
      ),
    );
    expect(engineRow(page).querySelector('.re-meta')?.textContent).toBe('1.3.0 · 1 of 2 accounts available');
    expect(tags(accountRows(page)[1])[0]).toMatch(/^Spent · resets /);
  });

  it('adds another account as a Google sign-in of its own, named as it is added', async () => {
    const page = mount(runner());
    const open = vi.spyOn(window, 'open');
    await click(button(engineRow(page), 'Add account'));
    expect(page.querySelector<HTMLInputElement>('.re-add input')?.value).toBe('Account 3');
    expect(loginPosts()).toEqual([{ engine: 'antigravity', accountName: 'Account 3' }]);
    // The terms stay in view above the panel while its sign-in starts.
    expect(engineRow(page).querySelector('.re-login-note')?.textContent).toContain('Google terms');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('signs a signed-out account back in with Google, naming the account', async () => {
    const page = mount(runner(antigravity({ accounts: [DEFAULT, { ...WORK, auth: 'no' }] })));
    const workRow = accountRows(page)[1];
    expect(tags(workRow)).toEqual(['Signed out']);
    expect(workRow.querySelector('.re-quota')?.textContent).toBe('Sign in to see quota');
    await click(button(workRow, 'Sign in'));
    expect(workRow.querySelector('.rsi')?.textContent).toContain('Google terms');
    const popup = { document: { write: vi.fn(), close: vi.fn() }, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    await click(button(workRow, 'Sign in with Google'));
    expect(loginPosts()).toEqual([{ engine: 'antigravity', account: WORK.id }]);
    open.mockRestore();
  });

  it('re-signs in, renames, pauses and removes from each account’s menu — never removing Default', async () => {
    const page = mount(runner());
    const [defaultRow, workRow] = accountRows(page);
    expect(buttons(defaultRow)).toEqual(['More actions']);
    const items = async (row: HTMLElement) =>
      all(await openRunnerMenu(row), '[role="menuitem"]').map((item) => item.textContent?.trim());
    expect(await items(defaultRow)).toEqual(['Rename', 'Re-sign in', 'Pause account…']);
    expect(await items(workRow)).toEqual(['Rename', 'Re-sign in', 'Pause account…', 'Remove account']);

    await clickRunnerMenuItem(workRow, 'Remove account');
    let ok: HTMLButtonElement | undefined;
    await act(async () => {
      await vi.waitFor(() => {
        ok = all(document, '.ant-popconfirm button').find((b) => b.textContent?.trim() === 'Remove') as HTMLButtonElement;
        expect(ok).toBeDefined();
      }, { timeout: 20_000, interval: 20 });
    });
    await click(ok!);
    expect(
      apiMock.mock.calls.filter(([path, options]) => String(path).includes('/accounts/') && options?.method === 'DELETE').map(([path]) => path),
    ).toEqual([`/runners/${RUNNER_ID}/accounts/antigravity/${WORK.id}`]);
  });

  it('counts a signed-out account against the folded card', () => {
    expect(summaryOf(runner())).toBe('All signed in');
    expect(summaryOf(runner(antigravity({ accounts: [DEFAULT, { ...WORK, auth: 'no' }] })))).toBe('3 of 4 signed in');
  });
});

describe('one Google account', () => {
  it('is one row, like Codex’s: signed in with its quota, and Add account beside its menu', () => {
    const page = mount(runner(antigravity({ accounts: [DEFAULT] })));
    const row = engineRow(page);
    expect(row.className).not.toContain('re-grp');
    expect(accountRows(page)).toHaveLength(0);
    // No "· Google account" after its version: one account of any engine reads the same.
    expect(row.querySelector('.re-meta')?.textContent).toBe('1.3.0');
    expect(tags(row)).toEqual(['Available']);
    expect(windows(row)[0]).toBe('gemini-weekly Weekly100% remaining');
    expect(buttons(row)).toEqual(['Add account', 'More actions']);
    expect(row.querySelector('.re-login-note')?.textContent).toContain('Google terms');
  });

  it('keeps Sign in with Google beside Add account while it is signed out', () => {
    const page = mount(runner(antigravity({ auth: 'no', accounts: [{ ...DEFAULT, auth: 'no' }], planUsage: undefined })));
    const row = engineRow(page);
    expect(tags(row)).toEqual(['Signed out']);
    expect(buttons(row)).toEqual(['Add account', 'Sign in with Google']);
  });

  it.each([
    ['no runner support for accounts', { capabilities: ['antigravity-google-login/v1'] }, null],
    [
      'a macOS runner',
      { antigravity: { supported: true, installed: true, version: '1.3.0', envKeyAvailable: true, authSource: 'google', googleLogin: 'unsupported_platform' } },
      'Google sign-in is not supported on macOS runners yet. Use a Gemini API key.',
    ],
    [
      'an older runner',
      { antigravity: { supported: true, installed: true, version: '1.3.0', envKeyAvailable: true, authSource: 'google', googleLogin: 'needs_update' } },
      'Update this runner to sign in with Google.',
    ],
    [
      'a runner that never declared Antigravity',
      { antigravity: { supported: false, installed: true, version: '1.3.0', envKeyAvailable: true, authSource: 'google', googleLogin: 'available' } },
      null,
    ],
  ] as const)('offers no Add account on %s', (_name, over, hint) => {
    const page = mount(runner(antigravity({ accounts: [DEFAULT] }), over as Partial<Runner>));
    const row = engineRow(page);
    expect(buttons(row)).not.toContain('Add account');
    if (hint) expect(row.querySelector('.re-login-note')?.textContent).toBe(hint);
  });
});

describe('a runner that runs agy on its Gemini key', () => {
  it('shows Default as the key it runs on — never signed out — and counts it available', async () => {
    const box = runner(envKey([{ ...DEFAULT, auth: 'no' }, WORK]));
    const page = mount(box);
    expect(engineRow(page).querySelector('.re-meta')?.textContent).toBe('1.3.0 · 2 of 2 accounts available');
    const [defaultRow, workRow] = accountRows(page);
    expect(tags(defaultRow)).toEqual(['Signed in']);
    expect(defaultRow.querySelector('.re-quota')?.textContent).toBe('env key · runs on your Gemini key');
    // Nothing to sign in or pause: it is no Google sign-in at all.
    expect(buttons(defaultRow)).toEqual(['More actions']);
    expect(all(await openRunnerMenu(defaultRow), '[role="menuitem"]').map((item) => item.textContent?.trim())).toEqual(['Rename']);
    // Automatic starts on a Google account, the only one with a quota to spend first.
    expect([defaultRow, workRow].map((row) => row.querySelector('.re-name')?.textContent)).toEqual(['Default', 'WorkNEXT']);
    expect(summaryOf(box)).toBe('All signed in');
  });

  it('keeps its one row as it was: env key, with no pause to offer', () => {
    const page = mount(runner(envKey([{ ...DEFAULT, auth: 'no' }])));
    const row = engineRow(page);
    expect(row.textContent).toContain('env key · runs on your Gemini key');
    expect(row.querySelector('[aria-label="More actions"]')).toBeNull();
  });
});

describe('the runner page’s Antigravity rows', () => {
  /** What the runner's own page draws: the card's rows, as MachineEngines lays them out there. */
  const machinePage = (r: Runner) => {
    const box = document.createElement('div');
    box.innerHTML = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MachineEngines runner={r} signIn={null} onSignIn={() => {}} machinePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return box;
  };
  /** Antigravity's head and each account under it, as each row reads. */
  const rows = (page: ParentNode) => [engineRow(page), ...accountRows(page)].map((row) => row.textContent);

  it.each([
    ['one Google account', runner(antigravity({ accounts: [DEFAULT] }))],
    ['two, Default the next', runner()],
    ['one of them signed out', runner(antigravity({ accounts: [DEFAULT, { ...WORK, auth: 'no' }] }))],
    ['a machine on its Gemini key', runner(envKey([{ ...DEFAULT, auth: 'no' }, WORK]))],
  ])('are the card’s own: %s', (_, r) => {
    expect(rows(machinePage(r))).toEqual(rows(mount(r)));
  });
});
