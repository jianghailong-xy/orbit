// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { resetSettingsReturn } from '../../lib/settingsReturn';

/**
 * Admin drawn as Settings is (owner's choice A, docs/mocks/admin-settings-style): it takes over the window, no
 * app sidebar, a nav of its pages in three groups — Accounts (Users with its count, Sign-in), Server (Email),
 * Integrations (Feishu bots) — each setting's On / Off as a dot, and Back to Orbit and Esc return to the page Admin
 * was opened from, across pages inside it. The addresses stay /admin, /admin/sign-in, /admin/email and
 * /admin/integrations.
 *
 * Mounted through the real App routes under the real BrowserRouter; the pages are reduced to a line saying which
 * one answered.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);

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
vi.mock('../WorkspaceConsole', () => ({ WorkspaceConsole: () => <p data-page="console">console</p> }));
vi.mock('../../pages/AdminUsersPage', () => ({ AdminUsersPage: () => <p data-page="users">users</p> }));
vi.mock('../../pages/AdminSignInPage', async (original) => ({
  ...(await original<typeof import('../../pages/AdminSignInPage')>()),
  AdminSignInPage: () => <p data-page="sign-in">sign-in</p>,
}));
vi.mock('../../pages/AdminEmailPage', async (original) => ({
  ...(await original<typeof import('../../pages/AdminEmailPage')>()),
  AdminEmailPage: () => <p data-page="email">email</p>,
}));
vi.mock('../../pages/AdminIntegrationsPage', async (original) => ({
  ...(await original<typeof import('../../pages/AdminIntegrationsPage')>()),
  AdminIntegrationsPage: () => <p data-page="integrations">integrations</p>,
}));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/admin/users') return [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    // Google: switched on but no secret saved, so not working: Off.
    if (path === '/admin/sign-in/google') {
      return { enabled: true, clientId: 'abc', hasSecret: false, secretUnreadable: false, signupPolicy: 'EXISTING_ACCOUNTS', redirectUri: 'x' };
    }
    if (path === '/admin/email') return { on: true };
    if (path === '/admin/integrations/feishu') return { allowed: true, connectedApps: 0, enabledApps: 0 };
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

const addressBar = (): string => window.location.pathname + window.location.search + window.location.hash;
const nav = () => container.querySelector('nav.settings-nav[aria-label="Admin"]')!;
const groups = () =>
  [...nav().querySelectorAll<HTMLElement>('[role="group"]')].map((group) => ({
    title: group.getAttribute('aria-label'),
    rows: [...group.querySelectorAll<HTMLAnchorElement>('a.settings-nav-row')].map((a) => ({
      label: a.querySelector('.settings-nav-label')?.textContent,
      href: a.getAttribute('href'),
      meta: a.querySelector('.settings-nav-meta')?.textContent ?? null,
      dot: a.querySelector('.settings-dot')?.getAttribute('aria-label') ?? null,
    })),
  }));
const active = () => nav().querySelector('a.settings-nav-row.active .settings-nav-label')?.textContent;
const page = () => container.querySelector('[data-page]')?.getAttribute('data-page');
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === name);

describe('the Admin window', () => {
  it('takes over the window with its own nav: three groups, a count on Users, On / Off on the rest', async () => {
    await visit('/admin');
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(nav().querySelector('.settings-title')?.textContent).toBe('Admin');
    expect(groups()).toEqual([
      {
        title: 'Accounts',
        rows: [
          { label: 'Users', href: '/admin', meta: '3', dot: null },
          { label: 'Sign-in', href: '/admin/sign-in', meta: null, dot: 'Off' },
        ],
      },
      { title: 'Server', rows: [{ label: 'Email', href: '/admin/email', meta: null, dot: 'On' }] },
      { title: 'Integrations', rows: [{ label: 'Feishu bots', href: '/admin/integrations', meta: null, dot: 'On' }] },
    ]);
    expect(page()).toBe('users');
    expect(active()).toBe('Users');
  });

  it('each row opens its page at the address it always had, and only that row is lit', async () => {
    await visit('/admin');
    for (const [label, address, answered] of [
      ['Sign-in', '/admin/sign-in', 'sign-in'],
      ['Email', '/admin/email', 'email'],
      ['Feishu bots', '/admin/integrations', 'integrations'],
      ['Users', '/admin', 'users'],
    ] as const) {
      await click([...nav().querySelectorAll('a.settings-nav-row')].find((a) => a.textContent?.includes(label)));
      expect(addressBar()).toBe(address);
      expect(page()).toBe(answered);
      expect(active()).toBe(label);
      expect(nav().querySelectorAll('a.settings-nav-row.active')).toHaveLength(1);
    }
  });

  it('Back to Orbit returns to the page Admin was opened from, across pages inside it', async () => {
    await visit('/tasks?scope=mine');
    await go('/admin');
    await click(nav().querySelector('a[href="/admin/email"]'));
    await click(nav().querySelector('a[href="/admin/sign-in"]'));
    await click(button('Back to Orbit'));
    expect(addressBar()).toBe('/tasks?scope=mine');
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('Esc does what Back to Orbit does, unless something is open over the page', async () => {
    await visit('/tasks');
    await go('/admin/email');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(addressBar()).toBe('/admin/email');
    dialog.remove();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(addressBar()).toBe('/tasks');
  });
});
