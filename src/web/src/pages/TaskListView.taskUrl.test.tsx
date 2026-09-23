// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { TaskListView } from './TaskListView';

/**
 * A task opened from the list puts its own address in the bar.
 *
 * The list and the panel above it used to be one place with one address: a click moved a piece of
 * component state and left the URL alone, so a task could not be linked to — the production
 * database holds task URLs pasted three times against 106 for sessions. Both directions of the
 * panel are `replace`, because the panel is not a place you navigate *to*: `push` would leave one
 * history entry per row and turn Back into a walk back up the list.
 *
 * The list the panel opened over rides along in `?list=<key>`, so the address is the task's while
 * the page behind it is still where the reader was.
 */

// The view reaches for the network on mount; every answer it needs is seeded into the cache
// instead, so that a test which renders all-tasks rows has provably read the *list's* page.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
  openTaskListConsole: () => new Promise(() => {}),
}));

const LIST_KEY = encodeId('00000000-0000-7000-8000-000000000001');
const row = (n: number, title: string) => ({
  id: encodeId(`00000000-0000-7000-8000-00000000001${n}`),
  title,
  status: 'OPEN',
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
});
const FIRST = row(1, 'Download shard 000');
const SECOND = row(2, 'Download shard 001');
/** Only in the every-task view: its absence is what says the background is the list, not "All". */
const ELSEWHERE = row(9, 'A task in no list at all');

const counts = {
  total: 2,
  open: 2,
  inProgress: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  running: 0,
  queued: 0,
  runnable: 2,
};

let container: HTMLDivElement;
let root: Root | null = null;
let qc: QueryClient;

const page = (items: unknown[]) => ({
  pages: [{ items, nextCursor: null, total: items.length, counts }],
  pageParams: [null],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The tab is remembered per browser, so a leftover would key the paged query somewhere the
  // seeds below do not answer.
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['task-lists'], [{ id: LIST_KEY, title: 'FineWeb Parquet' }]);
  qc.setQueryData(['tasks', 'page', { filter: 'ALL', query: '', listId: LIST_KEY }], page([FIRST, SECOND]));
  qc.setQueryData(['tasks', 'page', { filter: 'ALL', query: '', listId: null }], page([ELSEWHERE]));
  qc.setQueryData(['tasks', 'counts', LIST_KEY, []], counts);
  qc.setQueryData(['tasks', 'counts', null, []], counts);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Open `path` the way a page load does: the address bar says it before the view first renders. */
async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <AntApp>
          <BrowserRouter>
            <Routes>
              {/* The three routes the app draws this view at: a list, one task, all tasks. */}
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

/** The click, the navigation and the effects it starts, each on a later tick. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const address = (): string => window.location.pathname + window.location.search;
const taskRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.task-row')];
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};
const press = async (key: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
  await settle();
};
const closePanel = async (): Promise<void> => {
  const close = container.querySelector('[aria-label="Close"]');
  expect(close, 'the detail panel’s close button').toBeTruthy();
  await click(close!);
};

describe('opening a task from a list', () => {
  it('writes the task’s own address, keeps the list behind it, and replaces rather than pushes', async () => {
    await visit(`/lists/${LIST_KEY}`);
    expect(taskRows().map((r) => r.textContent)).toEqual([
      expect.stringContaining(FIRST.title),
      expect.stringContaining(SECOND.title),
    ]);
    // The bug this exists for: the address said `/lists/<key>` while a task was open over it.
    const historyLength = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');

    await click(taskRows()[0]);

    expect(address()).toBe(`/tasks/${FIRST.id}?list=${LIST_KEY}`);
    // Still the list behind the panel — not every task, which is what a bare /tasks/<id> opens on.
    expect(container.textContent).toContain(FIRST.title);
    expect(container.textContent).not.toContain(ELSEWHERE.title);
    expect(container.querySelector('.task-detail-panel')).toBeTruthy();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(historyLength);
  });

  it('puts the list’s own address back when the panel closes', async () => {
    await visit(`/lists/${LIST_KEY}`);
    const historyLength = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');
    await click(taskRows()[0]);
    expect(address()).toBe(`/tasks/${FIRST.id}?list=${LIST_KEY}`);

    await closePanel();

    expect(address()).toBe(`/lists/${LIST_KEY}`);
    expect(container.querySelector('.task-detail-panel')).toBeNull();
    expect(container.textContent).toContain(FIRST.title);
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(historyLength);
  });

  it('opens a task from the every-task view too, and closes back to it', async () => {
    await visit('/tasks');

    await click(taskRows()[0]);

    expect(address()).toBe(`/tasks/${ELSEWHERE.id}`);
    expect(container.textContent).toContain(ELSEWHERE.title);

    await closePanel();

    expect(address()).toBe('/tasks');
  });

  it('keeps a list that the task’s own address was opened with — a pasted link is the same place', async () => {
    // The other direction of the hand-off: an address copied out of a list is opened cold, and
    // the list it names is what the panel comes up over.
    await visit(`/tasks/${FIRST.id}?list=${LIST_KEY}`);

    expect(address()).toBe(`/tasks/${FIRST.id}?list=${LIST_KEY}`);
    expect(container.textContent).toContain(SECOND.title);
    expect(container.textContent).not.toContain(ELSEWHERE.title);

    await closePanel();

    expect(address()).toBe(`/lists/${LIST_KEY}`);
  });
});

describe('stepping down the list with the arrow keys', () => {
  it('moves the address with the cursor, replacing each time', async () => {
    await visit(`/lists/${LIST_KEY}`);
    const historyLength = window.history.length;
    const pushState = vi.spyOn(window.history, 'pushState');

    await press('ArrowDown');

    expect(address()).toBe(`/tasks/${FIRST.id}?list=${LIST_KEY}`);
    await press('ArrowDown');
    expect(address()).toBe(`/tasks/${SECOND.id}?list=${LIST_KEY}`);

    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(historyLength);
  });

  it('leaves the multi-selection alone, though the address changes under it', async () => {
    // The selection is scoped to the visible rows, and a panel opening does not change those —
    // so looking at a task must not silently drop what the user just checked.
    await visit(`/lists/${LIST_KEY}`);
    await press('ArrowDown', { shiftKey: true });
    await press('ArrowDown', { shiftKey: true });
    expect(container.querySelectorAll('.task-row.checked').length).toBe(2);

    await click(taskRows()[0]);

    expect(address()).toBe(`/tasks/${FIRST.id}?list=${LIST_KEY}`);
    expect(container.querySelectorAll('.task-row.checked').length).toBe(2);
  });
});
