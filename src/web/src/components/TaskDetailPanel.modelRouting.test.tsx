// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { meQuery, type UserPreferences } from '../lib/queries';
import type { ConfiguredProvider } from '../lib/workspaceDefaults';

/**
 * Smart model selection in the task panel (docs/model-routing-design.md §9; the web mock §2–§3).
 *
 * Details: a Suggested picker under Assignee — No suggestion and S / M / L / XL, each tier with the
 * model and effort the server resolved it to and a line on the work it is for — with the
 * coordinator's reason in grey under it; and the Model placeholder that says ✦ Smart selection once
 * the assignee has it on.
 *
 * Runs: each run's "model · effort", a ✦ tier tag on a run that ran on the pick (↑ when a failure
 * moved it up), a purple line on a run that did not, saying what smart selection would have picked —
 * and either one opens the Why: the decision's own reasons and its policy and time.
 *
 * All of it only while the account's switch (`preferences.modelRouting`) is on; off — the default —
 * the panel reads as it did before smart selection existed.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { TaskDetailPanel } = await import('./TaskDetailPanel');

const TASK = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a01');
const AGENT = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a02');
const RUNNER = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a03');
const RUN_1 = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a11');
const RUN_2 = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a12');
const RUN_3 = encodeId('01a0702b-242d-74ed-8c72-75d49d5b4a13');

/** The tiers as the server resolved them on the Agent's runner (`modelHintOptions`). */
const OPTIONS = [
  { level: 'S', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'low' },
  { level: 'M', provider: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', effort: 'medium' },
  { level: 'L', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'high' },
  { level: 'XL', provider: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5', effort: 'max' },
];

const REASON = 'one service plus its spec; an acceptance command decides it';

/** The route summary the task read carries beside a run (§7.5). */
const route = (over: Record<string, unknown> = {}) => ({
  level: 'M',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  applied: true,
  escalated: false,
  reasons: [`Tier M: suggested by the coordinator — ${REASON}`, "Engine claude: this agent's own engine"],
  policyVersion: 1,
  decidedAt: '2026-10-03T01:12:00.000Z',
  ...over,
});

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'Run',
  status: 'SUCCEEDED',
  createdAt: '2026-10-03T01:12:00.000Z',
  workspace: { name: 'orbit' },
  model: null,
  effort: null,
  route: null,
  ...over,
});

/** The owner's read of the task (GET /tasks/:id). */
const detail = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  title: 'Freeze the run target at v2',
  status: 'OPEN',
  assignee: { id: AGENT, name: 'orbit' },
  provider: null,
  model: null,
  modelHint: 'M',
  modelHintReason: REASON,
  modelHintOptions: OPTIONS,
  sessions: [],
  comments: [],
  attachments: [],
  dependsOn: [],
  dependedOnBy: [],
  ...over,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let where = '';

