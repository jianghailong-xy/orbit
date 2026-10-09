// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderKeyUsage } from '@orbit/shared';
import { api } from '../api';
import { openDialog } from '../components/RunnerEngines.test-helpers';
import { PROVIDERS_BASE, type ProviderRow } from '../lib/providerAdmin';
import { ProviderConnectPage } from './ProviderConnectPage';

/**
 * A DeepSeek key's pages after the provider/engine split (docs/mocks/provider-engine-decoupling, boards
 * 2 and 3): one Connect DeepSeek — the retired DeepSeek Harness address lands on it — saying which
 * engines the key works with and which processes get it, and testing the key on its protocol whichever
 * engine will run it; and the key's own page, saying what uses it on each engine, asking before it is
 * turned off or deleted, and showing a refused save in the server's words.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];
/** A DeepSeek key as GET /providers/mine serves it. */
const deepseekRow: ProviderRow = {
  id: 'p-deepseek',
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  engines: ['claude', 'opencode', 'dsh'] as ProviderRow['engines'],
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: DEEPSEEK_MODELS,
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
};
/** One made from the retired DeepSeek Harness preset before the split: a DeepSeek key all the same. */
const harnessRow: ProviderRow = {
  ...deepseekRow,
  id: 'p-harness',
  slug: 'deepseek-harness',
  label: 'Work key',
  runtime: 'dsh',
  engines: ['dsh', 'claude', 'opencode'] as ProviderRow['engines'],
  models: [],
  defaultModel: '',
  presetSlug: 'deepseek-harness',
};
const IN_USE: ProviderKeyUsage = {
  providerId: 'p-deepseek',
  engines: [
    { engine: 'claude', sessions: 2, tasks: 1 },
    { engine: 'dsh', sessions: 1, tasks: 0 },
  ] as ProviderKeyUsage['engines'],
  sessions: 3,
  tasks: 1,
};
const UNUSED: ProviderKeyUsage = { providerId: 'p-deepseek', engines: [], sessions: 0, tasks: 0 };

