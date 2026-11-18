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
 * Who gets an OpenAI key (docs/claude-engine-openai-gateway-design.md §3): Codex and OpenCode take it into the CLI's
 * environment; Claude Code, where the server runs it on the key through Orbit's gateway, never gets it — the key
 * stays on the Orbit server.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

/** An OpenAI key as GET /providers/mine serves it on a server with ORBIT_CLAUDE_OPENAI_GATEWAY on. */
const openaiRow: ProviderRow = {
  id: 'p-openai',
  slug: 'openai',
  label: 'OpenAI',
  runtime: 'codex',
  engines: ['codex', 'claude', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.openai.com/v1',
  models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
  defaultModel: 'gpt-5.5',
  presetSlug: 'openai',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
};

const CODEX_LINE = 'Sessions on Codex and OpenCode hand this key to the CLI in its environment, where commands the agent runs can read it.';
const CLAUDE_LINE =
  'Sessions on Claude Code never get it: the key stays on the Orbit server, which sends their requests on. Their runner gets a token that works only for that session.';
const SERVER_LINE = "Orbit's server uses it to test it when you connect.";

describe('who gets an OpenAI key', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rows: ProviderRow[] = [];

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
            <Routes>
              <Route path="/providers/new/:slug" element={<ProviderConnectPage />} />
              <Route path="/providers/:id" element={<ProviderConnectPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  const lines = () => [...container.querySelectorAll('.provider-who li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rows = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    apiMock.mockReset();
    apiMock.mockImplementation((async (p: string) => {
      if (p === PROVIDERS_BASE) return rows;
      if (p === '/providers/presets') return {};
      if (p.endsWith('/usage')) return { providerId: 'p-openai', engines: [], sessions: 0, tasks: 0 };
      return [];
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

  it('says on Connect OpenAI that Codex and OpenCode take the key into the CLI, and that the server tests it', async () => {
    await mount('/providers/new/openai');
    expect(container.querySelector('.provider-who b')?.textContent).toBe('Who gets this key');
    expect(lines()).toEqual([CODEX_LINE, SERVER_LINE]);
  });

  it('says on a key the server runs on Claude Code that Claude Code sessions never get it: it stays on the Orbit server', async () => {
    rows = [openaiRow];
    await mount('/providers/p-openai');
    expect(lines()).toEqual([CODEX_LINE, CLAUDE_LINE, SERVER_LINE]);
  });

  it('leaves the Claude Code line out where the server does not run the key on Claude Code', async () => {
    rows = [{ ...openaiRow, engines: ['codex', 'opencode'] as ProviderRow['engines'] }];
    await mount('/providers/p-openai');
    expect(lines()).toEqual([CODEX_LINE, SERVER_LINE]);
  });
});
