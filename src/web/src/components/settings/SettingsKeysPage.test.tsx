// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderKeyUsage } from '@orbit/shared';
import { openDialog } from '../RunnerEngines.test-helpers';
import { encodeId } from '../../lib/idCodec';
import type { ProviderRow } from '../../lib/providerAdmin';
import { SettingsKeysPage, SettingsProvidersHome } from './SettingsProviderPages';

/**
 * The API keys page in Settings' Providers group (owner's choice A, docs/mocks/settings-providers-compact
 * board-1): every key on one page, a section per vendor, chips to show one vendor's alone — which is what
 * the vendor's page was (owner's choice C1, docs/mocks/settings-redesign board-4),
 * what Infrastructure's card per vendor was (docs/mocks/infrastructure-focus) after the provider/engine
 * split (docs/mocks/provider-engine-decoupling web-1, ③ and ④): a row per key saying which engines it
 * runs on — the server's `engines` — the model a session on it starts on, the account pools it is in,
 * whether it is on and when it was last used, and a DeepSeek key its account balance; Add in each
 * vendor's heading; the account pools using these keys, and no row of vendors not connected yet (the
 * sidebar's Connect a provider reaches those); and a key's ⋯ → Delete asking first what uses it on each of
 * those engines.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const key = (n: number, label: string, over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: id(100 + n),
  slug: `key-${n}`,
  label,
  runtime: 'claude',
  engines: ['claude', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.anthropic.com',
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
  lastUsedAt: null,
  ...over,
});
const deepseek = (n: number, label: string, over: Partial<ProviderRow> = {}) =>
  key(n, label, {
    engines: ['claude', 'opencode', 'dsh'] as ProviderRow['engines'],
    baseUrl: 'https://api.deepseek.com/anthropic',
    presetSlug: 'deepseek',
    ...over,
  });
// The boards' account: two DeepSeek keys (one made from the retired Harness preset before the split,
// which is a DeepSeek key like the other), Gemini, Kimi and GLM keys, and a Claude subscription token.
/** A session ran on the first DeepSeek key three days ago; nothing has spent the others. */
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString();
const DEEPSEEK = deepseek(1, 'DeepSeek', {
  lastUsedAt: THREE_DAYS_AGO,
  models: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  defaultModel: 'deepseek-v4-flash',
});
const DEEPSEEK_2 = deepseek(2, 'DeepSeek 2', {
  runtime: 'dsh',
  engines: ['dsh', 'claude', 'opencode'] as ProviderRow['engines'],
  presetSlug: 'deepseek-harness',
});
const GEMINI = key(3, 'Gemini', {
  runtime: 'antigravity',
  engines: ['antigravity', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://generativelanguage.googleapis.com',
  presetSlug: 'gemini',
  models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
});
const KIMI = key(4, 'Kimi (Moonshot)', {
  runtime: 'kimi',
  engines: ['kimi', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.moonshot.ai/v1',
  presetSlug: 'moonshot',
});
const GLM = key(5, 'Z.AI (GLM)', { baseUrl: 'https://api.z.ai/api/anthropic', presetSlug: 'glm' });
const CLAUDE_MAX = key(6, 'Claude Max', { engines: ['claude'] as ProviderRow['engines'] });
const KEYS = [DEEPSEEK, DEEPSEEK_2, GEMINI, KIMI, GLM, CLAUDE_MAX];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = '';
let keys: ProviderRow[] = [];
let usage: Record<string, ProviderKeyUsage> = {};
let pools: unknown[] = [];
let sent: Array<{ method: string; path: string }> = [];

function Probe() {
  path = useLocation().pathname;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  keys = KEYS;
  usage = {};
  pools = [];
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p });
      return {};
    }
    if (p === '/runners') return [];
    if (p === '/providers/mine') return keys;
    if (p === '/providers/pools') return pools;
    const balance = /^\/providers\/mine\/([^/]+)\/balance/.exec(p);
    if (balance) {
      return {
        ok: true,
        providerId: balance[1],
        balances: [{ currency: 'CNY', totalBalance: balance[1] === DEEPSEEK.id ? '110.00' : '36.20', grantedBalance: '0.00', toppedUpBalance: '0.00' }],
        isAvailable: true,
        fetchedAt: new Date().toISOString(),
        sharedWith: [],
      };
    }
    const used = /^\/providers\/mine\/([^/]+)\/usage$/.exec(p);
    if (used) return usage[used[1]] ?? { providerId: used[1], engines: [], sessions: 0, tasks: 0 };
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(vendor?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[vendor ? `/settings/providers/${vendor}` : '/settings/providers']}>
          <Probe />
          <Routes>
            <Route path="/settings/providers" element={<SettingsProvidersHome />} />
            <Route path="/settings/providers/new" element={<div>pick a vendor</div>} />
            <Route path="/settings/providers/:vendor" element={<SettingsKeysPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}
