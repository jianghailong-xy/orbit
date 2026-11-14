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

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../../lib/toast', async (original) => ({
  ...(await original<typeof import('../../lib/toast')>()),
  useToast: () => toast,
}));

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
vi.mock('./SettingsProviderPages', async (original) => {
  const { useParams } = await import('react-router-dom');
  return {
    ...(await original<typeof import('./SettingsProviderPages')>()),
    SettingsKeysPage: () => {
      const { vendor } = useParams();
      return <p data-page={vendor ? `vendor:${vendor}` : 'keys'}>keys</p>;
    },
    SettingsProvidersHome: () => <p data-page="keys">keys</p>,
    SettingsPoolsPage: () => <p data-page="pools">pools</p>,
  };
});
vi.mock('../../pages/ProviderPoolPage', () => ({ ProviderPoolPage: () => <p data-page="pool">pool</p> }));
vi.mock('./MachineSettingsPage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    MachineSettingsPage: () => <p data-page={`machine:${useParams().id}:`}>machine</p>,
  };
});
vi.mock('./WorkspaceSettingsPage', async () => {
  const { useParams } = await import('react-router-dom');
  return { SettingsWorkspacePage: () => <p data-page={`workspace:${useParams().id}`}>workspace</p> };
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
let keys: unknown[] = KEYS;
let workspaces: unknown[] = WORKSPACES;
let pools: unknown[] = [{ id: 'p1', name: 'Team', members: [] }];
let runners: typeof RUNNERS = RUNNERS;
/** What POST /runners/reorder answers: the runners in the order asked, unless a test says otherwise. */
let reorder: (ids: string[]) => Promise<unknown> = async (ids) => {
  runners = ids.map((id) => RUNNERS.find((r) => r.id === id)!);
  return runners;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  keys = KEYS;
  workspaces = WORKSPACES;
  pools = [{ id: 'p1', name: 'Team', members: [] }];
  runners = RUNNERS;
  reorder = async (ids) => {
    runners = ids.map((id) => RUNNERS.find((r) => r.id === id)!);
    return runners;
  };
  toast.error.mockReset();
  apiMock.mockImplementation((async (path: string, init?: { body?: { ids: string[] } }) => {
    if (path === '/runners/reorder') return reorder(init!.body!.ids);
    if (path === '/runners') return runners;
    if (path === '/workspaces') return workspaces;
    if (path === '/providers/mine') return keys;
    if (path === '/providers/pools') return pools;
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

  it('has the five groups, and a + in the heading of Machines, Providers and Workspaces only', async () => {
    await visit('/settings/general');
    const titles = [...nav().querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(titles).toEqual(['Personal', 'Integrations', 'Machines', 'Providers', 'Workspaces']);
    expect(group('Personal').querySelector('.settings-nav-add')).toBeNull();
    expect(group('Integrations').querySelector('.settings-nav-add')).toBeNull();
    expect(group('Machines').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('Register a machine');
    expect(group('Providers').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('Connect a provider');
    expect(group('Workspaces').querySelector('.settings-nav-add')?.getAttribute('aria-label')).toBe('New workspace');
  });

  // Settings.css shows a group's + under the pointer only, except on a group marked empty.
  it('marks no group empty while each has something in it', async () => {
    await visit('/settings/general');
    for (const title of ['Machines', 'Providers', 'Workspaces']) {
      expect(group(title).classList.contains('settings-nav-group--empty')).toBe(false);
    }
  });

  it('marks a group with nothing in it empty, so its + stays in sight', async () => {
    runners = [];
    workspaces = [];
    keys = [];
    pools = [];
    await visit('/settings/general');
    for (const title of ['Machines', 'Providers', 'Workspaces']) {
      expect(group(title).classList.contains('settings-nav-group--empty')).toBe(true);
    }
  });

  it('lists Personal, each machine with its status dot, API keys and Account pools, and each workspace with its machine', async () => {
    await visit('/settings/general');
    expect(rows('Personal').map((r) => [r.label, r.href])).toEqual([
      ['General', '/settings/general'],
      ['Notifications', '/settings/notifications'],
      ['Appearance', '/settings/appearance'],
      ['Profile', '/settings/profile'],
      ['Storage', '/settings/storage'],
      ['Shared links', '/settings/shared-links'],
      ['Access tokens', '/settings/access-tokens'],
    ]);
    expect(rows('Integrations').map((r) => [r.label, r.href])).toEqual([['Feishu', '/settings/integrations/feishu']]);
    expect(rows('Machines').map((r) => [r.label, r.href, r.dot])).toEqual([
      ['gpu-box', '/settings/machines/gpuBox', 'Online'],
      ['old-laptop', '/settings/machines/oldLaptop', 'Needs you'],
      ['Studio Mac', '/settings/machines/studioMac', 'Offline'],
    ]);
    expect(rows('Providers').map((r) => [r.label, r.href, r.meta])).toEqual([
      // Two rows however many vendors the keys are (docs/mocks/settings-providers-compact).
      ['API keys', '/settings/providers', '3'],
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
      '/settings/providers': 'keys',
      '/settings/providers/pools': 'pools',
      '/settings/workspaces/wsOrbit': 'workspace:wsOrbit',
      '/settings/workspaces/wsSite': 'workspace:wsSite',
    };
    for (const [href, answered] of Object.entries(expected)) {
      await click(nav().querySelector(`a[href="${href}"]`));
      expect(addressBar()).toBe(href);
      expect(page()).toBe(answered);
      expect(nav().querySelector('a.active')?.getAttribute('href')).toBe(href);
    }
  });

  it('draws Providers as the one way to connect a provider while there is no key and no pool', async () => {
    keys = [];
    pools = [];
    await visit('/settings/general');
    expect(rows('Providers').map((r) => [r.label, r.href, r.meta])).toEqual([
      ['Connect a provider', '/settings/providers/new', null],
    ]);
    await click(nav().querySelector('a[href="/settings/providers/new"]'));
    expect(page()).toBe('pick-vendor');
  });

  it('keeps API keys lit on a vendor’s keys, and on none of a key’s own pages', async () => {
    for (const [path, lit] of [
      ['/settings/providers/anthropic', '/settings/providers'],
      ['/settings/providers/pools', '/settings/providers/pools'],
      ['/settings/providers/new', null],
      ['/settings/providers/new/anthropic', null],
      ['/settings/providers/keys/k1', null],
      ['/settings/providers/pools/p1', '/settings/providers/pools'],
    ] as const) {
      await visit(path);
      expect([path, nav().querySelector('a.active')?.getAttribute('href') ?? null]).toEqual([path, lit]);
      await act(async () => root?.unmount());
      root = null;
      container.remove();
    }
  });

  it('opens connecting a key, editing one and a pool’s page in the right-hand column', async () => {
    for (const [path, answered] of [
      ['/settings/providers/new', 'pick-vendor'],
      ['/settings/providers/new/anthropic', 'key'],
      ['/settings/providers/keys/k1', 'key'],
      ['/settings/providers/pools/p1', 'pool'],
    ] as const) {
      await visit(path);
      expect(addressBar()).toBe(path);
      expect(container.querySelector('.settings-column [data-page]')?.getAttribute('data-page')).toBe(answered);
      expect(nav()).toBeTruthy();
      await act(async () => root?.unmount());
      root = null;
      container.remove();
    }
  });

  it('sends each + where it adds one', async () => {
    await visit('/settings/general');
    await click(group('Machines').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/runners/register');
    expect(page()).toBe('register');

    await go('/settings/general');
    await click(group('Providers').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/settings/providers/new');
    expect(page()).toBe('pick-vendor');

    // New workspace: its page asks for the machine first.
    await go('/settings/general');
    await click(group('Workspaces').querySelector('.settings-nav-add'));
    expect(addressBar()).toBe('/settings/workspaces/new');
    expect(page()).toBe('workspace:new');
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

// Every workspace, most recently used first, each with its machine in grey: the owner asked for no fold.
describe('the Workspaces group', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const MANY = [
    { id: 'w1', name: 'orbit', runnerId: 'gpuBox', lastActiveAt: hoursAgo(1) },
    { id: 'w2', name: 'orbit', runnerId: 'studioMac', lastActiveAt: hoursAgo(30) },
    { id: 'w3', name: 'website', runnerId: 'studioMac', lastActiveAt: hoursAgo(2) },
    { id: 'w4', name: 'ml-experiments', runnerId: 'gpuBox', lastActiveAt: hoursAgo(5) },
    { id: 'w5', name: 'never-used', runnerId: 'gpuBox', lastActiveAt: null },
    { id: 'w6', name: 'docs', runnerId: 'oldLaptop', lastActiveAt: hoursAgo(50) },
    { id: 'w7', name: 'infra', runnerId: 'gpuBox', lastActiveAt: hoursAgo(3) },
    { id: 'w8', name: 'scratch', runnerId: 'oldLaptop', lastActiveAt: hoursAgo(400) },
  ];
  const labels = () => rows('Workspaces').map((r) => [r.label, r.meta]);

  it('lists every workspace, most recently used first and never-used last, each with its machine', async () => {
    workspaces = MANY;
    await visit('/settings/general');
    expect(labels()).toEqual([
      ['orbit', 'gpu-box'],
      ['website', 'Studio Mac'],
      ['infra', 'gpu-box'],
      ['ml-experiments', 'gpu-box'],
      // Two of one name stay apart by their machine.
      ['orbit', 'Studio Mac'],
      ['docs', 'old-laptop'],
      ['scratch', 'old-laptop'],
      ['never-used', 'gpu-box'],
    ]);
    expect([...group('Workspaces').querySelectorAll('button')].some((b) => b.textContent?.startsWith('Show all'))).toBe(false);
    expect(group('Workspaces').querySelector('input')).toBeNull();
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

/**
 * Machines are dragged into the order every runner list uses, in the Machines group itself: by the row
 * with a pointer, or by its grip with the keyboard. The new order shows at once, is sent as
 * POST /runners/reorder { ids }, and goes back with "Couldn't reorder the machines" if the server
 * refuses it. A press that doesn't move is still the link's.
 */
describe('reordering machines in the nav', () => {
  const ROW_HEIGHT = 30;
  // jsdom lays nothing out: each machine's row is given the box it would have, one under another.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const sortable = this.closest('.settings-nav-sortable');
      const index = sortable ? [...sortable.parentElement!.children].indexOf(sortable) : 0;
      const top = index * ROW_HEIGHT;
      return { x: 0, y: top, top, left: 0, right: 240, bottom: top + ROW_HEIGHT, width: 240, height: ROW_HEIGHT, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(async () => {
    // A drag's sensor keeps its click guard on the document for 50 ms after it lets go, and the
    // document outlives a test: let it go before the next test's click.
    await new Promise((resolve) => setTimeout(resolve, 60));
    vi.restoreAllMocks();
  });

  const machineOrder = () => rows('Machines').map((r) => r.label);
  const machineRow = (label: string) =>
    [...group('Machines').querySelectorAll<HTMLAnchorElement>('a.settings-nav-row')].find(
      (a) => a.querySelector('.settings-nav-label')?.textContent === label,
    )!;
  const reorderCalls = () =>
    apiMock.mock.calls.filter(([path]) => path === '/runners/reorder').map(([, init]) => init);

  /** A mouse pressed on a row, moved `dy` px down in steps, and let go. */
  async function dragRow(label: string, dy: number): Promise<MouseEvent> {
    const row = machineRow(label);
    const start = { clientX: 20, clientY: 15 };
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y });
    await act(async () => {
      row.dispatchEvent(pointer('pointerdown', start.clientX, start.clientY));
    });
    for (let step = 1; step <= 4; step += 1) {
      await act(async () => {
        document.dispatchEvent(pointer('pointermove', start.clientX, start.clientY + (dy * step) / 4));
      });
    }
    // The click a released press ends with lands on the row, as a browser's does.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      document.dispatchEvent(pointer('pointerup', start.clientX, start.clientY + dy));
    });
    await act(async () => {
      row.dispatchEvent(click);
    });
    await settle();
    return click;
  }

  it('draws a grip for each machine, named for it, that shows only on hover or focus', async () => {
    await visit('/settings/general');
    const grips = [...group('Machines').querySelectorAll<HTMLButtonElement>('button.settings-nav-grip')];
    expect(grips.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Reorder gpu-box',
      'Reorder old-laptop',
      'Reorder Studio Mac',
    ]);
    expect(grips.every((g) => g.title === 'Drag to reorder')).toBe(true);
    // Hidden at rest is the stylesheet's to say: opacity 0, shown on the row's hover or the grip's focus.
    const fs = await import('node:fs');
    const css = fs.readFileSync(
      [`${process.cwd()}/src/components/settings/Settings.css`, `${process.cwd()}/src/web/src/components/settings/Settings.css`].find(
        (path) => fs.existsSync(path),
      )!,
      'utf8',
    );
    expect(css).toMatch(/\.settings-nav-grip \{[^}]*opacity: 0;/);
    expect(css).toMatch(/\.settings-nav-sortable:hover \.settings-nav-grip,[^{]*\.settings-nav-grip:focus-visible \{\s*opacity: 1;/);
    // No other group has one.
    expect(nav().querySelectorAll('button.settings-nav-grip')).toHaveLength(3);
  });

  it('a drag sends the new order to POST /runners/reorder and the nav shows it, without opening the machine', async () => {
    await visit('/settings/general');
    expect(machineOrder()).toEqual(['gpu-box', 'old-laptop', 'Studio Mac']);
    const click = await dragRow('gpu-box', 2 * ROW_HEIGHT);
    // The browser doesn't follow the link either.
    expect(click.defaultPrevented).toBe(true);
    expect(reorderCalls()).toEqual([{ method: 'POST', body: { ids: ['oldLaptop', 'studioMac', 'gpuBox'] } }]);
    expect(machineOrder()).toEqual(['old-laptop', 'Studio Mac', 'gpu-box']);
    // The drag's click was the drag's: Settings stayed where it was.
    expect(addressBar()).toBe('/settings/general');
    expect(page()).toBe('/settings/general');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('moves a machine with the keyboard on its grip, as the old handle did', async () => {
    await visit('/settings/general');
    const grip = group('Machines').querySelector<HTMLButtonElement>('button[aria-label="Reorder Studio Mac"]')!;
    const key = async (code: string) => {
      await act(async () => {
        grip.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true }));
      });
      await settle();
    };
    grip.focus();
    await key('Space');
    await key('ArrowUp');
    await key('Space');
    expect(reorderCalls()).toEqual([{ method: 'POST', body: { ids: ['gpuBox', 'studioMac', 'oldLaptop'] } }]);
    expect(machineOrder()).toEqual(['gpu-box', 'Studio Mac', 'old-laptop']);
    expect(addressBar()).toBe('/settings/general');
  });

  it('a refused reorder puts the machines back and says so', async () => {
    let refuse!: (error: Error) => void;
    reorder = () => new Promise((_resolve, reject) => (refuse = reject));
    await visit('/settings/general');
    await dragRow('Studio Mac', -2 * ROW_HEIGHT);
    expect(reorderCalls()).toEqual([{ method: 'POST', body: { ids: ['studioMac', 'gpuBox', 'oldLaptop'] } }]);
    // Shown at once, before the server answers.
    expect(machineOrder()).toEqual(['Studio Mac', 'gpu-box', 'old-laptop']);
    await act(async () => refuse(new Error('Machine order is stale')));
    await settle();
    expect(machineOrder()).toEqual(['gpu-box', 'old-laptop', 'Studio Mac']);
    expect(toast.error).toHaveBeenCalledWith("Couldn't reorder the machines", 'Machine order is stale');
  });

  it('a plain click on a machine still opens its page, and sends no reorder', async () => {
    await visit('/settings/general');
    await dragRow('old-laptop', 0);
    expect(addressBar()).toBe('/settings/machines/oldLaptop');
    expect(page()).toBe('machine:oldLaptop:');
    expect(reorderCalls()).toEqual([]);
    // A press that moved less than the drag's 5 px is a click too.
    await go('/settings/general');
    await dragRow('gpu-box', 3);
    expect(addressBar()).toBe('/settings/machines/gpuBox');
    expect(reorderCalls()).toEqual([]);
    expect(machineOrder()).toEqual(['gpu-box', 'old-laptop', 'Studio Mac']);
  });
});
