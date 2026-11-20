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
 * Smart model selection on the workspace's Settings page (docs/model-routing-design.md §9): the Agent
 * has no switch and no engine list of its own any more (owner, 2026-11-20). The account's switch
 * (`preferences.modelRouting`) alone decides, and while it is on the read-only Model line says that
 * the model it names is only what the sessions opened by hand start on.
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

const SWITCH_LABEL = 'Smart model selection for tasks';
// The engine and the credential the workspace's last session ran on, said as they are (board 7 ②), and
// the model by its catalogue name.
const MODEL_LINE_OFF =
  'Model Opus 5.5 · Claude Code on this runner. Pick a different one from the session composer.';
const MODEL_LINE_ON =
  'Task runs: model picked per task by smart selection. Sessions you open yourself: Opus 5.5 · ' +
  'Claude Code on this runner.';

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
      ws = { ...ws, ...(options?.body as object) };
      return ws;
    }
    if (path === '/runners') return [runner];
    if (path === '/workspaces') return [ws];
    if (path === '/providers') return providers;
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return me;
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

const page = () => document.body;
const sessions = () => {
  const found = [...page().querySelectorAll<HTMLElement>('.settings-section')].find(
    (el) => el.querySelector('.settings-section-title')?.textContent === 'Sessions',
  );
  if (!found) throw new Error('no Sessions section');
  return found;
};
/** The Sessions card's rows, top to bottom, as their titles. */
const settingLabels = () =>
  [...sessions().querySelectorAll<HTMLElement>('.settings-row-title')]
    .map((el) => el.textContent)
    .filter((label) => label !== 'Model');
const rowOf = (title: string) => {
  const row = [...page().querySelectorAll<HTMLElement>('.settings-row')].find(
    (el) => el.querySelector('.settings-row-title')?.textContent === title,
  );
  if (!row) throw new Error(`no "${title}" row`);
  return row;
};
const worktreeSwitch = () => rowOf('Worktree isolation').querySelector<HTMLElement>('[role="switch"]')!;
const modelLine = () => squash(rowOf('Model').querySelector('.rd-form-derived')?.textContent);

describe('smart model selection on the Agent', () => {
  it('has no Optimize For of its own: it is the account\'s, on Settings → General', async () => {
    const { writes } = mount(workspace());
    await openEditor();
    expect(page().querySelector('[aria-label="Optimize for"]')).toBeNull();
    expect(page().querySelector('[aria-label="Optimize For"]')).toBeNull();
    await click(worktreeSwitch());
    expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
  });

  it('has no switch and no engine list of its own: the account\'s switch alone decides', async () => {
    // An Agent that had its own switch on and another engine ticked, from before both went.
    const { writes } = mount(workspace({ modelRouting: true, modelRoutingProviders: ['codex'] }));
    await openEditor();

    expect(settingLabels()).toEqual(['Worktree isolation']);
    expect(sessions().textContent).not.toContain(SWITCH_LABEL);
    expect(sessions().textContent).not.toContain('Engines it may use');
    expect(sessions().querySelector('[role="checkbox"]')).toBeNull();
    // The account's switch is on, so task runs pick their own model.
    expect(modelLine()).toBe(MODEL_LINE_ON);
    // The bold model is still the one sessions opened by hand start on.
    expect(rowOf('Model').querySelector('.rd-form-derived b')?.textContent).toBe('Opus 5.5');

    // Saving another row writes that row alone.
    await click(worktreeSwitch());
    expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
  });
});

describe('the model line names the key (board 7)', () => {
  const deepseekKey = (slug: string, label: string) => ({
    slug,
    label,
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    engines: ['claude', 'opencode', 'dsh'],
  });

  it('says the key a workspace last ran on', async () => {
    mount(workspace({ lastEngine: 'claude', lastProvider: 'deepseek' }), { modelRouting: true }, [deepseekKey('deepseek', 'DeepSeek')]);
    await openEditor();
    expect(modelLine()).toBe(
      'Task runs: model picked per task by smart selection. Sessions you open yourself: DeepSeek V4 Pro · ' +
        'Claude Code via DeepSeek on this runner.',
    );
  });

  it('says DeepSeek Harness and its key for a Harness workspace', async () => {
    const runner = {
      ...RUNNER,
      modelCatalog: { ...RUNNER.modelCatalog, dsh: [{ value: '["deepseek", "deepseek-v4-pro"]', label: 'DeepSeek V4 Pro' }] },
    } as Runner;
    mount(
      workspace({ lastEngine: 'dsh', lastProvider: 'deepseek-2' }),
      { modelRouting: false },
      [deepseekKey('deepseek', 'DeepSeek'), deepseekKey('deepseek-2', 'DeepSeek 2')],
      runner,
    );
    await openEditor();
    expect(modelLine()).toBe(
      'Model DeepSeek V4 Pro · DeepSeek Harness via DeepSeek 2 on this runner. Pick a different one from the session composer.',
    );
  });
});

describe('with the account switch off', () => {
  it('the Model line is today\'s, and nothing of smart selection shows', async () => {
    const { writes } = mount(workspace({ modelRouting: true, modelRoutingProviders: ['codex'] }), { modelRouting: false });
    await openEditor();

    expect(settingLabels()).toEqual(['Worktree isolation']);
    expect(sessions().textContent).not.toContain(SWITCH_LABEL);
    expect(modelLine()).toBe(MODEL_LINE_OFF);

    await click(worktreeSwitch());
    expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
  });
});
