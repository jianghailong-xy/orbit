import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { ProjectIntegrationView } from '@orbit/shared';
import { api } from '../api';
import { projectIntegrationQuery } from '../lib/queries';

/**
 * Where a project's work stands, and — when none of it is moving — why (the header card of the
 * project page).
 *
 * Three parts, in one card because they answer one question between them:
 *
 *  1. **Exhaustive work lanes.** Running / Ready / Blocked / Awaiting verification / Done /
 *     Failed / Cancelled. Ready means the server's task_start predicate accepts the row; the
 *     explicit terminal lanes keep every task in the denominator.
 *  2. **A stacked meter.** The same lanes as one 9px bar, so the proportion is readable without
 *     doing arithmetic on seven figures.
 *  3. **A stalled banner.** Rendered only when `ready > 0 && running === 0` — work that could
 *     start and nothing starting it — carrying the dispatch ledger's own account of why.
 *
 * `Running` counts a task with a LIVE SESSION on it, not one whose row says IN_PROGRESS: dispatch
 * never writes that column (see `project-panorama.ts`). Which is what the cell's own footnote has
 * always claimed, and is what keeps the banner below from calling a project with three agents
 * working on it stalled.
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
  /** Optional only for one rolling-deploy window; the current server always reports it. */
  awaitingVerification?: number;
  done: number;
  /** Optional only for one rolling-deploy window; older servers hid FAILED in the remainder. */
  failed?: number;
  /** A distinct terminal decision, kept visible so every task reconciles with the total. */
  cancelled: number;
  /**
   * The three lanes `done` splits across once this project has an integration line, plus the two
   * numbers that make the split readable (contract §7.2 V6).
   *
   * Optional AS A SET, and read as one: a project with no line — and any server from before there
   * were lines — reports none of them, and the card draws the single Done lane it always drew.
   * Reading an absent `integrating` as 0 would instead claim that nothing is in flight, which is
   * a different sentence from "this project does not integrate".
   */
  integrating?: number;
  onIntegrationLine?: number;
  onUpstream?: number;
  doneNotIntegrated?: number;
  waitingForLanding?: number;
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

/** The shapes, in the order they are drawn. Names describe the mark, not the status it stands for. */
export type BucketGlyph =
  | 'disc'
  | 'triangle'
  | 'square'
  | 'hourglass'
  | 'check'
  | 'cross'
  | 'slash'
  // Two more for the lanes `done` splits into: work the platform still has in hand, and work
  // that reached the project's own branch but not main.
  | 'spinner'
  | 'branch';

/** The seven lanes EVERY project reports, integration line or not. Spelled out rather than
 *  `keyof ProjectPanoramaBuckets`, which now also covers the integration lanes: those are an
 *  alternative set of cells, not extra members of this one, and the table below is what the
 *  projects list draws its meter from. */
type BucketKey =
  | 'running' | 'ready' | 'blocked' | 'awaitingVerification' | 'done' | 'failed' | 'cancelled';

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
  { key: 'blocked', label: 'Waiting', glyph: 'square', color: 'var(--text-3)' },
  {
    key: 'awaitingVerification',
    label: 'Awaiting verification',
    glyph: 'hourglass',
    color: 'var(--brand)',
  },
  { key: 'done', label: 'Done', glyph: 'check', color: 'var(--success)' },
  { key: 'failed', label: 'Failed', glyph: 'cross', color: 'var(--error)' },
  { key: 'cancelled', label: 'Cancelled', glyph: 'slash', color: 'var(--text-4)' },
];

/**
 * Whether this project's work is being INTEGRATED, which is what decides the shape of this card
 * (§7.2 V6).
 *
 * The question is answered by the payload, not by the project: a server that reports the three
 * lanes has an integration line and has classified every finished task against it; one that does
 * not is either older than the line or looking at a project that has none. Either way the card
 * draws the single Done lane, which is the thing it can honestly say.
 */
export function reportsIntegrationLanes(buckets: ProjectPanoramaBuckets): boolean {
  return buckets.integrating !== undefined
    && buckets.onIntegrationLine !== undefined
    && buckets.onUpstream !== undefined;
}

/**
 * The cells this card draws, in reading order, for a project that integrates (§7.2 V6's table).
 *
 * `Done` is replaced rather than joined: the three lanes sum to it, and a card showing both would
 * invite a reader to add 28 and 28. The lanes that are NOT part of that sum — work that never had
 * anything to land, failures, cancellations, verification — appear only when they are non-zero,
 * because a project page carrying four permanent zeroes is a page where a one stops being visible.
 *
 * `On project branch` is dropped on a `MAIN` line rather than shown as a zero: a project landing
 * straight into main has no branch for work to be stranded on, and a lane saying "0 stranded"
 * answers a question nobody asked.
 */
