// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  MANAGED_RUNNER_COPY,
  managedRunnerRow,
  type ManagedRunnerRowKind,
  type ManagedRunnerStatus,
} from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every web place that shows the account's managed runner by its heartbeat shows its shared state instead
 * (docs/managed-runner-existing-account-entry-design.md D4, and the owner's 2026-11-14 ask to optimise the
 * sleep UI): its machine page's pill and notice, the sidebar's workspace row and rail, the move dialog's
 * workspace picker and New workspace's machine picker. Asleep is Asleep, never Offline. Any other runner is
 * unchanged, and with the feature off GET /managed-runner is never read.
 */

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
  getSessionMoveTargets: vi.fn(),
}));
const { api, ApiError, getSessionMoveTargets } = await import('../api');
const apiMock = vi.mocked(api);
const { MachineSettingsPage } = await import('./settings/MachineSettingsPage');
const { SettingsWorkspacePage } = await import('./settings/WorkspaceSettingsPage');
const { SessionMoveModal } = await import('./SessionMoveModal');
const { WorkspaceRow, WorkspaceStateMark } = await import('./TasksSidePanel');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as {
  capabilities: { name: string; httpStatus: number; body: unknown; offered: boolean }[];
  states: { name: string; display: { kind: string } | null; status: ManagedRunnerStatus }[];
};
const state = (name: string) => fixture.states.find((s) => s.name === name)!.status;
const ON = fixture.capabilities.find((c) => c.name === 'switched on')!;
const OFF = fixture.capabilities.find((c) => c.name === 'switched off')!;

const MANAGED = state('sleeping').runnerId!;
const OWN = '33zx0JhRhJo8rd25d3qAM';
const runner = (id: string, name: string, online: boolean) => ({
  id,
  name,
  online,
  maxConcurrent: 2,
  activeSessions: 0,
  enrolledAt: '2026-06-18T09:00:00Z',
  lastHeartbeatAt: '2026-11-14T08:00:00Z',
  engines: [{ engine: 'claude', installed: false, auth: 'no' }],
});

