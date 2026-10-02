import { Prisma, RunStatus } from '@prisma/client';
import type { TaskRunReason } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { freshRunningBgJobs } from './background-job-activity';

/**
 * Whether a work session is still CARRYING its task: the one definition behind every surface that
 * shows a task as running, and every Run door that decides whether a press would start it.
 *
 * `session.status` answers a narrower question, and answers it correctly: is a turn queued or
 * executing. Runner slots (`ACTIVE_TURN_STATUSES`), spawn admission and `session_create(wait)`
 * (`UNSETTLED_SESSION_STATUSES`), a watch's SESSION_TURN_SETTLED and the stall reclaim
 * (`TASK_OCCUPYING`) are about turns and claims, and stay on them — see
 * common/session-scheduling.ts. Whether the TASK is being worked on is a different question, and
 * since `bg_run(wakeOnExit)`, `task_await` / `session_await` / `watch_create` and `schedule_wakeup`
 * it no longer has the same answer. A long run routinely ends its turn to wait for something it
 * started, sits at AWAITING_INPUT for the hour a test matrix takes, and is woken when the matrix
 * exits. Read as idle, such a task was drawn as Ready to run, and its Run button handed the whole
 * task brief to the waiting session as a new turn (2026-10-02: a work session at AWAITING_INPUT
 * with `running_bg_jobs = {bgj_fffcde016b95}`, its task offered in the Run queue as "1 ready").
 *
 * So a work session (`starts_task_work`, not in the Trash) carries its task while a turn is queued
 * or running, or while it is parked at AWAITING_INPUT with a WAKE SOURCE: something that will give
 * it another turn without anybody sending it a message. INTERRUPTED never carries it, wake source
 * or not: a person stopped that run, and Run on it means "go on". A parked session with no wake
 * source is idle in the plain sense — nothing moves it unless somebody speaks to it — so its task
 * stays Ready and Run continues that session, as it always has.
 *
 * Spelled as SQL because every reader asks it in SQL: inside the work-state CASE, the manual-run
 * predicate, the Run queue's CTEs, and the readers below that used to be Prisma `groupBy`s.
 * Whoever needs it splices these fragments; nobody spells the status list again.
 */

/**
 * The ways a parked session gets woken on its own, each with what a surface says while it is the
 * reason — in priority order, so a session's run reason is the first one it has.
 *
 * docs/session-request-reply-contract.md §4.1 as far as it exists today: (1) a RESUME_SESSION watch
 * the session observes, (2) a runner-hosted job still running, (3) a pending scheduled wake-up and
 * (6) an armed auto-retry — plus the two the engine reports about itself. §4.1's (4), a request this
 * session sent that has not been answered yet, and (5), an `ask_owner` question still open, join
 * this list once they can be read. Its NO_REPLY judgement asks the same question this list
 * answers, which is why the list lives here and not in any one reader.
 */
const WAKE_SOURCES: ReadonlyArray<{ reason: TaskRunReason; sql: (session: string) => string }> = [
  // The engine is generating while `status` stays AWAITING_INPUT: a background-task notification
  // or the engine's own wake-up restarted the model without passing through the inbox.
  { reason: 'TURN', sql: (s) => `${s}."engine_turn_active" = true` },
  // A sub-agent (Task/Agent tool) still in flight, which reports back into this session.
  { reason: 'TURN', sql: (s) => `cardinality(${s}."running_subagents") > 0` },
  // §4.1 (2): a `bg_run` job or watch. Never `running_bg_shells`, which also holds a `service` left
  // running on purpose — a dev server never ends, so it never wakes anyone — and the engine's own
  // background shells, which carry no kind at all.
  { reason: 'BACKGROUND_JOB', sql: (s) => `cardinality(${s}."running_bg_jobs") > 0` },
  // §4.1 (1): what `task_await`, `session_await` and `watch_create` leave behind.
  {
    reason: 'WAITING',
    sql: (s) => `EXISTS (
      SELECT 1 FROM "watch" ${s}_watch
       WHERE ${s}_watch."observer_session_id" = ${s}."id"
         AND ${s}_watch."state" = 'ACTIVE'
         AND ${s}_watch."action" = 'RESUME_SESSION'
    )`,
  },
  // §4.1 (3): `schedule_wakeup`.
  {
    reason: 'WAITING',
    sql: (s) => `EXISTS (
      SELECT 1 FROM "session_scheduled_wakeup" ${s}_wakeup
       WHERE ${s}_wakeup."session_id" = ${s}."id"
         AND ${s}_wakeup."state" = 'PENDING'
    )`,
  },
  // §4.1 (6): a failure the auto-retry sweep re-sends once it is likely to work.
  { reason: 'WAITING', sql: (s) => `${s}."retry_at" IS NOT NULL` },
];

/** At least one wake source is present on `session`. */
export function sessionWakeSourceSql(session: string): string {
  return `(${WAKE_SOURCES.map((source) => source.sql(session)).join('\n      OR ')})`;
}

/**
 * `session` is a work session still carrying its task — see the top of this file.
 *
 * The three-status list is implied by the clause after it and is stated anyway: it is what lets the
 * planner read it as an index condition (`session_owner_status_task_idx`) and match the execution
 * claim index's predicate, neither of which it can see through the OR.
 */
export function sessionCarriesTaskSql(session: string): string {
  return `(${session}."starts_task_work" = true
    AND ${session}."deleted_at" IS NULL
    AND ${session}."status" IN ('PENDING'::"run_status", 'RUNNING'::"run_status", 'AWAITING_INPUT'::"run_status")
    AND (${session}."status" <> 'AWAITING_INPUT'::"run_status" OR ${sessionWakeSourceSql(session)}))`;
}

