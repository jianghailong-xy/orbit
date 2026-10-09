// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIKI_DEFAULT_SPACE_SETTINGS, type WikiSpaceSettings, type WikiSystemModelRead, type WikiSystemModelReadState } from '@orbit/shared';
import type { WikiSpaceRow } from '../lib/wiki';
import { WikiSettingsPage } from './WikiSettingsPage';

/**
 * Wiki settings, driven in a document (criterion 8, mocks 19–20): the three modes in their order with
 * Tiered tagged default, the spot check that only Automatic can use, the fallback sentence, and the
 * maintenance card — off with Set up…, the form that turns it on, and on with Edit and Turn off.
 *
 * WHAT REACHES THE SERVER IS THE CLAIM: every control writes at once through
 * `PATCH /api/wiki/spaces/:id`, so the fetch below records each body and the tests read them.
 */

const SPACE_ID = '0196b300-0000-7000-8000-0000000000aa';
const WORKSPACE_ID = '0196b300-0000-7000-8000-0000000000bb';

function space(settings: Partial<WikiSpaceSettings> = {}): WikiSpaceRow {
  return {
    id: SPACE_ID,
    slug: 'orbit',
    title: 'orbit',
    repoUrlNorm: 'github.com/jianghailong-xy/orbit',
    rootCommitSha: null,
    settings: { ...WIKI_DEFAULT_SPACE_SETTINGS, ...settings } as WikiSpaceSettings,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    pendingOps: 0,
  };
}

let patches: Array<Record<string, unknown>> = [];
/** What `GET /api/wiki/system-model` answers; null is a control plane from before the read (a 404). */
let systemModel: WikiSystemModelRead | null = null;

/** The server's words and the model's five states (`src/shared/src/wiki-server-execution.fixture.json`). */
interface ServerFixture {
  settings: {
    rows: string[];
    form: { fields: Array<{ label: string; note: string }> };
    maintenanceNote: string;
    privacy: string;
    automaticNote: string;
    models: Array<{ status: { state: WikiSystemModelReadState; model: string | null }; label: string; state: string; tone: string }>;
  };
}

function serverFixture(): ServerFixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-server-execution.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-server-execution.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-server-execution.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as ServerFixture;
}

const SERVER = serverFixture();

