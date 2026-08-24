// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { CoordinatorStatus } from '../components/ProjectCoordinatorCard';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * The panorama as one page, rather than as five cards.
 *
 * Every card has its own suite, which is where its states are asserted; what is only observable
 * HERE is the assembly — what order the cards come in, that each one carries its own failure
 * instead of the page's, and that none of them reaches the wire on a project that did not load.
 *
 * This file mounts into a real DOM rather than rendering with `react-dom/server`, the way the rest
 * of the project suites do, for one reason: a static render never invokes a `queryFn`, so "the
 * 404 branch sends no requests" would pass on a page that sent all of them. The requests have to
 * actually be dispatched for their absence to mean anything.
 */
vi.mock('../api', async (importOriginal) => ({
  // Everything but the transport: the page branches on `error instanceof ApiError`, so the class
  // has to be the real one — a stand-in would let that branch pass against a shape the client
  // never throws — and `restoreSession` is a named helper that would otherwise reach real fetch.
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  restoreSession: vi.fn(),
}));
// The graph section reaches its drawing module through a `lazy()` boundary; it is stubbed here for
// the reason ProjectTasksGraph's own suite stubs it — React Flow measures with a ResizeObserver
// jsdom does not have, and what this file is about is which block comes after which.
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const P1 = '0195c0de-0000-7000-8000-000000000001';
/** The spelling the route carries and every URL below is built from — `routeId` normalizes the
 *  param to this, so a fixture keyed any other way would answer a request nobody makes. */
const PROJECT = encodeId(P1);

const DETAIL = {
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
  // Read by the acceptance card off this same document, which is why the card adds no request.
  acceptance: {
    total: 2,
    passed: 1,
    lastRunAt: '2026-08-20T09:00:00.000Z',
    criteria: [
      { key: 'c1', text: 'Every page scores 90 or better', ordinal: 1, verdict: 'PASS' },
      { key: 'c2', text: 'No console errors on load', ordinal: 2, verdict: 'UNDECIDED' },
    ],
  },
};

/** `running: 1` on purpose: a project whose queue is being served is not stalled, so the header
 *  draws no banner and asks for no dispatch health. The stalled path is the header suite's. */
const panorama = (form: 'chain' | 'mesh') => ({
  buckets: { running: 1, ready: 4, blocked: 30, done: 5, cancelled: 0 },
  shape: { taskCount: 39, edgeCount: 41, ratio: 41 / 39, maxDepth: 12, form },
});

const RANKING = {
  remainingCount: 34,
  items: [
    { taskId: 'tk-1', title: 'Backend: blocking-root endpoint', status: 'OPEN', downstreamBlocked: 30 },
    { taskId: 'tk-2', title: 'Backend: panorama buckets', status: 'OPEN', downstreamBlocked: 27 },
  ],
  truncated: null,
};

const ACTIVITY = {
  items: [
    {
      id: 'ac-1',
      at: '2026-08-20T14:22:00.000Z',
      kind: 'DISPATCH_TASK',
      title: 'Dispatched Backend: panorama buckets',
      detail: null,
      outcome: 'APPLIED',
      subjectTaskId: 'tk-2',
    },
  ],
  nextCursor: null,
};

const TASKS = {
  items: [
    {
      id: 'tk-1',
      title: 'Design the landing page',
      status: 'OPEN',
      parentTaskId: null,
      acceptanceCriteria: 'Passes design review',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      dueDate: null,
      assignee: null,
      childCount: 0,
      unmetCount: 0,
      blocksCount: 0,
      topoLevel: 0,
      dependencyState: 'READY',
    },
  ],
  nextCursor: null,
};

/**
 * `GET …/coordinator/status` for a project nobody has ever coordinated.
 *
 * The shape frozen in `docs/project-coordinator-status-contract.md` and mirrored by
 * `CoordinatorStatus`, which is what the card reads — every absent fact carrying its own reason
 * rather than being dropped, so "never opened" is told apart from "this server does not report
 * one". Typed, so a field renamed on the contract fails HERE rather than as a blank card.
 */
const COORDINATOR: CoordinatorStatus = {
  projectId: PROJECT,
  readAt: '2026-08-20T10:00:00.000Z',
  state: 'NEVER_OPENED',
  coordination: {
    sessionId: null,
    sessionIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
    session: null,
    sessionAbsentReason: 'COORDINATOR_NEVER_OPENED',
    coordinatorGeneration: '0',
    workspaceId: null,
    workspaceIdAbsentReason: 'NO_COORDINATION_WORKSPACE',
    workspaceName: null,
    workspaceNameAbsentReason: 'NO_COORDINATION_WORKSPACE',
    agentId: null,
    agentIdAbsentReason: 'NO_COORDINATOR_AGENT',
    agentName: null,
    agentNameAbsentReason: 'NO_COORDINATOR_AGENT',
  },
  openability: {
    canOpen: true,
    willCreate: true,
    refusalCode: null,
    refusalDetail: null,
    refusalCodeAbsentReason: 'NOTHING_REFUSES',
    requiredAction: null,
    requiredActionAbsentReason: 'NOTHING_REFUSES',
    landing: {
      workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
      workspaceIdAbsentReason: null,
      workspaceName: 'orbit-main',
      workspaceNameAbsentReason: null,
      agentId: null,
      agentName: null,
      fixed: false,
    },
  },
};