/** Some work session carries the task row `task`. `session` names the correlated session row. */
export function taskCarriedSql(task: string, session = 'carrier'): string {
  return `EXISTS (
    SELECT 1 FROM "session" ${session}
     WHERE ${session}."task_id" = ${task}."id"
       AND ${sessionCarriesTaskSql(session)}
  )`;
}

/**
 * Why `session` carries its task, as `TaskRunReason` text, and NULL exactly when it does not
 * (`sessionCarriesTaskSql`). A queued turn is TURN: whether a row reads QUEUED is decided off the
 * status by the caller, as it always was.
 */
export function sessionRunReasonSql(session: string): string {
  return `CASE
    WHEN NOT (${session}."starts_task_work" = true AND ${session}."deleted_at" IS NULL) THEN NULL
    WHEN ${session}."status" IN ('PENDING'::"run_status", 'RUNNING'::"run_status") THEN 'TURN'
    WHEN ${session}."status" <> 'AWAITING_INPUT'::"run_status" THEN NULL
    ${WAKE_SOURCES.map((source) => `WHEN ${source.sql(session)} THEN '${source.reason}'`).join('\n    ')}
  END`;
}

/** The session columns `runStalled` reads, as a reader selects them beside the run reason. */
export interface RunStallFacts {
  runReason: TaskRunReason | null;
  runningBgJobs: readonly string[] | null;
  runningBgJobActivity: unknown;
}

/**
 * A run held only by background jobs that have all stopped producing output.
 *
 * Deliberately NOT part of whether the task is running: a job that has written nothing for ten
 * minutes is still a process that will wake its session when it ends, and its known false positive —
 * a compile's silent phase, a `sleep` — is a job that is working (`BG_JOB_ACTIVITY_STALE_AFTER_MS`).
 * So the task stays RUNNING and this rides beside the reason, letting a surface say "no output for a
 * while" instead of either hiding the run or vouching for a job that may be hung. Only a
 * BACKGROUND_JOB reason can be stalled: a turn, or a wait for something else, is not held by the job.
 */
export function runStalled(facts: RunStallFacts, nowMs: number): boolean {
  const jobs = facts.runningBgJobs ?? [];
  return facts.runReason === 'BACKGROUND_JOB'
    && jobs.length > 0
    && freshRunningBgJobs(jobs, facts.runningBgJobActivity, nowMs).length === 0;
}

/** The work session carrying one task, as the surfaces that show the task read it. */
export interface TaskWorkCarrier {
  sessionId: string;
  /** PENDING, RUNNING or AWAITING_INPUT. */
  status: RunStatus;
  runReason: TaskRunReason;
  runStalled: boolean;
  /** When the session's run first started; null while it never has. */
  startedAt: Date | null;
}

interface CarrierRow extends RunStallFacts {
  taskId: string;
  sessionId: string;
  status: RunStatus;
  runReason: TaskRunReason;
  startedAt: Date | null;
}

/**
 * The session carrying each task `scope` reaches, keyed by task id.
 *
 * `scope` is a predicate over `carrier`, the session row: its owner, a task id list, the tasks of a
 * project or a list. At most one row per task can match — `session_task_execution_claim_idx` admits
 * one live session per task — so keying by task loses nothing.
 */
export async function readTaskWorkCarriers(
  prisma: Pick<PrismaService, '$queryRaw'>,
  scope: Prisma.Sql,
  nowMs: number = Date.now(),
): Promise<Map<string, TaskWorkCarrier>> {
  const rows = await prisma.$queryRaw<CarrierRow[]>(Prisma.sql`
    SELECT carrier."task_id" AS "taskId",
           carrier."id" AS "sessionId",
           carrier."status"::text AS "status",
           (${Prisma.raw(sessionRunReasonSql('carrier'))}) AS "runReason",
           carrier."running_bg_jobs" AS "runningBgJobs",
           carrier."running_bg_job_activity" AS "runningBgJobActivity",
           carrier."started_at" AS "startedAt"
      FROM "session" carrier
     WHERE carrier."task_id" IS NOT NULL
       AND ${scope}
       AND ${Prisma.raw(sessionCarriesTaskSql('carrier'))}`);
  return new Map(rows.map((row) => [row.taskId, {
    sessionId: row.sessionId,
    status: row.status,
    runReason: row.runReason,
    runStalled: runStalled(row, nowMs),
    startedAt: row.startedAt,
  }]));
}

/** How many sessions `scope` reaches carry a task — one per task, by the claim index. */
export async function countTaskWorkCarriers(
  prisma: Pick<PrismaService, '$queryRaw'>,
  scope: Prisma.Sql,
): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS "count"
      FROM "session" carrier
     WHERE carrier."task_id" IS NOT NULL
       AND ${scope}
       AND ${Prisma.raw(sessionCarriesTaskSql('carrier'))}`);
  return row?.count ?? 0;
}

/**
 * The live overlays a task row carries: `running` / `queued` as they have always read — QUEUED is
 * still exactly a PENDING session — and why.
 */
export interface TaskRunOverlay {
  running: boolean;
  queued: boolean;
  runReason: TaskRunReason | null;
  runStalled: boolean;
}

export function taskRunOverlay(carrier: TaskWorkCarrier | undefined): TaskRunOverlay {
  if (!carrier) return { running: false, queued: false, runReason: null, runStalled: false };
  const queued = carrier.status === RunStatus.PENDING;
  return { running: !queued, queued, runReason: carrier.runReason, runStalled: carrier.runStalled };
}