/** Where the router is, so a press that should not navigate can be shown not to. */
function Where() {
  where = useLocation().pathname;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The panel over this read, with the assignee Agent and its runner as the workspace list reports them,
 *  for an account with smart selection on unless `preferences` says otherwise. */
async function mount(
  data: Record<string, unknown>,
  agent: Record<string, unknown> = {},
  machine: Record<string, unknown> = {},
  providers: ConfiguredProvider[] = [],
  preferences: UserPreferences = { modelRouting: true },
): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  client.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', createdAt: '2026-01-01T00:00:00Z', preferences });
  client.setQueryData(['task', TASK], data);
  client.setQueryData(['workspaces'], [{ id: AGENT, name: 'orbit', runnerId: RUNNER, provider: 'claude', ...agent }]);
  client.setQueryData(['runners'], [
    {
      id: RUNNER,
      name: 'wikova',
      modelCatalog: {
        claude: [
          { value: 'claude-opus-5-5', label: 'Opus 5.5' },
          { value: 'claude-fable-5-1', label: 'Fable 5.1' },
          { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
        ],
      },
      ...machine,
    },
  ]);
  client.setQueryData(['providers'], providers);
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={['/tasks']}>
        <QueryClientProvider client={client}>
          <Where />
          <TaskDetailPanel taskId={TASK} onOpenTask={() => {}} onClose={() => {}} onDelete={() => {}} deleting={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which
 *  a list option needs before it takes a click as a choice rather than a keyboard activation. */
async function press(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    element!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    element!.dispatchEvent(new MouseEvent('mousedown', init));
    element!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    element!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<MouseEvent> {
  expect(element, `${what} is on screen`).toBeTruthy();
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    element!.dispatchEvent(event);
  });
  await settle();
  return event;
}

const panel = (): HTMLElement => container!.querySelector<HTMLElement>('.task-detail-panel')!;
const field = (label: string): HTMLElement => {
  const found = [...panel().querySelectorAll<HTMLElement>('.tdp-field')].find(
    (el) => el.querySelector('.tdp-field-label')?.textContent === label,
  );
  if (!found) throw new Error(`no ${label} field`);
  return found;
};
const labels = () => [...panel().querySelectorAll('.tdp-field-label')].map((el) => el.textContent);

/** The PATCHes the panel sent to the task, as their bodies. */
const patches = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === `/tasks/${TASK}` && options?.method === 'PATCH')
    .map(([, options]) => options?.body);

/** Open the Suggested picker, and wait for its rows to be in the popup it portals out. */
async function openSuggested(): Promise<HTMLElement[]> {
  await click(field('Suggested').querySelector('[role="combobox"]'), 'the Suggested picker');
  await vi.waitFor(() =>
    expect(document.body.querySelectorAll('.tdp-hint-popup [role="option"]').length).toBe(5),
  );
  return [...document.body.querySelectorAll<HTMLElement>('.tdp-hint-popup [role="option"]')];
}
/** What a field's picker says while nothing is chosen: a Select shows it as its value, a searchable
 *  one as the hint beside its input. */
const placeholderOf = (label: string): string | null | undefined => {
  const picker = field(label).querySelector('[role="combobox"]');
  return picker?.tagName === 'INPUT' ? picker.getAttribute('aria-placeholder') : picker?.textContent;
};
const optionText = (option: HTMLElement) => ({
  name: option.querySelector('.tdp-hint-option-name')?.textContent,
  detail: option.querySelector('.tdp-hint-option-detail')?.textContent,
  dot: option.querySelector('.tdp-hint-dot')?.className ?? null,
});

/** One run's row, its Why when open, and what each says. */
const row = (id: string): HTMLElement => {
  const found = panel().querySelector<HTMLElement>(`a.tdp-session[href="/sessions/${id}"]`);
  if (!found) throw new Error(`no run ${id}`);
  return found;
};
const why = (id: string): HTMLElement | null =>
  row(id).nextElementSibling?.classList.contains('tdp-route-why') ? (row(id).nextElementSibling as HTMLElement) : null;
const whyText = (el: HTMLElement) => ({
  title: el.querySelector('.tdp-route-why-title')?.textContent,
  reasons: [...el.querySelectorAll('li')].map((li) => li.textContent),
  foot: el.querySelector('.tdp-route-why-foot')?.textContent,
});
/** The panel's own short time, as the Runs list and the Why's footer write it. */
const short = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  apiMock.mockReset();
  // A write lands; every read the panel's other sections make stays in flight — not this file's subject.
  apiMock.mockImplementation(((_path: string, options?: { method?: string }) =>
    options?.method === 'PATCH' ? Promise.resolve({}) : new Promise(() => {})) as never);
  for (const fn of Object.values(toast)) fn.mockReset();
  where = '';
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the Suggested tier in Details', { timeout: 60_000 }, () => {
  it('sits under Assignee and shows the tier with its model and effort, the coordinator’s reason under it', async () => {
    await mount(detail());
    expect(labels().slice(0, 5)).toEqual(['Assignee', 'Suggested', 'Engine', 'Provider', 'Model']);
    const value = field('Suggested').querySelector('.tdp-hint-value');
    expect(value?.textContent).toBe('M · Sonnet 5.5 · medium');
    expect(value?.querySelector('.tdp-hint-dot')?.classList.contains('is-m')).toBe(true);
    expect(field('Suggested').querySelector('.tdp-field-note')?.textContent).toBe(`Coordinator: ${REASON}`);
  });

  it('reads No suggestion, with no reason line, on a task without one', async () => {
    await mount(detail({ modelHint: null, modelHintReason: null }));
    expect(placeholderOf('Suggested')).toBe('No suggestion');
    expect(field('Suggested').querySelector('.tdp-hint-value')).toBeNull();
    expect(field('Suggested').querySelector('.tdp-field-note')).toBeNull();
  });

  it('lists No suggestion and every tier with its model, effort and the work it is for', async () => {
    await mount(detail());
    const options = await openSuggested();
    expect(options.map(optionText)).toEqual([
      { name: 'No suggestion', detail: "Keeps the agent's model, as today", dot: null },
      { name: 'S · Sonnet 5.5 · low', detail: 'Rename, copy change, version bump, mechanical edits', dot: 'tdp-hint-dot is-s' },
      { name: 'M · Sonnet 5.5 · medium', detail: 'A clear feature or fix with a known shape', dot: 'tdp-hint-dot is-m' },
      {
        name: 'L · Opus 5.5 · high',
        detail: 'Unknown root cause, concurrency, cross-module, migrations, the dispatch path',
        dot: 'tdp-hint-dot is-l',
      },
      { name: 'XL · Opus 5.5 · max', detail: 'Architecture, design, long unattended work', dot: 'tdp-hint-dot is-xl' },
    ]);
  });

  it('names the bare tier where the server could not resolve its model', async () => {
    await mount(detail({ modelHintOptions: null }));
    const options = await openSuggested();
    expect(options.map((option) => optionText(option).name)).toEqual(['No suggestion', 'S', 'M', 'L', 'XL']);
  });

  it('saves a tier picked by hand without the coordinator’s reason, and No suggestion as no tier', async () => {
    await mount(detail());
    let options = await openSuggested();
    // The tier it already has is no change, and reaches the server as none.
    await press(options[2], 'M');
    expect(patches()).toEqual([]);

    options = await openSuggested();
    await press(options[3], 'L');
    await vi.waitFor(() => expect(patches()).toEqual([{ modelHint: 'L', modelHintReason: null }]));

    options = await openSuggested();
    await press(options[0], 'No suggestion');
    await vi.waitFor(() =>
      expect(patches()).toEqual([
        { modelHint: 'L', modelHintReason: null },
        { modelHint: null, modelHintReason: null },
      ]),
    );
  });

  it('saves a model picked by hand, and the model it already has as no change', async () => {
    await mount(detail({ provider: 'claude', model: 'claude-opus-5-5' }));
    const openModel = async () => {
      await press(field('Model').querySelector('[role="combobox"]'), 'the Model picker');
      await vi.waitFor(() => expect(document.body.querySelectorAll('[role="listbox"] [role="option"]').length).toBe(3));
      return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
    };
    let options = await openModel();
    // As in the select this replaces, picking the chosen option only closes the list.
    await press(options.find((option) => option.textContent?.includes('Opus 5.5')), 'Opus 5.5');
    expect(patches()).toEqual([]);

    options = await openModel();
    await press(options.find((option) => option.textContent?.includes('Sonnet 5.5')), 'Sonnet 5.5');
    await vi.waitFor(() => expect(patches()).toEqual([expect.objectContaining({ model: 'claude-sonnet-5-5' })]));
  });

  it('reads ✦ Smart selection in an unpinned Model while the assignee has it on, and Provider default otherwise', async () => {
    await mount(detail(), { modelRouting: true });
    expect(placeholderOf('Model')).toBe('✦ Smart selection');
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    await mount(detail(), { modelRouting: false });
    expect(placeholderOf('Model')).toBe('Provider default');
  });
});

