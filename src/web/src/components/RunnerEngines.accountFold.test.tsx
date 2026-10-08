// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { formatResetTime } from '../lib/providerPools';
import { RunnerEngines } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * Several accounts of one engine on one runner, folded under that engine's row — docs/mocks/
 * providers-account-fold. A group starts folded, and its head then says what the rows it hides would:
 * whether one of them needs signing in again, else the account a new session starts on, its state and
 * its window nearest the limit. Opening it lists the rows as they always were, and the page remembers
 * which groups were opened, as it does its cards.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const OPEN_KEY = 'orbit:providers-open-accounts';

/** Ahead of whenever this runs, so no reading is about a window already over. */
const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const WIKOVA: RunnerEngineAccount = { id: 'default', name: 'jianghailong.wikova@gmail.com', home: '/root/.claude', auth: 'yes' };
const RD: RunnerEngineAccount = { id: '1e84046c', name: 'jianghailong.rd@gmail.com', home: '/root/.orbit/claude-accounts/1e84046c', auth: 'yes' };
const ORBIT: RunnerEngineAccount = { id: '44bf2acd', name: 'jianghailong.orbit@gmail.com', home: '/root/.orbit/claude-accounts/44bf2acd', auth: 'yes' };

const ORBIT_FIVE_HOUR_RESET = inHours(0.7);

/** Default's week is spent, and rd's resets before orbit's: a new session starts on rd. */
const usage = (over: { rd?: object; orbit?: object } = {}) =>
  ({
    claude: {
      provider: 'claude',
      fiveHour: { utilization: 0 },
      sevenDay: { utilization: 100, resetsAt: inHours(37) },
      accounts: {
        [RD.id]: {
          provider: 'claude',
          fiveHour: { utilization: 29, resetsAt: inHours(3.5) },
          sevenDay: { utilization: 89, resetsAt: inHours(116) },
          ...over.rd,
        },
        [ORBIT.id]: {
          provider: 'claude',
          fiveHour: { utilization: 53, resetsAt: ORBIT_FIVE_HOUR_RESET },
          sevenDay: { utilization: 41, resetsAt: inHours(151) },
          ...over.orbit,
        },
      },
    },
  }) as PlanUsage;

