// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { TaskListView } from './TaskListView';

/**
 * The Tasks page lists the owner's own work: the tasks filed under no project.
 *
 * A project's tasks are on that project's page, where the project decides whether they run; on
 * this deployment they are 111,233 of 111,937 tasks, which is how the page came to say "Done 1,980
 * / 111,937" over the 700 tasks it was for. The narrowing is the server's (`projectId=none`), so
 * what is asserted is the REQUEST — every read the browsing views make carries it, a list the
 * reader opened does not — and the one sentence that says where the rest went.
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

const LIST_KEY = encodeId('00000000-0000-7000-8000-000000000031');
const row = (n: number, title: string, status = 'OPEN') => ({
  id: encodeId(`00000000-0000-7000-8000-00000000003${n}`),
  title,
  status,
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
});
const MINE = row(1, 'Providers: a narrow desktop breakpoint');
const FAILED = row(2, 'Release 0.1.165 and deploy it', 'FAILED');

const counts = {
  total: 704,
  open: 43,
  inProgress: 2,
  done: 648,
  failed: 8,
  cancelled: 3,
  running: 0,
  queued: 0,
  runnable: 50,
};

let requested: string[];
let inProjects: { tasks: number; projects: number } | undefined;
let container: HTMLDivElement;
let root: Root | null = null;

function answer(path: string): Promise<unknown> {
  requested.push(path);
  if (path.startsWith('/tasks/page')) return Promise.resolve({ items: [MINE], nextCursor: null, total: 1 });
  if (path.startsWith('/tasks/counts')) {
    return Promise.resolve(path.includes('projectId=none') && inProjects ? { ...counts, inProjects } : counts);
  }
  if (path.startsWith('/tasks/active')) return Promise.resolve({ items: [FAILED], total: 1, truncated: false });
  if (path.startsWith('/tasks/labels')) {
    return Promise.resolve({ items: [{ label: 'release', total: 3, open: 0, inProgress: 0, done: 2, failed: 1, cancelled: 0 }], labelTotal: 1, truncated: false });
  }
  if (path === '/task-lists') return Promise.resolve([{ id: LIST_KEY, title: 'NCE3', _count: { tasks: 32 } }]);
  if (path === '/workspaces') return Promise.resolve([]);
  return new Promise(() => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  requested = [];
  inProjects = { tasks: 111_233, projects: 71 };
  vi.mocked(api).mockImplementation(((path: string) => answer(path)) as typeof api);
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    vi.stubGlobal(name, class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
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
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});

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
              <Route path="/lists/:key" element={<TaskListView />} />
            </Routes>
          </BrowserRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const reads = (prefix: string) => requested.filter((p) => p.startsWith(prefix));
const note = (): HTMLElement | null => container.querySelector<HTMLElement>('.tasks-scope-note');
const title = (): string => container.querySelector('.page-title')?.textContent ?? '';

describe('the Tasks page lists the tasks outside projects', () => {
  it('asks every browsing read for the tasks filed under no project', async () => {
    await visit('/tasks');

    for (const prefix of ['/tasks/page', '/tasks/counts', '/tasks/active', '/tasks/labels']) {
      const made = reads(prefix);
      expect(made.length, `${prefix} was never read`).toBeGreaterThan(0);
      for (const path of made) expect(path, path).toContain('projectId=none');
    }
  });

  it('calls the view All tasks, the same name iOS gives it', async () => {
    await visit('/tasks');

    expect(title()).toBe('All tasks');
  });

  it('says in one sentence where the rest went, and links to Projects', async () => {
    await visit('/tasks');

    expect(note()?.textContent).toContain(
      'Tasks outside projects. 111,233 tasks in 71 projects are on their project pages.',
    );
    expect(note()?.querySelector('a')?.textContent).toBe('Projects ›');
  });

  it('says nothing about projects when there are none to point at', async () => {
    inProjects = undefined;
    await visit('/tasks');

    expect(note()).toBeNull();
  });

  it('keeps the tasks in no list to the ones outside projects too', async () => {
    await visit('/lists/none');

    expect(title()).toBe('No list');
    for (const path of reads('/tasks/page')) expect(path).toContain('projectId=none');
  });

  // NEGATIVE CONTROL: a list the reader opened is a scope somebody picked, so it lists its members
  // whoever filed them — and says nothing about the tasks outside projects.
  it('lists an opened list’s members whoever filed them', async () => {
    await visit(`/lists/${LIST_KEY}`);

    expect(reads('/tasks/page').length).toBeGreaterThan(0);
    expect(requested.filter((p) => p.includes('projectId'))).toEqual([]);
    expect(note()).toBeNull();
  });

  // The pinned strip is not narrowed by label, so under a label filter it would pin every live task
  // in scope over a page that shows one batch.
  it('pins nothing over a page narrowed to a label', async () => {
    await visit('/tasks?labels=release');

    expect(reads('/tasks/active')).toEqual([]);
    expect(container.textContent).not.toContain('Happening now');
  });

  it('pins the live and failed tasks outside projects on the unfiltered page', async () => {
    await visit('/tasks');

    expect(container.textContent).toContain('Happening now');
    expect(container.textContent).toContain(FAILED.title);
    expect(container.textContent).not.toContain('In projects');
  });
});