export function integrationLanes(
  buckets: ProjectPanoramaBuckets,
  line: 'MAIN' | 'PROJECT_BRANCH' | null,
): ReadonlyArray<{ key: string; label: string; value: number; footnote: string; glyph: BucketGlyph; color: string }> {
  const at = (value: number | undefined) => value ?? 0;
  const lanes = [
    { key: 'running', label: 'Running', value: buckets.running, footnote: 'active sessions',
      glyph: 'disc' as BucketGlyph, color: 'var(--brand)' },
    { key: 'ready', label: 'Ready', value: buckets.ready, footnote: 'can start now',
      glyph: 'triangle' as BucketGlyph, color: 'var(--warning-solid)' },
    { key: 'blocked', label: 'Waiting', value: buckets.blocked,
      // What it is waiting FOR, once a landing is the thing holding it: nobody has to act on that
      // one, so a reader who sees this footnote can stop looking for somebody to chase.
      footnote: at(buckets.waitingForLanding) > 0 ? 'for a prerequisite to land' : 'waiting on dependencies',
      glyph: 'square' as BucketGlyph, color: 'var(--text-3)' },
    { key: 'integrating', label: 'Integrating', value: at(buckets.integrating),
      footnote: 'checks running on the combined tree',
      glyph: 'spinner' as BucketGlyph, color: 'var(--brand)' },
    ...(line === 'MAIN' ? [] : [{
      key: 'onIntegrationLine', label: 'On project branch', value: at(buckets.onIntegrationLine),
      footnote: 'not on main yet', glyph: 'branch' as BucketGlyph, color: 'var(--success)',
    }]),
    // The two greens are deliberately different, and the meter is why: these lanes are adjacent
    // segments on one bar, and two touching blocks of the same colour read as a single larger
    // block — which is exactly the reading this split exists to break up. `--success-solid` is the
    // brighter of the pair, so main is the one that stands out.
    { key: 'onUpstream', label: 'On main', value: at(buckets.onUpstream), footnote: 'landed on main',
      glyph: 'check' as BucketGlyph, color: 'var(--success-solid)' },
  ];
  const extras = [
    { key: 'doneNotIntegrated', label: 'Done', value: at(buckets.doneNotIntegrated),
      footnote: 'nothing to land', glyph: 'check' as BucketGlyph, color: 'var(--success)' },
    { key: 'awaitingVerification', label: 'Awaiting verification', value: at(buckets.awaitingVerification),
      footnote: 'verifier must conclude', glyph: 'hourglass' as BucketGlyph, color: 'var(--brand)' },
    { key: 'failed', label: 'Failed', value: at(buckets.failed), footnote: 'coordinated continuation',
      glyph: 'cross' as BucketGlyph, color: 'var(--error)' },
    { key: 'cancelled', label: 'Cancelled', value: buckets.cancelled,
      footnote: 'closed without completion', glyph: 'slash' as BucketGlyph, color: 'var(--text-4)' },
  ].filter((lane) => lane.value > 0);
  return [...lanes, ...extras];
}

/** Rolling compatibility without letting an absent new field become NaN in a meter. */
export function panoramaBucketValue(buckets: ProjectPanoramaBuckets, key: BucketKey): number {
  return buckets[key] ?? 0;
}

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

/**
 * The landing in flight, in the words the card's live line uses — the one row that says what the
 * platform itself is doing while a project's numbers stand still.
 *
 * The card needed it because its own counts cannot say it: a landing holds no task session, so
 * `Running` is 0 through the four minutes it takes, and the only non-zero cell is `Integrating`
 * whose footnote is a term of art. The owner read exactly that page on 2026-09-25 and concluded the
 * project had stopped.
 */
export interface LandingLine {
  /** The task being landed, `N jobs` when more than one is in flight, or null when the job names no
   *  single task (a promotion, a merge check) — the row then draws its word and state alone. */
  what: string | null;
  /** Whether the combined-tree checks are running, as opposed to the job still waiting its turn.
   *  What the ring's spin and the two brand-blue words are drawn from; the `state` word is what
   *  carries the same fact to a reader who cannot use motion. */
  running: boolean;
  /** "checking" or "queued". */
  state: string;
  /** "1m 20s". See `landingClock`. */
  clock: string;
}

/** The row's first word, and the whole of what the line is about. */
export const LANDING_WORD = 'Landing';

