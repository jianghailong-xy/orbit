// Project rows in the session list (docs/session-list-projects-design.md §4, §6, §7).
// Session readings come from the same functions the ordinary rows use.
import {
  INTEGRATION_CLAIM_STALE_MS,
  type CoordinatorLeadKind,
  type ProjectListIntegration,
  type ProjectPromotionView,
  type ProjectSidebarTaskCounts,
  type ProjectStartSettings,
  type SessionProjectMembership,
} from '@orbit/shared';
import type { SessionFolder } from '../api';
import { JOB_PHASES, JOB_WORDS, jobPhases, jobWords, landingClockTime } from '../components/ProjectPanoramaHeader';
import { LANDING_PAGE_COPY } from './landingSession';
import { elapsedLabel, type SidebarProject } from './projectAttention';
import { promotionTimelineDetail, promotionTimelineTitle } from './projectMerge';
import { DEFAULT_MAIN_BRANCH, mainBranchName, runLineMain } from './projectStart';
import type { SessionListView } from './queries';
import { sessionFolderListing, type FolderSessionReadings, type SessionFolderRow } from './sessionFolders';
import { sessionTimeSections, type GroupableSession } from './sessionGrouping';

export interface SessionProjectSession extends GroupableSession {
  title?: string | null;
  folderId?: string | null;
  projectMembership?: SessionProjectMembership | null;
  ownerItems?: readonly { since: string }[];
}

export interface SessionProjectLine {
  text: string;
  /** `warning` is a fact the row states in amber without asking anything: a landing the server
   *  judged timed out. It is deliberately not `approval`, which lights the row's needs-you dot. */
  tone: 'preview' | 'running' | 'approval' | 'queued' | 'background' | 'watching' | 'review' | 'warning';
}

export interface SessionProjectRow<T> extends GroupableSession {
  projectId: string;
  title: string;
  status: SessionProjectMembership['projectStatus'];
  members: T[];
  sessionCount: number;
  coordinator: T | null;
  folderId: string | null;
  needsYou: boolean;
  running: boolean;
  jobs: boolean;
  indicator: 'needs-you' | 'running' | 'jobs' | null;
  line: SessionProjectLine;
  target: { kind: 'session' | 'project'; id: string };
  taskCounts?: ProjectSidebarTaskCounts;
  runningCount: number;
}

export type SessionProjectEntry<T> =
  | (T & { kind: 'session' })
  | (SessionProjectRow<T> & { kind: 'project' });

export interface SessionProjectListing<T> {
  folders: SessionFolderRow[];
  projects: SessionProjectRow<T>[];
  sessions: T[];
  entries: SessionProjectEntry<T>[];
}

export const listShowsProjects = (view: SessionListView, byTag: boolean, searching = false): boolean =>
  view !== 'trash' && !byTag && !searching;

