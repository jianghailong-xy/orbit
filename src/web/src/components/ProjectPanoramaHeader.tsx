import type { ReactNode } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';

/**
 * Where a project's work stands, and — when none of it is moving — why (the header card of the
 * project page).
 *
 * Three parts, in one card because they answer one question between them:
 *
 *  1. **Four buckets.** Running / Ready / Blocked / Done. `Ready` and `Blocked` are the two halves
 *     of the single `OPEN` tally the rest of the app reports, and splitting them is the whole
 *     point of this card: on the measured deployment that one number is 233 tasks waiting on a
 *     prerequisite and 29 that could start right now. No combined count can say "this project is
 *     stalled", because a big OPEN number looks the same either way.
 *  2. **A stacked meter.** The same four numbers as one 9px bar, so the proportion is readable
 *     without doing arithmetic on four figures.
 *  3. **A stalled banner.** Rendered only when `ready > 0 && running === 0` — work that could
 *     start and nothing starting it — carrying the dispatch ledger's own account of why.
 *
 * FETCHES ITS OWN DATA, deliberately: it is mounted next to four other cards that each read a
 * different endpoint, and a header that took its numbers as props would make the page decide when
 * to poll for a card it does not otherwise know anything about. It takes the project id and
 * nothing else, so it can be mounted (and tested) alone.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. Each bucket carries a distinct SHAPE — filled disc, right
 * triangle, hollow square, check — because Orbit's own tokens do not separate under CVD:
 * `--success-solid` against `--warning-solid` is OKLab ΔE 2.4 under protanopia, and green against
 * amber in dark mode is 6.4 (both measured by `src/lib/statusPalette.test.ts`'s pipeline, and both
 * under the ΔE 8 floor). Two consequences are baked into the palette below: `Done` wears
 * `--success` rather than `--success-solid`, and `Blocked` wears neutral `--text-3` rather than a
 * fifth hue — a neutral there is what lets `Ready`'s amber read as the one bucket asking for
 * attention. The meter, which has no room for a shape, carries the numbers in its `aria-label`.
 */

export interface ProjectPanoramaBuckets {
  running: number;
  ready: number;
  blocked: number;
  done: number;
  /** Reported by the endpoint and deliberately not a KPI cell: a decision, not work in flight. */
  cancelled: number;
}

/** The project's dependency graph as three numbers and the verdict drawn from them. */
export interface ProjectPanoramaShape {
  taskCount: number;
  edgeCount: number;
  ratio: number;
  /** Length in EDGES of the longest dependency path, so a 10-task chain reports 9. */
  maxDepth: number;
  form: 'chain' | 'mesh';
}

export interface ProjectPanorama {
  buckets: ProjectPanoramaBuckets;
  shape: ProjectPanoramaShape;
}

/** One PAC §12 refusal code and how often the control loop refused under it in the window. */
export interface DispatchRefusal {
  refusalCode: string;
  count: number;
  lastSeenAt: string;
}

export interface DispatchHealth {
  windowHours: number;
  dispatch: { applied: number; refused: number };
  /** Server-ordered by count, descending — read in that order rather than re-sorted here. */
  refusals: DispatchRefusal[];
  openBlockers: Array<{ kind: string; severity: string; occurrences: number; firstSeenAt: string }>;
}

/**
 * Keyed UNDER `['project', projectId]`, like the coordinator surface, so the invalidation a
 * control write already fires for the project document refreshes this too.
 *
 * Polled, because every number on it moves without this tab doing anything — a task is claimed, a
 * prerequisite settles, a run finishes. Slower than the coordinator panel's own 15s: this is four
 * aggregates over the project's whole task graph, and a header that is half a minute stale has
 * never misled anybody.
 */
export const projectPanoramaQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama'] as const,
    queryFn: () => api<ProjectPanorama>(`/projects/${encodeURIComponent(projectId)}/panorama`),
    refetchInterval: 30_000,
  });

/** A day, matching the endpoint's own default: long enough that an idle night still shows why. */
export const DISPATCH_HEALTH_WINDOW_HOURS = 24;

