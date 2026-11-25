// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ManagedRunnerStatus, ManagedRunnerUpdate } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Orbit Cloud's Update card on its machine page (docs/managed-runner-update-now-design.md, boards 2 to 4):
 * driven by the managed status's `update`, with Update Now… for the owner, a confirmation that names the turns
 * and background jobs a busy runner would lose, then Restarting and Updated.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);
const { MachineSettingsPage } = await import('./settings/MachineSettingsPage');
const { SettingsLayout } = await import('./settings/SettingsLayout');
const { ToastViewport } = await import('./ToastViewport');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as { capabilities: { name: string; body: unknown }[]; states: { name: string; status: ManagedRunnerStatus }[] };
const READY = fixture.states.find((s) => s.name === 'available')!.status;
const ON = fixture.capabilities.find((c) => c.name === 'switched on')!.body;
const MANAGED = READY.runnerId!;
const OWN = '33zx0JhRhJo8rd25d3qAM';

const AVAILABLE: ManagedRunnerUpdate = {
  running: { sha: '95884b154feb3d4e2a575fb012c4185b20c282ac', builtAt: '2026-11-16T10:00:00Z' },
  current: { sha: 'e03e2cd0000000000000000000000000000000aa', builtAt: '2026-11-18T10:00:00Z' },
  phase: 'available',
};
const BUSY = {
  code: 'MANAGED_RUNNER_BUSY',
  turns: [
    { sessionId: 's1', title: 'Fix login redirect', startedAt: new Date(Date.now() - 18 * 60_000).toISOString() },
    { sessionId: 's2', title: 'Backfill shard rows', startedAt: new Date(Date.now() - 64 * 60_000).toISOString() },
  ],
  backgroundJobs: 3,
};