/**
 * "1m 20s" — the landing clock, minutes and seconds ALWAYS, at every length.
 *
 * Not `formatSpan`, deliberately, and the difference is the point: that one rounds to the largest
 * unit it needs, so a landing two minutes in reads "2m" and then "2m" again a minute later. This
 * number is watched while it moves — it is what says the four minutes are passing rather than
 * stalled — so the seconds are the part that has to be there. Minutes are not folded into hours
 * either: a wait is read here in the unit it started in, and "65m 0s" says "over an hour" as
 * honestly as "1h 5m" does.
 */
export function landingClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/**
 * The line, or null when nothing is landing — which is what removes the row from the card.
 *
 * `inFlight` is the server's answer to "is anything in flight", so the whole row is drawn from it
 * rather than from the two counts: the counts and the job they count are read together, and a row
 * that appeared on a count while having no job to describe would have to invent one.
 *
 * The name slot takes the job's task, or the COUNT when there is more than one: "Landing 2 jobs"
 * says what a single task's title would have pretended to — that this is the oldest of several, not
 * the only thing the queue is doing.
 */
export function landingLine(view: ProjectIntegrationView, now: number): LandingLine | null {
  const inFlight = view.inFlight;
  if (!inFlight) return null;
  const running = inFlight.state === 'RUNNING';
  const jobs = view.integratingCount + view.queuedCount;
  const startedAt = Date.parse(inFlight.startedAt);
  return {
    what: jobs > 1 ? `${jobs} jobs` : inFlight.taskTitle,
    running,
    state: running ? 'checking' : 'queued',
    // An instant this clock cannot read is no elapsed time rather than `NaN` on the page: the row
    // stays up and counts from zero, which is the one thing it can still say truthfully.
    clock: landingClock(Number.isFinite(startedAt) ? now - startedAt : 0),
  };
}

/**
 * The live line itself: a ring, what is being landed, which half of the wait it is in, and how long
 * it has been there.
 *
 * The ring SPINS while the checks run and stands still while the job is queued, and its colour
 * follows the same two states — but neither is the only channel: `checking` and `queued` are the
 * words, and `prefers-reduced-motion` takes the spin away without touching them.
 */
function LandingRow({ line }: { line: LandingLine }) {
  return (
    <div className={line.running ? 'project-landing project-landing-running' : 'project-landing'}>
      <span className="project-landing-ring">
        <Glyph shape="spinner" color="currentColor" size={13} />
      </span>
      <span className="project-landing-word">{LANDING_WORD}</span>
      {/* Always drawn, even empty: it is the row's flexible middle, and the one that keeps the state
          and the clock against the right edge whether or not the job has a name. */}
      <span className="project-landing-what">{line.what}</span>
      <span className="project-landing-state">{line.state}</span>
      <span className="project-landing-clock">{line.clock}</span>
    </div>
  );
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
      ) : shape === 'hourglass' ? (
        <path d="M2 1.5 H10 M2 10.5 H10 M3 2 C3 4 5 4.6 6 6 C7 4.6 9 4 9 2 M3 10 C3 8 5 7.4 6 6 C7 7.4 9 8 9 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : shape === 'cross' ? (
        <path d="M2.2 2.2 L9.8 9.8 M9.8 2.2 L2.2 9.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : shape === 'slash' ? (
        <path d="M2 10 L10 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : shape === 'spinner' ? (
        // An open ring with an arrowhead: work in hand, drawn so it is not a second filled disc.
        <path
          d="M10.5 6 A4.5 4.5 0 1 1 6 1.5 M6 1.5 L4 3.4 M6 1.5 L8 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : shape === 'branch' ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="3" cy="2.6" r="1.2" />
          <circle cx="3" cy="9.4" r="1.2" />
          <circle cx="9" cy="4.1" r="1.2" />
          <path d="M3 3.8v4.4M9 5.3c0 2.2-2.2 2.4-4.8 3.4" strokeLinecap="round" />
        </g>
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
        padding: '14px 15px 15px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12.5,
          color: 'var(--text-2)',
          marginBottom: 3,
          whiteSpace: 'nowrap',
        }}
      >
        <Glyph shape={glyph} color={color} />
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 650, letterSpacing: '-0.025em', lineHeight: 1.12, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-4)', marginTop: 2 }}>{footnote}</div>
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
 * Exported because the projects list draws the same buckets in the same order from the same
 * table, differing only in how tall the bar is: two implementations of this would be two answers
 * to "is this project blocked?", and the list is where that question gets asked first.
 */
