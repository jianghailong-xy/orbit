import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import {
  INTEGRATION_CLAIM_STALE_MS,
  type IntegrationJobPhase,
  type ProjectIntegrationJob,
  type ProjectIntegrationView,
  type ProjectManualReady,
} from '@orbit/shared';
import { api } from '../api';
import { projectIntegrationQuery, projectReadyToRunQuery } from '../lib/queries';
import { LandingJobsSheet } from './LandingJobsSheet';
import { ProjectTaskLink } from './ProjectTaskLink';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import './ui/Typography.css';

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
 *  3. **Manual work to start.** The run queue names tasks with no automatic dispatch or schedule.
 *     Ready/running totals alone cannot diagnose a dispatch failure.
 *
 * `Running` counts task work in progress: a live session or an IN_PROGRESS task row. Landing jobs
 * are reported separately, and neither number diagnoses whether dispatch needs attention.
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
 * fifth hue. Ready is also neutral in this card: readiness is not an error. The meter, which has
 * no room for a shape, carries the numbers in its `aria-label`.
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
  | 'branch'
  // And the landing row's mark for a job whose runner went quiet past its limit — no bucket's.
  | 'exclamation';

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
    { key: 'running', label: 'Running', value: buckets.running, footnote: 'task work in progress',
      glyph: 'disc' as BucketGlyph, color: 'var(--brand)' },
    { key: 'ready', label: 'Ready', value: buckets.ready, footnote: 'can start now',
      glyph: 'triangle' as BucketGlyph, color: 'var(--text-3)' },
    { key: 'blocked', label: 'Waiting', value: buckets.blocked,
      footnote: at(buckets.waitingForLanding) > 0
        ? `${buckets.waitingForLanding} waiting for a prerequisite to land`
        : 'waiting on dependencies',
      glyph: 'square' as BucketGlyph, color: 'var(--text-3)' },
    { key: 'integrating', label: 'Pending landing', value: at(buckets.integrating),
      footnote: 'no landing receipt yet',
      glyph: 'hourglass' as BucketGlyph, color: 'var(--text-3)' },
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
 * What Ready's footnote says on a project nobody has started (mock board3 ②): its ready tasks start
 * when the owner starts the project and not before, so "can start now" would be the one untrue
 * thing about them.
 */
export const READY_UNTIL_STARTED = 'starts when you start';

/** A paused project intentionally leaves ready work undispatched. */
export const READY_WHILE_PAUSED = 'project is paused';

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
  word: string;
  /** The task being landed, `N jobs` (and how many of them timed out) when more than one is in
   *  flight, or null when the job names no single task (a promotion, a merge check) — the row then
   *  draws its word and state alone. */
  what: string | null;
  /** Whether the job is running, as opposed to still waiting its turn.
   *  What the ring's spin and the two brand-blue words are drawn from; the `state` word is what
   *  carries the same fact to a reader who cannot use motion. */
  running: boolean;
  /** Whether the server judged the job timed out: its runner said nothing for longer than the
   *  step's limit. Drawn as a still warning mark in amber instead of the ring; "Timed out" is the
   *  word that says it without colour. */
  timedOut: boolean;
  /** The runner's current phase, "queued", or "Timed out". */
  state: string;
  /** "1m 20s" (see `landingClock`), or "110m" without a report on a timed-out job. */
  clock: string;
  clockLabel: string;
  /** How fresh the line is, or the limit a timed-out job ran over ("limit 10m"). */
  updated: string | null;
  /** "2m 24s" — what the job waited for a runner before it was claimed, or null when it never
   *  waited, the read does not say, or it has not been claimed at all (a queued job's whole clock
   *  is that wait, said by `clockLabel`). */
  wait: string | null;
}

export const JOB_WORDS = {
  LAND_TASK: 'Landing',
  CHECK_PROMOTION: 'Merge check',
  LAND_PROMOTION: 'Merge to main',
};

/**
 * The state word for a job whose runner has stopped reporting.
 *
 * A fact about the REPORTS and nothing else: the runner is silent, which is not the same claim as
 * "this job is broken", and emphatically not the same claim as "this job timed out" — a timeout is
 * the job's own verdict, and only the server's `blockingReason` ever words one.
 */
