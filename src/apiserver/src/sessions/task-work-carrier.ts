import { Prisma, RunStatus } from '@prisma/client';
import type { SessionBackgroundFields, TaskRunReason } from '@orbit/shared';

import {
  ARMED_RETRY,
  bgJobsStalled,
  ENGINE_TURN,
  PENDING_WAKEUP,
  RESUME_WATCH,
  RUNNING_BG_JOB,
  RUNNING_SUBAGENT,
} from '../common/session-working';
import { DISPATCH_PAUSED } from '../queue/dispatch-pause';
import type { PrismaService } from '../prisma/prisma.service';
import { runnerUnavailableSql, sessionIsHeld } from './session-phase';

/**
 * Whether a work session is still CARRYING its task: the one definition behind every surface that
 * shows a task as running, and every Run door that decides whether a press would start it.
 *
 * `session.status` answers a narrower question, and answers it correctly: is a turn queued or
 * executing. Runner slots (the turn state IN_FLIGHT), spawn admission and `session_create(wait)`
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
 *
 * The facts themselves — the first three are what common/session-working.ts calls executing outside
 * a turn, the last three what it calls willWake — are spelled there, once; this list adds only the
 * carrier's own order and the reason each one gives.
 */
const WAKE_SOURCES: ReadonlyArray<{ reason: TaskRunReason; sql: (session: string) => string }> = [
  // The engine is generating while `status` stays AWAITING_INPUT.
  { reason: 'TURN', sql: ENGINE_TURN.sql },
  // A sub-agent still in flight, which reports back into this session.
  { reason: 'TURN', sql: RUNNING_SUBAGENT.sql },
  // §4.1 (2): a `bg_run` job or watch. Never `running_bg_shells` (common/session-working.ts says why).
  { reason: 'BACKGROUND_JOB', sql: RUNNING_BG_JOB.sql },
  // §4.1 (1): what `task_await`, `session_await` and `watch_create` leave behind.
  { reason: 'WAITING', sql: RESUME_WATCH.sql },
  // §4.1 (3): `schedule_wakeup`.
  { reason: 'WAITING', sql: PENDING_WAKEUP.sql },
  // §4.1 (6): a failure the auto-retry sweep re-sends once it is likely to work.
  { reason: 'WAITING', sql: ARMED_RETRY.sql },
];

/** At least one wake source is present on `session`. */
export function sessionWakeSourceSql(session: string): string {
  return `(${WAKE_SOURCES.map((source) => source.sql(session)).join('\n      OR ')})`;
}

/**
 * `session` is a work session still carrying its task — see the top of this file.
 *
 * The three-status list is implied by the clause after it and is stated anyway: it is what lets the
 * planner read it as an index condition (`session_owner_status_task_idx`), which it cannot see
 * through the OR. `finished_at IS NULL` is implied by the status list (session_release_fact_chk) and
 * is stated anyway for the same kind of reason: it is the execution claim index's predicate
 * (`session_task_execution_claim_idx_finished_at`, migration 1426, beside `deleted_at IS NULL`), and
 * the planner matches a partial index only by a predicate it can read here, never through a CHECK.
 * Without it, once 0130's status-set index is gone (release B), a task's carrier is found through
 * `project_event_session_task_provider_idx`, every run the task ever had.
 */
export function sessionCarriesTaskSql(session: string): string {
  return `(${session}."starts_task_work" = true
    AND ${session}."deleted_at" IS NULL
    AND ${session}."finished_at" IS NULL
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
    ELSE ${sessionActivitySql(session)}
  END`;
}

/**
 * What `session` is doing, as `SessionActivity` text — any session, task or not: the same answer
 * `sessionRunReasonSql` gives for a task's carrier, and NULL for a session that is queued for or doing
 * nothing beyond what its status says (ended, or parked with no wake source). Every surface that words
 * a session's state reads this beside `status`, so a parked session still working is never "Awaiting
 * reply".
 */
export function sessionActivitySql(session: string): string {
  return `CASE
    WHEN ${session}."status" IN ('PENDING'::"run_status", 'RUNNING'::"run_status") THEN 'TURN'
    WHEN ${session}."status" <> 'AWAITING_INPUT'::"run_status" THEN NULL
    ${WAKE_SOURCES.map((source) => `WHEN ${source.sql(session)} THEN '${source.reason}'`).join('\n    ')}
  END`;
}

/**
 * The Background mark's inputs for the sessions `ids`, by id, under the list row's own expressions: `activity`
 * (`sessionActivitySql`) and `runningBgCount` (`cardinality(running_bg_shells)`). Every payload kind that does not
 * read them in its own row query reads them here, so a session answers alike on all of them. A session that is not
 * there is absent.
 */
