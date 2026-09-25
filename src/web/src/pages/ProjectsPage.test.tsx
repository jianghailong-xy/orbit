import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { QUIET_MS } from '../lib/projectAttention';
import {
  PANORAMA_BUCKETS,
  type ProjectPanoramaBuckets,
} from '../components/ProjectPanoramaHeader';
import { runAtIso } from '../lib/taskSchedule';
import {
  ProjectDetailPage,
  ProjectTaskLevel,
  PROJECTS_REFRESH_MS,
  ProjectsPage,
  coordinatorSessionPath,
  openProjectCoordinator,
  scheduledStart,
  matchesOpenProjectView,
  matchesProjectSearch,
  noMatchDescription,
  projectFilterFromStatusParam,
  projectOpenViewFromParam,
  projectTaskWorkStateOf,
  projectsEmptyKind,
  projectsPath,
  projectsQueryKey,
  projectsReturnPath,
  projectsRoutePath,
} from './ProjectsPage';

// react-query never dispatches a fetch during a static (effect-free) render — confirmed by
// instrumenting it directly, matching TaskListView.test.tsx's own note that these tests must
// seed the cache instead of letting the real request run. So `api` is stubbed both as a backstop
// against an accidental live call and as the place a URL shows up when a test calls a registered
// queryFn by hand (see urlOf); the source-level endpoint check below is what fixes the shape of
// every call, including the ones no test invokes.
vi.mock('../api', async (importOriginal) => ({
  // `ApiError` REAL, not restated: the page decides whether a refused press gets a Retry by asking
  // `error instanceof ApiError && error.status === 409 && error.code === …`, and a stand-in class
  // here would let that branch pass against a shape the client never throws.
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
  // Named helper rather than an inline `api(...)`, so the source scan below cannot see it — stub
  // it or a Restore press would reach the real fetch.
  restoreSession: vi.fn(() => new Promise(() => {})),
}));
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
/** The shared query factories, read for the one endpoint this page reaches through them. */
const queriesSource = readFileSync(
  fileURLToPath(new URL('../lib/queries.ts', import.meta.url)),
  'utf8',
);
/** An `api(...)` call with its whole argument list. Two levels of nesting so neither
 *  encodeURIComponent(...) nor the encodeId(...) inside it cuts the match short — a call this
 *  cannot parse drops out of the list entirely, which fails the assertion too. */
const API_CALL = /\bapi(?:<[^>]*>)?\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g;

// Real UUIDs, not placeholder strings: the row link runs them through encodeId, which throws on
// anything that is neither spelling — so a fake id here would fail the render, not the assertion.
const P1 = '0195c0de-0000-7000-8000-000000000001';
const P2 = '0195c0de-0000-7000-8000-000000000002';
const P3 = '0195c0de-0000-7000-8000-000000000003';
const P4 = '0195c0de-0000-7000-8000-000000000004';
const P5 = '0195c0de-0000-7000-8000-000000000005';
const P6 = '0195c0de-0000-7000-8000-000000000006';
const P7 = '0195c0de-0000-7000-8000-000000000007';
const P8 = '0195c0de-0000-7000-8000-000000000008';
const P9 = '0195c0de-0000-7000-8000-000000000009';
const P10 = '0195c0de-0000-7000-8000-000000000010';
const P11 = '0195c0de-0000-7000-8000-000000000011';
const P12 = '0195c0de-0000-7000-8000-000000000012';
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