export const LANDING_NO_REPORT = 'No report';
/** The same fact with its age, for the row's right-hand slot: `No report for 11m`. */
export const landingNoReportFor = (minutes: number): string => `No report for ${minutes}m`;
/** And for a job claimed whose runner has never reported at all — the report that never came. */
export const LANDING_NO_REPORT_YET = 'No report yet';

export const JOB_PHASES = {
  FETCH: 'fetching',
  MAIN_SYNC: 'syncing main',
  REBASE: 'rebasing',
  MERGE: 'merging',
  CHECK: 'checking',
  VERIFY: 'verifying',
  PUSH: 'pushing',
};

export const LANDING_WORDS = {
  TIMED_OUT: 'Timed out',
  NO_REPORT_FOR: 'No report for',
  RETRY: 'Retry',
  RETRY_FAILED: 'Retry failed',
  NO_PUSH_RECORDED: 'no push recorded',
  MAY_HAVE_BEEN_PUSHED: 'may have been pushed',
  RETRIED_BY_OWNER: 'retried by you',
  RETRIED_BY_COORDINATOR: 'retried by the coordinator',
};

/** "2 jobs · 1 timed out" — the row's name slot while several jobs are in flight; "2 jobs" when none timed out. */
export function landingJobsCount(jobs: number, timedOut: number): string {
  return timedOut > 0 ? `${jobs} jobs · ${timedOut} timed out` : `${jobs} jobs`;
}

/** "limit 10m" — how long a timed-out job's step could go without a report, in whole minutes. */
export function landingLimit(seconds: number): string {
  return `limit ${Math.round(seconds / 60)}m`;
}

/** "2 jobs in flight" — the title of the list the landing row opens; "1 job" when there is one. */
export function landingJobsTitle(jobs: number): string {
  return `${jobs} ${jobs === 1 ? 'job' : 'jobs'} in flight`;
}

/** "20:07" — an instant on the reader's own 24-hour clock, or "--:--" for one it cannot read. */
export function landingClockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--:--';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

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
 *
 * A server that lists its jobs (`inFlightJobs`) also judges which of them timed out, and the row
 * takes its word: "Timed out" when the job it describes did, and the count says how many did.
 * "Update unavailable" then means only that this app cannot read the server. A server older than the
 * list leaves the reading of the reports here, from the runner's heartbeat: a claimed job whose
 * runner has gone quiet reads "No report" for as long as it stays quiet — never "timed out", which
 * is the job's own verdict to give and arrives as the server's `blockingReason`.
 */
export function landingLine(
  view: ProjectIntegrationView,
  now: number,
  observation: { updatedAt?: number; failed?: boolean } = {},
): LandingLine | null {
  const inFlight = view.inFlight;
  if (!inFlight) return null;
  const running = inFlight.state === 'RUNNING';
  const jobs = view.integratingCount + view.queuedCount;
  const listed = view.inFlightJobs;
  const lead = listed?.[0];
  const timedOutJobs = listed ? listed.filter((job) => job.timedOut).length : 0;
  const heartbeatAt = Date.parse(inFlight.heartbeatAt ?? '');
  // A claimed job whose runner has gone quiet: no report at all, or none since the claim lease the
  // server itself uses (`INTEGRATION_CLAIM_STALE_MS`). Read only where the server hands over no
  // verdict of its own (a server that does not list its jobs) — one that lists them judges the
  // timeouts, and this row takes that word instead. Even here it is a fact about the REPORTS and
  // never a verdict: "No report", not "timed out", which is the job's own to say.
  const silent = !listed && running
    && (!Number.isFinite(heartbeatAt) || now - heartbeatAt > INTEGRATION_CLAIM_STALE_MS);
  const unavailable = unreadable(now, observation);
  const named = {
    word: inFlight.kind ? JOB_WORDS[inFlight.kind] ?? 'Integration' : 'Integration',
    what: jobs > 1 ? landingJobsCount(jobs, timedOutJobs) : inFlight.taskTitle,
  };
  // What the job waited for a runner before it was claimed — the row's own `inFlight` carries it,
  // and only a CLAIMED job has one to show: a queued job's whole clock already is that wait.
  const waitMs = running ? inFlight.waitMs : null;
  if (!unavailable && lead?.timedOut) return { ...named, ...timedOutLine(lead, now, waitMs) };
  return { ...named, ...liveLine(inFlight, now, observation, unavailable, silent, waitMs) };
}

