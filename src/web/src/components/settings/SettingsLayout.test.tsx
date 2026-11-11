// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { resetSettingsReturn } from '../../lib/settingsReturn';
import { SettingsCard, SettingsRow, SettingsSection } from '.';

/**
 * Settings takes over the window (owner's choice A1, docs/mocks/settings-redesign board-2): no app
 * sidebar, Back to Orbit and Esc return to the page it was opened from, a search box, and four nav
 * groups — Personal, Machines (a status dot per machine), Providers (a row per vendor with its key
 * count, then Account pools) and Workspaces (each with its machine) — the last three with a + in the
 * heading. Every row opens a page.
 *
 * Mounted through the real App routes under the real BrowserRouter, so what is checked is the address
 * bar; the pages themselves are reduced to a line saying which one answered.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);

vi.mock('../../lib/useControlPlane', async (original) => ({
  ...(await original<typeof import('../../lib/useControlPlane')>()),
  ControlPlaneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => (
      <div data-testid="app-shell">
        <Outlet />
      </div>
    ),
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('../../pages/TaskRoute', () => ({ TaskRoute: () => <p data-page="tasks">the task list</p> }));
// Each Personal page says the address it answered at.
const { atPath } = vi.hoisted(() => ({
  atPath: async () => {
    const { useLocation } = await import('react-router-dom');
    return () => <p data-page={useLocation().pathname}>settings page</p>;
  },
}));
vi.mock('../../pages/settings/GeneralPage', async () => ({ GeneralSettingsPage: await atPath() }));
vi.mock('../../pages/settings/NotificationsPage', async () => ({ NotificationsSettingsPage: await atPath() }));
vi.mock('../../pages/settings/AppearancePage', async () => ({ AppearanceSettingsPage: await atPath() }));
vi.mock('../../pages/settings/StoragePage', async () => ({ StorageSettingsPage: await atPath() }));
vi.mock('../../pages/ProfilePage', () => ({ ProfilePage: () => <p data-page="profile">profile</p> }));
vi.mock('../../pages/SharedLinksPage', () => ({ SharedLinksPage: () => <p data-page="shared-links">links</p> }));
vi.mock('../../pages/AccessTokensPage', () => ({ AccessTokensPage: () => <p data-page="access-tokens">tokens</p> }));
vi.mock('../../pages/FeishuIntegrationPage', () => ({ FeishuIntegrationPage: () => <p data-page="feishu">feishu</p> }));
vi.mock('../../pages/InfrastructurePage', () => ({
  InfrastructurePage: ({ section }: { section?: string }) => <p data-page={`infrastructure:${section}`}>infra</p>,
}));
vi.mock('../../pages/RunnerDetailPage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    RunnerDetailPage: ({ runnerId, workspaceId }: { runnerId?: string; workspaceId?: string }) => {
      const params = useParams();
      return <p data-page={`machine:${runnerId ?? params.id}:${workspaceId ?? ''}`}>machine</p>;
    },
  };
});
// Home lands in a workspace's console.
vi.mock('../WorkspaceConsole', () => ({ WorkspaceConsole: () => <p data-page="console">console</p> }));
vi.mock('../RunnerRegisterGuide', () => ({ RunnerRegisterGuide: () => <p data-page="register">register</p> }));
vi.mock('../../pages/ProviderConnectPage', () => ({
  ProviderPickPage: () => <p data-page="pick-vendor">pick</p>,
  ProviderConnectPage: () => <p data-page="key">key</p>,
}));

const signedIn = { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4' };
const signedOut = { engine: 'claude', installed: true, auth: 'no', version: '2.1.4' };
const RUNNERS = [
  { id: 'gpuBox', name: 'gpu-box', online: true, engines: [signedIn] },
  { id: 'oldLaptop', name: 'old-laptop', online: true, engines: [signedOut] },
  { id: 'studioMac', name: 'studio-mac', displayName: 'Studio Mac', online: false, engines: [signedIn] },
];
const WORKSPACES = [
  { id: 'wsOrbit', name: 'orbit', runnerId: 'gpuBox', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'wsSite', name: 'website', runnerId: 'studioMac', createdAt: '2026-01-02T00:00:00Z' },
];
const KEYS = [
  { id: 'k1', slug: 'anthropic', label: 'Work', presetSlug: 'anthropic' },
  { id: 'k2', slug: 'openai', label: 'OpenAI', presetSlug: 'openai' },
  { id: 'k3', slug: 'anthropic-2', label: 'Home', presetSlug: 'anthropic' },
];

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/runners') return RUNNERS;
    if (path === '/workspaces') return WORKSPACES;
    if (path === '/providers/mine') return KEYS;
    if (path === '/providers/pools') return [{ id: 'p1', name: 'Team', members: [] }];
    return [];
  }) as typeof api);
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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

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
  await settle();
}

/** Move within the app as a link does: through history, which React Router listens to. */
async function go(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await settle();
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
}

