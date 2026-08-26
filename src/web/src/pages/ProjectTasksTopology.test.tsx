/**
 * The project task list as a topological plan rather than a tree.
 *
 * What these tests hold is the one claim the banding makes: everything inside a band can run at
 * the same time, and nothing in band N can start until band N-1 lands. Everything else here exists
 * to stop that claim from being quietly weakened — a band that sorts its own rows, a DONE task
 * padding out "what can run now", a `waits 3` that never says which three.
 *
 * Static renders throughout, matching ProjectsPage.test.tsx: react-query dispatches no fetch
 * during an effect-free render, so every fixture is seeded into the cache under the exact key the
 * component reads, and `api` is stubbed as a backstop against an accidental live call.
 */
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { ProjectTaskLevel, ProjectTasks, projectTaskGroups } from './ProjectsPage';

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

// Real UUIDs: the prerequisite read runs the row's id through encodeId, which throws on anything
// that is neither spelling — a placeholder here would fail the URL assertion for the wrong reason.
const P1 = '0195c0de-0000-7000-8000-000000000001';
const T1 = '0195c0de-0000-7000-8000-0000000000a1';
const T2 = '0195c0de-0000-7000-8000-0000000000a2';
const T3 = '0195c0de-0000-7000-8000-0000000000a3';
const T4 = '0195c0de-0000-7000-8000-0000000000a4';

/** The page holds ids in their public spelling, which is what the section is handed. */
const PROJECT = encodeId(P1);

// Spelled out rather than imported, like the keys in ProjectsPage.test.tsx: a key the component
// changes unilaterally should break these tests, which it cannot do if both sides read one
// constant.
const TASKS_KEY = ['project', PROJECT, 'tasks', 'root'];
const childKey = (parentTaskId: string) => ['project', PROJECT, 'tasks', 'children', parentTaskId];
const prereqKey = (taskId: string) => ['task', taskId, 'prerequisites'];

/** One row of the task page, carrying all four dependency facts the endpoint always sends. */
const task = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The section on its own, with one page of tasks already in the cache. */
function withPage(
  items: ReturnType<typeof task>[],
  nextCursor: string | null = null,
  seed?: (qc: QueryClient) => void,
) {
  const qc = newClient();
  qc.setQueryData(TASKS_KEY, { items, nextCursor });
  seed?.(qc);
  const out = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProjectTasks projectId={PROJECT} />
    </QueryClientProvider>,
  );
  return { qc, out };
}

/** Every band header in the order it was rendered. */
const bandKeys = (out: string) =>
  [...out.matchAll(/data-topo-group="([^"]+)"/g)].map((m) => m[1]);