/** Whether this app has lost the server: its last read failed, or is more than 90 s old. */
function unreadable(now: number, observation: { updatedAt?: number; failed?: boolean }): boolean {
  const readStale = observation.updatedAt !== undefined && now - observation.updatedAt > 90_000;
  return observation.failed === true || readStale;
}

/** A running or queued job's half of a line: its state, its clock and how fresh the line is —
 *  frozen at the last word anyone had when `unavailable`, and at the last report when `silent`
 *  (the same freeze, reached from the runner's silence rather than this app's read). */
function liveLine(
  job: { state: 'RUNNING' | 'QUEUED'; phase?: IntegrationJobPhase | null; startedAt: string; heartbeatAt?: string | null },
  now: number,
  observation: { updatedAt?: number },
  unavailable: boolean,
  silent: boolean,
  waitMs?: number | null,
): Omit<LandingLine, 'word' | 'what'> {
  const running = job.state === 'RUNNING';
  const startedAt = Date.parse(job.startedAt);
  const heartbeatAt = Date.parse(job.heartbeatAt ?? '');
  const reported = Number.isFinite(heartbeatAt);
  // What this row has evidence for. A read that failed or went stale is evidence only of itself, so
  // the row freezes at that read; a read that worked carries the runner's own last report, which is
  // what the line's freshness follows — a successful refresh does not make a silent job look active.
  const updatedAt = unavailable ? observation.updatedAt : running && reported ? heartbeatAt : observation.updatedAt;
  const elapsedAt = unavailable || silent ? Math.min(now, updatedAt ?? now) : now;
  const age = updatedAt === undefined ? null : Math.max(0, Math.floor((now - updatedAt) / 60_000));
  return {
    running: running && !unavailable && !silent,
    timedOut: false,
    state: unavailable ? 'Update unavailable'
      : silent ? LANDING_NO_REPORT
        : running ? (job.phase ? JOB_PHASES[job.phase] ?? 'running' : 'running') : 'queued',
    // An instant this clock cannot read is no elapsed time rather than `NaN` on the page: the row
    // stays up and counts from zero, which is the one thing it can still say truthfully.
    clock: landingClock(Number.isFinite(startedAt) ? elapsedAt - startedAt : 0),
    clockLabel: running ? 'Elapsed' : 'Queued for',
    // A read that failed or went stale says how old the read is; a read that WORKED says where the
    // reports stand — and a silent job says that rather than putting a false "Updated" on itself.
    updated: silent ? (reported && age !== null ? landingNoReportFor(age) : LANDING_NO_REPORT_YET)
      : age === null ? null : age === 0 ? 'Updated just now' : `Updated ${age}m ago`,
    wait: running && waitMs ? landingClock(waitMs) : null,
  };
}

/** A job the server judged timed out: how long its runner has said nothing — since its last report,
 *  or since the claim when it never made one — and the limit it ran over. */
function timedOutLine(
  job: ProjectIntegrationJob,
  now: number,
  waitMs?: number | null,
): Omit<LandingLine, 'word' | 'what'> {
  const silentSince = Date.parse(job.heartbeatAt ?? job.startedAt);
  return {
    running: false,
    timedOut: true,
    state: LANDING_WORDS.TIMED_OUT,
    clock: Number.isFinite(silentSince) ? `${Math.max(0, Math.floor((now - silentSince) / 60_000))}m` : '0m',
    clockLabel: LANDING_WORDS.NO_REPORT_FOR,
    updated: landingLimit(job.limitSeconds ?? 600),
    wait: waitMs ? landingClock(waitMs) : null,
  };
}

/** One job of the list the landing row opens (`LandingJobsSheet`). */
export interface LandingJobLine {
  jobId: string;
  /** The task it lands, which its row opens; null for a promotion or a merge check. */
  taskId: string | null;
  line: LandingLine;
  /** Where a timed-out job's runner stopped, or which generation a retried job is; null otherwise. */
  detail: string | null;
  /** Whether the owner's Retry takes this job now — the server's answer, not `line.timedOut`. */
  retryable: boolean;
}

