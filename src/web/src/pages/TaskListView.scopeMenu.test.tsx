// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { isProjectOnlyList, TaskListView, taskScopeMenuItems, type TaskListRow } from './TaskListView';

/**
 * The Tasks page's title is where the task lists are picked now: all tasks, the tasks in no list,
 * then the lists and the finished ones — the groups the sidebar held before its foot became the
 * open projects, as the iPhone's Tasks page offers them under `List:`. Like the page, it offers the
 * work outside projects: a list whose every task is some project's is on that project's page.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  const api = vi.fn();
  return {
    ...actual,
    api,
    getSession: (id: string) => api(`/sessions/${id}`),
    openTaskListConsole: () => new Promise(() => {}),
  };
});

const MERGE = encodeId('0196b000-0000-7000-8000-000000000001');
const RELEASE = encodeId('0196b000-0000-7000-8000-000000000002');
const PLAN = encodeId('0196b000-0000-7000-8000-000000000004');
const NCE3 = encodeId('0196b000-0000-7000-8000-000000000003');
const LISTS: TaskListRow[] = [
  // Every task of it is the FineWeb project's: that project's page is where it is reached.
  { id: MERGE, title: 'FineWeb + WARC → RocksDB 合并（自动接力）', _count: { tasks: 27468 }, runningTasks: 1, completed: false, tasksOutsideProjects: 0 },
  { id: RELEASE, title: 'Release 0.1.190 验收', _count: { tasks: 6 }, runningTasks: 1, completed: false, tasksOutsideProjects: 6 },
  // Empty: somebody's plan for work, not a project's.
  { id: PLAN, title: '下周计划', _count: { tasks: 0 }, runningTasks: 0, completed: false, tasksOutsideProjects: 0 },
  { id: NCE3, title: 'NCE3 缺失课程实现', _count: { tasks: 32 }, runningTasks: 0, completed: true, tasksOutsideProjects: 32 },
];
const UNLISTED = 1500;

const counts = (total: number) => ({
  total, open: total, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: total,
});

let requested: string[];
let container: HTMLDivElement;
let root: Root | null = null;

function answer(path: string): Promise<unknown> {
  requested.push(path);
  if (path.startsWith('/tasks/page')) {
    const total = path.includes('listId=none') ? UNLISTED : 3;
    return Promise.resolve({ items: [], nextCursor: null, total, counts: counts(total) });
  }
  if (path.startsWith('/tasks/counts')) return Promise.resolve(counts(3));
  if (path.startsWith('/tasks/active')) return Promise.resolve({ items: [], total: 0, truncated: false });
  if (path.startsWith('/tasks/labels')) return Promise.resolve({ items: [], labelTotal: 0, truncated: false });
  if (path === '/task-lists') return Promise.resolve(LISTS);
  if (path === '/workspaces') return Promise.resolve([]);
  return new Promise(() => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  requested = [];
  vi.mocked(api).mockImplementation(((path: string) => answer(path)) as typeof api);
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
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

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = '';
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <AntApp>
          <BrowserRouter>
            <Routes>
              <Route path="/tasks" element={<TaskListView />} />
              <Route path="/tasks/:id" element={<TaskListView />} />
              <Route path="/lists/:key" element={<TaskListView />} />
            </Routes>
          </BrowserRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const click = async (el: Element | null | undefined): Promise<void> => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};
const trigger = () => container.querySelector('h1.page-title .tasks-scope-trigger');
/** The open menu's entries and group labels, top to bottom, as a reader scans it. */
const menuLines = () =>
  [...document.querySelectorAll('.tasks-scope-menu .ant-dropdown-menu-item, .tasks-scope-menu .ant-dropdown-menu-item-group-title')].map(
    (el) => (el.textContent ?? '').trim(),
  );
const menuItem = (text: string) =>
  [...document.querySelectorAll('.tasks-scope-menu .ant-dropdown-menu-item')].find((el) =>
    el.textContent?.includes(text),
  );