/** One band's own markup: its header through to the next band's, or to the end. */
function band(out: string, key: string): string {
  const start = out.indexOf(`data-topo-group="${key}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = out.slice(start + 1);
  const next = rest.indexOf('data-topo-group="');
  return next === -1 ? rest : rest.slice(0, next);
}

/** One row draws exactly one status mark, so counting marks counts rows. */
const rowCount = (markup: string) => (markup.match(/data-glyph=/g) ?? []).length;

describe('ProjectTasks — topological bands', () => {
  it('bands the page by level, ascending, and puts the level’s size beside its name', () => {
    const { out } = withPage([
      task({ id: T1, title: 'Draft the schema', topoLevel: 0 }),
      task({ id: T2, title: 'Pick the palette', topoLevel: 0 }),
      task({ id: T3, title: 'Wire the endpoint', topoLevel: 1 }),
      task({ id: T4, title: 'Ship the page', topoLevel: 2 }),
    ]);

    expect(bandKeys(out)).toEqual(['level-0', 'level-1', 'level-2']);

    // The heading is the whole message: level 0 is what nothing in this project is holding up,
    // and every level after it names what it is queued behind. Read as a predicate rather than as
    // a fixed sentence — the wording of level 0's half is free to change, what it claims is not.
    expect(band(out, 'level-0')).toMatch(/Level 0\b/);
    expect(band(out, 'level-0')).toMatch(/\bready\b/i);
    expect(out).toContain('Level 1 · waits on level 0');
    expect(out).toContain('Level 2 · waits on level 1');

    // Two tasks at level 0 means two tasks that can be started right now, side by side — which is
    // the only thing this sort is for, and the number beside the heading is where it is legible.
    expect(rowCount(band(out, 'level-0'))).toBe(2);
    expect(rowCount(band(out, 'level-1'))).toBe(1);
    expect(rowCount(band(out, 'level-2'))).toBe(1);
    expect(band(out, 'level-0')).toContain('2 tasks');
    expect(band(out, 'level-1')).toContain('1 task');
    expect(out).not.toContain('1 tasks'); // the singular, spelled correctly
  });

  it('says who starts level 0, and never that it is already starting', () => {
    // Two rows, so the claim is read off a band header and not off a single task's own row.
    const { out } = withPage([
      task({ id: T1, title: 'Draft the schema', topoLevel: 0 }),
      task({ id: T2, title: 'Pick the palette', topoLevel: 0 }),
    ]);
    const heading = band(out, 'level-0');

    // The header used to read `ready now`, which promised a start nothing was going to make:
    // tasks in a project carry dispatch_authority COORDINATOR, the auto-run sweep takes only
    // LEGACY rows and stands down on these, and the control loop that once picked them up is
    // gone. Unblocked, then, but not on its way — and the header has to name whose move it is.
    expect(heading).not.toMatch(/ready now/i);
    expect(heading).toMatch(/coordinator/i);

    // Which is the same thing the coordinator card in the page head says from its side ("tasks
    // never start on their own"). If one of the two is ever softened, they stop agreeing, and a
    // reader is owed one answer about who starts this work rather than two.
    expect(heading).not.toMatch(/automatic|starts itself|starting now|will start/i);
  });

  it('sorts the bands but never the rows inside one', () => {
    // The page arrives out of level order and, within level 0, in an order only the server knows
    // the reason for. The bands must ascend; the rows inside a band must not be touched.
    const { out } = withPage([
      task({ id: T3, title: 'Zebra', topoLevel: 1 }),
      task({ id: T2, title: 'Yak', topoLevel: 0 }),
      task({ id: T1, title: 'Xerus', topoLevel: 0 }),
    ]);

    expect(bandKeys(out)).toEqual(['level-0', 'level-1']);
    expect(out.indexOf('Yak')).toBeLessThan(out.indexOf('Xerus'));
    expect(out.indexOf('Xerus')).toBeLessThan(out.indexOf('Zebra'));

    // Same claim, read off the partition itself rather than off the markup, so a reordering that
    // happened to render the same way still fails.
    const groups = projectTaskGroups([
      task({ id: T3, title: 'Zebra', topoLevel: 1 }),
      task({ id: T2, title: 'Yak', topoLevel: 0 }),
      task({ id: T1, title: 'Xerus', topoLevel: 0 }),
    ] as never);
    expect(groups.map((g) => g.level)).toEqual([0, 1]);
    expect(groups[0].tasks.map((t) => t.title)).toEqual(['Yak', 'Xerus']);
  });

  it('moves finished tasks out of their level into a dimmed band at the end', () => {
    const { out } = withPage([
      task({ id: T1, title: 'Landed already', status: 'DONE', topoLevel: 0 }),
      task({ id: T2, title: 'Still to do', status: 'OPEN', topoLevel: 1 }),
    ]);

    // Level 0 is gone: its only member has finished, and a band of finished work is not an answer
    // to "what can run now". The remaining level keeps its own number rather than being renumbered.
    expect(bandKeys(out)).toEqual(['level-1', 'done']);
    expect(out).toContain('Done');
    expect(out.indexOf('Still to do')).toBeLessThan(out.indexOf('Landed already'));
    expect(band(out, 'done')).toContain('Landed already');
    // Dimmed, not dropped: still the answer to "did that land?", just not to "what is next".
    expect(out).toMatch(/style="opacity:0\.55"/);
  });

  it('still says more tasks exist beyond the first page, and still offers no pager', () => {
    const { out } = withPage([task({ topoLevel: 0 })], 'eyJjcmVhdGVkQXQiOiIifQ');
    // The banding reads one page. Stopping silently at the end of it would read as "that is all
    // of them", which is exactly the wrong thing to tell someone reading a plan.
    expect(out).toContain('More top-level tasks exist beyond this first page');
    expect(out).not.toMatch(/Load more|Show more|Next page/i);
  });

  it('stays silent about further pages when the server returns no cursor', () => {
    expect(withPage([task()]).out).not.toContain('More top-level tasks exist');
  });
});

describe('ProjectTasks — waits and blocks badges', () => {
  it('shows both counts on a row that has both', () => {
    const { out } = withPage([
      task({ id: T3, title: 'Wire the endpoint', topoLevel: 1, unmetCount: 1, blocksCount: 27 }),
    ]);
    expect(out).toContain('waits 1');
    expect(out).toContain('blocks 27');
  });

  it('renders no badge at all on a row that waits on nothing and blocks nothing', () => {
    // Most rows in a real project are this row. A list where every one of them carries `waits 0`
    // and `blocks 0` is a list where the rows that DO carry a number stop standing out.
    const { qc, out } = withPage([task({ title: 'Standalone', unmetCount: 0, blocksCount: 0 })]);
    expect(out).toContain('Standalone');
    expect(out).not.toContain('waits');
    expect(out).not.toContain('blocks');
    // ...and nothing was armed to go looking for prerequisites it does not have.
    expect(qc.getQueryCache().find({ queryKey: prereqKey(T1) })).toBeUndefined();
  });

  it('arms the prerequisite read only on rows with two or more unmet prerequisites', () => {
    // The read is per row, so its budget is where the component is mounted, not an `enabled`
    // flag — a disabled query still takes an entry, and 100 of them is 100 entries.
    const { qc } = withPage([
      task({ id: T1, unmetCount: 0 }),
      task({ id: T2, unmetCount: 1 }),
      task({ id: T3, unmetCount: 2 }),
    ]);
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      TASKS_KEY,
      prereqKey(T3),
    ]);
  });

  it('asks for exactly one level upstream of that one task', () => {
    const { qc } = withPage([task({ id: T4, unmetCount: 3 })]);
    const registered = qc.getQueryCache().find({ queryKey: prereqKey(T4) });
    expect(registered).toBeDefined();
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    void (registered!.options.queryFn as (ctx: unknown) => unknown)({ queryKey: prereqKey(T4) });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toBe(
      `/tasks/${encodeId(T4)}/dependency-graph?direction=upstream&maxDepth=1`,
    );
  });
});

describe('ProjectTasks — which prerequisites a converging row waits on', () => {
  /** The upstream snapshot for T4: three direct prerequisites, all still open. */
  const threeUpstream = {
    focusTaskId: T4,
    nodes: [
      { id: T4, title: 'Ship the page', status: 'OPEN' },
      { id: T1, title: 'Draft the schema', status: 'OPEN' },
      { id: T2, title: 'Pick the palette', status: 'IN_PROGRESS' },
      { id: T3, title: 'Wire the endpoint', status: 'OPEN' },
    ],
    edges: [
      { sourceTaskId: T1, targetTaskId: T4 },
      { sourceTaskId: T2, targetTaskId: T4 },
      { sourceTaskId: T3, targetTaskId: T4 },
    ],
  };

  it('names all three, inline on the row', () => {
    // The information a tree cannot carry and a hand-drawn graph pays for in escape lines: `waits
    // 3` is a count, but WHICH three is what a reader has to know to go unblock them.
    const { out } = withPage(
      [task({ id: T4, title: 'Ship the page', topoLevel: 2, unmetCount: 3 })],
      null,
      (qc) => qc.setQueryData(prereqKey(T4), threeUpstream),
    );

    expect(out).toContain('waits 3');
    expect(out).toContain('Draft the schema');
    expect(out).toContain('Pick the palette');
    expect(out).toContain('Wire the endpoint');
    // All three accounted for, so nothing is elided.
    expect(out).not.toMatch(/\+\d+ more/);
  });

  it('leaves out prerequisites that have already settled', () => {
    // `unmetCount` counts what is NOT done; the names beside it have to be the same set, or the
    // row says "waiting on" about work that finished.
    const { out } = withPage(
      [task({ id: T4, title: 'Ship the page', unmetCount: 2 })],
      null,
      (qc) =>
        qc.setQueryData(prereqKey(T4), {
          ...threeUpstream,
          nodes: threeUpstream.nodes.map((n) =>
            n.id === T2 ? { ...n, status: 'DONE' } : n.id === T3 ? { ...n, status: 'OPEN' } : n,
          ),
        }),
    );
    expect(out).toContain('Draft the schema');
    expect(out).toContain('Wire the endpoint');
    expect(out).not.toContain('Pick the palette');
  });

  it('says how many it could not name rather than listing a partial set as if it were whole', () => {
    // The count comes from the page and the names from the graph, so they can disagree — a
    // collapsed branch, or a graph read a moment later. Silently listing one of three is the
    // failure mode this exists to stop.
    const { out } = withPage([task({ id: T4, unmetCount: 3 })], null, (qc) =>
      qc.setQueryData(prereqKey(T4), {
        focusTaskId: T4,
        nodes: [
          { id: T4, title: 'Ship the page', status: 'OPEN' },
          { id: T1, title: 'Draft the schema', status: 'OPEN' },
        ],
        edges: [{ sourceTaskId: T1, targetTaskId: T4 }],
      }),
    );
    expect(out).toContain('waits 3');
    expect(out).toContain('Draft the schema');
    expect(out).toContain('+2 more');
  });

  it('shows the badge alone while the prerequisite read is still in flight', () => {
    // Nothing seeded: the count is already on screen and correct, so a spinner or an error strip
    // inside the row would be a second thing to read about something the row is not missing.
    const { out } = withPage([task({ id: T4, title: 'Ship the page', unmetCount: 3 })]);
    expect(out).toContain('waits 3');
    expect(out).not.toContain('→');
  });
});

