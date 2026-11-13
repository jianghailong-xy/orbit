// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Runner } from './components/TasksSidePanel';
import { encodeId } from './lib/idCodec';

/**
 * The Runners and Providers addresses still land where they meant, with the query they carried: a
 * bookmark, the sidebars of older macOS/iOS clients, and those clients' "Sign in on the web", which
 * opens `/providers?runner=<id>&engine=<engine>`. A machine is a Settings page now
 * (/settings/machines/:id, docs/mocks/settings-redesign board-3), so `/runners`, `/infrastructure` and
 * `/runners/:id` land on one — the named machine's, on the engine named, or the first machine's. The
 * API keys and account pools are Settings' Providers pages (board-4): `/providers`, `/admin/providers`,
 * `/infrastructure#keys` and `#pools`, and the pages under `/providers`, land there.
 * /runners/register keeps its address.
 *
 * Mounted under the real BrowserRouter on jsdom's own history, the way main.tsx mounts it, so what
 * is checked is the address bar the redirect leaves behind.
 */

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
const { api } = await import('./api');
const apiMock = vi.mocked(api);

// Settings' window without its live updates.
vi.mock('./lib/useControlPlane', async (original) => ({
  ...(await original<typeof import('./lib/useControlPlane')>()),
  ControlPlaneProvider: ({ children }: { children: ReactNode }) => children,
}));
// The routed page alone: the real shell would need every query it polls answered first.
vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
// The pages under the old addresses, drawn only to say which page answered.
vi.mock('./components/RunnerRegisterGuide', () => ({ RunnerRegisterGuide: () => <p>register a machine</p> }));
vi.mock('./pages/settings/GeneralPage', () => ({ GeneralSettingsPage: () => <p>general settings</p> }));
vi.mock('./pages/ProviderConnectPage', () => ({
  ProviderPickPage: () => <p>pick a vendor</p>,
  ProviderConnectPage: () => <p>a key’s page</p>,
}));
vi.mock('./pages/ProviderPoolPage', () => ({ ProviderPoolPage: () => <p>a pool’s page</p> }));
vi.mock('./components/settings/SettingsProviderPages', async (original) => ({
  ...(await original<typeof import('./components/settings/SettingsProviderPages')>()),
  SettingsPoolsPage: () => <p>the pools page</p>,
}));

// = uuidToBase62(…): the cards' links encode it.
const MAC = '33zx0JhRhJo8rd25d3qAM';
const HPC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const KEY = encodeId('0195c0de-0000-7000-8000-0000000000c1');
const POOL = encodeId('0195c0de-0000-7000-8000-0000000000c2');

const machine = (id: string, name: string): Runner => ({
  id,
  name,
  online: true,
  activeSessions: 1,
  maxConcurrent: 4,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4' },
    { engine: 'codex', installed: true, auth: 'no', version: '0.160.0' },
    { engine: 'kimi', installed: false, auth: 'unknown' },
  ],
});

let container: HTMLDivElement;
let keys: unknown[] = [];
let root: Root | null = null;
const scroll = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token'); // signed in
  keys = [];
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/runners') return [machine(MAC, 'Mac Studio'), machine(HPC, 'HPC')];
    if (path === '/providers/mine') return keys;
    return [];
  }) as typeof api);
  // No release manifest here.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
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
  scroll.mockClear();
  Element.prototype.scrollIntoView = scroll;
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  apiMock.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** Open `path` the way a page load does: the address bar says it before the app first renders. */
async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const addressBar = (): string => window.location.pathname + window.location.search + window.location.hash;

/** What the Settings window's right-hand column says: which page answered there. */
const settingsPage = () => container.querySelector('.settings-column')?.textContent;
const machineTitle = () => container.querySelector('.machine-title')?.textContent;
const engineRow = (engine: string) => container.querySelector<HTMLElement>(`.re-row[data-engine="${engine}"]`)!;