const base = `/projects/${PROJECT}`;

/**
 * The whole page's wire, one entry per endpoint, keyed by path with the query string cut off.
 *
 * `overrides` is how a single endpoint is broken without disturbing the others — which is the only
 * way to ask whether one card's failure stays that card's. Anything not listed REJECTS rather than
 * resolving to undefined, so a card that starts reading a sixth endpoint shows up as a failure
 * here rather than as a silently empty render.
 */
function serve(overrides: Record<string, () => Promise<unknown>> = {}, form: 'chain' | 'mesh' = 'chain') {
  const routes: Record<string, () => Promise<unknown>> = {
    [base]: () => Promise.resolve(DETAIL),
    [`${base}/panorama`]: () => Promise.resolve(panorama(form)),
    [`${base}/panorama/blocking`]: () => Promise.resolve(RANKING),
    [`${base}/panorama/activity`]: () => Promise.resolve(ACTIVITY),
    [`${base}/tasks/page`]: () => Promise.resolve(TASKS),
    [`${base}/coordinator/status`]: () => Promise.resolve(COORDINATOR),
    ...overrides,
  };
  apiMock.mockImplementation((path: string) => {
    const handler = routes[path.split('?')[0]];
    if (!handler) return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    return handler() as Promise<never>;
  });
}

