// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A workspace picks which of its runner's Codex accounts its Codex sessions run on, under the
 * workspace form's Advanced. Mounted as the page is, so each claim is about what a person does:
 * open the workspace, open Advanced, pick an account, save — and what the save sends is the
 * account's id, which is all the control plane stores.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// Public ids, the spelling the web holds every id in (= uuidToBase62 of a v7 uuid).
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const WORKSPACE_ID = '33zx0JhRhJo8rd25d3qAN';

const DEFAULT: RunnerEngineAccount = { id: 'default', codexHome: '/root/.codex', auth: 'yes' };
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  codexHome: '/root/.orbit/codex-accounts/3fa91c2e',
  auth: 'yes',
};

const codex = (accounts?: RunnerEngineAccount[]): RunnerEngineHealth => ({
  engine: 'codex',
  installed: true,
  auth: 'yes',
  version: '0.156.0',
  ...(accounts ? { accounts } : {}),
});

const runner = (accounts?: RunnerEngineAccount[]): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  // Default's 5h window: the runner's usage probe reads Default.
  planUsage: { provider: 'codex', primary: { utilization: 62, windowDurationMins: 300 } } as PlanUsage,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }, codex(accounts)],
});

const workspace = (codexAccount: string | null, env: Record<string, string> = {}) => ({
  id: WORKSPACE_ID,
  name: 'orbit',
  runnerId: RUNNER_ID,
  workDir: '/srv/orbit',
  env,
  codexAccount,
  createdAt: '2026-09-23T08:00:00.000Z',
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // antd's Select measures its box, and jsdom ships no layout to measure: nothing asserted here
  // depends on one.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
});

/** The runner's page, over one workspace. Every PATCH the page sends is collected. */
function mount(r: Runner, ws: ReturnType<typeof workspace>) {
  const patches: Array<Record<string, unknown>> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method === 'PATCH' && path === `/workspaces/${WORKSPACE_ID}`) {
      patches.push(options?.body as Record<string, unknown>);
      return { ...ws, ...(options?.body as object) };
    }
    if (path === '/runners') return [r];
    if (path === '/workspaces') return [ws];
    if (path === '/providers') return [];
    if (path === '/users/me') return { id: 'u', email: 'u@example.invalid', name: 'u', createdAt: '', preferences: {} };
    if (path.includes('permission-rules')) return [];
    if (path.includes('imported')) return { count: 0 };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [r]);
  qc.setQueryData(['workspaces'], [ws]);
  qc.setQueryData(['providers'], []);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
            <Routes>
              <Route path="/runners/:id" element={<RunnerDetailPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>,
    ),
  );
  return { patches };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const byText = (selector: string, text: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find(
    (el) => el.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no ${selector} reading "${text}"`);
  return found;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};

/** Open the workspace's editor. */
async function openEditor() {
  await settle();
  await click(byText('.rd-workspace-name', 'orbit'));
}

/** Open the workspace's editor and its Advanced part. */
async function openAdvanced() {
  await openEditor();
  await click(document.body.querySelector<HTMLElement>('.rd-adv-toggle')!);
}

const field = () =>
  [...document.body.querySelectorAll<HTMLElement>('.rd-form-field')].find(
    (el) => el.querySelector('.rd-form-label')?.textContent === 'Codex account',
  );

/** Open the account dropdown and read its options: each account's name, then its own line. */
async function options() {
  await act(async () => {
    field()!
      .querySelector('.ant-select-content')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
  return [...document.body.querySelectorAll<HTMLElement>('.ant-select-item-option')].map((o) => ({
    el: o,
    text: [...o.querySelectorAll('.ant-select-item-option-content > div > div')].map((d) => d.textContent),
  }));
}

describe('which Codex account a workspace runs on', () => {
  it('offers each account on the runner with its own quota and sign-in, and saves the id picked', async () => {
    const { patches } = mount(runner([DEFAULT, WORK]), workspace(null));
    await openAdvanced();
    // Nothing picked reads as Default.
    expect(field()?.querySelector('.ant-select')?.textContent).toContain('Default (~/.codex)');

    const offered = await options();
    expect(offered.map((o) => o.text)).toEqual([
      ['Default (~/.codex)', '5h limit 62% · signed in'],
      // Only Default has a quota reported: the usage probe reads Default.
      ['Work', 'signed in'],
    ]);
    await click(offered[1].el);
    await click(byText('button', 'Save'));
    expect(patches).toHaveLength(1);
    expect(patches[0].codexAccount).toBe(WORK.id);
  });

  it('saves Default as no account at all', async () => {
    const { patches } = mount(runner([DEFAULT, WORK]), workspace(WORK.id));
    await openEditor();
    // Folded, the disclosure still says something is set behind it.
    expect(document.body.querySelector('.rd-adv-badge')?.textContent).toBe('1 configured');
    await click(document.body.querySelector<HTMLElement>('.rd-adv-toggle')!);
    expect(field()?.querySelector('.ant-select')?.textContent).toContain('Work');
    const offered = await options();
    await click(offered[0].el);
    await click(byText('button', 'Save'));
    expect(patches[0].codexAccount).toBeNull();
  });

  it('asks nothing of a runner with one account, and keeps the choice it never showed', async () => {
    for (const accounts of [[DEFAULT], undefined]) {
      const { patches } = mount(runner(accounts), workspace(null));
      await openAdvanced();
      expect(field()).toBeUndefined();
      await click(byText('button', 'Save'));
      expect(patches.at(-1)?.codexAccount).toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = host = null;
    }
  });

  it('says so when the account a workspace names is not on its runner, and lets it be undone', async () => {
    const { patches } = mount(runner([DEFAULT]), workspace('5e6f7a8b'));
    await openAdvanced();
    const offered = await options();
    expect(offered.map((o) => o.text)).toEqual([
      ['Default (~/.codex)', '5h limit 62% · signed in'],
      ['Account 5e6f7a8b', 'not on this runner — sessions run on Default'],
    ]);
    await click(offered[0].el);
    await click(byText('button', 'Save'));
    expect(patches[0].codexAccount).toBeNull();
  });

  it('does not claim Default while a CODEX_HOME typed into the env points elsewhere', async () => {
    mount(runner([DEFAULT, WORK]), workspace(null, { CODEX_HOME: '/root/.codex-b' }));
    await openAdvanced();
    expect(field()?.textContent).toContain('sessions run in ~/.codex-b, not Default');
  });
});