describe('the task pin: an engine, then a credential it runs (board 6)', { timeout: 60_000 }, () => {
  const key = (slug: string, label: string, over: Partial<ConfiguredProvider> = {}): ConfiguredProvider => ({
    slug,
    label,
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    defaultModel: 'deepseek-v4-pro',
    engines: ['claude', 'opencode', 'dsh'],
    ...over,
  });
  const keys = [key('deepseek', 'DeepSeek'), key('deepseek-2', 'DeepSeek 2'), key('glm', 'Z.AI (GLM)', { presetSlug: 'glm', engines: ['claude', 'opencode'] })];
  /** A runner that can run DeepSeek Harness. */
  const dshRunner = { capabilities: ['provider:dsh'] };

  /** An option's words, without the mark drawn before an engine's or a key's name. */
  const words = (option: Element) => {
    const copy = option.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.np-mark').forEach((mark) => mark.remove());
    return copy.textContent ?? '';
  };
  const openField = async (label: string): Promise<HTMLElement[]> => {
    await press(field(label).querySelector('[role="combobox"]'), `the ${label} picker`);
    await vi.waitFor(() => expect(document.body.querySelectorAll('[role="listbox"] [role="option"]').length).toBeGreaterThan(0));
    return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
  };
  const groupLabels = () => [...document.body.querySelectorAll('[role="listbox"] .orbit-select-group-label')].map((el) => el.textContent);

  it("reads the assignee's engine while nothing is pinned, and offers it and the six engines by their CLI names", async () => {
    await mount(detail(), { lastEngine: 'claude', lastProvider: 'claude' });
    expect(placeholderOf('Engine')).toBe("Assignee's · Claude Code");
    expect((await openField('Engine')).map(words)).toEqual([
      "Assignee'sClaude Code",
      'Claude Code',
      'Codex',
      'Kimi Code',
      'Antigravity CLI',
      'OpenCode',
      'DeepSeek Harness',
    ]);
  });

  it('pins an engine, keeping a credential it runs and dropping one it does not — and the model either way', async () => {
    await mount(detail({ engine: 'claude', provider: 'deepseek', model: 'deepseek-v4-pro' }), {}, dshRunner, keys);
    let options = await openField('Engine');
    await press(options.find((option) => words(option) === 'DeepSeek Harness'), 'DeepSeek Harness');
    // The DeepSeek key runs on DeepSeek Harness too: it stays pinned; the model space moved.
    await vi.waitFor(() => expect(patches()).toEqual([{ engine: 'dsh', model: null }]));

    options = await openField('Engine');
    await press(options.find((option) => words(option) === 'Codex'), 'Codex');
    // Codex does not run it: the pin gives way to Codex's own default.
    await vi.waitFor(() => expect(patches()[1]).toEqual({ engine: 'codex', provider: null, model: null }));

    options = await openField('Engine');
    await press(options.find((option) => words(option).startsWith("Assignee's")), "Assignee's");
    // Back on the assignee's: nothing stays pinned.
    await vi.waitFor(() => expect(patches()[2]).toEqual({ engine: null, provider: null, model: null }));
  });

  it('lists Engine default and only what the engine runs: every DeepSeek key under DeepSeek Harness', async () => {
    await mount(detail({ engine: 'dsh' }), {}, dshRunner, keys);
    expect(placeholderOf('Provider')).toBe('Engine default · DeepSeek');
    expect((await openField('Provider')).map(words)).toEqual(['Engine defaultfirst DeepSeek key', 'DeepSeek', 'DeepSeek 2']);
    expect(groupLabels()).toEqual(['Your DeepSeek keys']);
  });

  it('lists the runner sign-in as Claude Code’s default, then its pools and keys', async () => {
    await mount(detail({ engine: 'claude' }), {}, dshRunner, keys);
    expect(placeholderOf('Provider')).toBe('Engine default · sign-in on wikova');
    expect((await openField('Provider')).map(words)).toEqual(['Engine defaultrunner sign-in', 'DeepSeek', 'DeepSeek 2', 'Z.AI (GLM)']);
    expect(groupLabels()).toEqual(['Your keys']);
  });

  it('pins a credential together with the engine it runs on', async () => {
    await mount(detail(), { lastEngine: 'claude', lastProvider: 'claude' }, dshRunner, keys);
    const options = await openField('Provider');
    await press(options.find((option) => words(option) === 'DeepSeek 2'), 'DeepSeek 2');
    await vi.waitFor(() => expect(patches()).toEqual([{ engine: 'claude', provider: 'deepseek-2', model: null }]));
  });

  it('shows a pin the migration carried over as DeepSeek Harness on its DeepSeek key, with its models', async () => {
    await mount(
      detail({ engine: 'dsh', provider: 'deepseek' }),
      {},
      { ...dshRunner, modelCatalog: { dsh: [{ value: 'acp-pro', label: 'DeepSeek V4 Pro' }, { value: 'acp-flash', label: 'DeepSeek V4 Flash' }] } },
      keys,
    );
    expect(words(field('Engine'))).toContain('DeepSeek Harness');
    expect(words(field('Provider'))).toContain('DeepSeek');
    expect((await openField('Model')).map(words)).toEqual(['DeepSeek V4 Pro', 'DeepSeek V4 Flash']);
  });

  it('reads an older provider-only pin on the engine that provider runs on', async () => {
    await mount(detail({ provider: 'antigravity' }), { antigravityKeyAvailableByRunner: { [RUNNER]: false } }, {
      antigravity: { supported: true, installed: true, version: '1.2.16', envKeyAvailable: false },
    });
    expect(placeholderOf('Engine')).toBe('Antigravity CLI');
    expect(words(field('Provider'))).toContain('Sign-in on wikova');
    expect(words(field('Provider'))).toContain('env key');
  });

  it('links a Gemini key that needs a runner update to Infrastructure rather than pinning it', async () => {
    const gemini: ConfiguredProvider = {
      slug: 'gemini', label: 'Gemini', runtime: 'antigravity', presetSlug: 'gemini', models: [], engines: ['antigravity', 'opencode'],
    };
    await mount(detail({ engine: 'antigravity' }), {}, {
      antigravity: { supported: false, installed: true, version: '1.2.16', envKeyAvailable: true },
    }, [gemini]);
    const options = await openField('Provider');
    const row = options.find((option) => words(option).startsWith('Gemini'))!;
    expect(words(row)).toContain('Update runner');
    await press(row, 'Gemini needing a runner update');
    expect(where).toBe('/infrastructure');
    expect(patches()).toEqual([]);
  });
});