/** The dispatch ledger behind the stalled banner — requested only when there is a stall to explain. */
export const projectDispatchHealthQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama', 'dispatch-health'] as const,
    queryFn: () =>
      api<DispatchHealth>(
        `/projects/${encodeURIComponent(projectId)}/panorama/dispatch-health?windowHours=${DISPATCH_HEALTH_WINDOW_HOURS}`,
      ),
    refetchInterval: 30_000,
  });

/** The shapes, in the order they are drawn. Names describe the mark, not the status it stands for. */
export type BucketGlyph = 'disc' | 'triangle' | 'square' | 'check';

type BucketKey = 'running' | 'ready' | 'blocked' | 'done';

/**
 * One row per bucket, in reading order: what it is called, which shape carries it, and which token
 * colours it. See the file header for why the shape is not decoration and why `done` is `--success`
 * while `blocked` is a neutral.
 */
export const PANORAMA_BUCKETS: ReadonlyArray<{
  key: BucketKey;
  label: string;
  glyph: BucketGlyph;
  color: string;
}> = [
  { key: 'running', label: 'Running', glyph: 'disc', color: 'var(--brand)' },
  { key: 'ready', label: 'Ready', glyph: 'triangle', color: 'var(--warning-solid)' },
  { key: 'blocked', label: 'Blocked', glyph: 'square', color: 'var(--text-3)' },
  { key: 'done', label: 'Done', glyph: 'check', color: 'var(--success)' },
];

/**
 * Work that could start, and nothing starting it.
 *
 * The one condition this card exists to make visible, and the only thing that renders the banner:
 * neither number is remarkable alone — a project with four ready tasks is normal, and a project
 * with nothing running is normal — but together they mean the queue is not being served.
 */
export function stalledOnReady(buckets: ProjectPanoramaBuckets): boolean {
  return buckets.ready > 0 && buckets.running === 0;
}

/** A status marker as a SHAPE. `aria-hidden` because the cell's own text already names the status —
 *  a second reading of "Running" is noise, and the shape is here for the eye, not the screen reader.
 *
 *  `size` scales the drawing instead of redrawing it: the viewBox is fixed, so the projects list's
 *  8px marks are these four geometries, stroke weights and all, and not a second set that could
 *  drift from them. */
