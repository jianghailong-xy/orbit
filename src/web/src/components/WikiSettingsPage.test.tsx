// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WIKI_DEFAULT_SPACE_SETTINGS,
  WIKI_EXECUTOR_READ,
  type WikiSpaceSettings,
  type WikiSpaceWorkspaces,
  type WikiSystemModelRead,
  type WikiSystemModelReadState,
} from '@orbit/shared';
import type { WikiSpaceRow } from '../lib/wiki';
import { WIKI_MODE_NOTES } from '../lib/wikiReviewMode';
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
/** Every `DELETE /api/wiki/spaces/:id` (Move to Trash) the page sent; a refusal when `deleteRefused` is set. */
let deletes: string[] = [];
let deleteRefused: string | null = null;
/** What `GET /api/wiki/trash` answers. */
let trash: Array<{ id: string; slug: string; title: string; repoUrlNorm: string | null; deletedAt: string; purgeAt: string; entries: number }> = [];
let pathname = '';
/** What `GET /api/wiki/spaces/:id/workspaces` answers, and the writes the Workspaces card made. */
let members: WikiSpaceWorkspaces = { workspaces: [], addable: [] };
let memberWrites: string[] = [];
/** Every path the page read. */
let reads: string[] = [];
/** What `GET /api/wiki/system-model` answers; null is a control plane from before the read (a 404). */
let systemModel: WikiSystemModelRead | null = null;

/** The server's words and the model's five states (`src/shared/src/wiki-server-execution.fixture.json`). */
interface ServerFixture {
  settings: {
    rows: string[];
    form: { fields: Array<{ label: string; note: string }> };
    maintenanceNote: string;
    privacy: string;
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

/** The System model as the read answers it: the server executes every account's wiki (`WIKI_EXECUTOR_READ`, P11). */
function servedBy(state: WikiSystemModelReadState = 'up', model: string | null = 'qwen3.8-27b-fp8'): WikiSystemModelRead {
  return {
    state, model, since: '2026-10-08T06:00:00.000Z', checkedAt: '2026-10-08T06:29:55.000Z', workerSeenAt: '2026-10-08T06:29:55.000Z',
    executor: WIKI_EXECUTOR_READ,
  };
}

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'PATCH' && url === `/api/wiki/spaces/${SPACE_ID}`) {
    patches.push(JSON.parse(String(init.body)));
    return reply(200, {});
  }
  if (init?.method === 'DELETE' && url === `/api/wiki/spaces/${SPACE_ID}`) {
    deletes.push(url);
    return deleteRefused ? reply(503, { message: deleteRefused }) : reply(200, { spaceId: SPACE_ID });
  }
  reads.push(url);
  if (url === `/api/wiki/spaces/${SPACE_ID}/health`) return reply(200, { entries: 2606, maintenance: { look: 'off' } });
  if (url === '/api/wiki/spaces') return reply(200, [space()]);
  if (url === '/api/wiki/trash') return reply(200, { spaces: trash });
  const members_ = `/api/wiki/spaces/${SPACE_ID}/workspaces`;
  if (url === members_ && (init?.method ?? 'GET') === 'GET') return reply(200, members);
  if (url.startsWith(members_)) {
    const body = init?.body ? ` ${JSON.parse(String(init.body)).workspaceId as string}` : '';
    memberWrites.push(`${init?.method} ${url.slice(members_.length)}${body}`);
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
  deletes = [];
  deleteRefused = null;
  trash = [];
  members = { workspaces: [], addable: [] };
  memberWrites = [];
  reads = [];
  systemModel = servedBy();
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

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

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
        <MemoryRouter initialEntries={['/wiki/orbit/settings']}>
          <WikiSettingsPage space={row} />
          <RouterProbe />
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
  it('draws Review mode, Workspaces, Maintenance, then Move to Trash, the three modes in order with Tiered the default', async () => {
    await mount(space({ reviewMode: 'tiered' }));
    const page = text();
    expect(page).toContain('Wiki settings');
    expect(page).toContain('orbit · github.com/jianghailong-xy/orbit');
    const titles = [...container.querySelectorAll('.orbit-card-title')].map((node) => node.textContent);
    expect(titles).toEqual(['Review mode', 'Workspaces', 'Maintenance', 'Move to Trash']);
    expect(page).toContain('Only you can switch it');
    const modes = [...container.querySelectorAll('.wk-mode .wk-mode-t')].map((node) => node.textContent);
    expect(modes).toEqual(['Manual', 'Tiered', 'Automatic']);
    expect(container.querySelector('.wk-mode.on .wk-mode-t')?.textContent).toBe('Tiered');
    expect(container.querySelector('.wk-mode-tag')?.closest('.wk-mode')?.textContent).toContain('Tiered');
    expect(page.indexOf('Spot-check Automatic')).toBeGreaterThan(page.indexOf('The System model checks each change'));
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

  it('sets maintenance up: the workspace named for the space, the System model, 8 runs a day, the last 14 days', async () => {
    await mount(space());
    expect(text()).toContain('Wiki maintenance');
    expect(container.querySelector('.wk-maint-state')?.textContent).toContain('Off');
    await act(async () => button('Set up…', container).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Set up maintenance');
    expect(dialog.textContent).toContain('orbit · wikova');
    expect(dialog.textContent).toContain('runs a day');
    expect(dialog.textContent).toContain('Last 14 days');
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="days"]')?.value).toBe('14');
    await act(async () => button('Turn on', dialog).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: true, workspaceId: WORKSPACE_ID, dailyRunLimit: 8, lookbackDays: 14 } }]);
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
    // A space set up before server execution still reads its provider and its hidden list back (history): neither is shown.
    await mount(
      space({
        maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 6, lookbackDays: 30, listId: 'list' },
      }),
    );
    const rows = [...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent);
    expect(rows).toEqual(SERVER.settings.rows);
    const page = text();
    expect(page).toContain('orbit · wikova');
    expect(page).not.toContain('local-vllm');
    expect(page).toContain('6 runs a day');
    expect(page).toContain('Last 30 days');
    await act(async () => button('Turn off', container).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: false } }]);
  });
});

