// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreatedTaskRow, SessionCreatedTasks } from '@orbit/shared';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { sessionCreatedTasksQuery } from '../lib/queries';
import { SessionCreatedTasksStrip } from './SessionCreatedTasksStrip';

/**
 * The "Tasks created here" row above a session's composer: whether it is drawn at all, the one line
 * it folds to, and the list it opens to.
 *
 * Its sentence and its fixed words are the ones `session-created-tasks.fixture.json` gives both
 * clients, so the cases below are read out of that file rather than written a second time here —
 * a copy in this file is a copy free to agree with a sentence the native client never writes.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));

interface CountLineCase {
  running: number;
  failed: number;
  done: number;
  total: number;
  text: string;
}

/** A file of this repository, by both spellings: the web suite runs from `src/web`, a runner may
 *  start at the root. */
function fromRepo(...candidates: string[]): string {
  const found = candidates.map((each) => resolve(process.cwd(), each)).find(existsSync);
  if (!found) throw new Error(`none of ${candidates.join(', ')} is under ${process.cwd()}`);
  return readFileSync(found, 'utf8');
}

const fixture = JSON.parse(
  fromRepo(
    '../shared/src/session-created-tasks.fixture.json',
    'src/shared/src/session-created-tasks.fixture.json',
  ),
) as { copy: Record<string, string>; countLine: CountLineCase[] };

const css = fromRepo('src/index.css', 'src/web/src/index.css');

const SESSION = '34Ufyv4TQVdD5gtYW7Oza';
const PROJECT = encodeId('00000000-0000-7000-8000-00000000a001');
const HOUR = 3_600_000;

/** A row as the server draws it; `n` keeps each one's id and title apart. */
function row(n: number, over: Partial<SessionCreatedTaskRow> = {}): SessionCreatedTaskRow {
  return {
    id: encodeId(`00000000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`),
    title: `Task ${n}`,
    status: 'OPEN',
    running: false,
    queued: false,
    createdAt: new Date(Date.now() - n * HOUR - 60_000).toISOString(),
    projectId: null,
    replaces: null,
    ...over,
  };
}

function created(over: Partial<SessionCreatedTasks> = {}): SessionCreatedTasks {
  return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [], ...over };
}

let answer: SessionCreatedTasks;
let requested: string[];
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api).mockImplementation(async (path: string) => {
    requested.push(path);
    if (path === `/sessions/${SESSION}/created-tasks`) return answer as never;
    throw new Error(`unstubbed ${path}`);
  });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  vi.mocked(api).mockReset();
});