function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
/** An element's words, without the monograms drawn on its marks (OpenCode's "O"). */
const words = (el: Element | null | undefined) => {
  if (!el) return null;
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.provider-tile').forEach((tile) => tile.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? null;
};

const button = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => text(el) === words) ?? null;
const section = (title: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.settings-section')].find((el) =>
    text(el.querySelector('.settings-section-title'))?.startsWith(title),
  ) ?? null;
const vendorSections = () => [...document.body.querySelectorAll<HTMLElement>('.sp-vendor-section')];
const keyRows = () => vendorSections().flatMap((el) => [...el.querySelectorAll<HTMLElement>('.settings-row')]);
const chips = () => [...document.body.querySelectorAll<HTMLAnchorElement>('.sp-chip')];
const keyRow = (label: string) => keyRows().find((row) => text(row.querySelector('.vk-name'))?.startsWith(label))!;

/** Opens the key's ⋯ and presses an item in it. */
async function pressMenuItem(row: HTMLElement, label: string) {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-label^="More for"]')!;
  await act(async () => trigger.click());
  let item: HTMLElement | undefined;
  await act(async () => {
    await vi.waitFor(() => {
      item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => text(el) === label);
      if (!item) throw new Error(`no ${label} in the menu yet`);
    });
  });
  await act(async () => item!.click());
}

