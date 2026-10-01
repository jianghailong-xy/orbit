// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectTasks } from './ProjectsPage';

/**
 * A project's task row opens its task over the project's page (lib/projectTaskRoute).
 *
 * The rows used to be read-only — nothing on them opened the task, and the Tasks page no longer
 * lists a project's tasks, so the project's page was the one place they could be found and could
 * not be opened from. Pressed for real here (jsdom, a router with a history), because what matters
 * is where the press goes and what kind of history entry it leaves: a new one from the page, so a
 * phone's back gesture closes the task; a replacement from a task already open, so Back never walks
 * through every task looked at.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

const PROJECT = encodeId('0195c0de-0000-7000-8000-000000000001');
const T1 = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const T2 = encodeId('0195c0de-0000-7000-8000-0000000000a2');

const task = (over: Record<string, unknown>) => ({
  id: T1,
  title: 'Design the landing page',
  status: 'OPEN',
  parentTaskId: null,
  acceptanceCriteria: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  dueDate: null,
  assignee: null,
  childCount: 0,
  unmetCount: 0,
  blocksCount: 0,
  topoLevel: 0,
  dependencyState: 'READY',
  workState: 'READY',
  verificationState: null,
  autoRunWhenReady: false,
  ...over,
});

let container: HTMLDivElement;
let root: Root | null = null;
/** Every location the router went to, with how it got there. */
let visits: Array<{ path: string; state: unknown; type: string }> = [];

function Probe() {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    visits.push({ path: location.pathname, state: location.state, type });
  }, [location, type]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  visits = [];
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
  vi.unstubAllGlobals();
});

/** The Tasks section at `entry`, under both routes the project's page is drawn at. */
async function mount(entry: string | { pathname: string; state: unknown }, rows: ReturnType<typeof task>[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['project', PROJECT, 'tasks', 'root'], { items: rows, nextCursor: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <Probe />
          <Routes>
            <Route path="/projects/:id" element={<ProjectTasks projectId={PROJECT} />} />
            <Route path="/projects/:id/tasks/:taskId" element={<ProjectTasks projectId={PROJECT} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const rowOf = (title: string): HTMLElement => {
  const row = [...container.querySelectorAll<HTMLElement>('.project-task-row')].find((each) =>
    each.textContent?.includes(title),
  );
  expect(row, `the row for ${title}`).toBeTruthy();
  return row!;
};
const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

describe('a project task row', () => {
  it('opens its task over the page when pressed anywhere, as a new history entry', async () => {
    await mount(`/projects/${PROJECT}`, [task({})]);
    // Not on the title: the words underneath, which a phone's thumb lands on as often as anything.
    await click(rowOf('Design the landing page').querySelector('.project-task-row-description')!);

    expect(visits.at(-1)).toEqual({
      path: `/projects/${PROJECT}/tasks/${T1}`,
      state: { projectTaskOverPage: true },
      type: 'PUSH',
    });
  });

  it('opens a second task in place of the first, keeping the page underneath', async () => {
    await mount({ pathname: `/projects/${PROJECT}/tasks/${T1}`, state: { projectTaskOverPage: true } }, [
      task({}),
      task({ id: T2, title: 'Write the pricing copy' }),
    ]);
    await click(rowOf('Write the pricing copy'));

    expect(visits.at(-1)).toEqual({
      path: `/projects/${PROJECT}/tasks/${T2}`,
      state: { projectTaskOverPage: true },
      type: 'REPLACE',
    });
  });

  it('draws the open task’s row open, and only that one', async () => {
    await mount(`/projects/${PROJECT}/tasks/${T1}`, [task({}), task({ id: T2, title: 'Write the pricing copy' })]);

    expect(rowOf('Design the landing page').classList.contains('is-open')).toBe(true);
    expect(rowOf('Write the pricing copy').classList.contains('is-open')).toBe(false);
    expect(rowOf('Write the pricing copy').classList.contains('is-openable')).toBe(true);
  });

  it('has a real link on the title, and pressing it navigates once', async () => {
    await mount(`/projects/${PROJECT}`, [task({})]);
    const link = rowOf('Design the landing page').querySelector<HTMLAnchorElement>('a.project-task-row-link');
    expect(link?.getAttribute('href')).toBe(`/projects/${PROJECT}/tasks/${T1}`);

    const before = visits.length;
    await click(link!);
    // One move, not the link's and then the row's again on top of it.
    expect(visits.slice(before)).toEqual([
      { path: `/projects/${PROJECT}/tasks/${T1}`, state: { projectTaskOverPage: true }, type: 'PUSH' },
    ]);
  });

  it('leaves Show subtasks to open a level, not the task', async () => {
    await mount(`/projects/${PROJECT}`, [task({ childCount: 2 })]);
    const before = visits.length;
    await click(rowOf('Design the landing page').querySelector('.project-task-row-disclosure')!);

    expect(visits.length, 'no navigation').toBe(before);
    expect(rowOf('Design the landing page').querySelector('.project-task-children')).toBeTruthy();
  });
});

describe('how an openable row and the open task are drawn', () => {
  // Both spellings: the web suite runs from src/web, and a runner may start at the repository root.
  // Comments off, so a rule is not satisfied by a sentence describing it.
  const found = ['src/index.css', 'src/web/src/index.css'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  const css = readFileSync(found!, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) =>
    css.match(new RegExp(`(?:^|[},])\\s*${selector.replace(/[.()>:]/g, '\\$&')}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';

  it('tints them with the Tasks page’s own two tokens', () => {
    // One pair for both pages, so "under the pointer" and "open in the panel" read the same on each.
    expect(rule('.task-row:hover')).toContain('var(--bg-hover)');
    expect(rule('.project-task-row.is-openable:hover')).toContain('var(--bg-hover)');
    expect(rule('.task-row.selected')).toContain('var(--brand-tint)');
    expect(rule('.project-task-row.is-open')).toContain('var(--brand-tint)');
  });

  it('lays the panel over the page on a desktop instead of narrowing it', () => {
    const at = css.indexOf('.project-task-panel > .task-detail-panel');
    expect(at, 'the panel’s rule on the project page').toBeGreaterThan(-1);
    // Inside the desktop block: at ≤960px the panel's own full-screen rule stands for both pages.
    expect(css.lastIndexOf('@media', at)).toBe(css.lastIndexOf('@media (min-width: 961px)', at));
    expect(css.slice(at, css.indexOf('}', at))).toMatch(/position:\s*fixed/);
  });
});
