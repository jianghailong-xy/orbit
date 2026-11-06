// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiSpaceRow } from '../lib/wiki';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * A wiki's row's own actions in the sidebar (docs/mocks/wiki-delete, contract `space.delete`): a ⋯ on the row, and a
 * right-click anywhere on it, open Wiki settings and Delete wiki…, which asks first, naming the wiki and how much goes.
 * The row is a link, so what the claim has to hold is that a press on its menu opens no wiki.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  fetchAvatarDataUrl: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');

const space = (slug: string, over: Partial<WikiSpaceRow> = {}): WikiSpaceRow =>
  ({
    id: `id-${slug}`,
    slug,
    title: slug,
    repoUrlNorm: `github.com/jianghailong-xy/${slug}`,
    pendingOps: 0,
    planWaiting: 0,
    workspaceIds: [],
    docs: null,
    ...over,
  }) as WikiSpaceRow;

const PREVIEW = space('orbit-vllm-preview', { title: 'orbit · vLLM preview', repoUrlNorm: null });
const REFUSAL = 'Couldn’t reach the server. Nothing was deleted. Try again.';

let wikis: WikiSpaceRow[] = [];
let deletes: string[] = [];
let refuse = false;
let healthFails = false;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let location = '';
let closed = 0;

function RouterProbe() {
  location = useLocation().pathname;
  return null;
}

function serve() {
  vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') {
      deletes.push(path);
      if (refuse) throw new Error(REFUSAL);
      wikis = wikis.filter((one) => path !== `/wiki/spaces/${one.id}`);
      return { spaceId: path };
    }
    if (path === '/wiki/spaces') return wikis;
    if (path.endsWith('/health')) {
      if (healthFails) throw new Error('the read failed');
      return { entries: path.includes('preview') ? 2606 : 5120, maintenance: { look: 'off' } };
    }
    if (path === '/runners' || path === '/workspaces' || path === '/projects/sidebar' || path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  serve();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel onNavigate={() => { closed += 1; }} />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const rows = () => [...container!.querySelectorAll<HTMLElement>('.tp-group-wiki .tp-item')];
const rowNames = () => rows().map((row) => text(row.querySelector('.tp-label')));
const row = (name: string) => rows().find((one) => text(one.querySelector('.tp-label')) === name)!;
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const menuItem = (label: string) => menuItems().find((item) => text(item) === label)!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
const titleOf = (el: Element) => text(document.getElementById(el.getAttribute('aria-labelledby') ?? ''));
const bodyOf = (el: Element) => [...document.getElementById(el.getAttribute('aria-describedby') ?? '')!.querySelectorAll('.wk-delete-lines > div')].map(text);
const button = (label: string, within: ParentNode) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((one) => text(one) === label)!;

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

async function openMenu(name: string): Promise<string[]> {
  await click(row(name).querySelector<HTMLElement>('.tp-workspace-more')!);
  return menuItems().map((item) => text(item)!);
}

async function askDelete(name: string): Promise<HTMLElement> {
  await openMenu(name);
  await click(menuItem('Delete wiki…'));
  return dialog()!;
}

beforeEach(() => {
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
  wikis = [space('orbit', { docs: { written: 30, total: 35 } }), PREVIEW];
  deletes = [];
  refuse = false;
  healthFails = false;
  closed = 0;
  toast.success.mockClear();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe('a wiki row’s menu', () => {
  it('offers Wiki settings and Delete wiki… from the row’s ⋯, and opens no wiki', async () => {
    await visit('/tasks');
    expect(await openMenu('orbit · vLLM preview')).toEqual(['Wiki settings', 'Delete wiki…']);
    expect(menuItem('Delete wiki…').getAttribute('data-danger')).not.toBeNull();
    expect(location).toBe('/tasks');
  });

  it('opens the same menu on a right-click anywhere on the row, instead of the browser’s', async () => {
    await visit('/tasks');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      row('orbit').querySelector('.tp-label')!.dispatchEvent(event);
    });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(menuItems().map((item) => text(item))).toEqual(['Wiki settings', 'Delete wiki…']);
    expect(row('orbit').classList.contains('menu-open')).toBe(true);
    expect(location).toBe('/tasks');
  });

  it('takes Enter on its ⋯ as the menu’s, though the row around it is a link', async () => {
    await visit('/tasks');
    const more = row('orbit').querySelector<HTMLElement>('.tp-workspace-more')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      more.dispatchEvent(enter);
    });
    await settle();
    expect(location).toBe('/tasks');
    expect(closed).toBe(0);
  });

  it('still opens the wiki from the rest of the row', async () => {
    await visit('/tasks');
    await click(row('orbit'));
    expect(location).toBe('/wiki/orbit');
  });

  it('Wiki settings opens the wiki’s settings, and tells the drawer to close', async () => {
    await visit('/tasks');
    await openMenu('orbit · vLLM preview');
    await click(menuItem('Wiki settings'));
    expect(location).toBe('/wiki/orbit-vllm-preview/settings');
    expect(closed).toBe(1);
  });
});

