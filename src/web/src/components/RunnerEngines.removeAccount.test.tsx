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
 * Removing a Codex account from a runner, from the Providers page.
 *
 * A runner can hold more than one Codex account, and Default is not one of them it can let go: it
 * is the CODEX_HOME the machine's own environment selects, the one `codex` typed in a terminal
 * shares. Every other account is a slot the runner added, and the row's Remove takes it off that
 * machine — the request the control plane hands the runner on its next check-in. The same Remove
 * sits in the note raised when one account turned out to be signed in twice, which is exactly the
 * case where someone wants it.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it, and a
// placeholder would fail the render rather than an assertion.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
// Three accounts, three fingerprints — until a case below hands two rows the same one, which is
// what the page raises its duplicate note for.
const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  codexHome: '/root/.codex',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_2b7e9013',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  codexHome: '/root/.orbit/codex-accounts/3fa91c2e',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const PERSONAL: RunnerEngineAccount = {
  id: '7c21de40',
  name: 'Personal',
  codexHome: '/root/.orbit/codex-accounts/7c21de40',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_4d5c8b26',
};

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const runner = (accounts: RunnerEngineAccount[], over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [
    health({ engine: 'claude', version: '2.0.44' }),
    health({ engine: 'codex', version: '0.156.0', accounts }),
    health({ engine: 'kimi', version: '0.41.0' }),
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
    if (options?.method === 'DELETE') return { account: '3fa91c2e', status: 'pending', message: null };
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
/** Every request the page made to remove an account, in order. */
const removals = () =>
  apiMock.mock.calls.filter(([path, options]) => (options?.method ?? 'GET') === 'DELETE' && String(path).includes('/codex-accounts/'));

describe('removing one Codex account from a runner', () => {
  it('offers Remove on the accounts the runner added, and never on Default', () => {
    const page = mount([runner([DEFAULT, WORK, PERSONAL])]);
    const [defaultRow, workRow, personalRow] = accountsOf(page);

    expect(labels(defaultRow)).not.toContain('Remove');
    expect(labels(workRow)).toContain('Remove');
    expect(labels(personalRow)).toContain('Remove');
  });

  it('still draws the removed account its own row, sign-in and quota until the machine says it is gone', () => {
    const page = mount([runner([DEFAULT, WORK])]);
    const [, workRow] = accountsOf(page);

    expect(workRow.querySelector('.re-name')?.textContent).toBe('Work');
    expect(workRow.querySelector('.re-meta')?.textContent).toContain('~/.orbit/codex-accounts/3fa91c2e');
    expect(button(workRow, 'Re-sign in')).toBeTruthy();
  });

  it('asks the control plane to remove the account the row is for, and no other', async () => {
    const page = mount([runner([DEFAULT, WORK, PERSONAL])]);
    const [, , personalRow] = accountsOf(page);

    await click(button(personalRow, 'Remove'));

    expect(removals().map(([path]) => path)).toEqual([
      `/runners/${RUNNER_ID}/codex-accounts/7c21de40`,
    ]);
  });

  it('is offered nowhere on a machine that is offline, which cannot carry it out', () => {
    const page = mount([runner([DEFAULT, WORK], { online: false })]);
    const [, workRow] = accountsOf(page);

    expect(button(workRow, 'Remove').disabled).toBe(true);
  });
});

describe('the note raised by one account signed in twice', () => {
  it('is raised by two added slots that are one account, and its Remove takes the later one off', async () => {
    // Default is a different account here: Work and Personal are two slots of one account, which is
    // the case the fingerprint makes visible and the note exists for.
    const page = mount([runner([DEFAULT, WORK, { ...PERSONAL, fingerprintPrefix: WORK.fingerprintPrefix }])]);
    const [defaultRow, workRow, personalRow] = accountsOf(page);

    expect(defaultRow.querySelector('.re-dup')).toBeNull();
    expect(workRow.querySelector('.re-dup')).toBeNull();
    expect(personalRow.querySelector('.re-dup')?.textContent).toContain(
      'This is the same account as Work — signing in twice does not double the quota.',
    );

    await click(personalRow.querySelector('.re-dup .re-link') as HTMLButtonElement);

    expect(removals().map(([path]) => path)).toEqual([
      `/runners/${RUNNER_ID}/codex-accounts/7c21de40`,
    ]);
  });

  it('removes the slot that made the second copy, right where it says so', async () => {
    // Work turned out to hold the account Default already had: one account, two CODEX_HOMEs.
    const page = mount([runner([DEFAULT, { ...WORK, fingerprintPrefix: DEFAULT.fingerprintPrefix }])]);
    const [defaultRow, workRow] = accountsOf(page);

    expect(workRow.querySelector('.re-dup')?.textContent).toContain(
      'This is the same account as Default — signing in twice does not double the quota.',
    );
    expect(defaultRow.querySelector('.re-dup')).toBeNull();

    // The note's own Remove, not the row's: both are the same request, and the note is where the
    // person reading "this is the same account" is looking.
    const noteRemove = workRow.querySelector('.re-dup .re-link') as HTMLButtonElement;
    await click(noteRemove);

    expect(removals().map(([path]) => path)).toEqual([
      `/runners/${RUNNER_ID}/codex-accounts/3fa91c2e`,
    ]);
  });
});

describe('a removal the machine would not do', () => {
  it('says why, on the row it is about', () => {
    const refused = 'codex account 3fa91c2e is in use by a session running on this machine — end that session, then remove it';
    const page = mount([
      runner([DEFAULT, WORK], {
        codexAccountRemove: { account: '3fa91c2e', status: 'failed', message: refused },
      }),
    ]);
    const [, workRow] = accountsOf(page);

    expect(workRow.querySelector('.re-panel.bad')?.textContent).toContain(refused);
    // The account is still there, and the row says so rather than leaving a person guessing.
    expect(workRow.querySelector('.re-meta')?.textContent).toContain('~/.orbit/codex-accounts/3fa91c2e');
  });

  it('leaves another account’s row alone', () => {
    const page = mount([
      runner([DEFAULT, WORK, PERSONAL], {
        codexAccountRemove: { account: WORK.id, status: 'failed', message: 'a session is running on it' },
      }),
    ]);
    const [, workRow, personalRow] = accountsOf(page);

    expect(workRow.querySelector('.re-panel.bad')).toBeTruthy();
    expect(personalRow.querySelector('.re-panel.bad')).toBeNull();
  });

  it('shows the account as going while the machine has yet to answer', () => {
    const page = mount([
      runner([DEFAULT, WORK], {
        codexAccountRemove: { account: WORK.id, status: 'pending', message: null },
      }),
    ]);
    const [, workRow] = accountsOf(page);

    expect(button(workRow, 'Remove').disabled).toBe(true);
    expect(workRow.querySelector('.re-panel.bad')).toBeNull();
  });
});
