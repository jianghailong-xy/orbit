// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { SidebarProject } from '../lib/projectAttention';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * The foot of the sidebar: the open projects, as the iPhone drawer closes its rail with them — the
 * ones waiting on you first, then by the newest activity — where the task lists used to stand; and
 * the two entries that change with it: Tasks, which the lists are reached through now, and
 * Projects, which a project's own page no longer lights.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WIKIDS = encodeId('0196a000-0000-7000-8000-000000000001');
const FINEWEB = encodeId('0196a000-0000-7000-8000-000000000002');
const WIKI = encodeId('0196a000-0000-7000-8000-000000000003');
const POSTGRES = encodeId('0196a000-0000-7000-8000-000000000004');
const CLOSED = encodeId('0196a000-0000-7000-8000-000000000005');

const project = (id: string, title: string, over: Partial<SidebarProject> = {}): SidebarProject => ({
  id,
  title,
  status: 'OPEN',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: ago(DAY),
  buckets: { running: 0 },
  attention: { ownerItems: [] },
  coordinatorActivity: null,
  ...over,
});

/** `GET /projects?status=OPEN` — in the server's order, newest project first, which is not the rail's. */
const OPEN_PROJECTS: SidebarProject[] = [
  project(POSTGRES, 'Postgres 性能与容量治理', { lastActivityAt: ago(6 * DAY) }),
  project(FINEWEB, 'FineWeb × Common Crawl → RocksDB 语料库', {
    buckets: { running: 2 },
    lastActivityAt: ago(2 * HOUR),
  }),
  // Its coordinator is mid-turn while no task of it runs: the rail must still read it as working.
  project(WIKI, 'Orbit Wiki · 阶段 1（MVP）', {
    lastActivityAt: ago(3 * DAY),
    coordinatorActivity: { working: true, lastTurnAt: ago(MINUTE) },
  }),
  project(WIKIDS, 'Wikids AI 游戏模块：狼人杀 MVP', {
    lastActivityAt: ago(9 * DAY),
    attention: {
      ownerItems: [{ kind: 'COORDINATOR_QUESTION', count: 2, oldestWaitingSince: ago(26 * MINUTE) }],
    },
  }),
];

let requested: string[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

function serve(projects: SidebarProject[] = OPEN_PROJECTS) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    requested.push(path);
    if (path === '/projects?status=OPEN') return projects;
    if (path === '/runners') return [];
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
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

/** The group's rows as the reader sees them: title, dot, amber count, and whether it is lit. */
const projectRows = () =>
  [...container!.querySelectorAll('.tp-group .tp-item.inset')].map((row) => ({
    title: row.querySelector('.tp-label')?.textContent,
    working: row.querySelector('.tp-list-dot')!.classList.contains('running'),
    needsYou: row.querySelector('.tp-count.needs-you')?.textContent ?? null,
    active: row.classList.contains('active'),
  }));

/** The fixed entry lit as the page on screen, by its label. */
const currentEntry = () =>
  container!.querySelector('.tp-section .tp-item[aria-current="page"] .tp-label')?.textContent ?? null;

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
  requested = [];
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

describe('the sidebar’s Projects group', () => {
  it('lists the open projects, the ones waiting on you first, then by the newest activity', async () => {
    serve();
    await visit('/projects');

    const head = container!.querySelector('.tp-group-head');
    expect(head?.querySelector('.tp-group-name')?.textContent).toBe('Projects');
    expect(head?.querySelector('.tp-count')?.textContent).toBe('4');
    expect(projectRows()).toEqual([
      { title: 'Wikids AI 游戏模块：狼人杀 MVP', working: false, needsYou: '2', active: false },
      // Its coordinator's turn a minute ago is newer than FineWeb's last task write.
      { title: 'Orbit Wiki · 阶段 1（MVP）', working: true, needsYou: null, active: false },
      { title: 'FineWeb × Common Crawl → RocksDB 语料库', working: true, needsYou: null, active: false },
      { title: 'Postgres 性能与容量治理', working: false, needsYou: null, active: false },
    ]);
    expect(container!.querySelector('.tp-count.needs-you')?.getAttribute('title')).toBe('2 waiting on you');
  });

  it('no longer holds the task lists, and no longer reads them', async () => {
    serve();
    await visit('/projects');
    const text = container!.textContent ?? '';
    expect(text).not.toContain('Task List');
    expect(text).not.toContain('No list');
    expect(text).not.toContain('Completed');
    expect(requested.filter((p) => p === '/task-lists' || p.startsWith('/tasks/'))).toEqual([]);
  });

  it('opens a project’s page from its row, and lights that row there instead of Projects', async () => {
    serve();
    await visit('/projects');
    expect(currentEntry()).toBe('Projects');

    const fineweb = [...container!.querySelectorAll('.tp-group .tp-item.inset')].find((row) =>
      row.textContent?.includes('FineWeb'),
    ) as HTMLElement;
    await act(async () => fineweb.click());
    await settle();

    expect(pathname).toBe(`/projects/${FINEWEB}`);
    expect(projectRows().filter((row) => row.active).map((row) => row.title)).toEqual([
      'FineWeb × Common Crawl → RocksDB 语料库',
    ]);
    expect(currentEntry()).toBeNull();
  });

  it('lights a project’s row on a deep link to it, in either spelling of its id', async () => {
    serve();
    await visit(`/projects/0196a000-0000-7000-8000-000000000003`);
    expect(projectRows().filter((row) => row.active).map((row) => row.title)).toEqual([
      'Orbit Wiki · 阶段 1（MVP）',
    ]);
    expect(currentEntry()).toBeNull();
  });

  it('keeps Projects lit on the page of a project the group does not list', async () => {
    serve();
    await visit(`/projects/${CLOSED}`);
    expect(projectRows().some((row) => row.active)).toBe(false);
    expect(currentEntry()).toBe('Projects');
  });

  it('draws no group, and no rule above it, when no project is open', async () => {
    serve([]);
    await visit('/projects');
    expect(container!.querySelector('.tp-group-head')).toBeNull();
    expect(projectRows()).toEqual([]);
  });
});

describe('the sidebar’s Tasks entry', () => {
  it('sits under Projects, above the Wiki', async () => {
    serve();
    await visit('/projects');
    const labels = [...container!.querySelectorAll('.tp-section .tp-item .tp-label')].map((l) => l.textContent);
    expect(labels.slice(0, 3)).toEqual(['Projects', 'Tasks', 'Wiki']);
  });

  it.each([
    ['every task', '/tasks'],
    ['one task', `/tasks/${encodeId('0196a000-0000-7000-8000-0000000000aa')}`],
    ['the tasks in no list', '/lists/none'],
    ['one list', `/lists/${encodeId('0196a000-0000-7000-8000-0000000000bb')}`],
  ])('is the page on screen for %s', async (_, path) => {
    serve();
    await visit(path);
    expect(currentEntry()).toBe('Tasks');
  });
});
