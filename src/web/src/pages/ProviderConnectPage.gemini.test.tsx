// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { PROVIDERS_BASE, type ProviderRow } from '../lib/providerAdmin';
import { ProviderConnectPage } from './ProviderConnectPage';

/**
 * The Gemini preset, which runs on the Antigravity CLI (agy): connecting a key probes the Gemini API
 * on the endpoint agy calls and saves the row on that runtime, and editing a row keeps it there. The
 * form used to know only claude/codex/kimi, and read anything else as Claude — so a Save on a Gemini
 * row would have sent `runtime: 'claude'` back and moved it off agy.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

/** A row connected from the Gemini preset, as GET /providers/mine serves it. */
const geminiRow: ProviderRow = {
  id: 'p-gemini',
  slug: 'gemini',
  label: 'Gemini',
  runtime: 'antigravity',
  baseUrl: 'https://generativelanguage.googleapis.com',
  models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576 }],
  defaultModel: 'gemini-3.8-flash',
  presetSlug: 'gemini',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
};

describe('connecting a Gemini key', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rows: ProviderRow[] = [];
  let sent: Sent[] = [];

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
            <AntApp>
              <Routes>
                <Route path="/providers" element={<div>providers</div>} />
                <Route path="/providers/new/:slug" element={<ProviderConnectPage />} />
                <Route path="/providers/:id" element={<ProviderConnectPage />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };

  const text = () => container.textContent ?? '';
  const button = (words: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (el) => el.textContent?.trim() === words,
    ) ?? null;
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

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rows = [];
    sent = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    apiMock.mockReset();
    apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (p === PROVIDERS_BASE) return rows;
        // No server refresh for this vendor: the form falls back to the shipped preset.
        if (p === '/providers/presets') return {};
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      if (p === '/providers/test') return { ok: true, status: 200, message: 'Connected' };
      return {};
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

  it('says it runs on Antigravity, what agy does with the key, and nothing about not running', async () => {
    await mount('/providers/new/gemini');
    expect(container.querySelector('h1')?.textContent).toBe('Connect Antigravity');
    expect(text()).toContain('Runs on the Antigravity CLI');
    expect(text()).toContain('models from the runtime CLI');
    expect(text()).toContain('commands the agent runs can read it');
    expect(text()).toContain('usage statistics (not your conversations) to Google');
    expect(text()).not.toMatch(/can't run today|Responses API/);
  });

  it('probes the Gemini API with the model a session would run, then saves the row on agy', async () => {
    await mount('/providers/new/gemini');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'AIza-test');
    await click(button('Connect'));

    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/providers/test',
      body: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIza-test',
        model: 'gemini-3.8-flash',
        runtime: 'antigravity',
      },
    });
    expect(sent[1].method).toBe('POST');
    expect(sent[1].path).toBe(PROVIDERS_BASE);
    // The list is agy's, read off the runner: nothing of it is sent to be parked on the row.
    expect(sent[1].body).toEqual({
      label: 'Antigravity',
      runtime: 'antigravity',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-test',
      presetSlug: 'gemini',
      followsPreset: true,
      enabled: true,
    });
  });

  it('keeps an edited row on agy and preserves its stored name unless renamed', async () => {
    rows = [geminiRow];
    await mount('/providers/p-gemini');
    // No new key, so nothing to probe: Save writes straight away.
    await click(button('Save'));

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('PATCH');
    expect(sent[0].path).toBe(`${PROVIDERS_BASE}/p-gemini`);
    expect((sent[0].body as { runtime?: string }).runtime).toBe('antigravity');
    expect((sent[0].body as { label?: string }).label).toBe('Gemini');
  });
});