const runner = (accounts: RunnerEngineAccount[] = [WIKOVA, RD, ORBIT], planUsage = usage()): Runner => ({
  id: RUNNER_ID,
  name: 'HPC',
  online: true,
  planUsage,
  engines: [
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      version: '2.1.292 (Claude Code)',
      accounts,
      update: { status: 'checked', at: minutesAgo(7), okAt: minutesAgo(7) },
    },
    // One account yet: "Add account" is how it becomes a group.
    { engine: 'codex', installed: true, auth: 'yes', version: 'codex-cli 0.160.1', accounts: [{ id: 'default', home: '/root/.codex', auth: 'yes' }] },
    { engine: 'kimi', installed: true, auth: 'no', version: '2.1.1' },
  ],
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // The row a link names scrolls itself into view, which jsdom cannot do.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
afterEach(() => {
  unmount();
  apiMock.mockReset();
  localStorage.clear();
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
}

/** The section over these runners, at `path`; their cards open unless `cards` is false. What is open
 *  of their accounts is whatever the page remembers. */
function mount(runners: Runner[], { path = '/providers', cards = true } = {}) {
  if (cards) localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  apiMock.mockImplementation(async (url: string, options?: { method?: string }) => {
    if (url === '/runners') return runners;
    if (url.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
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
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
}

const head = (engine = 'claude') => host!.querySelector<HTMLElement>(`.re-row[data-engine="${engine}"]`)!;
const toggle = () => head().querySelector<HTMLButtonElement>('button.re-grp-toggle')!;
const accountNames = () => [...host!.querySelectorAll('.re-acct .re-name-text')].map((name) => name.textContent);
const tags = (el: Element) => [...el.querySelectorAll('.ant-tag')].map((tag) => tag.textContent?.trim());
const opened = (): unknown => JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
const button = (el: ParentNode, label: string) => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

describe('several accounts of one engine on a runner', () => {
  it("start folded, the head saying where the next session starts, that account's state and its tightest window", () => {
    mount([runner()]);
    expect(accountNames()).toEqual([]);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(head().querySelector('.re-meta b')?.textContent).toBe('2 of 3 accounts available');
    // A line of its own beside a status and a quota, rather than half of one.
    expect(head().querySelector('.re-upd')?.textContent).toBe('checked 7m ago');
    expect(tags(head())).toEqual(['Available']);
    const quota = head().querySelector('.re-quota')!;
    expect(quota.querySelector('.re-quota-next')?.textContent).toBe('Next: jianghailong.rd@gmail.com');
    // Of rd's two windows, the one nearest its limit — its week, not its 29% five hours.
    expect([...quota.querySelectorAll('.re-window .re-quota-head')].map((line) => line.textContent)).toEqual([
      'Weekly · all models89%',
    ]);
  });

  it('open on the head, list every account under it as before, and stay open', async () => {
    mount([runner()]);
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
    // Open, the head is the group's line again: each account's state is on its own row.
    expect(head().querySelector('.re-status')).toBeNull();
    expect(head().querySelector('.re-quota')).toBeNull();
    expect(head().querySelector('.re-upd')?.textContent).toBe(' · checked 7m ago');
    expect(opened()).toEqual([`${RUNNER_ID}/claude`]);

    unmount();
    mount([runner()]);
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);

    await click(toggle());
    expect(accountNames()).toEqual([]);
    expect(opened()).toEqual([]);
  });

  it('say an account needs signing in again, ahead of where the next session starts', () => {
    mount([runner([WIKOVA, RD, { ...ORBIT, auth: 'no' }])]);
    expect(head().querySelector('.re-meta b')?.textContent).toBe('1 of 3 accounts available');
    expect(tags(head())).toEqual(['1 signed out']);
    expect(head().querySelector('.re-quota-next')?.textContent).toBe('Next: jianghailong.rd@gmail.com');
  });

  it('with every account spent, name the first to come back and when', () => {
    const spent = usage({
      rd: { fiveHour: { utilization: 100, resetsAt: inHours(3.5) } },
      orbit: { fiveHour: { utilization: 100, resetsAt: ORBIT_FIVE_HOUR_RESET } },
    });
    mount([runner(undefined, spent)]);
    expect(head().querySelector('.re-meta b')?.textContent).toBe('0 of 3 accounts available');
    expect(tags(head())).toEqual([`Spent · resets ${formatResetTime(ORBIT_FIVE_HOUR_RESET)}`]);
    expect(head().querySelector('.re-quota-next')?.textContent).toBe('Next: jianghailong.orbit@gmail.com');
    expect(head().querySelector('.re-window .re-quota-head')?.textContent).toBe('5-hour limit100%');
  });

  it('open where a link to that engine on that runner arrives, and stay open', () => {
    mount([runner()], { path: `/providers?runner=${encodeId(RUNNER_ID)}&engine=claude`, cards: false });
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
    expect(opened()).toEqual([`${RUNNER_ID}/claude`]);
  });

  it('open to take an account being added, so that it lands where it can be seen', async () => {
    mount([runner()]);
    await click(button(head(), 'Add account'));
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
    expect(head().querySelector('.re-add')).not.toBeNull();
    expect(opened()).toEqual([`${RUNNER_ID}/claude`]);
    // An engine with one account yet: the one being added makes it a group, already open.
    await click(button(head('codex'), 'Add account'));
    expect(opened()).toEqual([`${RUNNER_ID}/claude`, `${RUNNER_ID}/codex`]);
  });

  // docs/mocks/providers-group-row-click
  it("fold from anywhere on the head's line — not from Add account, its panel, an account's row or a selection", async () => {
    mount([runner()]);
    // Folded, its status and its quota open it, as its name does; open, its blank folds it again.
    await click(head().querySelector<HTMLElement>('.re-status')!);
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
    await click(head());
    expect(accountNames()).toEqual([]);
    await click(head().querySelector<HTMLElement>('.re-quota')!);
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);

    // Add account opens its panel under the line and leaves the group open; nothing in that panel,
    // and no account's row, folds it.
    await click(button(head(), 'Add account'));
    expect(head().querySelector('.re-add')).not.toBeNull();
    await click(head().querySelector<HTMLElement>('.re-add-label')!);
    await click(head().querySelector<HTMLElement>('.re-add input')!);
    await click(host!.querySelector<HTMLElement>('.re-acct')!);
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
    expect(opened()).toEqual([`${RUNNER_ID}/claude`]);

    // A press that ends a drag across the head's words leaves them selected instead.
    const words = document.createRange();
    words.selectNodeContents(head().querySelector('.re-meta')!);
    getSelection()!.addRange(words);
    await click(head());
    getSelection()!.removeAllRanges();
    expect(accountNames()).toEqual([WIKOVA.name, RD.name, ORBIT.name]);
  });
});

describe("a runner's card", () => {
  const card = () => host!.querySelector<HTMLElement>('.re-runner-card')!;
  const folded = () => card().classList.contains('collapsed');

  it('folds from anywhere on its head — its summary too — and leaves Manage a link', async () => {
    mount([runner()], { cards: false });
    expect(folded()).toBe(true);
    await click(card().querySelector<HTMLElement>('.re-summary')!);
    expect(folded()).toBe(false);
    await click(card().querySelector<HTMLElement>('.re-head')!);
    expect(folded()).toBe(true);
    await click(card().querySelector<HTMLElement>('.re-manage')!);
    expect(folded()).toBe(true);
  });
});