export const SESSION_PROJECT_COPY = {
  progress: (done: number, total: number) => `${done}/${total}`,
  progressHint: (sessions: number, running: number) => `${sessions} sessions · ${running} running`,
  waitingSession: (text: string, title: string) => `${text} · ${title}`,
  noCoordinator: 'No coordinator',
  openSession: 'Open Session',
  openCoordinator: 'Open Coordinator',
  sessions: 'Sessions',
  openProject: 'Open Project',
  pin: 'Pin',
  unpin: 'Unpin',
  move: 'Move…',
  pageSubtitle: (sessions: number) => `Project · ${sessions} sessions`,
  /** The page's subtitle before its members have been read: no count it cannot vouch for yet. */
  pageSubtitleLoading: 'Project',
  /** The progress line of a project whose task counts no read has given: its status. */
  pageStatus: (status: string) => ({ OPEN: 'Open', DONE: 'Done', CANCELLED: 'Cancelled' } as Record<string, string>)[status] ?? status,
  pageEmpty: 'No sessions',
  pageUnread: 'Couldn’t load sessions',
  retry: 'Retry',
  coordinatorSection: 'Coordinator',
  pageProgress: (done: number, total: number, running: number) => `${done}/${total} done · ${running} running`,
  // A project nobody has started, and its start row (docs/mocks/project-start-sessions-page).
  pageNotStarted: (tasks: number) => `Not started · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,
  startAsked: (ago: string) => `asked ${ago}`,
  /** Directly into the main branch the start opens with (`startMainBranch`), or the suggestion's own
   *  where no integration read is at hand. */
  startSuggestion: (
    settings: Pick<ProjectStartSettings, 'line' | 'automatic' | 'maxConcurrentTasks' | 'upstreamRef'>,
    main: string = mainBranchName(settings.upstreamRef),
  ) =>
    `${settings.line === 'MAIN' ? runLineMain(main) : 'Project branch'} · Automatic ${settings.automatic ? 'on' : 'off'} · ${settings.maxConcurrentTasks} at a time`,
  startReview: 'Review and start',
  startNotAsked: 'The coordinator hasn’t asked yet',
  startHint: 'Opens the start card: the criteria, the plan and how it runs.',
} as const;

// Capitalized COORDINATOR_LEAD_COPY; literals also let OrbitKit read the shared wording.
export const SESSION_PROJECT_COORDINATOR_COPY: Record<CoordinatorLeadKind, string> = {
  INTEGRATION_CONFLICT: 'Resolving a merge conflict',
  INTEGRATION_CHECK_FAILED: 'Checks failed',
  INTEGRATION_ERROR: 'Handling an integration error',
  TASK_FAILED: 'Handling a failed task',
  DELIVERY_REVIEW: 'Reviewing a delivery',
  LANDING_UNOBSERVED: 'Handling work not on the line yet',
};

/** A runner that has stopped reporting, in this row's own scale: "no report for 11m", or
 *  "no report yet" for a claim nothing has come back from. The same fact the project page's row
 *  states as `LANDING_NO_REPORT`, and never a verdict about the work — a timeout is the job's own,
 *  and the server words it in the landing's `blockingReason`. OrbitKit: `SessionProjectCopy.landingSilentWord`. */
export function landingSilentWord(minutes: number | null): string {
  return minutes === null ? 'no report yet' : `no report for ${minutes}m`;
}

/**
 * The derived landing label a source work session carries at its bottom (owner 2026-10-19, board v4
 * 06 e): what the platform did with the work this conversation produced — `Landing · checking ›`,
 * `On project/x ✓ ›`, `Landing · checks failed ›`. The words are the integration line's, never the
 * session-merge vocabulary (a code session's own merge bar says something else), and the label opens
 * the landing session the generation belongs to.
 */
export const SESSION_SOURCE_LANDING_COPY = {
  LANDING: 'Landing',
  ON: 'On',
  NOTHING_TO_LAND: 'Nothing to land',
  CHECKS_FAILED: 'checks failed',
  CONFLICT: 'conflict',
  ERROR: 'error',
  QUEUED: 'queued',
  RUNNING: 'running',
} as const;

export interface SourceLandingLabel {
  text: string;
  /** Blue while it moves, green once it landed, red where it stopped — the same three inks the
   *  project page's landing rows wear. */
  tone: 'run' | 'landed' | 'failed' | 'quiet';
}

/**
 * The label for a session's `sourceLanding` (§2.9 LS1's derived field), or null when this
 * conversation produced no landing work. A settled subject says where the work went; an open one
 * says what the platform is doing — the attempt's own step where the server names it (`checking`,
 * `rebasing`), else its state.
 */
export function sourceLandingLabel(
  landing: {
    subject: 'TASK' | 'PROMOTION';
    state: string;
    phase?: string | null;
    settledAs: string | null;
    targetRef: string;
  } | null | undefined,
  main: string = DEFAULT_MAIN_BRANCH,
): SourceLandingLabel | null {
  if (!landing) return null;
  const branch = branchOf(landing.targetRef) || branchOf(main);
  switch (landing.settledAs) {
    case 'LANDED':
    case 'ALREADY_LANDED':
      return { text: `${SESSION_SOURCE_LANDING_COPY.ON} ${branch} ✓`, tone: 'landed' };
    case 'MERGED':
      return { text: `${SESSION_SOURCE_LANDING_COPY.ON} ${mainBranchName(main)} ✓`, tone: 'landed' };
    case 'NOTHING_TO_LAND':
      return { text: SESSION_SOURCE_LANDING_COPY.NOTHING_TO_LAND, tone: 'quiet' };
    case 'HANDLED':
    case 'DECLINED':
    case 'CANCELLED':
    case 'DELETED':
      return { text: `${SESSION_SOURCE_LANDING_COPY.LANDING} · ${landing.settledAs.toLowerCase()}`, tone: 'quiet' };
    default:
      break;
  }
  const stopped = landing.state === 'CHECK_FAILED'
    ? SESSION_SOURCE_LANDING_COPY.CHECKS_FAILED
    : landing.state === 'CONFLICT' ? SESSION_SOURCE_LANDING_COPY.CONFLICT
      : landing.state === 'ERROR' ? SESSION_SOURCE_LANDING_COPY.ERROR
        : null;
  if (stopped) return { text: `${SESSION_SOURCE_LANDING_COPY.LANDING} · ${stopped}`, tone: 'failed' };
  const step = landing.state === 'RUNNING'
    ? (landing.phase ? jobPhases(main)[landing.phase as keyof typeof JOB_PHASES] : null)
      ?? SESSION_SOURCE_LANDING_COPY.RUNNING
    : landing.state === 'QUEUED' ? SESSION_SOURCE_LANDING_COPY.QUEUED
      : landing.state.toLowerCase();
  return { text: `${SESSION_SOURCE_LANDING_COPY.LANDING} · ${step}`, tone: 'run' };
}

/** `refs/heads/project/x` as a branch is spoken of. */
function branchOf(ref: string | null | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '');
}

/** §7.2 V6 in the row's own scale: the server judged the claim timed out — "timed out · no report
 *  for 23m", in amber words and with no needs-you dot, because a stopped landing is a fact, not a
 *  question. OrbitKit: `SessionProjectCopy.landingTimedOut`. */
export const SESSION_PROJECT_TIMED_OUT = 'timed out';
/** The server's SILENT claim in the row's scale: "no word from runner · 4m" — inside the lease,
 *  so not a timeout. OrbitKit: `SessionProjectCopy.landingNoWordFromRunner`. */
export const SESSION_PROJECT_NO_WORD = 'no word from runner';

/** The project page's landing line, shortened for a row that is not redrawn every second:
 *  "Merge to main · queued · 13m", "Landing · checking · 4m · <task>". Null when nothing is in
 *  flight; a server that sends only the count gets "Landing · N jobs".
 *
 *  A job whose runner has stopped reporting says so in the state slot — "no report for 11m", or
 *  "no report yet" for one that has never reported (`LANDING_NO_REPORT`, the same claim lease the
 *  project page's row reads it with). That is a fact about the REPORTS: this line never calls a
 *  silent job a timed-out one, because a timeout is the job's own verdict and lives in the server's
 *  `blockingReason` (`LandTaskStatus` prints it as it is). OrbitKit's `SessionProjectCopy.landingLine`
 *  is this line's other half. A merge and a sync name `main`, the project's main branch. */
export function sessionProjectLandingLine(
  integration: ProjectListIntegration | null | undefined,
  now: number,
  main: string = DEFAULT_MAIN_BRANCH,
): SessionProjectLine | null {
  const count = integration?.activeJobCount ?? 0;
  const job = integration?.inFlight;
  if (!job) return count > 0 ? { text: `Landing · ${count} ${count === 1 ? 'job' : 'jobs'}`, tone: 'queued' } : null;
  const heartbeat = Date.parse(job.heartbeatAt ?? '');
  const reported = Number.isFinite(heartbeat);
  const word = (job.kind && jobWords(main)[job.kind as keyof typeof JOB_WORDS]) || 'Integration';
  const head = count > 1 ? `${word} ${count} jobs` : word;
  const since = Number.isFinite(heartbeat) ? heartbeat : Date.parse(job.startedAt);
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : 0;
  // §7.2 V6: a server that derives the claim's liveness hands this row the fact, so it no longer
  // reads the heartbeat against the claim lease by itself. A timeout is the server's verdict and
  // is said in amber words — not the needs-you ink, and not its dot: nothing here is a question.
  const liveness = job.liveness;
  if (liveness && job.state === 'RUNNING') {
    if (liveness === 'LEASE_EXPIRED') {
      return { text: [head, SESSION_PROJECT_TIMED_OUT, landingSilentWord(minutes)].join(' · '), tone: 'warning' };
    }
    if (liveness === 'SILENT') {
      return { text: [head, `${SESSION_PROJECT_NO_WORD} · ${minutes}m`].join(' · '), tone: 'queued' };
    }
    // LIVE, QUIET and LEGACY: the runner is reporting (or reports only between steps, so its
    // quiet is not silence). A healthy long check stays "checking".
    return {
      text: [head, (job.phase && jobPhases(main)[job.phase]) || 'running', elapsedLabel(job.startedAt, now),
        count > 1 ? null : job.taskTitle].filter(Boolean).join(' · '),
      tone: 'running',
    };
  }
  // An older server: the runner has gone quiet — the same claim lease the project page's landing
  // row reads the same fact with (`LANDING_NO_REPORT`): how long it has been silent, never a
  // verdict about the work.
  const silent = job.state === 'RUNNING' && (!reported || now - heartbeat > INTEGRATION_CLAIM_STALE_MS);
  const running = job.state === 'RUNNING' && !silent;
  const state = job.state !== 'RUNNING' ? 'queued'
    : silent ? landingSilentWord(reported ? Math.max(0, Math.floor((now - heartbeat) / 60_000)) : null)
      : (job.phase && jobPhases(main)[job.phase as keyof typeof JOB_PHASES]) || 'running';
  return {
    text: [head, state, elapsedLabel(job.startedAt, now),
      count > 1 ? null : job.taskTitle].filter(Boolean).join(' · '),
    tone: running ? 'running' : 'queued',
  };
}

/** The Landings row on a project's sessions page and the project's Landings window (owner
 *  2026-10-27, docs/mocks/landings-one-window; contract §2.9 LS6, revision 28): the row's count
 *  sentence, the window's last group and its read-only footer. */
export const SESSION_LANDINGS_COPY = {
  TITLE: 'Landings',
  WAITING: 'waiting for a decision',
  IN_FLIGHT: 'in flight',
  LANDED: 'landed',
  MERGED_INTO: 'merged into',
  TODAY: 'today',
  NOTHING_LANDED_TODAY: 'Nothing landed today',
  NOW: 'Now',
  ORBIT_RUNS_THESE_LANDINGS: 'Orbit runs these landings — nothing to type here.',
} as const;

/**
 * What a LANDING session row says about its subject, as `GET /sessions?projectId=&includeLanding=1`
 * carries it (contract §2.9 LS6). Absent from a conversation's row, and from a server that predates
 * the field.
 */
export interface LandingSessionSummary {
  subject: 'TASK' | 'PROMOTION';
  state: 'IN_FLIGHT' | 'AWAITING_DECISION' | 'SETTLED';
  settledAs: string | null;
  settledAt: string | null;
}

/** The part of a session row the window reads. */
export interface LandingSessionRow {
  id: string;
  title?: string | null;
  createdAt?: string | null;
  lastTurnAt?: string | null;
  landing?: LandingSessionSummary | null;
}

/** One settled landing in the window, drawn with the merged line's head: the mark that says how it
 *  ended, the task's name, the moment it settled, and one line under them. */
export interface LandingsWindowRow {
  /** The row's own key: the landing session's id, or `merge:<promotionId>` for a merge into main
   *  that has no landing session (it predates them). */
  key: string;
  /** The LANDING session the row opens in place; null for a merge that has none, whose receipt is
   *  all there is to open. */
  sessionId: string | null;
  subject: 'TASK' | 'PROMOTION';
  title: string;
  detail: string;
  /** ✓ landed, ⇢ merged into main, ◌ nothing to land and every other quiet ending. */
  tone: 'ok' | 'merge' | 'quiet';
  /** The clock time it settled at, `17:42`. */
  time: string;
  at: number;
  /** The round's merged record (`promotions/merged`), joined by `landingSessionId`; null on a task's
   *  row and on a round older than the read's 20 records. */
  promotion: ProjectPromotionView | null;
}

/** One landing that has not settled: a card at the bottom of the window. */
export interface LandingsWindowCard {
  sessionId: string;
  subject: 'TASK' | 'PROMOTION';
  state: 'IN_FLIGHT' | 'AWAITING_DECISION';
  /** The task's name (a round's own title), the line the card adds under its head. */
  title: string;
  at: number;
}

export interface LandingsWindow {
  /** The settled landings by the session list's own day sections, oldest first and oldest row first:
   *  the window reads like a conversation, the newest at the bottom. */
  days: Array<{ title: string; rows: LandingsWindowRow[] }>;
  /** The landings still in hand, in the order they started — the window's last group. */
  now: LandingsWindowCard[];
}

/** How a settled subject ended, in the row's own words. */
function settledWord(settledAs: string | null): { text: string; tone: LandingsWindowRow['tone'] } {
  switch (settledAs) {
    case 'LANDED': return { text: LANDING_PAGE_COPY.LANDED, tone: 'ok' };
    case 'ALREADY_LANDED': return { text: LANDING_PAGE_COPY.ALREADY_LANDED, tone: 'ok' };
    case 'NOTHING_TO_LAND': return { text: LANDING_PAGE_COPY.NOTHING_TO_LAND, tone: 'quiet' };
    case 'HANDLED': return { text: LANDING_PAGE_COPY.HANDLED, tone: 'quiet' };
    case 'DECLINED': return { text: LANDING_PAGE_COPY.DECLINED, tone: 'quiet' };
    case 'CANCELLED': return { text: LANDING_PAGE_COPY.CANCELLED, tone: 'quiet' };
    case 'DELETED': return { text: LANDING_PAGE_COPY.DELETED, tone: 'quiet' };
    default: return { text: settledAs ?? 'Settled', tone: 'quiet' };
  }
}

/** A task segment's title is the server's `Land · <task>`: the window names the task alone. */
export function landingTaskName(title: string | null | undefined): string {
  const name = title ?? '';
  const prefix = `${LANDING_PAGE_COPY.LAND} · `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * The project's Landings window (owner 2026-10-27, docs/mocks/landings-one-window; contract §2.9
 * LS6 and §3.6, revision 28): every landing the project has had, from the two reads its sessions
 * page already makes — the LANDING sessions (`includeLanding=1`, open and completed) and the merges
 * into main (`promotions/merged`).
 *
 * A settled landing is one row in the day it settled, in the session list's own day sections, all of
 * them kept. A round of merging that merged is one row with its record, joined by
 * `landingSessionId`; a merge older than landing sessions has a row of its own that opens to its
 * receipt alone, and a round past the read's last 20 records keeps its session's row. A landing still
 * in hand — in flight, or waiting for a decision — is a card under `Now`, in the order it started.
 */
export function landingsWindow(
  rows: readonly LandingSessionRow[],
  merges: readonly ProjectPromotionView[],
  opts: { now?: Date } = {},
): LandingsWindow {
  const records = merges.filter((promotion) => promotion.merged != null);
  const bySession = new Map<string, ProjectPromotionView>();
  for (const record of records) {
    if (record.landingSessionId && !bySession.has(record.landingSessionId)) {
      bySession.set(record.landingSessionId, record);
    }
  }
  const joined = new Set<string>();
  const settled: Array<LandingsWindowRow & GroupableSession> = [];
  const now: LandingsWindowCard[] = [];
  const add = (row: LandingsWindowRow, at: string | null | undefined) =>
    settled.push({ ...row, id: row.key, lastTurnAt: at ?? null });
  for (const row of rows) {
    const landing = row.landing;
    if (!landing) continue;
    const name = landing.subject === 'TASK' ? landingTaskName(row.title) : (row.title ?? '');
    if (landing.state !== 'SETTLED') {
      now.push({ sessionId: row.id, subject: landing.subject, state: landing.state, title: name, at: instant(row.createdAt) });
      continue;
    }
    if (landing.subject === 'PROMOTION' && landing.settledAs === 'MERGED') {
      const record = bySession.get(row.id) ?? null;
      if (record) joined.add(record.promotionId);
      const at = record?.merged?.at ?? landing.settledAt;
      add({
        key: row.id,
        sessionId: row.id,
        subject: 'PROMOTION',
        title: record ? promotionTimelineTitle(record) : `${LANDING_PAGE_COPY.MERGED_INTO} ${DEFAULT_MAIN_BRANCH}`,
        detail: record ? promotionTimelineDetail(record) : name,
        tone: 'merge',
        time: at ? landingClockTime(at) : '',
        at: instant(at),
        promotion: record,
      }, at);
      continue;
    }
    const word = settledWord(landing.settledAs);
    add({
      key: row.id,
      sessionId: row.id,
      subject: landing.subject,
      title: name,
      detail: word.text,
      tone: word.tone,
      time: landing.settledAt ? landingClockTime(landing.settledAt) : '',
      at: instant(landing.settledAt),
      promotion: null,
    }, landing.settledAt);
  }
  // A merge whose round has no session in the read: older than landing sessions, or a session the
  // read did not list. It is still a merge into main, at its own instant.
  for (const record of records) {
    if (joined.has(record.promotionId)) continue;
    const at = record.merged?.at ?? null;
    add({
      key: record.landingSessionId ?? `merge:${record.promotionId}`,
      sessionId: record.landingSessionId ?? null,
      subject: 'PROMOTION',
      title: promotionTimelineTitle(record),
      detail: promotionTimelineDetail(record),
      tone: 'merge',
      time: at ? landingClockTime(at) : '',
      at: instant(at),
      promotion: record,
    }, at);
  }
  // Newest first into the session list's grouper (which buckets by the local calendar day and keeps
  // the order it is given), then each section and the sections themselves turned over.
  settled.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  const days = sessionTimeSections(settled, { pinnedFirst: false, now: opts.now })
    .map((section) => ({
      title: section.title,
      rows: section.sessions.map(({ id: _id, lastTurnAt: _at, ...row }) => row).reverse(),
    }))
    .reverse();
  now.sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId));
  return { days, now };
}

/** The Landings row's three facts: the mark of the most urgent landing, how long it has waited (or
 *  how long ago the last one settled), and the counts under them. */
export interface LandingsRowSummary {
  /** ✕ something waits for a decision, the blue ring something is in flight, ✓ all settled. */
  mark: 'fail' | 'running' | 'ok';
  time: string;
  line: string;
}

/**
 * `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` — a count of 0 is
 * left out, today's two share one `today` at the end, and with all four at 0 the line is
 * `Nothing landed today`.
 */
export function landingsCountLine(
  counts: { waiting: number; inFlight: number; landed: number; merged: number },
  main: string = DEFAULT_MAIN_BRANCH,
): string {
  const today = [
    counts.landed > 0 ? `${counts.landed} ${SESSION_LANDINGS_COPY.LANDED}` : null,
    counts.merged > 0 ? `${counts.merged} ${SESSION_LANDINGS_COPY.MERGED_INTO} ${main}` : null,
  ].filter(Boolean).join(' · ');
  const parts = [
    counts.waiting > 0 ? `${counts.waiting} ${SESSION_LANDINGS_COPY.WAITING}` : null,
    counts.inFlight > 0 ? `${counts.inFlight} ${SESSION_LANDINGS_COPY.IN_FLIGHT}` : null,
    today ? `${today} ${SESSION_LANDINGS_COPY.TODAY}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : SESSION_LANDINGS_COPY.NOTHING_LANDED_TODAY;
}

