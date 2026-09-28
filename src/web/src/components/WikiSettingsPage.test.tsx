// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIKI_DEFAULT_SPACE_SETTINGS, type WikiSpaceSettings } from '@orbit/shared';
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
          <AntApp>
            <WikiSettingsPage space={row} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = (): string => (container.textContent ?? '').replace(/\s+/g, ' ');

function radio(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll<HTMLLabelElement>('.wk-mode label')].find((one) =>
    one.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no ${label} mode`);
  return found.querySelector('input')!;
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
    const spot = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(spot.disabled).toBe(true);
    await act(async () => radio('Automatic').click());
    await settle();
    expect(patches).toEqual([{ reviewMode: 'automatic' }]);
  });

  it('turns Automatic’s spot checks on', async () => {
    await mount(space({ reviewMode: 'automatic', automaticSpotChecks: false }));
    const spot = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(spot.disabled).toBe(false);
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

  it('sets maintenance up: the workspace named for the space, local-vllm, 8 runs a day', async () => {
    await mount(space());
    expect(text()).toContain('Wiki maintenance');
    expect(container.querySelector('.wk-maint-state')?.textContent).toContain('Off');
    await act(async () => button('Set up…', container).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('.ant-modal')!;
    expect(dialog.textContent).toContain('Set up maintenance');
    const fields = [...dialog.querySelectorAll('.wk-setup-k')].map((node) => node.textContent);
    expect(fields).toEqual(['Workspace', 'Provider', 'Daily limit']);
    expect(dialog.textContent).toContain('orbit · wikova');
    expect(dialog.textContent).toContain('local-vllm');
    expect(dialog.textContent).toContain('runs a day');
    await act(async () => button('Turn on', dialog).click());
    await settle();
    expect(patches).toEqual([
      { maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 8 } },
    ]);
  });

  it('shows maintenance on — where, on what, how often — and turns it off', async () => {
    await mount(
      space({ maintenance: { enabled: true, workspaceId: WORKSPACE_ID, provider: 'local-vllm', dailyRunLimit: 6, listId: 'list' } }),
    );
    const rows = [...container.querySelectorAll('.wk-maint-rows > .k')].map((node) => node.textContent);
    expect(rows).toEqual(['Status', 'Workspace', 'Provider', 'Daily limit']);
    const page = text();
    expect(page).toContain('orbit · wikova');
    expect(page).toContain('local-vllm · pinned, no fallback');
    expect(page).toContain('6 runs a day');
    await act(async () => button('Turn off', container).click());
    await settle();
    expect(patches).toEqual([{ maintenance: { enabled: false } }]);
  });
});
