// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { PROVIDERS_BASE, type ProviderRow } from '../lib/providerAdmin';
import { ProviderConnectPage } from './ProviderConnectPage';

/**
 * A vendor with separate international and China platforms (MiniMax, Z.AI/Zhipu, Moonshot): a key
 * works only on the platform it was made on, so the form asks which one, and a key the chosen one
 * refuses but the other accepts is offered the switch instead of "Save anyway".
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

type Answer = { ok: boolean; message: string; region?: { id: string; label: string; baseUrl: string } };

describe('a vendor with an international and a China platform', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rows: ProviderRow[] = [];
  let sent: { method: string; path: string; body?: unknown }[] = [];
  let answers: Answer[] = [];

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const mount = async (at: string) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path="/settings/providers" element={<div>providers</div>} />
              <Route path="/settings/providers/:vendor" element={<div>vendor</div>} />
              <Route path="/settings/providers/new/:slug" element={<ProviderConnectPage />} />
              <Route path="/settings/providers/keys/:id" element={<ProviderConnectPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  const text = () => (container.textContent ?? '').replace(/\s+/g, ' ');
  const button = (words: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent?.trim() === words) ?? null;
  const option = (words: string) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]')).find((el) => el.textContent?.trim() === words) ?? null;
  const keyLink = () =>
    Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.includes('Get your API key'))?.href;
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const type = async (input: HTMLInputElement | null | undefined, value: string) => {
    if (!input) throw new Error('nothing to type into');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  const probes = () => sent.filter((s) => s.path === '/providers/test').map((s) => (s.body as { baseUrl: string }).baseUrl);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rows = [];
    sent = [];
    answers = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    apiMock.mockReset();
    apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (p === PROVIDERS_BASE) return rows;
        if (p === '/providers/presets') return {};
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      if (p === '/providers/test') return answers.shift() ?? { ok: true, message: 'Connected' };
      return { id: 'p-new' };
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

  it('asks which platform the account is on, and the China one points the key link and the endpoint there', async () => {
    await mount('/settings/providers/new/minimax');
    expect(text()).toContain('Your account is on');
    expect(option('International · minimax.io')?.getAttribute('aria-checked')).toBe('true');
    expect(keyLink()).toBe('https://www.minimax.io/');

    await click(option('China · minimaxi.com'));
    expect(option('China · minimaxi.com')?.getAttribute('aria-checked')).toBe('true');
    expect(keyLink()).toBe('https://platform.minimaxi.com/');

    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'sk-test');
    await click(button('Connect'));
    expect(probes()).toEqual(['https://api.minimaxi.com/anthropic']);
    expect(sent.find((s) => s.path === PROVIDERS_BASE)?.body).toMatchObject({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      presetSlug: 'minimax',
    });
  });

  it('offers the other platform when the key works only there, and connects on it', async () => {
    answers = [
      {
        ok: false,
        message: 'This key is from the China platform (minimaxi.com), not the international platform',
        region: { id: 'cn', label: 'China', baseUrl: 'https://api.minimaxi.com/anthropic' },
      },
    ];
    await mount('/settings/providers/new/minimax');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'sk-test');
    await click(button('Connect'));
    expect(text()).toContain('This key is from the China platform (minimaxi.com)');
    expect(button('Save anyway')).toBeNull();
    expect(sent.some((s) => s.path === PROVIDERS_BASE)).toBe(false);

    await click(button('Switch to China'));
    expect(option('China · minimaxi.com')?.getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain('This key is from');
    await click(button('Connect'));
    expect(probes()).toEqual(['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic']);
    expect(sent.find((s) => s.path === PROVIDERS_BASE)?.body).toMatchObject({ baseUrl: 'https://api.minimaxi.com/anthropic' });
  });

  it('keeps "Save anyway" for a key neither platform takes', async () => {
    answers = [{ ok: false, message: 'Invalid API key — refused on both minimax.io and minimaxi.com' }];
    await mount('/settings/providers/new/minimax');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'sk-test');
    await click(button('Connect'));
    expect(text()).toContain('refused on both minimax.io and minimaxi.com');
    expect(button('Save anyway')).not.toBeNull();
  });

  it('shows a saved China key as China, and has no switch for a vendor with one platform', async () => {
    rows = [
      {
        id: 'p-mm', slug: 'minimax', label: 'MiniMax', runtime: 'claude', engines: ['claude', 'opencode'] as ProviderRow['engines'],
        baseUrl: 'https://api.minimaxi.com/anthropic', models: [], defaultModel: null, presetSlug: 'minimax',
        followsPreset: true, enabled: true, hasApiKey: true,
      },
    ];
    await mount('/settings/providers/keys/p-mm');
    expect(option('China · minimaxi.com')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => root.unmount());
    container.remove();

    await mount('/settings/providers/new/deepseek');
    expect(text()).not.toContain('Your account is on');
  });
});