// Every project row's goal line, in row order. The rows are what the assertions below are about,
// and a bare `html.toContain` cannot tell the goal apart from the title, the count or the page's
// own markup — this narrows to the one element the goal is rendered into.
function goalLines(html: string): string[] {
  return [...html.matchAll(/<div class="project-row-goal">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
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

// Unit L7's entry, under the same `['project', id]` prefix as the document and for the same
// reason: what a person is asked to ANSWER about this project. It mounts with the page, so an
// invalidation after a write refreshes it together with the document. The reopen preview stood
// beside it until migration 0229 removed the acceptance epoch it previewed.
const attributionKeys = (projectUuid: string) => [['project', encodeId(projectUuid), 'crossings']];

// Every entry the head, promotion and panorama cards register, in the order they mount:
//
//  1. the four buckets — asked for by the work overview, the first card in the command centre;
//  2. the Coordinator surface's own read, under the SAME `['project', id]` prefix as the document,
//     which is what makes one invalidation after a coordinator write refresh both;
//  3. the blocking ranking;
//  4. the actionable queue of ready and active work.
//
// Four, not six: the acceptance card reads the project document under `['project', id]` — the
// entry the page already holds — and the chain strip deliberately shares the overview's `panorama`
// key, so neither adds a request for the criteria. The judgment-request summary was a fifth until
// 2026-09-02, when the judgment machinery it read was removed. Spelled out rather than imported,
// for the same reason tasksKey is: a key the page changed unilaterally should break these tests.
const headerKeys = (projectUuid: string) => {
  const id = encodeId(projectUuid);
  return [
    // Whether a public link opens this project, read by the header's Share pill beside the status —
    // under the Share dialog's own key, so the dialog opens on it (docs/share-links-design.md §8).
    ['share-links', 'PROJECT', id],
    // Where this project's finished work goes (§1.6), read by the row under the title and again by
    // the task list, which names the branch a landed row landed on. ONE entry for the two of them:
    // two `useQuery` calls on one key share a request and a cache line, which is the whole reason
    // the task list reads it rather than being handed it down through three components.
    ['project', id, 'integration'],
    // The open items, read by the card that draws a coordinator's question to the owner (§5.2).
    // Ahead of the panorama because that is where the card sits: beside the blockers, above the
    // command centre, since both answer "what is standing in this project's way".
    ['project', id, 'open-items'],
    // The candidate waiting to be merged into main, read by the confirmation card that sits in the
    // same place (§3.6). Its card also reads the open items and the document — both under keys the
    // page already holds, so it adds exactly this one entry.
    ['project', id, 'promotion'],
    ['project', id, 'panorama'],
    ['project', id, 'coordinator', 'status'],
    ['project', id, 'panorama', 'blocking', 5],
    ['project', id, 'panorama', 'ready', 5],
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

// What GET /projects reports about every project besides its name: the four buckets and when it
// last moved. Spelled as a helper because the endpoint ALWAYS sends both — a project with no tasks
// reports five zeroes and a null rather than dropping them — so a row fixture without them would
// be testing a payload nobody sends. Named for what it answers: where this project stands.
const standing = (
  buckets: Partial<Record<'running' | 'ready' | 'blocked' | 'awaitingVerification' | 'done' | 'failed' | 'cancelled', number>> = {},
  lastActivityAt: string | null = '2026-01-02T00:00:00Z',
) => ({
  buckets: {
    running: 0,
    ready: 0,
    blocked: 0,
    awaitingVerification: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    ...buckets,
  },
  lastActivityAt,
});

const detail = (over: Record<string, unknown> = {}) => ({
  id: P1,
  title: 'Website Revamp',
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  acceptanceCriteriaItems: [
    { id: 'crit-1', ordinal: 1, text: 'Lighthouse ≥ 90 on every page', revision: 1 },
  ],
  instructions: 'Land behind a flag, then flip it',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 5 },
  tasksByStatus: { OPEN: 2, DONE: 3 },
  ...over,
});

describe('ProjectsPage', () => {
  it('reads exactly GET /projects, GET /projects/<id>, the project DELETE, the status and Automatic PATCHes, the coordinator status GET, its three writes, the two task-page levels and the per-row prerequisite read — no other endpoint', () => {
    // Negative control: a static render never invokes queryFn (nothing to observe at runtime —
    // see the module comment), so this asserts on the one place the real endpoints are decided.
    // Fails if any call grows extra args or a query string, if a path changes, or if a tenth
    // thirteenth api(...) call is added anywhere in the file (see API_CALL for what it can parse).
    const apiCalls = [...source.matchAll(API_CALL)].map(
      // A call wrapped across lines keeps its trailing comma; the URL is what this asserts on.
      (m) => m[1].trim().replace(/,$/, ''),
    );
    expect(apiCalls).toEqual([
      // The list read. The URL itself is built by `projectsPath`, because the status filter is
      // part of it — held there rather than interpolated here so there is ONE place the
      // `?status=` spelling is decided, asserted directly by its own unit tests below. What this
      // line still fixes is that the page reads the projects collection exactly once and passes
      // it nothing but the filter.
      "projectsPath(filter)",
      // The one press on the detail page that destroys something, and the only write in this file
      // with no body at all: the id in the path IS the whole request. Held as literally as the
      // reads, because a method that drifted to POST or a path that grew a segment would be a
      // different verb against the same button — and this endpoint cascades.
      "`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }",
      // The account owner's own write to `project.status`, and the only one this app has: PATCH,
      // with a body carrying nothing but the status being claimed. Held as literally as the rest,
      // because the shape of this body is the unit — a second field smuggled in here would make a
      // status press write something nobody confirmed, and the method drifting to PUT would
      // replace the project document with three characters of it.
      "`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { status } }",
      '`/projects/${encodeURIComponent(id!)}`',
      // The write that opens the conversation with this project's coordinator, and the reason it
      // is one: resolve-or-create, so a stale or trashed binding is repaired server-side rather
      // than followed. Method and body are held here as literally as the path, because the body is
      // the whole contract of this unit: `workspaceId` ONLY when the reader named one — which is
      // the one thing that clears `NO_LANDING_WORKSPACE` — and an empty object otherwise, which is
      // what lets the server borrow the workspace this project's work already runs in.
      "`/projects/${encodeURIComponent(projectId)}/coordinator`, { method: 'POST', body: workspaceId ? { workspaceId } : {} }",
      // The other half of that pair, and a SEPARATE route for the reason the card draws a separate
      // button: the open above resolves, so pressing it on a completed conversation hands that same
      // conversation back. This one replaces it. No body at all — where the replacement opens is
      // the project's to decide, and a `workspaceId` here would be a move wearing a replacement's
      // name (the rebind below is the move).
      "`/projects/${encodeURIComponent(projectId)}/coordinator/replace`, { method: 'POST' }",
      // The project's OTHER owner-only write: its Automatic switch, which is `coordinatorEnabled`
      // and the two fields that field cannot be written without. The same PATCH door as the status
      // write above, and the body is held in `automaticBody` rather than spelled out here — what
      // it carries is asserted at runtime, over the request that leaves the client, in
      // ProjectsPage.automatic.test.tsx.
      "`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: automaticBody(next, configRevision) }",
      // The verb behind every COORDINATOR_UNAVAILABLE. Held as literally as the path above,
      // `workspaceId` included: this endpoint has no `null` spelling, and a body that could send
      // one would be a way to REACH the state it exists to leave.
      "`/projects/${encodeURIComponent(projectId)}/coordinator/rebind`, { method: 'POST', body: { workspaceId } }",
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
    ]);
    // Tasks are created by agents, not from this page: the list above is the whole of what it puts
    // on the wire, so a POST to /tasks reappearing anywhere in the file fails it.
    expect(source).not.toContain("api('/tasks'");
    // ...that `id` is the normalized route id, not the raw param — the detail URL and the cache
    // key have to agree on one spelling...
    expect(source).toContain('const id = routeId(params.id)');
    // ...and that it stays nullable rather than collapsing to '', which would put a request to
    // `/projects/` on the wire the moment the param went missing.
    expect(source).not.toMatch(/routeId\(params\.id\)\s*\?\?/);
    expect(source).toContain('enabled: Boolean(id)');
    // The workspace and runner reads behind the list's New project destination are shared query
    // factories, not re-spelled here.
    expect(source).toContain(
      [
        'import {',
        '  projectCoordinatorStatusQuery,',
        '  projectIntegrationQuery,',
        '  runnersQuery,',
        '  workspacesQuery,',
        "} from '../lib/queries';",
      ].join('\n'),
    );

    // The page's SEVENTH and EIGHTH endpoints — the coordinator card's read, and the integration
    // line's. Their `api(...)` calls live in lib/queries.ts, so the scan above cannot see them and
    // the list would under-report what this page puts on the wire. Each is read out of its own
    // factory (the rest of the module belongs to other pages) and asserted to be exactly one call
    // at exactly one path, so the assertions together are the whole of it.
    const factoryCalls = (name: string) => {
      const factory =
        queriesSource.match(new RegExp(`export const ${name} = \\([\\s\\S]*?\\n  \\}\\);`))?.[0] ?? '';
      expect(factory).not.toBe('');
      return [...factory.matchAll(API_CALL)].map((m) => m[1].trim());
    };
    expect(factoryCalls('projectCoordinatorStatusQuery')).toEqual([
      '`/projects/${encodeURIComponent(projectId)}/coordinator/status`',
    ]);
    // The integration line is its OWN endpoint rather than four more fields on the project
    // document: `project-get-query-count.pg.spec.ts` holds that document to a statement budget,
    // and the row polls. A path that grew a query string here would be a different read.
    expect(factoryCalls('projectIntegrationQuery')).toEqual([
      '`/projects/${encodeURIComponent(projectId)}/integration`',
    ]);

    // ...and one more that no regex can see: a named helper imported from the api client. Held by
    // the import line itself, so a second one added here has to be added here too.
    expect(source).toContain("import { ApiError, api, restoreSession } from '../api';");
  });

  it('renders each project’s title, status, task count and goal/fallback', () => {
    // Well past any sensible row-length cap — what proves the row no longer slices the text.
    const longGoal = 'Ship the new marketing site. '.repeat(10);
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: 'Ship the new marketing site',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 5 },
        ...standing({ running: 1 }),
      },
      {
        // Open, like the other two: this test is about what one actionable row says. Terminal
        // history is reached through its own lifecycle filters rather than repeated below Open.
        id: P2,
        title: 'Legacy Cleanup',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-04T00:00:00Z',
        _count: { tasks: 1 },
        ...standing({ running: 1 }, '2026-01-04T00:00:00Z'),
      },
      {
        id: P3,
        title: 'Ledger Migration',
        status: 'OPEN',
        goal: longGoal,
        createdAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-06T00:00:00Z',
        _count: { tasks: 2 },
        ...standing({ running: 1 }, '2026-01-06T00:00:00Z'),
      },
    ]);
    const html = renderPage(qc);
    expect(html).toContain('Website Revamp');
    expect(html).toContain('OPEN');
    expect(html).toContain('Ship the new marketing site');
    expect(html).toContain('5 tasks');
    expect(html).toContain('Legacy Cleanup');
    expect(html).toContain('No goal set'); // fallback for a null goal
    expect(html).toContain('1 task'); // singular, not "1 tasks"
    expect(html).toContain('Ledger Migration');
    // The whole goal reaches the row, whitespace-collapsed and nothing else: the cut is the box's
    // (white-space:nowrap + text-overflow:ellipsis), which is why there is no character count and
    // no ellipsis character here. A 180-character slice occupies one rendered line of Latin text
    // and three of CJK — the same slice cannot give every row the same height.
    expect(goalLines(html)).toContain(longGoal.trim());
    expect(html).not.toContain('…'); // no hard-sliced excerpt left anywhere on the page
  });

  it('draws where the project stands as one meter, dropping the empty buckets and keeping the tiny one', () => {
    const qc = newClient();
    // The deployment's own worst row: one task running against seventeen thousand blocked. One
    // flex unit in 23,442 is a fraction of a pixel across the 196px this column gets, so the
    // running segment is exactly the one a proportional bar loses — and "nothing is running" is
    // the opposite of what this row would then be saying.
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'FineWeb × Common Crawl',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 23442 },
        ...standing({ running: 1, ready: 0, blocked: 17324, done: 6117 }),
      },
    ]);
    const html = renderPage(qc);
    const meter = html.match(/<div role="img"[\s\S]*?<\/div>/)?.[0] ?? '';

    // Three segments for the three non-zero buckets, in the table's order, each wearing that
    // bucket's token. `ready` is at zero and draws nothing: a hairline of colour for a bucket that
    // is empty is the one value a reader cannot un-see.
    const segments = [...meter.matchAll(/background:var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(segments).toEqual(['brand', 'text-3', 'success']);
    expect(meter).not.toContain('warning-solid');

    // The mark spec: 6px tall, 2px of surface between segments, 4px rounded at the two outer ends
    // only, and a 3px floor under every segment that is drawn — which is what keeps the 1-of-23,442
    // running task on the page at all.
    expect(meter).toContain('height:6px');
    expect(meter).toContain('gap:2px');
    expect(meter.match(/min-width:3px/g)).toHaveLength(3);
    expect(meter).toContain('border-radius:4px 2px 2px 4px');
    expect(meter).toContain('border-radius:2px 4px 4px 2px');

    // The bar has no room for a shape, so its label is where the buckets get named — all four of
    // them, including the one with no segment.
    expect(meter).toContain('aria-label="Task status: 1 running, 0 ready, 17324 waiting, 0 awaiting verification, 6117 done, 0 failed, 0 cancelled"');

    // Beside it, a figure per drawn bucket, each with its own shape: amber --warning-solid and
    // neutral --text-3 are 2.32:1 and 2.94:1 against this background, so nothing here may rest on
    // colour alone. Thousands are grouped — 17,324 and 17324 are not read at the same speed.
    const figures = html.match(/<div class="project-row-buckets"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
    expect([...figures.matchAll(/data-glyph="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      'disc',
      'square',
      'check',
    ]);
    expect([...figures.matchAll(/<b>([\d,]+)<\/b>/g)].map((m) => m[1])).toEqual([
      '1',
      '17,324',
      '6,117',
    ]);
  });

  it('takes the buckets, their order, their shapes and their colours from the panorama’s own table', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 28 },
        ...standing({
          running: 1,
          ready: 2,
          blocked: 3,
          awaitingVerification: 4,
          done: 5,
          failed: 6,
          cancelled: 7,
        }),
      },
    ]);
    const html = renderPage(qc);
    const meter = html.match(/<div role="img"[\s\S]*?<\/div>/)?.[0] ?? '';

    // Derived from the table rather than spelled here: a row that drew its own four colours would
    // pass a hard-coded list and still disagree with the project page it links to. Change the
    // table and this expectation changes with it — which is the only way one source can be proven.
    expect([...meter.matchAll(/background:(var\(--[a-z0-9-]+\))/g)].map((m) => m[1])).toEqual(
      PANORAMA_BUCKETS.map((bucket) => bucket.color),
    );
    const figures = html.match(/<div class="project-row-buckets"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
    expect([...figures.matchAll(/data-glyph="([a-z]+)"/g)].map((m) => m[1])).toEqual(
      PANORAMA_BUCKETS.map((bucket) => bucket.glyph),
    );

    // And it is an IMPORT that makes that true, not a copy that currently agrees.
    expect(source).toMatch(/import \{[\s\S]*?PANORAMA_BUCKETS[\s\S]*?\} from '..\/components\/ProjectPanoramaHeader';/);
    expect(source).toContain('<BucketMeter buckets={buckets} height={6} />');
    // The row's meter decides no colour of its own: every one it draws arrives as `bucket.color`
    // off the table. (The page still names tokens elsewhere — the detail page's task rows have
    // their own status table — so this is scoped to the component under test.)
    const component = source.match(/function ProjectRowMeter\([\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(component).toContain('color={bucket.color}');
    expect(component).not.toContain('var(--');
    // And nowhere on this page, nor in the rules it renders into, is a colour spelled as a hex.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    for (const cls of ['project-row-meter', 'project-row-buckets', 'project-row-when', 'project-row-activity', 'project-row-count']) {
      const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('ends the row with when the project last moved, and the total demoted behind it', () => {
    const qc = newClient();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 23442 },
        ...standing({ running: 1, blocked: 6 }, threeHoursAgo),
      },
      {
        id: P2,
        title: 'Nothing Filed Yet',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-04T00:00:00Z',
        _count: { tasks: 0 },
        // A project with no tasks: the endpoint sends five zeroes and a null rather than dropping
        // the fields, and the row has to read that as "nothing has happened here" — not as a
        // rendering failure, and not as a date nobody performed.
        ...standing({}, null),
      },
    ]);
    const html = renderPage(qc);

    const activity = [...html.matchAll(/<span class="project-row-activity">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(activity).toEqual(['3h ago', 'No activity']);
    // The total survives as scale — 6 blocked out of 23,442 is not 6 out of 12 — but it is no
    // longer the number the row leads with.
    const totals = [...html.matchAll(/<span class="project-row-count">([\s\S]*?)<\/span>/g)].map((m) =>
      m[1].replace(/<!-- -->/g, ''),
    );
    expect(totals).toEqual(['23,442 tasks', '0 tasks']);

    // Which one is the quieter number is the stylesheet's to say, and it says it in tokens.
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    expect(css.match(/\.project-row-activity\s*\{([^}]*)\}/)?.[1]).toContain('color: var(--text-2)');
    expect(css.match(/\.project-row-count\s*\{([^}]*)\}/)?.[1]).toContain('color: var(--text-4)');

    // An empty project still draws a bar — an empty track, the same one the project page draws —
    // rather than an absent element that reads as a broken row.
    expect(html).toContain('var(--fill-muted)');
  });

  it('shows a Markdown goal as the line it reads as, not as source', () => {
    // The shape of goal that actually shipped: a heading, bold, inline code, a path with a line
    // number in it, a bullet and a link — all of it rendered as Markdown on the detail page.
    const goal = [
      '把 Project 详情页改造成全景视图。',
      '',
      '## 现状缺口（2026-08-22 现网实测）',
      '',
      '- 项目页 payload `ProjectTask`（src/web/src/pages/ProjectsPage.tsx:521）**一个依赖字段都没有**',
      '- 详见 [依赖图设计](https://example.com/design)',
    ].join('\n');
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'Panorama',
        status: 'OPEN',
        goal,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 5 },
        ...standing({ running: 1 }),
      },
    ]);
    const [line] = goalLines(renderPage(qc));

    // The marks themselves are gone...
    expect(line).not.toMatch(/[#*`]/);
    expect(line).not.toContain('](');
    expect(line).not.toContain('https://example.com/design');
    // ...and every word they wrapped survived, in order, on one line.
    expect(line).not.toContain('\n');
    expect(line).toContain('现状缺口（2026-08-22 现网实测）');
    expect(line).toContain('ProjectTask');
    expect(line).toContain('一个依赖字段都没有');
    expect(line).toContain('依赖图设计');
    // A path with a line number carries no Markdown at all and has to come back untouched.
    expect(line).toContain('src/web/src/pages/ProjectsPage.tsx:521');
  });

  it('gives every row the same height whatever its goal is', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], [
      { id: P1, goal: 'Short', title: 'A' },
      { id: P2, goal: null, title: 'B' },
      { id: P3, goal: '## H\n\n- '.concat('长'.repeat(400)), title: 'C' },
    ].map((p) => ({
      status: 'OPEN' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      _count: { tasks: 1 },
      ...standing({ running: 1 }),
      ...p,
    })));
    const html = renderPage(qc);

    // Three rows, each a title line and exactly one goal line, in the same two elements. Same
    // markup + same class = same height, whether the goal is five characters or four hundred.
    expect(goalLines(html)).toHaveLength(3);
    expect(html.match(/class="project-row-title"/g)).toHaveLength(3);
    for (const line of goalLines(html)) expect(line).not.toContain('\n');

    // The rows no longer slice the field to a character count — the constant that did it is not
    // read here any more (it still serves the detail page's task rows, which this task left as
    // they were), and what replaced it is the Markdown-to-text helper.
    expect(source).toContain('markdownToPlainText(p.goal)');
    expect(source).not.toMatch(/excerpt\(p\.goal/);

    // The cut is the box's, and these three declarations are the cut. Asserted against the
    // stylesheet because there is no layout in a static render to measure.
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    const rule = css.match(/\.project-row-goal\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('overflow: hidden');
    expect(rule).toContain('text-overflow: ellipsis');
  });

  it('links the whole row to its project at the short public id, never the raw UUID', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], [
      {
        id: P1,
        title: 'Website Revamp',
        status: 'OPEN',
        goal: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        _count: { tasks: 5 },
        ...standing({ running: 1 }),
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

  it('shows an Open-scoped empty state when there are no open projects', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], []);
    const html = renderPage(qc);
    expect(html).toContain('No open projects');
  });

  it('shows an error with a Retry action when the load fails', async () => {
    const qc = newClient();
    // Seed a settled error state for the exact same key the page reads, independent of apiMock.
    await qc.prefetchQuery({ queryKey: ['projects', 'OPEN'], queryFn: () => Promise.reject(new Error('network down')) });
    const html = renderPage(qc);
    expect(html).toContain('Projects could not be loaded');
    expect(html).toContain('network down');
    expect(html).toContain('Retry');
  });
});

