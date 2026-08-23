// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  ProjectActivityFeed,
  activityHint,
  activitySourceCounts,
  activityTime,
  coalesceActivityRuns,
  projectActivityQuery,
  type ProjectActivityItem,
  type ProjectActivityPage,
} from './ProjectActivityFeed';

// react-query never dispatches a fetch during a static (effect-free) render, so the render tests
// seed the cache rather than letting a request run — the arrangement ProjectPanoramaHeader.test.tsx
// and ProjectsPage.test.tsx use. The stub is also what the query-options tests call directly, which
// is how the URL this card requests is pinned to behaviour rather than to a regex over the source.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

/** The short public id spelling the project page carries. This card encodes nothing — it puts what
 *  it is handed into the path. */
const PROJECT = '34BdLWSvNefueJBjdxJ7n';
const TASK = '34BdRqMcaKjseHpLXlGuN';

// Spelled out rather than imported from the component: a key the component changes unilaterally has
// to break these tests, which it cannot do if both sides read one constant.
const activityKey = ['project', PROJECT, 'panorama', 'activity'];

function newClient() {
  // refetchOnMount/retryOnMount:false keep a seeded entry (success OR error) from being treated as
  // needing a fresh fetch on this mount — these assertions are about what is already in cache.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
}

function render(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectActivityFeed projectId={PROJECT} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Seed one already-loaded page. */
function seed(qc: QueryClient, page: ProjectActivityPage) {
  qc.setQueryData(activityKey, { pages: [page], pageParams: [null] });
}

/** What a reader actually SEES: markup with its tags removed and its entities decoded, so an
 *  assertion cannot be satisfied by a class name, a colour or an aria attribute. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/** Every link in the markup, as `[href, text]`. */
function links(html: string): Array<[string, string]> {
  return [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
    m[1],
    visibleText(m[2]).trim(),
  ]);
}

const item = (over: Partial<ProjectActivityItem> = {}): ProjectActivityItem => {
  const merged: ProjectActivityItem = {
    id: 'row-1',
    at: '2026-08-22T16:25:11.000Z',
    kind: 'DISPATCH_TASK',
    title: 'Dispatch task',
    detail: 'PROVIDER_UNAVAILABLE',
    outcome: 'REFUSED',
    subjectTaskId: TASK,
    occurrences: [],
    ...over,
  };
  return {
    ...merged,
    occurrences: over.occurrences ?? [{ id: merged.id, at: merged.at }],
  };
};

function repeatedItem(count: number, over: Partial<ProjectActivityItem>): ProjectActivityItem {
  const base = item(over);
  const start = Date.parse(base.at);
  const occurrences = Array.from({ length: count }, (_, index) => ({
    id: `${base.id}-${index + 1}`,
    at: new Date(start - index * 60_000).toISOString(),
  }));
  return { ...base, id: occurrences[0].id, at: occurrences[0].at, occurrences };
}

async function mountInteractive(qc: QueryClient) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ProjectActivityFeed projectId={PROJECT} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** One row per outcome, in the four values the endpoint normalises to. */
const fourOutcomes: ProjectActivityItem[] = [
  item({ id: 'a', outcome: 'REFUSED', kind: 'DISPATCH_TASK', title: 'Dispatch task', detail: 'PROVIDER_UNAVAILABLE' }),
  item({ id: 'b', outcome: 'APPLIED', kind: 'OPEN_COORDINATOR_TURN', title: 'Open coordinator turn', detail: null, subjectTaskId: null }),
  item({ id: 'c', outcome: 'RESOLVED', kind: 'CLEAR_BLOCKER', title: 'Clear blocker', detail: 'WAITING_ON_APPROVAL', subjectTaskId: null }),
  item({ id: 'd', outcome: 'INFO', kind: 'DECIDE', title: 'in-flight session may end', detail: 'RUNNING → RUNNING', subjectTaskId: null }),
];