describe('ProjectTasks — status carried by shape', () => {
  it('gives the five statuses five different marks, including a failed task', () => {
    const { out } = withPage([
      task({ id: T1, title: 'Open one', status: 'OPEN' }),
      task({ id: T2, title: 'Running one', status: 'IN_PROGRESS' }),
      task({ id: T3, title: 'Cancelled one', status: 'CANCELLED' }),
      task({ id: T4, title: 'Done one', status: 'DONE' }),
      task({ id: '0195c0de-0000-7000-8000-0000000000a5', title: 'Failed one', status: 'FAILED' }),
    ]);

    const glyphs = [...out.matchAll(/data-glyph="([^"]+)"/g)].map((m) => m[1]);
    expect(glyphs).toHaveLength(5);
    expect(new Set(glyphs).size).toBe(5);
    expect(glyphs).toContain('cross');

    // Not five names for one drawing: strip every paint attribute and the five marks are still
    // pairwise different, which is what makes them readable to someone who cannot tell the
    // colours apart.
    const drawings = [...out.matchAll(/<svg[^>]*data-glyph="[^"]*"[^>]*>([\s\S]*?)<\/svg>/g)].map(
      (m) => m[1].replace(/\s*(?:fill|stroke)="[^"]*"/g, ''),
    );
    expect(drawings).toHaveLength(5);
    expect(new Set(drawings).size).toBe(5);

    // The mark is for the eye only — the row's own status text is what a screen reader gets, so a
    // second reading of "DONE" from the shape would be noise.
    expect(out).toMatch(/<svg[^>]*data-glyph="[^"]*"[^>]*aria-hidden="true"/);
    expect(out).toContain('CANCELLED');
    expect(out).toContain('IN_PROGRESS');
    expect(out).toContain('FAILED');
  });

  it('uses a neutral fallback mark for a status newer than this web bundle', () => {
    const { out } = withPage([
      task({ id: T1, title: 'Future state', status: 'FUTURE_STATUS' }),
    ]);

    expect(out).toContain('Future state');
    expect(out).toContain('FUTURE_STATUS');
    expect(out).toContain('data-glyph="ring"');
  });
});

