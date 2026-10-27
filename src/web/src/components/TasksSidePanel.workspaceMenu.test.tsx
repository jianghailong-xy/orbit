// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * A Workspace row's own actions in the sidebar (docs/mocks/workspace-delete-web): a ⋯ on the row, and a
 * right-click anywhere on it, open Configure — the workspace's editor on its machine's page — and
 * Delete workspace…, the machine page's Delete with the same confirmation. Before this the only way to
 * delete a workspace on the web was Infrastructure → the machine's Details → its row's ⋯.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api, getSession } = await import('../api');

const A = encodeId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = encodeId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const SHARED = encodeId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const RUNNER = encodeId('0000000f-0000-4000-8000-00000000000f');

const REFUSAL =
  'This agent still coordinates 1 project(s) and cannot be deleted — point those projects at another coordinator first';

let workspaces: Array<Record<string, unknown>> = [];
let deletes: string[] = [];
let refuse = false;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let location = '';

function RouterProbe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

function serve() {
  vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') {
      deletes.push(path);
      if (refuse) throw new Error(REFUSAL);
      workspaces = workspaces.filter((w) => path !== `/workspaces/${w.id}`);
      return { ok: true };
    }
    if (path === '/runners') return [{ id: RUNNER, name: 'wikova', online: true }];
    if (path === '/workspaces') return workspaces;
    if (path === '/projects/sidebar') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(getSession).mockImplementation((() => new Promise(() => {})) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
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
          <TasksSidePanel />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const rowNames = () => [...container!.querySelectorAll('.tp-workspace-name')].map(text);
const row = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>('.tp-workspace-name')]
    .find((label) => label.textContent === name)!.closest<HTMLElement>('.tp-item')!;
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const menuItem = (label: string) => menuItems().find((item) => text(item) === label)!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
const nameOf = (el: Element) => text(document.getElementById(el.getAttribute('aria-labelledby') ?? ''));
const button = (label: string, within: ParentNode) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((b) => text(b) === label)!;

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

/** The row's ⋯, as a pointer reaches it (it shows on hover). */
async function openMenu(name: string): Promise<string[]> {
  await click(row(name).querySelector<HTMLElement>('.tp-workspace-more')!);
  return menuItems().map((item) => text(item)!);
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
  workspaces = [
    { id: A, name: 'alpha', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: RUNNER },
    { id: B, name: 'bravo', createdAt: '2026-09-02T00:00:00.000Z', position: 1, runnerId: RUNNER },
  ];
  deletes = [];
  refuse = false;
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
  vi.mocked(getSession).mockReset();
});

