// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Runner } from './components/TasksSidePanel';
import { encodeId } from './lib/idCodec';

/**
 * The Runners and Providers pages are one page, Infrastructure, and the addresses they had still
 * land on it with the query they carried: a bookmark, the sidebars of older macOS/iOS clients, and
 * those clients' "Sign in on the web", which opens `/providers?runner=<id>&engine=<engine>` — where
 * that machine's card has to open on that engine, as it did on Providers. Bare `/providers` meant
 * the keys, so it lands on them. The pages under both addresses keep theirs.
 *
 * Mounted under the real BrowserRouter on jsdom's own history, the way main.tsx mounts it, so what
 * is checked is the address bar the redirect leaves behind.
 */

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
const { api } = await import('./api');
const apiMock = vi.mocked(api);

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
vi.mock('./pages/RunnerDetailPage', () => ({ RunnerDetailPage: () => <p>a machine’s page</p> }));
vi.mock('./pages/ProviderConnectPage', () => ({
  ProviderPickPage: () => <p>pick a vendor</p>,
  ProviderConnectPage: () => <p>a key’s page</p>,
}));
vi.mock('./pages/ProviderPoolPage', () => ({ ProviderPoolPage: () => <p>a pool’s page</p> }));

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
let root: Root | null = null;
const scroll = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token'); // signed in
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/runners') return [machine(MAC, 'Mac Studio'), machine(HPC, 'HPC')];
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
      <AntApp>
        <QueryClientProvider client={client}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const addressBar = (): string => window.location.pathname + window.location.search + window.location.hash;
const headings = () => [...container.querySelectorAll('.re-sec-head h3')].map((h3) => h3.textContent);
const card = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('.re-runner-card')].find(
    (el) => el.querySelector('.re-runner')?.textContent === name,
  )!;
const isOpen = (name: string) => card(name).querySelector('.re-toggle')?.getAttribute('aria-expanded') === 'true';

describe('the Runners and Providers addresses', () => {
  it('/runners lands on Infrastructure: its machines, its keys and its pools', async () => {
    await visit('/runners');
    expect(addressBar()).toBe('/infrastructure');
    expect(container.querySelector('h1')?.textContent).toBe('Infrastructure');
    expect(headings()).toEqual(['Machines', 'API keys', 'Account pools']);
    // Nothing named, so nothing opened for it, and nothing scrolled to.
    expect([isOpen('Mac Studio'), isOpen('HPC')]).toEqual([false, false]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('/providers lands on Infrastructure’s keys, and brings them into view', async () => {
    await visit('/providers');
    expect(addressBar()).toBe('/infrastructure#keys');
    expect(headings()).toEqual(['Machines', 'API keys', 'Account pools']);
    expect(scroll.mock.calls).toEqual([[{ block: 'start' }]]);
    expect(scroll.mock.contexts[0]).toBe(container.querySelector('#keys'));
    expect((scroll.mock.contexts[0] as HTMLElement).querySelector('h3')?.textContent).toBe('API keys');
  });

  it('/providers?runner=<id>&engine=<engine> opens that machine’s card on that engine, as Providers did', async () => {
    await visit(`/providers?runner=${MAC}&engine=codex`);
    expect(addressBar()).toBe(`/infrastructure?runner=${MAC}&engine=codex`);
    // That machine's card is open, the other one is not.
    expect([isOpen('Mac Studio'), isOpen('HPC')]).toEqual([true, false]);
    // The engine it named is marked, and is the one row brought into view.
    const row = card('Mac Studio').querySelector<HTMLElement>('.re-row[data-engine="codex"]')!;
    expect(row.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.re-row.focused')).toHaveLength(1);
    expect(scroll.mock.calls).toEqual([[{ block: 'center' }]]);
    expect(scroll.mock.contexts[0]).toBe(row);
    // It is the row to sign in from.
    expect([...row.querySelectorAll('button')].map((button) => button.textContent?.trim())).toContain('Sign in');
  });

  it('keeps the query on /runners too, the old spelling of a machine named by its UUID included', async () => {
    await visit(`/runners?runner=0195c0de-0000-7000-8000-0000000000b2&engine=claude`);
    expect(addressBar()).toBe('/infrastructure?runner=0195c0de-0000-7000-8000-0000000000b2&engine=claude');
    expect([isOpen('Mac Studio'), isOpen('HPC')]).toEqual([false, true]);
    const row = card('HPC').querySelector<HTMLElement>('.re-row[data-engine="claude"]')!;
    expect(row.classList.contains('focused')).toBe(true);
    expect(scroll.mock.contexts).toEqual([row]);
  });

  it.each([
    ['/runners/register', 'register a machine'],
    [`/runners/${MAC}`, 'a machine’s page'],
    ['/providers/new', 'pick a vendor'],
    ['/providers/new/anthropic', 'a key’s page'],
    [`/providers/${KEY}`, 'a key’s page'],
    [`/providers/pools/${POOL}`, 'a pool’s page'],
  ])('leaves %s where it is', async (path, page) => {
    await visit(path);
    expect(addressBar()).toBe(path);
    expect(container.textContent).toBe(page);
  });
});