describe('what each run was routed to, and why', { timeout: 60_000 }, () => {
  const escalated = route({
    level: 'L',
    model: 'claude-opus-5-5',
    effort: 'high',
    escalated: true,
    reasons: [
      'Tier L — raised after run 1 (M) failed its acceptance command',
      `Tier M: suggested by the coordinator — ${REASON}`,
      "Engine claude: this agent's own engine",
      'Opus weekly quota at 41% — no quota step-down needed',
    ],
    decidedAt: '2026-10-03T02:24:00.000Z',
  });

  it('writes model · effort and the tier it ran at, ↑ where a failed run moved it up', async () => {
    await mount(detail({
      sessions: [
        run(RUN_2, { status: 'RUNNING', createdAt: '2026-10-03T02:24:00.000Z', model: 'claude-opus-5-5', effort: 'high', route: escalated }),
        run(RUN_1, { status: 'FAILED', model: 'claude-sonnet-5-5', effort: 'medium', route: route() }),
      ],
    }));
    expect(row(RUN_2).querySelector('.tdp-session-sub')?.textContent).toBe(
      `${short('2026-10-03T02:24:00.000Z')} · Opus 5.5 · high✦ L ↑`,
    );
    const second = row(RUN_2).querySelector('.tdp-route-tag');
    expect(second?.textContent).toBe('✦ L ↑');
    expect(second?.classList.contains('is-up')).toBe(true);
    const first = row(RUN_1).querySelector('.tdp-route-tag');
    expect(row(RUN_1).querySelector('.tdp-session-sub')?.textContent).toBe(
      `${short('2026-10-03T01:12:00.000Z')} · Sonnet 5.5 · medium✦ M`,
    );
    expect(first?.classList.contains('is-up')).toBe(false);
    // On the pick, there is nothing it would have picked instead.
    expect(panel().querySelector('.tdp-route-would')).toBeNull();
    expect(why(RUN_2)).toBeNull();
  });

  it('opens the Why from the tier — the reasons as decided, the policy and when — and closes it again', async () => {
    await mount(detail({
      sessions: [
        run(RUN_2, { status: 'RUNNING', model: 'claude-opus-5-5', effort: 'high', route: escalated }),
        run(RUN_1, { status: 'FAILED', model: 'claude-sonnet-5-5', effort: 'medium', route: route() }),
      ],
    }));
    const tag = row(RUN_2).querySelector<HTMLElement>('.tdp-route-tag');
    const press = await click(tag, 'the ✦ L ↑ tag');
    // The tag answers in place: the row around it is a link into the run, and it is not followed.
    expect(press.defaultPrevented).toBe(true);
    expect(where).toBe('/tasks');
    expect(tag?.getAttribute('aria-expanded')).toBe('true');
    expect(whyText(why(RUN_2)!)).toEqual({
      title: 'Why Opus 5.5 · high',
      reasons: escalated.reasons,
      foot: `Policy v1 · decided ${short('2026-10-03T02:24:00.000Z')} · a failure from a usage limit would not have moved the tier`,
    });
    expect(why(RUN_1)).toBeNull();

    // A run a failure did not move says nothing about usage limits.
    await click(row(RUN_1).querySelector('.tdp-route-tag'), 'the ✦ M tag');
    expect(why(RUN_2)).toBeNull();
    expect(whyText(why(RUN_1)!)).toEqual({
      title: 'Why Sonnet 5.5 · medium',
      reasons: route().reasons,
      foot: `Policy v1 · decided ${short('2026-10-03T01:12:00.000Z')}`,
    });

    await click(row(RUN_1).querySelector('.tdp-route-tag'), 'the ✦ M tag, again');
    expect(why(RUN_1)).toBeNull();
    expect(where).toBe('/tasks');
  });

  it('on an Agent without smart selection, writes what the run used and, in purple, what it would have picked', async () => {
    const shadow = route({
      level: 'S',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      applied: false,
      reasons: ['Tier S: suggested by the coordinator — a copy change', "Engine claude: this agent's own engine"],
    });
    await mount(detail({
      sessions: [run(RUN_1, { status: 'SUCCEEDED', model: 'claude-opus-5-5', effort: null, route: shadow })],
    }));
    expect(row(RUN_1).querySelector('.tdp-session-sub')?.textContent).toBe(
      `${short('2026-10-03T01:12:00.000Z')} · Opus 5.5 · default effort`,
    );
    expect(row(RUN_1).querySelector('.tdp-route-tag')).toBeNull();
    const would = row(RUN_1).querySelector<HTMLElement>('.tdp-route-would');
    expect(would?.textContent).toBe('✦ Smart selection would have picked Sonnet 5.5 · low (S)');

    const press = await click(would, 'the would-have-picked line');
    expect(press.defaultPrevented).toBe(true);
    expect(where).toBe('/tasks');
    expect(whyText(why(RUN_1)!)).toEqual({
      title: 'Why Sonnet 5.5 · low',
      reasons: shadow.reasons,
      foot: `Policy v1 · decided ${short('2026-10-03T01:12:00.000Z')}`,
    });
  });

  it('adds no tier and no purple line to a run that was not routed, or that predates routing', async () => {
    await mount(detail({
      modelHint: null,
      modelHintReason: null,
      sessions: [
        run(RUN_3, {
          model: 'claude-fable-5-1',
          effort: 'max',
          route: route({ level: null, model: null, effort: 'max', applied: false, reasons: ["No suggestion — keeps the agent's model, as today"] }),
        }),
        run(RUN_2, { model: 'claude-opus-5-5', effort: 'xhigh' }),
        // Not claimed yet, and never routed: nothing is known about its model.
        run(RUN_1, { status: 'PENDING' }),
      ],
    }));
    // A model no tier names still reads as its runner's catalogue names it.
    expect(row(RUN_3).querySelector('.tdp-session-sub')?.textContent).toBe(
      `${short('2026-10-03T01:12:00.000Z')} · Fable 5.1 · max`,
    );
    expect(row(RUN_2).querySelector('.tdp-session-sub')?.textContent).toBe(
      `${short('2026-10-03T01:12:00.000Z')} · Opus 5.5 · xhigh`,
    );
    expect(row(RUN_1).querySelector('.tdp-session-sub')?.textContent).toBe(short('2026-10-03T01:12:00.000Z'));
    expect(panel().querySelector('.tdp-route-tag')).toBeNull();
    expect(panel().querySelector('.tdp-route-would')).toBeNull();
  });
});

