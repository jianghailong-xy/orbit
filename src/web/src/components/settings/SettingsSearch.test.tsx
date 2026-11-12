// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { resetSettingsReturn } from '../../lib/settingsReturn';
import { PERSONAL_SETTINGS } from '../../pages/settings/settingsIndex';
import { NARROW_SETTINGS_QUERY } from './SettingsLayout';
import { searchSettings } from './settingsSearch';

/**
 * Settings' search box and its narrow window (docs/mocks/settings-redesign, board-2 note 2 and board-6).
 *
 * The search finds Personal settings by title and description (from the Settings index), machines by
 * name and hostname, vendors by name and keys by label, and workspaces by name and working directory;
 * its results replace the nav while there is a query, and opening one goes to the page and lights the
 * row that matched. Below 760px the nav is a page of its own at /settings, and each page has
 * "‹ Settings" above it.
 *
 * Mounted through the real App routes; each page is reduced to the rows search can point at, drawn
 * with the real SettingsRow so the anchor is the one the real pages set.
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
vi.mock('../WorkspaceConsole', () => ({ WorkspaceConsole: () => <p data-page="console">console</p> }));
vi.mock('../../pages/TaskRoute', () => ({ TaskRoute: () => <p data-page="tasks">the task list</p> }));

// A Personal page draws the index's rows for its own address, as the real pages do.
const { personalPage } = vi.hoisted(() => ({
  personalPage: async () => {
    const { useLocation } = await import('react-router-dom');
    const { SettingsRow } = await import('./SettingsBlocks');
    const { PERSONAL_SETTINGS: index } = await import('../../pages/settings/settingsIndex');
    return () => {
      const { pathname } = useLocation();
      return (
        <div data-page={pathname}>
          {Object.values(index)
            .filter((s) => s.path === pathname)
            .map((s) => (
              <SettingsRow key={s.anchor} anchor={s.anchor} title={s.title} description={s.description} />
            ))}
        </div>
      );
    };
  },
}));
vi.mock('../../pages/settings/GeneralPage', async () => ({ GeneralSettingsPage: await personalPage() }));
vi.mock('../../pages/settings/NotificationsPage', async () => ({ NotificationsSettingsPage: await personalPage() }));
vi.mock('../../pages/settings/AppearancePage', async () => ({ AppearanceSettingsPage: await personalPage() }));
vi.mock('../../pages/settings/StoragePage', async () => ({ StorageSettingsPage: await personalPage() }));
vi.mock('../../pages/ProfilePage', async () => ({ ProfilePage: await personalPage() }));
vi.mock('./MachineSettingsPage', async () => {
  const { useParams } = await import('react-router-dom');
  const { SettingsRow } = await import('./SettingsBlocks');
  return {
    MachineSettingsPage: () => (
      <div data-page={`machine:${useParams().id}`}>
        <SettingsRow anchor="name" title="Name" />
        <SettingsRow anchor="hostname" title="Hostname" />
      </div>
    ),
  };
});
vi.mock('./WorkspaceSettingsPage', async () => {
  const { useParams } = await import('react-router-dom');
  const { SettingsRow } = await import('./SettingsBlocks');
  return {
    SettingsWorkspacePage: () => (
      <div data-page={`workspace:${useParams().id}`}>
        <SettingsRow anchor="name" title="Name" />
        <SettingsRow anchor="workDir" title="Working directory" />
      </div>
    ),
  };
});
vi.mock('./SettingsProviderPages', async (original) => {
  const { useParams } = await import('react-router-dom');
  const { SettingsRow } = await import('./SettingsBlocks');
  return {
    ...(await original<typeof import('./SettingsProviderPages')>()),
    SettingsVendorPage: () => (
      <div data-page={`vendor:${useParams().vendor}`}>
        {['k1', 'k2', 'k3'].map((id) => (
          <SettingsRow key={id} anchor={`key:${id}`} title={id} />
        ))}
      </div>
    ),
    SettingsPoolsPage: () => <p data-page="pools">pools</p>,
  };
});

const RUNNERS = [
  { id: 'gpuBox', name: 'gpu-box', hostname: 'dgx-07.internal', online: true, engines: [] },
  { id: 'studioMac', name: 'studio-mac', displayName: 'Studio Mac', hostname: 'mac-mini.local', online: true, engines: [] },
];
const WORKSPACES = [
  { id: 'wsOrbit', name: 'orbit', runnerId: 'gpuBox', workDir: '/srv/code/orbit' },
  { id: 'wsSite', name: 'website', runnerId: 'studioMac', workDir: '/Users/me/site' },
];
const KEYS = [
  { id: 'k1', slug: 'anthropic', label: 'Work', presetSlug: 'anthropic' },
  { id: 'k2', slug: 'openai', label: 'OpenAI', presetSlug: 'openai' },
  { id: 'k3', slug: 'anthropic-2', label: 'Home', presetSlug: 'anthropic' },
];

let container: HTMLDivElement;
let root: Root | null = null;
let narrow = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  narrow = false;
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/runners') return RUNNERS;
    if (path === '/workspaces') return WORKSPACES;
    if (path === '/providers/mine') return KEYS;
    if (path === '/providers/pools') return [];
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === NARROW_SETTINGS_QUERY ? narrow : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  Element.prototype.scrollIntoView = vi.fn();
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

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const searchBox = () => container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;

async function type(text: string): Promise<void> {
  const input = searchBox();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function press(key: string, target: EventTarget = searchBox()): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

const addressBar = () => window.location.pathname;
const nav = () => container.querySelector('nav.settings-nav');
const navGroups = () => container.querySelector<HTMLElement>('.settings-nav-groups');
/** The results on screen, by group: each hit's label and second line, the marked words in [brackets]. */
const results = () =>
  Object.fromEntries(
    [...container.querySelectorAll<HTMLElement>('[role="group"][aria-label$=" results"]')].map((group) => [
      group.querySelector('.settings-nav-heading')!.textContent,
      [...group.querySelectorAll('.settings-search-hit')].map((hit) =>
        [...hit.querySelectorAll('span')].map((part) =>
          [...part.childNodes].map((n) => (n.nodeName === 'MARK' ? `[${n.textContent}]` : n.textContent)).join(''),
        ),
      ),
    ]),
  );