const addressBar = (): string => window.location.pathname + window.location.search + window.location.hash;
const nav = () => container.querySelector('nav.settings-nav')!;
const group = (title: string) => nav().querySelector<HTMLElement>(`[role="group"][aria-label="${title}"]`)!;
const rows = (title: string) =>
  [...group(title).querySelectorAll<HTMLAnchorElement>('a.settings-nav-row')].map((a) => ({
    label: a.querySelector('.settings-nav-label')?.textContent,
    href: a.getAttribute('href'),
    meta: a.querySelector('.settings-nav-meta')?.textContent ?? null,
    dot: a.querySelector('.settings-dot')?.getAttribute('aria-label') ?? null,
  }));
const page = () => container.querySelector('[data-page]')?.getAttribute('data-page');
const button = (name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent === name,
  );

describe('the Settings window', () => {
  it('takes over the window: no app sidebar, Back to Orbit, the title, a search box', async () => {
    await visit('/settings');
    expect(addressBar()).toBe('/settings/general');
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(button('Back to Orbit')).toBeTruthy();
    expect(nav().querySelector('h1')?.textContent).toBe('Settings');
    expect(nav().querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe('Search settings');
    expect(page()).toBe('/settings/general');
  });

  it('has the four groups, and a + in the heading of Machines, Providers and Workspaces only', async () => {
    await visit('/settings/general');
    const titles = [...nav().querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(titles).toEqual(['Personal', 'Machines', 'Providers', 'Workspaces']);
    expect(group('Personal').querySelector('.settings-nav-add')).toBeNull();
    expect(group('Machines').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('Register a machine');
    expect(group('Providers').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('Connect a provider');
    expect(group('Workspaces').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('Add a workspace');
  });

  it('lists Personal, each machine with its status dot, each vendor with its keys, and each workspace with its machine', async () => {
    await visit('/settings/general');
    expect(rows('Personal').map((r) => [r.label, r.href])).toEqual([
      ['General', '/settings/general'],
      ['Notifications', '/settings/notifications'],
      ['Appearance', '/settings/appearance'],
      ['Profile', '/settings/profile'],
      ['Storage', '/settings/storage'],
      ['Shared links', '/settings/shared-links'],
      ['Access tokens', '/settings/access-tokens'],
      ['Feishu', '/settings/integrations/feishu'],
    ]);
    expect(rows('Machines').map((r) => [r.label, r.href, r.dot])).toEqual([
      ['gpu-box', '/settings/machines/gpuBox', 'Online'],
      ['old-laptop', '/settings/machines/oldLaptop', 'Needs you'],
      ['Studio Mac', '/settings/machines/studioMac', 'Offline'],
    ]);
    expect(rows('Providers').map((r) => [r.label, r.href, r.meta])).toEqual([
      ['Anthropic', '/settings/providers/anthropic', '2 keys'],
      ['OpenAI', '/settings/providers/openai', '1 key'],
      ['Account pools', '/settings/providers/pools', '1'],
    ]);
    expect(rows('Workspaces').map((r) => [r.label, r.href, r.meta])).toEqual([
      ['orbit', '/settings/workspaces/wsOrbit', 'gpu-box'],
      ['website', '/settings/workspaces/wsSite', 'Studio Mac'],
    ]);
  });

  it('opens a page from every nav row, and lights that row', async () => {
    await visit('/settings/general');
    const expected: Record<string, string> = {
      '/settings/general': '/settings/general',
      '/settings/notifications': '/settings/notifications',
      '/settings/appearance': '/settings/appearance',
      '/settings/profile': 'profile',
      '/settings/storage': '/settings/storage',
      '/settings/shared-links': 'shared-links',
      '/settings/access-tokens': 'access-tokens',
      '/settings/integrations/feishu': 'feishu',
      '/settings/machines/gpuBox': 'machine:gpuBox:',
      '/settings/machines/studioMac': 'machine:studioMac:',
      '/settings/providers/anthropic': 'infrastructure:keys',
      '/settings/providers/pools': 'infrastructure:pools',
      '/settings/workspaces/wsOrbit': 'machine:gpuBox:wsOrbit',
      '/settings/workspaces/wsSite': 'machine:studioMac:wsSite',
    };
    for (const [href, answered] of Object.entries(expected)) {
      await click(nav().querySelector(`a[href="${href}"]`));
      expect(addressBar()).toBe(href);
      expect(page()).toBe(answered);
      expect(nav().querySelector('a.active')?.getAttribute('href')).toBe(href);
    }
  });

  it('sends each + where it adds one', async () => {
    await visit('/settings/general');
    await click(group('Machines').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/runners/register');
    expect(page()).toBe('register');

    await go('/settings/general');
    await click(group('Providers').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/providers/new');

    // Until Settings has its own new-workspace page: the first online machine's Add workspace.
    await go('/settings/general');
    await click(group('Workspaces').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/settings/machines/gpuBox?workspace=new');
    expect(page()).toBe('machine:gpuBox:');
  });

  it('Back to Orbit returns to the page Settings was opened from, across pages inside it', async () => {
    await visit('/tasks?scope=mine');
    expect(page()).toBe('tasks');
    await go('/settings');
    await click(nav().querySelector('a[href="/settings/profile"]'));
    await click(button('Back to Orbit'));
    expect(addressBar()).toBe('/tasks?scope=mine');
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('Back to Orbit goes home when Settings was the first page opened', async () => {
    await visit('/settings/profile');
    await click(button('Back to Orbit'));
    expect(window.location.pathname).not.toMatch(/^\/settings/);
    expect(page()).toBe('console');
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('Esc does what Back to Orbit does', async () => {
    await visit('/tasks');
    await go('/settings/access-tokens');
    await pressEscape();
    expect(addressBar()).toBe('/tasks');
  });

  it('Esc leaves Settings alone while a dialog or drawer is open over it', async () => {
    await visit('/tasks');
    await go('/settings/general');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    await pressEscape();
    expect(addressBar()).toBe('/settings/general');
    dialog.remove();
    await pressEscape();
    expect(addressBar()).toBe('/tasks');
  });
});

describe('the Settings building blocks', () => {
  it('draw a section title with its action, and a card of rows: name, description, control', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <SettingsSection title="New sessions" action={<button type="button">Add</button>}>
          <SettingsCard>
            <SettingsRow title="Suggested replies" description="Offers what you'd type next." control={<input type="checkbox" />} />
            <SettingsRow title="Session recaps" />
          </SettingsCard>
        </SettingsSection>,
      );
    });
    expect(container.querySelector('.settings-section-title')?.textContent).toBe('New sessions');
    expect(container.querySelector('.settings-section-action button')?.textContent).toBe('Add');
    const drawn = [...container.querySelectorAll('.settings-card .settings-row')].map((row) => [
      row.querySelector('.settings-row-title')?.textContent,
      row.querySelector('.settings-row-description')?.textContent ?? null,
      !!row.querySelector('.settings-row-control input'),
    ]);
    expect(drawn).toEqual([
      ['Suggested replies', "Offers what you'd type next.", true],
      ['Session recaps', null, false],
    ]);
  });
});
