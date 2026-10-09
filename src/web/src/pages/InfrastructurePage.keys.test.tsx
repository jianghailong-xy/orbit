// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderKeyUsage } from '@orbit/shared';
import { openDialog } from '../components/RunnerEngines.test-helpers';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * Infrastructure's API keys after the provider/engine split
 * (docs/mocks/provider-engine-decoupling/web-1-infrastructure.html ③ and ④): the keys under their
 * vendors, each saying which engines it runs on — the server's `engines` — and a DeepSeek key its
 * account balance; the gallery a vendor to a card, DeepSeek Harness among none of them; and a key's
 * Delete asking first what uses it on each of those engines.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
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
const DEEPSEEK = deepseek(1, 'DeepSeek');
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
let usage: Record<string, ProviderKeyUsage> = {};
let sent: Array<{ method: string; path: string }> = [];

function Probe() {
  path = useLocation().pathname;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  usage = {};
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p });
      return {};
    }
    if (p === '/runners') return [];
    if (p === '/providers/mine') return KEYS;
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

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/infrastructure']}>
          <Probe />
          <Routes>
            <Route path="/infrastructure" element={<InfrastructurePage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
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
const keyRow = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.provider-keys tr.prov-key')].find(
    (row) => text(row.querySelector('.prov-cell-name')) === label,
  )!;

describe('API keys after the provider/engine split', () => {
  it('lists the keys under their vendors, in the order each vendor first appears, each with the way to add another', async () => {
    await mount();
    expect(text(document.body.querySelector('.provider-keys thead th'))).toBe('Key');
    const lines = [...document.body.querySelectorAll<HTMLElement>('.provider-keys tbody tr')].map((row) =>
      row.classList.contains('prov-group') ? `# ${text(row.querySelector('.prov-group-in'))}` : text(row.querySelector('.prov-cell-name')),
    );
    expect(lines).toEqual([
      // The key made from the retired Harness preset is DeepSeek's, beside the other.
      '# DeepSeek 2 keys + Add key',
      'DeepSeek',
      'DeepSeek 2',
      '# Google Gemini + Add key',
      'Gemini',
      '# Moonshot (Kimi) + Add key',
      'Kimi (Moonshot)',
      '# Z.AI (GLM) + Add key',
      'Z.AI (GLM)',
      '# Anthropic + Add key',
      'Claude Max',
    ]);
    expect(
      [...document.body.querySelectorAll<HTMLAnchorElement>('.prov-group-add')].map((a) => a.getAttribute('href')),
    ).toEqual(['/providers/new/deepseek', '/providers/new/gemini', '/providers/new/moonshot', '/providers/new/glm', '/providers/new/anthropic']);
  });

  it('says under each key which engines run it, the server’s order, and keeps a DeepSeek key’s balance', async () => {
    await mount();
    const engines = (label: string) => words(keyRow(label).querySelector('.prov-engines'));
    expect(engines('DeepSeek')).toBe('Claude Code · OpenCode · DeepSeek Harness');
    expect(engines('DeepSeek 2')).toBe('DeepSeek Harness · Claude Code · OpenCode');
    expect(engines('Gemini')).toBe('Antigravity CLI · OpenCode');
    expect(engines('Kimi (Moonshot)')).toBe('Kimi Code · OpenCode');
    expect(engines('Z.AI (GLM)')).toBe('Claude Code · OpenCode');
    // A Claude subscription token runs on Claude Code alone, and says why.
    expect(engines('Claude Max')).toBe('Claude Code · subscription token, Claude Code only');
    // Each engine beside its mark.
    expect(keyRow('DeepSeek').querySelectorAll('.prov-engine .provider-tile')).toHaveLength(3);
    await act(async () => {
      await vi.waitFor(() => expect(text(keyRow('DeepSeek 2').querySelector('.dsb-row'))).toContain('¥36.20'));
    });
    expect(text(keyRow('DeepSeek').querySelector('.dsb-row'))).toContain('Account balance ¥110.00');
    expect(keyRow('Gemini').querySelector('.dsb-row')).toBeNull();
    // Nothing on a key says it runs on one engine, or which machines run Harness.
    expect(text(document.body.querySelector('.provider-keys'))).not.toMatch(/Runs on|Ready on|Not ready/);
    expect(document.body.querySelector('[data-testid="dsh-runner-status"]')).toBeNull();
  });

  it('offers a card per vendor, by the vendor’s name, and none for DeepSeek Harness', async () => {
    await mount();
    const cards = [...document.body.querySelectorAll<HTMLAnchorElement>('.provider-more .provider-card')];
    expect(cards.map((card) => [text(card.querySelector('.pc-name')), text(card.querySelector('.pc-sub'))])).toEqual([
      ['Anthropic', 'Connected'],
      ['OpenAI', 'Codex · OpenCode'],
      ['Google Gemini', 'Connected'],
      // Both DeepSeek keys count towards DeepSeek.
      ['DeepSeek', 'Connected · 2 keys'],
      ['Moonshot (Kimi)', 'Connected'],
      ['Z.AI (GLM)', 'Connected'],
      ['MiniMax', 'Claude Code · OpenCode'],
      ['Qwen', 'Claude Code · OpenCode'],
      ['Custom', 'Manual endpoint'],
    ]);
    expect(document.body.querySelector('a[href="/providers/new/deepseek-harness"]')).toBeNull();
  });

  it('asks before deleting a key what uses it on every engine it works with', async () => {
    usage[DEEPSEEK.id] = {
      providerId: DEEPSEEK.id,
      engines: [
        { engine: 'claude', sessions: 2, tasks: 1 },
        { engine: 'dsh', sessions: 1, tasks: 0 },
      ] as ProviderKeyUsage['engines'],
      sessions: 3,
      tasks: 1,
    };
    await mount();
    await act(async () => {
      button('Delete', keyRow('DeepSeek'))!.click();
    });
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
    expect(path).toBe('/infrastructure');
  });
});