const hit = (label: string) =>
  [...container.querySelectorAll('.settings-search-hit')].find(
    (b) => b.querySelector('.settings-search-hit-label')?.textContent === label,
  );
const litRow = () => container.querySelector<HTMLElement>('.settings-row--found')?.dataset.settingAnchor ?? null;

describe('Settings search', () => {
  it('finds a Personal setting by its title, in place of the nav, and opens its page at the row, lit', async () => {
    await visit('/settings/notifications');
    expect(navGroups()!.hidden).toBe(false);
    await type('recap');
    expect(navGroups()!.hidden).toBe(true);
    expect(results()).toEqual({ Personal: [['Session [recap]s', 'General']] });
    await click(hit('Session recaps'));
    expect(addressBar()).toBe('/settings/general');
    expect(litRow()).toBe('recaps');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // The query is spent: the nav is back.
    expect(searchBox().value).toBe('');
    expect(navGroups()!.hidden).toBe(false);
  });

  it('finds a Personal setting by its description, and a page by its name', async () => {
    await visit('/settings/general');
    await type('across devices');
    expect(results()).toEqual({ Personal: [['Theme', 'Synced to your account [across devices].']] });
    await click(hit('Theme'));
    expect(addressBar()).toBe('/settings/appearance');
    expect(litRow()).toBe('theme');

    await type('tokens');
    expect(results()).toEqual({ Personal: [['Access [tokens]']] });
    await click(hit('Access tokens'));
    expect(addressBar()).toBe('/settings/access-tokens');
  });

  it('finds a machine by name, and by hostname, and opens it at that row', async () => {
    await visit('/settings/general');
    await type('studio');
    expect(results()).toEqual({ Machines: [['[Studio] Mac', 'mac-mini.local']] });
    await click(hit('Studio Mac'));
    expect(addressBar()).toBe('/settings/machines/studioMac');
    expect(litRow()).toBe('name');

    await type('DGX');
    expect(results()).toEqual({ Machines: [['gpu-box', '[dgx]-07.internal']] });
    await press('Enter');
    expect(addressBar()).toBe('/settings/machines/gpuBox');
    expect(litRow()).toBe('hostname');
  });

  it('finds a vendor by name, and a key by its label on its vendor page', async () => {
    await visit('/settings/general');
    await type('anthropic');
    expect(results()).toEqual({ Providers: [['[Anthropic]', '2 keys']] });
    await click(hit('Anthropic'));
    expect(addressBar()).toBe('/settings/providers/anthropic');
    expect(litRow()).toBeNull();

    await type('home');
    expect(results()).toEqual({ Providers: [['[Home]', 'Anthropic key']] });
    await press('Enter');
    expect(addressBar()).toBe('/settings/providers/anthropic');
    expect(litRow()).toBe('key:k3');
  });

  it('finds a workspace by name, and by its working directory', async () => {
    await visit('/settings/general');
    await type('websit');
    expect(results()).toEqual({ Workspaces: [['[websit]e', 'Studio Mac']] });
    await click(hit('website'));
    expect(addressBar()).toBe('/settings/workspaces/wsSite');
    expect(litRow()).toBe('name');

    await type('/srv/code');
    expect(results()).toEqual({ Workspaces: [['orbit', '[/srv/code]/orbit']] });
    await click(hit('orbit'));
    expect(addressBar()).toBe('/settings/workspaces/wsOrbit');
    expect(litRow()).toBe('workDir');
  });

  it('groups a query that matches in several groups, and the arrows choose which Enter opens', async () => {
    await visit('/settings/general');
    await type('orbit');
    expect(results()).toEqual({
      // A long line is cut so the match shows.
      Personal: [['Let sessions orchestrate', '… other sessions via the [orbit] MCP tools.']],
      Workspaces: [['[orbit]', 'gpu-box']],
    });
    await press('ArrowDown');
    expect(container.querySelector('.settings-search-hit.chosen .settings-search-hit-label')?.textContent).toBe('orbit');
    await press('Enter');
    expect(addressBar()).toBe('/settings/workspaces/wsOrbit');
  });

  it('says when nothing matches', async () => {
    await visit('/settings/general');
    await type('zzz');
    expect(results()).toEqual({});
    expect(container.querySelector('.settings-nav-none')?.textContent).toBe('Nothing in Settings matches.');
  });

  it('clears the query with Esc before Esc leaves Settings', async () => {
    await visit('/settings/storage');
    await type('theme');
    await press('Escape', document);
    expect(addressBar()).toBe('/settings/storage');
    expect(searchBox().value).toBe('');
    expect(navGroups()!.hidden).toBe(false);
    await press('Escape', document);
    expect(addressBar().startsWith('/settings')).toBe(false);
    expect(container.querySelector('[data-testid="app-shell"]')).toBeTruthy();
  });

  it('searches every setting in the index, by title', () => {
    const sources = { runners: [], keys: [], workspaces: [] };
    for (const setting of Object.values(PERSONAL_SETTINGS)) {
      const found = searchSettings(setting.title, sources).flatMap((g) => g.hits);
      expect(found).toContainEqual(expect.objectContaining({ to: setting.path, anchor: setting.anchor }));
    }
  });
});