/** Every panorama URL the mock was actually asked for — the question criterion 4 turns on. */
const panoramaCalls = () =>
  apiMock.mock.calls.map(([path]) => String(path)).filter((path) => path.includes('/panorama'));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  // antd's responsive grid subscribes to breakpoints on mount and jsdom ships no matchMedia. The
  // stub answers "no breakpoint matches", which is the desktop reading and the one this layout is
  // asserted at; the CSS media query that stacks the pair is not this test's subject.
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
  // The activity feed pulls its next page when a sentinel scrolls into view. jsdom has no
  // IntersectionObserver and never scrolls, so this is the inert stand-in that lets the effect run
  // — paging is asserted in the feed's own suite, which can drive it.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    // A failed read has to reach the owning card's error branch on the first answer rather than
    // after three silent retries — the assertions below are about what a reader sees.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // React Query delivers an answered query on a macrotask, so a microtask flush would leave every
  // assertion below looking at a page of spinners. Twice: the cards below the project document
  // only mount once IT has landed, so their own reads are answered a tick later than its.
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function page(urlId: string = PROJECT): ReactElement {
  return (
    <MemoryRouter initialEntries={[`/projects/${urlId}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Where a piece of text sits in the rendered page, as an index into its markup. */
const at = (text: string): number => container.innerHTML.indexOf(text);
const shows = (text: string): boolean => container.innerHTML.includes(text);
/** How many times a piece of text is on the page. `at`/`shows` both answer off the FIRST match, so
 *  a block rendered twice reads identically to one rendered once through them — which is exactly
 *  how a merge that kept both sides' copy of the fields shipped unnoticed. */
const countOf = (text: string): number => container.innerHTML.split(text).length - 1;

// Past the 5s default, because each of these mounts the WHOLE page: six answered reads, three
// Markdown fields, the panorama's meter, the ranking, the acceptance column and now the
// coordinator card, all through `act` on real timers. It takes about a second on an idle machine
// and several on a busy one — and a run that runs out of time here poisons every test after it,
// since the shared root is left mounted. Not a hang budget: a slow-render one.
describe('ProjectDetailPage — the panorama, assembled', { timeout: 20_000 }, () => {
  it('lays the four blocks out in the order the reader asks for them', async () => {
    serve();
    await mount(page());

    // Each block found by what it SAYS, not by a test id: these are the headings a reader steers
    // by, and a rename that leaves them unfindable is the thing worth failing on.
    const coordinator = at('aria-label="Coordinator"');
    const header = at('Work overview');
    const graph = at('>Task graph<');
    const chain = at('aria-label="Chain progress"');
    const goal = at('Ship the new marketing site');
    const tasks = at('>Tasks<');
    const ranking = at('Unblocks the most work');
    const acceptance = at('Acceptance</div>');

    // The stable goal frames every changing reading below it. It is one compact card between the
    // identity and the command centre, not a long-form appendix after the graph.
    expect(goal).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(goal);
    // Work state then establishes context, and the coordinator offers the action on it. Both
    // belong to one command-centre grid and stay ahead of the graph.
    expect(coordinator).toBeGreaterThan(-1);
    expect(coordinator).toBeGreaterThan(header);
    expect(coordinator).toBeLessThan(graph);
    // The picture the counts above are a summary of, then the chain reading of the same shape.
    expect(graph).toBeGreaterThan(header);
    expect(chain).toBeGreaterThan(graph);
    // After the graph's chain reading comes the outcome measure, then the work itself. Acceptance
    // leads the task list rather than trailing it:
    // "did this meet its bar" is the question the counts below cannot answer.
    expect(acceptance).toBeGreaterThan(chain);
    expect(tasks).toBeGreaterThan(acceptance);
    // The cards a reader consults less often than either, in their own order after both.
    expect(ranking).toBeGreaterThan(tasks);

    // The ranking is full width now rather than the wide half of a pair — it carries a horizontal
    // bar per row and was the half that needed the width, and the pair went with acceptance.
    expect(container.querySelector('.project-panorama-pair')).toBeNull();
  });

  it('keeps a card that fails to that card, and the rest of the page standing', async () => {
    serve({ [`${base}/panorama/blocking`]: () => Promise.reject(new Error('Internal Server Error')) });
    await mount(page());

    // The ranking says so itself, where the ranking would have been...
    expect(shows('The blocking ranking could not be read')).toBe(true);
    expect(shows('Internal Server Error')).toBe(true);

    // ...and nothing else on the page notices. The page's own title first, then all four of the
    // other blocks: this is the whole point of the cards being siblings rather than nested.
    expect(shows('Website Revamp')).toBe(true);
    expect(shows('Work overview')).toBe(true);
    expect(shows('Acceptance')).toBe(true);
    expect(shows('Design the landing page')).toBe(true);
    expect(shows('aria-label="Chain progress"')).toBe(true);

    // One failure, not a page of them: the other cards are not showing error states of their own.
    expect(shows('Project panorama could not be loaded')).toBe(false);
    expect(shows('Tasks could not be loaded')).toBe(false);
    expect(shows('Project could not be loaded')).toBe(false);
  });

  it('keeps the page standing in a stalled dispatch state', async () => {
    const stalled = panorama('chain');
    serve({
      [`${base}/panorama`]: () =>
        Promise.resolve({
          ...stalled,
          buckets: { ...stalled.buckets, running: 0 },
        }),
    });
    await mount(page());

    expect(shows('Website Revamp')).toBe(true);
    expect(shows('Work overview')).toBe(true);
    expect(shows('Dispatch needs attention')).toBe(true);
    expect(shows('Unblocks the most work')).toBe(true);
    expect(shows('Acceptance')).toBe(true);
    expect(shows('Design the landing page')).toBe(true);
  });

  it('draws the chain strip on a chain and nothing at all on a mesh', async () => {
    serve({}, 'chain');
    await mount(page());
    expect(shows('aria-label="Chain progress"')).toBe(true);
    // The strip is a position, so it has to say which one.
    expect(shows('Step 6 / 39')).toBe(true);

    await act(async () => root.unmount());
    container.remove();

    apiMock.mockReset();
    serve({}, 'mesh');
    await mount(page());
    expect(shows('aria-label="Chain progress"')).toBe(false);
    expect(shows('Step 6 / 39')).toBe(false);
    // Same page otherwise — a mesh loses the strip, not the panorama.
    expect(shows('Work overview')).toBe(true);
  });

  it('sends no panorama request at all for a project that did not load', async () => {
    serve({ [base]: () => Promise.reject(new Error('Project not found')) });
    await mount(page());

    // The page says what happened...
    expect(shows('Project could not be loaded')).toBe(true);
    expect(shows('Project not found')).toBe(true);

    // ...and asked for nothing else. Every card lives inside the loaded branch, so a 404 costs one
    // request rather than a row of doomed ones.
    expect(panoramaCalls()).toEqual([]);
    expect(apiMock.mock.calls.map(([path]) => String(path))).toEqual([base]);

    // Nothing painted a shell of itself either.
    expect(shows('Work overview')).toBe(false);
    expect(shows('Unblocks the most work')).toBe(false);
    expect(shows('What the coordinator has been doing')).toBe(false);
  });

  it('carries the project’s authored fields once, at their respective reading depths', async () => {
    serve();
    await mount(page());

    // The two remaining free-text fields, in full and under their own labels. Goal frames the page;
    // instructions remain beside the work they govern.
    expect(shows('Goal')).toBe(true);
    expect(shows('Ship the new marketing site')).toBe(true);
    expect(shows('Instructions')).toBe(true);
    expect(shows('Land behind a flag, then flip it')).toBe(true);

    // Acceptance is not a third one any more. It used to be BOTH a field of authored text and a
    // card of the same sentences with verdicts against them — the server makes one criterion out
    // of every non-blank line of that field, so the two were always the same list, and only the
    // lower one said what a run had concluded. What is left is the standing.
    expect(shows('Acceptance criteria')).toBe(false);
    expect(shows('Every page scores 90 or better')).toBe(true);
    expect(shows('No console errors on load')).toBe(true);
    // This fixture's authored text differs from its parsed criteria on purpose: it is how a
    // second copy of the list would be caught if one ever came back.
    expect(shows('Lighthouse ≥ 90 on every page')).toBe(false);

    // Goal is read before the changing work account and the Coordinator action, while the task
    // list still follows the outcome measure.
    expect(at('Ship the new marketing site')).toBeLessThan(at('Work overview'));
    expect(at('Ship the new marketing site')).toBeLessThan(at('>Tasks<'));
    expect(at('>Goal</h5>')).toBeLessThan(at('aria-label="Coordinator"'));
    expect(at('Ship the new marketing site')).toBeLessThan(at('aria-label="Coordinator"'));

    // Once each — the assembly places these, it does not repeat them. Ordering assertions read the
    // first match and stay green on a page that draws the whole block a second time lower down.
    expect(countOf('>Goal</h5>')).toBe(1);
    expect(countOf('Ship the new marketing site')).toBe(1);
    expect(countOf('>Acceptance</div>')).toBe(1);
    expect(countOf('Every page scores 90 or better')).toBe(1);
    expect(countOf('>Instructions</h5>')).toBe(1);
    expect(countOf('Land behind a flag, then flip it')).toBe(1);
    // The chain strip sat inside the same duplicated run and drew twice with them.
    expect(countOf('aria-label="Chain progress"')).toBe(1);
  });

  it('previews a long goal compactly and expands the same Markdown in place', async () => {
    const longGoal = [
      '## Outcome',
      '',
      'Eliminate memory growth, blank cold launches, background drain and write amplification.',
      '',
      '- Keep long sessions responsive',
      '- Keep large accounts on par with macOS',
    ].join('\n');
    serve({ [base]: () => Promise.resolve({ ...DETAIL, goal: longGoal }) });
    await mount(page());

    const card = container.querySelector<HTMLElement>('.project-goal-card');
    const content = card?.querySelector<HTMLElement>('.project-goal-content');
    const toggle = card?.querySelector<HTMLButtonElement>('.project-goal-toggle');

    expect(card).not.toBeNull();
    expect(content?.classList.contains('is-collapsed')).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toContain('Show details');
    // It remains real Markdown rather than a second plain-text excerpt.
    expect(card?.querySelector('h2')?.textContent).toBe('Outcome');
    expect(card?.querySelectorAll('li')).toHaveLength(2);

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(content?.classList.contains('is-collapsed')).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.textContent).toContain('Hide details');
    expect(countOf('Eliminate memory growth')).toBe(1);
  });

  it('keeps live and persisted task state in one overview instead of repeating header tags', async () => {
    serve();
    await mount(page());

    // Dispatch never writes IN_PROGRESS, so the panorama's live-session join is the only honest
    // reading of moving work. It appears once in the overview; OPEN/DONE header tags no longer
    // repeat a second, less useful account above it.
    expect(shows('Running 1')).toBe(true);
    expect(shows('OPEN 2')).toBe(false);
    expect(shows('DONE 3')).toBe(false);
    expect(at('Running 1')).toBeGreaterThan(at('Work overview'));
    expect(countOf('>Running</div>')).toBe(1);
    // One overview reader, one request.
    expect(panoramaCalls().filter((path) => path === `${base}/panorama`)).toHaveLength(1);
  });

  it('keeps a coordinator that cannot be READ to the coordinator', async () => {
    serve({ [`${base}/coordinator/status`]: () => Promise.reject(new Error('Internal Server Error')) });
    await mount(page());

    // A read that failed is the one thing on this surface Retry is the right answer to...
    expect(shows('Coordinator could not be read')).toBe(true);
    expect(shows('Retry')).toBe(true);
    // ...and it costs the reader the card, not the page.
    expect(shows('Website Revamp')).toBe(true);
    expect(shows('Work overview')).toBe(true);
    expect(shows('Ship the new marketing site')).toBe(true);
    expect(shows('Design the landing page')).toBe(true);
    expect(shows('Project could not be loaded')).toBe(false);
  });
});