export function BucketMeter({
  buckets,
  height = 9,
  segments,
}: {
  buckets: ProjectPanoramaBuckets;
  height?: number;
  /** The lanes to draw, when they are not the seven above: a project that integrates splits its
   *  done count three ways, and a bar that kept drawing one green block would disagree with the
   *  cells directly over it. Same proportions either way — this only changes what the blocks are. */
  segments?: ReadonlyArray<{ key: string; label: string; value: number; color: string }>;
}) {
  const table = segments ?? PANORAMA_BUCKETS.map((bucket) => ({
    key: bucket.key as string,
    label: bucket.label,
    color: bucket.color,
    value: panoramaBucketValue(buckets, bucket.key),
  }));
  const drawn = table.filter((segment) => segment.value > 0);
  const label = `Task status: ${table
    .map((segment) => `${segment.value} ${segment.label.toLowerCase()}`)
    .join(', ')}`;

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


/** Ready work exists and nothing is picking it up. This is deliberately a compact secondary
 *  action: when the coordinator also needs a reply, that conversation remains the page's primary
 *  CTA instead of competing with a second large blue button. */
function StalledBanner({ buckets }: { buckets: ProjectPanoramaBuckets }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 12px',
        alignItems: 'flex-start',
        marginTop: 16,
        padding: '12px 14px',
        background: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        borderRadius: 8,
      }}
    >
      <span style={{ paddingTop: 3 }}>
        <Glyph shape="triangle" color="var(--warning-solid)" size={11} />
      </span>
      <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13, lineHeight: 1.55 }}>
        <b style={{ color: 'var(--text-1)' }}>Dispatch needs attention</b>
        <div style={{ color: 'var(--text-2)', marginTop: 2 }}>
          {buckets.ready} task{buckets.ready === 1 ? ' is' : 's are'} ready, but nothing is running.
          {' '}Check the assignees&apos; runner and provider.
        </div>
      </div>
      <Link to="/providers">
        <Button size="small">
          Check providers
        </Button>
      </Link>
    </div>
  );
}

/** Every task has settled but the goal-level project status has not. This is a legitimate
 *  wrapping-up state, not a contradiction between the blue OPEN tag and a full green meter, so
 *  the detail page says the missing sentence explicitly. */
function WrappingUpBanner({ settled }: { settled: number }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        marginTop: 16,
        padding: '12px 14px',
        background: 'var(--brand-tint)',
        border: '1px solid var(--brand-border)',
        borderRadius: 8,
      }}
    >
      <span style={{ paddingTop: 3 }}>
        <Glyph shape="check" color="var(--brand)" size={12} />
      </span>
      <div style={{ minWidth: 0, fontSize: 13, lineHeight: 1.55 }}>
        <b style={{ color: 'var(--text-1)' }}>Ready to wrap up</b>
        <div style={{ color: 'var(--text-2)', marginTop: 2 }}>
          All {settled} task{settled === 1 ? ' is' : 's are'} settled. The project stays open until
          its outcome is confirmed.
        </div>
      </div>
    </div>
  );
}

/** The card chrome, so the loading, error and loaded states are the same block on the page rather
 *  than three differently-sized ones. */
