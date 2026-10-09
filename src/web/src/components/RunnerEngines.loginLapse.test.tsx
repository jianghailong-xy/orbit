// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { RunnerEngines } from './RunnerEngines';
import { openRunnerCards } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * An account's sign-in, said before it lapses and after it has, on the Providers page.
 *
 * Claude Code warns three days before a login lapses ("Your login expires in 3 days · run /login to
 * renew"); the runner reads the same expiry, so the page warns when the CLI would, with Renew beside
 * it. A signed-out account says what that costs: the account, or — the engine's only one there — the
 * engine on that machine. The sentences are the ones the design draws (docs/mocks/account-sign-in-ios
 * ②), quoted whole.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const DAY = 86_400_000;
const lapsesIn = (ms: number) => new Date(Date.now() + ms).toISOString();

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.claude', auth: 'yes', loginExpiresAt: lapsesIn(2 * DAY - 60_000) };
const WORK: RunnerEngineAccount = { id: '7c41e0b2', name: 'Work', home: '/root/.orbit/claude-accounts/7c41e0b2', auth: 'no' };
const LAB: RunnerEngineAccount = { id: 'b93d5a17', name: 'Lab', home: '/root/.orbit/claude-accounts/b93d5a17', auth: 'yes', loginExpiresAt: lapsesIn(10 * DAY) };

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({ engine: 'claude', installed: true, auth: 'yes', ...over });

const runner = (engines: RunnerEngineHealth[]): Runner => ({ id: RUNNER_ID, name: 'wikova', online: true, engines });

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
});

function mount(runners: Runner[]) {
  openRunnerCards(runners);
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
const notes = (el: ParentNode) => rows(el, '.re-dup').map((note) => note.textContent?.trim());

describe('a Claude account whose login is about to lapse', () => {
  it('says so three days out, with Renew beside it, and only on that account', () => {
    const page = mount([runner([health({ accounts: [DEFAULT, WORK, LAB] })])]);
    const [defaultRow, workRow, labRow] = rows(page, '.re-acct');

    const warning = defaultRow.querySelector('.re-dup.re-expiring');
    expect(warning?.textContent).toBe('Login expires in 2 daysRenew');
    // Ten days off is further than Claude Code warns, and a signed-out account has no login to lapse.
    expect(labRow.querySelector('.re-expiring')).toBeNull();
    expect(workRow.querySelector('.re-expiring')).toBeNull();
  });

  it('renews through the row’s own sign-in, into the same account', async () => {
    const page = mount([runner([health({ accounts: [DEFAULT, WORK, LAB] })])]);
    const [defaultRow] = rows(page, '.re-acct');
    const renew = rows(defaultRow, 'button').find((b) => b.textContent?.trim() === 'Renew')!;

    await act(async () => renew.click());

    expect(defaultRow.querySelector('.re-panel')?.textContent).toContain('Sign in to Claude Code');
  });
});

describe('a signed-out account', () => {
  it('says what it costs: the account, beside the others', () => {
    const page = mount([runner([health({ accounts: [DEFAULT, WORK, LAB] })])]);
    const [defaultRow, workRow] = rows(page, '.re-acct');

    expect(notes(workRow)).toEqual(['Sessions can’t use this account until you sign in again.']);
    expect(notes(defaultRow)).not.toContain('Sessions can’t use this account until you sign in again.');
  });

  it("says the engine can't run there when it is the engine's only account", () => {
    const page = mount([
      runner([
        health({ auth: 'no', accounts: [{ id: 'default', home: '/root/.claude', auth: 'no' }] }),
        health({ engine: 'kimi', auth: 'no' }),
      ]),
    ]);

    expect(notes(page)).toEqual([
      'Sessions on this runner can’t use Claude Code until you sign in again.',
      'Sessions on this runner can’t use Kimi Code until you sign in again.',
    ]);
  });
});
