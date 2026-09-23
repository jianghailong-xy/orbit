/**
 * What a link to an Orbit object is drawn from: `POST /api/link-previews`, one request for every
 * card a conversation shows.
 *
 * `Instant` is the one thing that differs across the wire, as in `project-progress.ts`: the
 * apiserver holds these as `Date`, everything downstream of JSON as ISO strings.
 *
 * Every id in a response is the base62 public id. A nullable id is its own key beside the object
 * it names (`coordinatorSessionId` beside `coordinator`), never wrapped. Statuses are the enums'
 * string values, which is what both a Prisma row and a decoded response hold.
 */
import type { ProjectIntegrationBuckets, SessionWaitingKind } from './project-progress';
import type {
  ProjectStatus,
  RunStatus,
  SessionLifecycleState,
  SessionRunState,
  SessionState,
  TaskStatus,
} from './enums';

/** The four kinds of object a link can name. */
export type LinkPreviewKind = 'project' | 'task' | 'session' | 'list';
export const LINK_PREVIEW_KINDS: readonly LinkPreviewKind[] = ['project', 'task', 'session', 'list'];

/** How many refs one request may carry. More is a 400, not a truncated answer. */
export const LINK_PREVIEW_MAX_REFS = 50;

/** One object a client wants a card for. `id` is a public id or a UUID. */
export interface LinkPreviewRef {
  kind: LinkPreviewKind;
  id: string;
}

export interface LinkPreviewsRequest {
  refs: LinkPreviewRef[];
}

/**
 * The live RESUME_SESSION watches parked on a session, as counts: what the session list reads from
 * the watch list to say "Watching 7 targets" / "Watch paused" / "2 watches paused". Null on a
 * session no live watch will resume.
 */
export interface LinkPreviewWatching {
  /** ACTIVE watches. */
  active: number;
  /** PAUSED watches. */
  paused: number;
  /** Targets still in the set (not GONE) across the ACTIVE watches, each counted once. */
  targets: number;
}

/**
 * A session's card: fields of the session LIST ROW (`SessionsService.list`), under the row's own
 * names, so a client reads them exactly as it reads a row — `id` included, for the same reason.
 * `watching` and `updatedAt` are the two the row does not carry.
 */
export interface LinkPreviewSession<Instant = string> {
  id: string;
  title: string;
  status: `${RunStatus}`;
  runStatus: `${RunStatus}`;
  runState: `${SessionRunState}`;
  sessionState: `${SessionState}`;
  lifecycleState: `${SessionLifecycleState}`;
  endReason: string | null;
  error: string | null;
  /** When an armed auto-retry re-sends the failed message; null when none is armed. */
  retryAt: Instant | null;
  engineTurnActive: boolean;
  pendingApprovals: number;
  waitingKind: SessionWaitingKind | null;
  runningBgCount: number;
  runningBgJobCount: number;
  watching: LinkPreviewWatching | null;
  workspace: { id: string; name: string } | null;
  model: string | null;
  numTurns: number;
  createdAt: Instant;
  lastTurnAt: Instant | null;
  updatedAt: Instant;
  /** The project this session COORDINATES, as on the list row; both null for any other session. */
  projectId: string | null;
  projectTitle: string | null;
}

/** A task's newest session. */
export interface LinkPreviewTaskRun<Instant = string> {
  status: `${RunStatus}`;
  runState: `${SessionRunState}`;
  numTurns: number;
  /** Null while it has not finished. */
  endedAt: Instant | null;
}

export interface LinkPreviewTask<Instant = string> {
  title: string;
  status: `${TaskStatus}`;
  /** The task list's live overlays: a RUNNING session on it, or a PENDING one with none running. */
  running: boolean;
  queued: boolean;
  project: { id: string; title: string } | null;
  /** The workspace responsible for it. */
  assignee: { id: string; name: string } | null;
  /** How many sessions the task has had. */
  runs: number;
  lastRun: LinkPreviewTaskRun<Instant> | null;
  updatedAt: Instant;
}

/** `readProjectPanorama`'s buckets: every task in exactly one of the seven lanes, plus the
 *  integration split of `done` on a project that has begun integrating. */
export interface LinkPreviewProjectBuckets extends Partial<ProjectIntegrationBuckets> {
  running: number;
  ready: number;
  blocked: number;
  awaitingVerification: number;
  done: number;
  failed: number;
  cancelled: number;
}

export interface LinkPreviewProject<Instant = string> {
  title: string;
  status: `${ProjectStatus}`;
  /** Every task in the project: the sum of the seven lanes. */
  total: number;
  buckets: LinkPreviewProjectBuckets;
  /** The coordinator session, and its card; both null when there is none it can be shown. */
  coordinatorSessionId: string | null;
  coordinator: LinkPreviewSession<Instant> | null;
}

/** The tallies behind the task list's progress bar (`GET /tasks/counts?listId=`), unchanged. */
export interface LinkPreviewListCounts {
  total: number;
  open: number;
  inProgress: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  runnable: number;
}

export interface LinkPreviewList {
  title: string;
  counts: LinkPreviewListCounts;
}

type Addressed<K extends LinkPreviewKind> = {
  kind: K;
  /** The ref's id as a public id; a ref whose id is not one comes back as it was sent. */
  id: string;
};

/**
 * Anything the caller cannot be shown: another account's, deleted, or an id that names nothing.
 * The three are deliberately the same answer.
 */
export type LinkPreviewUnavailable = Addressed<LinkPreviewKind> & { state: 'unavailable' };

export type LinkPreview<Instant = string> =
  | LinkPreviewUnavailable
  | (Addressed<'session'> & { state: 'ok'; session: LinkPreviewSession<Instant> })
  | (Addressed<'task'> & { state: 'ok'; task: LinkPreviewTask<Instant> })
  | (Addressed<'project'> & { state: 'ok'; project: LinkPreviewProject<Instant> })
  | (Addressed<'list'> & { state: 'ok'; list: LinkPreviewList });

/** One preview per ref, in the order they were asked for. */
export interface LinkPreviewsResponse<Instant = string> {
  previews: LinkPreview<Instant>[];
}
