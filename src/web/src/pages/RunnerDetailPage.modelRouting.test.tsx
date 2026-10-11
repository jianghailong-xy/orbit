// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { meQuery, type UserPreferences } from '../lib/queries';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * Smart model selection on the Agent's settings (docs/model-routing-design.md §9; the web mock §1):
 * a switch under Worktree isolation, off until the owner turns it on, saved as the workspace's
 * `modelRouting` through the user API — and the read-only Model line saying, once it is on, that
 * the model it names is only what the sessions opened by hand start on. All of it only while the
 * account's switch (`preferences.modelRouting`) is on; off — the default — the Agent has none of it.
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
      return { ...ws, ...(options?.body as object) };
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
        <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/runners/:id" element={<RunnerDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
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
    expect(form().querySelector('.rd-form-derived b')?.textContent).toBe('Opus 5.5');

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

/** An engine's name on its chip, without the note beside the agent's own. */
const engineName = (tick: HTMLElement) => {
  const label = tick.closest('label')?.cloneNode(true) as HTMLElement | undefined;
  label?.querySelectorAll('.rd-engine-own').forEach((note) => note.remove());
  return label?.textContent;
};
/** The engines smart selection may use, inside its row, as each one's tick reads: its CLI's name,
 *  whether it says it is the agent's own, whether it is checked, and whether it is disabled. */
const engines = () =>
  [...smartRow().querySelectorAll<HTMLElement>('.rd-engines-list [role="checkbox"]')].map((tick) => ({
    engine: engineName(tick),
    own: !!tick.closest('label')?.querySelector('.rd-engine-own'),
    ticked: tick.getAttribute('aria-checked') === 'true',
    fixed: tick.getAttribute('aria-disabled') === 'true',
  }));
const engineInput = (engine: string) =>
  [...smartRow().querySelectorAll<HTMLElement>('.rd-engines-list [role="checkbox"]')].find(
    (tick) => engineName(tick) === engine,
  )!;

describe('the engines smart selection may use', () => {
  it('sit under the switch, with only the agent\'s own engine ticked, and that one fixed', async () => {
    mount(workspace());
    await openEditor();

    expect(smartRow().querySelector('.rd-engines-label')?.textContent).toBe('Engines it may use');
    expect(engines()).toEqual([
      { engine: 'Claude Code', own: true, ticked: true, fixed: true },
      { engine: 'Codex', own: false, ticked: false, fixed: false },
    ]);
    expect(smartRow().querySelector('.rd-engine-own')?.textContent).toBe("this agent's engine");
    expect(squash(smartRow().querySelector('.rd-engines-note')?.textContent)).toBe(ENGINES_NOTE);
    // Still one setting row: the group belongs to the switch, not beside it.
    expect(settingLabels()).toEqual(['Worktree isolation', SWITCH_LABEL]);
  });

  it('ticking another engine saves it as modelRoutingProviders', async () => {
    const { writes } = mount(workspace());
    await openEditor();

    await click(engineInput('Codex'));
    expect(engines()[1]).toEqual({ engine: 'Codex', own: false, ticked: true, fixed: false });

    await click(byText('button', 'Save'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}` });
    expect(writes[0].body.modelRoutingProviders).toEqual(['codex']);
  });

  it('fixes the engine the agent runs on, and unticking the other one takes it off the list', async () => {
    const { writes } = mount(workspace({ lastProvider: 'codex', modelRoutingProviders: ['claude'] }));
    await openEditor();

    // The agent's own engine comes first.
    expect(engines()).toEqual([
      { engine: 'Codex', own: true, ticked: true, fixed: true },
      { engine: 'Claude Code', own: false, ticked: true, fixed: false },
    ]);
    await click(engineInput('Claude Code'));
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

describe('the engines, never the keys (board 7)', () => {
  const deepseekKey = (slug: string, label: string) => ({
    slug,
    label,
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    engines: ['claude', 'opencode', 'dsh'],
  });

  it('lists the engine a workspace last ran on a key, and says the key in the model line', async () => {
    mount(workspace({ lastEngine: 'claude', lastProvider: 'deepseek' }), { modelRouting: true }, [deepseekKey('deepseek', 'DeepSeek')]);
    await openEditor();
    expect(engines().map(({ engine, own }) => ({ engine, own }))).toEqual([
      { engine: 'Claude Code', own: true },
      { engine: 'Codex', own: false },
    ]);
    expect(modelLine()).toBe(
      'Model DeepSeek V4 Pro · Claude Code via DeepSeek on this runner. Pick a different one from the session composer.',
    );
  });

  it('locks DeepSeek Harness for a Harness workspace, and leaves its key out of the engines', async () => {
    const runner = {
      ...RUNNER,
      modelCatalog: { ...RUNNER.modelCatalog, dsh: [{ value: '["deepseek", "deepseek-v4-pro"]', label: 'DeepSeek V4 Pro' }] },
    } as Runner;
    mount(
      workspace({ lastEngine: 'dsh', lastProvider: 'deepseek-2' }),
      { modelRouting: true },
      [deepseekKey('deepseek', 'DeepSeek'), deepseekKey('deepseek-2', 'DeepSeek 2')],
      runner,
    );
    await openEditor();
    expect(engines()).toEqual([
      { engine: 'DeepSeek Harness', own: true, ticked: true, fixed: true },
      { engine: 'Claude Code', own: false, ticked: false, fixed: false },
      { engine: 'Codex', own: false, ticked: false, fixed: false },
    ]);
    expect(modelLine()).toBe(
      'Model DeepSeek V4 Pro · DeepSeek Harness via DeepSeek 2 on this runner. Pick a different one from the session composer.',
    );
  });
});

describe('with the account switch off', () => {
  const cases: Array<[string, UserPreferences]> = [
    ['preferences without modelRouting', {}],
    ['modelRouting: false', { modelRouting: false }],
  ];
  for (const [what, preferences] of cases) {
    it(`(${what}) nothing of smart selection shows, and saving leaves the Agent's own setting as it was`, async () => {
      // An Agent that had it on, with another engine ticked, before the account turned it off.
      const { writes } = mount(workspace({ modelRouting: true, modelRoutingProviders: ['codex'] }), preferences);
      await openEditor();

      expect(settingLabels()).toEqual(['Worktree isolation']);
      expect(form().querySelector('.rd-route-engines')).toBeNull();
      expect(form().textContent).not.toContain(SWITCH_LABEL);
      expect(form().textContent).not.toContain('Engines it may use');
      // The Model line is today's, though the Agent's own switch is on.
      expect(modelLine()).toBe(MODEL_LINE_OFF);

      await click(form().querySelector<HTMLElement>('.rd-set-row [role="switch"]')!); // Worktree isolation
      await click(byText('button', 'Save'));
      expect(writes).toHaveLength(1);
      expect(writes[0].body).toMatchObject({ enableWorktree: false, modelRouting: true, modelRoutingProviders: ['codex'] });
    });
  }
});