/**
 * Every job in flight, one line each, in the server's order — running first, then the queue oldest
 * first — so the first is the job the row outside describes. Empty from a server that does not list
 * them.
 *
 * Each line is drawn as the row draws its own, in the same words: the task's title in the name slot
 * (null for a promotion or a merge check), "Update unavailable" while this app cannot read the
 * server, "Timed out" for a job the server judged so. The detail says what a timed-out job's runner
 * did before it went quiet — who took it, when, where it stopped, and whether a push may already have
 * happened — or which generation a retried job is and who asked for it.
 */
export function landingJobLines(
  view: ProjectIntegrationView,
  now: number,
  observation: { updatedAt?: number; failed?: boolean } = {},
): LandingJobLine[] {
  const unavailable = unreadable(now, observation);
  return (view.inFlightJobs ?? []).map((job) => {
    const named = { word: JOB_WORDS[job.kind] ?? 'Integration', what: job.taskTitle };
    const stoppedAt = job.phase ? JOB_PHASES[job.phase] ?? 'running' : 'running';
    const pushed = job.phase === 'PUSH' || job.phase === 'VERIFY';
    return {
      jobId: job.jobId,
      taskId: job.taskId,
      line: !unavailable && job.timedOut
        ? { ...named, ...timedOutLine(job, now) }
        : { ...named, ...liveLine(job, now, observation, unavailable, false, null) },
      detail: job.timedOut
        ? `${job.runnerName ? `Runner ${job.runnerName}` : 'The runner'} took it at ${landingClockTime(job.startedAt)} · stopped at ${stoppedAt} · ${pushed ? LANDING_WORDS.MAY_HAVE_BEEN_PUSHED : LANDING_WORDS.NO_PUSH_RECORDED}`
        : job.retriedBy
          ? `Generation ${job.generation} · ${job.retriedBy === 'OWNER' ? LANDING_WORDS.RETRIED_BY_OWNER : LANDING_WORDS.RETRIED_BY_COORDINATOR} at ${landingClockTime(job.queuedAt)}`
          : null,
      retryable: job.retryable,
    };
  });
}

/**
 * The live line itself: a ring, what is being landed, which half of the wait it is in, and how long
 * it has been there.
 *
 * The ring SPINS while the job runs and stands still while it is queued, and its colour
 * follows the same two states — but neither is the only channel: `checking` and `queued` are the
 * words, and `prefers-reduced-motion` takes the spin away without touching them. A job the server
 * judged timed out trades the ring for a warning mark that never spins, in amber, and says
 * "Timed out".
 */
export function LandingRow({ line }: { line: LandingLine }) {
  return (
    <div className={line.timedOut ? 'project-landing project-landing-timed-out'
      : line.running ? 'project-landing project-landing-running' : 'project-landing'}>
      <div className="project-landing-heading">
        <span className="project-landing-ring">
          <Glyph shape={line.timedOut ? 'exclamation' : 'spinner'} color="currentColor" size={13} />
        </span>
        <span className="project-landing-word">{line.word}</span>
        <span className="project-landing-state">{line.state}</span>
      </div>
      {line.what ? <div className="project-landing-what">{line.what}</div> : null}
      <div className="project-landing-meta">
        <span>{line.clockLabel} <span className="project-landing-clock">{line.clock}</span></span>
        {/* The other half of "how long is this taking": what it waited for a runner before any of
            the elapsed time began. */}
        {line.wait ? <span>Waited <span className="project-landing-wait">{line.wait}</span></span> : null}
        {line.updated ? <span>{line.updated}</span> : null}
      </div>
    </div>
  );
}

/** The landing row as a press that lists every job in flight (`LandingJobsSheet`): a button, so the
 *  keyboard reaches it, named by the row's own words, with a chevron saying it opens something. */