export async function readSessionBackgroundFields(
  prisma: Pick<PrismaService, '$queryRaw'>,
  ids: readonly string[],
): Promise<Map<string, SessionBackgroundFields>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string } & SessionBackgroundFields>>(Prisma.sql`
    SELECT s."id" AS "id", (${Prisma.raw(sessionActivitySql('s'))}) AS "activity",
           cardinality(s."running_bg_shells")::int AS "runningBgCount"
      FROM "session" s
     WHERE s."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`);
  return new Map(rows.map(({ id, activity, runningBgCount }) => [id, { activity, runningBgCount }]));
}

/** `readSessionBackgroundFields` for one session; null when it is not there. */
export async function readOneSessionBackgroundFields(
  prisma: Pick<PrismaService, '$queryRaw'>,
  id: string,
): Promise<SessionBackgroundFields | null> {
  return (await readSessionBackgroundFields(prisma, [id])).get(id) ?? null;
}

/** The session columns `runStalled` reads, as a reader selects them beside the run reason. */
export interface RunStallFacts {
  runReason: TaskRunReason | null;
  runningBgJobs: readonly string[] | null;
  runningBgJobActivity: unknown;
}

/**
 * A run held only by background jobs that have all stopped producing output: the shared stall flag
 * (`bgJobsStalled`, common/session-working.ts), which is deliberately not part of whether the task is
 * running. The task stays RUNNING and this rides beside the reason, letting a surface say "no output
 * for a while" instead of either hiding the run or vouching for a job that may be hung. The carrier's
 * own addition is the reason: only a BACKGROUND_JOB reason can be stalled — a turn, or a wait for
 * something else, is not held by the job.
 */
export function runStalled(facts: RunStallFacts, nowMs: number): boolean {
  return facts.runReason === 'BACKGROUND_JOB' && bgJobsStalled(facts, nowMs);
}

/** The work session carrying one task, as the surfaces that show the task read it. */
export interface TaskWorkCarrier {
  sessionId: string;
  /** PENDING, RUNNING or AWAITING_INPUT. */
  status: RunStatus;
  runReason: TaskRunReason;
  runStalled: boolean;
  /** The queued turn is held (`sessionIsHeld`, the rule behind `waitingOn: 'HOLD'`); false for any other status. */
  held: boolean;
  /** When the session's run first started; null while it never has. */
  startedAt: Date | null;
}

interface CarrierRow extends RunStallFacts {
  taskId: string;
  sessionId: string;
  status: RunStatus;
  runReason: TaskRunReason;
  startedAt: Date | null;
  error: string | null;
  runnerUnavailable: boolean;
  dispatchPaused: boolean;
}

/**
 * The session carrying each task `scope` reaches, keyed by task id.
 *
 * `scope` is a predicate over `carrier`, the session row: its owner, a task id list, the tasks of a
 * project or a list. At most one row per task can match — the execution claim index
 * (`session_task_execution_claim_idx_finished_at`) admits one live session per task — so keying by
 * task loses nothing.
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
           carrier."started_at" AS "startedAt",
           carrier."error" AS "error",
           ${runnerUnavailableSql('r')} AS "runnerUnavailable",
           ${DISPATCH_PAUSED} AS "dispatchPaused"
      FROM "session" carrier
      LEFT JOIN "runner" r ON r."id" = carrier."assigned_runner_id"
     WHERE carrier."task_id" IS NOT NULL
       AND ${scope}
       AND ${Prisma.raw(sessionCarriesTaskSql('carrier'))}`);
  return new Map(rows.map((row) => [row.taskId, {
    sessionId: row.sessionId,
    status: row.status,
    runReason: row.runReason,
    runStalled: runStalled(row, nowMs),
    held: sessionIsHeld(row, { dispatchPaused: row.dispatchPaused === true, runnerUnavailable: row.runnerUnavailable === true }),
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
  /** Additive: the queued run is held (waitingOn HOLD). `queued` keeps its value. */
  queuedOnHold: boolean;
}

export function taskRunOverlay(carrier: TaskWorkCarrier | undefined): TaskRunOverlay {
  if (!carrier) return { running: false, queued: false, runReason: null, runStalled: false, queuedOnHold: false };
  const queued = carrier.status === RunStatus.PENDING;
  return { running: !queued, queued, runReason: carrier.runReason, runStalled: carrier.runStalled, queuedOnHold: queued && carrier.held };
}
