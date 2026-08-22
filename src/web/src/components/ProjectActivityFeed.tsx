import { useEffect, useRef, type ReactNode } from 'react';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, Spin, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';

/**
 * What the control loop has actually been doing, as one scrollable stream
 * (`GET /projects/:id/panorama/activity`).
 *
 * Three tables record it — the event outbox, the decision audit and the action ledger — and until
 * this card no page showed a row of any of them. Read in time order they are the loop itself: the
 * layer a project of autonomous work has and a ticket tracker does not, because its tickets never
 * decide anything.
 *
 * THREE THINGS THIS CARD IS CAREFUL ABOUT
 *
 *  - **The outcome is a WORD, not a colour.** Every row prints `REFUSED` / `APPLIED` / `RESOLVED` /
 *    `INFO` as text, and the colour only reinforces it. A reader who cannot separate the hues (or
 *    is looking at a greyscale screenshot in a bug report) loses nothing, and a row can never mean
 *    something the row does not say.
 *  - **Refusals are findable by eye.** A REFUSED row also takes `--fill-inset` behind it, because
 *    "why did it not dispatch just now" is the question this card gets asked most, and answering
 *    it should not require reading every line.
 *  - **The columns line up.** Time and kind are read DOWN the card, not across, so they are one
 *    grid (tabular figures, monospace kinds) rather than three per-row layouts that drift.
 *
 * FETCHES ITS OWN DATA, like the other panorama cards: it hangs on the project page beside cards
 * that each read a different endpoint, and taking rows as props would make the page decide when to
 * poll for a feed it knows nothing else about. It takes a project id and nothing else, so it can
 * be mounted — and tested — alone.
 */

/**
 * The closed set the server maps all three tables into (see `project-panorama-activity.ts`).
 *
 * Mirrored rather than imported: the web bundle does not depend on the apiserver's build, and this
 * is a wire contract either way. Nothing here fails on a value outside the set — a newer server
 * that adds a ninth kind gets its kind printed verbatim, which is the whole reason the column is
 * the raw vocabulary and not a table of English phrases.
 */
export type ProjectActivityKind =
  | 'DISPATCH_TASK'
  | 'OPEN_COORDINATOR_TURN'
  | 'ROTATE_COORDINATOR_SESSION'
  | 'RAISE_BLOCKER'
  | 'CLEAR_BLOCKER'
  | 'APPLY_VERIFICATION_VERDICT'
  | 'REQUEST_APPROVAL'
  | 'RUN_PROJECT_ACCEPTANCE'
  | 'DECIDE'
  | 'WAKE'
  | 'SIGNAL';

/** How a row reads, in the four values a colour may be chosen from — and printed as the word. */
export type ProjectActivityOutcome = 'APPLIED' | 'REFUSED' | 'RESOLVED' | 'INFO';

export interface ProjectActivityItem {
  /** Base62 by the time it leaves the API. The row key, and what its cursor was built from. */
  id: string;
  /** ISO instant; the server's `Date` crosses the wire as a string. */
  at: string;
  kind: ProjectActivityKind | string;
  title: string;
  detail: string | null;
  outcome: ProjectActivityOutcome | string;
  /** The task this row is ABOUT, when it is about one — an address the reader opens. */
  subjectTaskId: string | null;
}

export interface ProjectActivityPage {
  items: ProjectActivityItem[];
  nextCursor: string | null;
}

/** A screenful, matching the endpoint's own default. */
export const ACTIVITY_PAGE_SIZE = 20;

/**
 * Keyed UNDER `['project', projectId]`, like the coordinator surface and the panorama header, so
 * the invalidation a control write already fires for the project document refreshes this too.
 *
 * Polled only while a single page is loaded. A poll refetches EVERY page react-query is holding,
 * so a reader who has scrolled back through six pages would be re-requesting six pages a minute to
 * learn about rows that only ever appear at the top; past the first page this is being read as
 * history, and history does not move.
 */
