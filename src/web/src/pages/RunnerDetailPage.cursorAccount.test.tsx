// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A workspace picks which of its runner's Cursor CLI accounts its Cursor CLI sessions run on, under the
 * workspace form's Advanced — beside the other engines', shown once the runner has two (P4a). What the
 * save sends is the account's id (`cursorAccount`), which dispatch hands the runner as that account's
 * directory (ORBIT_CURSOR_ACCOUNT_DIR). Each account says what Cursor reports of it: a share used only
 * above 0, and no number at all otherwise.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const WORKSPACE_ID = '33zx0JhRhJo8rd25d3qAN';

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' };
const TEAM: RunnerEngineAccount = { id: '5c2e91a0', name: 'Team', home: '/root/.orbit/cursor-accounts/5c2e91a0', auth: 'yes' };

const cursor = (accounts: RunnerEngineAccount[]): RunnerEngineHealth => ({
  engine: 'cursor',
  installed: true,
  auth: 'yes',
  version: '2026.10.14-941492e',
  accounts,
});

/** Default on the Free plan, which Cursor reports no share of; Team on Pro at 34%. */
const USAGE: PlanUsage = {
  cursor: {
    provider: 'cursor' as never,
    account: 'default',
    planName: 'Free',
    accounts: { [TEAM.id]: { provider: 'cursor' as never, planName: 'Pro', includedUsage: { percentUsed: 34 } } },
  },
};

const runner = (engine: RunnerEngineHealth): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  capabilities: ['provider:cursor', 'cursor-account-login/v1'],
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }, engine],
  planUsage: USAGE,
});

const workspace = (cursorAccount: string | null, env: Record<string, string> = {}) => ({
  id: WORKSPACE_ID,
  name: 'orbit',
  runnerId: RUNNER_ID,
  workDir: '/srv/orbit',
  env,
  cursorAccount,
  createdAt: '2026-09-23T08:00:00.000Z',
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
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
    if (path === '/sessions/counts') return [];
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
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/runners/:id" element={<RunnerDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return { patches };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const byText = (selector: string, text: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`no ${selector} reading "${text}"`);
  return found;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};
/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which a
 *  list option needs before it takes a click as a choice rather than a keyboard activation. */
const press = async (el: HTMLElement) => {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
};

async function openAdvanced() {
  await settle();
  await click(byText('.rd-workspace-name', 'orbit'));
  await click(document.body.querySelector<HTMLElement>('.rd-adv-toggle')!);
}

const field = () =>
  [...document.body.querySelectorAll<HTMLElement>('.rd-form-field')].find(
    (el) => el.querySelector('.rd-form-label')?.textContent === 'Cursor CLI account',
  );

/** The account picker, as its role names it. */
const picker = () => field()?.querySelector<HTMLElement>('[role="combobox"]');

/** Open the account dropdown and read its options: each account's name, then its own line. */
async function options() {
  await click(picker()!);
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((o) => {
    const status = o.querySelector('.rd-codex-account-status');
    return { el: o, text: [status?.previousElementSibling?.textContent, status?.textContent] };
  });
}

describe('which Cursor CLI account a workspace runs on', () => {
  it('offers each account with what Cursor reports of it, and saves the id picked', async () => {
    const { patches } = mount(runner(cursor([DEFAULT, TEAM])), workspace(null));
    await openAdvanced();
    expect(picker()?.textContent).toContain('Automatic');
    const offered = await options();
    expect(offered.map((o) => o.text)).toEqual([
      ['Automatic', 'each new session starts on the account whose quota resets soonest'],
      ['Default (~/.orbit/cursor/default)', 'Free plan · usage unavailable · signed in'],
      ['Team', 'Monthly limit 34% · signed in'],
    ]);
    // A conversation that has started stays on its account (D5): Automatic promises no move.
    expect(field()?.querySelector('.rd-path-hint')?.textContent).toBe(
      'Only applies to sessions that run Cursor CLI on this machine. Automatic starts each new session on the account whose quota resets soonest, so none of it goes unused.',
    );
    await press(offered[2].el);
    await click(byText('button', 'Save'));
    expect(patches).toHaveLength(1);
    expect(patches[0].cursorAccount).toBe(TEAM.id);
  });

  it('asks nothing of a runner with one account, and keeps the choice it never showed', async () => {
    const { patches } = mount(runner(cursor([DEFAULT])), workspace(null));
    await openAdvanced();
    expect(field()).toBeUndefined();
    await click(byText('button', 'Save'));
    expect(patches.at(-1)?.cursorAccount).toBeNull();
  });
});