describe('where the row’s ⋯ shows', () => {
  it('takes the place of what waits in the wiki on the desktop sidebar, as a workspace’s does', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const swap = /\.app-shell \.app-nav:not\(\.collapsed\) \.tp-group-wiki \.tp-item:hover \.tp-count\.needs-you,\s*\.app-shell \.app-nav:not\(\.collapsed\) \.tp-group-wiki \.tp-item\.menu-open \.tp-count\.needs-you \{\s*display: none;/;
    expect(styles).toMatch(swap);
    expect(styles.slice(styles.lastIndexOf('@media', styles.search(swap)), styles.search(swap))).toMatch(/^@media \(min-width: 961px\) \{/);
  });
});

describe('Delete wiki…', () => {
  it('asks first, naming the wiki and how much goes, with Cancel where the keyboard lands', async () => {
    await visit('/tasks');
    const confirm = await askDelete('orbit · vLLM preview');
    expect(titleOf(confirm)).toBe('Delete wiki “orbit · vLLM preview”?');
    expect(bodyOf(confirm)).toEqual([
      'Its 2,606 entries and their history will be permanently deleted. This cannot be undone.',
      'Workspaces and sessions are kept.',
    ]);
    expect(deletes).toEqual([]);
    expect(document.activeElement).toBe(button('Cancel', confirm));
  });

  it('says what a wiki with a repository does next, and counts its documents', async () => {
    await visit('/tasks');
    const confirm = await askDelete('orbit');
    expect(bodyOf(confirm)).toEqual([
      'Its 5,120 entries, 30 documents and their history will be permanently deleted. This cannot be undone.',
      'The next session on github.com/jianghailong-xy/orbit to use the wiki starts a new, empty one.',
      'Workspaces and sessions are kept.',
    ]);
  });

  it('still asks when the count cannot be read, with no number in the sentence', async () => {
    healthFails = true;
    await visit('/tasks');
    const confirm = await askDelete('orbit · vLLM preview');
    expect(bodyOf(confirm)[0]).toBe('Its entries and their history will be permanently deleted. This cannot be undone.');
  });

  it('Cancel deletes nothing', async () => {
    await visit('/tasks');
    await click(button('Cancel', await askDelete('orbit')));
    expect(dialog()).toBeNull();
    expect(deletes).toEqual([]);
    expect(rowNames()).toEqual(['orbit', 'orbit · vLLM preview']);
  });

  it('deletes the wiki and drops its row, and another page stays where it is', async () => {
    await visit('/tasks');
    await click(button('Delete wiki', await askDelete('orbit · vLLM preview')));
    expect(deletes).toEqual(['/wiki/spaces/id-orbit-vllm-preview']);
    expect(dialog()).toBeNull();
    expect(rowNames()).toEqual(['orbit']);
    expect(location).toBe('/tasks');
    expect(closed).toBe(0);
    expect(toast.success).toHaveBeenCalledWith('Deleted wiki “orbit · vLLM preview”');
  });

  it('deleting another wiki from a wiki’s page stays on that page', async () => {
    await visit('/wiki/orbit');
    await click(button('Delete wiki', await askDelete('orbit · vLLM preview')));
    expect(deletes).toEqual(['/wiki/spaces/id-orbit-vllm-preview']);
    expect(location).toBe('/wiki/orbit');
  });

  it('deleting the wiki on screen leaves for the one `/wiki` opens, and closes the drawer', async () => {
    await visit('/wiki/orbit-vllm-preview/settings');
    await click(button('Delete wiki', await askDelete('orbit · vLLM preview')));
    expect(location).toBe('/wiki');
    expect(closed).toBe(1);
  });

  it('deleting the last wiki takes the group away, and leaves the entry', async () => {
    wikis = [PREVIEW];
    await visit('/wiki/orbit-vllm-preview');
    await click(button('Delete wiki', await askDelete('orbit · vLLM preview')));
    expect(container!.querySelector('.tp-group-wiki')).toBeNull();
    expect([...container!.querySelectorAll('.tp-label')].map(text)).toContain('Wiki');
    expect(location).toBe('/wiki');
  });

  it('a refusal is said in the dialog, which stays open, and the wiki stays', async () => {
    refuse = true;
    await visit('/wiki/orbit-vllm-preview');
    await click(button('Delete wiki', await askDelete('orbit · vLLM preview')));
    expect(text(dialog()!.querySelector('[role="alert"]'))).toBe(REFUSAL);
    expect(rowNames()).toEqual(['orbit', 'orbit · vLLM preview']);
    expect(location).toBe('/wiki/orbit-vllm-preview');
  });
});
