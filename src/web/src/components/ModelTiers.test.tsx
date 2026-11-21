// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SubagentTiersResponse } from '@orbit/shared';
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

const TIERS: SubagentTiersResponse = {
  providers: [
    {
      slug: 'cursor', label: 'Cursor', kind: 'builtin', providerId: null, billing: 'subscription',
      models: [
        { model: 'claude-opus-5-6', levels: ['L', 'XL'], source: 'catalogue', editable: true, outputPricePerMTok: null },
        { model: 'grok-4.7', levels: ['L'], source: 'owner', editable: true, outputPricePerMTok: null },
        { model: 'claude-opus-5', levels: [], source: null, editable: true, outputPricePerMTok: null, supersededBy: 'claude-opus-5-6' },
        { model: 'kimi-k3', levels: [], source: null, editable: true, outputPricePerMTok: null },
      ],
    },
    {
      slug: 'my-endpoint', label: 'My endpoint', kind: 'key', providerId: 'k1', billing: 'key',
      models: [{ model: 'qwen-coder', levels: ['M'], source: 'owner', editable: true, outputPricePerMTok: null }],
    },
    {
      slug: 'deepseek', label: 'DeepSeek', kind: 'key', providerId: 'k2', billing: 'key',
      models: [{ model: 'deepseek-v4-pro', levels: ['L'], source: 'catalogue', editable: false, outputPricePerMTok: 1.98 }],
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

  it("keeps a key's model on its own door", async () => {
    const { writes } = await mount();
    expect(await openMenu('qwen-coder')).toEqual(['S', 'M', 'L', 'XL', 'Clear']);
    await choose('S');
    expect(writes).toEqual([{ path: '/providers/mine/k1/model-tier', body: { model: 'qwen-coder', tier: 'S' } }]);
  });
});