let server: { capabilities: { httpStatus: number; body: unknown }; status: ManagedRunnerStatus };
/** What GET /runners says of the managed runner beyond the basics: e.g. the version it reported. */
let managedReport: Record<string, unknown> = {};
/** The same for the account's own machine. */
let ownReport: Record<string, unknown> = {};
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  server = { capabilities: ON, status: state('sleeping') };
  managedReport = {};
  ownReport = {};
  apiMock.mockImplementation((async (path: string) => {
    if (path === '/auth/capabilities') {
      if (server.capabilities.httpStatus !== 200) throw new ApiError('Not Found', server.capabilities.httpStatus);
      return server.capabilities.body;
    }
    if (path === '/managed-runner') return server.status;
    if (path === '/runners') return [{ ...runner(OWN, 'workstation', false), ...ownReport }, { ...runner(MANAGED, 'managed', false), ...managedReport }];
    if (path === '/workspaces') return [];
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  host?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  apiMock.mockReset();
});

async function render(node: React.ReactNode, at = '/'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return host;
}

const askedStatus = () => apiMock.mock.calls.some(([path]) => path === '/managed-runner');
const machinePage = (id: string) =>
  render(
    <Routes>
      <Route path="/settings/machines/:id" element={<MachineSettingsPage />} />
    </Routes>,
    `/settings/machines/${id}`,
  );

describe("the managed runner's machine page", () => {
  const mapped = fixture.states.filter((s) => s.status.runnerId && s.display && s.display.kind !== 'notOffered');
  it.each(mapped.map((s) => [s.name, s] as const))('%s: the shared label on the pill, the notice on top', async (_n, s) => {
    server.status = s.status;
    const page = await machinePage(MANAGED);
    const kind = s.display!.kind as ManagedRunnerRowKind;
    expect(page.querySelector('[data-testid="machine-status"]')?.textContent).toBe(MANAGED_RUNNER_COPY.short[kind]);
    // Its heartbeat's offline card and Resources' Offline are not said beside it.
    expect(page.textContent).not.toContain('Never checked in');
    expect(page.querySelector('.machine-section-resources .machine-section-note')?.textContent).not.toBe('Offline');
    const notice = page.querySelector('.managed-runner-notice');
    if (kind === 'available') expect(notice).toBeNull();
    else {
      expect(notice?.getAttribute('data-kind')).toBe(kind);
      // At the top: straight after the page's head.
      expect(page.querySelector('.machine-head')?.nextElementSibling).toBe(notice);
    }
  });

  it('another machine keeps its heartbeat pill and no notice', async () => {
    const page = await machinePage(OWN);
    expect(page.querySelector('[data-testid="machine-status"]')?.textContent).toMatch(/Offline|Last seen/);
    expect(page.querySelector('.managed-runner-notice')).toBeNull();
  });

  const wakes = () => apiMock.mock.calls.filter(([path]) => path === '/managed-runner/wake');

  it('asleep while it waits for a login: opening its page wakes it, once, so it can be signed in', async () => {
    server.status = state('sleeping: waiting for a login');
    const page = await machinePage(MANAGED);
    expect(page.querySelector('.managed-runner-notice')?.getAttribute('data-kind')).toBe('sleeping');
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0][1]).toMatchObject({ method: 'POST', body: { idempotencyKey: expect.any(String) } });
  });

  it('asleep with a runtime signed in: opening its page leaves it asleep', async () => {
    server.status = state('sleeping');
    await machinePage(MANAGED);
    expect(wakes()).toHaveLength(0);
  });

  it('feature off: the managed runner shows by heartbeat, and its status is never read', async () => {
    server.capabilities = OFF;
    const page = await machinePage(MANAGED);
    expect(page.querySelector('[data-testid="machine-status"]')?.textContent).toMatch(/Offline|Last seen/);
    expect(page.querySelector('.managed-runner-notice')).toBeNull();
    expect(askedStatus()).toBe(false);
  });
});

describe('Orbit Cloud: the managed runner\'s name, version line and updates on its machine page', () => {
  const NO_SELFUPDATE = { state: 'disabledByEnv', reason: 'ORBIT_NO_SELFUPDATE is set' };
  const now = new Date().toISOString();
  const title = (page: HTMLElement) => page.querySelector('.machine-title')?.textContent;
  const metaline = (page: HTMLElement) => page.querySelector('.machine-metaline')?.textContent ?? '';
  const about = (page: HTMLElement) => page.querySelector('.machine-section-about')?.textContent ?? '';

  it('is headed Orbit Cloud, by being the managed runner — not by its stored name', async () => {
    server.status = state('available');
    managedReport = { name: 'something-else', version: '0.1.250', online: true, lastHeartbeatAt: now };
    const page = await machinePage(MANAGED);
    expect(title(page)).toBe('Orbit Cloud');
    // The account's own machine named like the server's managed runner is still its own name.
    ownReport = { name: 'orbit-cloud' };
    const own = await machinePage(OWN);
    expect(title(own)).toBe('orbit-cloud');
  });

  it('an owner-given name still wins', async () => {
    server.status = state('available');
    managedReport = { displayName: 'Team box', online: true };
    expect(title(await machinePage(MANAGED))).toBe('Team box');
  });

  it('a managed-<sha> image: "Build 95884b1" and the check-in, never the whole hash; no Updates are turned off', async () => {
    server.status = state('available');
    managedReport = {
      version: 'managed-95884b154feb3d4e2a575fb012c4185b20c282ac',
      online: true,
      lastHeartbeatAt: now,
      selfUpdate: NO_SELFUPDATE,
    };
    ownReport = { version: '0.1.260' };
    const page = await machinePage(MANAGED);
    expect(metaline(page)).toMatch(/^Build 95884b1 · Last Check-in /);
    expect(page.textContent).not.toContain('managed-95884');
    expect(about(page)).toContain('Build 95884b1');
    expect(page.textContent).not.toContain('Kept up to date by Orbit');
    expect(about(page)).not.toContain('Last Update');
    expect(page.textContent).not.toContain('Updates are turned off');
    expect(page.textContent).not.toContain('ORBIT_NO_SELFUPDATE');
  });

  it('a release behind the latest with ORBIT_NO_SELFUPDATE: its version, "Orbit moves it to each new build.", no card', async () => {
    server.status = state('available');
    managedReport = { version: '0.1.250', online: true, lastHeartbeatAt: now, selfUpdate: NO_SELFUPDATE };
    ownReport = { version: '0.1.260' };
    const page = await machinePage(MANAGED);
    expect(metaline(page)).toMatch(/^v0\.1\.250 · Last Check-in /);
    expect(about(page)).toContain('Orbit moves it to each new build.');
    expect(page.textContent).not.toContain('Updates are turned off');
    expect(page.textContent).not.toContain('ORBIT_NO_SELFUPDATE');
  });

  it('a self-hosted runner in the same state still gets the Updates are turned off card, unchanged', async () => {
    server.status = state('available');
    managedReport = { version: '0.1.260' };
    ownReport = { version: '0.1.250', online: true, lastHeartbeatAt: now, selfUpdate: NO_SELFUPDATE };
    const page = await machinePage(OWN);
    expect(title(page)).toBe('workstation');
    expect(metaline(page)).toMatch(/^v0\.1\.250 · Last Check-in /);
    expect(page.textContent).toContain('Updates are turned off');
    expect(page.textContent).toContain('remove ORBIT_NO_SELFUPDATE from the runner’s environment');
  });
});