/**
 * The project sessions page's one Landings row (owner 2026-10-27, board 01 b), in the place the
 * Landings group had: under the coordinator, above the page's own timeline. It opens the project's
 * Landings window. Null for a project that has never had a landing, which draws no row at all.
 *
 * The mark follows the most urgent landing: one waiting for a decision is the red ✕ and the right
 * slot says how long the longest of them has waited; else one in flight is the blue ring; else ✓.
 * Without a waiting one the right slot says how long ago the last one settled. Today's counts are the
 * window's own `Today` section, so the row and the window never disagree about a day.
 */
export function landingsRowSummary(
  rows: readonly LandingSessionRow[],
  merges: readonly ProjectPromotionView[],
  opts: { now?: number; main?: string } = {},
): LandingsRowSummary | null {
  const landings = rows.filter((row) => row.landing);
  if (landings.length === 0 && !merges.some((promotion) => promotion.merged != null)) return null;
  const now = opts.now ?? Date.now();
  const window = landingsWindow(landings, merges, { now: new Date(now) });
  const waiting = window.now.filter((card) => card.state === 'AWAITING_DECISION');
  const inFlight = window.now.filter((card) => card.state === 'IN_FLIGHT');
  const today = window.days.find((day) => day.title === 'Today')?.rows ?? [];
  const settledAt = Math.max(...window.days.flatMap((day) => day.rows.map((row) => row.at)));
  const time = waiting.length > 0
    ? elapsedLabel(new Date(Math.min(...waiting.map((card) => card.at))).toISOString(), now)
    : Number.isFinite(settledAt) ? elapsedLabel(new Date(settledAt).toISOString(), now) : null;
  return {
    mark: waiting.length > 0 ? 'fail' : inFlight.length > 0 ? 'running' : 'ok',
    time: time ?? '',
    line: landingsCountLine({
      waiting: waiting.length,
      inFlight: inFlight.length,
      landed: today.filter((row) => row.tone === 'ok').length,
      merged: today.filter((row) => row.tone === 'merge').length,
    }, opts.main),
  };
}

