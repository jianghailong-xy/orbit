// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
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
vi.mock('../api', () => ({ api: vi.fn() }));
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
  coordinatorSessionId: null,
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

/** Enough of GET …/coordinator/status for the surface to paint — every absent fact carrying its
 *  reason, which is the shape a project nobody has coordinated actually returns. */
const COORDINATOR = {
  projectId: PROJECT,
  readAt: '2026-08-20T10:00:00.000Z',
  project: {
    title: 'Website Revamp', status: 'OPEN',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    taskCount: 5, tasksByStatus: { OPEN: 2, DONE: 3 },
  },
  coordination: {
    agentId: null, agentIdAbsentReason: 'NO_COORDINATOR_AGENT', agentName: null,
    identitySource: 'DERIVED', workspaceId: null,
    workspaceIdAbsentReason: 'NO_COORDINATION_WORKSPACE', generation: '0',
    sessionId: null, sessionIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
    session: null, sessionAbsentReason: 'COORDINATOR_NEVER_OPENED',
  },
  policy: {
    coordinatorEnabled: false, automationPolicy: 'MANUAL', configRevision: '0',
    maxConcurrentTasks: 1, sessionBudgetPerDay: null, sessionBudgetPerDayAbsentReason: 'UNLIMITED',
  },
  consumption: {
    tasksInFlight: 0, concurrencyRemaining: 1, coordinatorSessionsLast24h: 0,
    budgetRemaining: null, budgetRemainingAbsentReason: 'UNLIMITED',
    budgetWindowStartedAt: '2026-08-19T10:00:00.000Z',
  },
  runtime: {
    runState: 'PLANNING', lease: null, leaseAbsentReason: 'NOT_LEASED',
    fencingToken: '0', acceptanceAttempt: '0',
  },
  nextWake: {
    at: null, reason: null, absentReason: 'NO_WAKE_SCHEDULED',
    candidates: [], candidatesAbsentReason: 'NO_DECISION_YET', flooredBy: null, decisionId: null,
  },
  decisions: [], decisionsEmptyReason: 'NO_DECISION_YET',
  pendingActions: [], pendingActionsEmptyReason: 'NO_PENDING_ACTION',
  blockers: { open: [], openEmptyReason: 'NO_OPEN_BLOCKER', resolved: [] },
  events: { pending: [], pendingEmptyReason: 'NO_PENDING_EVENT', recent: [] },
  acceptance: {
    criteria: null, criteriaAbsentReason: 'NO_ACCEPTANCE_CRITERIA', attempt: '0',
    run: null, runAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
    doneGate: {
      allowed: false, runId: null, refusalCode: 'ACCEPTANCE_MISSING', reason: null,
      acceptanceDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    lastRun: null, lastRunAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
    evidence: {
      verifications: { total: 0, pending: 0, pass: 0, fail: 0, inconclusive: 0, unresolvedFailures: 0 },
      merges: [], mergesEmptyReason: 'NO_MERGE_EVIDENCE',
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

describe('ProjectDetailPage — the panorama, assembled', () => {
  it('lays the five blocks out in the order the reader asks for them', async () => {
    serve();
    await mount(page());

    // Each block found by what it SAYS, not by a test id: these are the headings a reader steers
    // by, and a rename that leaves them unfindable is the thing worth failing on.
    const header = at('Where the work stands');
    const ranking = at('Unblocks the most work');
    const acceptance = at('Acceptance</div>');
    const feed = at('What the coordinator has been doing');
    const tasks = at('>Tasks<');
    const chain = at('aria-label="Chain progress"');

    expect(header).toBeGreaterThan(-1);
    expect(ranking).toBeGreaterThan(header);
    // Side by side, so the ranking leads and acceptance follows within the same row.
    expect(acceptance).toBeGreaterThan(ranking);
    expect(feed).toBeGreaterThan(acceptance);
    expect(tasks).toBeGreaterThan(feed);
    expect(chain).toBeGreaterThan(tasks);

    // And the pair really is a pair — one grid, two cards, neither wrapping the other.
    const pair = container.querySelector('.project-panorama-pair');
    expect(pair).not.toBeNull();
    expect(pair!.children.length).toBe(2);
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
    expect(shows('Where the work stands')).toBe(true);
    expect(shows('Acceptance')).toBe(true);
    expect(shows('What the coordinator has been doing')).toBe(true);
    expect(shows('Design the landing page')).toBe(true);
    expect(shows('aria-label="Chain progress"')).toBe(true);

    // One failure, not a page of them: the other cards are not showing error states of their own.
    expect(shows('Project panorama could not be loaded')).toBe(false);
    expect(shows('Tasks could not be loaded')).toBe(false);
    expect(shows('Project could not be loaded')).toBe(false);
  });

  it('keeps the page standing when dispatch health omits its refusal breakdown', async () => {
    const stalled = panorama('chain');
    serve({
      [`${base}/panorama`]: () =>
        Promise.resolve({
          ...stalled,
          buckets: { ...stalled.buckets, running: 0 },
        }),
      [`${base}/panorama/dispatch-health`]: () =>
        Promise.resolve({ windowHours: 24, dispatch: { applied: 0, refused: 0 } }),
    });
    await mount(page());

    expect(shows('Website Revamp')).toBe(true);
    expect(shows('Where the work stands')).toBe(true);
    expect(shows('Unblocks the most work')).toBe(true);
    expect(shows('Acceptance')).toBe(true);
    expect(shows('What the coordinator has been doing')).toBe(true);
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
    expect(shows('Where the work stands')).toBe(true);
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
    expect(shows('Where the work stands')).toBe(false);
    expect(shows('Unblocks the most work')).toBe(false);
    expect(shows('What the coordinator has been doing')).toBe(false);
  });

  it('still carries the project’s own fields and its coordinator, below the panorama', async () => {
    serve();
    await mount(page());

    // The three free-text fields, in full and under their own labels.
    expect(shows('Goal')).toBe(true);
    expect(shows('Ship the new marketing site')).toBe(true);
    expect(shows('Acceptance criteria')).toBe(true);
    expect(shows('Lighthouse ≥ 90 on every page')).toBe(true);
    expect(shows('Instructions')).toBe(true);
    expect(shows('Land behind a flag, then flip it')).toBe(true);

    // The coordinator surface, both halves of it: the control that opens the conversation and the
    // section that reports what the loop is doing.
    expect(shows('>Coordinator<')).toBe(true);
    expect(shows('Start coordinator')).toBe(true);

    // Below the panorama, which is the move this assembly made: what the project was set up to be
    // is read once, where the panorama is what a reader comes back for.
    expect(at('Where the work stands')).toBeLessThan(at('Ship the new marketing site'));
    expect(at('>Tasks<')).toBeLessThan(at('Ship the new marketing site'));
    expect(at('Ship the new marketing site')).toBeLessThan(at('>Coordinator<'));
  });
});