export const projectActivityQuery = (projectId: string) =>
  infiniteQueryOptions({
    queryKey: ['project', projectId, 'panorama', 'activity'] as const,
    queryFn: ({ pageParam }) =>
      api<ProjectActivityPage>(
        `/projects/${encodeURIComponent(projectId)}/panorama/activity?limit=${ACTIVITY_PAGE_SIZE}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: null as string | null,
    // `undefined`, never null: react-query reads null as a legitimate page param, which would ask
    // for the first page again forever at the end of the stream.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 30_000),
  });

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

/**
 * The colour each outcome is reinforced with. It carries nothing the row does not also spell out —
 * see the file header — so an unknown value simply reads neutral rather than being dropped.
 */
const OUTCOME_COLOR: Record<string, string> = {
  REFUSED: 'var(--error)',
  APPLIED: 'var(--success)',
  RESOLVED: 'var(--success)',
  INFO: 'var(--text-3)',
};

/** The eight kinds that came from the action ledger; `DECIDE` came from the decision audit and
 *  everything else from the event outbox. */
const ACTION_KINDS: ReadonlySet<string> = new Set([
  'DISPATCH_TASK',
  'OPEN_COORDINATOR_TURN',
  'ROTATE_COORDINATOR_SESSION',
  'RAISE_BLOCKER',
  'CLEAR_BLOCKER',
  'APPLY_VERIFICATION_VERDICT',
  'REQUEST_APPROVAL',
  'RUN_PROJECT_ACCEPTANCE',
]);

export interface ActivitySourceCounts {
  events: number;
  decisions: number;
  actions: number;
}

/**
 * How many of the loaded rows came from each of the three tables.
 *
 * The endpoint serves one merged stream and does not report the tables' totals, so this counts what
 * is in hand and the hint says `loaded` rather than implying a table-wide total. It is here for one
 * reason: three logs that no page has ever shown should not look like they started existing when
 * this card was written.
 *
 * Derived from `kind` because that is what the wire carries. The one imprecision: a server newer
 * than its own enum reports an unrecognised action as `SIGNAL`, which lands in `events` — a
 * miscount of a row that should not exist rather than of anything the loop routinely writes.
 */
export function activitySourceCounts(items: ProjectActivityItem[]): ActivitySourceCounts {
  const counts: ActivitySourceCounts = { events: 0, decisions: 0, actions: 0 };
  for (const item of items) {
    if (ACTION_KINDS.has(item.kind)) counts.actions += 1;
    else if (item.kind === 'DECIDE') counts.decisions += 1;
    else counts.events += 1;
  }
  return counts;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function activityHint(items: ProjectActivityItem[]): string {
  const { events, decisions, actions } = activitySourceCounts(items);
  return `${plural(events, 'event')} · ${plural(decisions, 'decision')} · ${plural(
    actions,
    'action',
  )} loaded`;
}

/**
 * An instant on the reader's wall clock, to the second.
 *
 * Seconds because a reconcile pass writes its decision and the actions it produced in one
 * transaction: minute resolution would print the same time for a group whose ORDER is the thing
 * being read. An unparseable value is printed as it arrived rather than as a dash — the row is
 * still history, and a dash would hide which field is wrong.
 */
export function activityTime(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return at;
  return when.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** The card chrome, so the loading, error, empty and loaded states are one block on the page
 *  rather than four differently-sized ones. */
function Card({ hint, children }: { hint?: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        padding: '18px 20px',
        marginBottom: 14,
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          What the coordinator has been doing
        </Typography.Title>
        {hint ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** One row, as three cells of the enclosing grid — see {@link Feed} for why they are not a
 *  per-row layout of their own. */
function Row({ item }: { item: ProjectActivityItem }) {
  const refused = item.outcome === 'REFUSED';
  // The tint goes on all three cells, because the row itself is not an element in a grid whose
  // children are the cells — a background on a `display: contents` wrapper paints nothing.
  const cell: React.CSSProperties = {
    padding: '5px 10px',
    borderTop: '1px solid var(--border-subtle)',
    background: refused ? 'var(--fill-inset)' : undefined,
  };

  return (
    <>
      <div
        style={{
          ...cell,
          paddingLeft: 2,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-3)',
          whiteSpace: 'nowrap',
        }}
      >
        {activityTime(item.at)}
      </div>
      <div style={{ ...cell, fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap' }}>
        {item.kind}
      </div>
      <div style={{ ...cell, paddingRight: 2, minWidth: 0, overflowWrap: 'anywhere' }}>
        {/* The outcome, as the word. Everything about this row's standing is in these characters;
            the colour beside them repeats it and decides nothing. */}
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
            color: OUTCOME_COLOR[item.outcome] ?? 'var(--text-3)',
          }}
        >
          {item.outcome}
        </span>{' '}
        {item.subjectTaskId ? (
          // The row is ABOUT a task, so its title is the way into that task. Ids arrive Base62
          // from the interceptor; nothing is encoded here.
          <Link to={`/tasks/${encodeURIComponent(item.subjectTaskId)}`}>{item.title}</Link>
        ) : (
          <span>{item.title}</span>
        )}
        {item.detail ? (
          <span style={{ color: 'var(--text-2)' }}> — {item.detail}</span>
        ) : null}
      </div>
    </>
  );
}

export function ProjectActivityFeed({ projectId }: { projectId: string }) {
  const feed = useInfiniteQuery({
    ...projectActivityQuery(projectId),
    enabled: Boolean(projectId),
  });
  const items = (feed.data?.pages ?? []).flatMap((page) => page.items);

  // Pull the next page when the end of the feed comes into view, so the stream is read by
  // scrolling. The button below is the same action for a reader who is not scrolling (and the only
  // one a keyboard can reach), not a second mechanism.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !feed.hasNextPage || feed.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void feed.fetchNextPage();
      },
      { rootMargin: '300px' },
    );
    observer.observe(sentinel);
    // Re-armed after each page: torn down while a fetch is in flight and set up again once the
    // rows have landed, so one page is requested at a time even though the sentinel stays in view.
    return () => observer.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  // `isPending`, not `isLoading`: `isLoading` is `isPending && isFetching`, and a card mounted
  // before the page has resolved its project id holds a DISABLED query — pending with nothing in
  // flight. Reading `isLoading` there falls through to the empty state below and tells the reader
  // the control loop has recorded nothing for a project this card has not asked about yet.
  if (feed.isPending) {
    return (
      <Card>
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (feed.isError && items.length === 0) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="Coordinator activity could not be loaded"
          description={feed.error instanceof Error ? feed.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => void feed.refetch()}>
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card hint={activityHint(items)}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="The control loop has not recorded anything for this project yet."
        />
      </Card>
    );
  }

  return (
    <Card hint={activityHint(items)}>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content 1fr', fontSize: 13, lineHeight: 1.5 }}>
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </div>

      {feed.hasNextPage ? (
        <div ref={loadMoreRef} style={{ textAlign: 'center', paddingTop: 12 }}>
          <Button size="small" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            Load older activity
          </Button>
          {/* A page that failed leaves the rows already read in place and says why here, rather
              than replacing a readable feed with an error card. */}
          {feed.isError ? (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--error)' }}>
              The last page could not be loaded.
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
