// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { RunnerEngines } from './RunnerEngines';
import { openRunnerCards } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

/**
 * DeepSeek Harness on a machine's card in Infrastructure's Machines
 * (docs/mocks/provider-engine-decoupling/web-1-infrastructure.html ②): a row of its own after
 * OpenCode, on every machine. Ready, it says it uses API keys — the account's DeepSeek keys, not a
 * sign-in on the machine. Otherwise it says why not, with the reason written under the row, and an
 * Install where installing (or reinstalling) is the fix.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a').
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

const dsh = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'dsh',
  installed: true,
  version: '0.2.0-rc.2',
  auth: 'unknown',
  dsh: {
    versionCompatible: true,
    credentialPresent: false,
    modelCatalogReadable: true,
    requestValidation: 'unknown',
    sandboxEnforcement: 'unknown',
  },
  ...over,
});

const runner = (over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  capabilities: ['provider:dsh'],
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.290' },
    { engine: 'opencode', installed: true, auth: 'yes', version: '1.18.35' },
    dsh(),
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: Array<{ method: string; path: string; body?: unknown }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

function mount(box: Runner) {
  sent = [];
  openRunnerCards([box]);
  apiMock.mockImplementation((async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path, body: options?.body });
      return {};
    }
    if (path === '/runners') return [box];
    return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
  }) as typeof api);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [box]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/infrastructure']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
const harness = (page: HTMLElement) => page.querySelector<HTMLElement>('.re-row[data-engine="dsh"]')!;
/** What the row says: its name, the line under it, its status, the hint under the row and its buttons. */
const said = (row: HTMLElement) => ({
  name: text(row.querySelector('.re-name')),
  meta: text(row.querySelector('.re-meta')),
  status: text(row.querySelector('.re-status')),
  tone: [...(row.querySelector('.re-status .orbit-badge')?.classList ?? [])].find((c) => c !== 'orbit-badge'),
  hint: text(row.querySelector('.re-login-note')),
  buttons: [...row.querySelectorAll('button')].map((button) => text(button)),
});

describe('DeepSeek Harness on a machine’s card', () => {
  it('comes after OpenCode, and on a machine that can run it says it uses API keys, with nothing to sign in', () => {
    const page = mount(runner());
    expect([...page.querySelectorAll<HTMLElement>('.re-row')].map((row) => row.dataset.engine)).toEqual([
      'claude',
      'codex',
      'antigravity',
      'kimi',
      'opencode',
      'dsh',
    ]);
    expect(said(harness(page))).toEqual({
      name: 'DeepSeek Harness',
      meta: '0.2.0-rc.2',
      status: 'Uses API keys',
      tone: 'orbit-badge-default',
      hint: null,
      buttons: [],
    });
    // No quota of the machine's to show: its sessions spend DeepSeek keys.
    expect(text(harness(page).querySelector('.re-quota'))).toBe('—');
  });

  it('is on a runner that predates DeepSeek Harness too, saying it updates itself', () => {
    const page = mount(runner({ capabilities: [], version: '0.1.198', engines: [{ engine: 'claude', installed: true, auth: 'yes' }] }));
    expect(said(harness(page))).toEqual({
      name: 'DeepSeek Harness',
      meta: null,
      status: 'Update runner',
      tone: 'orbit-badge-orange',
      hint: 'This runner predates DeepSeek Harness. It updates itself when no session is running on it.',
      buttons: [],
    });
  });

  it('offers to install it where it is missing, and installs it on that machine', async () => {
    const page = mount(runner({ engines: [dsh({ installed: false, version: undefined })] }));
    expect(said(harness(page))).toEqual({
      name: 'DeepSeek Harness',
      meta: 'Not installed — Orbit can install it here',
      status: 'Not installed',
      tone: 'orbit-badge-default',
      hint: null,
      buttons: ['Install'],
    });
    await act(async () => {
      harness(page).querySelector('button')!.click();
    });
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/install`, body: { engine: 'dsh' } }]);
  });

  it('says where it can’t run at all, under the row, with nothing to press', () => {
    const page = mount(runner({ engines: [dsh({ installed: false, version: undefined, installationError: 'DSH_PLATFORM_UNSUPPORTED: darwin' })] }));
    expect(said(harness(page))).toEqual({
      name: 'DeepSeek Harness',
      meta: null,
      status: 'Not supported here',
      tone: 'orbit-badge-default',
      hint: 'DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only.',
      buttons: [],
    });
  });

  it('offers to reinstall a version Orbit does not support', () => {
    const page = mount(runner({ engines: [dsh({ version: '0.1.0', dsh: { ...dsh().dsh!, versionCompatible: false } })] }));
    const row = said(harness(page));
    expect(row.status).toBe('Unsupported version');
    expect(row.buttons).toEqual(['Install']);
    expect(row.hint).toBe('This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Infrastructure.');
  });

  it('says an install is under way, and what a failed one said', () => {
    const relay = (over: Partial<RunnerInstallState>): RunnerInstallState => ({
      status: null, engine: 'dsh', command: null, message: null, mode: null, ...over,
    });
    const missing = [dsh({ installed: false, version: undefined })];
    let page = mount(runner({ engines: missing, install: relay({ status: 'installing' }) }));
    expect(said(harness(page))).toMatchObject({ meta: 'Not installed yet', status: 'Installing…', buttons: [] });
    act(() => root?.unmount());
    host?.remove();
    page = mount(runner({ engines: missing, install: relay({ status: 'failed', message: 'node 26 not found' }) }));
    expect(text(harness(page).querySelector('.re-panel.bad'))).toBe('node 26 not found');
    expect(said(harness(page)).buttons).toEqual(['Install']);
  });
});