describe("the managed runner's page before it first reports (owner, 2026-11-14: \"fix the preparing page\")", () => {
  const broken = /Update runner|predates|Not installed|Orbit can install it here|Sign in/;
  const waitingLines = (page: HTMLElement) =>
    [...page.querySelectorAll('.machine-managed-waiting')].map((line) => line.textContent);

  it.each(['preparing: requested', 'preparing: starting', 'waiting for capacity before the first start', 'failed: retryable'])(
    '%s, no version yet: banner and pill, one quiet line for Resources and Engines, no badges and no engine rows',
    async (name) => {
      server.status = state(name);
      const page = await machinePage(MANAGED);
      expect(page.querySelector('.managed-runner-notice')).not.toBeNull();
      expect(page.querySelector('[data-testid="machine-status"]')?.textContent).toBe(
        MANAGED_RUNNER_COPY.short[fixture.states.find((s) => s.name === name)!.display!.kind as ManagedRunnerRowKind],
      );
      expect(waitingLines(page)).toEqual(['Available once the runner is ready.', 'Available once the runner is ready.']);
      expect(page.querySelector('.machine-engines, .re-runner-card')).toBeNull();
      expect(page.textContent).not.toMatch(broken);
    },
  );

  it('READY with a version: the ordinary page, engine rows and Resources as today', async () => {
    server.status = state('available');
    managedReport = { version: '0.1.250', online: true };
    const page = await machinePage(MANAGED);
    expect(waitingLines(page)).toEqual([]);
    expect(page.querySelector('.machine-engines')).not.toBeNull();
    expect(page.querySelector('[data-testid="machine-status"]')?.textContent).toBe(MANAGED_RUNNER_COPY.short.available);
  });

  it('asleep after it had reported: the ordinary page under its Asleep pill', async () => {
    server.status = state('sleeping');
    managedReport = { version: '0.1.250' };
    const page = await machinePage(MANAGED);
    expect(waitingLines(page)).toEqual([]);
    expect(page.querySelector('.machine-engines')).not.toBeNull();
  });

  it('a normal runner without a version is unchanged: its Update runner badges and engine rows stay', async () => {
    server.status = state('preparing: requested');
    const page = await machinePage(OWN);
    expect(waitingLines(page)).toEqual([]);
    expect(page.querySelector('.machine-engines')).not.toBeNull();
    expect(page.textContent).toMatch(/predates/);
  });
});

