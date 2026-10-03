// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * Where an admin finds user management: a row of the account menu at the sidebar's foot, right
 * under Settings — not an entry among the fixed destinations up top, which are the same for every
 * account. A member's menu is the one it always was.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

function serve(role: 'ADMIN' | 'MEMBER') {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return [];
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role, avatarUpdatedAt: null };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function openAccountMenu(): Promise<void> {
  const trigger = container!.querySelector<HTMLButtonElement>('.tp-user-trigger')!;
  await act(async () => trigger.click());
  await settle();
}

/** The fixed destinations at the top of the expanded panel, by label. */
const topEntries = () =>
  [...container!.querySelectorAll('.tp-section .tp-item .tp-label')].map((label) => label.textContent);

/** The account menu's plain rows, top to bottom, by label (Appearance is a submenu, not one). */
const menuRows = () =>
  [...document.querySelectorAll('.tp-account-menu .ant-dropdown-menu-item:not(.tp-account-profile)')].map(
    (row) => row.querySelector('.ant-dropdown-menu-title-content')?.textContent,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe('Admin, for an admin', () => {
  it('is a row of the account menu right under Settings, not a top-nav entry', async () => {
    serve('ADMIN');
    await visit('/projects');
    expect(topEntries()).toEqual(['Projects', 'Tasks', 'Wiki', 'Runners', 'Providers']);

    await openAccountMenu();
    expect(menuRows()).toEqual(['Settings', 'Admin', 'Log out']);
  });

  it('opens the Users page', async () => {
    serve('ADMIN');
    await visit('/projects');
    await openAccountMenu();

    const admin = [...document.querySelectorAll<HTMLElement>('.tp-account-menu .ant-dropdown-menu-item')].find(
      (row) => row.querySelector('.ant-dropdown-menu-title-content')?.textContent === 'Admin',
    )!;
    await act(async () => admin.click());
    await settle();
    expect(pathname).toBe('/admin');
  });

  it('lights no top-nav entry on the Users page, as on Settings', async () => {
    serve('ADMIN');
    await visit('/admin');
    expect(topEntries()).not.toContain('Admin');
    expect(container!.querySelector('.tp-section .tp-item[aria-current="page"]')).toBeNull();
  });
});

describe('Admin, for a member', () => {
  it('is nowhere: the account menu is the one it always was', async () => {
    serve('MEMBER');
    await visit('/projects');
    expect(topEntries()).toEqual(['Projects', 'Tasks', 'Wiki', 'Runners', 'Providers']);

    await openAccountMenu();
    expect(menuRows()).toEqual(['Settings', 'Log out']);
  });
});