describe('the Runners and Providers addresses', () => {
  it('/runners lands on the first machine’s Settings page, by way of /infrastructure', async () => {
    await visit('/runners');
    expect(addressBar()).toBe(`/settings/machines/${MAC}`);
    expect(machineTitle()).toBe('Mac Studio');
    // Nothing named, so nothing marked, and nothing scrolled to.
    expect(container.querySelectorAll('.re-row.focused')).toHaveLength(0);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('/infrastructure with no machine lands on General', async () => {
    apiMock.mockImplementation((async () => []) as typeof api);
    await visit('/infrastructure');
    expect(addressBar()).toBe('/settings/general');
    expect(settingsPage()).toBe('general settings');
  });

  it.each(['/providers', '/admin/providers', '/infrastructure#keys'])(
    '%s lands on the API keys page in Settings',
    async (path) => {
      keys = [{ id: KEY, label: 'Work key', presetSlug: 'anthropic', engines: ['claude'], models: [] }];
      await visit(path);
      expect(addressBar()).toBe('/settings/providers');
      expect(container.querySelector('.settings-column .sp-vendor-title')?.textContent).toBe('API keys');
    },
  );

  it('/providers with no key at all lands on connecting one', async () => {
    await visit('/providers');
    expect(addressBar()).toBe('/settings/providers/new');
    expect(settingsPage()).toBe('pick a vendor');
  });

  it('/infrastructure#pools lands on Account pools in Settings', async () => {
    await visit('/infrastructure#pools');
    expect(addressBar()).toBe('/settings/providers/pools');
    expect(settingsPage()).toBe('the pools page');
  });

  it('/providers?runner=<id>&engine=<engine> opens that machine’s page on that engine, as Providers did', async () => {
    await visit(`/providers?runner=${MAC}&engine=codex`);
    // The engine is taken from the address once its row is marked, so a reload doesn't do it again.
    expect(addressBar()).toBe(`/settings/machines/${MAC}`);
    expect(machineTitle()).toBe('Mac Studio');
    // The engine it named is marked, and is the one row brought into view.
    const row = engineRow('codex');
    expect(row.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.re-row.focused')).toHaveLength(1);
    expect(scroll.mock.calls).toEqual([[{ block: 'center' }]]);
    expect(scroll.mock.contexts[0]).toBe(row);
    // It is the row to sign in from.
    expect([...row.querySelectorAll('button')].map((button) => button.textContent?.trim())).toContain('Sign in');
  });

  it('keeps the query on /runners too, the old spelling of a machine named by its UUID included', async () => {
    await visit(`/runners?runner=0195c0de-0000-7000-8000-0000000000b2&engine=claude`);
    expect(addressBar()).toBe(`/settings/machines/${HPC}`);
    expect(machineTitle()).toBe('HPC');
    const row = engineRow('claude');
    expect(row.classList.contains('focused')).toBe(true);
    expect(scroll.mock.contexts).toEqual([row]);
  });

  it('/runners/:id is that machine’s Settings page', async () => {
    await visit(`/runners/${MAC}`);
    expect(addressBar()).toBe(`/settings/machines/${MAC}`);
    expect(machineTitle()).toBe('Mac Studio');
  });

  it('/runners/:id?workspace=<id>, which opened that workspace’s editor, is the workspace’s Settings page', async () => {
    const workspace = encodeId('0195c0de-0000-7000-8000-0000000000d1');
    await visit(`/runners/${MAC}?workspace=${workspace}`);
    expect(addressBar()).toBe(`/settings/workspaces/${workspace}`);
  });

  it.each([
    ['/runners/register', 'register a machine'],
  ])('leaves %s where it is', async (path, page) => {
    await visit(path);
    expect(addressBar()).toBe(path);
    expect(container.textContent).toBe(page);
  });

  it.each([
    ['/providers/new', '/settings/providers/new', 'pick a vendor'],
    ['/providers/new/anthropic', '/settings/providers/new/anthropic', 'a key’s page'],
    [`/providers/${KEY}`, `/settings/providers/keys/${KEY}`, 'a key’s page'],
    [`/providers/pools/${POOL}`, `/settings/providers/pools/${POOL}`, 'a pool’s page'],
  ])('moves %s into Settings, at %s', async (path, to, page) => {
    await visit(path);
    expect(addressBar()).toBe(to);
    expect(settingsPage()).toBe(page);
  });
});
