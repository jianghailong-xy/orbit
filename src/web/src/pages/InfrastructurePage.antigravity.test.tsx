// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { Runner } from '../components/TasksSidePanel';
import { InfrastructurePage } from './InfrastructurePage';

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
const gemini = {
  id: 'gemini-key', slug: 'gemini', label: 'Gemini', presetSlug: 'gemini', runtime: 'antigravity',
  engines: ['antigravity', 'opencode'], baseUrl: 'https://generativelanguage.googleapis.com', models: [],
  defaultModel: null, followsPreset: true, enabled: true, hasApiKey: true,
};
const runner = (over: Partial<Runner> = {}): Runner => ({
  id: '33zx0JhRhJo8rd25d3qAM', name: 'HPC', online: true,
  engines: [{ engine: 'antigravity', installed: true, version: 'agy 1.2.16', auth: 'no' }],
  antigravity: { supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: false },
  ...over,
});

/** An element's words, without the monograms drawn on its marks (OpenCode's "O"). */
const words = (el: Element | null | undefined) => {
  if (!el) return null;
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.provider-tile').forEach((tile) => tile.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? null;
};

describe('Antigravity identity and readiness on the Infrastructure page', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let rows: Runner[];
  const scroll = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    Element.prototype.scrollIntoView = scroll;
    scroll.mockClear();
    apiMock.mockReset();
    apiMock.mockImplementation(((path: string) => Promise.resolve(path === '/runners' ? rows : [])) as typeof api);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function mount(runners: Runner[]) {
    rows = runners;
    client.setQueryData(['runners'], rows);
    client.setQueryData(['providers', 'mine'], [gemini]);
    client.setQueryData(['providers', 'pools'], []);
    client.setQueryData(['providers', 'shared-pools'], []);
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/infrastructure?runner=33zx0JhRhJo8rd25d3qAM&engine=antigravity']}>
        <QueryClientProvider client={client}><InfrastructurePage /></QueryClientProvider>
      </MemoryRouter>);
    });
  }

  it('keeps a Gemini key its own name under Google Gemini, says which engines run it, and calls the engine Antigravity CLI', async () => {
    await mount([runner(), runner({ id: 'offline', online: false })]);
    expect(container.querySelector('.prov-group b')?.textContent).toBe('Google Gemini');
    expect(container.querySelector('.prov-key .prov-cell-name')?.textContent).toBe('Gemini');
    expect(words(container.querySelector('.prov-key .prov-engines'))).toBe('Antigravity CLI · OpenCode');
    // Which machines can run it is the machines' to say, on their own rows: the key no longer does.
    expect(container.querySelector('.prov-key')?.textContent).not.toContain('Ready on');
    expect(container.querySelector('a[href="/providers/new/gemini"] .pc-name')?.textContent).toBe('Google Gemini');
    expect(container.querySelector('[data-engine="antigravity"] .re-name')?.textContent).toBe('Antigravity CLI');
  });

  it('offers installation on the focused CLI row of a machine without the CLI', async () => {
    await mount([runner({ antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false } })]);
    const row = container.querySelector('[data-engine="antigravity"]')!;
    expect(row.classList.contains('focused')).toBe(true);
    expect(row.textContent).toContain('Not installed — Orbit can install it here');
    const install = Array.from(row.querySelectorAll('button')).find((button) => button.textContent === 'Install')!;
    await act(async () => install.click());
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('/runners/33zx0JhRhJo8rd25d3qAM/install', {
      method: 'POST', body: { engine: 'antigravity' },
    }));
  });
});