describe('ProjectTasks — the parent/child level underneath', () => {
  it('keeps a row’s disclosure closed, unfetched, and named after the row', () => {
    const { qc, out } = withPage([
      task({ id: T1, title: 'Has children', childCount: 3, topoLevel: 1 }),
    ]);
    expect(out).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[^<]*<span>Show subtasks<\/span>/);
    expect(out).toContain('aria-label="Show subtasks for Has children"');
    expect(out).toContain('3 subtasks');
    // Closed still means unfetched: banding the rows must not have made the child pages eager.
    expect(qc.getQueryCache().find({ queryKey: childKey(T1) })).toBeUndefined();
  });

  it('still pulls the level below when that row is opened', () => {
    // A static render cannot press the button, so the opened level is mounted directly — the seam
    // ProjectTaskLevel is exported for. The child rows go through the same row component, so the
    // badges have to survive the trip down.
    const qc = newClient();
    qc.setQueryData(childKey(T1), {
      items: [task({ id: T2, title: 'A child', unmetCount: 2, blocksCount: 4, topoLevel: 2 })],
      nextCursor: null,
    });
    const level = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ProjectTaskLevel projectId={PROJECT} parentTaskId={T1} />
      </QueryClientProvider>,
    );
    expect(level).toContain('A child');
    expect(level).toContain('waits 2');
    expect(level).toContain('blocks 4');
    expect(level).toMatch(/data-glyph="/);
  });
});