describe('the sidebar: a workspace on the managed runner', () => {
  const workspace = { id: 'w1', name: 'managed', runnerId: MANAGED } as never;
  const row = (name: string) => managedRunnerRow(MANAGED, state(name))!;

  it.each([
    ['sleeping', 'sleeping'],
    ['waking: starting again', 'waking'],
    ['failed: retryable', 'failed'],
  ])('%s: its mark with the shared words, never the offline mark', async (name, kind) => {
    const page = await render(
      <>
        <WorkspaceRow
          workspace={workspace}
          runnerLabel="managed"
          active={false}
          offline={false}
          managed={row(name)}
          running={false}
          jobs={0}
          needsYou={0}
          onOpen={() => {}}
          menu={[]}
        />
        <div data-testid="rail">
          <WorkspaceStateMark compact offline={false} managed={row(name)} running={false} needsYou={0} runnerLabel="managed" />
        </div>
      </>,
    );
    const mark = page.querySelector('.tp-workspace-icon-managed')!;
    expect(mark.getAttribute('data-kind')).toBe(kind);
    expect(mark.getAttribute('aria-label')).toContain(MANAGED_RUNNER_COPY.short[kind as ManagedRunnerRowKind]);
    if (kind === 'sleeping') expect(mark.getAttribute('aria-label')).toContain(MANAGED_RUNNER_COPY.asleep.row);
    expect(page.querySelector('[data-testid="rail"] .tp-rail-managed')?.getAttribute('data-kind')).toBe(kind);
    expect(page.querySelector('.tp-workspace-icon-offline, .tp-rail-offline')).toBeNull();
    expect(page.innerHTML).not.toMatch(/is offline|Runner offline/);
  });

  it('ready: no mark at all', async () => {
    const page = await render(
      <WorkspaceRow workspace={workspace} runnerLabel="managed" active={false} offline={false}
        managed={row('available')} running={false} jobs={0} needsYou={0} onOpen={() => {}} menu={[]} />,
    );
    expect(page.querySelector('.tp-workspace-icon-managed')).toBeNull();
  });
});

describe('the pickers', () => {
  it("New workspace's machine picker: the managed runner reads Asleep, another offline machine Offline", async () => {
    const page = await render(
      <Routes>
        <Route path="/settings/workspaces/:id" element={<SettingsWorkspacePage />} />
      </Routes>,
      '/settings/workspaces/new',
    );
    const choice = (id: string) => page.querySelector(`[data-runner-id="${id}"]`)?.textContent ?? '';
    expect(choice(MANAGED)).toContain(MANAGED_RUNNER_COPY.short.sleeping);
    expect(choice(MANAGED)).not.toContain('Offline');
    expect(choice(OWN)).toContain('Offline');
  });

  it("the move dialog: the managed runner's workspace says Asleep, not Runner offline", async () => {
    vi.mocked(getSessionMoveTargets).mockResolvedValue({
      folders: [],
      targets: [
        { workspaceId: 'wM', name: 'managed', provider: 'claude', runnerId: MANAGED, runnerName: 'managed', runnerOnline: false,
          workDir: '/w', reason: null, conversation: 'rebuilt' },
        { workspaceId: 'wO', name: 'orbit', provider: 'claude', runnerId: OWN, runnerName: 'workstation', runnerOnline: false,
          workDir: '/o', reason: null, conversation: 'rebuilt' },
      ],
    } as never);
    await render(
      <SessionMoveModal open session={{ id: 's1', title: 'A session' }} workspace={{ id: 'wX', name: 'here' }} folders={[]} onClose={() => {}} />,
    );
    const pills = [...document.querySelectorAll('.move-dialog-pill')];
    const managedPill = pills.find((p) => p.getAttribute('data-managed-kind'));
    expect(managedPill?.textContent).toBe(MANAGED_RUNNER_COPY.short.sleeping);
    expect(pills.filter((p) => !p.getAttribute('data-managed-kind')).map((p) => p.textContent)).toEqual(['Runner offline']);
  });
});