describe('ProjectActivityFeed', () => {
  it('prints every outcome as a WORD, so the colour is never the only channel', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });
    const text = visibleText(render(qc));

    // The assertion the card exists to keep honest: each outcome is readable text, not a class.
    for (const outcome of ['REFUSED', 'APPLIED', 'RESOLVED', 'INFO']) {
      expect(text).toContain(outcome);
    }
  });

  it('renders each row as time, kind and detail', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });
    const html = render(qc);
    const text = visibleText(html);

    for (const row of fourOutcomes) {
      expect(text).toContain(row.kind); // the kind column, verbatim from the wire
      expect(text).toContain(row.title);
      if (row.detail) expect(text).toContain(row.detail);
      expect(text).toContain(activityTime(row.at)); // the time column, on the reader's clock
    }
    // Digits are read down the column, so they have to be tabular.
    expect(html).toContain('font-variant-numeric:tabular-nums');
  });

  it('tints a REFUSED row and leaves the others untinted', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });
    const html = render(qc);

    // Three cells of the one refused row, and no more: the other three rows carry no fill.
    expect([...html.matchAll(/background:var\(--fill-inset\)/g)]).toHaveLength(3);
  });

  it('links a row that is about a task, and only such a row', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });

    // One row carries a subjectTaskId; its title is the way into that task.
    expect(links(render(qc))).toEqual([[`/tasks/${TASK}`, 'Dispatch task']]);
  });

  it('offers a way to keep loading exactly when the server says there is more', () => {
    const withMore = newClient();
    seed(withMore, { items: fourOutcomes, nextCursor: 'eyJjcmVhdGVkQXQiOiIyMDI2In0' });
    expect(visibleText(render(withMore))).toContain('Load older activity');

    const end = newClient();
    seed(end, { items: fourOutcomes, nextCursor: null });
    expect(visibleText(render(end))).not.toContain('Load older activity');
  });

  it('reports how many rows of each of the three logs are in hand', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });
    const text = visibleText(render(qc));

    // Three actions (dispatch, open turn, clear blocker), one decision, no events in this page.
    expect(text).toContain('0 events · 1 decision · 3 actions loaded');
  });

  it('shows a collapsed run as a count and time span, then expands every original row', async () => {
    const qc = newClient();
    const run = repeatedItem(3, {
      id: 'wake',
      kind: 'WAKE',
      title: 'timer.due',
      detail: null,
      outcome: 'INFO',
      subjectTaskId: null,
    });
    seed(qc, { items: [run], nextCursor: null });

    const collapsed = visibleText(render(qc));
    const newest = activityTime(run.occurrences[0].at);
    const middle = activityTime(run.occurrences[1].at);
    const oldest = activityTime(run.occurrences[2].at);
    expect(collapsed).toContain('WAKE ×3');
    expect(collapsed).toContain(`${oldest} – ${newest}`);
    expect(collapsed).toContain('INFO');
    expect(collapsed).not.toContain(middle);

    const { container, root } = await mountInteractive(qc);
    try {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Show 3 rows',
      );
      expect(button).toBeDefined();
      await click(button!);

      const expanded = container.textContent ?? '';
      for (const occurrence of run.occurrences) {
        expect(expanded).toContain(activityTime(occurrence.at));
      }
      // The summary plus all three restored rows still spell the outcome; colour is never the
      // only channel in either state.
      expect(expanded.match(/INFO/g)).toHaveLength(4);
      expect(expanded).toContain('Hide 3 rows');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps the card bounded and scrolls its contents internally', () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: null });
    const html = render(qc);

    expect(html).toContain('max-height:420px');
    expect(html).toContain('overflow-y:auto');
  });

  it('keeps full source counts after folding 47 heartbeat pairs', () => {
    const qc = newClient();
    seed(qc, {
      items: [
        repeatedItem(47, {
          id: 'wake', kind: 'WAKE', title: 'timer.due', detail: null,
          outcome: 'INFO', subjectTaskId: null,
        }),
        repeatedItem(47, {
          id: 'decide', kind: 'DECIDE', title: 'in-flight session may end', detail: null,
          outcome: 'INFO', subjectTaskId: null,
        }),
        item({ id: 'action-1', kind: 'DISPATCH_TASK', outcome: 'APPLIED' }),
        item({ id: 'action-2', kind: 'RAISE_BLOCKER', outcome: 'APPLIED' }),
        item({ id: 'action-3', kind: 'REQUEST_APPROVAL', outcome: 'REFUSED' }),
      ],
      nextCursor: null,
    });

    expect(visibleText(render(qc))).toContain('47 events · 47 decisions · 3 actions loaded');
  });

  it('renders an empty project as an empty state rather than an empty grid', () => {
    const qc = newClient();
    seed(qc, { items: [], nextCursor: null });
    const html = render(qc);

    expect(visibleText(html)).toContain('The control loop has not recorded anything for this project yet.');
    expect(html).toContain('ant-empty');
    expect(links(html)).toEqual([]);
    expect(visibleText(html)).not.toContain('Load older activity');
  });

  it('treats a page with no activity list as empty', () => {
    const qc = newClient();
    qc.setQueryData(activityKey, { pages: [{ nextCursor: null }], pageParams: [null] });

    const html = render(qc);
    expect(visibleText(html)).toContain('The control loop has not recorded anything for this project yet.');
  });

  it('renders the loading state, and does not throw', () => {
    // Nothing seeded, so the query is pending with its fetch not yet dispatched.
    const html = render(newClient());

    expect(html).toContain('What the coordinator has been doing');
    expect(html).toContain('ant-spin');
    expect(html).not.toContain('could not be loaded');
  });

  it('waits rather than claiming the loop did nothing, before it has a project to ask about', () => {
    // The page mounts this card before its project id resolves, so the query is disabled: pending
    // with nothing in flight. `isLoading` is false there — reading it would answer "the control
    // loop has not recorded anything" for a project this card has not asked a single question about.
    const html = renderToStaticMarkup(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter>
          <ProjectActivityFeed projectId="" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain('ant-spin');
    expect(visibleText(html)).not.toContain('has not recorded anything');
  });

  it('renders the error state with a Retry, and does not throw', async () => {
    const qc = newClient();
    await qc.prefetchInfiniteQuery({
      queryKey: activityKey,
      queryFn: () => Promise.reject(new Error('network down')),
      initialPageParam: null,
    });
    const html = render(qc);
    const text = visibleText(html);

    expect(text).toContain('Coordinator activity could not be loaded');
    expect(text).toContain('network down');
    expect(text).toContain('Retry');
    // A failed read is never drawn as a project the loop has done nothing for.
    expect(text).not.toContain('has not recorded anything');
  });

  it('keeps the rows it has when a later page fails, and says so', async () => {
    const qc = newClient();
    seed(qc, { items: fourOutcomes, nextCursor: 'more' });
    // The state a failed fetchNextPage leaves behind: pages in cache, status error.
    qc.setQueryData(activityKey, (prev: unknown) => prev);
    const entry = qc.getQueryCache().find({ queryKey: activityKey });
    entry?.setState({ status: 'error', error: new Error('page 2 down') } as never);
    const text = visibleText(render(qc));

    expect(text).toContain('Dispatch task'); // the rows already read stay on screen
    expect(text).toContain('The last page could not be loaded.');
  });

  it('requests the endpoint the backend serves, first page and cursor alike', async () => {
    const mock = vi.mocked(api);
    mock.mockReset();
    mock.mockResolvedValue({ items: [], nextCursor: null });
    const options = projectActivityQuery(PROJECT);
    const call = options.queryFn as (ctx: { pageParam: string | null }) => Promise<unknown>;

    await call({ pageParam: null });
    await call({ pageParam: 'cur sor/1' });

    expect(mock.mock.calls.map((c) => c[0])).toEqual([
      `/projects/${PROJECT}/panorama/activity?limit=20`,
      `/projects/${PROJECT}/panorama/activity?limit=20&cursor=cur%20sor%2F1`,
    ]);
  });

  it('pages on nextCursor, and stops rather than re-asking for the first page', () => {
    const { getNextPageParam } = projectActivityQuery(PROJECT);
    const next = getNextPageParam as (page: ProjectActivityPage) => string | undefined;

    expect(next({ items: [], nextCursor: 'abc' })).toBe('abc');
    // `undefined`, never null: react-query reads null as a real page param and would loop.
    expect(next({ items: [], nextCursor: null })).toBeUndefined();
  });
});