describe('Settings in a window narrower than 760px', () => {
  it('is the nav alone at /settings, and each row opens its page full width with ‹ Settings to go back', async () => {
    narrow = true;
    await visit('/settings');
    expect(addressBar()).toBe('/settings');
    expect(container.querySelector('.settings-shell--narrow')).toBeTruthy();
    expect(nav()).toBeTruthy();
    expect(container.querySelector('main.settings-main')).toBeNull();

    await click(nav()!.querySelector('a[href="/settings/machines/gpuBox"]'));
    expect(addressBar()).toBe('/settings/machines/gpuBox');
    expect(nav()).toBeNull();
    expect(container.querySelector('[data-page]')?.getAttribute('data-page')).toBe('machine:gpuBox');
    const back = container.querySelector<HTMLButtonElement>('main .settings-back--list');
    expect(back?.textContent).toBe('Settings');

    await click(back);
    expect(addressBar()).toBe('/settings');
    expect(nav()).toBeTruthy();
    expect(container.querySelector('main.settings-main')).toBeNull();
  });

  it('opens a search result as a page of its own too', async () => {
    narrow = true;
    await visit('/settings');
    await type('/Users/me');
    await press('Enter');
    expect(addressBar()).toBe('/settings/workspaces/wsSite');
    expect(nav()).toBeNull();
    expect(litRow()).toBe('workDir');
  });

  it('opens a page linked to directly with ‹ Settings above it', async () => {
    narrow = true;
    await visit('/settings/notifications');
    expect(nav()).toBeNull();
    expect(container.querySelector('main .settings-back--list')).toBeTruthy();
    expect(container.querySelector('[data-page]')?.getAttribute('data-page')).toBe('/settings/notifications');
  });

  it('is two columns at 760px and wider: /settings opens General beside the nav, with no ‹ Settings', async () => {
    narrow = false;
    await visit('/settings');
    expect(addressBar()).toBe('/settings/general');
    expect(container.querySelector('.settings-shell--narrow')).toBeNull();
    expect(nav()).toBeTruthy();
    expect(container.querySelector('main.settings-main')).toBeTruthy();
    expect(container.querySelector('.settings-back--list')).toBeNull();
  });

  it('switches at 760px exactly', () => {
    expect(NARROW_SETTINGS_QUERY).toBe('(max-width: 759.98px)');
  });
});
