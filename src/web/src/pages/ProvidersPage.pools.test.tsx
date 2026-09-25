// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { formatResetTime, type PoolMember, type ProviderPool } from '../lib/providerPools';
import { ProviderPoolPage } from './ProviderPoolPage';
import { ProvidersPage } from './ProvidersPage';

/**
 * The Account pools section of /providers and the pool's own page, mounted for real against a fake
 * API: which of them renders for which keys, what a pool's head says, what each account's row says,
 * and what the Add account / Create a pool dialog lets through.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const HOUR = 60 * 60 * 1000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);

const key = (n: number, label: string, over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: id(n),
  slug: `anthropic-${n}`,
  label,
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
  ...over,
});
const WORK = key(1, 'Work');
const HOME = key(2, 'Home');
const SPARE = key(3, 'Spare');
const METERED = key(4, 'Team API key', {
  poolRefusal: { reason: 'NOT_SUBSCRIPTION_TOKEN', message: 'Metered API key — no 5-hour window' },
});
const GATEWAY = key(5, 'Gateway', {
  baseUrl: 'https://gateway.example.com',
  presetSlug: null,
  poolRefusal: { reason: 'NOT_ANTHROPIC_ENDPOINT', message: 'Endpoint is not api.anthropic.com' },
});

const fiveHour = (utilization: number, resetsAt = at(2 * HOUR)) => ({
  provider: 'claude' as never,
  fiveHour: { utilization, resetsAt },
});
const member = (row: ProviderRow, over: Partial<PoolMember>): PoolMember => ({
  id: row.id,
  slug: row.slug,
  label: row.label,
  presetSlug: row.presetSlug,
  enabled: true,
  planUsage: null,
  state: 'NO_QUOTA',
  resetsAt: null,
  next: false,
  ...over,
});
const POOL_ID = id(900);
const pool = (members: PoolMember[], resetsAt: string | null = null): ProviderPool => ({
  id: POOL_ID,
  slug: 'claude-accounts',
  label: 'Claude accounts',
  resetsAt,
  members,
});

interface Posted {
  method: string;
  path: string;
  body?: unknown;
}

describe('Account pools on /providers', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let path = '';
  let mobile = false;
  let storage: Map<string, string>;
  let keys: ProviderRow[] = [];
  let pools: ProviderPool[] = [];
  let posted: Posted[] = [];

  function Probe() {
    path = useLocation().pathname;
    return null;
  }

  /** Let the queries settle: act, then one more macrotask for what the act started. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const mount = async (at: string) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[at]}>
            <AntApp>
              <Probe />
              <Routes>
                <Route path="/providers" element={<ProvidersPage />} />
                <Route path="/providers/pools/:id" element={<ProviderPoolPage />} />
                <Route path="/providers/:id" element={<div>provider page</div>} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };

  const text = () => container.textContent ?? '';
  const section = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.re-sec')).find((el) =>
      el.querySelector('h3')?.textContent === 'Account pools',
    ) ?? null;
  const heading = (words: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('h3')).find((el) => el.textContent === words) ?? null;
  /** Whether `a` comes before `b` in the document. */
  const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const rowOf = (label: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('.pool-row')).find(
      (row) => row.querySelector('.re-name')?.firstChild?.textContent === label,
    ) ?? null;
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const button = (words: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (el) => el.textContent?.trim() === words,
    ) ?? null;
  /** The dialog's row for one key: its checkbox and what it says about joining. */
  const pickRow = (row: ProviderRow) => {
    const el = document.body.querySelector<HTMLElement>(`.pool-pick[data-provider="${row.id}"]`);
    if (!el) throw new Error(`no row for ${row.label} in the dialog`);
    return {
      checkbox: el.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
      why: el.querySelector('.pool-pick-why')?.textContent ?? '',
    };
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    path = '';
    mobile = false;
    storage = new Map();
    posted = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: mobile,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    apiMock.mockReset();
    apiMock.mockImplementation(((p: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        posted.push({ method, path: p, body: init?.body });
        return Promise.resolve({}) as never;
      }
      if (p === '/providers/mine') return Promise.resolve(keys) as never;
      if (p === '/providers/pools') return Promise.resolve(pools) as never;
      return Promise.resolve([]) as never;
    }) as typeof api);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('renders nothing of pools while fewer than two keys could join one', async () => {
    keys = [WORK, METERED, GATEWAY];
    pools = [];
    await mount('/providers');
    expect(heading('Your API keys')).not.toBeNull();
    expect(section()).toBeNull();
    expect(text()).not.toContain('Account pools');
    expect(text()).not.toContain('Create a pool');

    keys = [METERED, GATEWAY];
    await act(async () => root.unmount());
    await mount('/providers');
    expect(section()).toBeNull();
    expect(text()).not.toContain('Create a pool');
  });

  it('offers a pool at the top of the API keys once two keys could join and there is none', async () => {
    keys = [WORK, HOME, METERED];
    pools = [];
    await mount('/providers');
    expect(section()).toBeNull();
    const hint = container.querySelector<HTMLElement>('.pool-hint');
    expect(hint?.textContent).toContain('2 of your keys are Claude subscriptions.');
    // At the top of the keys section: after its heading, before the keys table.
    expect(before(heading('Your API keys')!, hint!)).toBe(true);
    expect(before(hint!, container.querySelector('.provider-keys')!)).toBe(true);
  });

  it("heads a pool with the next account's own gauge, not an average, between the runners and the keys", async () => {
    keys = [WORK, HOME, SPARE];
    pools = [
      pool([
        member(WORK, { state: 'RUNNING', planUsage: fiveHour(80) }),
        member(HOME, { state: 'AVAILABLE', planUsage: fiveHour(20), next: true }),
        member(SPARE, { state: 'SPENT', planUsage: fiveHour(100), resetsAt: at(HOUR) }),
      ]),
    ];
    await mount('/providers');
    const sec = section();
    expect(sec).not.toBeNull();
    expect(before(heading('On your runners')!, sec!)).toBe(true);
    expect(before(sec!, heading('Your API keys')!)).toBe(true);

    const head = sec!.querySelector<HTMLElement>('.re-head')!;
    expect(head.textContent).toContain('Claude accounts');
    expect(head.textContent).toContain('2 of 3 accounts available');
    const gauge = head.querySelector<HTMLElement>('.pool-gauge')!;
    expect(gauge.textContent).toContain('Next: Home');
    expect(gauge.querySelector<HTMLElement>('.runner-util-fill')?.style.width).toBe('20%');
    expect(gauge.textContent).toContain('20%');
    // (80 + 20 + 100) / 3 — what an average would have drawn.
    expect(gauge.textContent).not.toContain('67%');
    expect(head.querySelector('a')?.getAttribute('href')).toBe(`/providers/pools/${POOL_ID}`);
  });

  it('says in each row where that account stands', async () => {
    const resets = at(90 * 60 * 1000);
    keys = [WORK, HOME, SPARE, METERED];
    const refused = key(6, 'Old laptop');
    const silent = key(7, 'Silent');
    pools = [
      pool([
        member(WORK, { state: 'RUNNING', planUsage: fiveHour(80) }),
        member(HOME, { state: 'AVAILABLE', planUsage: fiveHour(20), next: true }),
        member(SPARE, { state: 'SPENT', planUsage: fiveHour(100, resets), resetsAt: resets }),
        member(refused, { state: 'REFUSED' }),
        member(silent, { state: 'NO_QUOTA' }),
      ]),
    ];
    await mount('/providers');
    const tag = (label: string) => rowOf(label)?.querySelector('.ant-tag')?.textContent;
    expect(tag('Work')).toBe('Running now');
    expect(tag('Home')).toBe('Available');
    expect(tag('Spare')).toBe(`Spent · resets ${formatResetTime(resets)}`);
    expect(tag('Old laptop')).toBe('Unavailable · key refused');
    expect(tag('Silent')).toBe('No quota reported');
    // Its own gauge, not the pool's: Work is at 80 while the pool's head shows Home's 20.
    expect(rowOf('Work')?.querySelector<HTMLElement>('.runner-util-fill')?.style.width).toBe('80%');
    expect(rowOf('Work')?.querySelector('.runner-util')?.classList.contains('full')).toBe(false);
    expect(rowOf('Spare')?.querySelector('.runner-util')?.classList.contains('full')).toBe(true);
    // Not reported is not 0%: no gauge at all.
    expect(rowOf('Silent')?.querySelector('.runner-util')).toBeNull();
    expect(rowOf('Home')?.textContent).toContain('NEXT');

    // A refused key's way back is a new key, on that provider's own page.
    expect(button('Re-add key', rowOf('Work')!)).toBeNull();
    await click(button('Re-add key', rowOf('Old laptop')!));
    expect(path).toBe(`/providers/${refused.id}`);
  });

  it('says so when a fully spent pool frees up — at the earliest reset, not the latest', async () => {
    const early = at(HOUR);
    const late = at(4 * HOUR);
    keys = [WORK, HOME];
    pools = [
      pool(
        [
          member(WORK, { state: 'SPENT', planUsage: fiveHour(100, late), resetsAt: late }),
          member(HOME, { state: 'SPENT', planUsage: fiveHour(100, early), resetsAt: early }),
        ],
        early,
      ),
    ];
    await mount('/providers');
    const head = section()!.querySelector<HTMLElement>('.re-head')!;
    expect(head.textContent).toContain('0 of 2 accounts available');
    const gauge = head.querySelector<HTMLElement>('.pool-gauge')!.textContent;
    expect(gauge).toBe(`All spent · resets ${formatResetTime(early)}`);
    expect(gauge).not.toContain(formatResetTime(late));
  });

  it('keeps a pool of one account honest about being that account', async () => {
    keys = [WORK, HOME];
    pools = [pool([member(WORK, { state: 'AVAILABLE', planUsage: fiveHour(10), next: true })])];
    await mount('/providers');
    expect(section()?.textContent).toContain('With one account this pool is the same as using Work on its own.');
    expect(section()?.textContent).toContain('1 of 1 account available');
  });

  it('on a phone folds each pool to its head line, and remembers an unfold', async () => {
    mobile = true;
    keys = [WORK, HOME];
    pools = [
      pool([
        member(WORK, { state: 'AVAILABLE', planUsage: fiveHour(30) }),
        member(HOME, { state: 'AVAILABLE', planUsage: fiveHour(20), next: true }),
      ]),
    ];
    await mount('/providers');
    const card = section()!.querySelector<HTMLElement>('.pool-card')!;
    expect(card.classList.contains('collapsed')).toBe(true);
    expect(card.querySelectorAll('.pool-row')).toHaveLength(0);
    expect(card.querySelector('.re-head')?.textContent).toContain('2 of 2 accounts available');
    expect(card.querySelector<HTMLElement>('.pool-gauge .runner-util-fill')?.style.width).toBe('20%');

    await click(card.querySelector('.re-toggle'));
    expect(section()!.querySelectorAll('.pool-row')).toHaveLength(2);
    expect(JSON.parse(storage.get('orbit:providers-pool-fold') ?? '{}')).toEqual({ [POOL_ID]: true });
  });

  it('is open on a wide screen until folded, and the fold sticks', async () => {
    keys = [WORK, HOME];
    pools = [pool([member(WORK, { state: 'AVAILABLE', next: true }), member(HOME, { state: 'AVAILABLE' })])];
    await mount('/providers');
    expect(section()!.querySelectorAll('.pool-row')).toHaveLength(2);
    await click(section()!.querySelector('.re-toggle'));
    expect(section()!.querySelectorAll('.pool-row')).toHaveLength(0);
    expect(JSON.parse(storage.get('orbit:providers-pool-fold') ?? '{}')).toEqual({ [POOL_ID]: false });
  });

  it('creates a pool from the hint with every key that can join, and none that cannot', async () => {
    keys = [WORK, METERED, HOME, GATEWAY];
    pools = [];
    await mount('/providers');
    await click(button('Create a pool'));
    expect(pickRow(METERED)).toMatchObject({ why: 'Metered API key — no 5-hour window' });
    expect(pickRow(METERED).checkbox.disabled).toBe(true);
    expect(pickRow(GATEWAY)).toMatchObject({ why: 'Endpoint is not api.anthropic.com' });
    expect(pickRow(GATEWAY).checkbox.disabled).toBe(true);
    expect(pickRow(WORK).checkbox.disabled).toBe(false);
    expect(pickRow(WORK).checkbox.checked).toBe(true);
    expect(pickRow(HOME).checkbox.checked).toBe(true);

    await click(button('Create pool'));
    expect(posted).toEqual([
      { method: 'POST', path: '/providers/pools', body: { label: 'Claude accounts', providerIds: [WORK.id, HOME.id] } },
    ]);
  });

  it("the pool's own page: Add account refuses a metered key and a foreign endpoint, with the reason", async () => {
    keys = [WORK, HOME, SPARE, METERED, GATEWAY];
    pools = [
      pool([
        member(WORK, { state: 'AVAILABLE', planUsage: fiveHour(40), next: true }),
        member(HOME, { state: 'AVAILABLE', planUsage: fiveHour(60) }),
      ]),
    ];
    // Deep-linked, in the spelling a pasted link could carry.
    await mount(`/providers/pools/0195c0de-0000-7000-8000-000000000900`);
    expect(container.querySelector('h1')?.textContent).toBe('Claude accounts');
    expect(text()).toContain('2 of 2 accounts available');

    await click(button('Add account'));
    // Joinable first, then the refusals the dialog is there to explain, then what is in already.
    expect(
      Array.from(document.body.querySelectorAll('.pool-pick .pool-pick-name')).map((el) => el.textContent),
    ).toEqual(['Spare', 'Team API key', 'Gateway', 'Work', 'Home']);
    for (const [row, why] of [
      [METERED, 'Metered API key — no 5-hour window'],
      [GATEWAY, 'Endpoint is not api.anthropic.com'],
      [WORK, 'Already in this pool'],
    ] as const) {
      expect(pickRow(row).why).toBe(why);
      expect(pickRow(row).checkbox.disabled).toBe(true);
    }
    expect(pickRow(SPARE).checkbox.disabled).toBe(false);
    expect(pickRow(SPARE).checkbox.checked).toBe(false);
    // Nothing picked yet, so there is nothing to add.
    expect(button('Add')?.disabled).toBe(true);

    await click(pickRow(SPARE).checkbox);
    await click(button('Add'));
    expect(posted).toEqual([{ method: 'POST', path: `/providers/pools/${POOL_ID}/members`, body: { providerId: SPARE.id } }]);
  });

  it("the pool's own page takes an account out without touching the key", async () => {
    keys = [WORK, HOME];
    pools = [pool([member(WORK, { state: 'AVAILABLE', next: true }), member(HOME, { state: 'AVAILABLE' })])];
    await mount(`/providers/pools/${POOL_ID}`);
    await click(rowOf('Home')!.querySelector('button[aria-label="Remove Home from this pool"]'));
    expect(posted).toEqual([{ method: 'DELETE', path: `/providers/pools/${POOL_ID}/members/${HOME.id}`, body: undefined }]);
  });

  it('a pool that is gone says so on its own page', async () => {
    keys = [];
    pools = [];
    await mount(`/providers/pools/${POOL_ID}`);
    expect(text()).toContain('That pool no longer exists.');
  });
});
