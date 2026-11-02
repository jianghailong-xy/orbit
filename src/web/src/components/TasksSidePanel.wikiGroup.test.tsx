// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { WikiSpaceRow } from '../lib/wiki';
import { WIKI_FROM_WORKSPACE_KEY, WIKI_LAST_SPACE_KEY } from '../lib/wikiSpace';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * The wikis in the sidebar: a group of the Projects group's grammar between the Workspaces and the
 * Projects, a row for each wiki with its own amber count. The Wiki entry above stays as the Projects
 * entry stays, standing for them all: lit only on a page of no wiki the group shows, always the whole
 * count, and on the collapsed rail, which has no group, the one icon every wiki route lights.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  fetchAvatarDataUrl: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api, ApiError } = await import('../api');

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

const WORKSPACE_ID = encodeId('0196a000-0000-7000-8000-0000000000a1');

/** `GET /wiki/spaces`, in the server's order: by slug. */
const WIKIS = [
  space('cbai', { docs: { written: 2, total: 9 } }),
  space('orbit', { docs: { written: 30, total: 35 }, pendingOps: 1, planWaiting: 2, workspaceIds: [WORKSPACE_ID] }),
  space('wikova', { docs: { written: 5, total: 5 }, pendingOps: 4 }),
];

const WORKSPACE = { id: WORKSPACE_ID, name: 'orbit-develop', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: 'runner' };
const PROJECT = {
  id: encodeId('0196a000-0000-7000-8000-0000000000b1'),
  title: 'Checkout page redesign',
  status: 'OPEN',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-02T00:00:00.000Z',
  buckets: { running: 0 },
  attention: { ownerItems: [] },
  coordinatorActivity: null,
};

function serve(wikis: unknown, { workspaces = [] as unknown[], projects = [] as unknown[] } = {}) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return projects;
    if (path === '/runners') return workspaces.length > 0 ? [{ id: 'runner', name: 'workstation', online: true }] : [];
    if (path === '/workspaces') return workspaces;
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') {
      if (wikis instanceof Error) throw wikis;
      return wikis;
    }
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string, onNavigate?: () => void): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel onNavigate={onNavigate} />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function leave(): Promise<void> {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
}

const group = () => container!.querySelector('.tp-group-wiki');
const rows = () => [...container!.querySelectorAll<HTMLElement>('.tp-group-wiki .tp-item')];
const row = (name: string) => rows().find((item) => item.querySelector('.tp-label')?.textContent === name)!;
const names = () => rows().map((item) => item.querySelector('.tp-label')?.textContent);
const entry = () =>
  [...container!.querySelectorAll<HTMLElement>('.tp-section .tp-item')].find(
    (item) => item.querySelector('.tp-label')?.textContent === 'Wiki',
  );
const railIcon = () => container!.querySelector<HTMLElement>('.tp-rail-item[title="Wiki"]')!;
/** Every row of the panel lit as the page on screen, by what it says. */
const lit = () =>
  [...container!.querySelectorAll('.tp-scroll [aria-current="page"] .tp-label')].map((label) => label.textContent);
const amber = (item: Element) => item.querySelector('.needs-you');

async function press(item: HTMLElement): Promise<void> {
  await act(async () => item.click());
  await settle();
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
  localStorage.clear();
  sessionStorage.clear();
  serve(WIKIS);
});

