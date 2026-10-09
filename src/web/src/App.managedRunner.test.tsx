// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import type { ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedRunner } from './lib/managedRunner';

/**
 * Managed runners on the web's own routes (docs/managed-runner-design.md, "Server and three client
 * interfaces"), driven by the server state samples every client is rendered from.
 *
 * With the capability missing — a server from before it, its member absent, the switch off, a
 * contract this client does not know, a malformed answer — the default landing, the workspace a
 * person lands in, a self-managed runner's onboarding and the deep links go exactly where they went
 * before, and the managed status is never even read. With it on, an account with nothing to open is
 * shown its managed runner instead of the registration guide, and a managed workspace's console is
 * handed its runner's state (and only a managed runner's console is).
 *
 * Mounted under the real BrowserRouter, so what is checked is the address bar.
 */

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
  // A /sessions/<id> deep link resolves its runner from the session; getSession calls api.ts's own
  // fetch, so it is answered here.
  getSession: vi.fn(),
}));
const { api, ApiError, getSession } = await import('./api');
const apiMock = vi.mocked(api);

vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('./components/RunnerRegisterGuide', () => ({ RunnerRegisterGuide: () => <p>register a machine</p> }));
vi.mock('./pages/RunnerDetailPage', () => ({ RunnerDetailPage: () => <p>a machine’s page</p> }));
vi.mock('./pages/InfrastructurePage', () => ({ InfrastructurePage: () => <p>infrastructure</p> }));
// The console's own view, reduced to what WorkspaceConsole hands it: whose runner, and what managed state.
vi.mock('./components/WorkspaceView', () => ({
  WorkspaceView: ({ runner, managed }: { runner: { name: string }; managed?: ManagedRunner | null }) => (
    <p data-testid="console">
      {runner.name}|{managed?.display.kind ?? 'no managed state'}
    </p>
  ),
}));

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as {
  ids: { runner: string; workspace: string };
  capabilities: { name: string; httpStatus: number; body: unknown; offered: boolean }[];
  states: { name: string; status: ManagedRunnerStatus }[];
};
const state = (name: string) => fixture.states.find((c) => c.name === name)!.status;
const capability = (name: string) => fixture.capabilities.find((c) => c.name === name)!;

// The managed runner and its default workspace, as the status names them (public ids).
const MANAGED_RUNNER = state('sleeping').runnerId!;
const MANAGED_WORKSPACE = state('sleeping').workspaceId!;
const MAC = '33zx0JhRhJo8rd25d3qAM';
const HPC = '33zx0JhRhJo8rd25d3qAN';
const MAC_WORKSPACE = '33zx0JhRhJo8rd25d3qAP';
const SESSION = '33zx0JhRhJo8rd25d3qAQ';

const runner = (id: string, name: string, online: boolean) => ({ id, name, online, activeSessions: 0, maxConcurrent: 2 });
const workspace = (id: string, runnerId: string, createdAt: string, position: number | null = null) => ({
  id,
  name: id === MANAGED_WORKSPACE ? 'Default' : 'orbit',
  runnerId,
  createdAt,
  position,
});

