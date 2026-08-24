import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  EMPTY_NEW_TASK_DRAFT,
  NewProjectTaskForm,
  ProjectCoordinatorControl,
  ProjectDetailPage,
  ProjectTaskLevel,
  ProjectsPage,
  coordinatorSessionPath,
  createProjectTask,
  invalidateAfterProjectTaskCreate,
  newProjectTaskBody,
  openProjectCoordinator,
  runAtIso,
  runAtProblem,
  scheduledStart,
  RUN_AT_IMPOSSIBLE,
  canCreateProjectTask,
  type NewProjectTaskDraft,
} from './ProjectsPage';

// react-query never dispatches a fetch during a static (effect-free) render — confirmed by
// instrumenting it directly, matching TaskListView.test.tsx's own note that these tests must
// seed the cache instead of letting the real request run. So `api` is stubbed both as a backstop
// against an accidental live call and as the place a URL shows up when a test calls a registered
// queryFn by hand (see urlOf); the source-level endpoint check below is what fixes the shape of
// every call, including the ones no test invokes.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));
// The project page now draws the dependency graph itself, behind a `lazy()` boundary. A static
// render only ever paints that boundary's fallback, so pulling React Flow into this
// node-environment suite would buy nothing but its import cost — the graph is asserted in
// ProjectTasksGraph's own suite, which mounts into a DOM.
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});

const source = readFileSync(fileURLToPath(new URL('./ProjectsPage.tsx', import.meta.url)), 'utf8');

// Real UUIDs, not placeholder strings: the row link runs them through encodeId, which throws on
// anything that is neither spelling — so a fake id here would fail the render, not the assertion.
const P1 = '0195c0de-0000-7000-8000-000000000001';
const P2 = '0195c0de-0000-7000-8000-000000000002';
const P3 = '0195c0de-0000-7000-8000-000000000003';
// A task id in the raw-UUID spelling a payload can still carry across the public-id migration:
// what goes on the wire has to be the short public id whichever spelling the row was handed.
const T1 = '0195c0de-0000-7000-8000-0000000000a1';
// A session id in the raw-UUID spelling the coordinator response can still carry, alongside the
// short public id the web normally holds: one route has to come out of either.
const S1 = '0195c0de-0000-7000-8000-0000000000b1';