describe('The Workspaces card (mock 38)', () => {
  const row = (id: string, name: string, inWiki: boolean, runner: string | null = 'build-01') => ({ id, name, runner, inWiki });
  const rows = () => [...container.querySelectorAll<HTMLElement>('.wk-ws-row')];
  const toggle = (name: string) => container.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`)!;

  it('lists the workspaces in this wiki, and says what a left-out one means', async () => {
    members = { workspaces: [row('a', 'shop-cli @ EU', false), row('b', 'shop-cli @ SG', true), row('c', 'notes', true, null)], addable: [] };
    await mount(space());
    expect(rows().map((one) => one.querySelector('.wk-ws-t')?.textContent)).toEqual([
      'shop-cli @ EU · build-01', 'shop-cli @ SG · build-01', 'notes',
    ]);
    expect(rows().map((one) => one.querySelector('.wk-ws-d')?.textContent ?? null)).toEqual([
      'Left out. It stays out until you turn it back on.', null, null,
    ]);
    expect(rows().map((one) => one.classList.contains('off'))).toEqual([true, false, false]);
    expect(toggle('shop-cli @ EU').getAttribute('aria-checked')).toBe('false');
    expect(toggle('shop-cli @ SG').getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('Agents in these workspaces read this wiki, and maintenance learns from their sessions.');
    expect(text()).toContain('New workspaces on this repository join by themselves. A workspace on another repository has its own wiki.');
  });

  it('leaves one out and turns one back on through the owner’s door, at once', async () => {
    members = { workspaces: [row('a', 'shop-cli @ EU', false), row('b', 'shop-cli @ SG', true)], addable: [] };
    await mount(space());
    await press(toggle('shop-cli @ SG'));
    expect(memberWrites).toEqual(['DELETE /b']);
    await press(toggle('shop-cli @ EU'));
    expect(memberWrites).toEqual(['DELETE /b', 'POST  a']);
    expect(patches).toEqual([]);
  });

  it('offers the workspaces with no repository, and adds the one picked', async () => {
    members = { workspaces: [row('b', 'shop-cli @ SG', true)], addable: [row('n', 'notes', false), row('s', 'scratch', false, null)] };
    await mount(space());
    await act(async () => button('Add workspace…').click());
    await settle();
    const menu = document.body.querySelector('.orbit-menu')!;
    expect(menu.querySelector('.orbit-menu-group-label')?.textContent).toBe('Workspaces with no repository');
    const items = [...menu.querySelectorAll<HTMLElement>('.orbit-menu-item')];
    expect(items.map((item) => item.textContent)).toEqual(['notes · build-01', 'scratch']);
    await act(async () => items[0].click());
    await settle();
    expect(memberWrites).toEqual(['POST  n']);
  });

  it('draws no Add workspace when there is nothing to add', async () => {
    members = { workspaces: [row('b', 'shop-cli @ SG', true)], addable: [] };
    await mount(space());
    expect([...container.querySelectorAll('button')].map((one) => one.textContent)).not.toContain('Add workspace…');
  });

  it('says so when a wiki with no repository has no workspace yet', async () => {
    members = { workspaces: [], addable: [row('n', 'notes', false)] };
    await mount({ ...space(), repoUrlNorm: null });
    expect(container.querySelector('.wk-ws-empty')?.textContent).toBe('No workspace is in this wiki yet.');
    expect(text()).toContain('This wiki has no repository behind it, so a workspace joins only when you add it.');
    expect(text()).not.toContain('New workspaces on this repository');
    expect(button('Add workspace…')).toBeTruthy();
  });
});

describe('Move to Trash (docs/mocks/wiki-trash)', () => {
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

  it('says Trash keeps it, and asks before it moves anything', async () => {
    await mount(space());
    expect(text()).toContain('Move to Trash');
    expect(text()).toContain('It stays in Trash for 365 days and can be restored until then.');
    await press(button('Move to Trash…'));
    const asked = dialog()!;
    expect(asked.textContent).toContain('Move wiki “orbit” to Trash?');
    expect(asked.textContent).toContain('It leaves your wikis now, and sessions stop reading it.');
    expect(asked.textContent).toContain('Its 2,606 entries stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.');
    expect(asked.textContent).toContain('Until you restore it, the next session on github.com/jianghailong-xy/orbit to use the wiki starts a new, empty one.');
    expect(asked.textContent).toContain('Workspaces and sessions are kept.');
    expect(deletes).toEqual([]);

    await press(button('Cancel', asked));
    expect(dialog()).toBeNull();
    expect(deletes).toEqual([]);
    expect(pathname).toBe('/wiki/orbit/settings');
  });

  it('does not say a new wiki is made for a wiki with no repository', async () => {
    await mount({ ...space(), repoUrlNorm: null, title: 'orbit · vLLM preview' });
    await press(button('Move to Trash…'));
    expect(dialog()!.textContent).not.toContain('the next session');
  });

  it('moves it through the owner’s door and leaves for the wiki `/wiki` opens', async () => {
    await mount(space());
    await press(button('Move to Trash…'));
    await press(button('Move to Trash', dialog()!));
    expect(deletes).toEqual([`/api/wiki/spaces/${SPACE_ID}`]);
    expect(pathname).toBe('/wiki');
  });

  it('says a refusal in the dialog, and stays on the page', async () => {
    deleteRefused = 'Couldn’t reach the server. Nothing was moved. Try again.';
    await mount(space());
    await press(button('Move to Trash…'));
    await press(button('Move to Trash', dialog()!));
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(deleteRefused);
    expect(pathname).toBe('/wiki/orbit/settings');
  });

  it('leads to nothing under the card while Trash is empty', async () => {
    await mount(space());
    expect(text()).not.toContain('Open Trash');
  });

  it('leads to Trash under the card while anything is in it, and opens it where the reader is', async () => {
    trash = [{
      id: 'gone', slug: 'gone', title: 'gone', repoUrlNorm: null,
      deletedAt: '2026-11-07T12:00:00.000Z', purgeAt: '2027-11-07T12:00:00.000Z', entries: 3,
    }];
    await mount(space());
    expect(text()).toContain('Trash holds 1 wiki. Open Trash');
    await press(button('Open Trash'));
    const opened = document.body.querySelector<HTMLElement>('.wk-trash-dialog')!;
    expect(opened.textContent).toContain('Moved to Trash Nov 7, 2026 · 3 entries · deleted for good Nov 7, 2027');
    expect(pathname).toBe('/wiki/orbit/settings');
  });
});

describe('Wiki settings name the System model (mock 35 ①②)', () => {
  const ON = { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 6, lookbackDays: 30, listId: 'list' };

  it('names the System model and its state, reads the repository from the workspace, and says where the material goes', async () => {
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
    expect(container.querySelector('.wk-mode.on .wk-mode-d')?.textContent).toBe(WIKI_MODE_NOTES.automatic);
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
    // Nothing is listed to pick from: the page never asks for the account's providers.
    expect(reads.filter((url) => url.startsWith('/api/providers'))).toEqual([]);
    await act(async () => button('Turn on', dialog).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: true, workspaceId: WORKSPACE_ID, dailyRunLimit: 8, lookbackDays: 14 } }]);
  });

  it('draws no System model and no privacy note while the read does not say the server executes the account’s wiki', async () => {
    // A control plane from before the read (a 404), and a read from before `executor`.
    for (const read of [null, { ...servedBy(), executor: undefined }]) {
      systemModel = read;
      await mount(space({ reviewMode: 'automatic', maintenance: ON }));
      const rows = [...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent);
      expect(rows).toEqual(SERVER.settings.rows.filter((row) => row !== 'Model'));
      expect(container.querySelector('.wk-model-line')).toBeNull();
      expect(container.querySelector('.wk-privacy')).toBeNull();
      expect(text()).not.toContain('local-vllm');
      expect(container.querySelector('.wk-mode.on .wk-mode-d')?.textContent).toBe(WIKI_MODE_NOTES.automatic);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});
