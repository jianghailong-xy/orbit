// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { TaskListView } from './TaskListView';

/**
 * The toolbar takes the bulk bar's height as its minimum, the bar's own scrollbar included. WebKit settles an
 * overflow:auto box's scrollbars only after the page column's flex layout, and kept the toolbar at the height of the bar
 * without its 8px scrollbar (docs/evidence/base-ui-migration/tasks-toolbar-height; the geometry itself is checked in a
 * real WebKit by ui-migration/tasks-toolbar.browser.mjs). jsdom lays nothing out, so the bar is as tall as the test
 * says: 42px with a task open (the list narrow, the bar's scrollbar there), 34px without.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), openTaskListConsole: () => new Promise(() => {}) };
});

const row = (n: number, title: string) => ({
  id: encodeId(`00000000-0000-7000-8000-00000000003${n}`),
  title,
  status: 'OPEN',
  running: false,
  queued: false,
  blocked: false,
  dependencyState: 'NONE',
  assignee: null,
});
const ROWS = [row(1, 'Toolbar height under a scrolling bulk bar'), row(2, 'Another task in the list')];
const counts = { total: 2, open: 2, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: 2 };

/** What the stubbed control plane answers. The detail panel's own reads are left pending. */
function answer(path: string): Promise<unknown> {
  if (path.startsWith('/tasks/page')) return Promise.resolve({ items: ROWS, nextCursor: null, total: ROWS.length });
  if (path.startsWith('/tasks/counts')) return Promise.resolve(counts);
  if (path.startsWith('/tasks/active')) return Promise.resolve({ items: [], total: 0, truncated: false });
  if (path.startsWith('/tasks/labels')) return Promise.resolve({ items: [], labelTotal: 0, truncated: false });
  if (path === '/task-lists' || path === '/workspaces') return Promise.resolve([]);
  return new Promise(() => {});
}

/** The ResizeObservers the view made, so a test can report a size change to the one watching the bar. */
let observers: { callback: ResizeObserverCallback; targets: Element[] }[];
/** Frames asked for and not yet run. */
let frames: Map<number, FrameRequestCallback>;
/** The bar's height when a test sets it; otherwise 42px with a task open, 34px without. */
let barHeight: number | null;
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  observers = [];
  frames = new Map();
  barHeight = null;
  vi.mocked(api).mockImplementation(((path: string) => answer(path)) as typeof api);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
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
  let lastFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    lastFrame += 1;
    frames.set(lastFrame, callback);
    return lastFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const unmeasured = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (!this.classList.contains('tasks-bulkbar')) return unmeasured.call(this);
    return new DOMRect(0, 0, 0, barHeight ?? (document.querySelector('.task-detail-panel') ? 42 : 34));
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
        <BrowserRouter>
          <Routes>
            <Route path="/tasks" element={<TaskListView />} />
            <Route path="/tasks/:id" element={<TaskListView />} />
          </Routes>
        </BrowserRouter>
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

const toolbar = (): HTMLElement => container.querySelector<HTMLElement>('.tasks-toolbar')!;
const bulkbar = (): HTMLElement | null => container.querySelector<HTMLElement>('.tasks-bulkbar');
const taskRow = (title: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('.task-row')].find((el) => el.textContent?.includes(title))!;
/** A click; `metaKey` makes a row click check the row instead of opening its task. */
const click = async (el: Element | null, init: MouseEventInit = {}): Promise<void> => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};

describe('the tasks toolbar under the bulk bar', () => {
  it('takes the bar’s height whenever a commit can turn its scrollbar on or off, and gives it up with the selection', async () => {
    await visit('/tasks');
    expect(toolbar().style.minHeight).toBe('');

    await click(taskRow(ROWS[1].title), { metaKey: true });
    expect(bulkbar()?.textContent).toContain('1 selected');
    expect(toolbar().style.minHeight).toBe('34px');

    // A task opened: the list narrows and the bar gains its scrollbar, settled in the same commit (no frame run).
    await click(taskRow(ROWS[0].title));
    expect(container.querySelector('.task-detail-panel')).not.toBeNull();
    expect(bulkbar()?.textContent).toContain('1 selected');
    expect(toolbar().style.minHeight).toBe('42px');

    await click(container.querySelector('[aria-label="Close"]'));
    expect(container.querySelector('.task-detail-panel')).toBeNull();
    expect(toolbar().style.minHeight).toBe('34px');

    await click([...bulkbar()!.querySelectorAll('button')].find((b) => b.textContent === 'Clear') ?? null);
    expect(bulkbar()).toBeNull();
    expect(toolbar().style.minHeight).toBe('');
  });

  it('follows a bar its ResizeObserver reports resized on the next frame, not inside the callback', async () => {
    await visit('/tasks');
    await click(taskRow(ROWS[1].title), { metaKey: true });
    expect(toolbar().style.minHeight).toBe('34px');
    const watching = observers.filter((o) => o.targets.includes(bulkbar()!));
    expect(watching).toHaveLength(1);

    // Only the room around the bar changed (the window narrowed): no commit, the observer reports it.
    barHeight = 42;
    frames.clear();
    act(() => watching[0].callback([], {} as ResizeObserver));
    expect(toolbar().style.minHeight).toBe('34px');
    act(() => {
      for (const [, callback] of [...frames]) callback(performance.now());
    });
    expect(toolbar().style.minHeight).toBe('42px');
  });
});