describe('ProjectsPage — sections', () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  /** A complete GET /projects row. Unless a test explicitly supplies `_count`, its task count is
   *  derived from the five buckets so the fixture does not accidentally claim FAILED work. */
  const listRow = (
    id: string,
    title: string,
    over: Record<string, unknown> & { buckets?: Partial<Record<string, number>> },
  ) => {
    const buckets = {
      running: 0,
      ready: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
      ...(over.buckets ?? {}),
    };
    return {
      id,
      title,
      status: 'OPEN',
      goal: `The goal of ${title}`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      lastActivityAt: ago(HOUR),
      ...over,
      _count: over._count ?? { tasks: Object.values(buckets).reduce((sum, count) => sum + count, 0) },
      buckets,
    };
  };

  const MIXED = [
    // Healthy work: newest activity wins inside Running.
    listRow(P1, 'Website Revamp', {
      buckets: { running: 1, blocked: 3 },
      lastActivityAt: ago(4 * HOUR),
    }),
    listRow(P2, 'Legacy Cleanup', { status: 'DONE', buckets: { done: 16 } }),
    // One older ready task must outrank a much larger but newer queue.
    listRow(P3, 'Ledger Migration', {
      buckets: { ready: 1, blocked: 1, done: 1 },
      lastActivityAt: ago(10 * HOUR),
    }),
    listRow(P4, 'Abandoned Rewrite', { status: 'CANCELLED', buckets: { done: 7 } }),
    // Every task settled, but the project still needs a close decision.
    listRow(P5, 'Inbox Redesign', { buckets: { done: 12 } }),
    listRow(P6, 'FineWeb Corpus', {
      buckets: { ready: 6118, blocked: 17324 },
      lastActivityAt: ago(2 * HOUR),
    }),
    listRow(P7, 'LFS Build', {
      buckets: { running: 1, blocked: 117 },
      lastActivityAt: ago(HOUR),
    }),
    // Created, never filed against.
    listRow(P8, 'Brand Refresh', { _count: { tasks: 0 }, lastActivityAt: null }),
    // Expected dependency wait is not called an operational failure.
    listRow(P9, 'Waiting on upstream', {
      buckets: { blocked: 4 },
      lastActivityAt: ago(8 * QUIET_MS),
    }),
    // One task is outside the legacy buckets: TaskStatus.FAILED. Without a canonical escalation
    // it remains an automatic continuation in Waiting, never a synthetic Needs you signal.
    listRow(P10, 'Failed release', { _count: { tasks: 3 }, buckets: { done: 2 } }),
    // A run that has emitted no task activity for two days is an exception, not healthy Running.
    listRow(P11, 'Zombie run', {
      buckets: { running: 1 },
      lastActivityAt: ago(2 * QUIET_MS),
    }),
    // A fresh run keeps its execution lane while its durable USER-owned blocker stays visible.
    listRow(P12, 'Needs approval', {
      buckets: { running: 1, blocked: 1 },
      attention: {
        userBlockers: 1,
        coordinatorBlockers: 0,
        systemBlockers: 0,
        maxSeverity: 'WARNING',
        attentionSinceAt: ago(3 * QUIET_MS),
        nextCheckAt: null,
      },
    }),
  ];

  /** The markup of ONE section, sliced off the flat render at the marker each one carries — the
   *  assertions below are about which section a project landed in, which a whole-page `toContain`
   *  cannot tell apart. */
  function sectionOf(html: string, key: string): string {
    const start = html.indexOf(`data-section="${key}"`);
    expect(start).toBeGreaterThan(-1);
    const nextSection = html.indexOf('<section', start);
    return nextSection === -1 ? html.slice(start) : html.slice(start, nextSection);
  }

  function renderMixed(): string {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], MIXED);
    return renderPage(qc);
  }

  it('cuts Open into five next-actor lanes with exceptions first', () => {
    const html = renderMixed();
    expect([...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'attention',
      'running',
      'ready',
      'waiting',
      'definition',
    ]);
  });

  it('separates intervention, healthy work, ready work, expected waits, and drafts', () => {
    const html = renderMixed();
    const attention = sectionOf(html, 'attention');
    const running = sectionOf(html, 'running');
    expect(attention).not.toContain('Needs approval');
    expect(attention).not.toContain('Failed release');
    expect(attention).toContain('Zombie run');
    expect(attention).toContain('Inbox Redesign');
    expect(running).toContain('Needs approval');
    expect(running).toContain('Needs you · Warning · 3d · 1 blocker');
    expect(running).toContain('LFS Build');
    expect(running).toContain('Website Revamp');
    expect(sectionOf(html, 'ready')).toContain('FineWeb Corpus');
    expect(sectionOf(html, 'ready')).toContain('Ledger Migration');
    expect(sectionOf(html, 'waiting')).toContain('Waiting on upstream');
    expect(sectionOf(html, 'waiting')).toContain('Failed release');
    expect(sectionOf(html, 'definition')).toContain('Brand Refresh');
    // Even if a stale/mixed cache entry carries terminal rows, Open never repeats that history
    // below its attention lanes. The dedicated filters are their only list surface.
    expect(html).not.toContain('Legacy Cleanup');
    expect(html).not.toContain('Abandoned Rewrite');
    expect(html).not.toContain('data-section="completed"');
  });

  it('orders Ready by oldest activity, not by raw queue size', () => {
    const ready = sectionOf(renderMixed(), 'ready');
    expect(ready.indexOf('Ledger Migration')).toBeLessThan(ready.indexOf('FineWeb Corpus'));
  });

  it('orders Running by newest activity even when a row carries an attention chip', () => {
    const running = sectionOf(renderMixed(), 'running');
    expect(running).toContain('Needs approval');
    expect(running).toContain('Needs you · Warning · 3d · 1 blocker');
    expect(running.indexOf('LFS Build')).toBeLessThan(running.indexOf('Website Revamp'));
  });

  it('orders Needs attention by issue severity before age', () => {
    const attention = sectionOf(renderMixed(), 'attention');
    expect(attention.indexOf('Zombie run')).toBeLessThan(attention.indexOf('Inbox Redesign'));
  });

  it('counts each section in its own header', () => {
    const html = renderMixed();
    expect(sectionOf(html, 'attention')).toMatch(/Needs attention<\/h3>.*?>2</);
    expect(sectionOf(html, 'running')).toMatch(/Running<\/h3>.*?>3</);
    expect(sectionOf(html, 'ready')).toMatch(/Ready<\/h3>.*?>2</);
    expect(sectionOf(html, 'waiting')).toMatch(/Waiting<\/h3>.*?>2</);
    expect(sectionOf(html, 'definition')).toMatch(/Needs definition<\/h3>.*?>1</);
  });

  it('prints under every header what that section is ordered by', () => {
    const html = renderMixed();
    expect(sectionOf(html, 'attention')).toContain('reason/severity first, then oldest signal');
    expect(sectionOf(html, 'running')).toContain('newest task activity first');
    expect(sectionOf(html, 'ready')).toContain('oldest task activity first');
    expect(sectionOf(html, 'waiting')).toContain('oldest task activity first');
    expect(sectionOf(html, 'definition')).toContain('title A–Z');
  });

  it('does not repeat terminal projects at the bottom of Open', () => {
    const html = renderMixed();

    expect(html).not.toContain('data-section="completed"');
    expect(html).not.toContain(`href="/projects/${encodeURIComponent(encodeId(P2))}"`);
    expect(html).not.toContain('Legacy Cleanup');
    expect(html).not.toContain('Abandoned Rewrite');
    expect(sectionOf(html, 'waiting')).toContain('The goal of Failed release');
  });

  it('leaves out a section with nothing in it', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], MIXED.filter((p) => p.title === 'LFS Build'));
    const html = renderPage(qc);
    expect(html).toContain('data-section="running"');
    expect(html).not.toContain('data-section="attention"');
    expect(html).not.toContain('data-section="completed"');
    // Below the toolbar only: "Completed" is also the name of a filter segment, which is on the
    // page whether or not anything is completed — the word must be gone from the LIST, not from
    // the controls that ask for one.
    expect(html.slice(html.indexOf('<section'))).not.toContain('Completed');
  });

  it('no longer renders the list as one flat run in the server’s order', () => {
    expect(source).toContain('projectAttentionSections(visibleMatches, now)');
    expect(source).not.toMatch(/note: 'Newest first'/);
    expect(source).not.toMatch(/projects: all\.filter\(\(p\) => p\.status/);
  });

  it('refreshes server facts at the same cadence as the local attention clock', () => {
    expect(PROJECTS_REFRESH_MS).toBe(60_000);
    expect(source).toContain('refetchInterval: PROJECTS_REFRESH_MS');
    expect(source).toContain('if (projects.dataUpdatedAt > 0) setNow(Date.now())');
    expect(source).toContain('[projects.dataUpdatedAt]');
  });
});