export function LandingRowButton({ line, onPress }: { line: LandingLine; onPress: () => void }) {
  return (
    <button type="button" className="project-landing-press" aria-haspopup="dialog" onClick={onPress}>
      <LandingRow line={line} />
      <RightOutlined className="project-landing-press-chev" aria-hidden />
    </button>
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
      ) : shape === 'exclamation' ? (
        // A warning triangle: drawn still, so it cannot be read as the spinning ring it replaces.
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 1.2 L10.9 10.6 H1.1 Z" />
          <path d="M6 5 V6.9" />
          <circle cx="6" cy="8.75" r="0.75" fill="currentColor" stroke="none" />
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
}: {
  label: string;
  value: number;
  footnote: string;
  glyph: BucketGlyph;
  color: string;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-raised)',
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


/** Manual dispatch is a choice, not a runner diagnosis. The named task opens over this project. */
function ManualReadyBanner({ manual, projectId }: { manual: ProjectManualReady; projectId: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px 12px',
        alignItems: 'flex-start',
        marginTop: 16,
        padding: '12px 14px',
        background: 'var(--bg-hover)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
      }}
    >
      <span style={{ paddingTop: 3 }}>
        <Glyph shape="triangle" color="var(--text-3)" size={11} />
      </span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.55 }}>
        <b style={{ color: 'var(--text-1)' }}>Ready to start</b>
        <div style={{ color: 'var(--text-2)', marginTop: 2 }}>
          {manual.count} task{manual.count === 1 ? ' is' : 's are'} set to start manually.
        </div>
        <ProjectTaskLink projectId={projectId} taskId={manual.taskId} className="project-manual-task">
          {manual.title}
        </ProjectTaskLink>
        <ProjectTaskLink projectId={projectId} taskId={manual.taskId} className="project-manual-open">
          Open task
        </ProjectTaskLink>
      </div>
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
        <h5 className="orbit-typography" style={{ margin: 0 }}>
          Work overview
        </h5>
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
  started,
  paused = false,
}: {
  projectId: string;
  /** Goal-level status. Task completion does not close a project, so this is what lets the card
   *  identify the useful in-between state: every task settled, project still open. */
  projectStatus?: 'OPEN' | 'DONE' | 'CANCELLED';
  /** Which line this project lands on, so the `On project branch` lane is dropped for a project
   *  that has no branch to strand work on. Handed in rather than read again: the integration row
   *  above this card already holds it, and a second read for one boolean is a second request. */
  integrationLine?: 'MAIN' | 'PROJECT_BRANCH' | null;
  /** Whether the project has been started, from the document the page holds. Only `false` changes
   *  anything: ready work on a project nobody has started is waiting for the start. */
  started?: boolean | null;
  paused?: boolean;
}) {
  const panorama = useQuery({ ...projectPanoramaQuery(projectId), enabled: Boolean(projectId) });

  // The landing the line below reports on, from the same read the page's own integration row makes
  // — one query key, so the card mounting this is not a second request. It is read here rather than
  // handed in because the row is drawn inside this card, and a card that only knew there was a line
  // (the `integrationLine` prop) could not say what the line is doing.
  const integration = useQuery({ ...projectIntegrationQuery(projectId), enabled: Boolean(projectId) });
  const ready = useQuery({ ...projectReadyToRunQuery(projectId), enabled: Boolean(projectId) });
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
  // A server that lists the jobs in flight is one whose row opens that list; an older one has
  // nothing to list, and its row stays a line to read.
  const listed = integration.data?.inFlightJobs !== undefined;
  const [jobsOpen, setJobsOpen] = useState(false);

  // `isPending`, not `isLoading`: a first render that has not dispatched its fetch yet (which is
  // every static render, and the first paint of a live one) is pending with `fetchStatus: 'idle'`,
  // and `isLoading` is false there — reading it would drop this card straight to its error state
  // while the request it is waiting for has not even been made.
  if (panorama.isPending) {
    return (
      <Card>
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spinner aria-busy="true" />
        </div>
      </Card>
    );
  }

  if (panorama.isError || !panorama.data) {
    return (
      <Card>
        <Alert
          type="error"
          title="Project panorama could not be loaded"
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
    <>
      <ProjectPanoramaCard
        panorama={panorama.data}
        projectStatus={projectStatus}
        integrationLine={integrationLine}
        started={started}
        paused={paused}
        projectId={projectId}
        manualReady={ready.isError ? null : ready.data?.manualReady ?? null}
        landing={integration.data ? landingLine(integration.data, now, {
          updatedAt: integration.dataUpdatedAt, failed: integration.isError,
        }) : null}
        onOpenLanding={listed ? () => setJobsOpen(true) : undefined}
      />
      {/* Kept while open even if the row goes, so a list being read does not vanish under the
          reader when its last job lands. */}
      {listed || jobsOpen ? (
        <LandingJobsSheet projectId={projectId} open={jobsOpen} onClose={() => setJobsOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * The card itself, drawn from a panorama already in hand — the header above once its read answers,
 * and a public project page from the panorama its link carries. `banners: false` leaves out the
 * owner's manual-task and wrap-up actions (docs/share-links-design.md §7).
 */
export function ProjectPanoramaCard({
  panorama,
  projectStatus,
  integrationLine,
  banners = true,
  landing = null,
  onOpenLanding,
  started,
  paused = false,
  projectId,
  manualReady = null,
}: {
  panorama: ProjectPanorama;
  projectStatus?: 'OPEN' | 'DONE' | 'CANCELLED';
  integrationLine?: 'MAIN' | 'PROJECT_BRANCH' | null;
  banners?: boolean;
  /** Whether the project has been started; `false` says ready work waits for the start. */
  started?: boolean | null;
  paused?: boolean;
  projectId?: string;
  manualReady?: ProjectManualReady | null;
  /** The landing in flight, from the header's own integration read. A public project page has no
   *  such read, so it draws the card without the row. */
  landing?: LandingLine | null;
  /** Opens the list of every job in flight, given when the server lists them: the row is then a
   *  button. Without it the row is only read. */
  onOpenLanding?: () => void;
}) {
  const { shape } = panorama;
  const loaded = panorama.buckets;
  const notStarted = started === false;
  const manual = !notStarted && !paused && projectStatus !== 'DONE' && projectStatus !== 'CANCELLED'
    && loaded.ready > 0 ? manualReady : null;
  const readyFootnote = notStarted ? READY_UNTIL_STARTED : paused ? READY_WHILE_PAUSED
    : manual?.count === loaded.ready ? 'can start manually' : 'can start now';
  const lanes = reportsIntegrationLanes(loaded)
    ? integrationLanes(loaded, integrationLine ?? null).map((lane) =>
        lane.key === 'ready' ? { ...lane, footnote: readyFootnote } : lane)
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
    && (loaded.integrating ?? 0) === 0
    && (loaded.onIntegrationLine ?? 0) === 0
    && landing === null
    && settled > 0;
  const footnotes: Record<BucketKey, string> = {
    running: 'task work in progress',
    ready: readyFootnote,
    blocked: 'waiting on dependencies',
    awaitingVerification: 'verifier must conclude',
    done:
      shape.taskCount > 0
        ? `${Math.round((loaded.done / shape.taskCount) * 100)}% complete`
        : 'no tasks yet',
    failed: 'coordinated continuation',
    cancelled: 'closed without completion',
  };
  const cells = lanes ?? PANORAMA_BUCKETS.map((bucket) => ({
    key: bucket.key as string,
    label: bucket.label,
    value: panoramaBucketValue(loaded, bucket.key),
    footnote: footnotes[bucket.key],
    glyph: bucket.glyph,
    color: bucket.key === 'ready' ? 'var(--text-3)' : bucket.color,
  }));

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
          {onOpenLanding ? <LandingRowButton line={landing} onPress={onOpenLanding} /> : <LandingRow line={landing} />}
        </div>
      ) : null}
      <div
        className={lanes ? 'project-overview-grid' : undefined}
        style={{
          display: 'grid',
          // Integration lanes use three columns on desktop and two on a phone (in CSS).
          // The older, unsplit lanes retain their auto-fit layout.
          gridTemplateColumns: lanes
            ? undefined
            : 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 2,
          background: 'var(--border-subtle)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {cells.map((lane) => (
          <Kpi
            key={lane.key}
            label={lane.label}
            value={lane.value}
            footnote={lane.footnote}
            glyph={lane.glyph}
            color={lane.color}
          />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <BucketMeter buckets={loaded} segments={cells} />
      </div>

      {banners && manual && projectId ? (
        <ManualReadyBanner manual={manual} projectId={projectId} />
      ) : null}

      {banners && wrappingUp ? <WrappingUpBanner settled={settled} /> : null}
    </Card>
  );
}