const instant = (at: string | null | undefined): number => {
  const ms = Date.parse(at ?? '');
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** The owner item's own wait is authoritative; old summaries only have last activity. */
const waitingInstant = (session: SessionProjectSession): number => {
  const items = (session.ownerItems ?? []).map((item) => instant(item.since)).filter(Number.isFinite);
  return items.length ? Math.min(...items) : instant(session.lastTurnAt ?? session.createdAt);
};

/** Split one view of one workspace. Supplemental coordinators affect placement and wording only:
 *  a coordinator from another workspace/view never inflates this view's activity or folder count. */
export function sessionProjectListing<T extends SessionProjectSession>(
  sessions: readonly T[],
  folders: readonly SessionFolder[],
  projects: readonly SidebarProject[],
  opts: {
    view: SessionListView;
    byTag: boolean;
    searching?: boolean;
    folderId?: string | null;
    runnerOffline?: boolean;
    now?: number;
    coordinators?: readonly T[];
    /** Same-view sessions across workspaces, used for the waiting line and tooltip count. */
    contentSessions?: readonly T[];
    line: (session: T) => SessionProjectLine;
  } & FolderSessionReadings<T>,
): SessionProjectListing<T> {
  const flat = (rows: T[], folderRows: SessionFolderRow[] = []): SessionProjectListing<T> => ({
    folders: folderRows,
    projects: [],
    sessions: rows,
    entries: rows.map((session) => ({ ...session, kind: 'session' })),
  });
  if (!listShowsProjects(opts.view, opts.byTag, opts.searching)) return flat([...sessions]);

  const groups = new Map<string, T[]>();
  const coordinators = new Map<string, T>();
  for (const session of [...(opts.coordinators ?? []), ...sessions]) {
    if (session.projectMembership?.role === 'COORDINATOR') {
      coordinators.set(session.projectMembership.projectId, session);
    }
  }
  for (const session of sessions) {
    const id = session.projectMembership?.projectId;
    if (!id) continue;
    const members = groups.get(id);
    if (members) members.push(session);
    else groups.set(id, [session]);
  }
  const assigned = sessions.map((session) => {
    const id = session.projectMembership?.projectId;
    return id ? { ...session, folderId: coordinators.get(id)?.folderId ?? null } : session;
  });
  const folderListing = sessionFolderListing(assigned, folders, opts);
  const knownFolders = new Set(folders.map((folder) => folder.id));
  const inScope = (folderId: string | null | undefined) => opts.folderId
    ? folderId === opts.folderId
    : !folderId || !knownFolders.has(folderId);
  const loose = sessions.filter((session) => !session.projectMembership && inScope(session.folderId));
  if (!groups.size) return flat(loose, opts.folderId ? [] : folderListing.folders);

  const summaries = new Map(projects.map((project) => [project.id, project]));
  const rows: SessionProjectRow<T>[] = [];
  for (const [projectId, members] of groups) {
    const coordinator = coordinators.get(projectId) ?? null;
    const folderId = coordinator?.folderId ?? null;
    if (!inScope(folderId)) continue;
    const summary = summaries.get(projectId);
    const membership = members[0].projectMembership!;
    const content = opts.contentSessions ? [...new Map([
      ...opts.contentSessions.filter((session) => session.projectMembership?.projectId === projectId),
      ...members,
    ].map((session) => [session.id, session])).values()] : members;
    const lines = new Map(content.map((session) => [session.id, opts.line(session)]));
    const coordinatorLine = coordinator ? (lines.get(coordinator.id) ?? opts.line(coordinator)) : null;
    const waiting = content.filter((session) => lines.get(session.id)?.tone === 'approval');
    waiting.sort((a, b) => {
      const left = waitingInstant(a);
      const right = waitingInstant(b);
      if (left !== right) {
        if (!Number.isFinite(left)) return 1;
        if (!Number.isFinite(right)) return -1;
        return left - right;
      }
      return a.id.localeCompare(b.id);
    });
    const landing = sessionProjectLandingLine(
      summary?.integration, opts.now ?? Date.now(), mainBranchName(summary?.mainBranch));
    let line: SessionProjectLine;
    let target: SessionProjectRow<T>['target'];
    if (coordinatorLine?.tone === 'approval') {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator!.id };
    } else if (waiting.length) {
      const lead = waiting[0];
      line = { text: SESSION_PROJECT_COPY.waitingSession(lines.get(lead.id)!.text, lead.title ?? ''), tone: 'approval' };
      target = { kind: 'session', id: lead.id };
    } else if (coordinator && summary?.attention?.coordinatorItems) {
      const held = summary.attention.coordinatorItems;
      const copy = SESSION_PROJECT_COORDINATOR_COPY[held.leadKind];
      line = { text: [copy, elapsedLabel(held.oldestWaitingSince, opts.now ?? Date.now())].filter(Boolean).join(' · '), tone: 'running' };
      target = { kind: 'session', id: coordinator.id };
    } else if (coordinator && coordinatorLine && !opts.runnerOffline && opts.motion(coordinator) === 'spinner') {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator.id };
    } else if (landing) {
      line = landing;
      target = coordinator ? { kind: 'session', id: coordinator.id } : { kind: 'project', id: projectId };
    } else if (coordinatorLine) {
      line = coordinatorLine;
      target = { kind: 'session', id: coordinator!.id };
    } else {
      line = { text: SESSION_PROJECT_COPY.noCoordinator, tone: 'preview' };
      target = { kind: 'project', id: projectId };
    }
    const latest = members.reduce((newest, session) => instant(session.lastTurnAt ?? session.createdAt) > instant(newest.lastTurnAt ?? newest.createdAt) ? session : newest);
    const motions = opts.runnerOffline ? [] : members.map(opts.motion);
    const needsYou = members.some((session) => lines.get(session.id)?.tone === 'approval');
    const running = motions.includes('spinner');
    const jobs = motions.includes('pulse');
    rows.push({
      id: projectId,
      projectId,
      title: summary?.title ?? membership.projectTitle,
      status: summary?.status ?? membership.projectStatus,
      members: [...members],
      sessionCount: new Set([...content.map((session) => session.id), ...(coordinator ? [coordinator.id] : [])]).size,
      coordinator,
      folderId,
      pinnedAt: coordinator?.pinnedAt ?? null,
      lastTurnAt: latest.lastTurnAt ?? latest.createdAt,
      createdAt: coordinator?.createdAt ?? latest.createdAt,
      needsYou,
      running,
      jobs,
      indicator: needsYou ? 'needs-you' : running ? 'running' : jobs ? 'jobs' : null,
      line,
      target,
      taskCounts: summary?.taskCounts,
      runningCount: summary?.buckets.running ?? motions.filter((motion) => motion === 'spinner').length,
    });
  }
  const entries: SessionProjectEntry<T>[] = [
    ...loose.map((session) => ({ ...session, kind: 'session' as const })),
    ...rows.map((project) => ({ ...project, kind: 'project' as const })),
  ];
  entries.sort((a, b) => {
    if (opts.view === 'open' && !!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
    const left = instant(a.lastTurnAt ?? a.createdAt);
    const right = instant(b.lastTurnAt ?? b.createdAt);
    return left === right ? 0 : left > right ? -1 : 1;
  });
  return { folders: opts.folderId ? [] : folderListing.folders, projects: rows, sessions: loose, entries };
}
