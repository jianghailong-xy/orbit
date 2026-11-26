// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * Model routing in the account menu: a row right above Settings that opens Settings → Providers → Model routing,
 * its end column saying how routing runs now — Off, or the Optimize For it routes by.
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

function serve(preferences: Record<string, unknown>) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return [];
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'MEMBER', avatarUpdatedAt: null, preferences };
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

/** The account menu's plain rows, top to bottom, by label (the profile row aside; Appearance opens a submenu, so
 *  it is not one). */
const menuRows = () =>
  [...document.querySelectorAll('[role="menu"].tp-account-menu [role="menuitem"]:not(.tp-account-profile):not([aria-haspopup])')].map(
    (row) => row.textContent,
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

const routingRow = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"].tp-account-menu [role="menuitem"]')].find((row) =>
    row.textContent?.startsWith('Model routing'),
  );

describe('Model routing in the account menu', () => {
  it('sits right above Help center and Settings, saying the mode it routes by, Balance for an account that never chose', async () => {
    serve({});
    await visit('/projects');
    await openAccountMenu();
    expect(menuRows()).toEqual(['MachinesNone', 'Model routingBalance', 'Help center', 'Settings', 'Log out']);
  });

  it('says the Optimize For the account chose, and Off while Route by tier is off', async () => {
    serve({ optimizeFor: 'intelligence' });
    await visit('/projects');
    await openAccountMenu();
    expect(routingRow()?.textContent).toBe('Model routingIntelligence');
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';

    serve({ modelRouting: false, optimizeFor: 'cost' });
    await visit('/projects');
    await openAccountMenu();
    expect(routingRow()?.textContent).toBe('Model routingOff');
  });

  it('opens Settings → Providers → Model routing', async () => {
    serve({});
    await visit('/projects');
    await openAccountMenu();
    await act(async () => routingRow()!.click());
    await settle();
    expect(pathname).toBe('/settings/providers/routing');
  });
});
