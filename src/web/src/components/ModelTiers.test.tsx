// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelQuality, SubagentTiersResponse } from '@orbit/shared';
import { ModelTiers } from './ModelTiers';

/**
 * The Providers page's Tier column (docs/subagent-design.md §7; board 2026-11-20, file 350aNOQs4SEwHBvVKj4A7):
 * every model of a built-in engine's catalogue is listed and the owner's to tier through
 * PATCH /providers/builtin/:engine/model-tier; Clear is offered only on a tier the owner set; such a tier carries
 * a "Yours" tag. A key's model keeps its own door.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

/** No SubAgent run and no done task: the row reads "No runs yet". */
const NONE: ModelQuality = {
  subagent: { averageRating: null, ratedCount: 0, runCount: 0, raters: [] },
  tasks: { firstPassRate: null, firstPassTaskCount: 0, completedTaskCount: 0 },
};
/** Enough of both, rated by two parents' models. */
const RATED: ModelQuality = {
  subagent: {
    averageRating: 4.4, ratedCount: 23, runCount: 41,
    raters: [
      { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', count: 15 },
      { engine: 'claude', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', count: 8 },
    ],
  },
  tasks: { firstPassRate: 0.86, firstPassTaskCount: 45, completedTaskCount: 52 },
};
/** Some of each, below both minimums. */
const SPARSE: ModelQuality = {
  subagent: { averageRating: null, ratedCount: 3, runCount: 12,
    raters: [{ engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', count: 3 }] },
  tasks: { firstPassRate: null, firstPassTaskCount: 4, completedTaskCount: 6 },
};

const TIERS: SubagentTiersResponse = {
  providers: [
    {
      slug: 'cursor', label: 'Cursor', kind: 'builtin', providerId: null, billing: 'subscription',
      models: [
        { model: 'claude-opus-5-6', levels: ['L', 'XL'], source: 'catalogue', editable: true, outputPricePerMTok: null, quality: RATED },
        { model: 'grok-4.7', levels: ['L'], source: 'owner', editable: true, outputPricePerMTok: null, quality: SPARSE },
        { model: 'claude-opus-5', levels: [], source: null, editable: true, outputPricePerMTok: null, supersededBy: 'claude-opus-5-6', quality: NONE },
        { model: 'kimi-k3', levels: [], source: null, editable: true, outputPricePerMTok: null, quality: NONE },
      ],
    },
    {
      slug: 'my-endpoint', label: 'My endpoint', kind: 'key', providerId: 'k1', billing: 'key',
      models: [{ model: 'qwen-coder', levels: ['M'], source: 'owner', editable: true, outputPricePerMTok: null, quality: NONE }],
    },
    {
      slug: 'deepseek', label: 'DeepSeek', kind: 'key', providerId: 'k2', billing: 'key',
      models: [{ model: 'deepseek-v4-pro', levels: ['L'], source: 'catalogue', editable: false, outputPricePerMTok: 1.98, quality: NONE }],
    },
  ],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
});

async function mount() {
  const writes: Array<{ path: string; body: unknown }> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method === 'PATCH') { writes.push({ path, body: options.body }); return {}; }
    if (path === '/providers/subagent-tiers') return TIERS;
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={qc}><ModelTiers /></QueryClientProvider>));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { writes };
}

const rowOf = (model: string) => [...document.querySelectorAll('.model-tiers tbody tr')]
  .find((row) => row.querySelector('.model-tiers-model')?.textContent === model) as HTMLTableRowElement;

async function openMenu(model: string): Promise<string[]> {
  const button = rowOf(model).querySelector<HTMLButtonElement>('button.model-tiers-set')!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
}

async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')]
    .find((entry) => entry.textContent?.trim() === label)!;
  await act(async () => { item.click(); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('ModelTiers', () => {
  it("lists a built-in engine's whole catalogue, each model a tier button, with Yours on the owner's tiers", async () => {
    await mount();
    for (const model of ['claude-opus-5-6', 'grok-4.7', 'kimi-k3']) {
      expect(rowOf(model).querySelector('button.model-tiers-set'), model).not.toBeNull();
    }
    expect(rowOf('kimi-k3').querySelector('button')?.textContent).toBe('Not set');
    expect(rowOf('grok-4.7').querySelector('.model-tiers-yours')?.textContent).toBe('Yours');
    expect(rowOf('qwen-coder').querySelector('.model-tiers-yours')?.textContent).toBe('Yours');
    expect(rowOf('claude-opus-5-6').querySelector('.model-tiers-yours')).toBeNull();
    // The catalogue's tier on a key stays plain text.
    expect(rowOf('deepseek-v4-pro').querySelector('button')).toBeNull();
  });

  it('reads an older family model as Older · uses the newest, still a tier button with the S-XL menu', async () => {
    await mount();
    const button = rowOf('claude-opus-5').querySelector<HTMLButtonElement>('button.model-tiers-set')!;
    expect(button.textContent).toBe('Older · uses claude-opus-5-6');
    expect(button.classList.contains('model-tiers-older')).toBe(true);
    expect(button.classList.contains('model-tiers-unset')).toBe(false);
    expect(await openMenu('claude-opus-5')).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('sets a built-in model\'s tier through the builtin door', async () => {
    const { writes } = await mount();
    expect(await openMenu('kimi-k3')).toEqual(['S', 'M', 'L', 'XL']);
    await choose('M');
    expect(writes).toEqual([{ path: '/providers/builtin/cursor/model-tier', body: { model: 'kimi-k3', tier: 'M' } }]);
  });

  it('offers no Clear on a catalogue tier', async () => {
    await mount();
    expect(await openMenu('claude-opus-5-6')).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('offers Clear on a tier the owner set, and clears it with null', async () => {
    const { writes } = await mount();
    expect(await openMenu('grok-4.7')).toEqual(['S', 'M', 'L', 'XL', 'Clear']);
    await choose('Clear');
    expect(writes).toEqual([{ path: '/providers/builtin/cursor/model-tier', body: { model: 'grok-4.7', tier: null } }]);
  });

  it('shows a Quality column: two figures, why one is missing, and No runs yet', async () => {
    await mount();
    expect([...document.querySelectorAll('.model-tiers thead th')].map((th) => th.textContent))
      .toEqual(['Provider', 'Model', 'Tier', 'Quality', 'Price / M out']);
    const quality = (model: string) => [...rowOf(model).querySelectorAll('.model-tiers-quality .model-tiers-quality-line')]
      .map((line) => line.textContent);
    expect(quality('claude-opus-5-6')).toEqual(['SubAgents4.4 · 23 rated of 41', 'Tasks86% first pass · 52 tasks']);
    expect(quality('grok-4.7')).toEqual(['SubAgentsNot enough ratings', 'TasksNot enough tasks']);
    expect(rowOf('grok-4.7').querySelectorAll('.model-tiers-quality .model-tiers-muted')).toHaveLength(2);
    expect(rowOf('kimi-k3').querySelector('.model-tiers-quality')?.textContent).toBe('No runs yet');
    expect(document.querySelector('#tiers')?.textContent).toContain('Quality is shown, not used for routing.');
  });

  it('says who rated in a tooltip on the SubAgents line, only where there is an average', async () => {
    await mount();
    expect(rowOf('grok-4.7').querySelector('.model-tiers-rated')).toBeNull();
    const line = rowOf('claude-opus-5-6').querySelector<HTMLElement>('.model-tiers-rated')!;
    await act(async () => { line.focus(); line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Rated by Opus 5.5 (15) · Sonnet 5.5 (8)');
  });

  it("keeps a key's model on its own door", async () => {
    const { writes } = await mount();
    expect(await openMenu('qwen-coder')).toEqual(['S', 'M', 'L', 'XL', 'Clear']);
    await choose('S');
    expect(writes).toEqual([{ path: '/providers/mine/k1/model-tier', body: { model: 'qwen-coder', tier: 'S' } }]);
  });
});
