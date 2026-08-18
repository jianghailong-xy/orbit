import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  ProjectCoordinatorControl,
  ProjectDetailPage,
  ProjectTaskLevel,
  ProjectsPage,
  coordinatorSessionPath,
  openProjectCoordinator,
} from './ProjectsPage';

// react-query never dispatches a fetch during a static (effect-free) render — confirmed by
// instrumenting it directly, matching TaskListView.test.tsx's own note that these tests must
// seed the cache instead of letting the real request run. So `api` is stubbed both as a backstop
// against an accidental live call and as the place a URL shows up when a test calls a registered
// queryFn by hand (see urlOf); the source-level endpoint check below is what fixes the shape of
// every call, including the ones no test invokes.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

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
  it('reads exactly GET /projects, GET /projects/<id>, the coordinator POST and the two task-page levels — no other endpoint', () => {
    // Negative control: a static render never invokes queryFn (nothing to observe at runtime —
    // see the module comment), so this asserts on the one place the real endpoints are decided.
    // Fails if any call grows extra args or a query string, if a path changes, or if a sixth
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
      // The only WRITE on this page, and the reason it is one: resolve-or-create, so a stale or
      // trashed binding is repaired server-side rather than followed. Method and body are held
      // here as literally as the path, because an empty body is the whole contract of this unit —
      // a `workspaceId` appearing in it would be a workspace picker that no longer exists in the
      // UI, and a method other than POST would be a read of a pointer this page must not trust.
      // What it actually puts on the wire is asserted at runtime further down.
      "`/projects/${encodeURIComponent(projectId)}/coordinator`, { method: 'POST', body: {} }",
      // Exactly this, spelled out: the root level is requested by sending NO parentId, so an
      // added `&parentId=…` here would silently turn this into a subtask page under the same
      // cache key. `limit=100` is inline rather than interpolated so this stays a literal read
      // of the URL that goes on the wire.
      '`/projects/${encodeURIComponent(projectId)}/tasks/page?limit=100`',
      // The level below a row: the same endpoint, plus exactly one `parentId`, carrying the id
      // through encodeId so the server is named a parent the way it names one itself, and escaped
      // like the path segment above. What each of these two fetches is asserted at runtime further
      // down — base62 has nothing to escape, so the escaping itself is held here — and this list
      // is what proves there is no THIRD task-page spelling and no sixth endpoint in the file.
      '`/projects/${encodeURIComponent(projectId)}/tasks/page?parentId=${encodeURIComponent(encodeId(parentTaskId))}&limit=100`',
    ]);
    // ...that `id` is the normalized route id, not the raw param — the detail URL and the cache
    // key have to agree on one spelling...
    expect(source).toContain('const id = routeId(params.id)');
    // ...and that it stays nullable rather than collapsing to '', which would put a request to
    // `/projects/` on the wire the moment the param went missing.
    expect(source).not.toMatch(/routeId\(params\.id\)\s*\?\?/);
    expect(source).toContain('enabled: Boolean(id)');
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
    // open a page for those three — expansion is the next unit, so these two are the only queries
    // this page is allowed to have.
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ['project', encodeId(P1)],
      tasksKey(P1),
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
    expect(out.match(/aria-label="[^"]*"/g)).toEqual([
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
    // claiming four children between them still leave exactly the two queries this page had.
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ['project', encodeId(P1)],
      tasksKey(P1),
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
    expect(out).not.toContain('aria-label');
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

describe('ProjectDetailPage — coordinator', () => {
  /** The section on its own, in one state. A static render cannot press the button, so every state
   *  past the first is only reachable by handing it in. */
  function renderControl(
    props: Partial<Parameters<typeof ProjectCoordinatorControl>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      <ProjectCoordinatorControl
        bound={false}
        pending={false}
        error={null}
        onOpen={() => {}}
        {...props}
      />,
    );
  }

  /** The one call `openProjectCoordinator` makes, read off the module mock. */
  function postOf(projectId: string): [string, { method?: string; body?: unknown }] {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    void openProjectCoordinator(projectId);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0];
    return [path, (init ?? {}) as { method?: string; body?: unknown }];
  }

  it('posts an empty body to exactly this project’s coordinator, id escaped into the path', () => {
    // A project id chosen unescapable-looking on purpose: a real base62 id has nothing to escape,
    // so it would hide a missing encodeURIComponent here just as it would in the task pages.
    const [path, init] = postOf('p/1');
    expect(path).toBe('/projects/p%2F1/coordinator');
    expect(init).toEqual({ method: 'POST', body: {} });

    // Spelled out again, because `toEqual({...})` on an empty body is easy to misread as "any
    // body": POST is what makes this resolve-or-create rather than a read, and the body must carry
    // NO workspaceId — that emptiness is what makes this unit picker-free, and what hands the
    // choice (and the actionable 400) to the server.
    expect(init.method).toBe('POST');
    expect(Object.keys(init.body as Record<string, unknown>)).toEqual([]);

    // ...and an id that already arrived as a public id goes out unchanged, not mangled by the
    // escaping above.
    expect(postOf(encodeId(P1))[0]).toBe(`/projects/${encodeId(P1)}/coordinator`);
  });

  it('turns either spelling of the RETURNED session id into one canonical route', () => {
    // The response is the only place this id comes from, and it can arrive in either spelling.
    expect(coordinatorSessionPath(S1)).toBe(`/sessions/${encodeId(S1)}`);
    expect(coordinatorSessionPath(encodeId(S1))).toBe(`/sessions/${encodeId(S1)}`);
    expect(coordinatorSessionPath(S1)).not.toContain(S1); // the raw UUID must not reach the URL
    // base62 has nothing to escape, so the string above cannot show whether it was escaped at all
    // — the call itself is what keeps a future id alphabet safe. Same reason as the row link.
    expect(source).toContain('`/sessions/${encodeURIComponent(encodeId(sessionId))}`');
  });

  it('offers to OPEN the coordinator a project already names — as a button, not a link', () => {
    const out = renderControl({ bound: true });
    expect(out).toContain('Coordinator');
    expect(out).toContain('A project has exactly one coordinator session');
    expect(out).toContain('Open coordinator');
    expect(out).not.toContain('Start coordinator');
    // Never a deep link: the bound id is an input to the LABEL and nothing else, so that a pointer
    // which has since gone to Trash is repaired by the POST instead of followed into it.
    expect(out).toMatch(/<button[^>]*>[\s\S]*?Open coordinator/);
    expect(out).not.toContain('href');
  });

  it('offers to START one on a project that has never had a coordinator', () => {
    const out = renderControl({ bound: false });
    expect(out).toContain('Start coordinator');
    expect(out).not.toContain('Open coordinator');
    expect(out).not.toContain('href'); // same request from the same control, either way round
  });

  it('disables the action while one is being opened, so a second press cannot open a second', () => {
    const out = renderControl({ bound: true, pending: true });
    expect(out).toMatch(/<button[^>]*\bdisabled\b/);
    expect(out).toContain('ant-btn-loading'); // and says so, rather than going quiet
    expect(out).toContain('Open coordinator'); // still named, so the wait is attached to something
  });

  it('shows the server’s own message inline, with a Retry firing the same request', () => {
    // The server's exact 400 for the one failure a reader can act on. This unit has no picker, so
    // this message IS the fallback — it has to arrive whole rather than summarised into "failed".
    const message =
      'no workspace to open the coordinator in — none of this project’s tasks has an assignee ' +
      'to borrow one from. Assign a task, or pass workspaceId.';
    const out = renderControl({ bound: false, error: new Error(message) });
    expect(out).toContain('Coordinator could not be opened');
    expect(out).toContain(message);
    expect(out).toContain('Retry');
    // The primary action stays on screen beside the error, so the page is not left with Retry as
    // its only control — and the failure stays inline rather than navigating anywhere.
    expect(out).toContain('Start coordinator');

    // Retry is the SAME handler the primary action uses — a static render cannot press either, so
    // the one place both are wired is what says so.
    expect(source).toContain(
      '<Button type="primary" loading={pending} disabled={pending} onClick={onOpen}>',
    );
    expect(source).toMatch(/<Button size="small" danger onClick=\{onOpen\}>\s*Retry/);
  });

  it('navigates with the session the server returned, never the pointer the project carried', () => {
    expect(source).toContain(
      'onSuccess: (result) => navigate(coordinatorSessionPath(result.sessionId))',
    );
    // The bound id decides the label and nothing else. A route built from it would follow exactly
    // the stale pointer the POST exists to repair.
    expect(source).toContain('bound={Boolean(p.coordinatorSessionId)}');
    expect(source).not.toMatch(/coordinatorSessionPath\(\s*p\.coordinatorSessionId/);
    expect(source).not.toMatch(/\/sessions\/\$\{[^}]*coordinatorSessionId/);
    // ...and the request is guarded by the normalized route id, keyed per project so two open in
    // two tabs cannot share one in-flight or failed state.
    expect(source).toContain('return openProjectCoordinator(id);');
    expect(source).toContain("mutationKey: ['project', id, 'coordinator']");
  });

  it('appears only once the project itself has loaded', async () => {
    // Still loading: nothing seeded.
    expect(renderDetail(newClient(), encodeId(P1))).not.toContain('Coordinator');

    // Failed: the page has no project to coordinate, so it must not offer to open one.
    const failed = newClient();
    await failed.prefetchQuery({
      queryKey: ['project', encodeId(P1)],
      queryFn: () => Promise.reject(new Error('network down')),
    });
    expect(renderDetail(failed, encodeId(P1))).not.toContain('Coordinator');

    // No :id in the route at all — nothing was asked for, so there is nothing to open either.
    const missingId = renderToStaticMarkup(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter initialEntries={['/projects']}>
          <Routes>
            <Route path="/projects" element={<ProjectDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(missingId).not.toContain('Coordinator');
  });

  it('sits between the project’s own fields and its tasks, reading the bound pointer for its label', () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail({ coordinatorSessionId: encodeId(S1) }));
    qc.setQueryData(tasksKey(P1), { items: [task()], nextCursor: null });
    const out = renderDetail(qc, encodeId(P1));

    // The section is there, named, and knows this project already has one...
    expect(out).toContain('>Coordinator<');
    expect(out).toContain('Open coordinator');
    // ...ahead of the tasks, and with everything else on the page still around it.
    expect(out.indexOf('>Coordinator<')).toBeLessThan(out.indexOf('>Tasks<'));
    expect(out).toContain('Website Revamp');
    expect(out).toContain('5 tasks');
    expect(out).toContain('Land behind a flag, then flip it');
    expect(out).toContain('Design the landing page');

    // A null pointer is the other label, from the same control and the same request.
    const unbound = newClient();
    unbound.setQueryData(['project', encodeId(P1)], detail({ coordinatorSessionId: null }));
    const out2 = renderDetail(unbound, encodeId(P1));
    expect(out2).toContain('Start coordinator');
    expect(out2).not.toContain('Open coordinator');
  });

  it('keeps a failed coordinator out of the project’s way', () => {
    // The section is a sibling of the fields and of the task list, and the error lives INSIDE the
    // section — so the only thing a failure can take down is the section itself. A static render
    // cannot fail the mutation, so this reads the two places that decide it.
    const control = source.indexOf('<ProjectCoordinatorControl');
    expect(control).toBeGreaterThan(-1);
    expect(control).toBeLessThan(source.indexOf('<ProjectTasks projectId={id} />'));
    // Nothing on the page is rendered conditionally on the coordinator's failure...
    expect(source).not.toMatch(/coordinator\.(isError|error)\s*\?/);
    // ...and the failed section still stands up whole on its own: heading, action and message.
    const out = renderControl({ error: new Error('boom') });
    expect(out).toContain('Coordinator');
    expect(out).toContain('Start coordinator');
    expect(out).toContain('boom');
  });
});
