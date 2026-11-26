// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * The account menu's Machines row: every machine a level down with its state, each opening its Settings page,
 * and Add a machine under them. With no machine yet the row itself adds the first.
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

let runners: unknown[] = [];
// The account's managed runner, by the shared fixture's state name; null serves a server without the feature.
let managed: string | null = null;

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as {
  capabilities: { name: string; body: unknown }[];
  states: { name: string; status: ManagedRunnerStatus }[];
};
const managedState = (name: string) => fixture.states.find((c) => c.name === name)!.status;

function serve() {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return runners;
    if (path === '/auth/capabilities' && managed) {
      return fixture.capabilities.find((c) => c.name === 'switched on')!.body;
    }
    if (path === '/managed-runner' && managed) return managedState(managed);
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'MEMBER', avatarUpdatedAt: null };
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

const accountRow = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(label),
  );

async function press(row: HTMLElement | undefined): Promise<void> {
  if (!row) throw new Error('no such row');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

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
  runners = [];
  managed = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe('Machines in the account menu', () => {
  it('sits under Appearance and says how many machines are online', async () => {
    runners = [
      { id: 'r1', name: 'mbp', displayName: 'MacBook Pro', online: true },
      { id: 'r2', name: 'build-box', online: true },
      { id: 'r3', name: 'old-linux', online: false },
    ];
    serve();
    await visit('/projects');
    await openAccountMenu();

    const labels = [...document.querySelectorAll<HTMLElement>('[role="menu"].tp-account-menu > [role="menuitem"]')]
      .filter((row) => !row.classList.contains('tp-account-profile'))
      .map((row) => row.textContent);
    expect(labels).toEqual(['AppearanceSystem', 'Machines2 of 3 online', 'Model routingBalance', 'Help center', 'Settings', 'Log out']);
    expect(accountRow('Machines')!.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('lists each machine with its state, and opens its Settings page', async () => {
    runners = [
      { id: 'r1', name: 'mbp', displayName: 'MacBook Pro', online: true },
      { id: 'r3', name: 'old-linux', online: false },
    ];
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Machines'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('MacBook Pro')).toBeDefined(), { timeout: 5_000, interval: 20 });
    });

    expect(accountRow('MacBook Pro')!.textContent).toBe('MacBook Pro');
    expect(accountRow('MacBook Pro')!.querySelector('.tp-account-machine-dot')!.getAttribute('data-online')).toBe('true');
    expect(accountRow('old-linux')!.textContent).toBe('old-linuxOffline');
    expect(accountRow('old-linux')!.querySelector('.tp-account-machine-dot')!.getAttribute('data-online')).toBe('false');
    expect(accountRow('Add a machine')).toBeDefined();
    // The level's rows are as tall as the account menu's own (index.css .tp-account-submenu).
    expect(accountRow('MacBook Pro')!.closest('[role="menu"]')!.classList.contains('tp-account-submenu')).toBe(true);

    await press(accountRow('old-linux'));
    expect(pathname).toBe('/settings/machines/r3');
  });

  it.each([
    ['available', 'true', 'Orbit Cloud'],
    ['sleeping', 'false', 'Orbit CloudAsleep'],
  ])('shows the managed runner %s by its own state, never Ready', async (name, dot, text) => {
    managed = name;
    const id = managedState(name).runnerId!;
    runners = [{ id, name: 'orbit-cloud', online: name === 'available' }];
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Machines'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('Orbit Cloud')?.textContent).toBe(text), { timeout: 5_000, interval: 20 });
    });
    expect(accountRow('Orbit Cloud')!.querySelector('.tp-account-machine-dot')!.getAttribute('data-online')).toBe(dot);
  });

  it('pins Orbit Cloud first, marked, with a line before your own machines in their order', async () => {
    runners = [
      { id: 'r1', name: 'mbp', displayName: 'MacBook Pro', online: true },
      { id: 'r2', name: 'orbit-cloud', online: true, managed: true },
      { id: 'r3', name: 'old-linux', online: false },
    ];
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Machines'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('Orbit Cloud')).toBeDefined(), { timeout: 5_000, interval: 20 });
    });

    const level = accountRow('Orbit Cloud')!.closest('[role="menu"]')!;
    const rows = [...level.children].map((row) =>
      row.getAttribute('role') === 'separator' ? '—' : (row.textContent ?? ''),
    );
    expect(rows).toEqual(['Orbit Cloud', '—', 'MacBook Pro', 'old-linuxOffline', '—', 'Add a machine']);
    expect(accountRow('Orbit Cloud')!.querySelector('.tp-account-machine-cloud .anticon-cloud')).not.toBeNull();
    expect(accountRow('MacBook Pro')!.querySelector('.tp-account-machine-cloud')).toBeNull();
  });

  it('marks every other machine by the OS it reported, a monitor when it has not said', async () => {
    runners = [
      { id: 'r2', name: 'orbit-cloud', online: true, managed: true, capabilities: ['os:linux'] },
      { id: 'r1', name: 'mini', online: true, capabilities: ['session-worktree-ops-v1', 'os:darwin'] },
      { id: 'r3', name: 'hpc', online: true, capabilities: ['os:linux'] },
      { id: 'r4', name: 'win-box', online: true, capabilities: ['os:windows'] },
      { id: 'r5', name: 'old-runner', online: true },
    ];
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Machines'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('Orbit Cloud')).toBeDefined(), { timeout: 5_000, interval: 20 });
    });

    const osOf = (label: string) => accountRow(label)!.querySelector('.tp-account-machine-os > .anticon')?.getAttribute('data-os');
    expect(osOf('mini')).toBe('darwin');
    expect(osOf('hpc')).toBe('linux');
    expect(osOf('win-box')).toBe('windows');
    expect(osOf('old-runner')).toBe('unknown');
    // Add a machine's + leads, in the same column, so its words start where the names do; no icon at the row's end.
    expect(accountRow('Add a machine')!.querySelector('.tp-account-machine-os > .anticon-plus')).not.toBeNull();
    expect(accountRow('Add a machine')!.querySelector('.orbit-menu-icon')).toBeNull();
    // Orbit Cloud keeps its cloud, whatever OS it runs.
    expect(accountRow('Orbit Cloud')!.querySelector('.tp-account-machine-os')).toBeNull();
    expect(accountRow('Orbit Cloud')!.querySelector('.anticon-cloud')).not.toBeNull();
  });

  it('draws Appearance\'s choices with their marks before them, as the machines are drawn', async () => {
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Appearance'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('Light')).toBeDefined(), { timeout: 5_000, interval: 20 });
    });
    const markOf = (label: string) =>
      [...accountRow(label)!.querySelector('.tp-account-machine-os > .anticon')!.classList].find((c) => c.startsWith('anticon-'));
    expect(markOf('System')).toBe('anticon-desktop');
    expect(markOf('Light')).toBe('anticon-sun');
    expect(markOf('Dark')).toBe('anticon-moon');
    // The current choice keeps its check at the row's end.
    expect(accountRow('System')!.querySelector('.orbit-menu-icon .anticon-check')).not.toBeNull();
  });

  it('draws no line under Orbit Cloud when it is the only machine', async () => {
    runners = [{ id: 'r2', name: 'orbit-cloud', online: true, managed: true }];
    serve();
    await visit('/projects');
    await openAccountMenu();
    await press(accountRow('Machines'));
    await act(async () => {
      await vi.waitFor(() => expect(accountRow('Orbit Cloud')).toBeDefined(), { timeout: 5_000, interval: 20 });
    });
    const level = accountRow('Orbit Cloud')!.closest('[role="menu"]')!;
    expect(level.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  it('reads All online when none is down', async () => {
    runners = [{ id: 'r1', name: 'mbp', online: true }];
    serve();
    await visit('/projects');
    await openAccountMenu();
    expect(accountRow('Machines')!.textContent).toBe('MachinesAll online');
  });

  it('with no machine yet, reads None and adds the first', async () => {
    serve();
    await visit('/projects');
    await openAccountMenu();
    const machines = accountRow('Machines')!;
    expect(machines.textContent).toBe('MachinesNone');
    expect(machines.hasAttribute('aria-haspopup')).toBe(false);

    await press(machines);
    expect(pathname).toBe('/settings/machines/new');
  });
});