describe('activitySourceCounts', () => {
  it('splits the merged stream back into the three logs it came from', () => {
    expect(activitySourceCounts(fourOutcomes)).toEqual({ events: 0, decisions: 1, actions: 3 });
    expect(
      activitySourceCounts([
        item({ kind: 'WAKE' }),
        item({ kind: 'SIGNAL' }),
        item({ kind: 'DECIDE' }),
        item({ kind: 'RAISE_BLOCKER' }),
      ]),
    ).toEqual({ events: 2, decisions: 1, actions: 1 });
    expect(activitySourceCounts([])).toEqual({ events: 0, decisions: 0, actions: 0 });
  });

  it('counts one row in the singular', () => {
    expect(activityHint([item({ kind: 'WAKE' })])).toBe('1 event · 0 decisions · 0 actions loaded');
  });
});

describe('coalesceActivityRuns', () => {
  it('rejoins bounded page chunks of the two interleaved heartbeat lanes', () => {
    const wakeA = repeatedItem(2, {
      id: 'wake-a', kind: 'WAKE', title: 'timer.due', detail: null,
      outcome: 'INFO', subjectTaskId: null,
    });
    const decideA = repeatedItem(2, {
      id: 'decide-a', kind: 'DECIDE', title: 'in-flight session may end', detail: null,
      outcome: 'INFO', subjectTaskId: null,
    });
    const wakeB = repeatedItem(3, {
      id: 'wake-b', kind: 'WAKE', title: 'timer.due', detail: null,
      outcome: 'INFO', subjectTaskId: null,
    });
    const decideB = repeatedItem(3, {
      id: 'decide-b', kind: 'DECIDE', title: 'in-flight session may end', detail: null,
      outcome: 'INFO', subjectTaskId: null,
    });

    const joined = coalesceActivityRuns([wakeA, decideA, wakeB, decideB]);
    expect(joined.map((run) => run.kind)).toEqual(['WAKE', 'DECIDE']);
    expect(joined.map((run) => run.occurrences.length)).toEqual([5, 5]);
  });
});

describe('activityTime', () => {
  it('reads to the second, because a pass writes its whole group in one instant', () => {
    // Two rows of one transaction differ only in their seconds; a minute-resolution clock would
    // print them identically and hide the order the feed is read for.
    expect(activityTime('2026-08-22T16:25:11.000Z')).not.toBe(activityTime('2026-08-22T16:25:41.000Z'));
    expect(activityTime('2026-08-22T16:25:11.000Z')).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('prints an unreadable instant as it arrived rather than hiding it', () => {
    expect(activityTime('not-a-date')).toBe('not-a-date');
  });
});