describe('ProjectsPage — toolbar', () => {
  it('builds one status-scoped request URL for each lifecycle', () => {
    expect(projectsPath('OPEN')).toBe('/projects?status=OPEN');
    expect(projectsPath('DONE')).toBe('/projects?status=DONE');
    expect(projectsPath('CANCELLED')).toBe('/projects?status=CANCELLED');
  });

  it('keys the cache by the filter, under the prefix every write invalidates', () => {
    expect(projectsQueryKey('OPEN')).toEqual(['projects', 'OPEN']);
    expect(projectsQueryKey('DONE')).toEqual(['projects', 'DONE']);
    expect(projectsQueryKey('CANCELLED')).toEqual(['projects', 'CANCELLED']);
    // Same first element for all three: `['projects']` is what task creation invalidates, and a
    // prefix only matches if it is one.
    const statuses = ['OPEN', 'DONE', 'CANCELLED'] as const;
    expect(statuses.map((status) => projectsQueryKey(status)[0])).toEqual(['projects', 'projects', 'projects']);
  });

  it('keeps operational and lifecycle views in refreshable, validated return URLs', () => {
    expect(projectFilterFromStatusParam(null)).toBe('OPEN');
    expect(projectFilterFromStatusParam('OPEN')).toBe('OPEN');
    expect(projectFilterFromStatusParam('DONE')).toBe('DONE');
    expect(projectFilterFromStatusParam('CANCELLED')).toBe('CANCELLED');
    expect(projectFilterFromStatusParam('not-a-status')).toBe('OPEN');
    expect(projectOpenViewFromParam(null)).toBe('ALL');
    expect(projectOpenViewFromParam('ALL')).toBe('ALL');
    expect(projectOpenViewFromParam('RUNNING')).toBe('RUNNING');
    expect(projectOpenViewFromParam('READY')).toBe('READY');
    expect(projectOpenViewFromParam('not-a-view')).toBe('ALL');

    expect(projectsRoutePath('OPEN')).toBe('/projects');
    expect(projectsRoutePath('OPEN', 'RUNNING')).toBe('/projects?view=RUNNING');
    expect(projectsRoutePath('OPEN', 'READY')).toBe('/projects?view=READY');
    expect(projectsRoutePath('DONE')).toBe('/projects?status=DONE');
    expect(projectsRoutePath('CANCELLED')).toBe('/projects?status=CANCELLED');
    expect(projectsReturnPath({ projectsReturnTo: '/projects?view=RUNNING' })).toBe(
      '/projects?view=RUNNING',
    );
    expect(projectsReturnPath({ projectsReturnTo: '/projects?view=READY' })).toBe(
      '/projects?view=READY',
    );
    expect(projectsReturnPath({ projectsReturnTo: '/projects?status=DONE' })).toBe(
      '/projects?status=DONE',
    );
    expect(projectsReturnPath({ projectsReturnTo: '/projects?status=CANCELLED' })).toBe(
      '/projects?status=CANCELLED',
    );
    // Location state is not trusted as an arbitrary internal redirect.
    expect(projectsReturnPath({ projectsReturnTo: '/settings' })).toBe('/projects');
    expect(projectsReturnPath(null)).toBe('/projects');
  });

  it('stays on screen while the list is loading and after it fails', () => {
    // The controls are how a slow or failed read is narrowed and retried; a toolbar that appeared
    // only once rows did would take them away exactly when they are wanted.
    const loading = renderPage(newClient());
    expect(loading).toContain('Search projects');
    expect(loading).toContain('New project');

    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], undefined);
    expect(renderPage(qc)).toContain('Search projects');
  });

  it('separates Open work views from lifecycle history and offers project creation', () => {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], []);
    const html = renderPage(qc);
    expect(html).toContain('Search projects');
    expect(html).toContain('Open projects');
    expect(html).toContain('>All<');
    expect(html).toContain('Running 0');
    expect(html).toContain('Ready 0');
    expect(html).toContain('>History<');
    expect(html).not.toContain('>Completed<');
    expect(html).not.toContain('>Cancelled<');
    // Twice: once in the heading, once as the empty page's own call to action.
    expect(html.split('New project').length - 1).toBe(2);
  });
});

