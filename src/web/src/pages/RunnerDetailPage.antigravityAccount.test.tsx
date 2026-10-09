// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A workspace picks which of its runner's Antigravity (Google) accounts its Antigravity sessions run
 * on, under the workspace form's Advanced — a third field beside Codex's and Claude's, shown once the
 * runner has two accounts. What the save sends is the account's id (`antigravityAccount`).
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const WORKSPACE_ID = '33zx0JhRhJo8rd25d3qAN';

const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.orbit/antigravity/google', auth: 'yes' };
const WORK: RunnerEngineAccount = {
  id: '5c2e91a0',
  name: 'Work',
  home: '/root/.orbit/antigravity-accounts/5c2e91a0',
  auth: 'yes',
};

/** agy's buckets for Default and Work, on the engine's own health: what is left of each. */
const antigravity = (accounts: RunnerEngineAccount[], over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'antigravity',
  installed: true,
  auth: 'yes',
  authSource: 'google',
  version: '1.3.0',
  accounts,
  planUsage: {
    provider: 'antigravity',
    buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.72 }],
    accounts: { [WORK.id]: { provider: 'antigravity', buckets: [{ id: 'gemini-5h', window: '5h', remainingFraction: 0.04 }] } },
  },
  ...over,
});

const runner = (engine: RunnerEngineHealth): Runner => ({
  id: RUNNER_ID,
  name: 'hpc',
  online: true,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }, engine],
});

const workspace = (antigravityAccount: string | null) => ({
  id: WORKSPACE_ID,
  name: 'orbit',
  runnerId: RUNNER_ID,
  workDir: '/srv/orbit',
  env: {},
  antigravityAccount,
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
    (el) => el.querySelector('.rd-form-label')?.textContent === 'Antigravity account',
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

describe('which Antigravity account a workspace runs on', () => {
  it('offers each Google account with what is left of its emptiest bucket, and saves the id picked', async () => {
    const { patches } = mount(runner(antigravity([DEFAULT, WORK])), workspace(null));
    await openAdvanced();
    expect(picker()?.textContent).toContain('Automatic');
    const offered = await options();
    expect(offered.map((o) => o.text)).toEqual([
      ['Automatic', 'each new session starts on the account whose quota resets soonest'],
      ['Default (~/.orbit/antigravity/google)', 'gemini-weekly 72% left · signed in'],
      ['Work', 'gemini-5h 4% left · signed in'],
    ]);
    await press(offered[2].el);
    await click(byText('button', 'Save'));
    expect(patches).toHaveLength(1);
    expect(patches[0].antigravityAccount).toBe(WORK.id);
  });

  it('says a Default on the runner’s Gemini key runs on that key', async () => {
    mount(
      runner(antigravity([{ ...DEFAULT, auth: 'no' }, WORK], { authSource: 'env_key' })),
      workspace(null),
    );
    await openAdvanced();
    const offered = await options();
    expect(offered[1].text).toEqual(['Default (~/.orbit/antigravity/google)', 'env key · runs on your Gemini key']);
  });

  it('asks nothing of a runner with one account, and keeps the choice it never showed', async () => {
    const { patches } = mount(runner(antigravity([DEFAULT])), workspace(null));
    await openAdvanced();
    expect(field()).toBeUndefined();
    await click(byText('button', 'Save'));
    expect(patches.at(-1)?.antigravityAccount).toBeNull();
  });
});