export function Glyph({
  shape,
  color,
  size = 12,
}: {
  shape: BucketGlyph;
  color: string;
  size?: number;
}) {
  return (
    <svg
      data-glyph={shape}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      style={{ color, flex: 'none' }}
    >
      {shape === 'disc' ? (
        <circle cx="6" cy="6" r="5" fill="currentColor" />
      ) : shape === 'triangle' ? (
        <polygon points="2.5,1 11,6 2.5,11" fill="currentColor" />
      ) : shape === 'square' ? (
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <path
          d="M1.5 6.4 L4.6 9.5 L10.5 2.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** One bucket: shape, name, the number, and a line saying what the number counts. */
function Kpi({
  label,
  value,
  footnote,
  glyph,
  color,
  attention,
}: {
  label: string;
  value: number;
  footnote: string;
  glyph: BucketGlyph;
  color: string;
  attention: boolean;
}) {
  return (
    <div
      style={{
        background: attention ? 'var(--warning-bg)' : 'var(--bg-raised)',
        padding: '13px 15px 14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12,
          color: 'var(--text-2)',
          marginBottom: 3,
          whiteSpace: 'nowrap',
        }}
      >
        <Glyph shape={glyph} color={color} />
        {label}
      </div>
      <div style={{ fontSize: 29, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.12, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 1 }}>{footnote}</div>
    </div>
  );
}

/** 4px on the bar's outer ends, 2px everywhere the 2px surface gap does the separating. */
function segmentRadius(index: number, total: number): string {
  if (total === 1) return '4px';
  if (index === 0) return '4px 2px 2px 4px';
  if (index === total - 1) return '2px 4px 4px 2px';
  return '2px';
}

/**
 * The four numbers as one bar: segments in proportion, separated by 2px of the surface behind them
 * rather than by a stroke, rounded 4px at the two outer ends only.
 *
 * An empty bucket is DROPPED rather than drawn as a hairline: a sliver of colour for zero is a
 * value the reader cannot help but see, and this card's whole subject is a zero. A bucket that is
 * NOT empty keeps a 3px floor for the opposite reason — at the projects list's 196px the running
 * task in a 1-of-118 project rounds to under two pixels, and work in flight that renders as
 * nothing is the same lie the other way round.
 *
 * The bar carries no shape channel, so `role="img"` plus every number in the label is what makes
 * it readable at all without colour — including the buckets that have no segment.
 *
 * Exported because the projects list draws the same four buckets in the same order from the same
 * table, differing only in how tall the bar is: two implementations of this would be two answers
 * to "is this project blocked?", and the list is where that question gets asked first.
 */
export function BucketMeter({
  buckets,
  height = 9,
}: {
  buckets: ProjectPanoramaBuckets;
  height?: number;
}) {
  const drawn = PANORAMA_BUCKETS.map((bucket) => ({ ...bucket, value: buckets[bucket.key] })).filter(
    (segment) => segment.value > 0,
  );
  const label = `Task status: ${PANORAMA_BUCKETS.map(
    (bucket) => `${buckets[bucket.key]} ${bucket.label.toLowerCase()}`,
  ).join(', ')}`;

  return (
    <div role="img" aria-label={label} style={{ display: 'flex', gap: 2, height }}>
      {drawn.length === 0 ? (
        // Every bucket is zero: an empty track, so the bar reads as "no work" rather than as a
        // rendering failure.
        <span style={{ flex: 1, background: 'var(--fill-muted)', borderRadius: 4 }} />
      ) : (
        drawn.map((segment, index) => (
          <span
            key={segment.key}
            title={`${segment.label} ${segment.value}`}
            style={{
              flex: segment.value,
              minWidth: 3,
              background: segment.color,
              borderRadius: segmentRadius(index, drawn.length),
            }}
          />
        ))
      )}
    </div>
  );
}

/** The refusal breakdown, most-refused first — the top three, and an honest count of the rest. */
export function topRefusals(refusals: unknown, limit = 3): DispatchRefusal[] {
  return Array.isArray(refusals) ? refusals.slice(0, limit) : [];
}

/** What the dispatch ledger says about the window, as one sentence. Absent when it could not be read
 *  — an unreadable ledger must not be reported as "nothing was refused". */
function dispatchSentence(health: DispatchHealth): string {
  const { applied, refused } = health.dispatch;
  if (refused > 0) {
    return ` The coordinator refused ${refused} of ${applied + refused} dispatch attempts in the last ${health.windowHours}h.`;
  }
  if (applied > 0) {
    return ` The coordinator applied ${applied} dispatch attempts in the last ${health.windowHours}h and refused none.`;
  }
  return ` The coordinator has not attempted a dispatch in the last ${health.windowHours}h.`;
}

/**
 * Ready work, nothing running, and the ledger's account of why.
 *
 * The banner is driven by the BUCKETS alone: the dispatch health read explains the stall, it does
 * not decide there is one. So a failed or still-loading explanation degrades to a stated absence
 * rather than hiding the banner — the stall is a fact of the first read, and suppressing it because
 * the second read failed is how a stalled project comes to look idle.
 */
function StalledBanner({
  buckets,
  health,
  healthError,
}: {
  buckets: ProjectPanoramaBuckets;
  health: DispatchHealth | undefined;
  healthError: boolean;
}) {
  const refusals = health?.refusals;
  const top = topRefusals(refusals);
  const rest = Array.isArray(refusals) ? refusals.length - top.length : 0;

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        marginTop: 16,
        padding: '13px 15px',
        background: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        borderRadius: 8,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1.35, color: 'var(--warning)' }}>
        ▲
      </span>
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.65 }}>
        <b>
          {buckets.ready} task{buckets.ready === 1 ? '' : 's'} ready, {buckets.running} running.
        </b>
        {health ? dispatchSentence(health) : null}
        <div style={{ color: 'var(--text-2)', marginTop: 3 }}>
          {healthError ? (
            'Why is not readable: the dispatch health read failed.'
          ) : !health ? (
            'Reading the dispatch ledger…'
          ) : top.length === 0 ? (
            'No dispatch was refused in the window, so nothing here explains the stall.'
          ) : (
            <>
              {top.map((refusal, index) => (
                <span key={refusal.refusalCode}>
                  {index > 0 ? ' · ' : null}
                  {refusal.count}× <code>{refusal.refusalCode}</code>
                </span>
              ))}
              {rest > 0 ? ` · ${rest} more code${rest === 1 ? '' : 's'}` : null}
              {health.dispatch.applied > 0 ? ` — ${health.dispatch.applied} applied.` : null}
            </>
          )}
        </div>
      </div>
      {/* The one action this card can name. It does not guess a destination per refusal code: the
          codes are printed right above, and the providers page is where the refusal that dominates
          them (PROVIDER_UNAVAILABLE) is actually resolved. */}
      <Link to="/providers">
        <Button type="primary" size="small">
          Check providers
        </Button>
      </Link>
    </div>
  );
}