describe('ProjectsPage — Open work views', () => {
  const open = (buckets: Partial<ProjectPanoramaBuckets>) => ({
    status: 'OPEN' as const,
    buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0, ...buckets },
  });

  it('makes Running and Ready mutually exclusive, with Running taking priority', () => {
    const mixed = open({ running: 1, ready: 5 });
    expect(matchesOpenProjectView(mixed, 'ALL')).toBe(true);
    expect(matchesOpenProjectView(mixed, 'RUNNING')).toBe(true);
    expect(matchesOpenProjectView(mixed, 'READY')).toBe(false);

    const ready = open({ ready: 2 });
    expect(matchesOpenProjectView(ready, 'RUNNING')).toBe(false);
    expect(matchesOpenProjectView(ready, 'READY')).toBe(true);
  });

  it('uses execution buckets rather than attention lanes and rejects terminal payloads', () => {
    // Time and blocker ownership do not enter this predicate: quiet work may move to the Needs
    // attention SECTION, but its execution fact must remain reachable from its top filter.
    expect(matchesOpenProjectView(open({ running: 1 }), 'RUNNING')).toBe(true);
    expect(matchesOpenProjectView(open({ ready: 1 }), 'READY')).toBe(true);
    expect(matchesOpenProjectView(open({ blocked: 4 }), 'READY')).toBe(false);
    expect(matchesOpenProjectView({ ...open({ running: 1 }), status: 'DONE' }, 'RUNNING')).toBe(false);
  });
});

describe('ProjectsPage — search matching', () => {
  const project = (over: { title?: string; goal?: string | null }) => ({
    title: 'Website Revamp',
    goal: 'Ship the new marketing site',
    ...over,
  });

  it('matches the goal with its Markdown removed, not its source', () => {
    // What the row shows is `Ship the new marketing site`; what the field HOLDS is the line below.
    // A reader typing what they can see has to find it, which a match over the source cannot do.
    const p = project({ goal: '## Goal\n\n**Ship** the new marketing `site`' });
    expect(matchesProjectSearch(p, 'ship the new marketing site')).toBe(true);
    // The marks themselves are not searchable text — nobody types them, and matching them would
    // make `*` find every project with an emphasis in its goal.
    expect(matchesProjectSearch(p, '**')).toBe(false);
    expect(matchesProjectSearch(p, '## Goal')).toBe(false);
  });

  it('matches the title, ignores case and surrounding space, and lets a blank search through', () => {
    expect(matchesProjectSearch(project({}), 'REVAMP')).toBe(true);
    expect(matchesProjectSearch(project({}), '  revamp  ')).toBe(true);
    expect(matchesProjectSearch(project({}), 'ledger')).toBe(false);
    // An empty box is not a filter — and neither is one holding only spaces.
    expect(matchesProjectSearch(project({}), '')).toBe(true);
    expect(matchesProjectSearch(project({}), '   ')).toBe(true);
  });

  it('survives a project with no goal at all', () => {
    const p = project({ goal: null });
    expect(matchesProjectSearch(p, 'revamp')).toBe(true);
    expect(matchesProjectSearch(p, 'ship')).toBe(false);
  });
});

describe('ProjectsPage — which empty state', () => {
  it('reserves the create-oriented empty state for an unsearched Open view', () => {
    expect(projectsEmptyKind(0, 0, 'OPEN', '')).toBe('none');
    expect(projectsEmptyKind(0, 0, 'DONE', '')).toBe('no-match');
    expect(projectsEmptyKind(0, 0, 'CANCELLED', '')).toBe('no-match');
    expect(projectsEmptyKind(0, 0, 'OPEN', 'zzz')).toBe('no-match');
    expect(projectsEmptyKind(3, 0, 'OPEN', 'zzz')).toBe('no-match');
    // A non-empty Open response can still have no rows in its selected Running/Ready view.
    expect(projectsEmptyKind(3, 0, 'OPEN', '')).toBe('no-match');
    // A search of nothing but spaces narrows nothing, so it cannot be the reason either.
    expect(projectsEmptyKind(0, 0, 'OPEN', '   ')).toBe('none');
  });

  it('is not an empty state at all when something matched', () => {
    expect(projectsEmptyKind(3, 1, 'DONE', 'cleanup')).toBeNull();
    expect(projectsEmptyKind(3, 3, 'OPEN', '')).toBeNull();
  });

  it('names whichever narrowing emptied the list, the search first', () => {
    // Both on: the search is the one that was just typed, so it is the one named.
    expect(noMatchDescription('OPEN', 'ledger')).toBe('No open projects match “ledger”');
    expect(noMatchDescription('DONE', 'ledger')).toBe(
      'No completed projects match “ledger”',
    );
    expect(noMatchDescription('CANCELLED', 'ledger')).toBe(
      'No cancelled projects match “ledger”',
    );
    expect(noMatchDescription('OPEN', 'ledger', 'RUNNING')).toBe(
      'No running projects match “ledger”',
    );
    expect(noMatchDescription('OPEN', 'ledger', 'READY')).toBe(
      'No ready projects match “ledger”',
    );
    expect(noMatchDescription('OPEN', '')).toBe('No open projects');
    expect(noMatchDescription('OPEN', '', 'RUNNING')).toBe('No running projects');
    expect(noMatchDescription('OPEN', '', 'READY')).toBe('No ready projects');
    expect(noMatchDescription('DONE', '  ')).toBe('No completed projects');
    expect(noMatchDescription('CANCELLED', '')).toBe('No cancelled projects');
  });
});