/** A fresh strip over `data`, once its one read has been answered and drawn. */
async function mount(data: SessionCreatedTasks): Promise<void> {
  if (root) act(() => root!.unmount());
  answer = data;
  requested = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionCreatedTasksStrip sessionId={SESSION} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const key = sessionCreatedTasksQuery(SESSION).queryKey;
  await act(async () => {
    await vi.waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'));
    // The cache settles a tick before the observers hear of it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requested).toEqual([`/sessions/${SESSION}/created-tasks`]);
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const one = (selector: string): HTMLElement | null => container.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(selector)];
const link = (text: string): HTMLAnchorElement | undefined =>
  all('a').find((a) => a.textContent === text) as HTMLAnchorElement | undefined;

describe('the collapsed row', () => {
  it('is not drawn for a session that created nothing', async () => {
    await mount(created());
    expect(container.innerHTML).toBe('');
  });

  it('names a lone task and shows its pill, instead of counting it', async () => {
    const task = row(1, { title: 'Signed-out engines stop probing the model catalog', running: true });
    await mount(created({ total: 1, running: 1, items: [task] }));

    expect(one('.bg-tray-title')?.textContent).toBe(fixture.copy.title);
    expect(one('.ct-one')?.textContent).toBe(task.title);
    expect(one('.bg-tray-row .status-pill')?.textContent).toBe('Running');
    expect(one('.bg-tray-count'), 'one task is named, not counted').toBeNull();
  });

  it('writes the sentence the fixture gives for every count, its failed part in red', async () => {
    expect(css).toMatch(/\.ct-failed\s*\{[^}]*color:\s*var\(--error-solid\)/);
    for (const { text, ...counts } of fixture.countLine) {
      await mount(created({ ...counts, items: [row(1), row(2)] }));
      const label = JSON.stringify(counts);
      expect(one('.bg-tray-count')?.textContent, label).toBe(text);
      if (counts.failed > 0) {
        expect(one('.bg-tray-count .ct-failed')?.textContent, label).toBe(`${counts.failed} failed`);
      } else {
        expect(one('.ct-failed'), label).toBeNull();
      }
      expect(one('.ct-one'), label).toBeNull();
    }
  });

  it('keeps the row once everything is done, saying only how much is', async () => {
    const allDone = fixture.countLine.find((c) => c.done === c.total && c.running === 0 && c.failed === 0);
    expect(allDone, 'the fixture keeps an all-done case').toBeDefined();
    const { text, ...counts } = allDone!;
    await mount(
      created({ ...counts, items: [row(1, { status: 'DONE' }), row(2, { status: 'DONE' })] }),
    );
    expect(one('.bg-tray-count')?.textContent).toBe(text);
    expect(one('.ct-failed')).toBeNull();
  });

  it('never wraps the title: it truncates beside the sentence, stays whole beside one task', async () => {
    // What the stylesheet gives the elements drawn; how wide they come out is a browser's to say.
    const sheet = document.createElement('style');
    sheet.textContent = css;
    document.head.append(sheet);
    const style = (el: Element | null | undefined, ...props: (keyof CSSStyleDeclaration)[]) =>
      Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el!)[prop]]));
    const title = () => all('span').find((el) => el.textContent === fixture.copy.title);
    try {
      // The longest sentence seen: a pipeline session's 109,874 tasks, on a phone.
      await mount(created({ total: 109_874, running: 1, failed: 2, done: 281, items: [row(1), row(2)] }));
      expect(style(title(), 'whiteSpace', 'minWidth', 'overflow', 'textOverflow')).toEqual({
        whiteSpace: 'nowrap',
        minWidth: '0px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      // The sentence never shrinks below its words.
      expect(style(one('.ct-count'), 'whiteSpace', 'minWidth')).toEqual({
        whiteSpace: 'nowrap',
        minWidth: 'auto',
      });

      await mount(created({ total: 1, items: [row(1, { title: 'A task named at length '.repeat(8) })] }));
      expect(style(title(), 'whiteSpace', 'flexShrink')).toEqual({ whiteSpace: 'nowrap', flexShrink: '0' });
      expect(style(one('.ct-one'), 'minWidth', 'textOverflow')).toEqual({
        minWidth: '0px',
        textOverflow: 'ellipsis',
      });
    } finally {
      sheet.remove();
    }
  });
});

