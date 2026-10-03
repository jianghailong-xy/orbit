// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { Runner } from '../components/TasksSidePanel';
import { ProvidersPage } from './ProvidersPage';

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
const gemini = {
  id: 'gemini-key', slug: 'gemini', label: 'Gemini', presetSlug: 'gemini', runtime: 'antigravity',
  baseUrl: 'https://generativelanguage.googleapis.com', models: [], defaultModel: null,
  followsPreset: true, enabled: true, hasApiKey: true,
};
const runner = (over: Partial<Runner> = {}): Runner => ({
  id: '33zx0JhRhJo8rd25d3qAM', name: 'HPC', online: true,
  engines: [{ engine: 'antigravity', installed: true, version: 'agy 1.2.16', auth: 'no' }],
  antigravity: { supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: false },
  ...over,
});

describe('Gemini readiness on the Providers page', () => {
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
      root.render(<MemoryRouter initialEntries={['/providers?runner=33zx0JhRhJo8rd25d3qAM&engine=antigravity']}>
        <QueryClientProvider client={client}><ProvidersPage /></QueryClientProvider>
      </MemoryRouter>);
    });
  }

  it('counts only online runners that declare support and have the CLI, and scrolls to their cards', async () => {
    await mount([
      runner(), runner({ id: 'offline', online: false }),
      runner({ id: 'old', antigravity: { supported: false, installed: true, version: '1.2.16', envKeyAvailable: false } }),
      runner({ id: 'missing', antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false } }),
    ]);
    const key = container.querySelector('.prov-runtime')!;
    expect(key.textContent).toContain('Runs on the Antigravity CLI');
    expect(key.textContent).toContain('Ready on 1 runner');
    scroll.mockClear();
    await act(async () => (key.querySelector('a') as HTMLAnchorElement).click());
    expect(scroll.mock.calls).toEqual([[{ behavior: 'smooth', block: 'start' }]]);
    expect(scroll.mock.contexts[0]).toBe(container.querySelector('#provider-runners'));
  });

  it('warns when no online runner is ready and offers installation on the focused CLI row', async () => {
    await mount([runner({ antigravity: { supported: true, installed: false, version: null, envKeyAvailable: false } })]);
    expect(container.querySelector('.prov-runtime')?.textContent).toContain('Not ready on any runner');
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
