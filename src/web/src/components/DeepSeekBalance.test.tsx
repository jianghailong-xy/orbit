// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBalance } from '@orbit/shared';
import { api } from '../api';
import { ProviderConnectPage } from '../pages/ProviderConnectPage';
import { ProvidersPage } from '../pages/ProvidersPage';
import { deepseekBalanceKey } from '../lib/deepseekBalance';
import { PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { DeepSeekBalanceLine, DeepSeekBalanceSection } from './DeepSeekBalance';

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'ds',
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  ...over,
});
const harness = row({ id: 'dsh', slug: 'deepseek-harness', label: 'DeepSeek Harness', runtime: 'dsh', presetSlug: 'deepseek-harness', models: [], defaultModel: '' });

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000 - 5_000).toISOString();
const CNY = { currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' };
const USD = { currency: 'USD', totalBalance: '5.00', grantedBalance: '0.00', toppedUpBalance: '5.00' };
const ok = (over: Partial<Extract<ProviderBalance, { ok: true }>> = {}): ProviderBalance => ({
  ok: true,
  balances: [CNY],
  isAvailable: true,
  fetchedAt: minutesAgo(2),
  sharedWith: [],
  ...over,
});
const low: ProviderBalance = ok({
  isAvailable: false,
  fetchedAt: new Date().toISOString(),
  balances: [{ currency: 'CNY', totalBalance: '0.42', grantedBalance: '0.00', toppedUpBalance: '0.42' }],
});
const failed = (reason: 'KEY_REJECTED' | 'NETWORK' | 'UPSTREAM_ERROR', message: string): ProviderBalance => ({
  ok: false,
  reason,
  message,
  fetchedAt: new Date().toISOString(),
  sharedWith: [],
});
const keyRejected = failed('KEY_REJECTED', 'DeepSeek rejected this API key (401 Authentication Fails).');
const network = failed(
  'NETWORK',
  "Couldn't reach api.deepseek.com — the request timed out after 10 s. The key itself wasn't checked.",
);
const upstream = failed('UPSTREAM_ERROR', "DeepSeek answered 503 Server Overloaded. The key itself wasn't checked.");

/** Nothing on screen reads as an amount: no currency sign, and no 0 standing for one. */
function expectNoAmount(text: string) {
  expect(text).not.toMatch(/[¥$]/);
  expect(text).not.toMatch(/(^|[^\d.])0(\.\d+)?(?![\d.])/);
}

describe('the DeepSeek account balance', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  /** What GET /providers/mine/:id/balance answers, by provider id — refresh=1 included. */
  let answers: Record<string, () => Promise<unknown>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    answers = {};
    apiMock.mockReset();
    apiMock.mockImplementation(((path: string) => {
      const balance = /^\/providers\/mine\/([^/]+)\/balance/.exec(path);
      if (balance) return (answers[balance[1]] ?? (() => new Promise(() => {})))();
      return Promise.resolve([]);
    }) as typeof api);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Seeded lists stay as seeded; the balance queries have no data, so they still ask.
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  /** Let the balance requests settle and what they answered render, in act slices: the query's
   *  answer reaches React through a timer of its own. */
  async function flush() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function show(node: ReactNode) {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
    });
    await flush();
  }

  const text = () => (container.textContent ?? '').replace(/\s+/g, ' ').trim();
  const buttons = () => [...container.querySelectorAll('button')];
  const press = async (label: string) => {
    const button = buttons().find((b) => b.textContent?.includes(label) || b.getAttribute('aria-label')?.includes(label));
    expect(button, `no ${label} button`).toBeTruthy();
    await act(async () => button!.click());
    await flush();
  };
  const balanceRequests = () => apiMock.mock.calls.map(([path]) => path as string).filter((path) => path.includes('/balance'));

  describe('the line under a DeepSeek row on the Providers list', () => {
    it('says it is checking until the server answers — with no number in the meantime', async () => {
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toBe('Checking account balance…');
      expectNoAmount(text());
    });

    it('shows the total, when it was read, and a refresh', async () => {
      answers.ds = async () => ok();
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toBe('Account balance ¥110.00 · updated 2 min ago');
      expect(container.querySelector('button[title="Refresh"]')).not.toBeNull();
      expect(balanceRequests()).toEqual(['/providers/mine/ds/balance']);
    });

    it('lists every currency, unconverted', async () => {
      answers.ds = async () => ok({ balances: [CNY, USD] });
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toBe('Account balance ¥110.00 · $5.00updated 2 min ago');
      expect([...container.querySelectorAll('.dsb-line')].map((line) => line.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'Account balance ¥110.00 · $5.00',
        'updated 2 min ago',
      ]);
    });

    it('says plainly when the balance is too low, and links to DeepSeek’s top-up', async () => {
      answers.ds = async () => low;
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toContain('Balance ¥0.42 — too low, DeepSeek calls will fail');
      const topUp = container.querySelector<HTMLAnchorElement>('a[href="https://platform.deepseek.com/top_up"]');
      expect(topUp?.textContent).toBe('Top up on DeepSeek ↗');
      expect(topUp?.target).toBe('_blank');
      expect(container.querySelector('.dsb-line.low')).not.toBeNull();
    });

    it.each([
      ['a rejected key', keyRejected, 'Balance unavailable: API key rejected · Retry'],
      ['no answer from DeepSeek', network, 'Balance unavailable: network error · Retry'],
      ['an error from DeepSeek', upstream, 'Balance unavailable: DeepSeek error · Retry'],
    ])('says why there is no balance after %s — and shows no amount, never ¥0.00', async (_, answer, line) => {
      answers.ds = async () => answer;
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toBe(line);
      expectNoAmount(text());
      expect(container.querySelector('.dsb-line.fail')?.getAttribute('title')).toBe((answer as { message: string }).message);
    });

    it('fails the same way when the request never reached the server', async () => {
      answers.ds = () => Promise.reject(new Error('Bad Gateway'));
      await show(<DeepSeekBalanceLine row={row()} />);
      expect(text()).toBe("Balance unavailable: couldn't load · Retry");
      expectNoAmount(text());
    });

    it('Retry asks DeepSeek again and shows what it says', async () => {
      answers.ds = async () => network;
      await show(<DeepSeekBalanceLine row={row()} />);
      answers.ds = async () => ok({ fetchedAt: new Date().toISOString() });
      await press('Retry');
      expect(balanceRequests()).toEqual(['/providers/mine/ds/balance', '/providers/mine/ds/balance?refresh=1']);
      expect(text()).toBe('Account balance ¥110.00 · updated just now');
    });
  });

  describe('the section under the key on a DeepSeek key’s edit page', () => {
    it('shows the total, granted and topped up, when it was read, a refresh, and where to top up', async () => {
      answers.ds = async () => ok({ sharedWith: [{ id: 'dsh', label: 'DeepSeek Harness' }] });
      await show(<DeepSeekBalanceSection row={row()} />);
      const section = text();
      expect(section).toContain('DeepSeek account balanceTop up on DeepSeek ↗');
      expect(section).toContain('Total¥110.00CNY');
      expect(section).toContain('Updated 2 min ago');
      expect(section).toContain('Granted¥10.00');
      expect(section).toContain('Topped up¥100.00');
      expect(buttons().map((b) => b.textContent)).toEqual(['Refresh']);
      expect(container.querySelector('.ps-link a')?.getAttribute('href')).toBe('https://platform.deepseek.com/top_up');
      // Whose balance it is, in words: the whole account's, not what anything here spent.
      expect(section).toContain(
        'The balance of the whole DeepSeek account this key belongs to — every app and person using that account draws on it, so it is not what Orbit or this session spent. Granted credit is spent before topped-up credit.',
      );
      expect(section).toContain('Same DeepSeek account as DeepSeek Harness — both show this balance.');
      const bar = container.querySelector('.dsb-bar')!;
      expect((bar.querySelector('.g') as HTMLElement).style.width).toBe(`${(10 / 110) * 100}%`);
      expect((bar.querySelector('.t') as HTMLElement).style.width).toBe(`${(100 / 110) * 100}%`);
    });

    it('gives every currency its own total and split, and says they are not converted', async () => {
      answers.ds = async () => ok({ balances: [CNY, USD] });
      await show(<DeepSeekBalanceSection row={row()} />);
      expect([...container.querySelectorAll('.dsb-total')].map((t) => t.textContent)).toEqual(['¥110.00CNY', '$5.00USD']);
      expect(container.querySelectorAll('.dsb-cur')).toHaveLength(2);
      expect(text()).toContain('Granted$0.00');
      expect(text()).toContain("Each currency is a separate balance; DeepSeek doesn't convert between them.");
      expect(text()).not.toContain('Same DeepSeek account as');
    });

    it('turns red when DeepSeek says the account can’t pay, with the real amount and a top-up button', async () => {
      answers.ds = async () => low;
      await show(<DeepSeekBalanceSection row={row()} />);
      expect(container.querySelector('.dsb-card.low')).not.toBeNull();
      expect(text()).toContain('Balance too low — DeepSeek calls will fail');
      expect(text()).toContain("Every session using a key on this account will fail at its next request. Orbit can't top up for you.");
      expect(container.querySelector('.dsb-total.low')?.textContent).toBe('¥0.42CNY');
      expect(text()).toContain('Updated just now');
      const topUp = container.querySelector<HTMLAnchorElement>('.dsb-actions a');
      expect(topUp?.getAttribute('href')).toBe('https://platform.deepseek.com/top_up');
      expect(topUp?.textContent).toContain('Top up on DeepSeek');
      expect(text()).toContain("Opens platform.deepseek.com — refresh here when you're done.");
      expect(container.querySelector('.ps-link'), 'the top-up is the card’s action, not a link in the head').toBeNull();
    });

    it('says DeepSeek rejected the key, what to do, and shows no amount — Balance unknown', async () => {
      answers.ds = async () => keyRejected;
      await show(<DeepSeekBalanceSection row={row()} />);
      expect(container.querySelector('.dsb-card.fail')).not.toBeNull();
      expect(text()).toContain("Couldn't get the balance");
      expect(text()).toContain(
        'DeepSeek rejected this API key (401 Authentication Fails). Paste a valid key above and save, then retry.',
      );
      expect(text()).toContain('Balance unknown');
      expect(text()).toContain('Tried just now');
      expect(buttons().map((b) => b.textContent)).toEqual(['Retry']);
      expect(container.querySelector('.ps-link')).toBeNull();
      expectNoAmount(text());
    });

    it.each([
      ['no answer from DeepSeek', network],
      ['an error from DeepSeek', upstream],
    ])('says the key was not what failed after %s — and shows no amount', async (_, answer) => {
      answers.ds = async () => answer;
      await show(<DeepSeekBalanceSection row={row()} />);
      expect(text()).toContain(`Couldn't get the balance${(answer as { message: string }).message}`);
      expect(text()).not.toContain('Paste a valid key');
      expect(text()).toContain('Balance unknown');
      expectNoAmount(text());
    });

    it('draws the card’s shape while it loads, with Refresh off and no number', async () => {
      await show(<DeepSeekBalanceSection row={row()} />);
      expect(text()).toContain('Checking balance…');
      expect(container.querySelector('.dsb-card[aria-busy="true"]')).not.toBeNull();
      expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['Refresh', true]]);
      expectNoAmount(text());
    });

    it('a request that never reached the server is a failure too, never a 0', async () => {
      answers.ds = () => Promise.reject(new Error('Bad Gateway'));
      await show(<DeepSeekBalanceSection row={row()} />);
      expect(text()).toContain("Couldn't get the balanceBad Gateway");
      expect(text()).toContain('Balance unknown');
      expectNoAmount(text());
    });

    it('Refresh asks DeepSeek again, and the provider sharing the key reads the new answer too', async () => {
      answers.ds = async () => ok({ sharedWith: [{ id: 'dsh', label: 'DeepSeek Harness' }] });
      client.setQueryData(deepseekBalanceKey('dsh'), ok({ sharedWith: [{ id: 'ds', label: 'DeepSeek' }] }));
      await show(<DeepSeekBalanceSection row={row()} />);
      answers.ds = async () => ({ ...low, sharedWith: [{ id: 'dsh', label: 'DeepSeek Harness' }] });
      await press('Refresh');
      expect(balanceRequests()).toEqual(['/providers/mine/ds/balance', '/providers/mine/ds/balance?refresh=1']);
      expect(text()).toContain('Balance too low — DeepSeek calls will fail');
      expect(client.getQueryState(deepseekBalanceKey('dsh'))?.isInvalidated).toBe(true);
    });
  });

  describe('on the pages', () => {
    const others = [
      row({ id: 'claude', slug: 'anthropic', label: 'Anthropic (Claude)', presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      row({ id: 'custom', slug: 'my-deepseek', label: 'My DeepSeek', presetSlug: null, baseUrl: 'https://api.deepseek.com/v1' }),
      row({ id: 'proxy', slug: 'proxy', label: 'Proxy', presetSlug: null, baseUrl: 'https://llm-proxy.example.com/v1' }),
    ];

    it('the Providers list gives every DeepSeek key a balance line — and the same balance to keys that share it', async () => {
      const shared = ok();
      answers.ds = async () => shared;
      answers.dsh = async () => shared;
      answers.custom = async () => keyRejected;
      client.setQueryData(['runners'], []);
      client.setQueryData(PROVIDERS_LIST_KEY, [row(), harness, ...others]);
      client.setQueryData(['providers', 'pools'], []);
      client.setQueryData(['providers', 'shared-pools'], []);
      await show(<ProvidersPage />);
      const lineOf = (name: string) =>
        [...container.querySelectorAll('tr')]
          .find((tr) => tr.querySelector('.prov-cell-name')?.textContent === name)
          ?.querySelector('[data-testid="deepseek-balance-line"]')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim();
      expect(lineOf('DeepSeek')).toBe('Account balance ¥110.00 · updated 2 min ago');
      expect(lineOf('DeepSeek Harness')).toBe('Account balance ¥110.00 · updated 2 min ago');
      expect(lineOf('My DeepSeek')).toBe('Balance unavailable: API key rejected · Retry');
      expect(lineOf('Anthropic (Claude)')).toBeUndefined();
      expect(lineOf('Proxy')).toBeUndefined();
      expect(balanceRequests().sort()).toEqual([
        '/providers/mine/custom/balance',
        '/providers/mine/ds/balance',
        '/providers/mine/dsh/balance',
      ]);
    });

    async function edit(id: string, rows: ProviderRow[]) {
      client.setQueryData(PROVIDERS_LIST_KEY, rows);
      client.setQueryData(['providers', 'presets'], {});
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[`/providers/${id}`]}>
              <Routes>
                <Route path="/providers/:id" element={<ProviderConnectPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      });
      await flush();
    }

    it('a DeepSeek key’s edit page has the balance section right under the key', async () => {
      answers.dsh = async () => ok({ sharedWith: [{ id: 'ds', label: 'DeepSeek' }] });
      await edit('dsh', [row(), harness]);
      const titles = [...container.querySelectorAll('.provider-step .ps-title')].map((t) => t.textContent);
      expect(titles).toEqual(['Name', 'Paste your DeepSeek Harness API key', 'DeepSeek account balance']);
      expect(text()).toContain('Same DeepSeek account as DeepSeek — both show this balance.');
    });

    it('no other key’s page has one, and a page that is only connecting a key never asks', async () => {
      await edit('claude', [row(), ...others]);
      expect(container.querySelector('[data-testid="deepseek-balance"]')).toBeNull();
      await edit('proxy', [row(), ...others]);
      expect(container.querySelector('[data-testid="deepseek-balance"]')).toBeNull();
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/providers/new/deepseek']}>
              <Routes>
                <Route path="/providers/new/:slug" element={<ProviderConnectPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      });
      expect(container.querySelector('[data-testid="deepseek-balance"]')).toBeNull();
      expect(balanceRequests()).toEqual([]);
    });
  });

  it('nothing here falls back to 0 for a missing amount', () => {
    for (const file of ['./DeepSeekBalance.tsx', '../lib/deepseekBalance.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\?\?\s*0(?![\d.])/);
      expect(source, file).not.toMatch(/\|\|\s*0(?![\d.])/);
    }
  });
});