afterEach(async () => {
  await leave();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe('the sidebar’s Wiki group', () => {
  it('lists the wikis under a head that says how many, in the server’s order', async () => {
    await visit('/projects');
    expect(group()!.querySelector('.tp-group-name')?.textContent).toBe('Wiki');
    expect(group()!.querySelector('.tp-group-head .tp-count')?.textContent).toBe('3');
    expect(names()).toEqual(['cbai', 'orbit', 'wikova']);
  });

  it('calls a wiki what the Wiki’s own head calls it', async () => {
    serve([
      space('a-orbit', { repoUrlNorm: 'github.com/alice/orbit' }),
      space('b-orbit', { repoUrlNorm: 'github.com/bob/orbit' }),
      space('notes', { repoUrlNorm: null, title: 'Team notes' }),
    ]);
    await visit('/projects');
    expect(names()).toEqual(['alice/orbit', 'bob/orbit', 'Team notes']);
  });

  it('stands between the Workspaces and the Projects, a gap for each pair that is there', async () => {
    serve(WIKIS, { workspaces: [WORKSPACE], projects: [PROJECT] });
    await visit('/projects');
    const blocks = () => [...container!.querySelector('.tp-lists')!.children].map((child) => child.className);
    expect(blocks()).toEqual([
      'tp-group tp-group-workspaces',
      'tp-divider',
      'tp-group tp-group-wiki',
      'tp-divider',
      'tp-group tp-group-projects autohide-scrollbar',
    ]);
    await leave();

    serve(WIKIS, { projects: [PROJECT] });
    await visit('/projects');
    expect(blocks()).toEqual([
      'tp-group tp-group-workspaces',
      'tp-group tp-group-wiki',
      'tp-divider',
      'tp-group tp-group-projects autohide-scrollbar',
    ]);
    await leave();

    serve(WIKIS, { workspaces: [WORKSPACE] });
    await visit('/projects');
    expect(blocks()).toEqual(['tp-group tp-group-workspaces', 'tp-divider', 'tp-group tp-group-wiki']);
    await leave();

    serve([], { workspaces: [WORKSPACE], projects: [PROJECT] });
    await visit('/projects');
    expect(blocks()).toEqual([
      'tp-group tp-group-workspaces',
      'tp-divider',
      'tp-group tp-group-projects autohide-scrollbar',
    ]);
  });

  it('counts what waits in each wiki, and the entry keeps the whole of it', async () => {
    await visit('/projects');
    expect(amber(row('cbai'))).toBeNull();
    expect(amber(row('orbit'))?.textContent).toBe('3');
    expect(amber(row('orbit'))?.getAttribute('aria-label')).toBe('3 waiting on you');
    expect(amber(row('wikova'))?.textContent).toBe('4');
    expect(amber(entry()!)?.textContent).toBe('7');
    expect(amber(railIcon())?.textContent).toBe('7');
  });

  it('has no group with no wiki to list, and the entry is still the way to a first one', async () => {
    serve([]);
    await visit('/projects');
    expect(group()).toBeNull();
    expect(entry()).toBeDefined();
  });

  it('draws neither for an account the server has not switched the wiki on for', async () => {
    serve(new ApiError('The Orbit wiki is not on for this account', 404, 'WIKI_DISABLED'));
    await visit('/projects');
    expect(group()).toBeNull();
    expect(entry()).toBeUndefined();
  });

  it('folds from its head', async () => {
    await visit('/projects');
    await press(group()!.querySelector<HTMLElement>('.tp-group-head')!);
    expect(rows()).toEqual([]);
    expect(group()!.querySelector('.tp-group-head .tp-count')?.textContent).toBe('3');
    await press(group()!.querySelector<HTMLElement>('.tp-group-head')!);
    expect(names()).toEqual(['cbai', 'orbit', 'wikova']);
  });
});

describe('where a wiki’s row leads', () => {
  it('opens the wiki’s home, and tells the drawer to close', async () => {
    const onNavigate = vi.fn();
    await visit('/projects', onNavigate);
    await press(row('wikova'));
    expect(pathname).toBe('/wiki/wikova');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('opens from the keyboard, as a link does', async () => {
    await visit('/projects');
    await act(async () => {
      row('orbit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(pathname).toBe('/wiki/orbit');
    expect(row('orbit').getAttribute('role')).toBe('link');
    expect(row('orbit').tabIndex).toBe(0);
  });

  it('goes nowhere when lit, on any page of the wiki, and still closes the drawer', async () => {
    const onNavigate = vi.fn();
    await visit('/wiki/wikova/activity', onNavigate);
    await press(row('wikova'));
    expect(pathname).toBe('/wiki/wikova/activity');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('leaves the entry to open `/wiki` from a wiki’s page, as the entry’s row is not lit there', async () => {
    await visit('/wiki/wikova/activity');
    await press(entry()!);
    expect(pathname).toBe('/wiki');
  });
});

describe('which row is lit', () => {
  it.each([
    '/wiki/wikova',
    '/wiki/wikova/activity',
    '/wiki/wikova/d/how-it-runs',
    '/wiki/wikova/t/clients/2',
    '/wiki/wikova/e/entry-1',
    '/wiki/wikova/review',
    '/wiki/wikova/settings',
  ])('is the wiki’s own on %s, and the entry is not', async (path) => {
    await visit(path);
    expect(lit()).toEqual(['wikova']);
    expect(row('wikova').classList.contains('active')).toBe(true);
    expect(entry()!.classList.contains('active')).toBe(false);
  });

  it('is the wiki `/wiki` opens: the last one looked at', async () => {
    localStorage.setItem(WIKI_LAST_SPACE_KEY, 'wikova');
    await visit('/wiki');
    expect(lit()).toEqual(['wikova']);
  });

  it('is the wiki `/wiki` opens: the one bound to the workspace the reader came from, over the last look', async () => {
    localStorage.setItem(WIKI_LAST_SPACE_KEY, 'wikova');
    sessionStorage.setItem(WIKI_FROM_WORKSPACE_KEY, WORKSPACE_ID);
    await visit('/wiki');
    expect(lit()).toEqual(['orbit']);
  });

  it('is the wiki `/wiki` opens: the one with the most written, with nothing else to go on', async () => {
    await visit('/wiki');
    expect(lit()).toEqual(['orbit']);
  });

  it.each(['/wiki/review', '/wiki/no-such-wiki'])('is the entry on %s, a page of no wiki', async (path) => {
    await visit(path);
    expect(lit()).toEqual(['Wiki']);
  });

  it('is the entry with no wiki to list', async () => {
    serve([]);
    await visit('/wiki');
    expect(lit()).toEqual(['Wiki']);
  });

  it('is the entry while the group is folded, so the rail still says where you are', async () => {
    await visit('/wiki/wikova/activity');
    await press(group()!.querySelector<HTMLElement>('.tp-group-head')!);
    expect(lit()).toEqual(['Wiki']);
    await press(entry()!);
    expect(pathname).toBe('/wiki/wikova/activity');
  });

  it('is neither off the Wiki', async () => {
    await visit('/tasks');
    expect(lit()).toEqual(['Tasks']);
  });
});

describe('the collapsed rail, which has no group', () => {
  it('lights its Wiki icon on a wiki’s page, and a press goes nowhere', async () => {
    await visit('/wiki/wikova/activity');
    expect(railIcon().classList.contains('active')).toBe(true);
    expect(railIcon().getAttribute('aria-current')).toBe('page');
    await press(railIcon());
    expect(pathname).toBe('/wiki/wikova/activity');
  });

  it('lights nothing of the Wiki elsewhere, and opens it from there', async () => {
    await visit('/tasks');
    expect(railIcon().classList.contains('active')).toBe(false);
    await press(railIcon());
    expect(pathname).toBe('/wiki');
  });
});
