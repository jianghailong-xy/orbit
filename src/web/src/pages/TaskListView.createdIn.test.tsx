// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_CREATED_TASKS_COPY } from '@orbit/shared';
import { ApiError, api } from '../api';
import { encodeId } from '../lib/idCodec';
import { TaskListView } from './TaskListView';

/**
 * `/tasks?createdIn=<session>`: the Tasks page narrowed to what one conversation created — where
 * "View all in Tasks ›" under a session's "Tasks created here" row lands.
 *
 * The narrowing is the server's (`creatorSessionId` on `/tasks/page` and `/tasks/counts`), so what
 * is asserted is the REQUEST: both reads carry the session, the chip names it, and taking the chip
 * off asks for every task again.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  const api = vi.fn();
  return {
    ...actual,
    api,
    // Calls the module-local `api`, which replacing the export alone would not reach.
    getSession: (id: string) => api(`/sessions/${id}`),
    openTaskListConsole: () => new Promise(() => {}),
  };
});

const SESSION = '34Ufyv4TQVdD5gtYW7Oza';
const SESSION_TITLE = 'Session tasks in the parking strip';

const row = (n: number, title: string) => ({
  id: encodeId(`00000000-0000-7000-8000-00000000002${n}`),
  title,
  status: 'OPEN',
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
});
/** Created in the session. */
const MINE = row(1, 'Web: a Tasks created here row above the composer');
/** Created anywhere else: only the unscoped page has it. */
const ELSEWHERE = row(2, 'A task another conversation filed');

const counts = (total: number) => ({
  total,
  open: total,
  inProgress: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  running: 0,
  queued: 0,
  runnable: total,
});

let requested: string[];
let sessionReadable: boolean;
let container: HTMLDivElement;
let root: Root | null = null;

/** What the stubbed control plane answers. The detail panel's own reads are left pending. */
function answer(path: string): Promise<unknown> {
  requested.push(path);
  const scoped = path.includes(`creatorSessionId=${SESSION}`);
  if (path.startsWith('/tasks/page')) {
    const items = scoped ? [MINE] : [MINE, ELSEWHERE];
    return Promise.resolve({ items, nextCursor: null, total: items.length });
  }
  if (path.startsWith('/tasks/counts')) return Promise.resolve(counts(scoped ? 1 : 2));
  if (path.startsWith('/tasks/active')) return Promise.resolve({ items: [], total: 0, truncated: false });
  if (path.startsWith('/tasks/labels')) return Promise.resolve({ items: [], labelTotal: 0, truncated: false });
  if (path === '/task-lists' || path === '/workspaces') return Promise.resolve([]);
  if (path === `/sessions/${SESSION}`) {
    return sessionReadable
      ? Promise.resolve({ id: SESSION, title: SESSION_TITLE })
      : Promise.reject(new ApiError('Session not found', 404));
  }
  return new Promise(() => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The tab is remembered per browser; a leftover would scope the page to some other tab.
  localStorage.clear();
  requested = [];
  sessionReadable = true;
  vi.mocked(api).mockImplementation(((path: string) => answer(path)) as typeof api);
  // jsdom implements neither, and the view measures its scrolling body with both.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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

/** Open `path` the way a page load does: the address bar says it before the view first renders. */
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
            </Routes>
          </BrowserRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The answers, the navigation and the effects they start, each on a later tick. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const address = (): string => window.location.pathname + window.location.search;
const chip = (): HTMLElement | null => container.querySelector<HTMLElement>('.tasks-createdin');
const rowTitles = (): string[] =>
  [...container.querySelectorAll('.task-row .task-title')].map((t) => t.textContent ?? '');
const click = async (el: Element | null): Promise<void> => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};

describe('the Tasks page scoped to one session', () => {
  it('asks for that session’s rows and tallies, and names it in the toolbar', async () => {
    await visit(`/tasks?createdIn=${SESSION}`);

    expect(requested).toContain(`/tasks/page?limit=200&creatorSessionId=${SESSION}&counts=total`);
    expect(requested).toContain(`/tasks/counts?creatorSessionId=${SESSION}`);
    expect(
      requested.filter((p) => (p.startsWith('/tasks/page') || p.startsWith('/tasks/counts')) && !p.includes(SESSION)),
      'a read of the page that is not narrowed to the session',
    ).toEqual([]);
    // "Happening now" cannot be narrowed to a session, so in this scope it is not asked for at all.
    expect(requested.filter((p) => p.startsWith('/tasks/active'))).toEqual([]);

    expect(rowTitles()).toEqual([MINE.title]);
    expect(chip()?.textContent).toBe(`${SESSION_CREATED_TASKS_COPY.createdInChip}${SESSION_TITLE}`);
  });

  it('calls a session it cannot read “this session”', async () => {
    sessionReadable = false;
    await visit(`/tasks?createdIn=${SESSION}`);

    expect(requested).toContain(`/sessions/${SESSION}`);
    expect(chip()?.textContent).toBe(`${SESSION_CREATED_TASKS_COPY.createdInChip}this session`);
  });

  it('takes the scope off with the chip, and asks for every task again', async () => {
    await visit(`/tasks?createdIn=${SESSION}`);
    requested = [];

    await click(chip()?.querySelector('.ant-tag-close-icon') ?? null);

    expect(address()).toBe('/tasks');
    expect(chip()).toBeNull();
    expect(requested).toContain('/tasks/page?limit=200&counts=total');
    expect(requested).toContain('/tasks/counts');
    expect(requested.filter((p) => p.includes('creatorSessionId'))).toEqual([]);
    expect(rowTitles()).toEqual([MINE.title, ELSEWHERE.title]);
  });

  it('draws no chip, and narrows nothing, without the parameter', async () => {
    await visit('/tasks');

    expect(chip()).toBeNull();
    expect(requested.filter((p) => p.includes('creatorSessionId'))).toEqual([]);
    expect(requested.filter((p) => p.startsWith('/sessions/'))).toEqual([]);
  });

  it('keeps the scope behind a task opened over it, and closes back to it', async () => {
    await visit(`/tasks?createdIn=${SESSION}`);

    await click(container.querySelector('.task-row'));

    expect(address()).toBe(`/tasks/${MINE.id}?createdIn=${SESSION}`);
    expect(chip()).not.toBeNull();
    expect(rowTitles()).toEqual([MINE.title]);

    await click(container.querySelector('[aria-label="Close"]'));

    expect(address()).toBe(`/tasks?createdIn=${SESSION}`);
    expect(chip()).not.toBeNull();
  });
});
