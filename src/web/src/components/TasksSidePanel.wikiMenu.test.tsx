// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiSpaceRow } from '../lib/wiki';
import { wikiTrashHolds } from '../lib/wikiReviewMode';
import { TasksSidePanel } from './TasksSidePanel';
import { WikiTrashLink } from './WikiTrashDialog';

/**
 * A wiki's row's own actions in the sidebar (docs/mocks/wiki-trash, contract `space.trash`): a ⋯ on the row, and a
 * right-click anywhere on it, open Wiki settings and Move to Trash…, which asks first, naming the wiki and how much
 * Trash keeps. Trash itself has no row in the sidebar (docs/mocks/wiki-trash/02-trash-entry): it opens from Wiki
 * settings' line, drawn here beside the sidebar, where a wiki is restored or deleted permanently.
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
const REFUSAL = 'Couldn’t reach the server. Nothing was moved. Try again.';
const TAKEN = 'A newer wiki for github.com/jianghailong-xy/orbit is in your wikis now. Move it to Trash first, then restore this one.';

let wikis: WikiSpaceRow[] = [];
let trashed: WikiSpaceRow[] = [];
let deletes: string[] = [];
let restores: string[] = [];
let refuse = false;
let restoreTaken = false;
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
      if (path.endsWith('/purge')) {
        trashed = trashed.filter((one) => path !== `/wiki/spaces/${one.id}/purge`);
        return { spaceId: path };
      }
      trashed = [...wikis.filter((one) => path === `/wiki/spaces/${one.id}`), ...trashed];
      wikis = wikis.filter((one) => path !== `/wiki/spaces/${one.id}`);
      return { spaceId: path };
    }
    if (options?.method === 'POST' && path.endsWith('/restore')) {
      restores.push(path);
      if (restoreTaken) throw new Error(TAKEN);
      const back = trashed.filter((one) => path === `/wiki/spaces/${one.id}/restore`);
      trashed = trashed.filter((one) => !back.includes(one));
      wikis = [...wikis, ...back];
      return back[0];
    }
    if (path === '/wiki/spaces') return wikis;
    if (path === '/wiki/trash') {
      return {
        spaces: trashed.map((one) => ({
          id: one.id,
          slug: one.slug,
          title: one.title,
          repoUrlNorm: one.repoUrlNorm,
          deletedAt: '2026-11-07T12:00:00.000Z',
          purgeAt: '2027-11-07T12:00:00.000Z',
          entries: one.id.includes('preview') ? 11138 : 1,
        })),
      };
    }
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
          <WikiTrashLink sentence={wikiTrashHolds} />
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
const trashLink = () => container!.querySelector<HTMLElement>('.wk-trash-open');
const trashDialog = () => document.body.querySelector<HTMLElement>('.wk-trash-dialog');
const trashRows = () => [...trashDialog()!.querySelectorAll<HTMLElement>('.wk-trash-row')];
const trashRowNamed = (name: string) => trashRows().find((one) => text(one.querySelector('.wk-trash-name')) === name)!;
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

async function askMove(name: string): Promise<HTMLElement> {
  await openMenu(name);
  await click(menuItem('Move to Trash…'));
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
  trashed = [];
  deletes = [];
  restores = [];
  refuse = false;
  restoreTaken = false;
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
  it('offers Wiki settings and Move to Trash… from the row’s ⋯, and opens no wiki', async () => {
    await visit('/tasks');
    expect(await openMenu('orbit · vLLM preview')).toEqual(['Wiki settings', 'Move to Trash…']);
    expect(menuItem('Move to Trash…').getAttribute('data-danger')).not.toBeNull();
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
    expect(menuItems().map((item) => text(item))).toEqual(['Wiki settings', 'Move to Trash…']);
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

describe('Move to Trash…', () => {
  it('asks first, naming the wiki and what Trash keeps, with Cancel where the keyboard lands', async () => {
    await visit('/tasks');
    const confirm = await askMove('orbit · vLLM preview');
    expect(titleOf(confirm)).toBe('Move wiki “orbit · vLLM preview” to Trash?');
    expect(bodyOf(confirm)).toEqual([
      'It leaves your wikis now, and sessions stop reading it.',
      'Its 2,606 entries stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.',
      'Workspaces and sessions are kept.',
    ]);
    expect(deletes).toEqual([]);
    expect(document.activeElement).toBe(button('Cancel', confirm));
  });

  it('says what a wiki with a repository does meanwhile, and counts its documents', async () => {
    await visit('/tasks');
    const confirm = await askMove('orbit');
    expect(bodyOf(confirm)).toEqual([
      'It leaves your wikis now, and sessions stop reading it.',
      'Its 5,120 entries and 30 documents stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.',
      'Until you restore it, the next session on github.com/jianghailong-xy/orbit to use the wiki starts a new, empty one.',
      'Workspaces and sessions are kept.',
    ]);
  });

  it('still asks when the count cannot be read, with no number in the sentence', async () => {
    healthFails = true;
    await visit('/tasks');
    const confirm = await askMove('orbit · vLLM preview');
    expect(bodyOf(confirm)[1]).toBe('Its entries stay in Trash for 365 days: restore it any time until then. After that it is deleted for good.');
  });

  it('Cancel moves nothing', async () => {
    await visit('/tasks');
    await click(button('Cancel', await askMove('orbit')));
    expect(dialog()).toBeNull();
    expect(deletes).toEqual([]);
    expect(rowNames()).toEqual(['orbit', 'orbit · vLLM preview']);
    expect(trashLink()).toBeNull();
  });

  it('moves the wiki to Trash: its row leaves, no Trash row comes, and another page stays where it is', async () => {
    await visit('/tasks');
    await click(button('Move to Trash', await askMove('orbit · vLLM preview')));
    expect(deletes).toEqual(['/wiki/spaces/id-orbit-vllm-preview']);
    expect(dialog()).toBeNull();
    expect(rowNames()).toEqual(['orbit']);
    expect(container!.querySelector('.tp-group-wiki')!.textContent).not.toContain('Trash');
    expect(text(trashLink()!.parentElement)).toBe('Trash holds 1 wiki. Open Trash');
    expect(location).toBe('/tasks');
    expect(closed).toBe(0);
    expect(toast.success).toHaveBeenCalledWith('Moved wiki “orbit · vLLM preview” to Trash');
  });

  it('moving another wiki from a wiki’s page stays on that page', async () => {
    await visit('/wiki/orbit');
    await click(button('Move to Trash', await askMove('orbit · vLLM preview')));
    expect(deletes).toEqual(['/wiki/spaces/id-orbit-vllm-preview']);
    expect(location).toBe('/wiki/orbit');
  });

  it('moving the wiki on screen leaves for the one `/wiki` opens, and closes the drawer', async () => {
    await visit('/wiki/orbit-vllm-preview/settings');
    await click(button('Move to Trash', await askMove('orbit · vLLM preview')));
    expect(location).toBe('/wiki');
    expect(closed).toBe(1);
  });

  it('moving the last wiki takes the group away and leaves the entry', async () => {
    wikis = [PREVIEW];
    await visit('/wiki/orbit-vllm-preview');
    await click(button('Move to Trash', await askMove('orbit · vLLM preview')));
    expect(container!.querySelector('.tp-group-wiki')).toBeNull();
    expect([...container!.querySelectorAll('.tp-label')].map(text)).toContain('Wiki');
    expect(location).toBe('/wiki');
  });

  it('a refusal is said in the dialog, which stays open, and the wiki stays', async () => {
    refuse = true;
    await visit('/wiki/orbit-vllm-preview');
    await click(button('Move to Trash', await askMove('orbit · vLLM preview')));
    expect(text(dialog()!.querySelector('[role="alert"]'))).toBe(REFUSAL);
    expect(rowNames()).toEqual(['orbit', 'orbit · vLLM preview']);
    expect(location).toBe('/wiki/orbit-vllm-preview');
  });
});

describe('Trash', () => {
  beforeEach(() => {
    trashed = [PREVIEW];
    wikis = [space('orbit', { docs: { written: 30, total: 35 } })];
  });

  it('has no row in the Wiki group, and opens from Wiki settings’ line without leaving the page', async () => {
    await visit('/tasks');
    expect(rowNames()).toEqual(['orbit']);
    expect(container!.querySelector('.tp-group-wiki')!.textContent).not.toContain('Trash');
    await click(trashLink()!);
    expect(location).toBe('/tasks');
    expect(text(trashDialog()!.querySelector('.wk-trash-lead'))).toBe(
      'A wiki stays here for 365 days after it was moved, then it is deleted for good.',
    );
    expect(trashRows().map((one) => [text(one.querySelector('.wk-trash-name')), text(one.querySelector('.wk-trash-line'))])).toEqual([
      ['orbit · vLLM preview', 'Moved to Trash Nov 7, 2026 · 11,138 entries · deleted for good Nov 7, 2027'],
    ]);
  });

  it('restores a wiki: it leaves Trash and comes back to the group', async () => {
    await visit('/tasks');
    await click(trashLink()!);
    await click(button('Restore', trashRowNamed('orbit · vLLM preview')));
    expect(restores).toEqual(['/wiki/spaces/id-orbit-vllm-preview/restore']);
    expect(toast.success).toHaveBeenCalledWith('Restored wiki “orbit · vLLM preview”');
    expect(text(trashDialog()!.querySelector('.wk-trash-empty'))).toBe('Trash is empty.');
    expect(rowNames()).toEqual(['orbit', 'orbit · vLLM preview']);
  });

  it('says under the row why a restore was refused, in the server’s words, and keeps the wiki in Trash', async () => {
    restoreTaken = true;
    await visit('/tasks');
    await click(trashLink()!);
    await click(button('Restore', trashRowNamed('orbit · vLLM preview')));
    expect(text(trashRowNamed('orbit · vLLM preview').querySelector('[role="alert"]'))).toBe(TAKEN);
    expect(rowNames()).toEqual(['orbit']);
  });

  it('asks before deleting a wiki permanently, and Cancel deletes nothing', async () => {
    await visit('/tasks');
    await click(trashLink()!);
    await click(button('Delete permanently…', trashRowNamed('orbit · vLLM preview')));
    const confirm = dialog()!;
    expect(titleOf(confirm)).toBe('Delete permanently?');
    expect(text(document.getElementById(confirm.getAttribute('aria-describedby') ?? ''))).toBe(
      'Its 11,138 entries and their history will be permanently deleted. This cannot be undone.',
    );
    await click(button('Cancel', confirm));
    expect(deletes).toEqual([]);
    expect(trashRows()).toHaveLength(1);
  });

  it('deletes a wiki permanently: it leaves Trash, and the line goes once Trash is empty', async () => {
    await visit('/tasks');
    await click(trashLink()!);
    await click(button('Delete permanently…', trashRowNamed('orbit · vLLM preview')));
    await click(button('Delete permanently', dialog()!));
    expect(deletes).toEqual(['/wiki/spaces/id-orbit-vllm-preview/purge']);
    expect(text(trashDialog()!.querySelector('.wk-trash-empty'))).toBe('Trash is empty.');
    await click(button('Close', trashDialog()!));
    expect(trashDialog()).toBeNull();
    expect(trashLink()).toBeNull();
    expect(rowNames()).toEqual(['orbit']);
  });
});