describe('the Tasks page’s title', () => {
  it('opens every scope the sidebar used to hold, and counts the tasks in no list only once open', async () => {
    await visit('/tasks');
    expect(trigger()?.textContent).toBe('All tasks');
    expect(requested.filter((p) => p.startsWith('/tasks/page?limit=1&'))).toEqual([]);

    await click(trigger());

    // Counted over the tasks outside projects, the scope the No list page itself lists.
    expect(requested.filter((p) => p.startsWith('/tasks/page?limit=1&'))).toEqual([
      '/tasks/page?limit=1&listId=none&projectId=none',
    ]);
    expect(menuLines()).toEqual([
      'All tasks',
      `No list${UNLISTED}`,
      'Task List · 2',
      'Release 0.1.190 验收6',
      '下周计划0',
      'Completed · 1',
      'NCE3 缺失课程实现32',
    ]);
    // The dots the sidebar drew: a list with a task executing breathes, a finished one is green.
    expect(menuItem('Release')?.querySelector('.tp-list-dot')?.className).toBe('tp-list-dot running');
    expect(menuItem('下周计划')?.querySelector('.tp-list-dot')?.className).toBe('tp-list-dot ');
    expect(menuItem('NCE3')?.querySelector('.tp-list-dot')?.className).toBe('tp-list-dot done');
    expect(menuItem('All tasks')?.classList.contains('ant-dropdown-menu-item-selected')).toBe(true);
  });

  it('opens a picked list, whose name the title then carries', async () => {
    await visit('/tasks');
    await click(trigger());
    await click(menuItem('Release'));

    expect(window.location.pathname).toBe(`/lists/${RELEASE}`);
    expect(trigger()?.textContent).toBe('Release 0.1.190 验收');
  });

  it('goes back to every task from a list', async () => {
    await visit(`/lists/${NCE3}`);
    await click(trigger());
    expect(menuItem('NCE3')?.classList.contains('ant-dropdown-menu-item-selected')).toBe(true);
    await click(menuItem('All tasks'));
    expect(window.location.pathname).toBe('/tasks');
    expect(trigger()?.textContent).toBe('All tasks');
  });
});

// A list whose every task is some project's is reached from that project's page.
describe('isProjectOnlyList', () => {
  it('leaves out a list whose every task is filed under a project', () => {
    expect(isProjectOnlyList({ _count: { tasks: 27_468 }, tasksOutsideProjects: 0 })).toBe(true);
    expect(isProjectOnlyList({ _count: { tasks: 32 }, tasksOutsideProjects: 32 })).toBe(false);
    expect(isProjectOnlyList({ _count: { tasks: 3 }, tasksOutsideProjects: 1 })).toBe(false);
  });

  // An empty list is somebody's plan for work, not a project's; and a server that does not report
  // the split lists everything, as it always did.
  it('keeps an empty list, and every list when the server does not say', () => {
    expect(isProjectOnlyList({ _count: { tasks: 0 }, tasksOutsideProjects: 0 })).toBe(false);
    expect(isProjectOnlyList({ _count: { tasks: 27_468 } })).toBe(false);
  });
});

describe('taskScopeMenuItems', () => {
  const labelText = (item: unknown): string => {
    const label = (item as { label?: unknown }).label;
    return typeof label === 'string' ? label : 'node';
  };

  it('offers No list while it is still being counted, and leaves it out once it holds nothing', () => {
    const keys = (unlisted: number | undefined, current = '/tasks') =>
      taskScopeMenuItems([], unlisted, current).map((item) => (item as { key?: string }).key);
    expect(keys(undefined)).toEqual(['/tasks', '/lists/none']);
    expect(keys(12)).toEqual(['/tasks', '/lists/none']);
    expect(keys(0)).toEqual(['/tasks']);
    // Unless it is the page on screen: the title would otherwise name a scope the menu cannot show.
    expect(keys(0, '/lists/none')).toEqual(['/tasks', '/lists/none']);
  });

  it('draws no rule and no groups for an owner with no lists', () => {
    const items = taskScopeMenuItems([], 3, '/tasks');
    expect(items.some((item) => (item as { type?: string })?.type === 'divider')).toBe(false);
    expect(items.map(labelText)).toEqual(['node', 'node']);
  });

  it('opens each list at its public address, whichever spelling the index carried', () => {
    const uuid = '0196b000-0000-7000-8000-000000000009';
    // Every task, the rule, then the one group: No list holds nothing here.
    const [, , group] = taskScopeMenuItems([{ id: uuid, title: 'L' }], 0, '/tasks') as Array<{
      children?: Array<{ key: string }>;
    }>;
    expect(group.children?.map((child) => child.key)).toEqual([`/lists/${encodeId(uuid)}`]);
  });
});
