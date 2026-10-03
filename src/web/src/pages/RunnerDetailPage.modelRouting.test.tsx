// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * Smart model selection on the Agent's settings (docs/model-routing-design.md §9; the web mock §1):
 * a switch under Worktree isolation, off until the owner turns it on, saved as the workspace's
 * `modelRouting` through the user API — and the read-only Model line saying, once it is on, that
 * the model it names is only what the sessions opened by hand start on.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
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
const SWITCH_DESC =
  'Task runs use the model and effort of the tier suggested for the task, and go one tier up after a failed run. ' +
  "Tasks with no suggestion start on this Agent's model. A model pinned on a task always wins. " +
  'Sessions you open yourself are not affected.';
const MODEL_LINE_OFF =
  'Model claude-opus-5-5 · resolved by Claude on this runner. Pick a different one from the session composer.';
const MODEL_LINE_ON =
  'Task runs: model picked per task by smart selection. Sessions you open yourself: claude-opus-5-5 · ' +
  'resolved by Claude on this runner.';

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

/** The runner's page over one workspace. Every PATCH and POST the page sends is collected. */
function mount(ws: ReturnType<typeof workspace>) {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method === 'PATCH' || method === 'POST') {
      writes.push({ method, path, body: options?.body as Record<string, unknown> });
      return { ...ws, ...(options?.body as object) };
    }
    if (path === '/runners') return [RUNNER];
    if (path === '/workspaces') return [ws];
    if (path === '/providers') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'u', email: 'u@example.invalid', name: 'u', createdAt: '', preferences: {} };
    if (path.includes('permission-rules')) return [];
    if (path.includes('imported')) return { count: 0 };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [RUNNER]);
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
  return { writes };
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
const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Open the workspace's editor, as a person does: by its name in the list. */
async function openEditor() {
  await settle();
  await click(byText('.rd-workspace-name', 'orbit'));
}

const form = () => {
  const found = document.body.querySelector<HTMLElement>('.rd-workspace-form');
  if (!found) throw new Error('the workspace editor is not open');
  return found;
};
/** The editor's settings rows, top to bottom, as their labels. */
const settingLabels = () =>
  [...form().querySelectorAll<HTMLElement>('.rd-set-row .rd-set-label')].map((el) => el.textContent);
const smartRow = () => {
  const row = [...form().querySelectorAll<HTMLElement>('.rd-set-row')].find(
    (el) => el.querySelector('.rd-set-label')?.textContent === SWITCH_LABEL,
  );
  if (!row) throw new Error(`no "${SWITCH_LABEL}" row`);
  return row;
};
const smartSwitch = () => smartRow().querySelector<HTMLElement>('[role="switch"]')!;
const modelLine = () => squash(form().querySelector('.rd-form-derived')?.textContent);

describe('smart model selection on the Agent', () => {
  it('sits under Worktree isolation, off until it is turned on, with the task routing explanation', async () => {
    mount(workspace());
    await openEditor();

    expect(settingLabels()).toEqual(['Worktree isolation', SWITCH_LABEL]);
    expect(smartRow().querySelector('.rd-set-desc')?.textContent).toBe(SWITCH_DESC);
    expect(smartSwitch().getAttribute('aria-checked')).toBe('false');
    // Off, the Model line is today's.
    expect(modelLine()).toBe(MODEL_LINE_OFF);
  });

  it('turned on, says task runs pick their own model, and saves modelRouting: true', async () => {
    const { writes } = mount(workspace());
    await openEditor();

    await click(smartSwitch());
    expect(smartSwitch().getAttribute('aria-checked')).toBe('true');
    expect(modelLine()).toBe(MODEL_LINE_ON);
    // The bold model is still the one sessions opened by hand start on.
    expect(form().querySelector('.rd-form-derived b')?.textContent).toBe('claude-opus-5-5');

    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}` });
    expect(writes[0].body.modelRouting).toBe(true);
    // Nothing else the form owns moved with it.
    expect(writes[0].body.enableWorktree).toBe(true);
  });

  it('opens on for an Agent that has it, and turning it off saves modelRouting: false', async () => {
    const { writes } = mount(workspace({ modelRouting: true }));
    await openEditor();

    expect(smartSwitch().getAttribute('aria-checked')).toBe('true');
    expect(modelLine()).toBe(MODEL_LINE_ON);

    await click(smartSwitch());
    expect(smartSwitch().getAttribute('aria-checked')).toBe('false');
    expect(modelLine()).toBe(MODEL_LINE_OFF);

    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0].body.modelRouting).toBe(false);
  });

  it('leaves the switch as it was when the Agent is saved for something else', async () => {
    const { writes } = mount(workspace({ modelRouting: true }));
    await openEditor();
    await click(form().querySelector<HTMLElement>('.rd-set-row [role="switch"]')!); // Worktree isolation
    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ enableWorktree: false, modelRouting: true });
  });
});

const ENGINES_NOTE =
  "Only this agent's own engine is ticked by default, so a task never moves to another engine unless you tick it here.";

/** The engines smart selection may use, inside its row, as each one's tick reads. */
const engines = () =>
  [...smartRow().querySelectorAll<HTMLElement>('.rd-engines-list .ant-checkbox-wrapper')].map((chip) => {
    const input = chip.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    return { engine: chip.textContent, ticked: input.checked, fixed: input.disabled };
  });
const engineInput = (engine: string) =>
  [...smartRow().querySelectorAll<HTMLElement>('.rd-engines-list .ant-checkbox-wrapper')]
    .find((chip) => chip.textContent === engine)!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

describe('the engines smart selection may use', () => {
  it('sit under the switch, with only the agent\'s own engine ticked, and that one fixed', async () => {
    mount(workspace());
    await openEditor();

    expect(smartRow().querySelector('.rd-engines-label')?.textContent).toBe('Engines it may use');
    expect(engines()).toEqual([
      { engine: 'claude', ticked: true, fixed: true },
      { engine: 'codex', ticked: false, fixed: false },
    ]);
    expect(squash(smartRow().querySelector('.rd-engines-note')?.textContent)).toBe(ENGINES_NOTE);
    // Still one setting row: the group belongs to the switch, not beside it.
    expect(settingLabels()).toEqual(['Worktree isolation', SWITCH_LABEL]);
  });

  it('ticking another engine saves it as modelRoutingProviders', async () => {
    const { writes } = mount(workspace());
    await openEditor();

    await click(engineInput('codex'));
    expect(engines()[1]).toEqual({ engine: 'codex', ticked: true, fixed: false });

    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}` });
    expect(writes[0].body.modelRoutingProviders).toEqual(['codex']);
  });

  it('fixes the engine the agent runs on, and unticking the other one takes it off the list', async () => {
    const { writes } = mount(workspace({ lastProvider: 'codex', modelRoutingProviders: ['claude'] }));
    await openEditor();

    expect(engines()).toEqual([
      { engine: 'claude', ticked: true, fixed: false },
      { engine: 'codex', ticked: true, fixed: true },
    ]);
    await click(engineInput('claude'));
    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0].body.modelRoutingProviders).toEqual([]);
  });

  it('leaves the list as it was when the Agent is saved for something else', async () => {
    const { writes } = mount(workspace({ modelRoutingProviders: ['codex'] }));
    await openEditor();
    await click(form().querySelector<HTMLElement>('.rd-set-row [role="switch"]')!); // Worktree isolation
    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ enableWorktree: false, modelRoutingProviders: ['codex'] });
  });
});