function renderPage(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The detail page reads its id from the route, so it needs a real matched route to render under
// — `urlId` is what the URL carries, which is not always what the query key holds (see the
// raw-UUID case below).
function renderDetail(qc: QueryClient, urlId: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${urlId}`]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function newClient() {
  // refetchOnMount/retryOnMount:false keep a seeded cache entry (success OR error) from being
  // treated as needing a fresh fetch on this mount — the assertions below are about what's
  // already in cache, not about a race with a background refetch during the static render.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

// The tasks section's own cache entry: keyed by the NORMALIZED project id (what the URL carries
// is not always what the key holds) and by the level being read, so a later subtask page under the
// same project cannot land here. Spelled out rather than imported — a key the component changed
// unilaterally should break these tests, which it can't do if both sides read one constant.
const tasksKey = (projectUuid: string) => ['project', encodeId(projectUuid), 'tasks', 'root'];

// The Coordinator surface's own entry, under the SAME `['project', id]` prefix as the document —
// which is what makes one invalidation after a control write refresh both. Spelled out here for
// the same reason tasksKey is: a key the page changed unilaterally should break these tests.

// Unit L7's two entries, under the same `['project', id]` prefix and for the same reason: what a
// person is asked to ANSWER about this project (the crossings queue) and what reopening it would
// cost. Both mount with the page, so an invalidation after either write refreshes them together
// with the document.
const attributionKeys = (projectUuid: string) => {
  const id = encodeId(projectUuid);
  return [
    ['project', id, 'crossings'],
    ['project', id, 'reopen'],
  ];
};

// Every entry the panorama cards register, in the order they mount. Three, not four: the
// acceptance card reads the project document under `['project', id]` — the entry the page already
// holds — and the chain strip deliberately shares the header's `panorama` key and the ranking's
// `blocking` one, so neither adds a request.
const panoramaKeys = (projectUuid: string) => {
  const id = encodeId(projectUuid);
  return [
    ['project', id, 'panorama'],
    ['project', id, 'panorama', 'blocking', 5],
  ];
};

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  title: 'Design the landing page',
  status: 'OPEN',
  parentTaskId: null,
  acceptanceCriteria: 'Passes design review',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  dueDate: null,
  assignee: null,
  childCount: 0,
  // The four dependency facts the task page derives on every read. Spelled out here because the
  // endpoint always sends all four — a row that is part of no dependency at all still carries
  // them, which is what makes an absent key mean "this server does not report dependencies"
  // rather than "this task has none". A fixture missing them would test a payload nobody sends.
  unmetCount: 0,
  blocksCount: 0,
  topoLevel: 0,
  dependencyState: 'READY',
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  id: P1,
  title: 'Website Revamp',
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  acceptanceCriteria: 'Lighthouse ≥ 90 on every page',
  instructions: 'Land behind a flag, then flip it',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 5 },
  tasksByStatus: { OPEN: 2, DONE: 3 },
  ...over,
});

describe('ProjectsPage', () => {
  it('reads exactly GET /projects, GET /projects/<id>, the coordinator POST, the two task-page levels, the per-row prerequisite read and the task-create POST — no other endpoint', () => {
    // Negative control: a static render never invokes queryFn (nothing to observe at runtime —
    // see the module comment), so this asserts on the one place the real endpoints are decided.
    // Fails if any call grows extra args or a query string, if a path changes, or if an eighth
    // api(...) call is added anywhere in the file. The arg pattern allows two levels of nesting so
    // that neither encodeURIComponent(...) nor the encodeId(...) inside it cuts the match short —
    // a call it cannot parse drops out of this list entirely, which fails the assertion too.
    const apiCalls = [
      ...source.matchAll(/\bapi(?:<[^>]*>)?\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g),
    ].map(
      // A call wrapped across lines keeps its trailing comma; the URL is what this asserts on.
      (m) => m[1].trim().replace(/,$/, ''),
    );
    expect(apiCalls).toEqual([
      "'/projects'",
      '`/projects/${encodeURIComponent(id!)}`',
      // The write that opens the conversation with this project's coordinator, and the reason it
      // is one: resolve-or-create, so a stale or trashed binding is repaired server-side rather
      // than followed. Method and body are held here as literally as the path, because an empty
      // body is the whole contract of this unit.
      "`/projects/${encodeURIComponent(projectId)}/coordinator`, { method: 'POST', body: {} }",
      // Exactly this, spelled out: the root level is requested by sending NO parentId, so an
      // added `&parentId=…` here would silently turn this into a subtask page under the same
      // cache key. `limit=100` is inline rather than interpolated so this stays a literal read
      // of the URL that goes on the wire.
      '`/projects/${encodeURIComponent(projectId)}/tasks/page?limit=100`',
      // WHICH prerequisites a multi-prerequisite row is waiting on, one level up and no further:
      // `maxDepth=1` is the whole point, since a row states a direct relationship and anything
      // deeper is the dependency graph's job. `direction=upstream` keeps the dependents out of a
      // response this row would only discard. Held literally so a depth or direction added here
      // cannot quietly turn a per-row read into a subtree walk — this is the one endpoint in the
      // file that is fetched once PER ROW, and only by the rows that render it.
      '`/tasks/${encodeURIComponent(encodeId(task.id))}/dependency-graph?direction=upstream&maxDepth=1`',
      // The level below a row: the same endpoint, plus exactly one `parentId`, carrying the id
      // through encodeId so the server is named a parent the way it names one itself, and escaped
      // like the path segment above. What each of these two fetches is asserted at runtime further
      // down — base62 has nothing to escape, so the escaping itself is held here — and this list
      // is what proves there is no THIRD task-page spelling and no sixth endpoint in the file.
      '`/projects/${encodeURIComponent(projectId)}/tasks/page?parentId=${encodeURIComponent(encodeId(parentTaskId))}&limit=100`',
      // The one write that CREATES anything: a top-level task in this
      // project. The path is the generic task collection rather than a nested project route —
      // `projectId` is a field of the body, which is why it is built in one place instead of
      // interpolated here. What that body carries, and what it deliberately leaves out, is
      // asserted at runtime further down.
      "'/tasks', { method: 'POST', body: newProjectTaskBody(projectId, draft) }",
    ]);
    // ...that `id` is the normalized route id, not the raw param — the detail URL and the cache
    // key have to agree on one spelling...
    expect(source).toContain('const id = routeId(params.id)');
    // ...and that it stays nullable rather than collapsing to '', which would put a request to
    // `/projects/` on the wire the moment the param went missing.
    expect(source).not.toMatch(/routeId\(params\.id\)\s*\?\?/);
    expect(source).toContain('enabled: Boolean(id)');
    // The New task form's three option sources are read through the shared query factories, not
    // re-spelled here — which is what keeps the list above a complete account of this file's
    // requests, and what keeps its keys identical to the ones the task panel's pickers use.
    expect(source).toContain(
      [
        'import {',
        '  providersQuery,',
        '  runnersQuery,',
        '  workspacesQuery,',
        "} from '../lib/queries';",
      ].join('\n'),
    );
  });

  it('renders each project’s title, status, task count and goal excerpt/fallback', () => {
    // Well past any sensible row-length cap — proves long goals get truncated, not just shown.
    const longGoal = 'Ship the new marketing site. '.repeat(10);
    const qc = newClient();
    qc.setQueryData(['projects'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: 'Ship the new marketing site',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 5 },
      },
      {
        id: P2,
        title: 'Legacy Cleanup',
        status: 'DONE',
        goal: null,
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-04T00:00:00Z',
        _count: { tasks: 1 },
      },
      {
        id: P3,
        title: 'Ledger Migration',
        status: 'OPEN',
        goal: longGoal,
        createdAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-06T00:00:00Z',
        _count: { tasks: 2 },
      },
    ]);
    const html = renderPage(qc);
    expect(html).toContain('Website Revamp');
    expect(html).toContain('OPEN');
    expect(html).toContain('Ship the new marketing site');
    expect(html).toContain('5 tasks');
    expect(html).toContain('Legacy Cleanup');
    expect(html).toContain('DONE');
    expect(html).toContain('No goal set'); // fallback for a null goal
    expect(html).toContain('1 task'); // singular, not "1 tasks"
    expect(html).toContain('Ledger Migration');
    expect(html).not.toContain(longGoal); // the full 300-char goal must not reach the row
    expect(html).toContain(`${longGoal.slice(0, 180)}…`); // capped at 180 chars + one ellipsis
  });

  it('links the whole row to its project at the short public id, never the raw UUID', () => {
    const qc = newClient();
    qc.setQueryData(['projects'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 5 },
      },
    ]);
    const html = renderPage(qc);
    expect(html).toContain(`href="/projects/${encodeURIComponent(encodeId(P1))}"`);
    // A raw-UUID href still resolves (routeId normalizes), so only the encoded form proves the
    // link was built the way every other link in the app is.
    expect(html).not.toContain(`href="/projects/${P1}"`);
    // base62 needs no percent-escaping, so the rendered href can't tell whether the id was
    // escaped at all — assert on the call itself, which is what keeps a future id alphabet safe.
    expect(source).toContain('to={`/projects/${encodeURIComponent(encodeId(p.id))}`}');

    // The link has to span the row — meta AND count — so the whole row is one tab stop and one
    // click target, not just the title. An <a href> is keyboard-focusable by construction.
    const anchor = html.match(/<a\b[^>]*href="\/projects\/[^"]+"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    expect(anchor).toContain('Website Revamp');
    expect(anchor).toContain('No goal set');
    expect(anchor).toContain('5 tasks');
  });

  it('shows an empty state when there are no projects', () => {
    const qc = newClient();
    qc.setQueryData(['projects'], []);
    const html = renderPage(qc);
    expect(html).toContain('No projects yet');
  });

  it('shows an error with a Retry action when the load fails', async () => {
    const qc = newClient();
    // Seed a settled error state for the exact same key the page reads, independent of apiMock.
    await qc.prefetchQuery({ queryKey: ['projects'], queryFn: () => Promise.reject(new Error('network down')) });
    const html = renderPage(qc);
    expect(html).toContain('Projects could not be loaded');
    expect(html).toContain('network down');
    expect(html).toContain('Retry');
  });
});

describe('ProjectDetailPage', () => {
  it('renders the title, status, total tasks, per-status tallies and the full long-form fields', () => {
    // Longer than the list row's 180-char cap: the detail page is where a goal is read in full,
    // so it must arrive uncut rather than re-truncated here.
    const longGoal = 'Ship the new marketing site. '.repeat(10).trim();
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail({ goal: longGoal }));
    const html = renderDetail(qc, encodeId(P1));
    expect(html).toContain('Website Revamp');
    expect(html).toContain('OPEN');
    expect(html).toContain('5 tasks');
    expect(html).toContain('OPEN 2'); // tasksByStatus, one tag per status the server returned
    expect(html).toContain('DONE 3');
    expect(html).toContain('Goal');
    expect(html).toContain(longGoal); // in full — no excerpt, no ellipsis
    expect(html).not.toContain('…');
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('Lighthouse ≥ 90 on every page');
    expect(html).toContain('Instructions');
    expect(html).toContain('Land behind a flag, then flip it');
    expect(html).toContain('href="/projects"'); // back to the list
  });

  it('reads the long-form fields as Markdown rather than printing their source', () => {
    // All three are written as prompts — a coordinator is handed them verbatim — so they arrive
    // with headings, lists and emphasis in them, and the page that shows a human the same text
    // must not be the one place it reads as source.
    const qc = newClient();
    qc.setQueryData(
      ['project', encodeId(P1)],
      detail({
        goal: '## Ship it\n\n- new marketing site\n- **90** Lighthouse',
        instructions: 'Land behind a flag,\nthen flip it',
      }),
    );
    const html = renderDetail(qc, encodeId(P1));

    expect(html).toContain('<h2>Ship it</h2>');
    expect(html).toContain('<li>new marketing site</li>');
    expect(html).toContain('<strong>90</strong>');
    // ...and none of the markers are left standing where the reader can see them.
    expect(html).not.toContain('## Ship it');
    expect(html).not.toContain('**90**');
    // A lone newline stays a line break: these are hand-laid-out fields that used to be rendered
    // pre-wrapped, and CommonMark's soft break would run their lines together.
    expect(html).toContain('Land behind a flag,<br/>');
  });

  it('falls back for every empty field and for a project with no tasks', () => {
    const qc = newClient();
    qc.setQueryData(
      ['project', encodeId(P2)],
      detail({
        id: P2,
        title: 'Legacy Cleanup',
        goal: null,
        acceptanceCriteria: null,
        instructions: null,
        _count: { tasks: 0 },
        // groupBy returns no rows for a project with no tasks — an empty object, not zeroes.
        tasksByStatus: {},
      }),
    );
    const html = renderDetail(qc, encodeId(P2));
    expect(html).toContain('Legacy Cleanup');
    expect(html).toContain('0 tasks');
    expect(html).toContain('No tasks yet');
    expect(html).toContain('No goal set');
    expect(html).toContain('No acceptance criteria set');
    expect(html).toContain('No instructions set');
  });

  it('normalizes a raw-UUID URL onto the same cache key as the encoded one', () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    // Seeded under the encoded key, visited by UUID: it renders only if routeId normalized first,
    // which is the same normalization that keeps GET /projects/<id> off a second spelling.
    expect(renderDetail(qc, P1)).toContain('Website Revamp');
  });

  it('refuses to request anything when the route carries no id', () => {
    // Rendered under a route with no :id segment, so params.id is undefined. The page must say so
    // outright rather than fetch `/projects/` — a URL for no project, which the list route answers
    // with 200 and a body this page would then try to read as one.
    const html = renderToStaticMarkup(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter initialEntries={['/projects']}>
          <Routes>
            <Route path="/projects" element={<ProjectDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain('Project could not be loaded');
    expect(html).toContain('This link is missing a project id');
    expect(html).not.toContain('Retry'); // nothing was asked for, so there is nothing to retry
    expect(html).not.toContain('ant-spin'); // and nothing in flight to wait on
    expect(html).toContain('href="/projects"'); // only a way back
  });

  it('still queries a malformed id, so a bad link surfaces as the server’s 404', async () => {
    const qc = newClient();
    // routeId can't decode this, so it falls through as-is — non-empty, therefore a real request.
    await qc.prefetchQuery({
      queryKey: ['project', 'not-a-real-id'],
      queryFn: () => Promise.reject(new Error('project not found')),
    });
    const html = renderDetail(qc, 'not-a-real-id');
    expect(html).toContain('Project could not be loaded');
    expect(html).toContain('project not found');
    expect(html).toContain('Retry'); // a real query failed — unlike the missing-id case above
    expect(html).not.toContain('This link is missing a project id');
  });

  it('spins while the project is still loading', () => {
    // Nothing seeded: react-query reports the optimistic pending state on first render.
    expect(renderDetail(newClient(), encodeId(P1))).toContain('ant-spin');
  });

  it('shows an error with a Retry action when the project fails to load', async () => {
    const qc = newClient();
    await qc.prefetchQuery({
      queryKey: ['project', encodeId(P1)],
      queryFn: () => Promise.reject(new Error('network down')),
    });
    const html = renderDetail(qc, encodeId(P1));
    expect(html).toContain('Project could not be loaded');
    expect(html).toContain('network down');
    expect(html).toContain('Retry');
    expect(html).toContain('href="/projects"'); // the way out stays reachable on the error path
  });

  it('keeps rendering the project itself when its tasks fail to load', async () => {
    // The tasks section is an addition to this page, not a gate on it: a failed task page must
    // cost the reader the task list and nothing else.
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    await qc.prefetchQuery({ queryKey: tasksKey(P1), queryFn: () => Promise.reject(new Error('tasks down')) });
    const html = renderDetail(qc, encodeId(P1));
    expect(html).toContain('Website Revamp');
    expect(html).toContain('5 tasks');
    expect(html).toContain('Lighthouse ≥ 90 on every page');
    expect(html).not.toContain('Project could not be loaded');
  });

  it('is routed at /projects/:id inside the app shell, wrapped in DocView', () => {
    // The page only gets a gutter + its own scroll region if it's wrapped like the other doc
    // views; an unwrapped route renders into a full-bleed shell instead.
    const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
    expect(app).toMatch(
      /path="projects\/:id"\s*\n\s*element=\{\s*\n\s*<DocView>\s*\n\s*<ProjectDetailPage \/>/,
    );
  });
});

describe('ProjectDetailPage — top-level tasks', () => {
  /** A detail page whose project loaded, so the tasks section is actually mounted. */
  function withProject(seed?: (qc: QueryClient) => void) {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    seed?.(qc);
    return { qc, html: () => renderDetail(qc, encodeId(P1)) };
  }

  it('renders every root task in full: title, status, criteria excerpt/fallback and subtask count', () => {
    // Well past the 180-char row cap, so this proves the criteria get cut rather than merely shown.
    const longCriteria = 'Every breakpoint matches the comp. '.repeat(10);
    // Long enough that a title-truncating row would be caught: a half-read title names a
    // different task, so this one must arrive whole.
    const longTitle = 'Migrate the ledger export job off the legacy scheduler and onto the queue';
    const { qc, html } = withProject((c) =>
      c.setQueryData(tasksKey(P1), {
        items: [
          task({ id: 't1', status: 'IN_PROGRESS', acceptanceCriteria: longCriteria, childCount: 3 }),
          task({ id: 't2', title: longTitle, status: 'DONE', acceptanceCriteria: null, childCount: 1 }),
          task({ id: 't3', title: 'Retire the old CDN', status: 'CANCELLED', childCount: 0 }),
        ],
        nextCursor: null,
      }),
    );
    const out = html();

    expect(out).toContain('Tasks');
    expect(out).toContain('Design the landing page');
    expect(out).toContain('IN_PROGRESS'); // a status a PROJECT can never have — its own colour map
    expect(out).toContain(longTitle); // whole, not excerpted
    expect(out).toContain('DONE');
    expect(out).toContain('Retire the old CDN');
    expect(out).toContain('CANCELLED');

    // Acceptance criteria: capped with one ellipsis, never delivered whole to a row...
    expect(out).toContain(`${longCriteria.slice(0, 180)}…`);
    expect(out).not.toContain(longCriteria);
    // ...shown as-is when it already fits...
    expect(out).toContain('Passes design review');
    // ...and named rather than left blank when there is none.
    expect(out).toContain('No acceptance criteria set');

    // Subtask counts, with the singular spelled correctly — `1 subtasks` is the bug this catches.
    expect(out).toContain('3 subtasks');
    expect(out).toContain('1 subtask');
    expect(out).not.toContain('1 subtasks');
    expect(out).toContain('0 subtasks');

    // The children themselves stay unfetched. Rendering a row with `3 subtasks` on it must not
    // open a page for those three — expansion is the next unit, so the document, its root task
    // level, the panorama's own entries and the Coordinator surface's one read are the only
    // queries this page is allowed to have.
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ['project', encodeId(P1)],
      tasksKey(P1),
      ...panoramaKeys(P1),
      ...attributionKeys(P1),
    ]);
  });

  it('reads the page from a key naming both the project and the root level', () => {
    // Seeded under the exact key and rendered without a stub: the row can only appear if the
    // component asked for THIS entry. A key missing the project id would collide across projects;
    // one missing the level would collide with the subtask pages that come next.
    const { html } = withProject((qc) =>
      qc.setQueryData(tasksKey(P1), { items: [task({ title: 'Only via the right key' })], nextCursor: null }),
    );
    expect(html()).toContain('Only via the right key');

    // ...and it is a different entry from the project document itself, which is keyed one level up.
    const other = newClient();
    other.setQueryData(['project', encodeId(P1)], detail());
    other.setQueryData(tasksKey(P2), { items: [task({ title: 'Another project’s task' })], nextCursor: null });
    expect(renderDetail(other, encodeId(P1))).not.toContain('Another project’s task');
  });

  it('says so when the project has no top-level tasks', () => {
    const { html } = withProject((qc) => qc.setQueryData(tasksKey(P1), { items: [], nextCursor: null }));
    const out = html();
    expect(out).toContain('Tasks');
    expect(out).toContain('No top-level tasks yet');
    // Distinct from the per-status tally's own empty line, which is about a different count.
    expect(out).toContain('OPEN 2');
  });

  it('spins under the Tasks heading while the page is still loading', () => {
    // Project seeded, tasks not: the section is mounted and pending, which is a state of its own
    // rather than a silently empty list.
    const { html } = withProject();
    const out = html();
    expect(out).toContain('Tasks');
    expect(out).toContain('ant-spin');
    expect(out).not.toContain('No top-level tasks yet');
  });

  it('shows an error with a Retry action when the task page fails', async () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    await qc.prefetchQuery({ queryKey: tasksKey(P1), queryFn: () => Promise.reject(new Error('tasks down')) });
    const out = renderDetail(qc, encodeId(P1));
    expect(out).toContain('Tasks could not be loaded');
    expect(out).toContain('tasks down');
    expect(out).toContain('Retry');
  });

  it('says more top-level tasks exist when the server returns a cursor — without a pager', () => {
    const { html } = withProject((qc) =>
      qc.setQueryData(tasksKey(P1), { items: [task()], nextCursor: 'eyJjcmVhdGVkQXQiOiIifQ' }),
    );
    const out = html();
    expect(out).toContain('More top-level tasks exist beyond this first page');
    // This unit reads one page and sends no cursor, so it must not offer a control that would.
    expect(out).not.toMatch(/Load more|Show more|Next page/i);
  });

  it('stays silent about further pages when the server returns none', () => {
    const { html } = withProject((qc) =>
      qc.setQueryData(tasksKey(P1), { items: [task()], nextCursor: null }),
    );
    expect(html()).not.toContain('More top-level tasks exist');
  });

  it('does not create the tasks query until the project itself has loaded', async () => {
    // Mounting a useQuery registers it in the cache even in a static render (no effects needed),
    // so "is there an entry for this key" is a direct read of whether the request was armed at
    // all — stronger than checking that no rows rendered, which an empty page would also satisfy.
    const key = tasksKey(P1);

    const pending = newClient(); // nothing seeded: the project is still loading
    renderDetail(pending, encodeId(P1));
    expect(pending.getQueryCache().find({ queryKey: key })).toBeUndefined();

    const failed = newClient();
    await failed.prefetchQuery({
      queryKey: ['project', encodeId(P1)],
      queryFn: () => Promise.reject(new Error('network down')),
    });
    renderDetail(failed, encodeId(P1));
    expect(failed.getQueryCache().find({ queryKey: key })).toBeUndefined();

    const missingId = newClient(); // no :id in the route at all — nothing to key a task page by
    renderToStaticMarkup(
      <QueryClientProvider client={missingId}>
        <MemoryRouter initialEntries={['/projects']}>
          <Routes>
            <Route path="/projects" element={<ProjectDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The project's own query is still built — it is declared unconditionally and `enabled` is
    // what keeps it off the wire — but no task page is, because there is no id to key one by.
    expect(missingId.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([['project', null]]);

    // Only a project that actually came back arms it.
    const loaded = newClient();
    loaded.setQueryData(['project', encodeId(P1)], detail());
    renderDetail(loaded, encodeId(P1));
    expect(loaded.getQueryCache().find({ queryKey: key })).toBeDefined();
  });
});

describe('ProjectDetailPage — expanding a task onto its subtasks', () => {
  // One row's children, keyed by project AND parent. Spelled out rather than imported, for the
  // same reason tasksKey is: a key the component changes unilaterally has to break these tests.
  const childKey = (projectUuid: string, parentTaskId: string) => [
    'project',
    encodeId(projectUuid),
    'tasks',
    'children',
    parentTaskId,
  ];

  /** A detail page whose project and root task page both loaded, so the rows are on screen. */
  function withRows(items: ReturnType<typeof task>[]) {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    qc.setQueryData(tasksKey(P1), { items, nextCursor: null });
    return { qc, out: renderDetail(qc, encodeId(P1)) };
  }

  /** One opened level, mounted on its own: a static render cannot press the row's button, so this
   *  is the only way to assert what an expansion actually puts on screen. */
  function renderLevel(qc: QueryClient, projectId: string, parentTaskId: string) {
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ProjectTaskLevel projectId={projectId} parentTaskId={parentTaskId} />
      </QueryClientProvider>,
    );
  }

  /** The URL a registered query would really fetch. The static render never dispatches it (see the
   *  module comment), but the queryFn it registered is sitting in the cache — calling that by hand
   *  reads the URL itself, where the source assertion above only reads the code that builds it. */
  function urlOf(qc: QueryClient, queryKey: unknown[]): string {
    const registered = qc.getQueryCache().find({ queryKey });
    if (!registered) throw new Error(`nothing registered for ${JSON.stringify(queryKey)}`);
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    void (registered.options.queryFn as (ctx: unknown) => unknown)({ queryKey });
    expect(apiMock).toHaveBeenCalledTimes(1);
    return apiMock.mock.calls[0][0];
  }

  it('gives a row with children one closed disclosure, and asks for nothing until it opens', () => {
    const { qc, out } = withRows([
      task({ id: 't1', title: 'Has children', childCount: 3 }),
      task({ id: 't2', title: 'Also has children', childCount: 1 }),
    ]);

    // One control per expandable row, each a real button with a name that says what it does —
    // and `aria-expanded` on it, which is what makes it a disclosure to a reader who cannot see
    // the indent it controls.
    expect(out).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>[^<]*<span>Show subtasks<\/span>/,
    );
    expect(out.match(/aria-expanded="[^"]*"/g)).toEqual([
      'aria-expanded="false"',
      'aria-expanded="false"',
    ]);
    expect(out).not.toContain('Hide subtasks'); // closed is the state it starts in

    // Each control says which row it opens. The visible text is the same three words on every
    // expandable row, so without this a reader tabbing through hears "Show subtasks" twice with
    // nothing to choose between them — and it stays the literal prefix of the name, so the button
    // is still reachable by what is written on it.
    // Matched against the disclosure labels specifically rather than every label on the page:
    // the task section also carries the List | Graph group, which names itself and is not one of
    // these controls.
    expect(out.match(/aria-label="(?:Show|Hide) subtasks[^"]*"/g)).toEqual([
      'aria-label="Show subtasks for Has children"',
      'aria-label="Show subtasks for Also has children"',
    ]);
    // The opened spelling is the same name in the other direction; only the source can show it,
    // since a static render cannot flip the row.
    expect(source).toMatch(
      /aria-label=\{\s*expanded \? `Hide subtasks for \$\{task\.title\}` : `Show subtasks for \$\{task\.title\}`\s*\}/,
    );

    // ...and closed means NOT FETCHED, not merely not shown: the level component is the only
    // thing that registers a child query, and a closed row does not render one at all. Two rows
    // claiming four children between them still leave exactly the queries this page already had.
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ['project', encodeId(P1)],
      tasksKey(P1),
      ...panoramaKeys(P1),
      ...attributionKeys(P1),
    ]);
    expect(qc.getQueryCache().find({ queryKey: childKey(P1, 't1') })).toBeUndefined();
    expect(qc.getQueryCache().find({ queryKey: childKey(P1, 't2') })).toBeUndefined();
  });

  it('gives a leaf row no expand control at all', () => {
    // A control here would promise a level that does not exist, and pressing it would spend a
    // request to learn what the row already says.
    const { out } = withRows([task({ id: 't3', title: 'A leaf', childCount: 0 })]);
    expect(out).toContain('A leaf');
    expect(out).toContain('0 subtasks');
    expect(out).not.toContain('Show subtasks');
    expect(out).not.toContain('aria-expanded');
    expect(out).not.toMatch(/aria-label="(?:Show|Hide) subtasks/);
  });

  it('mounts the opened level indented, and only inside the expanded branch', () => {
    // The indent and the mount both live behind `expanded`, which a static render cannot flip —
    // so this reads the one place both are decided. Rendering the level from anywhere else would
    // make the child page eager, which the cache assertion above would then be blind to.
    expect(source).toMatch(
      /\{expanded \? \(\s*<div style=\{\{ marginLeft: 32, marginTop: 8 \}\}>\s*<ProjectTaskLevel projectId=\{projectId\} parentTaskId=\{task\.id\} \/>/,
    );
  });

  it('requests exactly this parent’s direct children, at the task’s public id', () => {
    // Handed the raw-UUID spelling, as a payload from before the public-id flip would give it.
    const qc = newClient();
    renderLevel(qc, 'p/1', T1);
    const url = urlOf(qc, ['project', 'p/1', 'tasks', 'children', T1]);

    // Exactly one parentId, carrying the short public id the server names a parent by — and a
    // project id escaped into the path, chosen unescapable-looking on purpose because a real
    // base62 id would hide a missing encodeURIComponent.
    expect(url).toBe(`/projects/p%2F1/tasks/page?parentId=${encodeId(T1)}&limit=100`);
    expect(url).not.toContain(T1); // the raw UUID must not reach the wire
    expect(url.match(/parentId=/g)).toHaveLength(1);

    // ...and an id that already arrived as a public id is sent unchanged, not encoded twice.
    const already = newClient();
    renderLevel(already, 'p/1', encodeId(T1));
    expect(urlOf(already, ['project', 'p/1', 'tasks', 'children', encodeId(T1)])).toBe(
      `/projects/p%2F1/tasks/page?parentId=${encodeId(T1)}&limit=100`,
    );
  });

  it('still requests the root level with no parentId at all', () => {
    // The two levels share an endpoint, so the root's own URL is asserted the same way: sending
    // `parentId` here would quietly turn the top of the tree into one task's children.
    const { qc } = withRows([task({ childCount: 2 })]);
    const rootUrl = urlOf(qc, tasksKey(P1));
    expect(rootUrl).toBe(`/projects/${encodeId(P1)}/tasks/page?limit=100`);
    expect(rootUrl).not.toContain('parentId');
  });

  it('keys every level by project and parent, so no two levels can collide', () => {
    const qc = newClient();
    qc.setQueryData(childKey(P1, 't1'), {
      items: [task({ id: 'c1', title: 'Only under t1 of P1' })],
      nextCursor: null,
    });

    // Seeded under one parent, read back only there...
    expect(renderLevel(qc, encodeId(P1), 't1')).toContain('Only under t1 of P1');
    // ...not by a sibling level of the same project (a key missing the parent id)...
    expect(renderLevel(qc, encodeId(P1), 't2')).not.toContain('Only under t1 of P1');
    // ...and not by the same-looking level of another project (a key missing the project id).
    expect(renderLevel(qc, encodeId(P2), 't1')).not.toContain('Only under t1 of P1');
    // Nor does any of them land on the root entry, which is the level with no parent at all.
    expect(qc.getQueryCache().find({ queryKey: tasksKey(P1) })).toBeUndefined();
  });

  it('renders the direct children in full, each expandable one level at a time', () => {
    const longCriteria = 'Every breakpoint matches the comp. '.repeat(10);
    const qc = newClient();
    qc.setQueryData(childKey(P1, 't1'), {
      items: [
        task({ id: 'c1', title: 'First child', status: 'IN_PROGRESS', acceptanceCriteria: longCriteria, childCount: 2 }),
        task({ id: 'c2', title: 'Second child', status: 'DONE', acceptanceCriteria: null, childCount: 1 }),
        task({ id: 'c3', title: 'Third child', status: 'CANCELLED', childCount: 0 }),
      ],
      nextCursor: null,
    });
    const out = renderLevel(qc, encodeId(P1), 't1');

    // The same row as the root list: whole title, status tag, criteria excerpt or fallback, count.
    expect(out).toContain('First child');
    expect(out).toContain('IN_PROGRESS');
    expect(out).toContain(`${longCriteria.slice(0, 180)}…`);
    expect(out).not.toContain(longCriteria);
    expect(out).toContain('Second child');
    expect(out).toContain('No acceptance criteria set');
    expect(out).toContain('Third child');
    expect(out).toContain('2 subtasks');
    expect(out).toContain('1 subtask');
    expect(out).not.toContain('1 subtasks');
    expect(out).toContain('0 subtasks');

    // Recursive, but still one level per press: the two children that have children of their own
    // get their own closed disclosure, the leaf gets none...
    expect(out.match(/aria-expanded="[^"]*"/g)).toEqual([
      'aria-expanded="false"',
      'aria-expanded="false"',
    ]);
    // ...and none of THEIR levels is fetched either, so opening one row never opens a subtree.
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([childKey(P1, 't1')]);
  });

  it('spins inside the row while the child page is still loading', () => {
    // Nothing seeded for this level: react-query reports the pending state on first render, which
    // is a state of its own rather than a row that silently opened onto nothing.
    const out = renderLevel(newClient(), encodeId(P1), 't1');
    expect(out).toContain('ant-spin');
    expect(out).not.toContain('No subtasks');
  });

  it('shows a failed level’s own error and Retry, without taking anything else down', async () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    qc.setQueryData(tasksKey(P1), { items: [task({ id: 't1', childCount: 2 })], nextCursor: null });
    await qc.prefetchQuery({
      queryKey: childKey(P1, 't1'),
      queryFn: () => Promise.reject(new Error('subtasks down')),
    });

    // The level says what went wrong, in place, and offers the one thing that can fix it.
    const level = renderLevel(qc, encodeId(P1), 't1');
    expect(level).toContain('Subtasks could not be loaded');
    expect(level).toContain('subtasks down');
    expect(level).toContain('Retry');

    // And it is its own cache entry, so the page it hangs off is untouched: the project, the root
    // list and the parent row all still render, and the root reports no error of its own.
    const page = renderDetail(qc, encodeId(P1));
    expect(page).toContain('Website Revamp');
    expect(page).toContain('Design the landing page');
    expect(page).toContain('Show subtasks');
    expect(page).not.toContain('Tasks could not be loaded');
    expect(page).not.toContain('Project could not be loaded');
    expect(page).not.toContain('Subtasks could not be loaded');
  });

  it('names the stale count when a child page comes back empty', () => {
    // Only a row claiming children can open a level, so nothing here is not "a leaf" — it is a
    // count the row is still showing after the children went away.
    const qc = newClient();
    qc.setQueryData(childKey(P1, 't1'), { items: [], nextCursor: null });
    const out = renderLevel(qc, encodeId(P1), 't1');
    expect(out).toContain('No subtasks — the count on this row is out of date');
    expect(out).not.toContain('ant-spin');
  });

  it('says more subtasks exist when the child page returns a cursor — without a pager', () => {
    const qc = newClient();
    qc.setQueryData(childKey(P1, 't1'), {
      items: [task({ id: 'c1', title: 'First child' })],
      nextCursor: 'eyJjcmVhdGVkQXQiOiIifQ',
    });
    const out = renderLevel(qc, encodeId(P1), 't1');
    expect(out).toContain('More subtasks exist beyond this first page');
    // This unit reads one page per level and sends no cursor, so it must not offer a control that
    // would — the same promise the root list makes.
    expect(out).not.toMatch(/Load more|Show more|Next page/i);
  });

  it('stays silent about further subtasks when the server returns no cursor', () => {
    const qc = newClient();
    qc.setQueryData(childKey(P1, 't1'), {
      items: [task({ id: 'c1', title: 'First child' })],
      nextCursor: null,
    });
    expect(renderLevel(qc, encodeId(P1), 't1')).not.toContain('More subtasks exist');
  });
});

describe('ProjectDetailPage — creating a top-level task', () => {
  // The three option sources the form reads, at the shared factories' own keys. Seeded rather than
  // stubbed, exactly like every other query on this page.
  const WORKSPACES = [
    { id: 'w-codex', name: 'Builder', runnerId: 'r1', provider: 'codex' },
    { id: 'w-plain', name: 'Drafter', runnerId: 'r1', provider: null },
    { id: 'w-none', name: 'Runnerless', runnerId: null, provider: 'claude' },
  ];
  const PROVIDERS = [
    {
      slug: 'acme',
      label: 'Acme',
      runtime: 'claude',
      models: [{ value: 'acme-1', label: 'Acme One' }],
    },
  ];
  const RUNNERS = [
    {
      id: 'r1',
      modelCatalog: {
        codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
        claude: [{ value: 'claude-opus-5', label: 'Opus 5' }],
      },
    },
  ];

  /** The form on its own, in one state. An antd Modal renders through a portal, which a static
   *  render produces NO markup for at all — so the body mounted directly is the only place the
   *  dialog's fields can be read. */
  function renderForm(
    draft: NewProjectTaskDraft,
    over: { error?: Error | null; pending?: boolean; seed?: (qc: QueryClient) => void } = {},
  ) {
    const qc = newClient();
    qc.setQueryData(['workspaces'], WORKSPACES);
    qc.setQueryData(['providers'], PROVIDERS);
    qc.setQueryData(['runners'], RUNNERS);
    over.seed?.(qc);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <NewProjectTaskForm
          projectId={P1}
          draft={draft}
          onChange={() => {}}
          error={over.error ?? null}
          pending={over.pending ?? false}
        />
      </QueryClientProvider>,
    );
    // The renderer escapes the apostrophe in "Assignee's"; comparing against the text a reader
    // sees keeps that entity out of the assertions below.
    return html.replace(/&#x27;/g, "'");
  }

  /** The one call `createProjectTask` makes, read off the module mock — the same shape the
   *  coordinator POST is asserted with. */
  function postOf(projectId: string, draft: NewProjectTaskDraft) {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    void createProjectTask(projectId, draft);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0];
    return [path, (init ?? {}) as { method?: string; body?: Record<string, unknown> }] as const;
  }

  it('offers New task beside the heading, whatever the list underneath is doing', async () => {
    const listed = newClient();
    listed.setQueryData(['project', encodeId(P1)], detail());
    listed.setQueryData(tasksKey(P1), { items: [task()], nextCursor: null });
    // A real button, named by what is written on it, next to the section it adds to.
    expect(renderDetail(listed, encodeId(P1))).toMatch(
      /<button[^>]*>[^<]*<span>New task<\/span>/,
    );

    // A project with no tasks is exactly where this is most needed...
    const empty = newClient();
    empty.setQueryData(['project', encodeId(P1)], detail({ _count: { tasks: 0 }, tasksByStatus: {} }));
    empty.setQueryData(tasksKey(P1), { items: [], nextCursor: null });
    const emptyOut = renderDetail(empty, encodeId(P1));
    expect(emptyOut).toContain('No top-level tasks yet');
    expect(emptyOut).toContain('New task');

    // ...and a page of tasks that failed to load says nothing about whether another can be added.
    const failed = newClient();
    failed.setQueryData(['project', encodeId(P1)], detail());
    await failed.prefetchQuery({
      queryKey: tasksKey(P1),
      queryFn: () => Promise.reject(new Error('tasks down')),
    });
    const failedOut = renderDetail(failed, encodeId(P1));
    expect(failedOut).toContain('Tasks could not be loaded');
    expect(failedOut).toContain('New task');

    // Only the project itself gates it: with nothing to create a task under, there is no offer.
    expect(renderDetail(newClient(), encodeId(P1))).not.toContain('New task');
  });

  it('posts one top-level task to /tasks, in this project, carrying every choice made', () => {
    const [path, init] = postOf(encodeId(P1), {
      title: 'Ship the pricing page',
      description: 'Copy is signed off; wire it up',
      assigneeId: 'w-codex',
      provider: 'acme',
      model: 'acme-1',
    });

    expect(path).toBe('/tasks');
    expect(init.method).toBe('POST');
    expect(init.body).toEqual({
      projectId: encodeId(P1),
      title: 'Ship the pricing page',
      description: 'Copy is signed off; wire it up',
      assigneeId: 'w-codex',
      provider: 'acme',
      model: 'acme-1',
    });

    // The project is fixed by the page, never picked in the form: whatever else the reader
    // chooses, the task lands under the project whose page they are on.
    expect(init.body!.projectId).toBe(encodeId(P1));
    // ...and it is a ROOT task. A `parentTaskId` here would file it under some row instead, which
    // is a different control on a different unit.
    expect(init.body).not.toHaveProperty('parentTaskId');
    // ...and the draft has no field for one, so no caller can reintroduce it through this path.
    const draftFields = source.match(/export interface NewProjectTaskDraft \{([^}]*)\}/)?.[1] ?? '';
    expect(draftFields).toContain('title: string;');
    expect(draftFields).not.toContain('parentTaskId');
  });

  it('says "inherit" by leaving the field out, never by copying the assignee’s provider', () => {
    // An assignee that HAS a provider, and no pin of its own. The wire body must carry the
    // assignee and nothing about providers: absent is what the server reads as "inherit".
    const body = newProjectTaskBody(encodeId(P1), {
      title: 'Draft the migration plan',
      assigneeId: 'w-codex',
    });
    expect(body).toEqual({ projectId: encodeId(P1), title: 'Draft the migration plan', assigneeId: 'w-codex' });
    // Absent, not null and not '': `'provider' in body` is what tells those three apart, and only
    // the first one inherits — a null would pin "no provider" and an '' would pin an empty slug.
    expect('provider' in body).toBe(false);
    expect('model' in body).toBe(false);

    // Nothing at all chosen reduces to the two fields the page itself decides.
    expect(Object.keys(newProjectTaskBody(encodeId(P1), { title: 'Bare' }))).toEqual([
      'projectId',
      'title',
    ]);
    // The reset state is that same nothing: reopening the dialog after a create cannot leave a
    // previous task's pins behind on the next one.
    expect(EMPTY_NEW_TASK_DRAFT).toEqual({ title: '' });

    // The resolved provider exists in the form, but only to decide which models are OFFERED — it
    // is never written back into the draft, which is the one way a copy could reach the body.
    expect(source).toContain(
      'const effectiveProvider = draft.provider ?? assignee?.provider ?? null;',
    );
    expect(source).not.toMatch(/provider:\s*effectiveProvider/);
    expect(source).not.toMatch(/provider:\s*assignee[?.]/);
  });

  it('trims the title, drops an empty description, and refuses a title of only spaces', () => {
    expect(
      newProjectTaskBody(encodeId(P1), { title: '  Ship the pricing page  ', description: '  ' }),
    ).toEqual({ projectId: encodeId(P1), title: 'Ship the pricing page' });

    // A description that is really there survives, trimmed.
    expect(
      newProjectTaskBody(encodeId(P1), { title: 'x', description: '  wire it up  ' }).description,
    ).toBe('wire it up');

    // Whitespace-only never gets as far as the body: the dialog's own action is disabled, which a
    // static render cannot reach (portal) — so what is asserted is the predicate that decides it.
    // `@MinLength(1)` on the server would happily accept '   ', so the trim is a real check.
    expect(canCreateProjectTask({ title: '   ' })).toBe(false);
    expect(canCreateProjectTask({ title: '' })).toBe(false);
    expect(canCreateProjectTask({ title: 'Ship the pricing page' })).toBe(true);
    // ...and that the dialog is wired to it, which only the source can show.
    expect(source).toContain('const creatable = canCreateProjectTask(draft);');
    expect(source).toContain('okButtonProps={{ disabled: !creatable }}');
  });

  it('keeps OpenCode’s managed-model choice, which is an empty string rather than no choice', () => {
    // '' is a real selection in OpenCode's model space ("Managed by OpenCode"), so it has to reach
    // the wire — dropping it as falsy would silently fall back to inheriting the assignee's model.
    const chosen = newProjectTaskBody(encodeId(P1), { title: 'x', provider: 'opencode', model: '' });
    expect(chosen.model).toBe('');
    expect('model' in chosen).toBe(true);
    // Where nothing was picked at all, the field stays absent.
    expect('model' in newProjectTaskBody(encodeId(P1), { title: 'x', provider: 'opencode' })).toBe(false);
  });

  it('shows Title, Description, Assignee, Provider and Model, holding what it was handed', () => {
    const out = renderForm({
      title: 'Ship the pricing page',
      description: 'Copy is signed off',
      assigneeId: 'w-codex',
    });

    expect(out).toContain('>Title<');
    expect(out).toContain('>Description<');
    expect(out).toContain('>Assignee<');
    expect(out).toContain('>Provider<');
    expect(out).toContain('>Model<');

    // The values are rendered, not merely accepted: a field that dropped what was typed would
    // still show its label.
    expect(out).toContain('value="Ship the pricing page"');
    expect(out).toContain('Copy is signed off');
    // The assignee is shown by NAME, which can only come from the workspaces the form read.
    expect(out).toContain('>Builder<');
  });

  it('lists models from the effective provider and the assignee runner’s own catalogue', () => {
    // No pin: the model space is the ASSIGNEE's provider (codex), read out of that runner's
    // catalogue under the codex key. The picker renders the option's LABEL, so a model id that
    // resolves to its catalogue name is proof the list was built from that catalogue.
    expect(renderForm({ title: 'x', assigneeId: 'w-codex', model: 'gpt-5.6-sol' })).toContain(
      '>GPT-5.6 Sol<',
    );

    // A pin of its own wins over the assignee's: the same assignee with a configured provider
    // pinned reads that provider's own model list instead, never the runtime's.
    const pinned = renderForm({ title: 'x', assigneeId: 'w-codex', provider: 'acme', model: 'acme-1' });
    expect(pinned).toContain('>Acme One<');
    // ...and the provider box names it, which is only possible if configured providers are merged
    // in alongside the built-ins.
    expect(pinned).toContain('>Acme<');
    expect(source).toContain('options={mergedProviderOptions(configuredProviders)}');

    // A built-in pin resolves to its built-in label, from the same merged list.
    expect(renderForm({ title: 'x', provider: 'codex' })).toContain('>Codex<');

    // An id the catalogue does not name — one whose runner retired it while the dialog was open
    // — still renders as itself rather than vanishing out of the box it is sitting in.
    expect(renderForm({ title: 'x', assigneeId: 'w-codex', model: 'claude-opus-5' })).toContain(
      '>claude-opus-5<',
    );
  });

  it('names the provider a task would inherit instead of pre-selecting it', () => {
    // An assignee with a provider: the box stays EMPTY and says what would be inherited. A
    // pre-selected value here would be the copy that turns inheriting into pinning.
    const inherited = renderForm({ title: 'x', assigneeId: 'w-codex' });
    expect(inherited).toContain("Assignee's (codex)");
    expect(inherited).not.toContain('>Codex<');
    // Named as a hint, never announced as what the box holds. A box holding a real choice reports
    // it through `title` — the tooltip a user reads off it — as the Assignee box beside it does
    // with the name it really is holding; a box showing only a placeholder reports nothing. That
    // is the same distinction antd's private placeholder class draws, read off the accessible
    // surface instead, so a renamed internal class cannot quietly turn this green.
    expect(inherited).toContain('title="Builder"');
    expect(inherited).not.toMatch(/title="[^"]*codex[^"]*"/i);

    // An assignee with no provider of its own inherits the server's own claude fallback...
    expect(renderForm({ title: 'x', assigneeId: 'w-plain' })).toContain("Assignee's (claude)");
    // ...and with no assignee there is nothing to name, so it says only whose it will be.
    const unassigned = renderForm({ title: 'x' });
    expect(unassigned).toContain("Assignee's");
    expect(unassigned).not.toContain("Assignee's (");
    // The model box says the same kind of thing for the same reason.
    expect(unassigned).toContain('Provider default');
  });

  it('drops the chosen model whenever the provider OR the assignee changes', () => {
    // A model id only means anything inside one provider's model space, and an unpinned task takes
    // that space from its assignee — so both pickers have to carry the model out with them. The
    // handlers are inline in JSX, which a static render reduces to markup with no way back to the
    // function, so this reads the one place each transition is written.
    expect(source).toContain(
      'onChange={(val) => onChange({ ...draft, provider: val ?? undefined, model: undefined })}',
    );
    // Reassigning is the case that would otherwise submit an id from the PREVIOUS assignee's
    // runner catalogue against the new one's runtime.
    expect(source).toContain(
      'onChange={(val) => onChange({ ...draft, assigneeId: val ?? undefined, model: undefined })}',
    );
    // The model's own handler must NOT clear back the other way: picking a model says nothing
    // about who runs it or on what.
    expect(source).toContain('onChange={(val) => onChange({ ...draft, model: val ?? undefined })}');
    expect(source).not.toMatch(/model: val \?\? undefined, (provider|assigneeId): undefined/);
  });

  it('shows the server’s own message inline, leaving everything that was typed on screen', () => {
    // The real shape of a rejection a reader can act on: it names the field. Summarised into
    // "failed" it would be unactionable, so it arrives whole.
    const message = 'provider must be one of the built-in engines or a provider you have enabled';
    const out = renderForm(
      { title: 'Ship the pricing page', description: 'Copy is signed off', assigneeId: 'w-codex' },
      { error: new Error(message) },
    );
    expect(out).toContain('Task could not be created');
    expect(out).toContain(message);
    // Inline: the draft is still there to correct, which is what makes the dialog's own Create
    // button the retry — so there is no second Retry control repeating it.
    expect(out).toContain('value="Ship the pricing page"');
    expect(out).toContain('Copy is signed off');
    expect(out).toContain('>Builder<');
    expect(out).not.toContain('Retry');
  });

  it('refreshes the level the task landed in, the project’s tallies and the task views', () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    qc.setQueryData(tasksKey(P1), { items: [task()], nextCursor: null });
    qc.setQueryData(['projects'], []);
    qc.setQueryData(['tasks', 'counts', null, []], { open: 1 });
    // Another project's page, open in another tab: it must not be dragged along.
    qc.setQueryData(['project', encodeId(P2)], detail({ id: P2 }));
    qc.setQueryData(tasksKey(P2), { items: [], nextCursor: null });

    invalidateAfterProjectTaskCreate(qc, encodeId(P1));

    const invalidated = (key: unknown[]) =>
      qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;
    // The row the new task appears in...
    expect(invalidated(tasksKey(P1))).toBe(true);
    // ...the document whose total and per-status tallies it moved...
    expect(invalidated(['project', encodeId(P1)])).toBe(true);
    // ...the list row carrying the same count...
    expect(invalidated(['projects'])).toBe(true);
    // ...and the task views elsewhere in the app, which have never heard of this page.
    expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
    // Scoped, though: another project's page is left exactly where it was.
    expect(invalidated(['project', encodeId(P2)])).toBe(false);
    expect(invalidated(tasksKey(P2))).toBe(false);
  });

  it('empties the form and closes the dialog once the task exists', () => {
    // Both live in the mutation's onSuccess, behind a button no static render can press.
    expect(source).toMatch(
      /onSuccess: \(\) => \{\s*setDraft\(EMPTY_NEW_TASK_DRAFT\);\s*onClose\(\);\s*invalidateAfterProjectTaskCreate\(qc, projectId\);/,
    );
    // The project the task is created under is the page's own normalized id, handed down from the
    // route — never re-derived, and never picked in the form.
    expect(source).toContain('<ProjectTasks projectId={id}');
    expect(source).toContain('projectId={projectId}');
  });
});

/**
 * A scheduled start is the one thing on this page whose correct answer depends on WHERE the reader
 * is, so every assertion below runs in a pinned zone rather than the machine's own — otherwise the
 * suite would pass in UTC (where local and UTC agree, and the bug this guards is invisible) and
 * fail everywhere else. Node re-reads `process.env.TZ` on the next Date/Intl call, so setting it
 * around one call is enough; restoring it is what keeps the rest of the file in the host's zone.
 */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

// Two real zones on opposite sides of UTC, one of them on DST at the instant used below, so a
// conversion that merely dropped the offset would land on a different day in at least one of them.
const SHANGHAI = 'Asia/Shanghai'; // UTC+8 year-round
const NEW_YORK = 'America/New_York'; // UTC-4 in September
// Pinned for the DST edges alone. Berlin springs forward 02:00 -> 03:00 on 2026-03-29 (so 02:30
// never happens that day) and falls back on 2026-10-25 (so 02:30 happens twice). Both dates are
// fixed points in the past/future of a fixed tzdata rule, not "today", so nothing here drifts.
const BERLIN = 'Europe/Berlin';

describe('scheduling a new task — the local control and the UTC wire value', () => {
  it('sends no runAt at all when no time was chosen', () => {
    // Absent, not '' and not null: the server's `@IsOptional() @IsDateString()` rejects an empty
    // string outright, and absence is the only spelling that means "unscheduled".
    const bare = newProjectTaskBody('proj1', { title: 'Bare' });
    expect('runAt' in bare).toBe(false);

    // The other two ways "no time" reaches the body: a draft that holds the field but never got a
    // value, and one the reader opened and then cleared — the control hands back '' for that.
    for (const runAtLocal of [undefined, '']) {
      expect('runAt' in newProjectTaskBody('proj1', { title: 'x', runAtLocal })).toBe(false);
    }
    expect(runAtIso(undefined)).toBeUndefined();
    expect(runAtIso('')).toBeUndefined();

    // And the form's reset state carries no schedule, so a scheduled task cannot leave its start
    // behind on the next one created from the reopened dialog.
    expect(EMPTY_NEW_TASK_DRAFT).toEqual({ title: '' });
    expect('runAtLocal' in EMPTY_NEW_TASK_DRAFT).toBe(false);
  });

  it('converts the viewer’s local wall clock to the UTC instant, zone by zone', () => {
    // The SAME wall-clock reading is three different instants in three zones — which is the whole
    // job of this function, and what a naive `local + 'Z'` would get wrong in two of them.
    expect(inTimeZone(SHANGHAI, () => runAtIso('2026-09-01T09:00'))).toBe('2026-09-01T01:00:00.000Z');
    expect(inTimeZone(NEW_YORK, () => runAtIso('2026-09-01T09:00'))).toBe('2026-09-01T13:00:00.000Z');
    expect(inTimeZone('UTC', () => runAtIso('2026-09-01T09:00'))).toBe('2026-09-01T09:00:00.000Z');

    // Across midnight the conversion moves the DATE too, not just the clock: 09:00 in Shanghai on
    // the 1st is still the previous day in UTC.
    expect(inTimeZone(SHANGHAI, () => runAtIso('2026-09-01T07:30'))).toBe('2026-08-31T23:30:00.000Z');

    // Seconds are accepted (some browsers' pickers emit them) and survive.
    expect(inTimeZone('UTC', () => runAtIso('2026-09-01T09:00:30'))).toBe('2026-09-01T09:00:30.000Z');

    // Whatever the zone, what goes on the wire is always canonical UTC ISO-8601 — never a locale
    // rendering like "9/1/2026, 9:00 AM", which the server reads as no date at all.
    for (const tz of [SHANGHAI, NEW_YORK, 'UTC']) {
      expect(inTimeZone(tz, () => runAtIso('2026-09-01T09:00'))).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  it('refuses a date with no time rather than silently shifting it by the viewer’s offset', () => {
    // The trap this guards: `new Date('2026-09-01')` is parsed as UTC while
    // `new Date('2026-09-01T09:00')` is parsed as LOCAL, so letting a date-only value through
    // would schedule a Shanghai reader's task 8 hours off with no error anywhere.
    expect(inTimeZone(SHANGHAI, () => runAtIso('2026-09-01'))).toBeUndefined();
    // Proof the two really do disagree, so the guard above is closing a real gap and not noise.
    expect(inTimeZone(SHANGHAI, () => new Date('2026-09-01').toISOString())).not.toBe(
      inTimeZone(SHANGHAI, () => new Date('2026-09-01T00:00').toISOString()),
    );
  });

  it('turns half-typed and impossible input into no schedule, never an Invalid Date', () => {
    // What a partly-filled or hand-edited control can hand back. None of it may reach the wire,
    // and none of it may throw — the dialog stays usable and simply carries no schedule.
    //
    // Pinned even though every case here is rejected in EVERY zone: the last two rows do reach the
    // Date constructor, and a value's fate must never depend on where the suite happens to run.
    inTimeZone(BERLIN, () => {
      for (const bad of [
        'tomorrow',
        '2026-09-01T09', // hour, no minutes — a picker mid-edit
        '9/1/2026, 9:00 AM', // a locale rendering, the value that must never be sent
        '2026-09-01T09:00Z', // an offset spelling the control never produces
        '2026-13-01T09:00', // no 13th month
        '2026-09-01T25:00', // no 25th hour
      ]) {
        expect(runAtIso(bad)).toBeUndefined();
        // Present but unusable: refused outright rather than dropped, so the reader's choice
        // cannot be spent on its opposite — a task created with no schedule and nothing said.
        expect(() => newProjectTaskBody('proj1', { title: 'x', runAtLocal: bad })).toThrow(
          RUN_AT_IMPOSSIBLE,
        );
      }
    });
  });

  it('refuses a date the calendar does not have, rather than rolling it forward', () => {
    // A calendar is the same everywhere, so none of this depends on the zone — but the whole test
    // is pinned regardless, because the EXPECTED ISO strings below do, and because a helper that
    // is only sometimes wrapped is one edit away from being wrapped nowhere.
    inTimeZone(BERLIN, () => {
      // The Date constructor NORMALIZES rather than refusing, so Feb 31st is a real instant three
      // days later — a schedule nobody picked, arriving with no error at all.
      for (const impossible of ['2026-02-31T12:00', '2026-02-30T09:00', '2026-04-31T10:00']) {
        expect(runAtIso(impossible)).toBeUndefined();
        expect(() => newProjectTaskBody('proj1', { title: 'x', runAtLocal: impossible })).toThrow(
          RUN_AT_IMPOSSIBLE,
        );
      }

      // Proof the rollover is real, so the check above is closing a gap rather than restating the
      // regex: the raw constructor turns Feb 31st into March.
      expect(new Date(2026, 1, 31).getMonth()).toBe(2);

      // The last real day of each of those months still goes through untouched.
      expect(runAtIso('2026-02-28T12:00')).toBe('2026-02-28T11:00:00.000Z');
      expect(runAtIso('2026-04-30T10:00')).toBe('2026-04-30T08:00:00.000Z');
      // ...including a leap day in a year that has one.
      expect(runAtIso('2028-02-29T12:00')).toBe('2028-02-29T11:00:00.000Z');
      // ...and not in a year that does not.
      expect(runAtIso('2026-02-29T12:00')).toBeUndefined();
    });
  });

  it('refuses a wall time that the reader’s own clock skips on a spring-forward day', () => {
    // ONE wrapper around every Berlin assertion, rather than one per call. This test is the only
    // one here whose outcome really does change with the zone — 02:30 on this date is a perfectly
    // ordinary time in UTC — so a single paired call left outside the wrapper would pass on this
    // machine and fail on a UTC CI host. Scoping it structurally is what makes that impossible.
    inTimeZone(BERLIN, () => {
      // Berlin jumps 02:00 -> 03:00 on 2026-03-29, so 02:30 is a time that does not happen. Left
      // to normalize it becomes 03:30 — and lands on the SAME instant as a deliberate 03:30, which
      // is what makes this worse than being merely an hour off: afterwards the two choices are
      // indistinguishable.
      expect(runAtIso('2026-03-29T02:30')).toBeUndefined();
      // ...and the body refuses it rather than carrying no schedule at all: this is the one case
      // a real browser can actually hand over, so a silent downgrade here would be a schedule the
      // reader picked and never got.
      expect(() =>
        newProjectTaskBody('proj1', { title: 'x', runAtLocal: '2026-03-29T02:30' }),
      ).toThrow(RUN_AT_IMPOSSIBLE);

      // Either side of the gap is a real time on that same day and converts normally — 01:30 still
      // on CET (+1), 03:30 already on CEST (+2).
      expect(runAtIso('2026-03-29T01:30')).toBe('2026-03-29T00:30:00.000Z');
      expect(runAtIso('2026-03-29T03:30')).toBe('2026-03-29T01:30:00.000Z');

      // The collision the guard prevents: without it, the skipped time and the real one would have
      // produced one and the same instant.
      expect(new Date(2026, 2, 29, 2, 30).toISOString()).toBe(
        new Date(2026, 2, 29, 3, 30).toISOString(),
      );

      // AMBIGUOUS is not impossible, and must still go through: Berlin falls back on 2026-10-25,
      // so 02:30 happens twice that day. It reads back as 02:30 either way, so it survives as the
      // first of the two — refusing it would reject a time the reader's clock really does show.
      expect(runAtIso('2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z');
    });

    // The same wall time in a zone with no DST at all is untouched by any of this — which is also
    // what proves the rejection above came from Berlin's rules and not from the value itself.
    expect(inTimeZone(SHANGHAI, () => runAtIso('2026-03-29T02:30'))).toBe('2026-03-28T18:30:00.000Z');
  });

  it('never turns a schedule the reader picked into an unscheduled POST', () => {
    // The downgrade this forbids: 02:30 on Berlin's spring-forward day is a time a real browser
    // will hand over, and quietly omitting it would create the task successfully with no schedule
    // — the exact opposite of what was asked for, reported as success.
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    inTimeZone(BERLIN, () => {
      expect(() =>
        createProjectTask(encodeId(P1), { title: 'Run the nightly ingest', runAtLocal: '2026-03-29T02:30' }),
      ).toThrow(RUN_AT_IMPOSSIBLE);
    });
    // Nothing reached the wire at all — in particular, no body with the schedule silently missing.
    expect(apiMock).not.toHaveBeenCalled();

    // The same draft with the start cleared is a different request, and a perfectly good one.
    apiMock.mockClear();
    createProjectTask(encodeId(P1), { title: 'Run the nightly ingest' });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect((apiMock.mock.calls[0][1] as { body: Record<string, unknown> }).body).not.toHaveProperty(
      'runAt',
    );
  });

  it('surfaces the refusal as a failed mutation, which is what the dialog renders', async () => {
    // The throw is synchronous inside the mutationFn; this is what proves react-query turns that
    // into the error state the form's inline Alert already reads, rather than letting it escape.
    //
    // A calendar-impossible value rather than the DST one on purpose: it is refused in EVERY zone,
    // so this test needs no pinning and cannot race the zone restore across its await.
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    const observer = new MutationObserver(newClient(), {
      mutationFn: (d: NewProjectTaskDraft) => createProjectTask(encodeId(P1), d),
      retry: false,
    });

    await observer.mutate({ title: 'x', runAtLocal: '2026-02-31T12:00' }).catch(() => {});

    const result = observer.getCurrentResult();
    expect(result.isError).toBe(true);
    // The same sentence the field itself shows — one message, so the two cannot disagree.
    expect(result.error?.message).toBe(RUN_AT_IMPOSSIBLE);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('refuses a year the constructor would quietly move into the 1900s', () => {
    // `new Date(26, ...)` means 1926, not the year 26 — the constructor's two-digit-year rule. The
    // control cannot produce this, but the round-trip is what makes it impossible rather than
    // merely unlikely.
    expect(inTimeZone(BERLIN, () => runAtIso('0026-09-01T09:00'))).toBeUndefined();
    expect(inTimeZone(BERLIN, () => new Date(26, 8, 1, 9, 0, 0).getFullYear())).toBe(1926);
  });

  it('carries the schedule alongside every other choice, in one POST to /tasks', () => {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    inTimeZone(SHANGHAI, () =>
      createProjectTask(encodeId(P1), {
        title: 'Run the nightly ingest',
        description: 'Kick it off before the EU morning',
        assigneeId: 'w-codex',
        provider: 'acme',
        model: 'acme-1',
        runAtLocal: '2026-09-01T09:00',
      }),
    );

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0] as [string, { method?: string; body?: Record<string, unknown> }];
    expect(path).toBe('/tasks');
    expect(init.method).toBe('POST');
    // The schedule is one more field on the same body — it does not replace or disturb any of the
    // fields that were already there, and it lands as UTC while the control held local.
    expect(init.body).toEqual({
      projectId: encodeId(P1),
      title: 'Run the nightly ingest',
      description: 'Kick it off before the EU morning',
      runAt: '2026-09-01T01:00:00.000Z',
      assigneeId: 'w-codex',
      provider: 'acme',
      model: 'acme-1',
    });
    // Named `runAt`, never `dueDate`: they are different fields on the server and only one of them
    // starts anything.
    expect(init.body).not.toHaveProperty('dueDate');
  });
});

/**
 * The one `<time>` element on a row, read as its parts.
 *
 * By attribute NAME rather than by substring: React's static renderer spells the prop out as
 * `dateTime`, while HTML parses attribute names case-insensitively — so a browser sees `datetime`
 * either way, and pinning one casing into every assertion would break on a renderer change that
 * changes nothing a reader or a machine can observe.
 */
function timeTag(html: string): { instant: string; hover: string; text: string } | null {
  const el = /<time\s+([^>]*)>([^<]*)<\/time>/i.exec(html);
  if (!el) return null;
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(el[1])?.[1] ?? '';
  return { instant: attr('datetime'), hover: attr('title'), text: el[2] };
}

describe('ProjectDetailPage — a task’s scheduled start on its row', () => {
  /** The detail page with one root task, rendered in a pinned zone. */
  function rowIn(tz: string, over: Record<string, unknown>) {
    return inTimeZone(tz, () => {
      const qc = newClient();
      qc.setQueryData(['project', encodeId(P1)], detail());
      qc.setQueryData(tasksKey(P1), { items: [task(over)], nextCursor: null });
      return renderDetail(qc, encodeId(P1));
    });
  }

  it('shows the start in the viewer’s own zone, with the exact instant on the <time>', () => {
    const at = '2026-09-01T01:00:00.000Z';
    const out = rowIn(SHANGHAI, { runAt: at });

    // Rendered as a real <time>, so the precise instant is available to anything not reading the
    // pixels — and in canonical UTC on both halves, which is the unambiguous spelling of the pair.
    const shown = timeTag(out)!;
    expect(shown.instant).toBe(at);
    expect(shown.hover).toBe(at);
    // Labelled for what it is. "Starts", not "Due".
    expect(shown.text).toMatch(/^Starts /);
    expect(out).not.toContain('Due');
    // The visible half is the reader's own wall clock — 01:00Z is 09:00 in Shanghai, so the raw
    // instant must NOT be what is written on the row.
    expect(shown.text).not.toContain(at);
    expect(shown.text).toBe(
      `Starts ${inTimeZone(SHANGHAI, () =>
        new Date(at).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
      )}`,
    );
  });

  it('renders the same instant differently for readers in different zones', () => {
    // The assertion that cannot be satisfied by accident: one stored instant, two zones, and at
    // this one it is not even the same DAY — 01:00Z on the 1st is the previous evening in New
    // York. A row that printed the UTC string, or formatted with a hard-coded zone, would render
    // identically in both and fail here whatever the host machine's own zone is.
    const at = '2026-09-01T01:00:00.000Z';
    const shanghai = rowIn(SHANGHAI, { runAt: at });
    const newYork = rowIn(NEW_YORK, { runAt: at });

    expect(shanghai).not.toBe(newYork);
    // Both still name the identical instant to a machine...
    expect(timeTag(shanghai)!.instant).toBe(at);
    expect(timeTag(newYork)!.instant).toBe(at);
    // ...while what a person reads rolls back to the previous day in New York only.
    expect(timeTag(shanghai)!.text).not.toBe(timeTag(newYork)!.text);
    expect(timeTag(newYork)!.text).toMatch(/31/);
    expect(timeTag(shanghai)!.text).not.toMatch(/31/);
  });

  it('says nothing at all about scheduling on a task that has none', () => {
    // Absent and null alike — most tasks are unscheduled, and a chip on every row would bury the
    // few that are not.
    for (const over of [{}, { runAt: null }]) {
      const out = rowIn(SHANGHAI, over);
      expect(out).not.toContain('Starts');
      expect(out).not.toContain('<time');
      // The row is otherwise unchanged: it still renders everything it always did.
      expect(out).toContain('Design the landing page');
      expect(out).toContain('OPEN');
    }
  });

  it('never reads a due date as a start — they are different fields', () => {
    // A deadline nothing dispatches on. This row has deliberately never shown one, and the
    // scheduled-start chip must not become the place it leaks in.
    const out = rowIn(SHANGHAI, { dueDate: '2026-09-30T00:00:00.000Z', runAt: null });
    expect(out).not.toContain('Starts');
    expect(out).not.toContain('2026-09-30');

    // With BOTH set, only the start is shown, and it is the start's instant on the <time>.
    const both = rowIn(SHANGHAI, {
      dueDate: '2026-09-30T00:00:00.000Z',
      runAt: '2026-09-01T01:00:00.000Z',
    });
    expect(timeTag(both)!.instant).toBe('2026-09-01T01:00:00.000Z');
    expect(both).not.toContain('2026-09-30');
  });

  it('renders no schedule rather than the words "Invalid Date" when the value is unusable', () => {
    // Not reachable through this app's own writes, but a row renders whatever the payload holds,
    // and `new Date('nonsense')` formats to the literal text "Invalid Date" on screen.
    for (const bad of ['not a date', '', '2026-13-01T00:00:00.000Z']) {
      const out = rowIn(SHANGHAI, { runAt: bad });
      expect(out).not.toContain('Invalid Date');
      expect(out).not.toContain('Starts');
      expect(out).toContain('Design the landing page');
    }
  });

  it('normalizes whatever spelling the payload carried into one canonical instant', () => {
    // Same moment, written three ways. The machine-readable half must be one string regardless,
    // so anything comparing or sorting on it sees one spelling.
    expect(scheduledStart('2026-09-01T01:00:00.000Z')!.iso).toBe('2026-09-01T01:00:00.000Z');
    expect(scheduledStart('2026-09-01T01:00:00Z')!.iso).toBe('2026-09-01T01:00:00.000Z');
    expect(scheduledStart('2026-09-01T09:00:00+08:00')!.iso).toBe('2026-09-01T01:00:00.000Z');
    // And an offset spelling still renders in the READER's zone, not the one it was written in.
    expect(timeTag(rowIn(NEW_YORK, { runAt: '2026-09-01T09:00:00+08:00' }))!.instant).toBe(
      '2026-09-01T01:00:00.000Z',
    );

    // Nothing to render is null, not a throw and not a partial object.
    expect(scheduledStart(null)).toBeNull();
    expect(scheduledStart(undefined)).toBeNull();
    expect(scheduledStart('')).toBeNull();
    expect(scheduledStart('nope')).toBeNull();
  });

  it('survives a round trip: what the form sent is what the row reads back', () => {
    // The two halves of this unit meet here. A reader in Shanghai picks 09:00 on the 1st, the wire
    // carries the UTC instant, the server echoes it back on the task page, and the row has to show
    // that same reader the 09:00 they picked — not 01:00.
    const wire = inTimeZone(SHANGHAI, () => runAtIso('2026-09-01T09:00'))!;
    expect(wire).toBe('2026-09-01T01:00:00.000Z');

    const shown = inTimeZone(SHANGHAI, () => scheduledStart(wire)!.local);
    const picked = inTimeZone(SHANGHAI, () =>
      new Date('2026-09-01T09:00').toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(shown).toBe(picked);
    expect(rowIn(SHANGHAI, { runAt: wire })).toContain(`Starts ${shown}`);
  });
});

describe('the New task form’s Start at control', () => {
  /** The form body on its own — an antd Modal renders through a portal, which a static render
   *  produces no markup for, so this is the only place its fields can be read. */
  function renderForm(draft: NewProjectTaskDraft, over: { pending?: boolean } = {}) {
    const qc = newClient();
    qc.setQueryData(['workspaces'], []);
    qc.setQueryData(['providers'], []);
    qc.setQueryData(['runners'], []);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <NewProjectTaskForm
          projectId={P1}
          draft={draft}
          onChange={() => {}}
          error={null}
          pending={over.pending ?? false}
        />
      </QueryClientProvider>,
    );
  }

  it('offers one clearly labelled datetime control, empty until a time is chosen', () => {
    const out = renderForm({ title: 'x' });

    // Named for what it does. "Start at" is a trigger; "Due" would be a deadline, which this page
    // has no control for at all.
    expect(out).toContain('>Start at<');
    expect(out).not.toContain('>Due<');
    expect(out).not.toContain('>Due date<');

    // A real datetime-local input — a plain text box would accept "next tuesday" and a date-only
    // input would drop the time this field exists to collect.
    expect(out).toMatch(/<input[^>]*type="datetime-local"/);
    // Nothing chosen renders as empty, never as a placeholder string that could be submitted.
    expect(out).toMatch(/<input[^>]*type="datetime-local"[^>]*value=""/);
    // ...and it says whose clock it reads and that it fires once, which the control cannot show
    // itself (a datetime-local ignores `placeholder`).
    expect(out).toContain('in your own time zone');
    expect(out).toContain('starts once');
  });

  it('holds the local value it was handed, in the control’s own spelling', () => {
    // The draft keeps the wall-clock string, NOT the UTC instant: handing a `...Z` value back to a
    // datetime-local control blanks it, silently losing what the reader picked.
    const out = renderForm({ title: 'x', runAtLocal: '2026-09-01T09:00' });
    expect(out).toMatch(/<input[^>]*type="datetime-local"[^>]*value="2026-09-01T09:00"/);
    expect(out).not.toContain('value="2026-09-01T01:00:00.000Z"');
  });

  it('goes disabled with the rest of the form while the task is being created', () => {
    // A schedule changed mid-flight would not reach the request that is already gone.
    expect(renderForm({ title: 'x', runAtLocal: '2026-09-01T09:00' }, { pending: true })).toMatch(
      /<input[^>]*type="datetime-local"[^>]*disabled/,
    );
    expect(renderForm({ title: 'x', runAtLocal: '2026-09-01T09:00' })).not.toMatch(
      /<input[^>]*type="datetime-local"[^>]*disabled/,
    );
  });

  it('names the problem on the field itself when the picked time cannot happen', () => {
    // 02:30 on Berlin's spring-forward day: a value the control will genuinely offer, because a
    // datetime-local knows nothing about the reader's daylight-saving rules.
    const out = inTimeZone(BERLIN, () => renderForm({ title: 'x', runAtLocal: '2026-03-29T02:30' }));

    // Said inline, in full, where the reader is looking — not swallowed and not deferred to a
    // task that comes back later with no schedule on it.
    expect(out).toContain(RUN_AT_IMPOSSIBLE);
    // Marked wrong on the control, for eyes and for anything reading the accessibility tree.
    expect(out).toMatch(/<input[^>]*type="datetime-local"[^>]*aria-invalid="true"/);
    expect(out).toContain('ant-input-status-error');
    // What they typed is still there to correct — clearing it for them would lose the choice just
    // as surely as sending nothing would.
    expect(out).toMatch(/<input[^>]*value="2026-03-29T02:30"/);
    // The general hint gives way to the specific problem, rather than stacking two lines.
    expect(out).not.toContain('The task starts once, at that time.');
  });

  it('says nothing of the sort while the field is empty or holds a real time', () => {
    // An empty field is not an error — the whole field is optional, and an unscheduled task is the
    // normal case. This is the assertion that keeps the message off everyone else's screen.
    for (const draft of [
      { title: 'x' },
      { title: 'x', runAtLocal: undefined },
      // Either side of the same gap, and an ambiguous fall-back time, are all real choices.
      { title: 'x', runAtLocal: '2026-03-29T01:30' },
      { title: 'x', runAtLocal: '2026-03-29T03:30' },
      { title: 'x', runAtLocal: '2026-10-25T02:30' },
    ]) {
      const out = inTimeZone(BERLIN, () => renderForm(draft));
      expect(out).not.toContain(RUN_AT_IMPOSSIBLE);
      expect(out).not.toContain('aria-invalid');
      expect(out).not.toContain('ant-input-status-error');
      expect(out).toContain('The task starts once, at that time.');
    }
  });

  it('closes the Create button on an impossible start, and only while it is impossible', () => {
    // The button lives behind the Modal's portal, which a static render produces no markup for, so
    // the predicate that decides it is what gets asserted — the dialog's wiring to it is checked
    // where the rest of the dialog's wiring is.
    inTimeZone(BERLIN, () => {
      expect(canCreateProjectTask({ title: 'x', runAtLocal: '2026-03-29T02:30' })).toBe(false);
      // Fixing the time reopens it...
      expect(canCreateProjectTask({ title: 'x', runAtLocal: '2026-03-29T03:30' })).toBe(true);
      // ...as does clearing it, since no schedule at all was always allowed.
      expect(canCreateProjectTask({ title: 'x' })).toBe(true);
      // A good time cannot rescue a bad title, and vice versa: both gates are real.
      expect(canCreateProjectTask({ title: '  ', runAtLocal: '2026-03-29T03:30' })).toBe(false);
      expect(canCreateProjectTask({ title: '  ', runAtLocal: '2026-03-29T02:30' })).toBe(false);

      // And the predicate agrees with the field, so the button cannot be open on a draft the form
      // is showing an error for — nor closed on one it is not.
      for (const local of ['2026-03-29T02:30', '2026-03-29T03:30', '2026-02-31T12:00', undefined]) {
        expect(canCreateProjectTask({ title: 'x', runAtLocal: local })).toBe(
          runAtProblem(local) === null,
        );
      }
    });
  });

  it('points the control at the line that explains it, hint and error alike', () => {
    // `aria-invalid` says THAT the field is wrong; this is what carries WHY. Asserted as an
    // association rather than against a literal id — the id is generated, and what matters is
    // that the two ends agree, which is the whole of what a screen reader follows.
    const described = (html: string) => /<input[^>]*type="datetime-local"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    const textAt = (html: string, id: string) =>
      new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>([^<]*)<`, 'i').exec(html)?.[1];

    // The optional case: the field is fine, and what gets announced with it is the hint that says
    // whose clock it reads and that it fires once.
    const ok = inTimeZone(BERLIN, () => renderForm({ title: 'x', runAtLocal: '2026-03-29T03:30' }));
    const okId = described(ok)!;
    expect(okId).toBeTruthy();
    expect(textAt(ok, okId)).toContain('Optional, in your own time zone');

    // The broken case: the SAME association now resolves to the reason it is broken, so the
    // announcement is the actual problem rather than a bare "invalid".
    const bad = inTimeZone(BERLIN, () => renderForm({ title: 'x', runAtLocal: '2026-03-29T02:30' }));
    const badId = described(bad)!;
    expect(badId).toBeTruthy();
    expect(textAt(bad, badId)).toBe(RUN_AT_IMPOSSIBLE);

    // Described in both states, not only when it fails — a field that loses its description the
    // moment it becomes valid is one a reader can never hear the instructions for.
    expect(described(inTimeZone(BERLIN, () => renderForm({ title: 'x' })))).toBeTruthy();

    // And the id is the form's own, not a constant: two forms in one document must not collide.
    const two = renderToStaticMarkup(
      <QueryClientProvider client={newClient()}>
        <NewProjectTaskForm projectId={P1} draft={{ title: 'a' }} onChange={() => {}} error={null} pending={false} />
        <NewProjectTaskForm projectId={P1} draft={{ title: 'b' }} onChange={() => {}} error={null} pending={false} />
      </QueryClientProvider>,
    );
    const ids = [...two.matchAll(/type="datetime-local"[^>]*aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves every field that was already there exactly as it was', () => {
    // The schedule is an addition, not a rearrangement: the five controls this form has always had
    // still render, still in order, still holding what they were handed.
    const out = renderForm({ title: 'Ship it', description: 'Copy is signed off' });
    for (const label of ['>Title<', '>Description<', '>Start at<', '>Assignee<', '>Provider<', '>Model<']) {
      expect(out).toContain(label);
    }
    expect(out.indexOf('>Description<')).toBeLessThan(out.indexOf('>Start at<'));
    expect(out.indexOf('>Start at<')).toBeLessThan(out.indexOf('>Assignee<'));
    expect(out).toContain('value="Ship it"');
    expect(out).toContain('Copy is signed off');
  });
});
