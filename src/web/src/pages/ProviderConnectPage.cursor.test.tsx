// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorKeyCheckAnswer } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE, type ProviderRow } from '../lib/providerAdmin';
import { ProviderConnectPage } from './ProviderConnectPage';

/**
 * Connecting a Cursor User API Key (the owner's board, docs/mocks/cursor-engine Web 4): a key Cursor CLI
 * alone runs on, which the server never uses itself — a runner of the owner's checks it with
 * `agent models` (P2 follow-up, POST /providers/test with `runtime: 'cursor'`). A key Cursor refuses is
 * not saved and offers no "Save anyway"; Cursor or a runner out of reach says nothing about the key,
 * which may be saved anyway; and a saved key is checked again at once, so its row has an answer.
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

const cursorRow: ProviderRow = {
  id: 'p-cursor',
  slug: 'cursor-api',
  label: 'Cursor',
  runtime: 'cursor',
  engines: ['cursor'] as ProviderRow['engines'],
  baseUrl: 'https://api2.cursor.sh',
  models: [],
  defaultModel: null,
  presetSlug: 'cursor-api',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  keyCheckState: 'VALID',
  keyCheckedAt: '2026-10-17T06:00:00.000Z',
};

describe('connecting a Cursor key', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rows: ProviderRow[] = [];
  let sent: Sent[] = [];
  let check: CursorKeyCheckAnswer;

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
              <Route path="/infrastructure" element={<div>infrastructure</div>} />
              <Route path="/providers/new/:slug" element={<ProviderConnectPage />} />
              <Route path="/providers/:id" element={<ProviderConnectPage />} />
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
  const connectWith = async (answer: CursorKeyCheckAnswer) => {
    check = answer;
    await mount('/providers/new/cursor-api');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'key_test_cursor');
    await click(button('Connect'));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rows = [];
    sent = [];
    check = { ok: true, keyCheck: 'VALID', message: 'Cursor accepted this key.' };
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
      if (p === '/providers/test') return check;
      if (p === PROVIDERS_BASE) return { ...cursorRow, id: 'p-new' };
      if (p.endsWith('/key-check')) return { ...check, recorded: true, keyCheckState: check.keyCheck, keyCheckedAt: '2026-10-17T07:00:00.000Z' };
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

  it('says the key runs Cursor CLI alone, where its models come from, and who gets it', async () => {
    await mount('/providers/new/cursor-api');
    expect(container.querySelector('h1')?.textContent).toBe('Connect Cursor');
    expect(text()).toContain('Cursor API · models from Cursor CLI on each machine');
    expect(text()).toContain('Works with— Cursor CLI only; sessions on this key are billed to its Cursor plan');
    expect(text()).toContain('Cursor’s own agent · models from Cursor on each machine');
    // P0c, Linux: the CLI gets the key, the commands its agent runs don't (D4 approach A).
    expect(text()).toContain('Sessions on Cursor CLI hand it to the CLI on the runner, and commands the agent runs there can’t read it.');
    expect(text()).toContain('A runner with Cursor CLI checks it when you connect. The check spends none of your requests.');
    expect(text()).toContain('It never runs another engine, and no other key runs Cursor CLI.');
    expect(text()).not.toContain('commands the agent runs can read it');
  });

  it('checks the key on a runner, saves it, and checks it again at once so its row has an answer', async () => {
    await connectWith({ ok: true, keyCheck: 'VALID', message: 'Cursor accepted this key.' });
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/providers/test',
      body: { baseUrl: 'https://api2.cursor.sh', apiKey: 'key_test_cursor', runtime: 'cursor' },
    });
    expect(sent[1]).toMatchObject({ method: 'POST', path: PROVIDERS_BASE });
    expect(sent[1].body).toMatchObject({ runtime: 'cursor', presetSlug: 'cursor-api', apiKey: 'key_test_cursor' });
    expect(sent[2]).toEqual({ method: 'POST', path: `${PROVIDERS_BASE}/p-new/key-check`, body: undefined });
  });

  it('keeps a key Cursor refused, says why in Cursor’s words, and offers no “Save anyway”', async () => {
    await connectWith({
      ok: false,
      keyCheck: 'INVALID',
      message: 'Cursor rejected this key: “The provided API key is invalid.” Check it on cursor.com and paste it again.',
    });
    expect(text()).toContain('Cursor rejected this key: “The provided API key is invalid.” Check it on cursor.com and paste it again.');
    expect(button('Save anyway')).toBeNull();
    expect(sent.map((s) => s.path)).toEqual(['/providers/test']);
  });

  it.each([
    ['UNREACHABLE', 'Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine.'],
    ['NO_RUNNER', 'None of your runners can check a Cursor key right now. Save the key anyway, or try again.'],
  ] as const)('lets a key be saved anyway when it could not be checked (%s)', async (keyCheck, message) => {
    await connectWith({ ok: false, keyCheck, message });
    expect(text()).toContain(message);
    await click(button('Save anyway'));
    expect(sent.map((s) => s.path)).toEqual(['/providers/test', PROVIDERS_BASE, `${PROVIDERS_BASE}/p-new/key-check`]);
  });

  it('keeps an edited Cursor key on Cursor’s protocol, with no check when the key is not changed', async () => {
    rows = [cursorRow];
    await mount('/providers/p-cursor');
    await click(button('Save'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: `${PROVIDERS_BASE}/p-cursor` });
    expect((sent[0].body as { runtime?: string }).runtime).toBe('cursor');
  });
});