describe('the opened list', () => {
  it('opens and closes on a click anywhere on the row', async () => {
    await mount(created({ total: 2, items: [row(1), row(2)] }));
    expect(one('.ct-list')).toBeNull();
    await click(one('.bg-tray-row'));
    expect(one('.ct-list')).not.toBeNull();
    await click(one('.bg-tray-title'));
    expect(one('.ct-list')).toBeNull();
    await click(one('.wt-expand'));
    expect(one('.ct-list'), 'the caret opens it too, once, not twice').not.toBeNull();
  });

  it('draws the rows in the order the server sent them, each with its own pill', async () => {
    // Not an order any client-side sort would produce — newest first is broken, and so is Failed
    // before Done — so a list that re-sorts cannot pass.
    const items = [
      row(3, { status: 'DONE' }),
      row(1, { status: 'FAILED' }),
      row(5, { status: 'OPEN', queued: true }),
      row(2, { status: 'IN_PROGRESS', running: true }),
      row(4, { status: 'CANCELLED' }),
    ];
    await mount(created({ total: 5, running: 1, failed: 1, done: 1, items }));
    await click(one('.bg-tray-row'));

    expect(all('.ct-row .ct-title').map((t) => t.textContent)).toEqual(items.map((t) => t.title));
    expect(all('.ct-row .ct-pill .status-pill').map((p) => p.textContent)).toEqual([
      'Done',
      'Failed',
      'Queued',
      'Running',
      'Cancelled',
    ]);
    expect(all('.ct-row .ct-age')[0].textContent).toBe('3h ago');
    // Each row opens its task where an Orbit link card for it goes: the task's own page.
    expect(all('.ct-row').map((a) => a.getAttribute('href'))).toEqual(
      items.map((t) => `/tasks/${t.id}`),
    );
  });

  it('draws a task that was taken over as the one doing the work, naming the one it replaces', async () => {
    const original = row(9, { title: 'Fix the login redirect loop after the token expires' });
    const successor = row(1, {
      title: 'Fix the login redirect loop (rerun)',
      status: 'DONE',
      replaces: { id: original.id, title: original.title },
    });
    await mount(created({ total: 2, done: 1, items: [successor, row(2)] }));
    await click(one('.bg-tray-row'));

    const [first] = all('.ct-row');
    expect(first.querySelector('.ct-replaces')?.textContent).toBe(
      ` · ${fixture.copy.replacesPrefix}${original.title}`,
    );
    expect(first.querySelector('.ct-title')?.textContent).toBe(
      `${successor.title} · ${fixture.copy.replacesPrefix}${original.title}`,
    );
    expect(first.getAttribute('href'), 'the row opens the successor, not the task it replaced').toBe(
      `/tasks/${successor.id}`,
    );
    expect(first.querySelector('.status-pill')?.textContent).toBe('Done');
    expect(all('.ct-replaces')).toHaveLength(1);
  });

  it('links to every task this session created, and to each project they belong to', async () => {
    await mount(
      created({
        total: 2,
        items: [row(1, { projectId: PROJECT }), row(2)],
        projects: [{ id: PROJECT, title: 'Session tasks in the parking strip' }],
      }),
    );
    await click(one('.bg-tray-row'));

    expect(link(fixture.copy.viewAll)?.getAttribute('href')).toBe(`/tasks?createdIn=${SESSION}`);
    const projects = all('.ct-foot a').filter((a) => a.textContent === fixture.copy.openProject);
    expect(projects.map((a) => a.getAttribute('href'))).toEqual([`/projects/${PROJECT}`]);
  });

  it('offers no project link when none of its tasks is in a project', async () => {
    await mount(created({ total: 2, items: [row(1), row(2)] }));
    await click(one('.bg-tray-row'));
    expect(link(fixture.copy.viewAll)).toBeDefined();
    expect(link(fixture.copy.openProject)).toBeUndefined();
  });
});

describe('keeping it current', () => {
  const interval = (data: SessionCreatedTasks | undefined) => {
    const every = sessionCreatedTasksQuery(SESSION).refetchInterval as (
      query: Query<SessionCreatedTasks>,
    ) => number | false;
    return every({ state: { data } } as Query<SessionCreatedTasks>);
  };

  it('is read under the task prefix every task event refreshes', () => {
    expect(sessionCreatedTasksQuery(SESSION).queryKey.slice(0, 1)).toEqual(['tasks']);
  });

  it('polls while a row is running or queued, and not otherwise', () => {
    expect(interval(created({ total: 1, running: 1, items: [row(1, { running: true })] }))).toBe(15_000);
    expect(interval(created({ total: 1, items: [row(1, { queued: true })] }))).toBe(15_000);
    expect(interval(created({ total: 1, done: 1, items: [row(1, { status: 'DONE' })] }))).toBe(false);
    expect(interval(undefined)).toBe(false);
  });
});