let status: ManagedRunnerStatus;
let activeSessions = 0;
let managedVersion = 'managed-95884b154feb3d4e2a575fb012c4185b20c282ac';
/** What POST /managed-runner/update-now answers to each body; a busy runner refuses a plain press. */
let busy = false;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const runner = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, online: true, maxConcurrent: 4, activeSessions, enrolledAt: '2026-06-18T09:00:00Z',
  lastHeartbeatAt: new Date().toISOString(), engines: [], ...extra,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  busy = false;
  activeSessions = 0;
  managedVersion = 'managed-95884b154feb3d4e2a575fb012c4185b20c282ac';
  status = { ...READY, update: AVAILABLE };
  apiMock.mockImplementation((async (path: string, options?: { body?: { interruptTurns?: boolean } }) => {
    if (path === '/auth/capabilities') return ON;
    if (path === '/managed-runner') return status;
    if (path === '/managed-runner/update-now') {
      if (busy && !options?.body?.interruptTurns) throw new ApiError('busy', 409, 'MANAGED_RUNNER_BUSY', BUSY);
      // Accepted: from now on the server's status says updating, as the real one does until the next generation.
      status = { ...status, update: { ...status.update!, phase: 'updating' } };
      return status;
    }
    if (path === '/runners') {
      return [
        runner(OWN, 'workstation', { version: '0.1.260' }),
        runner(MANAGED, 'managed', { version: managedVersion }),
      ];
    }
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
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

async function settle() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function render(node: React.ReactNode, at: string): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[at]}>{node}<ToastViewport /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return host;
}
const page = (id: string) =>
  render(<Routes><Route path="/settings/machines/:id" element={<MachineSettingsPage />} /></Routes>, `/settings/machines/${id}`);
const card = (p: HTMLElement) => p.querySelector('[data-testid="managed-update-card"]');
const updateNowButton = (p: HTMLElement) => p.querySelector<HTMLButtonElement>('.runner-update-now-button');
const dialog = () => document.body.querySelector('[role="dialog"], [role="alertdialog"]');
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const posts = () => apiMock.mock.calls.filter(([path]) => path === '/managed-runner/update-now');
async function click(el: Element | undefined | null) {
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
}

describe("Orbit Cloud's Update card", () => {
  it('available: title, body and Update Now…, and the version line names the running build', async () => {
    const p = await page(MANAGED);
    expect(card(p)?.getAttribute('data-phase')).toBe('available');
    expect(card(p)?.textContent).toContain('The Nov 18 build is available');
    expect(card(p)?.textContent).toContain('Available');
    expect(card(p)?.textContent).toContain('It moves the next time this runner is idle');
    expect(updateNowButton(p)?.textContent).toBe('Update Now…');
    const about = p.querySelector('.machine-section-about')?.textContent ?? '';
    expect(about).toContain('Build 95884b1 · Nov 16');
    expect(p.textContent).not.toContain('Kept up to date by Orbit');
    expect(p.textContent).not.toContain('Orbit updates this machine for you.');
    expect(p.textContent).not.toContain('Later');
  });

  it('release versions: the card, the confirmation and the version line use the version, as self-managed runners do', async () => {
    status = {
      ...READY,
      update: {
        running: { sha: '', version: '0.1.261-beta.82' },
        current: { sha: 'e03e2cd0000000000000000000000000000000aa', version: '0.1.261-beta.83', builtAt: '2026-11-18T10:00:00Z' },
        phase: 'available',
      },
    };
    managedVersion = '0.1.261-beta.82';
    const p = await page(MANAGED);
    expect(card(p)?.textContent).toContain('0.1.261-beta.83 is available');
    expect(card(p)?.textContent).not.toContain('build is available');
    expect(p.textContent).toContain('0.1.261-beta.82');
    expect(p.textContent).not.toContain('Build ');
    expect(p.textContent).not.toContain('Kept up to date by Orbit');
    await click(updateNowButton(p));
    expect(dialog()?.textContent).toContain('It restarts on 0.1.261-beta.83');
    await click(buttonNamed('Update Now'));
    status = { ...status, update: { ...status.update!, phase: 'updating' } };
    const again = await page(MANAGED);
    expect(card(again)?.textContent).toContain('Restarting on 0.1.261-beta.83');
  });

  it('an update without a version keeps the build wording', async () => {
    status = { ...READY, update: { ...AVAILABLE, current: { ...AVAILABLE.current } } };
    const p = await page(MANAGED);
    expect(card(p)?.textContent).toContain('The Nov 18 build is available');
    expect(p.querySelector('.machine-section-about')?.textContent).toContain('Build 95884b1 · Nov 16');
  });

  it('nothing running: asks first, then Update Now sends a plain press and the card turns to Restarting', async () => {
    const p = await page(MANAGED);
    await click(updateNowButton(p));
    expect(dialog()?.textContent).toContain('Update Orbit Cloud now?');
    expect(dialog()?.textContent).toContain('No turn is running. It restarts on the Nov 18 build');
    expect(buttonNamed('Update Now')).toBeTruthy();
    await click(buttonNamed('Update Now'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', body: { interruptTurns: false } });
    status = { ...READY, update: { ...AVAILABLE, phase: 'updating' } };
    const again = await page(MANAGED);
    expect(card(again)?.getAttribute('data-phase')).toBe('restarting');
    expect(card(again)?.textContent).toContain('Restarting on the Nov 18 build');
    expect(card(again)?.textContent).toContain('Usually under a minute.');
    expect(updateNowButton(again)).toBeNull();
  });

  it('busy: the 409 turns and background jobs are listed, and the red button sends interruptTurns:true', async () => {
    busy = true;
    activeSessions = 2;
    const p = await page(MANAGED);
    await click(updateNowButton(p));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1]).toMatchObject({ body: { interruptTurns: false } });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('It stops these turns and restarts on the Nov 18 build');
    expect(text).toContain('Fix login redirect');
    expect(text).toContain('running 18 min');
    expect(text).toContain('Backfill shard rows');
    expect(text).toContain('running 1 h 4 min');
    expect(text).toContain('3 background jobs in these sessions stop, and so do the services they started.');
    const red = buttonNamed('Interrupt 2 Turns and Update');
    expect(red?.className).toContain('orbit-button-danger');
    await click(red);
    expect(posts()).toHaveLength(2);
    expect(posts()[1][1]).toMatchObject({ body: { interruptTurns: true } });
    // The server's answer says updating at once, and the press is remembered, so Restarting says what it interrupted.
    expect(card(p)?.getAttribute('data-phase')).toBe('restarting');
    expect(card(p)?.textContent).toContain('2 interrupted turns continue once it is back.');
    status = { ...READY, update: { ...AVAILABLE, phase: 'updating' } };
    const after = await page(MANAGED);
    expect(card(after)?.textContent).toContain('2 interrupted turns continue once it is back.');
  });

  it('a refused Update Now never shows Restarting', async () => {
    busy = true;
    activeSessions = 2;
    const p = await page(MANAGED);
    await click(updateNowButton(p));
    // The server refuses the interrupting press (a conflict), so nothing is restarting.
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/auth/capabilities') return ON;
      if (path === '/managed-runner') return status;
      if (path === '/managed-runner/update-now') throw new ApiError('conflict', 409, 'MANAGED_RUNNER_REVISION_CONFLICT', {});
      if (path === '/runners') return [runner(MANAGED, 'managed', { version: 'managed-95884b154feb3d4e2a575fb012c4185b20c282ac' })];
      return [];
    }) as typeof api);
    await click(buttonNamed('Interrupt 2 Turns and Update'));
    expect(card(p)?.getAttribute('data-phase')).toBe('available');
    expect(localStorage.getItem(`orbit.managedUpdate.pending.${MANAGED}`)).toBeNull();
    const again = await page(MANAGED);
    expect(card(again)?.getAttribute('data-phase')).toBe('available');
  });

  it('an Update Now that ended unwatched before a newer build came out does not read Restarting (production, 2026-11-23)', async () => {
    // Pressed for the previous build, with one turn interrupted; nobody looked while it finished, and the server now
    // offers a newer build. The server says available, so the card does, and the old note goes.
    const pending = `orbit.managedUpdate.pending.${MANAGED}`;
    localStorage.setItem(pending, JSON.stringify({ at: Date.now() - 3 * 3_600_000, interruptedTurns: 1, to: AVAILABLE.running }));
    const p = await page(MANAGED);
    expect(card(p)?.getAttribute('data-phase')).toBe('available');
    expect(card(p)?.textContent).not.toContain('Restarting');
    expect(card(p)?.textContent).not.toContain('interrupted turn');
    expect(updateNowButton(p)).toBeTruthy();
    expect(localStorage.getItem(pending)).toBeNull();
    expect(localStorage.getItem(`orbit.managedUpdate.updated.${MANAGED}`)).toBeNull();
  });

  it('a busy answer found after the first dialog still lists the turns', async () => {
    busy = true;
    const p = await page(MANAGED);
    await click(updateNowButton(p));
    await click(buttonNamed('Update Now'));
    expect(dialog()?.textContent).toContain('Backfill shard rows');
    expect(buttonNamed('Interrupt 2 Turns and Update')).toBeTruthy();
  });

  it('restarting: the status says updating', async () => {
    status = { ...READY, update: { ...AVAILABLE, phase: 'updating' } };
    const p = await page(MANAGED);
    expect(card(p)?.getAttribute('data-phase')).toBe('restarting');
    expect(card(p)?.textContent).toContain('Restarting');
    expect(updateNowButton(p)).toBeNull();
  });

  it('updated: the runner is back on the current build — shown for a day, then gone', async () => {
    busy = true;
    activeSessions = 1;
    const p = await page(MANAGED);
    await click(updateNowButton(p));
    await click(buttonNamed('Interrupt 2 Turns and Update'));
    // Back: READY, no `update`, now running the current build.
    status = { ...READY };
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/auth/capabilities') return ON;
      if (path === '/managed-runner') return status;
      if (path === '/runners') return [runner(MANAGED, 'managed', { version: 'managed-e03e2cd0000000000000000000000000000000aa' })];
      return [];
    }) as typeof api);
    const back = await page(MANAGED);
    expect(card(back)?.getAttribute('data-phase')).toBe('updated');
    expect(card(back)?.textContent).toContain('Updated to the Nov 18 build');
    expect(card(back)?.textContent).toContain('2 interrupted turns resumed.');
    expect(back.querySelector('.machine-section-about')?.textContent).toContain('Build e03e2cd · Nov 18');
    // A day later it is only About's line.
    const key = `orbit.managedUpdate.updated.${MANAGED}`;
    const kept = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...kept, at: Date.now() - 25 * 3_600_000 }));
    await act(async () => root!.unmount());
    root = null;
    const later = await page(MANAGED);
    expect(card(later)).toBeNull();
  });

  it('current: no update, no card, no button', async () => {
    status = { ...READY };
    const p = await page(MANAGED);
    expect(card(p)).toBeNull();
    expect(updateNowButton(p)).toBeNull();
  });

  it('not the owner: a machine that is not the viewer\'s own Orbit Cloud has no card and no button', async () => {
    const p = await page(OWN);
    expect(card(p)).toBeNull();
    expect(updateNowButton(p)).toBeNull();
  });

  it("the machine row carries the update dot while a newer build waits", async () => {
    const layout = await render(
      <Routes><Route path="/settings/*" element={<SettingsLayout />} /></Routes>,
      '/settings/machines',
    );
    const row = layout.querySelector('.settings-nav-cloud .settings-managed-state');
    expect(row?.hasAttribute('data-update')).toBe(true);
    expect(row?.textContent).toBe('Update');
    expect(row?.querySelector('.settings-dot--update')).toBeTruthy();
    status = { ...READY };
    await act(async () => root!.unmount());
    root = null;
    const quiet = await render(
      <Routes><Route path="/settings/*" element={<SettingsLayout />} /></Routes>,
      '/settings/machines',
    );
    expect(quiet.querySelector('.settings-nav-cloud [data-update]')).toBeNull();
  });
});
