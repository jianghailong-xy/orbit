// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MANAGED_RUNNER_COPY, type ManagedRunnerRowKind, type ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { encodeId } from '../../lib/idCodec';
import { resetSettingsReturn } from '../../lib/settingsReturn';

/**
 * The managed runner's entry for an account that already has machines or workspaces
 * (docs/managed-runner-existing-account-entry-design.md, board 2; owner took D1–D5 = A):
 * Settings → Machines gets "Managed runner · Set up" while the server offers one, its page asks first and
 * then lands on the runner's machine page; once mapped the runner's row carries the shared short label; and
 * with the feature off there is no entry and GET /managed-runner is never read.
 *
 * Mounted through the real App routes, driven by the shared state fixture every client is held to.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api, ApiError } = await import('../../api');
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
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('../../pages/settings/GeneralPage', () => ({ GeneralSettingsPage: () => <p data-page="general">general</p> }));
vi.mock('./MachineSettingsPage', async () => {
  const { useParams } = await import('react-router-dom');
  return { MachineSettingsPage: () => <p data-page={`machine:${useParams().id}`}>machine</p> };
});
vi.mock('../WorkspaceConsole', () => ({ WorkspaceConsole: () => <p data-page="console">console</p> }));

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as {
  capabilities: { name: string; httpStatus: number; body: unknown; offered: boolean }[];
  states: { name: string; display: { kind: string } | null; status: ManagedRunnerStatus }[];
};
const state = (name: string) => fixture.states.find((c) => c.name === name)!.status;
const capability = (name: string) => fixture.capabilities.find((c) => c.name === name)!;
const ON = capability('switched on');

const MANAGED = state('sleeping').runnerId!;
const OWN = [
  { id: '33zx0JhRhJo8rd25d3qAM', name: 'workstation', online: true, engines: [] },
  { id: '33zx0JhRhJo8rd25d3qAN', name: 'laptop', online: false, engines: [] },
];
const MANAGED_RUNNER = { id: MANAGED, name: 'managed', online: false, engines: [] };
const WORKSPACES = [{ id: '33zx0JhRhJo8rd25d3qAP', name: 'orbit', runnerId: OWN[0].id, createdAt: '2026-01-01T00:00:00Z' }];

interface Server {
  capabilities: { httpStatus: number; body: unknown };
  status: ManagedRunnerStatus;
  runners: unknown[];
  workspaces: unknown[];
}
let server: Server;
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  toast.error.mockReset();
  server = { capabilities: ON, status: state('no mapping, offered'), runners: OWN, workspaces: WORKSPACES };
  apiMock.mockImplementation((async (path: string, options?: { method?: string }) => {
    if (path === '/auth/capabilities') {
      if (server.capabilities.httpStatus !== 200) throw new ApiError('Not Found', server.capabilities.httpStatus);
      return server.capabilities.body;
    }
    if (path === '/managed-runner' && !options?.method) return server.status;
    if (path === '/managed-runner/ensure' && options?.method === 'POST') {
      // The answer carries the runner and its default workspace, which the lists now hold.
      server.status = state('preparing: requested');
      server.runners = [...server.runners, MANAGED_RUNNER];
      return server.status;
    }
    if (path === '/runners') return server.runners;
    if (path === '/workspaces') return server.workspaces;
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
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
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

const machinesGroup = () =>
  container.querySelector('nav.settings-nav [role="group"][aria-label="Machines"]')!;
const machineRows = () => [...machinesGroup().querySelectorAll('a.settings-nav-row')];
const entryRow = () => machineRows().find((a) => a.getAttribute('href') === '/settings/machines/managed') ?? null;
const askedStatus = () => apiMock.mock.calls.some(([path, options]) => path === '/managed-runner' && !options?.method);
const ensures = () => apiMock.mock.calls.filter(([path]) => path === '/managed-runner/ensure');
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;
const dialog = () => document.querySelector('[role="dialog"], [role="alertdialog"]');
const rowOf = (runnerId: string) => machineRows().find((a) => a.getAttribute('href') === `/settings/machines/${runnerId}`)!;

describe('feature off: no entry, and GET /managed-runner is never read', () => {
  it.each(fixture.capabilities.filter((c) => !c.offered).map((c) => [c.name, c] as const))('%s', async (_name, cap) => {
    server.capabilities = cap;
    await visit('/settings/machines/new');
    expect(machineRows().map((a) => a.textContent)).toEqual(['workstation', 'laptop']);
    expect(entryRow()).toBeNull();
    expect(container.textContent).not.toContain(MANAGED_RUNNER_COPY.entry.register);
    // The Set up address itself has nothing to set up: Register a machine.
    await visit('/settings/machines/managed');
    expect(window.location.pathname).toBe('/settings/machines/new');
    expect(askedStatus()).toBe(false);
  });

  it('MANAGED_RUNNER_DISABLED with a mapping left: no entry, and the leftover runner shows by heartbeat', async () => {
    server.status = state('switched off with a mapping left from before');
    server.runners = [...OWN, MANAGED_RUNNER];
    await visit('/settings/general');
    expect(entryRow()).toBeNull();
    const row = rowOf(MANAGED);
    expect(row.querySelector('.settings-managed-state')).toBeNull();
    expect(row.querySelector('.settings-dot')?.getAttribute('aria-label')).toBe('Offline');
  });
});

describe('no mapping, and the server offers one', () => {
  it('puts Managed runner · Set up first in Machines, however many machines the account has', async () => {
    await visit('/settings/general');
    const rows = machineRows();
    expect(rows[0]).toBe(entryRow());
    expect(rows[0].querySelector('.settings-nav-label')?.textContent).toBe(MANAGED_RUNNER_COPY.entry.title);
    expect(rows[0].querySelector('.settings-nav-meta')?.textContent).toBe(MANAGED_RUNNER_COPY.entry.action);
    expect(rows.slice(1).map((a) => a.textContent)).toEqual(['workstation', 'laptop']);
  });

  it('Register a machine links to the Set up page', async () => {
    await visit('/settings/machines/new');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === MANAGED_RUNNER_COPY.entry.register);
    expect(link?.getAttribute('href')).toBe('/settings/machines/managed');
  });

  it('opens a page with the notice and the sentence; Set up confirms first, then ensures and lands on the runner', async () => {
    await visit('/settings/general');
    await click(entryRow());
    expect(window.location.pathname).toBe('/settings/machines/managed');
    const notice = container.querySelector('.managed-runner-notice')!;
    expect(notice.getAttribute('data-kind')).toBe('setup');
    expect(notice.textContent).toContain(MANAGED_RUNNER_COPY.title.setup);
    expect(container.textContent).toContain(MANAGED_RUNNER_COPY.entry.page);

    // Cancel: nothing is asked of the server.
    await click(button(notice, MANAGED_RUNNER_COPY.ensure));
    expect(dialog()?.textContent).toContain(MANAGED_RUNNER_COPY.confirm.title);
    expect(dialog()?.textContent).toContain(MANAGED_RUNNER_COPY.confirm.body);
    await click(button(dialog()!, MANAGED_RUNNER_COPY.confirm.cancel));
    expect(dialog()).toBeNull();
    expect(ensures()).toHaveLength(0);

    // Set up: one ensure, and the route is replaced by the runner's own machine page.
    const before = window.history.length;
    await click(button(container.querySelector('.managed-runner-notice')!, MANAGED_RUNNER_COPY.ensure));
    await click(button(dialog()!, MANAGED_RUNNER_COPY.confirm.confirm));
    expect(ensures()).toHaveLength(1);
    expect(window.location.pathname).toBe(`/settings/machines/${encodeId(MANAGED)}`);
    expect(window.history.length).toBe(before);
    // The entry is gone: the managed runner is one machine in the list, by its shared label.
    expect(entryRow()).toBeNull();
    expect(rowOf(MANAGED).querySelector('.settings-managed-state')?.textContent).toBe(MANAGED_RUNNER_COPY.short.preparing);
  });

  it('an account with no runner and no workspace sets up at one click', async () => {
    server.runners = [];
    server.workspaces = [];
    await visit('/settings/machines/managed');
    await click(button(container.querySelector('.managed-runner-notice')!, MANAGED_RUNNER_COPY.ensure));
    expect(dialog()).toBeNull();
    expect(ensures()).toHaveLength(1);
    expect(window.location.pathname).toBe(`/settings/machines/${encodeId(MANAGED)}`);
  });

  it("a refusal is the server's sentence in a toast, and the page stays", async () => {
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation((async (path: string, options?: { method?: string }) => {
      if (path === '/managed-runner/ensure') throw new ApiError('This account is not given a managed runner.', 403);
      return base(path, options as never);
    }) as typeof api);
    await visit('/settings/machines/managed');
    await click(button(container.querySelector('.managed-runner-notice')!, MANAGED_RUNNER_COPY.ensure));
    await click(button(dialog()!, MANAGED_RUNNER_COPY.confirm.confirm));
    expect(toast.error).toHaveBeenCalledWith("Couldn't set up the managed runner", 'This account is not given a managed runner.');
    expect(window.location.pathname).toBe('/settings/machines/managed');
  });
});

describe('no mapping, and the server gives none (D2): no row', () => {
  it.each(['no mapping, account not eligible', 'no mapping, environment unavailable'])('%s', async (name) => {
    server.status = state(name);
    await visit('/settings/general');
    expect(entryRow()).toBeNull();
    expect(machineRows().map((a) => a.textContent)).toEqual(['workstation', 'laptop']);
  });
});

describe('with a mapping, the managed runner is one machine row with the shared short label (D4)', () => {
  const mapped = fixture.states.filter((s) => s.status.runnerId && s.display && s.display.kind !== 'notOffered');
  it.each(mapped.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    server.status = s.status;
    server.runners = [...OWN, MANAGED_RUNNER];
    await visit('/settings/general');
    expect(entryRow()).toBeNull();
    const kind = s.display!.kind as ManagedRunnerRowKind;
    const managed = rowOf(MANAGED).querySelector('.settings-managed-state')!;
    expect(managed.getAttribute('data-kind')).toBe(kind);
    expect(managed.textContent).toBe(MANAGED_RUNNER_COPY.short[kind]);
    // Never the heartbeat's Online/Offline, which an asleep runner would read as.
    expect(rowOf(MANAGED).querySelector('[aria-label="Offline"], [aria-label="Online"]')).toBeNull();
    // The account's own machines keep their heartbeat dots.
    expect(rowOf(OWN[0].id).querySelector('.settings-dot')?.getAttribute('aria-label')).toBe('Online');
    // A mapped account's Set up address is the runner's page.
    await visit('/settings/machines/managed');
    expect(window.location.pathname).toBe(`/settings/machines/${encodeId(MANAGED)}`);
  });
});
