// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { RunnerEngines } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * The same Codex account signed into two slots, on the Providers page.
 *
 * Two slots holding one account are two CODEX_HOMEs the runner reads on their own, so the page
 * would show two rows of quota that look unrelated — and quota does not double because an account
 * was signed in twice. The page says so, on the row that made the second copy, and offers the way
 * out of it. An unread fingerprint is not that: a slot nobody has read is not evidence of a copy.
 *
 * The sentence asserted here is the one the design draws (docs/mocks/providers-multi-codex-accounts
 * .png, note 5), so it is quoted whole rather than matched loosely.
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
  auth: 'yes',
  fingerprintPrefix: 'cxa1_2b7e9013',
};
const PERSONAL: RunnerEngineAccount = {
  id: '7c21de40',
  name: 'Personal',
  codexHome: '/root/.orbit/codex-accounts/7c21de40',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_4d5c8b26',
};
// The same two slots as an older runner reports them, or before anything has read a fingerprint for
// one: the field is absent entirely, which is not the same as two slots agreeing.
const DEFAULT_UNREAD: RunnerEngineAccount = {
  id: 'default',
  codexHome: '/root/.codex',
  auth: 'yes',
};
const WORK_UNREAD: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  codexHome: '/root/.orbit/codex-accounts/3fa91c2e',
  auth: 'yes',
};

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const runner = (accounts: RunnerEngineAccount[]): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [
    health({ engine: 'claude', version: '2.0.44' }),
    health({ engine: 'codex', version: '0.156.0', accounts }),
    health({ engine: 'kimi', version: '0.41.0' }),
  ],
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

/** Mount the section over this runner, its card open, the way a user who opened it sees it. */
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
const labels = (el: ParentNode) => rows(el, 'button').map((b) => b.textContent?.trim());
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

/** The account rows, in the order the page drew them. */
const accountsOf = (page: ParentNode) => rows(page, '.re-acct');

describe('one Codex account signed into two slots', () => {
  it('says it on the slot that signed in second, naming the slot the account is already on', () => {
    const page = mount([runner([DEFAULT, { ...WORK, fingerprintPrefix: DEFAULT.fingerprintPrefix }])]);
    const [defaultRow, workRow] = accountsOf(page);

    expect(workRow.querySelector('.re-dup')?.textContent).toContain(
      'This is the same account as Default — signing in twice does not double the quota.',
    );
    expect(button(workRow, 'Remove')).toBeTruthy();
    // Said once, and on the later row: Default is where the account was signed in first, and
    // nothing about it is a repeat.
    expect(defaultRow.querySelector('.re-dup')).toBeNull();
    expect(labels(defaultRow)).not.toContain('Remove');
    expect(rows(page, '.re-dup')).toHaveLength(1);
  });

  it('names the slot that made the first sign-in, whichever one it was', () => {
    // Default is a different account here: the repeat is Work's, signed in again as Personal.
    const page = mount([runner([DEFAULT, WORK, { ...PERSONAL, fingerprintPrefix: WORK.fingerprintPrefix }])]);
    const [defaultRow, workRow, personalRow] = accountsOf(page);

    expect(defaultRow.querySelector('.re-dup')).toBeNull();
    expect(workRow.querySelector('.re-dup')).toBeNull();
    expect(personalRow.querySelector('.re-dup')?.textContent).toContain(
      'This is the same account as Work — signing in twice does not double the quota.',
    );
    expect(button(personalRow, 'Remove')).toBeTruthy();
  });

  it('says it on every slot that repeats an account, not just the first repeat', () => {
    const page = mount([
      runner([
        DEFAULT,
        { ...WORK, fingerprintPrefix: DEFAULT.fingerprintPrefix },
        { ...PERSONAL, fingerprintPrefix: DEFAULT.fingerprintPrefix },
      ]),
    ]);
    const [, workRow, personalRow] = accountsOf(page);

    for (const row of [workRow, personalRow]) {
      expect(row.querySelector('.re-dup')?.textContent).toContain('This is the same account as Default —');
      expect(button(row, 'Remove')).toBeTruthy();
    }
  });

  it('still draws the second slot its own row, sign-in and quota', () => {
    const page = mount([runner([DEFAULT, { ...WORK, fingerprintPrefix: DEFAULT.fingerprintPrefix }])]);
    const [, workRow] = accountsOf(page);

    // The note is a note: the row keeps saying what it is, and stays the way back into that slot.
    expect(workRow.querySelector('.re-name')?.textContent).toBe('Work');
    expect(workRow.querySelector('.re-meta')?.textContent).toContain('~/.orbit/codex-accounts/3fa91c2e');
    expect(button(workRow, 'Re-sign in')).toBeTruthy();
  });

  it('takes the slot off the machine, which is what the note is offering', async () => {
    const page = mount([runner([DEFAULT, { ...WORK, fingerprintPrefix: DEFAULT.fingerprintPrefix }])]);
    const [, workRow] = accountsOf(page);

    await click(button(workRow, 'Remove'));

    // One request, for this slot and no other: the note is about THIS account being the second copy
    // of one already signed in, so it is this slot that goes (RunnerEngines.removeAccount.test.tsx).
    expect(
      apiMock.mock.calls
        .filter(([, options]) => (options?.method ?? 'GET') === 'DELETE')
        .map(([path]) => path),
    ).toEqual([`/runners/${RUNNER_ID}/codex-accounts/3fa91c2e`]);
  });
});

describe('two slots that are two accounts', () => {
  it('says nothing about a repeat, and still offers each added one a way off the machine', () => {
    const page = mount([runner([DEFAULT, WORK])]);
    const [defaultRow, workRow] = accountsOf(page);

    expect(rows(page, '.re-dup')).toHaveLength(0);
    expect(accountsOf(page)).toHaveLength(2);
    expect(labels(defaultRow)).not.toContain('Remove');
    expect(labels(workRow)).toContain('Remove');
  });
});

describe('a fingerprint nobody has read', () => {
  // One mount per case: a mount of this page is seconds on a loaded host, and three in one test
  // spend the whole per-test budget on wall clock rather than on what is being asserted.
  for (const [what, accounts] of [
    // An older runner: no fingerprints at all, and two slots that may or may not be one account.
    ['an older runner, which reads none at all', [DEFAULT_UNREAD, WORK_UNREAD]],
    // Nothing has read the slot that signed in second yet.
    ['the slot signed in second, not read yet', [DEFAULT, WORK_UNREAD]],
    // ...and the other way round: the only fingerprint here has nothing above it to match.
    ['only the slot signed in second, read', [DEFAULT_UNREAD, WORK]],
  ] as [string, RunnerEngineAccount[]][]) {
    it(`is not a repeat: ${what}`, () => {
      const page = mount([runner(accounts)]);
      const [defaultRow, addedRow] = accountsOf(page);

      expect(rows(page, '.re-dup')).toHaveLength(0);
      expect(labels(defaultRow)).not.toContain('Remove');
      expect(labels(addedRow)).toContain('Remove');
    });
  }
});