describe('with the account switch off', { timeout: 60_000 }, () => {
  const cases: Array<[string, UserPreferences]> = [
    ['preferences without modelRouting', {}],
    ['modelRouting: false', { modelRouting: false }],
  ];
  for (const [what, preferences] of cases) {
    it(`(${what}) nothing of smart selection shows`, async () => {
      const shadow = route({ level: 'S', model: 'claude-sonnet-5-5', effort: 'low', applied: false });
      // Everything that draws smart selection while it is on: a tier and its reason, an assignee with
      // the Agent switch on, a run on the pick, a run beside it, and a run not claimed yet.
      await mount(
        detail({
          sessions: [
            run(RUN_3, { status: 'PENDING', route: route({ level: 'L', model: 'claude-opus-5-5', effort: 'high' }) }),
            run(RUN_2, { status: 'RUNNING', model: 'claude-sonnet-5-5', effort: 'medium', route: route() }),
            run(RUN_1, { status: 'SUCCEEDED', model: 'claude-opus-5-5', effort: null, route: shadow }),
          ],
        }),
        { modelRouting: true },
        {},
        [],
        preferences,
      );

      // Details: no Suggested, and Model's placeholder is the one it always had.
      expect(labels().slice(0, 4)).toEqual(['Assignee', 'Engine', 'Provider', 'Model']);
      expect(labels()).not.toContain('Suggested');
      expect(panel().querySelector('.tdp-hint-value')).toBeNull();
      expect(panel().textContent).not.toContain(`Coordinator: ${REASON}`);
      expect(placeholderOf('Model')).toBe('Provider default');

      // Runs: what each run used, and nothing about what smart selection picked or would have.
      expect(row(RUN_3).querySelector('.tdp-session-sub')?.textContent).toBe(short('2026-10-03T01:12:00.000Z'));
      expect(row(RUN_2).querySelector('.tdp-session-sub')?.textContent).toBe(
        `${short('2026-10-03T01:12:00.000Z')} · Sonnet 5.5 · medium`,
      );
      expect(row(RUN_1).querySelector('.tdp-session-sub')?.textContent).toBe(
        `${short('2026-10-03T01:12:00.000Z')} · Opus 5.5 · default effort`,
      );
      expect(panel().querySelector('.tdp-route-tag')).toBeNull();
      expect(panel().querySelector('.tdp-route-would')).toBeNull();
      expect(panel().querySelector('.tdp-route-why')).toBeNull();
      expect(panel().textContent).not.toContain('✦');
      expect(panel().textContent).not.toContain('Smart selection');
      expect(panel().textContent).not.toContain('would have picked');
    });
  }
});