describe('a DeepSeek key’s pages', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rows: ProviderRow[] = [];
  let usage: ProviderKeyUsage = UNUSED;
  let refusal: string | null = null;
  let sent: Array<{ method: string; path: string; body?: unknown }> = [];
  let path = '';

  function Probe() {
    const location = useLocation();
    path = location.pathname + location.hash;
    return null;
  }

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
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
            <Probe />
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

  const text = (el: Element | null | undefined = container) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** An element's words, without the monograms drawn on its marks (OpenCode's "O"). */
  const words = (el: Element | null | undefined) => {
    const copy = el?.cloneNode(true) as Element | undefined;
    copy?.querySelectorAll('.provider-tile').forEach((tile) => tile.remove());
    return text(copy);
  };
  const button = (words: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent?.trim() === words) ?? null;
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
  /** Works with, row by row: the engine, what it says about it, and — on a saved key — what uses it. */
  const worksWith = () =>
    [...container.querySelectorAll<HTMLElement>('.provider-works-row')].map((row) =>
      [row.querySelector('.provider-works-engine'), row.querySelector('.provider-works-how'), row.querySelector('.provider-works-use')]
        .filter(Boolean)
        .map((cell) => words(cell)),
    );

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rows = [];
    usage = UNUSED;
    refusal = null;
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
        if (p === '/providers/presets') return {};
        if (p.endsWith('/usage')) return usage;
        // The balance is DeepSeekBalance.test.tsx's: here it never answers.
        if (p.includes('/balance')) return new Promise(() => {});
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      if (p === '/providers/test') return { ok: true, status: 200, message: 'Connected' };
      if (method === 'PATCH' && refusal) throw new Error(refusal);
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

  it('lands the retired DeepSeek Harness address on Connect DeepSeek', async () => {
    await mount('/providers/new/deepseek-harness');
    expect(path).toBe('/providers/new/deepseek');
    expect(container.querySelector('h1')?.textContent).toBe('Connect DeepSeek');
  });

  it('says on Connect DeepSeek the protocol, the engines the key works with and who gets it — never a single engine', async () => {
    await mount('/providers/new/deepseek');
    expect(text(container.querySelector('.provider-idbar'))).toBe('DeepSeekAnthropic-compatible · 2 models included');
    expect(text(container.querySelector('.provider-works-head'))).toBe(
      'Works with— pick the engine when you start a session; this key is one of its providers',
    );
    expect(worksWith()).toEqual([
      ['Claude Code', "DeepSeek's Anthropic-compatible API · DeepSeek V4 Pro, V4 Flash"],
      ['OpenCode', 'as an OpenCode provider · DeepSeek V4 Pro, V4 Flash'],
      ['DeepSeek Harness', "DeepSeek's own agent · models from its catalogue on each machine"],
    ]);
    // The default model leads, in bold.
    expect(text(container.querySelector('.provider-works-how b'))).toBe('DeepSeek V4 Pro');
    expect([...container.querySelectorAll('.provider-who li')].map((li) => text(li))).toEqual([
      'Sessions on Claude Code and OpenCode hand this key to the CLI in its environment, where commands the agent runs can read it.',
      "DeepSeek Harness keeps it out of the commands it runs, but any program running as the runner's user can still read it from the Harness process.",
      "Orbit's server uses it to test it when you connect and to read this DeepSeek account's balance.",
    ]);
    expect(text()).not.toMatch(/Runs on|not the DeepSeek provider|DeepSeek Harness (API )?key|Harness key/);

    await click(container.querySelector('.provider-adv-head'));
    expect(text(container.querySelector('.provider-adv-body'))).toContain(
      "DeepSeek's Anthropic-compatible API — Claude Code, OpenCode and DeepSeek Harness all call it.",
    );
    expect(text(container.querySelector('.provider-adv-body'))).toContain(
      'For Claude Code and OpenCode — maintained by Orbit from the official DeepSeek catalogue. DeepSeek Harness lists its own models on each machine.',
    );
  });

  it('tests a new DeepSeek key on its protocol before connecting it as a DeepSeek key', async () => {
    await mount('/providers/new/deepseek');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'sk-deepseek-test');
    await click(button('Connect'));
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/providers/test',
      body: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-deepseek-test', model: 'deepseek-v4-pro', runtime: 'claude' },
    });
    expect(sent[1]).toMatchObject({
      method: 'POST',
      path: PROVIDERS_BASE,
      body: { label: 'DeepSeek', runtime: 'claude', presetSlug: 'deepseek', followsPreset: true },
    });
  });

  it('names a second DeepSeek key, counting one made from the retired Harness preset as a DeepSeek key', async () => {
    rows = [{ ...harnessRow, label: 'DeepSeek' }];
    await mount('/providers/new/deepseek');
    expect(container.querySelector<HTMLInputElement>('.provider-step input')?.value).toBe('DeepSeek 2');
    expect(text()).toContain('You already have one DeepSeek key — the name is what tells them apart when picking a model.');
  });

  it('edits a key from the retired Harness preset as a DeepSeek key, and tests a new key for it the same way', async () => {
    rows = [harnessRow];
    await mount('/providers/p-harness');
    expect(container.querySelector('h1')?.textContent).toBe('Edit Work key');
    expect(text(container.querySelector('.provider-idbar'))).toContain('Anthropic-compatible');
    await type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'sk-new-key');
    await click(button('Save'));
    // Probed on Anthropic's protocol like any DeepSeek key, though it runs on DeepSeek Harness by default.
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/providers/test',
      body: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-new-key', model: 'deepseek-v4-pro', runtime: 'dsh' },
    });
    expect(sent[1]).toMatchObject({ method: 'PATCH', path: `${PROVIDERS_BASE}/p-harness`, body: { runtime: 'dsh', apiKey: 'sk-new-key' } });
  });

  it('says on the key’s page what uses it on each engine it works with, and what turning it off stops', async () => {
    rows = [deepseekRow];
    usage = IN_USE;
    await mount('/providers/p-deepseek');
    expect(text(container.querySelector('.provider-works-head'))).toBe(
      'Works with— pick it in the Provider menu of a session on any of these',
    );
    expect(worksWith()).toEqual([
      ['Claude Code', 'DeepSeek V4 Pro, V4 Flash', '2 open sessions · 1 task pinned'],
      ['OpenCode', 'DeepSeek V4 Pro, V4 Flash', 'Not in use'],
      ['DeepSeek Harness', 'models from its catalogue on each machine', '1 open session'],
    ]);
    expect(text()).toContain('Off stops it on Claude Code, OpenCode and DeepSeek Harness, and hides it from their Provider menus.');
    expect(container.querySelector('.provider-who')).toBeNull();
    expect(button('Delete key', container)).not.toBeNull();
  });

  it('asks before turning off a key something uses, and turns it off once confirmed', async () => {
    rows = [deepseekRow];
    usage = IN_USE;
    await mount('/providers/p-deepseek');
    await click(container.querySelector('[role="switch"][aria-label="Enabled"]'));
    await click(button('Save'));
    expect(sent).toEqual([]);
    const dialog = await openDialog('Turn off DeepSeek?');
    expect([...dialog.querySelectorAll('.key-impact > p, .key-impact-row')].map(words)).toEqual([
      'It stops on all three engines it works with:',
      'Claude Code — 2 open sessions, 1 task pinned',
      'OpenCode — not in use',
      'DeepSeek Harness — 1 open session',
      'Those sessions and the pinned task keep their engine and can’t run until you turn the key back on or switch them to another key — nothing falls back to a runner’s own sign-in.',
    ]);
    await click(button('Turn off', dialog));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: `${PROVIDERS_BASE}/p-deepseek`, body: { enabled: false } });
  });

  it('turns off a key nothing uses without asking', async () => {
    rows = [deepseekRow];
    await mount('/providers/p-deepseek');
    await click(container.querySelector('[role="switch"][aria-label="Enabled"]'));
    await click(button('Save'));
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PATCH', body: { enabled: false } });
  });

  it('deletes the key from its page once asked, and goes back to Infrastructure', async () => {
    rows = [deepseekRow];
    usage = IN_USE;
    await mount('/providers/p-deepseek');
    await click(button('Delete key', container));
    const dialog = await openDialog('Delete DeepSeek?');
    expect(text(dialog.querySelector('.key-impact'))).toContain('They keep their engine and can’t run until you switch them to another key.');
    await click(button('Delete key', dialog));
    expect(sent).toEqual([{ method: 'DELETE', path: `${PROVIDERS_BASE}/p-deepseek`, body: undefined }]);
    expect(path).toBe('/infrastructure#keys');
  });

  it('shows a refused save in the server’s words above the buttons', async () => {
    rows = [deepseekRow];
    refusal =
      'provider "DeepSeek" is in use on Claude Code, DeepSeek Harness by 3 open sessions and 1 task pins; its endpoint can\'t change while they use it';
    await mount('/providers/p-deepseek');
    await click(button('Save'));
    expect(text(container.querySelector('.provider-save-error'))).toBe(`Couldn't save the provider. ${refusal}`);
    expect(path).toBe('/providers/p-deepseek');
  });
});