interface Server {
  capabilities: { httpStatus: number; body: unknown };
  status?: ManagedRunnerStatus | 'error';
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
  apiMock.mockImplementation((async (path: string, options?: { method?: string }) => {
    if (path === '/auth/capabilities') {
      const { httpStatus, body } = server.capabilities;
      if (httpStatus !== 200) throw new ApiError('Not Found', httpStatus);
      return body;
    }
    if (path === '/managed-runner' && !options?.method) {
      if (!server.status || server.status === 'error') throw new ApiError('Internal Server Error', 500);
      return server.status;
    }
    if (path === '/managed-runner/ensure') return state('preparing: requested');
    if (path === '/runners') return server.runners;
    if (path === '/workspaces') return server.workspaces;
    throw new Error(`unexpected ${path}`);
  }) as typeof api);
  vi.mocked(getSession).mockImplementation((async (id: string) => {
    if (id === SESSION) return { id: SESSION, assignedRunnerId: MAC, workspace: { id: MAC_WORKSPACE } };
    throw new ApiError('Not Found', 404);
  }) as unknown as typeof getSession);
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
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const { App } = await import('./App');
const addressBar = () => window.location.pathname + window.location.search;
const asked = (path: string) => apiMock.mock.calls.some(([called]) => called === path);
const consoleShows = () => container.querySelector('[data-testid="console"]')?.textContent ?? null;

/** Where an account lands, for each runner/workspace shape the default landing knows. */
const LANDINGS = [
  { label: 'no runner and no workspace: the registration guide', runners: [], workspaces: [], lands: '/runners/register', shows: 'register a machine' },
  { label: 'one runner, no workspace: that runner’s page', runners: [runner(MAC, 'Mac', true)], workspaces: [], lands: `/runners/${MAC}`, shows: 'a machine’s page' },
  {
    label: 'several runners, no workspace: Infrastructure',
    runners: [runner(MAC, 'Mac', true), runner(HPC, 'HPC', false)],
    workspaces: [],
    lands: '/infrastructure',
    shows: 'infrastructure',
  },
  {
    label: 'a workspace: its console',
    runners: [runner(MAC, 'Mac', false)],
    workspaces: [workspace(MAC_WORKSPACE, MAC, '2026-09-01T00:00:00Z', 0)],
    lands: `/workspaces/${MAC_WORKSPACE}`,
    shows: 'Mac|no managed state',
  },
];

describe('without the capability, every landing and deep link is what it was', () => {
  const missing = fixture.capabilities.filter(({ offered }) => !offered);

  it('the fixture holds every way the capability can be missing', () => {
    expect(missing.map(({ name }) => name)).toEqual([
      'a server from before the feature',
      'no managedRunners member',
      'switched off',
      'a contract this client does not know',
      'malformed',
    ]);
  });

  for (const cap of missing) {
    for (const landing of LANDINGS) {
      it(`${cap.name} — ${landing.label}`, async () => {
        server = { capabilities: cap, status: state('sleeping'), runners: landing.runners, workspaces: landing.workspaces };
        await visit('/');
        expect(addressBar()).toBe(landing.lands);
        expect(container.textContent).toContain(landing.shows);
        expect(asked('/managed-runner')).toBe(false);
        expect(container.querySelector('.managed-runner-notice')).toBeNull();
      });
    }

    it(`${cap.name} — deep links open their console and nothing managed`, async () => {
      server = {
        capabilities: cap,
        status: state('sleeping'),
        runners: [runner(MAC, 'Mac', true), runner(MANAGED_RUNNER, 'Managed runner', false)],
        workspaces: [workspace(MAC_WORKSPACE, MAC, '2026-09-01T00:00:00Z', 0), workspace(MANAGED_WORKSPACE, MANAGED_RUNNER, '2026-10-09T00:00:00Z')],
      };
      await visit(`/sessions/${SESSION}`);
      expect(addressBar()).toBe(`/sessions/${SESSION}`);
      expect(consoleShows()).toBe('Mac|no managed state');

      await act(async () => root!.unmount());
      root = null;
      container.remove();
      await visit(`/workspaces/${MANAGED_WORKSPACE}`);
      expect(addressBar()).toBe(`/workspaces/${MANAGED_WORKSPACE}`);
      expect(consoleShows()).toBe('Managed runner|no managed state');
      expect(asked('/managed-runner')).toBe(false);
    });
  }
});

describe('with the capability switched on', () => {
  const on = capability('switched on');

  it('an account with nothing to open is offered Set up, with the registration guide a link away', async () => {
    server = { capabilities: on, status: state('no mapping, offered'), runners: [], workspaces: [] };
    await visit('/');
    expect(addressBar()).toBe('/');
    expect(container.querySelector('.managed-runner-notice-title')?.textContent).toBe('Set up a managed runner');
    const register = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Register your own machine');
    expect(register?.getAttribute('href')).toBe('/runners/register');

    const setUp = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Set up')!;
    await act(async () => setUp.click());
    expect(apiMock.mock.calls.some(([path, options]) => path === '/managed-runner/ensure' && (options as { method?: string })?.method === 'POST')).toBe(true);
    await vi.waitFor(() => expect(container.querySelector('.managed-runner-notice-title')?.textContent).toBe('Preparing your managed runner'));
  });

  it('an account the server gives none to is told why, and keeps the registration guide', async () => {
    server = { capabilities: on, status: state('no mapping, account not eligible'), runners: [], workspaces: [] };
    await visit('/');
    expect(container.querySelector('.managed-runner-notice-detail')?.textContent).toBe(
      state('no mapping, account not eligible').reason!.message,
    );
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Set up')).toBe(false);
    expect([...container.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/runners/register')).toBe(true);
  });

  it('a status that cannot be read is no managed UI: the landing goes where it always went', async () => {
    server = { capabilities: on, status: 'error', runners: [], workspaces: [] };
    await visit('/');
    // One retry of the read, then the landing it always had: a wait with an end, never a spinner.
    await vi.waitFor(() => expect(addressBar()).toBe('/runners/register'), { timeout: 5_000 });
  });

  it('lands in the sleeping managed workspace, not in registration, and hands its console the state', async () => {
    server = {
      capabilities: on,
      status: state('sleeping'),
      runners: [runner(MANAGED_RUNNER, 'Managed runner', false)],
      workspaces: [workspace(MANAGED_WORKSPACE, MANAGED_RUNNER, '2026-10-09T00:00:00Z')],
    };
    await visit('/');
    expect(addressBar()).toBe(`/workspaces/${MANAGED_WORKSPACE}`);
    await vi.waitFor(() => expect(consoleShows()).toBe('Managed runner|sleeping'));
    expect(container.textContent).not.toContain('register a machine');
  });

  it('keeps the workspace a person already had first, and hands no managed state to a self-managed console', async () => {
    server = {
      capabilities: on,
      status: state('failed: retryable'),
      runners: [runner(MAC, 'Mac', true), runner(MANAGED_RUNNER, 'Managed runner', false)],
      workspaces: [workspace(MAC_WORKSPACE, MAC, '2026-09-01T00:00:00Z', 0), workspace(MANAGED_WORKSPACE, MANAGED_RUNNER, '2026-10-09T00:00:00Z')],
    };
    await visit('/');
    expect(addressBar()).toBe(`/workspaces/${MAC_WORKSPACE}`);
    expect(consoleShows()).toBe('Mac|no managed state');
  });

  it('a deep link into the managed workspace opens it with its state; one into a session elsewhere is untouched', async () => {
    server = {
      capabilities: on,
      status: state('waking: starting again'),
      runners: [runner(MAC, 'Mac', true), runner(MANAGED_RUNNER, 'Managed runner', false)],
      workspaces: [workspace(MAC_WORKSPACE, MAC, '2026-09-01T00:00:00Z', 0), workspace(MANAGED_WORKSPACE, MANAGED_RUNNER, '2026-10-09T00:00:00Z')],
    };
    await visit(`/workspaces/${MANAGED_WORKSPACE}`);
    expect(addressBar()).toBe(`/workspaces/${MANAGED_WORKSPACE}`);
    await vi.waitFor(() => expect(consoleShows()).toBe('Managed runner|waking'));

    await act(async () => root!.unmount());
    root = null;
    container.remove();
    await visit(`/sessions/${SESSION}`);
    expect(addressBar()).toBe(`/sessions/${SESSION}`);
    expect(consoleShows()).toBe('Mac|no managed state');
  });
});