describe('ProjectDetailPage', () => {
  it('renders the title, human status, total tasks and the full long-form fields without duplicate tallies', () => {
    // Longer than the list row's 180-char cap: the detail page is where a goal is read in full,
    // so it must arrive uncut rather than re-truncated here.
    const longGoal = 'Ship the new marketing site. '.repeat(10).trim();
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail({ goal: longGoal }));
    const html = renderDetail(qc, encodeId(P1));
    expect(html).toContain('Website Revamp');
    expect(html).toContain('Open');
    expect(html).toContain('5 tasks');
    expect(html).not.toContain('OPEN 2');
    expect(html).not.toContain('DONE 3');
    expect(html).toContain('Goal');
    expect(html).toContain(longGoal); // in full — no excerpt, no ellipsis
    expect(html).not.toContain('…');
    // The criteria have one home: the Acceptance criteria card, not a second heading of their own
    // and — since migration 0229 removed the legacy text column — not a second representation.
    expect((html.match(/Acceptance criteria/g) ?? []).length).toBe(1);
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

  it('contains long inline Markdown tokens without taking scrolling away from fenced code', () => {
    // This exact shape widened the project document on an iPhone: inline code has no natural
    // break point, and the document's vertical `overflow:auto` consequently grew a horizontal
    // scrollbar for the whole page. The fenced command is intentionally different — it should
    // remain verbatim and scroll inside its own box.
    const path = 'src/macos/OrbitKit/Tests/OrbitKitTests/PerfBaselineTests.swift';
    const command =
      'docker run --rm -e ORBIT_PERF=1 -v "$PWD:/src" -w /src/src/macos/OrbitKit swift:6.1';
    const qc = newClient();
    qc.setQueryData(
      ['project', encodeId(P1)],
      detail({ instructions: `Harness: \`${path}\`\n\n\`\`\`bash\n${command}\n\`\`\`` }),
    );
    const html = renderDetail(qc, encodeId(P1));

    expect(html).toContain(`<code>${path}</code>`);
    expect(html).toContain('<pre>');
    expect(html).toContain('language-bash');
    expect(html).toContain('ORBIT_PERF=1');

    // jsdom has no layout engine, so pin the two halves of the CSS contract directly. The prose
    // can break an otherwise unbreakable token; preformatted code stays whole and owns x-scroll.
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    const markdown = css.match(/\.md\s*\{([^}]*)\}/)?.[1] ?? '';
    const fenced = css.match(/\.md pre\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(markdown).toContain('min-width: 0');
    expect(markdown).toContain('overflow-wrap: anywhere');
    expect(fenced).toContain('max-width: 100%');
    expect(fenced).toContain('overflow-x: auto');
    expect(fenced).toContain('overflow-wrap: normal');
    expect(fenced).toContain('word-break: normal');
  });

  it('falls back for every empty field and for a project with no tasks', () => {
    const qc = newClient();
    qc.setQueryData(
      ['project', encodeId(P2)],
      detail({
        id: P2,
        title: 'Legacy Cleanup',
        goal: null,
        acceptanceCriteriaItems: [],
        instructions: null,
        _count: { tasks: 0 },
        // groupBy returns no rows for a project with no tasks — an empty object, not zeroes.
        tasksByStatus: {},
      }),
    );
    const html = renderDetail(qc, encodeId(P2));
    expect(html).toContain('Legacy Cleanup');
    expect(html).toContain('0 tasks');
    expect(html).toContain('No goal set');
    // Acceptance is no longer one of the free-text fields, so its empty state is the section's
    // own: this fixture states no criteria at all.
    expect(html).toContain('No criteria are stated for this project');
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
      ...headerKeys(P1),
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
    // Distinct from the project-wide total beside the title, which is about every level.
    expect(out).toContain('5 tasks');
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
      ...headerKeys(P1),
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
      /\{expanded \? \(\s*<div className="project-task-children">\s*<ProjectTaskLevel projectId=\{projectId\} parentTaskId=\{task\.id\} branches=\{branches\} \/>/,
    );
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    const childrenRule = css.match(/\.project-task-children\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(childrenRule).toContain('margin-inline-start: 32px');
    expect(childrenRule).toContain('margin-block-start: 8px');
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

  it('survives a round trip: what a picked wall time sends is what the row reads back', () => {
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

describe('ProjectsPage — badges', () => {
  /**
   * The badges are ages, and the page reads the real clock — so the fixtures are written as
   * offsets from `Date.now()` rather than as fixed instants that would age out of the case they
   * were chosen for. QUIET_MS is imported rather than restated: a test carrying its own copy of
   * the threshold cannot fail when the threshold moves, which is the one thing it is here for.
   */
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  const listRow = (
    id: string,
    title: string,
    over: Record<string, unknown> & { buckets?: Partial<Record<string, number>> },
  ) => {
    const buckets = {
      running: 0,
      ready: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
      ...(over.buckets ?? {}),
    };
    return {
      id,
      title,
      status: 'OPEN',
      goal: `The goal of ${title}`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      lastActivityAt: ago(2 * QUIET_MS),
      ...over,
      _count: over._count ?? { tasks: Object.values(buckets).reduce((sum, count) => sum + count, 0) },
      buckets,
    };
  };

  /** Every row of the page, read back out of the markup: which section it is in and what its badge
   *  says. The assertions below are about the rendered row — a rule that is right in
   *  lib/projectAttention and unwired here has to fail. */
  function rowsOf(html: string): Array<{ section: string; title: string; chip: string | null; tone: string | null }> {
    const out = [];
    const marks = [...html.matchAll(/data-section="([^"]+)"/g)];
    for (const [i, m] of marks.entries()) {
      const block = html.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : html.length);
      for (const li of block.matchAll(/<li [^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)) {
        const chip = /class="project-row-chip project-row-chip-(\w+)">([^<]*)</.exec(li[2]);
        out.push({
          section: m[1],
          title: /class="project-row-title">([^<]*)</.exec(li[2])?.[1] ?? '',
          chip: chip?.[2] ?? null,
          tone: chip?.[1] ?? null,
        });
      }
    }
    return out;
  }

  function render(rows: ReturnType<typeof listRow>[]) {
    const qc = newClient();
    qc.setQueryData(['projects', 'OPEN'], rows);
    return rowsOf(renderPage(qc));
  }

  const rowFor = (rows: ReturnType<typeof render>, title: string) => rows.find((r) => r.title === title)!;

  it('moves a quiet ready queue into Needs attention and explains why', () => {
    const rows = render([listRow(P1, 'Ledger Migration', { buckets: { ready: 9, blocked: 1 }, lastActivityAt: ago(4 * QUIET_MS) })]);

    expect(rowFor(rows, 'Ledger Migration')).toMatchObject({
      section: 'attention',
      chip: 'Ready · no activity 4d',
      tone: 'warning',
    });
  });

  it('badges a run that says RUNNING and has written nothing for days', () => {
    // The zombie, and the reason this unit exists: the section header over this row reads "Work in
    // flight" while the project has not been touched since Thursday. Production held two of these
    // and the page said nothing about either.
    const rows = render([listRow(P2, 'Fair Scheduling', { buckets: { running: 1, ready: 1, blocked: 9, done: 5 }, lastActivityAt: ago(2 * QUIET_MS) })]);

    expect(rowFor(rows, 'Fair Scheduling')).toMatchObject({
      section: 'attention',
      chip: 'Running · no activity 2d',
      tone: 'warning',
    });
  });

  it('badges a finished project nobody closed with the count that justifies closing it', () => {
    const rows = render([listRow(P3, 'Inbox Redesign', { _count: { tasks: 12 }, buckets: { done: 12 } })]);

    expect(rowFor(rows, 'Inbox Redesign')).toMatchObject({
      section: 'attention',
      chip: '12/12 settled · still open',
      tone: 'brand',
    });
  });

  it('keeps a recently touched ready queue out of Needs attention', () => {
    // The negative case the threshold is FOR. Same section, same buckets, three hours instead of
    // four days: the section already says nothing is running, and a badge here would say only
    // that the reader should stop reading badges.
    const rows = render([
      listRow(P1, 'Quiet For Days', { buckets: { ready: 9, blocked: 1 }, lastActivityAt: ago(4 * QUIET_MS) }),
      listRow(P4, 'Touched This Morning', { buckets: { ready: 6118, blocked: 17324 }, lastActivityAt: ago(3 * 60 * 60 * 1000) }),
    ]);

    expect(rowFor(rows, 'Touched This Morning').section).toBe('ready');
    expect(rowFor(rows, 'Touched This Morning').chip).toBeNull();
    expect(rowFor(rows, 'Quiet For Days').chip).toBe('Ready · no activity 4d');
  });

  it('leaves a running project that just wrote something unbadged', () => {
    const rows = render([listRow(P5, 'LFS Build', { buckets: { running: 1, blocked: 117 }, lastActivityAt: ago(3 * 60 * 1000) })]);

    expect(rowFor(rows, 'LFS Build').section).toBe('running');
    expect(rowFor(rows, 'LFS Build').chip).toBeNull();
  });

  it('badges nothing else on a page full of rows', () => {
    // Three badges out of eight rows. Healthy, expected-waiting, empty and closed rows stay quiet.
    const rows = render([
      listRow(P1, 'Stalled Quiet', { buckets: { ready: 9, blocked: 1 }, lastActivityAt: ago(2 * QUIET_MS) }),
      listRow(P2, 'Stalled Fresh', { buckets: { ready: 40 }, lastActivityAt: ago(60 * 1000) }),
      listRow(P3, 'Zombie Run', { buckets: { running: 1, blocked: 9 }, lastActivityAt: ago(3 * QUIET_MS) }),
      listRow(P4, 'Healthy Run', { buckets: { running: 2 }, lastActivityAt: ago(90 * 1000) }),
      listRow(P5, 'Needs Closing', { _count: { tasks: 7 }, buckets: { done: 4, cancelled: 3 } }),
      listRow(P6, 'Long Done', { status: 'DONE', buckets: { done: 16 }, lastActivityAt: ago(90 * QUIET_MS) }),
      listRow(P7, 'Abandoned', { status: 'CANCELLED', buckets: { done: 7 }, lastActivityAt: ago(50 * QUIET_MS) }),
      listRow(P8, 'Brand New', { _count: { tasks: 0 }, lastActivityAt: null }),
    ]);

    expect(rows.filter((r) => r.chip).map((r) => [r.title, r.chip])).toEqual([
      ['Zombie Run', 'Running · no activity 3d'],
      ['Stalled Quiet', 'Ready · no activity 2d'],
      ['Needs Closing', '7/7 settled · still open'],
    ]);
  });

  it('spells its colours as theme tokens, never as a hex', () => {
    // Both badge tones are named in index.css off --warning-*/--brand-*, so they follow the
    // palette into dark mode. A hex on either badge would be light-mode-only styling.
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    const rules = /\.project-row-chip\s*\{[^}]*\}[\s\S]*?\.project-row-chip-brand\s*\{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(rules).toContain('var(--warning-bg)');
    expect(rules).toContain('var(--warning-border)');
    expect(rules).toContain('var(--brand-tint)');
    expect(rules).toContain('var(--brand-border)');
    expect(rules).toContain('var(--brand-strong)');
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/project-row-chip[^`]*#[0-9a-f]{3}/i);
  });
});

describe('a task’s lane when the API is too old to send one', () => {
  // The fallback re-derives the lane from the same two columns the server's Ready predicate kills
  // on, so the project page and the task list cannot answer differently about one row. Parked in
  // Awaiting verification, a task that does have work of its own is offered no next step anywhere.
  it('parks only the gate row in Awaiting verification', () => {
    const gateRow = {
      completionCriterion: 'VERIFICATION' as const,
      completionPolicy: 'VERIFICATION_PASSED' as const,
      verifiesTaskId: null,
    };
    expect(projectTaskWorkStateOf(task(gateRow))).toBe('AWAITING_VERIFICATION');
    // The criterion is not what puts a row in that lane: the policy is, whatever criterion the row
    // carries — including none at all, which is what a server that stopped sending it looks like.
    expect(
      projectTaskWorkStateOf(task({ completionPolicy: 'VERIFICATION_PASSED', verifiesTaskId: null })),
    ).toBe('AWAITING_VERIFICATION');
    expect(projectTaskWorkStateOf(task({ ...gateRow, completionCriterion: undefined }))).toBe(
      'AWAITING_VERIFICATION',
    );
    // A task that declares VERIFICATION and does its own work is an ordinary work row.
    expect(
      projectTaskWorkStateOf(
        task({
          completionCriterion: 'VERIFICATION',
          completionPolicy: 'MANUAL',
          verifiesTaskId: null,
        }),
      ),
    ).not.toBe('AWAITING_VERIFICATION');
    // ...and a verifier is work too, not a lane of its own.
    expect(
      projectTaskWorkStateOf(
        task({
          completionCriterion: 'VERIFICATION',
          completionPolicy: 'MANUAL',
          verifiesTaskId: 'subject-1',
        }),
      ),
    ).not.toBe('AWAITING_VERIFICATION');
  });
});

// Contract `docs/project-integration-line-contract.md` §7.2 V3 / V4 / V6, §7.3 V10 and §7.4 V11 —
// mocks 2, 3 and 6. What the four tests below are about, in one sentence each: where this
// project's finished work goes, how much of it is already there, which row is on which side of
// that line, and which criterion is met by work that has not crossed it yet.
describe('ProjectDetailPage — integration', () => {
  /** `GET /projects/:id/integration` (§1.6), as the row and the settings card read it. Spelled
   *  out rather than imported: a payload the page changed unilaterally should break this. */
  const integrationKey = (projectUuid: string) => ['project', encodeId(projectUuid), 'integration'];

  const integration = (over: Record<string, unknown> = {}) => ({
    line: 'PROJECT_BRANCH',
    lineAbsentReason: null,
    ref: 'project/bg-jobs',
    upstreamRef: 'main',
    source: 'DEFAULT_RULE',
    locked: true,
    startedAt: '2026-01-01T00:00:00Z',
    mergeCheckCommand: 'cd src/runner-go && go test -count=1 ./...',
    mergeCheckCommandAbsentReason: null,
    mergeCheckTimeoutSeconds: 3600,
    escalationSeconds: 7200,
    commitsAheadOfUpstream: 7,
    commitsAheadOfUpstreamAbsentReason: null,
    // Twelve minutes back from the suite's own clock, which is how the row's "12m ago" is
    // reproducible without freezing time — the same thing the activity row above does.
    lastUpstreamSyncAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    lastUpstreamSyncAbsentReason: null,
    integratingCount: 1,
    queuedCount: 1,
    mergeCheckOnTip: 'PASSING',
    ...over,
  });

  /** The panorama's buckets with the three integration lanes the done count is split across
   *  (V6). `done` stays the sum of them, which is the invariant the card is drawn from. */
  const panorama = (buckets: Record<string, number> = {}, taskCount = 34, edgeCount = 18) => ({
    buckets: {
      running: 4,
      ready: 0,
      blocked: 2,
      awaitingVerification: 0,
      done: 28,
      failed: 0,
      cancelled: 0,
      integrating: 1,
      onIntegrationLine: 4,
      onUpstream: 23,
      doneNotIntegrated: 0,
      waitingForLanding: 2,
      ...buckets,
    },
    shape: { taskCount, edgeCount, ratio: edgeCount / taskCount, maxDepth: 3, form: 'chain' },
  });

  /** §2.7's per-task view, defaulted to the one state most rows are in. */
  const taskIntegration = (over: Record<string, unknown> = {}) => ({
    state: 'NOT_APPLICABLE',
    since: null,
    handler: null,
    openItemId: null,
    jobId: null,
    checksRunningForMs: null,
    ...over,
  });

  function withIntegration(seed?: (qc: QueryClient) => void, over: Record<string, unknown> = {}) {
    const qc = newClient();
    // Both halves, because they are two different reads: the project document carries the SETTINGS
    // (§1.4's one exception), and the endpoint below carries what the queue is doing. A fixture
    // with only one of them would be testing a page nobody serves.
    qc.setQueryData(['project', encodeId(P1)], detail({
      integration: { line: 'PROJECT_BRANCH', ref: 'project/bg-jobs', upstreamRef: 'main' },
      ...over,
    }));
    qc.setQueryData(integrationKey(P1), integration());
    seed?.(qc);
    return { qc, html: () => renderDetail(qc, encodeId(P1)) };
  }

  /** The rendered text with its markup taken out. The line row emphasises the numbers inside it —
   *  `<b>7</b> commits ahead of main` — and separates its facts with flex gap rather than with
   *  spaces in the markup, so a `toContain` on the raw HTML would be asserting where the tags fall
   *  rather than what the row says. Each element becomes one space, then runs collapse: what is
   *  left is the row as a reader reads it. */
  function text(html: string): string {
    return html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('shows the integration line row', () => {
    const { html } = withIntegration();
    const out = text(html());

    // Where finished work goes, how far ahead of main it is, when main last came in, what is in
    // flight, and whether the branch tip is green — the five facts of §7.2 V3, in that order, as
    // one sentence rather than five independent `toContain`s that a scrambled row would pass.
    expect(out).toContain(
      'project/bg-jobs · 7 commits ahead of main · synced with main 12m ago'
      + ' · Integrating 1 · Queued 1 · Merge check ✓ passing on the branch tip',
    );
    expect(out).toContain('Integration settings');
  });

  it('reads the integration line from its own key, not from the project document', () => {
    // No entry seeded: the row is what the endpoint answers, so a page holding only the project
    // document must still ARM the read rather than inventing a line from the document's copy.
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    renderDetail(qc, encodeId(P1));
    expect(qc.getQueryCache().find({ queryKey: integrationKey(P1) })).toBeDefined();
  });

  it('says main, and nothing about a branch, when the line is main', () => {
    const qc = newClient();
    qc.setQueryData(['project', encodeId(P1)], detail());
    qc.setQueryData(
      integrationKey(P1),
      integration({ line: 'MAIN', ref: 'main', commitsAheadOfUpstream: null,
        commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
        lastUpstreamSyncAbsentReason: 'NEVER_SYNCED' }),
    );
    const out = text(renderDetail(qc, encodeId(P1)));

    expect(out).toContain('main · Integrating 1 · Queued 1 · Merge check ✓ passing');
    expect(out).toContain('Integration settings');
    // A project that lands straight into main is neither ahead of main nor syncing from it, so
    // the two facts that only mean something on a branch are not printed as zeroes.
    expect(out).not.toContain('commits ahead of main');
    expect(out).not.toContain('synced with main');
  });

  it('offers the three integration settings behind the row', () => {
    // §7.2 V4 / mock 6 ③. A native disclosure, so what it holds is in the markup either way and
    // a reader with no pointer can reach it.
    const { html } = withIntegration();
    const out = html();

    expect(out).toContain('Tasks land on');
    expect(out).toContain('A project branch');
    expect(out).toContain('Directly into main');
    expect(out).toContain('Merge check');
    expect(out).toContain('cd src/runner-go &amp;&amp; go test -count=1 ./...');
    expect(out).toContain('Escalate after');
    expect(out).toContain('2 hours');
    // The line is locked, so the choice cannot be re-made — and the card says why rather than
    // presenting a control that would be refused 409 INTEGRATION_LINE_LOCKED (L4).
    expect(out).toContain('started integrating');
  });

  it('splits done into integrating, on project branch and on main', () => {
    const { html } = withIntegration((qc) => qc.setQueryData(['project', encodeId(P1), 'panorama'], panorama()));
    const out = html();

    expect(out).toContain('Integrating');
    expect(out).toContain('checks running on the combined tree');
    expect(out).toContain('On project branch');
    expect(out).toContain('not on main yet');
    expect(out).toContain('On main');
    expect(out).toContain('landed on main');
    // One lane, not two: the old Done cell is what these three replace, so a card showing both
    // would count 28 tasks twice.
    expect(out).not.toContain('% complete');
    // Waiting says what it is waiting FOR once a prerequisite is the thing holding it (V6).
    expect(out).toContain('for a prerequisite to land');
    expect(out).not.toContain('waiting on dependencies');
  });

  it('keeps the plain done lane on a project that is not integrating', () => {
    // An older server, or a project nobody has integrated: the three lanes are absent from the
    // payload and the card is exactly what it was.
    const { html } = withIntegration((qc) =>
      qc.setQueryData(['project', encodeId(P1), 'panorama'], {
        buckets: { running: 1, ready: 0, blocked: 2, awaitingVerification: 0, done: 3, failed: 0, cancelled: 0 },
        shape: { taskCount: 6, edgeCount: 2, ratio: 1 / 3, maxDepth: 1, form: 'chain' },
      }),
    );
    const out = html();

    expect(out).toContain('% complete');
    expect(out).toContain('waiting on dependencies');
    expect(out).not.toContain('On project branch');
  });

  it('groups tasks by integration stage with waiting reasons', () => {
    const { html } = withIntegration((qc) =>
      qc.setQueryData(tasksKey(P1), {
        items: [
          task({
            id: 'i1', title: 'Checks are running on this one', status: 'DONE', workState: 'DONE',
            integration: taskIntegration({ state: 'RUNNING', jobId: 'job-1', checksRunningForMs: 3 * 60_000 }),
          }),
          task({
            id: 'i2', title: 'Checks failed on this one', status: 'DONE', workState: 'DONE',
            integration: taskIntegration({ state: 'CHECK_FAILED', handler: 'COORDINATOR', openItemId: 'oi-1' }),
          }),
          task({
            id: 'w1', title: 'Waits on a prerequisite landing', status: 'OPEN', workState: 'BLOCKED',
            dependencyState: 'BLOCKED', unmetCount: 0, landingWaitCount: 1,
          }),
          task({
            id: 'l1', title: 'Already on the project branch', status: 'DONE', workState: 'DONE',
            integration: taskIntegration({ state: 'ON_INTEGRATION_LINE' }),
          }),
          task({
            id: 'l2', title: 'Already on main', status: 'DONE', workState: 'DONE',
            integration: taskIntegration({ state: 'ON_UPSTREAM' }),
          }),
        ],
        nextCursor: null,
      }),
    );
    const out = html();

    expect(out).toContain('Integrating · checks run on the combined tree');
    expect(out).toContain('Integrating · checks 3m');
    expect(out).toContain('Checks failed · coordinator');
    expect(out).toContain('Waiting · for a prerequisite to land');
    expect(out).toContain('Waits for 1 task to land');
    expect(out).toContain('Landed');
    expect(out).toContain('On project/bg-jobs');
    expect(out).toContain('On main');
    // A task the platform is still working on has not settled, so it is not filed under the
    // heading that says it has.
    expect(out).not.toContain('Done / Cancelled');
  });

  it('counts the tasks a row waits on in the plural the number asks for', () => {
    const { html } = withIntegration((qc) =>
      qc.setQueryData(tasksKey(P1), {
        items: [
          task({ id: 'w2', status: 'OPEN', workState: 'BLOCKED', dependencyState: 'BLOCKED',
            unmetCount: 0, landingWaitCount: 2 }),
        ],
        nextCursor: null,
      }),
    );
    expect(html()).toContain('Waits for 2 tasks to land');
  });

  it('describes criterion landing as project branch or main', () => {
    const { html } = withIntegration(undefined, {
      acceptanceCriteriaItems: [
        { id: 'c-1', ordinal: 1, text: 'Jobs survive a merge', revision: 1, satisfied: true,
          unmet: [], landing: 'ON_INTEGRATION_LINE' },
        { id: 'c-2', ordinal: 2, text: 'Durable events carry the exit code', revision: 1,
          satisfied: true, unmet: [], landing: 'LANDED' },
        { id: 'c-3', ordinal: 3, text: 'Nobody merged anything', revision: 1, satisfied: true,
          unmet: [], landing: 'UNKNOWN' },
      ],
    });
    const out = html();

    // Met, and on the project's own branch — which is NOT on main, said in the same breath so a
    // reader cannot take the green as "shipped" (V11).
    expect(out).toContain('on project/bg-jobs');
    expect(out).toContain('not on main yet');
    expect(out).toContain('on main');
    // The old sentence named a branch this project may not even use.
    expect(out).not.toContain('landed on the default branch');
    // The absence of evidence keeps saying exactly that.
    expect(out).toContain('no merge receipt either way');
  });
});
