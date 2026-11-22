// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../TasksSidePanel';
import { meQuery, type UserPreferences } from '../../lib/queries';
import { SettingsWorkspacePage } from './WorkspaceSettingsPage';

/**
 * The SubAgents group on the Agent's settings (docs/subagent-design.md §7, board docs/mocks/subagent/05.png, and the
 * Workflows row of board docs/mocks/subagent-workflow part 5): the switches and Running at once each saved on the
 * workspace with its own PATCH, and the Providers block list saved to the account's preferences. Optimize For is not
 * here: it is the account's, on Settings → General. Harness as WorkspaceSettingsPage.modelRouting.test.tsx.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);

// Public ids, the spelling the web holds every id in (= uuidToBase62 of a v7 uuid).
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const WORKSPACE_ID = '33zx0JhRhJo8rd25d3qAN';

const RUNNER: Runner = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
  modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] },
  runtimeDefaultModels: { claude: 'claude-opus-5-5' },
};

const workspace = (over: Record<string, unknown> = {}) => ({
  id: WORKSPACE_ID,
  name: 'orbit',
  runnerId: RUNNER_ID,
  workDir: '/root/orbit',
  enableWorktree: true,
  lastProvider: 'claude',
  createdAt: '2026-09-23T08:00:00.000Z',
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

/** The runner's page over one workspace, for an account with smart selection on unless `preferences`
 *  says otherwise. Every PATCH and POST the page sends is collected. */
function mount(
  ws: ReturnType<typeof workspace>,
  preferences: UserPreferences = { modelRouting: true },
  providers: unknown[] = [],
  runner: Runner = RUNNER,
) {
  const me = { id: 'u', email: 'u@example.invalid', name: 'u', createdAt: '', preferences };
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method === 'PATCH' || method === 'POST') {
      writes.push({ method, path, body: options?.body as Record<string, unknown> });
      if (path === '/users/me/preferences') return { ...me, preferences: { ...me.preferences, ...(options?.body as object) } };
      ws = { ...ws, ...(options?.body as object) };
      return ws;
    }
    if (path === '/runners') return [runner];
    if (path === '/workspaces') return [ws];
    if (path === '/providers') return providers;
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return me;
    if (path === '/providers/subagent-tiers') return TIERS;
    if (path.includes('permission-rules')) return [];
    if (path.includes('imported')) return { count: 0 };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [runner]);
  qc.setQueryData(['workspaces'], [ws]);
  qc.setQueryData(['providers'], providers);
  qc.setQueryData(meQuery().queryKey, me);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/settings/workspaces/${WORKSPACE_ID}`]}>
          <Routes>
            <Route path="/settings/workspaces/:id" element={<SettingsWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return { writes };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};
const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** The workspace's page, drawn: every row shows without anything to open. */
async function openEditor() {
  await settle();
  await settle();
}

const form = () => document.body;

const TIERS = {
  providers: ['claude', 'codex', 'deepseek-1', 'kimi', 'my-endpoint', 'team'].map((slug) => ({
    slug, label: slug === 'deepseek-1' ? 'DeepSeek' : slug, kind: 'key', providerId: null, billing: 'key', models: [],
  })),
};

/** The SubAgents group's row whose label reads `label`. */
const subagentRow = (label: string) => {
  const row = [...form().querySelectorAll<HTMLElement>('.subagents-row')].find(
    (el) => el.querySelector('.rd-set-label')?.textContent === label,
  );
  if (!row) throw new Error(`no SubAgents row "${label}"`);
  return row;
};

describe('the SubAgents group on the Agent (docs/subagent-design.md §7)', () => {
  it('shows the four rows with the board copy and the defaults: on, on, every provider, 4', async () => {
    mount(workspace(), {});
    await openEditor();
    const group = form().querySelector<HTMLElement>('.subagents-group')!;
    expect([...group.querySelectorAll('.rd-set-label')].map((el) => el.textContent)).toEqual([
      'SubAgents', 'Workflows', 'Providers', 'Running at once',
    ]);
    expect(subagentRow('SubAgents').querySelector('.rd-set-desc')?.textContent)
      .toBe('Let this agent hand work to other providers in the same folder');
    expect(subagentRow('SubAgents').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(subagentRow('Workflows').querySelector('.rd-set-desc')?.textContent)
      .toBe('Let this agent run a script that starts many SubAgents and wakes it once');
    expect(subagentRow('Workflows').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(subagentRow('Providers').querySelector('.rd-set-desc')?.textContent)
      .toBe('All enabled providers. Block one to keep SubAgents off it.');
    expect(squash(subagentRow('Providers').querySelector('button')?.textContent)).toBe('6 of 6 · Edit');
    expect(subagentRow('Running at once').querySelector('.rd-set-desc')?.textContent)
      .toBe('Per session: delegated SubAgents and workflow calls together');
    expect(subagentRow('Running at once').querySelector<HTMLInputElement>('input')?.value).toBe('4');
  });

  it('saves the switch through its own PATCH /workspaces/:id', async () => {
    const { writes } = mount(workspace({ subagentsMaxRunning: 6 }), {});
    await openEditor();
    expect(subagentRow('Running at once').querySelector<HTMLInputElement>('input')?.value).toBe('6');
    await click(subagentRow('SubAgents').querySelector<HTMLElement>('[role="switch"]')!);
    expect(writes).toEqual([
      { method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { subagentsEnabled: false } },
    ]);
  });

  it('saves the Workflows switch through its own PATCH /workspaces/:id', async () => {
    const { writes } = mount(workspace(), {});
    await openEditor();
    await click(subagentRow('Workflows').querySelector<HTMLElement>('[role="switch"]')!);
    expect(writes).toEqual([
      { method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { workflowsEnabled: false } },
    ]);
    expect(subagentRow('Workflows').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(subagentRow('SubAgents').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('Workflows follows SubAgents: off with it, and cannot be turned on while it is off', async () => {
    const { writes } = mount(workspace({ subagentsEnabled: false, workflowsEnabled: true }), {});
    await openEditor();
    const sw = subagentRow('Workflows').querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.hasAttribute('disabled') || sw.getAttribute('aria-disabled') === 'true' || sw.hasAttribute('data-disabled')).toBe(true);
    await click(sw);
    expect(writes).toEqual([]);
    // SubAgents back on: Workflows reads its own value again.
    await click(subagentRow('SubAgents').querySelector<HTMLElement>('[role="switch"]')!);
    expect(writes).toEqual([
      { method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { subagentsEnabled: true } },
    ]);
    expect(subagentRow('Workflows').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('blocks a provider through PATCH /users/me/preferences, and the count follows', async () => {
    const { writes } = mount(workspace(), { subagentBlockedProviders: ['kimi'] });
    await openEditor();
    expect(squash(subagentRow('Providers').querySelector('button')?.textContent)).toBe('5 of 6 · Edit');
    await click(subagentRow('Providers').querySelector<HTMLElement>('button')!);
    const sw = document.body.querySelector<HTMLElement>('.subagents-providers-list [aria-label="DeepSeek"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.body.querySelector('.subagents-providers-list [aria-label="kimi"]')?.getAttribute('aria-checked')).toBe('false');
    await click(sw);
    expect(writes).toEqual([
      { method: 'PATCH', path: '/users/me/preferences', body: { subagentBlockedProviders: ['kimi', 'deepseek-1'] } },
    ]);
    expect(squash(subagentRow('Providers').querySelector('button')?.textContent)).toBe('4 of 6 · Edit');
  });
});