function Card({ hint, children }: { hint?: string; children: ReactNode }) {
  return (
    <section
      className="project-work-overview"
      aria-label="Work overview"
      data-project-block="work-overview"
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        padding: '18px 20px',
        height: '100%',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Work overview
        </Typography.Title>
        {hint ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function ProjectPanoramaHeader({
  projectId,
  projectStatus,
  integrationLine,
}: {
  projectId: string;
  /** Goal-level status. Task completion does not close a project, so this is what lets the card
   *  identify the useful in-between state: every task settled, project still open. */
  projectStatus?: 'OPEN' | 'DONE' | 'CANCELLED';
  /** Which line this project lands on, so the `On project branch` lane is dropped for a project
   *  that has no branch to strand work on. Handed in rather than read again: the integration row
   *  above this card already holds it, and a second read for one boolean is a second request. */
  integrationLine?: 'MAIN' | 'PROJECT_BRANCH' | null;
}) {
  const panorama = useQuery({ ...projectPanoramaQuery(projectId), enabled: Boolean(projectId) });

  // The landing the line below reports on, from the same read the page's own integration row makes
  // — one query key, so the card mounting this is not a second request. It is read here rather than
  // handed in because the row is drawn inside this card, and a card that only knew there was a line
  // (the `integrationLine` prop) could not say what the line is doing.
  const integration = useQuery({ ...projectIntegrationQuery(projectId), enabled: Boolean(projectId) });
  const inFlight = integration.data?.inFlight ?? null;
  // The clock counts in SECONDS while something is landing, rather than stepping with the 30s poll
  // above: a number that jumped half a minute at a time would read as the stalled page this row
  // exists to disprove. The interval runs only while there is something to count.
  const counting = inFlight !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

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

  return (
    <ProjectPanoramaCard
      panorama={panorama.data}
      projectStatus={projectStatus}
      integrationLine={integrationLine}
      landing={integration.data ? landingLine(integration.data, now) : null}
    />
  );
}

/**
 * The card itself, drawn from a panorama already in hand — the header above once its read answers,
 * and a public project page from the panorama its link carries. `banners: false` leaves out the two
 * banners, which speak to the project's owner: "Dispatch needs attention" sends them to their
 * providers, and "Ready to wrap up" asks them to confirm the outcome (docs/share-links-design.md §7).
 */
export function ProjectPanoramaCard({
  panorama,
  projectStatus,
  integrationLine,
  banners = true,
  landing = null,
}: {
  panorama: ProjectPanorama;
  projectStatus?: 'OPEN' | 'DONE' | 'CANCELLED';
  integrationLine?: 'MAIN' | 'PROJECT_BRANCH' | null;
  banners?: boolean;
  /** The landing in flight, from the header's own integration read. A public project page has no
   *  such read, so it draws the card without the row. */
  landing?: LandingLine | null;
}) {
  const { shape } = panorama;
  const loaded = panorama.buckets;
  const stalled = stalledOnReady(loaded);
  const lanes = reportsIntegrationLanes(loaded)
    ? integrationLanes(loaded, integrationLine ?? null)
    : null;
  const awaitingVerification = loaded.awaitingVerification ?? 0;
  const failed = loaded.failed ?? 0;
  const settled = loaded.done + loaded.cancelled;
  const wrappingUp =
    projectStatus === 'OPEN'
    && loaded.running === 0
    && loaded.ready === 0
    && loaded.blocked === 0
    && awaitingVerification === 0
    && failed === 0
    && settled > 0;
  const footnotes: Record<BucketKey, string> = {
    running: 'active sessions',
    ready: 'can start now',
    blocked: 'waiting on dependencies',
    awaitingVerification: 'verifier must conclude',
    done:
      shape.taskCount > 0
        ? `${Math.round((loaded.done / shape.taskCount) * 100)}% complete`
        : 'no tasks yet',
    failed: 'coordinated continuation',
    cancelled: 'closed without completion',
  };

  return (
    <Card
      hint={`${shape.taskCount} task${shape.taskCount === 1 ? '' : 's'} · ${shape.edgeCount} dependenc${
        shape.edgeCount === 1 ? 'y' : 'ies'
      }`}
    >
      {/* Above the cells, because it is the card's one moving part: what the platform is doing with
          work that is already done, while every count over it stands still. It draws nothing at all
          when nothing is landing — an empty state here would be a permanent "0 jobs" row. */}
      {landing ? (
        <div style={{ marginBottom: 12 }}>
          <LandingRow line={landing} />
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          // Three across when the done count is split three ways, which is what makes the six
          // lanes two full rows rather than four and a gap — the grid's own background shows
          // through an unfilled slot, and a grey rectangle beside "On main" reads as a cell that
          // failed to render. `auto-fit` everywhere else, unchanged.
          gridTemplateColumns: lanes
            ? 'repeat(3, minmax(0, 1fr))'
            : 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 2,
          background: 'var(--border-subtle)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {(lanes
          ?? PANORAMA_BUCKETS.map((bucket) => ({
            key: bucket.key as string,
            label: bucket.label,
            value: panoramaBucketValue(loaded, bucket.key),
            footnote: footnotes[bucket.key],
            glyph: bucket.glyph,
            color: bucket.color,
          }))
        ).map((lane) => (
          <Kpi
            key={lane.key}
            label={lane.label}
            value={lane.value}
            footnote={lane.footnote}
            glyph={lane.glyph}
            color={lane.color}
            // The one cell that changes colour, and only in the state this card is about: ready
            // work with nothing serving it. The amber is a second reading of the banner below, not
            // the thing that says it.
            attention={banners && lane.key === 'ready' && stalled}
          />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <BucketMeter buckets={loaded} segments={lanes ?? undefined} />
      </div>

      {banners && stalled ? (
        <StalledBanner buckets={loaded} />
      ) : null}

      {banners && wrappingUp ? <WrappingUpBanner settled={settled} /> : null}
    </Card>
  );
}