describe('a sidebar Workspace row’s menu', () => {
  it('offers Configure and Delete workspace… from the row’s ⋯, without opening the workspace', async () => {
    await visit(`/workspaces/${A}`);
    expect(await openMenu('bravo')).toEqual(['Configure', 'Delete workspace…']);
    expect(menuItem('Delete workspace…').getAttribute('data-danger')).not.toBeNull();
    expect(location).toBe(`/workspaces/${A}`);
  });

  it('opens the same menu on a right-click anywhere on the row, instead of the browser’s', async () => {
    await visit(`/workspaces/${A}`);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      row('bravo').querySelector('.tp-workspace-name')!.dispatchEvent(event);
    });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(menuItems().map((item) => text(item))).toEqual(['Configure', 'Delete workspace…']);
    expect(row('bravo').classList.contains('menu-open')).toBe(true);
    expect(location).toBe(`/workspaces/${A}`);
  });

  it('Configure opens the workspace’s editor on its machine’s page', async () => {
    await visit(`/workspaces/${A}`);
    await openMenu('bravo');
    await click(menuItem('Configure'));
    expect(location).toBe(`/runners/${RUNNER}?workspace=${B}`);
  });

  it('a workspace with no machine has no page to configure it on, so only Delete', async () => {
    workspaces.push({ id: SHARED, name: 'shared', createdAt: '2026-09-03T00:00:00.000Z', position: 2, runnerId: null });
    await visit(`/workspaces/${A}`);
    expect(await openMenu('shared')).toEqual(['Delete workspace…']);
  });

  it('Delete asks first, then deletes the workspace and drops its row', async () => {
    await visit(`/workspaces/${A}`);
    await openMenu('bravo');
    await click(menuItem('Delete workspace…'));
    const confirm = dialog()!;
    expect(nameOf(confirm)).toBe('Delete workspace “bravo”?');
    expect(text(document.getElementById(confirm.getAttribute('aria-describedby') ?? ''))).toBe(
      'The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it. To park one you still use, disable it instead.',
    );
    expect(deletes).toEqual([]);

    await click(button('Delete', confirm));
    expect(deletes).toEqual([`/workspaces/${B}`]);
    expect(dialog()).toBeNull();
    expect(rowNames()).toEqual(['alpha']);
    // Another workspace's list stays where it was.
    expect(location).toBe(`/workspaces/${A}`);
  });

  it('Cancel deletes nothing', async () => {
    await visit(`/workspaces/${A}`);
    await openMenu('bravo');
    await click(menuItem('Delete workspace…'));
    await click(button('Cancel', dialog()!));
    expect(dialog()).toBeNull();
    expect(deletes).toEqual([]);
    expect(rowNames()).toEqual(['alpha', 'bravo']);
  });

  it('deleting the workspace on screen leaves its page', async () => {
    await visit(`/workspaces/${B}`);
    await openMenu('bravo');
    await click(menuItem('Delete workspace…'));
    await click(button('Delete', dialog()!));
    expect(deletes).toEqual([`/workspaces/${B}`]);
    expect(location).toBe('/');
  });

  it('a refusal (a project it still coordinates) is said in the dialog, which stays open', async () => {
    refuse = true;
    await visit(`/workspaces/${B}`);
    await openMenu('bravo');
    await click(menuItem('Delete workspace…'));
    await click(button('Delete', dialog()!));
    expect(text(dialog()!.querySelector('[role="alert"]'))).toBe(REFUSAL);
    expect(rowNames()).toEqual(['alpha', 'bravo']);
    expect(location).toBe(`/workspaces/${B}`);
  });

  it('has no ⋯ while the rows are being arranged', async () => {
    await visit(`/workspaces/${A}`);
    expect(container!.querySelectorAll('.tp-workspace-more')).toHaveLength(2);
    await click([...container!.querySelectorAll<HTMLElement>('.tp-group-action')].find((b) => text(b) === 'Edit')!);
    expect(container!.querySelectorAll('.tp-workspace-more')).toHaveLength(0);
  });
});

describe('where the row’s ⋯ shows', () => {
  const styles = readFileSync(
    [resolve(process.cwd(), 'src/index.css'), resolve(process.cwd(), 'src/web/src/index.css')].find(existsSync)!,
    'utf8',
  );
  const rule = (selector: string) => {
    const at = styles.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return styles.slice(at, styles.indexOf('}', at));
  };

  it('stays hidden until the row is hovered or its menu is open, and then takes the ⌘N’s place', () => {
    expect(rule('.tp-workspace-actions')).toContain('display: none');
    expect(styles).toMatch(/\.tp-item:hover \.tp-workspace-actions,\s*\.tp-item\.menu-open \.tp-workspace-actions \{\s*display: flex;/);
    expect(styles).toMatch(
      /\.app-shell \.app-nav:not\(\.collapsed\) \.tp-item:hover \.tp-workspace-shortcut,\s*\.app-shell \.app-nav:not\(\.collapsed\) \.tp-item\.menu-open \.tp-workspace-shortcut \{\s*display: none;/,
    );
  });

  it('always shows in the touch drawer, which has no hover', () => {
    expect(styles).toMatch(/@media \(max-width: 960px\) \{\s*\.tp-workspace-actions \{\s*display: flex;/);
  });

  it('comes in before a needs-you count, which keeps the row’s far end instead of moving over for it', () => {
    const selector = '.app-shell .app-nav:not(.collapsed) .tp-workspace-label ~ .tp-count.needs-you';
    expect(rule(selector)).toContain('order: 1;');
    // On the desktop sidebar only: the drawer shows every row's ⋯, so there it stays at the row's end.
    const at = styles.indexOf(`${selector} {`);
    expect(styles.slice(styles.lastIndexOf('@media', at), at)).toMatch(/^@media \(min-width: 961px\) \{/);
  });
});