describe('ProjectTasks — narrow rows', () => {
  it('lets source-like task copy wrap instead of widening the document scroller', () => {
    // The production failure was a grep alternation in acceptanceCriteria: there is no whitespace
    // for an ordinary line-break algorithm to use, so the 180-character excerpt became the row's
    // min-content width and made the project page horizontally scrollable on an iPhone.
    const symbolRun =
      'NewProjectModal|NewProjectForm|NewProjectDraft|EMPTY_NEW_PROJECT_DRAFT|canCreateProject';
    const title = `Remove_${symbolRun}_${symbolRun}`;
    const criteria = `${symbolRun}|${symbolRun}|${symbolRun}`;
    const { out } = withPage([task({ title, acceptanceCriteria: criteria, childCount: 2 })]);

    // Copy remains complete by policy: the title is never truncated, while criteria still use the
    // existing 180-character excerpt. Layout is fixed by owned hooks rather than by deleting text.
    expect(out).toContain(title);
    expect(out).toContain(`${criteria.slice(0, 180)}…`);
    expect(out).toContain('class="project-task-row-layout"');
    expect(out).toContain('class="project-task-row-copy"');
    expect(out).toContain('class="project-task-row-title"');
    expect(out).toContain('class="project-task-row-description"');
    expect(out).toContain('class="project-task-row-count"');
    expect(out).toContain('project-task-row-disclosure');

    // jsdom has no layout engine, so assert the CSS contract directly, following the other
    // responsive tests in this package. A real-browser smoke check covers scrollWidth separately.
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const layout = css.match(/\.project-task-row-layout\s*\{([^}]*)\}/)?.[1] ?? '';
    const shrinkBoundary =
      css.match(
        /\.project-task-row-copy,\s*\.project-task-row-meta,\s*\.project-task-row-meta \.ant-list-item-meta-content\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const wrapping =
      css.match(
        /\.project-task-row-title,\s*\.project-task-row-description\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const phoneRules =
      css.match(
        /@media \(max-width: 640px\) \{([\s\S]*?)\n\}\n\n\/\* The acceptance section/,
      )?.[1] ?? '';

    expect(layout).toContain('min-width: 0');
    expect(layout).toContain('width: 100%');
    expect(shrinkBoundary).toContain('min-width: 0');
    expect(wrapping).toContain('overflow-wrap: anywhere');
    expect(phoneRules).toMatch(/\.project-task-row-layout\s*\{[^}]*flex-wrap: wrap/);
    expect(phoneRules).toMatch(/\.project-task-row-copy\s*\{[^}]*flex: 1 0 100%/);
  });
});