describe('the API keys page in Settings', () => {
  it('lists every key, a section per vendor in the order of its first key, and a chip per vendor', async () => {
    await mount();
    expect(text(document.body.querySelector('.sp-vendor-title'))).toBe('API keys');
    expect(text(document.body.querySelector('.sp-vendor-sub'))).toBe(
      'Keys on your account, usable from every machine and billed per token.',
    );
    expect(vendorSections().map((el) => words(el.querySelector('.settings-section-title')))).toEqual([
      'DeepSeek 2 keys',
      'Google Gemini 1 key',
      'Moonshot (Kimi) 1 key',
      'Z.AI (GLM) 1 key',
      'Anthropic 1 key',
    ]);
    // Each beside its vendor's mark.
    expect(vendorSections().every((el) => el.querySelector('.settings-section-title .provider-tile'))).toBe(true);
    expect(keyRows()).toHaveLength(6);
    expect(chips().map((chip) => [text(chip), chip.getAttribute('href'), chip.classList.contains('on')])).toEqual([
      ['All 6', '/settings/providers', true],
      ['DeepSeek 2', '/settings/providers/deepseek', false],
      ['Google Gemini 1', '/settings/providers/gemini', false],
      ['Moonshot (Kimi) 1', '/settings/providers/moonshot', false],
      ['Z.AI (GLM) 1', '/settings/providers/glm', false],
      ['Anthropic 1', '/settings/providers/anthropic', false],
    ]);

    // A chip shows that vendor's keys alone, at the vendor's address; All shows them all again.
    await act(async () => chips()[1].click());
    expect(path).toBe('/settings/providers/deepseek');
    expect(vendorSections()).toHaveLength(1);
    expect(chips().filter((chip) => chip.classList.contains('on')).map(text)).toEqual(['DeepSeek 2']);
    await act(async () => chips()[0].click());
    expect(path).toBe('/settings/providers');
    expect(vendorSections()).toHaveLength(5);

    // Add key in the page's heading picks the vendor first.
    await act(async () => button('Add key', document.body.querySelector('.sp-vendor-head')!)!.click());
    expect(path).toBe('/settings/providers/new');
  });

  it('draws no chips while every key is one vendor’s', async () => {
    keys = [DEEPSEEK, DEEPSEEK_2];
    await mount();
    expect(vendorSections()).toHaveLength(1);
    expect(chips()).toEqual([]);
  });

  it('is connecting a key while there is none', async () => {
    keys = [];
    await mount();
    expect(path).toBe('/settings/providers/new');
  });

  it('shows a vendor’s keys alone at its address — a key from the retired Harness preset among DeepSeek’s', async () => {
    await mount('deepseek');
    expect(vendorSections().map((el) => words(el.querySelector('.settings-section-title')))).toEqual(['DeepSeek 2 keys']);
    expect(keyRows().map((row) => text(row.querySelector('.vk-name')))).toEqual(['DeepSeek', 'DeepSeek 2']);
    // The table's endpoint and model count are the key's own page's.
    expect(text(vendorSections()[0])).not.toContain('https://');
    // Each key's Edit opens its own page in Settings' right-hand column.
    await act(async () => button('Edit', keyRow('DeepSeek 2'))!.click());
    expect(path).toBe(`/settings/providers/keys/${DEEPSEEK_2.id}`);
  });

  it('adds another of a vendor’s keys from its section’s heading', async () => {
    await mount();
    const anthropic = vendorSections()[4];
    expect([...anthropic.querySelectorAll('.vk-name')].map(text)).toEqual(['Claude Max']);
    const add = button('Add', anthropic.querySelector('.settings-section-action')!)!;
    expect(add.getAttribute('aria-label')).toBe('Add Anthropic key');
    await act(async () => add.click());
    expect(path).toBe('/settings/providers/new/anthropic');
  });

  it('says under each key which engines run it, the server’s order, and keeps a DeepSeek key’s balance', async () => {
    const engines = (label: string) => words(keyRow(label).querySelector('.prov-engines'));
    await mount('deepseek');
    expect(engines('DeepSeek')).toBe('Runs on Claude Code · OpenCode · DeepSeek Harness');
    expect(engines('DeepSeek 2')).toBe('Runs on DeepSeek Harness · Claude Code · OpenCode');
    // Each engine beside its mark.
    expect(keyRow('DeepSeek').querySelectorAll('.prov-engine .provider-tile')).toHaveLength(3);
    await act(async () => {
      await vi.waitFor(() => expect(text(keyRow('DeepSeek 2').querySelector('.dsb-row'))).toContain('¥36.20'));
    });
    expect(text(keyRow('DeepSeek').querySelector('.dsb-row'))).toContain('Account balance ¥110.00');
    // Nothing on a key says which machines run Harness.
    expect(text(vendorSections()[0])).not.toMatch(/Ready on|Not ready/);
    expect(document.body.querySelector('[data-testid="dsh-runner-status"]')).toBeNull();
    unmount();

    for (const [vendor, label, expected] of [
      ['gemini', 'Gemini', 'Runs on Antigravity CLI · OpenCode'],
      ['moonshot', 'Kimi (Moonshot)', 'Runs on Kimi Code · OpenCode'],
      ['glm', 'Z.AI (GLM)', 'Runs on Claude Code · OpenCode'],
      // A Claude subscription token runs on Claude Code alone, and says why.
      ['anthropic', 'Claude Max', 'Runs on Claude Code · subscription token, Claude Code only'],
    ] as const) {
      await mount(vendor);
      expect(engines(label)).toBe(expected);
      expect(keyRow(label).querySelector('.dsb-row')).toBeNull();
      unmount();
    }
  });

  it('says what each key starts a session on, whether it is off, and when it last ran one — never used for one nothing has spent', async () => {
    keys = [...KEYS.slice(0, 5), { ...CLAUDE_MAX, enabled: false }];
    await mount('deepseek');
    // Its default model by its list's name, else the first it lists.
    expect(text(keyRow('DeepSeek').querySelector('.vk-model'))).toBe('· Starts on DeepSeek V4 Flash');
    expect(text(keyRow('DeepSeek').querySelector('.vk-used'))).toBe('last used 3d ago');
    // What the relative time stands for is its tooltip.
    expect(keyRow('DeepSeek').querySelector('.vk-used')?.getAttribute('title')).toBe(
      new Date(THREE_DAYS_AGO).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    );
    // A key that is on says nothing of it.
    expect(text(keyRow('DeepSeek').querySelector('.vk-name'))).toBe('DeepSeek');
    unmount();

    await mount('gemini');
    expect(text(keyRow('Gemini').querySelector('.vk-model'))).toBe('· Starts on Gemini 3.8 Flash');
    unmount();
    // Nothing for a key that lists no model.
    await mount('glm');
    expect(keyRow('Z.AI (GLM)').querySelector('.vk-model')).toBeNull();
    unmount();

    // A key nobody has spent says so, in the muted state, rather than showing a time; a key switched off
    // says that beside its name.
    await mount('anthropic');
    const row = keyRow('Claude Max');
    expect(text(row.querySelector('.vk-name'))).toBe('Claude Max Disabled');
    expect(text(row.querySelector('.vk-used.never'))).toBe('never used');
    expect(row.querySelector('.vk-used[title]')).toBeNull();
    expect([...row.querySelectorAll('.vk-act button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Edit Claude Max',
      'More for Claude Max',
    ]);
  });

  it('names the account pools each key is in, and lists the pools using these keys, each a way to the pools page', async () => {
    pools = [
      { id: 'pool-1', slug: 'team', label: 'Team Claude', resetsAt: null, members: [{ id: DEEPSEEK.id }, { id: GLM.id }] },
      { id: 'pool-2', slug: 'other', label: 'Other', resetsAt: null, members: [{ id: GLM.id }] },
    ];
    await mount('deepseek');
    expect(text(keyRow('DeepSeek').querySelector('.vk-pool'))).toBe('· in pool “Team Claude”');
    expect(keyRow('DeepSeek 2').querySelector('.vk-pool')).toBeNull();
    const using = section('Account pools using these keys')!;
    expect([...using.querySelectorAll('.settings-row')].map((row) => text(row.querySelector('.settings-row-title')))).toEqual([
      'Team Claude',
    ]);
    expect(text(using.querySelector('.settings-row-description'))).toBe('2 accounts · dispatches to whichever has quota left');
    expect(using.querySelector('a')?.getAttribute('href')).toBe('/settings/providers/pools');
    unmount();

    // A vendor none of whose keys is in a pool has no such section.
    await mount('gemini');
    expect(section('Account pools using these keys')).toBeNull();
  });

  it('offers no row of vendors not connected yet', async () => {
    await mount('deepseek');
    expect(section('Not connected yet')).toBeNull();
    expect(document.body.querySelector('a[href^="/settings/providers/new/"]:not([href="/settings/providers/new/deepseek"])')).toBeNull();
  });

  it('asks before deleting a key from its ⋯ what uses it on every engine it works with', async () => {
    usage[DEEPSEEK.id] = {
      providerId: DEEPSEEK.id,
      engines: [
        { engine: 'claude', sessions: 2, tasks: 1 },
        { engine: 'dsh', sessions: 1, tasks: 0 },
      ] as ProviderKeyUsage['engines'],
      sessions: 3,
      tasks: 1,
    };
    await mount('deepseek');
    await pressMenuItem(keyRow('DeepSeek'), 'Delete');
    const dialog = await openDialog('Delete DeepSeek?');
    await act(async () => {
      await vi.waitFor(() => expect(text(dialog)).toContain('They keep their engine'));
    });
    expect([...dialog.querySelectorAll('.key-impact > p, .key-impact-row')].map(words)).toEqual([
      'It goes from all three engines it works with:',
      'Claude Code — 2 open sessions, 1 task pinned',
      'OpenCode — not in use',
      'DeepSeek Harness — 1 open session',
      'They keep their engine and can’t run until you switch them to another key. To pause the key instead, turn it off.',
    ]);
    expect(sent).toEqual([]);
    await act(async () => {
      button('Delete key', dialog)!.click();
    });
    await settle();
    expect(sent).toEqual([{ method: 'DELETE', path: `/providers/mine/${DEEPSEEK.id}` }]);
    // DeepSeek has another key, so its chip stays chosen.
    expect(path).toBe('/settings/providers/deepseek');
  });

  it('goes back to every key once the chosen vendor’s last key is deleted', async () => {
    await mount('gemini');
    await pressMenuItem(keyRow('Gemini'), 'Delete');
    const dialog = await openDialog('Delete Gemini?');
    // Nothing uses it: the question says so, engine by engine.
    await act(async () => {
      await vi.waitFor(() => expect(text(dialog)).toContain('Nothing uses it right now.'));
    });
    expect([...dialog.querySelectorAll('.key-impact-row')].map(words)).toEqual([
      'Antigravity CLI — not in use',
      'OpenCode — not in use',
    ]);
    await act(async () => {
      button('Delete key', dialog)!.click();
    });
    await settle();
    expect(sent).toEqual([{ method: 'DELETE', path: `/providers/mine/${GEMINI.id}` }]);
    expect(path).toBe('/settings/providers');
  });
});
