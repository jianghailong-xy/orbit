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
 * Smart model selection on the workspace's Settings page (docs/model-routing-design.md §9; the web
 * mock §1): a switch under Worktree isolation, off until the owner turns it on, saved on its own as
 * the workspace's `modelRouting` — and the read-only Model line saying, once it is on, that
 * the model it names is only what the sessions opened by hand start on. All of it only while the
 * account's switch (`preferences.modelRouting`) is on; off — the default — the Agent has none of it.
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
// The row says it short (board-5); the whole explanation is the control's tooltip.
const SWITCH_DESC = 'Task runs use the suggested tier’s model and effort.';
const SWITCH_TOOLTIP =
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

// Select options need the browser's full pointer sequence to commit a choice.
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
const smartRow = () => rowOf(SWITCH_LABEL);
const smartSwitch = () => smartRow().querySelector<HTMLElement>('[role="switch"]')!;
const worktreeSwitch = () => rowOf('Worktree isolation').querySelector<HTMLElement>('[role="switch"]')!;
const optimize = () => page().querySelector<HTMLElement>('[aria-label="Optimize for"]');
const modelLine = () => squash(rowOf('Model').querySelector('.rd-form-derived')?.textContent);

describe('smart model selection on the Agent', () => {
  it.each([
    [undefined, 'Cost'],
    ['cost', 'Cost'],
    ['balance', 'Balance'],
    ['intelligence', 'Intelligence'],
  ])('reads optimize mode %s as %s', async (mode, label) => {
    mount(workspace({ modelRoutingOptimizeFor: mode }));
    await openEditor();
    expect(optimize()?.textContent).toContain(label);
  });

  it.each(['Cost', 'Balance', 'Intelligence'])('saves %s on its own, in a PATCH of that field alone', async (label) => {
    const { writes } = mount(workspace({ modelRoutingOptimizeFor: label === 'Balance' ? 'cost' : 'balance' }));
    await openEditor();
    await click(optimize()!);
    expect([...document.querySelectorAll('[role="option"]')].map((el) => el.textContent)).toEqual([
      'Cost', 'Balance', 'Intelligence',
    ]);
    await press(byText('[role="option"]', label));
    expect(writes).toEqual([
      { method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { modelRoutingOptimizeFor: label.toLowerCase() } },
    ]);
    expect(optimize()?.textContent).toContain(label);
  });

  it('leaves the saved optimize mode alone when another setting is saved with the account switch off', async () => {
    const { writes } = mount(workspace({ modelRoutingOptimizeFor: 'intelligence' }), { modelRouting: false });
    await openEditor();
    expect(optimize()).toBeNull();
    await click(worktreeSwitch());
    expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
  });

  it('sits under Worktree isolation, off until it is turned on, with the task routing explanation', async () => {
    mount(workspace());
    await openEditor();

    expect(settingLabels()).toEqual(['Worktree isolation', SWITCH_LABEL, 'Optimize for']);
    expect(smartRow().querySelector('.settings-row-description')?.textContent).toBe(SWITCH_DESC);
    // The whole explanation, where the row shortens it.
    expect(smartRow().querySelector('.settings-row-control')?.getAttribute('title')).toBe(SWITCH_TOOLTIP);
    expect(smartSwitch().getAttribute('aria-checked')).toBe('false');
    // Off, the Model line is today's.
    expect(modelLine()).toBe(MODEL_LINE_OFF);
  });

  it('turned on, says task runs pick their own model, and saves modelRouting: true alone', async () => {
    const { writes } = mount(workspace());
    await openEditor();

    await click(smartSwitch());
    expect(smartSwitch().getAttribute('aria-checked')).toBe('true');
    expect(modelLine()).toBe(MODEL_LINE_ON);
    // The bold model is still the one sessions opened by hand start on.
    expect(rowOf('Model').querySelector('.rd-form-derived b')?.textContent).toBe('Opus 5.5');
    expect(writes).toEqual([{ method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { modelRouting: true } }]);
  });

  it('opens on for an Agent that has it, and turning it off saves modelRouting: false', async () => {
    const { writes } = mount(workspace({ modelRouting: true }));
    await openEditor();

    expect(smartSwitch().getAttribute('aria-checked')).toBe('true');
    expect(modelLine()).toBe(MODEL_LINE_ON);

    await click(smartSwitch());
    expect(smartSwitch().getAttribute('aria-checked')).toBe('false');
    expect(modelLine()).toBe(MODEL_LINE_OFF);
    expect(writes.map((w) => w.body)).toEqual([{ modelRouting: false }]);
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
const engineGroup = () => sessions().querySelector<HTMLElement>('.rd-route-engines');
/** The engines smart selection may use, as each one's tick reads: its CLI's name, whether it says it
 *  is the agent's own, whether it is checked, and whether it is disabled. */
const engines = () =>
  [...(engineGroup()?.querySelectorAll<HTMLElement>('.rd-engines-list [role="checkbox"]') ?? [])].map((tick) => ({
    engine: engineName(tick),
    own: !!tick.closest('label')?.querySelector('.rd-engine-own'),
    ticked: tick.getAttribute('aria-checked') === 'true',
    fixed: tick.getAttribute('aria-disabled') === 'true',
  }));
const engineInput = (engine: string) =>
  [...engineGroup()!.querySelectorAll<HTMLElement>('.rd-engines-list [role="checkbox"]')].find(
    (tick) => engineName(tick) === engine,
  )!;

describe('the engines smart selection may use', () => {
  it('sit under Optimize for, with only the agent\'s own engine ticked, and that one fixed', async () => {
    mount(workspace());
    await openEditor();

    expect(engineGroup()?.querySelector('.rd-engines-label')?.textContent).toBe('Engines it may use');
    expect(engines()).toEqual([
      { engine: 'Claude Code', own: true, ticked: true, fixed: true },
      { engine: 'Codex', own: false, ticked: false, fixed: false },
    ]);
    expect(engineGroup()?.querySelector('.rd-engine-own')?.textContent).toBe("this agent's engine");
    expect(squash(engineGroup()?.querySelector('.rd-engines-note')?.textContent)).toBe(ENGINES_NOTE);
  });

  it('ticking another engine saves it as modelRoutingProviders, and nothing else', async () => {
    const { writes } = mount(workspace());
    await openEditor();

    await click(engineInput('Codex'));
    expect(engines()[1]).toEqual({ engine: 'Codex', own: false, ticked: true, fixed: false });
    expect(writes).toEqual([
      { method: 'PATCH', path: `/workspaces/${WORKSPACE_ID}`, body: { modelRoutingProviders: ['codex'] } },
    ]);
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
    expect(writes.map((w) => w.body)).toEqual([{ modelRoutingProviders: [] }]);
  });

  it('leaves the list as it was when another setting is saved', async () => {
    const { writes } = mount(workspace({ modelRoutingProviders: ['codex'] }));
    await openEditor();
    await click(worktreeSwitch());
    expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
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
    it(`(${what}) nothing of smart selection shows, and saving another row leaves the Agent's own setting as it was`, async () => {
      // An Agent that had it on, with another engine ticked, before the account turned it off.
      const { writes } = mount(workspace({ modelRouting: true, modelRoutingProviders: ['codex'] }), preferences);
      await openEditor();

      expect(settingLabels()).toEqual(['Worktree isolation']);
      expect(engineGroup()).toBeNull();
      expect(sessions().textContent).not.toContain(SWITCH_LABEL);
      expect(sessions().textContent).not.toContain('Engines it may use');
      // The Model line is today's, though the Agent's own switch is on.
      expect(modelLine()).toBe(MODEL_LINE_OFF);

      await click(worktreeSwitch());
      expect(writes.map((w) => w.body)).toEqual([{ enableWorktree: false }]);
    });
  }
});