/** The System model as the read answers it while the server executes this account's wiki. */
function servedBy(state: WikiSystemModelReadState = 'up', model: string | null = 'qwen3.8-27b-fp8'): WikiSystemModelRead {
  return {
    state, model, since: '2026-10-08T06:00:00.000Z', checkedAt: '2026-10-08T06:29:55.000Z', workerSeenAt: '2026-10-08T06:29:55.000Z',
    executor: { mode: 'canary', serverExecutes: true },
  };
}

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'PATCH' && url === `/api/wiki/spaces/${SPACE_ID}`) {
    patches.push(JSON.parse(String(init.body)));
    return reply(200, {});
  }
  if (url === '/api/workspaces') {
    return reply(200, [
      { id: WORKSPACE_ID, name: 'orbit', runner: { id: 'r', name: 'wikova', displayName: null } },
      { id: 'other', name: 'wikids', runner: { id: 'r2', name: 'workstation', displayName: null } },
    ]);
  }
  if (url === '/api/wiki/system-model') {
    return systemModel ? reply(200, systemModel) : reply(404, { message: 'Cannot GET /api/wiki/system-model' });
  }
  if (url === '/api/providers') {
    return reply(200, [
      { slug: 'local-vllm', label: 'local-vllm', runtime: 'claude', models: [{ value: 'qwen3.8-27b-fp8', label: 'qwen' }], defaultModel: 'qwen3.8-27b-fp8' },
      { slug: 'deepseek', label: 'DeepSeek', runtime: 'opencode', models: [], defaultModel: null },
    ]);
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('fetch', vi.fn(serve));
  patches = [];
  systemModel = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(row: WikiSpaceRow): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiSettingsPage space={row} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = (): string => (container.textContent ?? '').replace(/\s+/g, ' ');

function radio(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLLabelElement>('.wk-mode label')].find((one) =>
    one.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no ${label} mode`);
  return found.querySelector<HTMLElement>('[role="radio"]')!;
}

/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which a
 *  list option needs before it takes a click as a choice rather than a keyboard activation. */
async function press(element: Element): Promise<void> {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (one) => one.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('Wiki settings', () => {
  it('draws Review mode then Maintenance, the three modes in order with Tiered the default', async () => {
    await mount(space({ reviewMode: 'tiered' }));
    const page = text();
    expect(page).toContain('Wiki settings');
    expect(page).toContain('orbit · github.com/jianghailong-xy/orbit');
    expect(page.indexOf('Review mode')).toBeLessThan(page.indexOf('Maintenance'));
    expect(page).toContain('Only you can switch it');
    const modes = [...container.querySelectorAll('.wk-mode .wk-mode-t')].map((node) => node.textContent);
    expect(modes).toEqual(['Manual', 'Tiered', 'Automatic']);
    expect(container.querySelector('.wk-mode.on .wk-mode-t')?.textContent).toBe('Tiered');
    expect(container.querySelector('.wk-mode-tag')?.closest('.wk-mode')?.textContent).toContain('Tiered');
    expect(page.indexOf('Spot-check Automatic')).toBeGreaterThan(page.indexOf('local-vllm checks each change'));
    expect(page).toContain('Always asks you, in any mode: principles, anything a session proposed');
  });

  it('switches the mode through the owner’s door, and lets only Automatic take spot checks', async () => {
    await mount(space({ reviewMode: 'tiered' }));
    const spot = container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(spot.getAttribute('aria-disabled')).toBe('true');
    await act(async () => radio('Automatic').click());
    await settle();
    expect(patches).toEqual([{ reviewMode: 'automatic' }]);
  });

  it('turns Automatic’s spot checks on', async () => {
    await mount(space({ reviewMode: 'automatic', automaticSpotChecks: false }));
    const spot = container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(spot.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => spot.click());
    await settle();
    expect(patches).toEqual([{ automaticSpotChecks: true }]);
  });

  it('says when Automatic sent itself back to Tiered, and not once the owner chose again', async () => {
    await mount(space({ reviewMode: 'tiered', reviewModeChangedBy: 'verification', reviewModeChangedAt: '2026-09-27T12:00:00.000Z' }));
    expect(text()).toContain('Automatic switched itself back to Tiered on Sep 27');
    act(() => root.unmount());
    root = createRoot(container);
    await mount(space({ reviewMode: 'tiered', reviewModeChangedBy: 'owner', reviewModeChangedAt: '2026-09-28T12:00:00.000Z' }));
    expect(text()).not.toContain('switched itself back');
  });

  it('sets maintenance up: the workspace named for the space, local-vllm, 8 runs a day, the last 14 days', async () => {
    await mount(space());
    expect(text()).toContain('Wiki maintenance');
    expect(container.querySelector('.wk-maint-state')?.textContent).toContain('Off');
    await act(async () => button('Set up…', container).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Set up maintenance');
    const fields = [...dialog.querySelectorAll('.wk-setup-k')].map((node) => node.textContent);
    expect(fields).toEqual(['Workspace', 'Provider', 'Daily limit', 'Look back']);
    expect(dialog.textContent).toContain('orbit · wikova');
    expect(dialog.textContent).toContain('local-vllm');
    expect(dialog.textContent).toContain('runs a day');
    expect(dialog.textContent).toContain('Last 14 days');
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="days"]')?.value).toBe('14');
    await act(async () => button('Turn on', dialog).click());
    await settle();
    expect(patches).toEqual([
      { maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 8, lookbackDays: 14 } },
    ]);
  });

  it('looks back as far as the owner picks: all of history, from now on, or days they type', async () => {
    await mount(space());
    const setUp = async (): Promise<HTMLElement> => {
      await act(async () => button('Set up…', container).click());
      await settle();
      return document.querySelector<HTMLElement>('[role="dialog"]')!;
    };
    const pick = async (label: string): Promise<void> => {
      await act(async () => document.getElementById('wk-setup-lookback')!.click());
      await settle();
      const options = [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
      expect(options.map((option) => option.textContent)).toEqual(['From now on', 'Last 14 days', 'All history']);
      await press(options.find((option) => option.textContent === label)!);
    };

    let dialog = await setUp();
    await pick('All history');
    expect(dialog.querySelector('input[aria-label="days"]'), 'no days to type for all of history').toBeNull();
    await act(async () => button('Turn on', dialog).click());
    await settle();

    dialog = await setUp();
    await pick('From now on');
    await act(async () => button('Turn on', dialog).click());
    await settle();

    dialog = await setUp();
    const days = dialog.querySelector<HTMLInputElement>('input[aria-label="days"]')!;
    await act(async () => {
      days.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(days, '30');
      days.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => days.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    expect(dialog.textContent).toContain('Last 30 days');
    await act(async () => button('Turn on', dialog).click());
    await settle();

    expect(patches.map((body) => (body.maintenance as { lookbackDays?: unknown }).lookbackDays)).toEqual([null, 0, 30]);
  });

  it('shows maintenance on — where, on what, how often, how far back — and turns it off', async () => {
    await mount(
      space({
        maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 6, lookbackDays: 30, listId: 'list' },
      }),
    );
    const rows = [...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent);
    expect(rows).toEqual(['Status', 'Workspace', 'Provider', 'Daily limit', 'Look back']);
    const page = text();
    expect(page).toContain('orbit · wikova');
    expect(page).toContain('local-vllm · pinned, no fallback');
    expect(page).toContain('6 runs a day');
    expect(page).toContain('Last 30 days');
    await act(async () => button('Turn off', container).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: false } }]);
  });
});

describe('Wiki settings while the server executes the account’s wiki (mock 35 ①②)', () => {
  const ON = { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 6, lookbackDays: 30, listId: 'list' };

  it('names the System model and its state instead of a provider, reads the repository from the workspace, and says where the material goes', async () => {
    systemModel = servedBy();
    await mount(space({ reviewMode: 'automatic', maintenance: ON }));
    const rows = [...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent);
    expect(rows).toEqual(SERVER.settings.rows);
    const page = text();
    expect(page).toContain('orbit · wikova');
    expect(container.querySelector('.wk-maint-rows .wk-model-line')?.textContent).toBe('System model · qwen3.8-27b-fp8Up');
    expect(container.querySelector('.wk-maint-rows .wk-model-state')?.className).toBe('wk-model-state up');
    expect(page).not.toContain('pinned, no fallback');
    expect(page).not.toContain('local-vllm');
    expect(container.querySelector('.wk-privacy')?.textContent).toBe(SERVER.settings.privacy);
    // Automatic's sentence names who checks: the System model.
    expect(container.querySelector('.wk-mode.on .wk-mode-d')?.textContent).toBe(SERVER.settings.automaticNote);
  });

  it('says each of the model’s five states in its words and colour', async () => {
    for (const one of SERVER.settings.models) {
      systemModel = servedBy(one.status.state, one.status.model);
      await mount(space({ maintenance: ON }));
      const line = container.querySelector('.wk-maint-rows .wk-model-line');
      expect(line?.textContent, one.status.state).toBe(`${one.label}${one.state}`);
      expect(line?.querySelector('.wk-model-state')?.className, one.status.state).toBe(`wk-model-state ${one.tone}`);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('sets maintenance up with no provider to pick, and writes none', async () => {
    systemModel = servedBy();
    await mount(space());
    expect(container.querySelector('.wk-maint-d')?.textContent).toBe(SERVER.settings.maintenanceNote);
    expect(container.querySelector('.wk-privacy')?.textContent).toBe(SERVER.settings.privacy);
    await act(async () => button('Set up…', container).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('.wk-modal-note')?.textContent).toBe(SERVER.settings.maintenanceNote);
    expect([...dialog.querySelectorAll('.wk-setup-k')].map((node) => node.textContent)).toEqual(SERVER.settings.form.fields.map((field) => field.label));
    expect([...dialog.querySelectorAll('.wk-setup-d')].map((node) => node.textContent)).toEqual(SERVER.settings.form.fields.map((field) => field.note));
    expect(dialog.querySelector('#wk-setup-provider'), 'no provider picker').toBeNull();
    expect(dialog.querySelector('.wk-setup-model')?.textContent).toBe('System model · qwen3.8-27b-fp8Up');
    expect(dialog.querySelector('.wk-privacy')?.textContent).toBe(SERVER.settings.privacy);
    await act(async () => button('Turn on', dialog).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: true, workspaceId: WORKSPACE_ID, dailyRunLimit: 8, lookbackDays: 14 } }]);
  });

  it('is what it always was under runner, and for a control plane that predates the read', async () => {
    for (const read of [{ ...servedBy(), executor: { mode: 'runner' as const, serverExecutes: false } }, null]) {
      systemModel = read;
      await mount(space({ reviewMode: 'automatic', maintenance: ON }));
      expect([...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent))
        .toEqual(['Status', 'Workspace', 'Provider', 'Daily limit', 'Look back']);
      expect(text()).toContain('local-vllm · pinned, no fallback');
      expect(container.querySelector('.wk-privacy')).toBeNull();
      expect(container.querySelector('.wk-mode.on .wk-mode-d')?.textContent).toContain('local-vllm checks each change');
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});