/** The card chrome, so the loading, error and loaded states are the same block on the page rather
 *  than three differently-sized ones. */
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
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Where the work stands
        </Typography.Title>
        {hint ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function ProjectPanoramaHeader({ projectId }: { projectId: string }) {
  const panorama = useQuery({ ...projectPanoramaQuery(projectId), enabled: Boolean(projectId) });
  const buckets = panorama.data?.buckets;
  const stalled = buckets ? stalledOnReady(buckets) : false;
  // Only fetched when there is a stall to explain — the banner is the only reader of it, and a
  // project whose queue is being served has nothing to look up.
  const health = useQuery({
    ...projectDispatchHealthQuery(projectId),
    enabled: Boolean(projectId) && stalled,
  });

  // `isPending`, not `isLoading`: a first render that has not dispatched its fetch yet (which is
  // every static render, and the first paint of a live one) is pending with `fetchStatus: 'idle'`,
  // and `isLoading` is false there — reading it would drop this card straight to its error state
  // while the request it is waiting for has not even been made.
  if (panorama.isPending) {
    return (
      <Card>
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (panorama.isError || !panorama.data) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="Project panorama could not be loaded"
          description={panorama.error instanceof Error ? panorama.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => panorama.refetch()}>
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  const { shape } = panorama.data;
  const loaded = panorama.data.buckets;
  const footnotes: Record<BucketKey, string> = {
    running: 'dispatched, session live',
    ready: 'unblocked, not dispatched',
    blocked: 'waiting on prerequisites',
    done:
      shape.taskCount > 0
        ? `${Math.round((loaded.done / shape.taskCount) * 100)}% of ${shape.taskCount}`
        : 'no tasks yet',
  };

  return (
    <Card
      hint={`${shape.taskCount} task${shape.taskCount === 1 ? '' : 's'} · ${shape.edgeCount} dependency edge${
        shape.edgeCount === 1 ? '' : 's'
      }`}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 2,
          background: 'var(--border-subtle)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {PANORAMA_BUCKETS.map((bucket) => (
          <Kpi
            key={bucket.key}
            label={bucket.label}
            value={loaded[bucket.key]}
            footnote={footnotes[bucket.key]}
            glyph={bucket.glyph}
            color={bucket.color}
            // The one cell that changes colour, and only in the state this card is about: ready
            // work with nothing serving it. The amber is a second reading of the banner below, not
            // the thing that says it.
            attention={bucket.key === 'ready' && stalled}
          />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <BucketMeter buckets={loaded} />
      </div>

      {stalled ? (
        <StalledBanner buckets={loaded} health={health.data} healthError={health.isError} />
      ) : null}
    </Card>
  );
}
