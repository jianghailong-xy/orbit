import { Prisma } from '@prisma/client';

import { freshRunningBgJobs } from '../sessions/background-job-activity';
import { sessionTurnStateSql, turnStateFilter, turnStateOf, type TurnStateFacts } from '../sessions/session-turn-state';
import { heldFilter, isHeld, sessionHeldSql } from './session-release';

/**
 * The one definition of "is this session working" (docs/session-three-state-design.md §11,
 * docs/session-three-state-plan.md step 1.1), asked as three named questions about a session row:
 *
 * - **executing**: something is running for the session right now — a dispatched turn, a turn the
 *   engine started for itself, a subagent, or a runner-hosted background job;
 * - **willWake**: nothing is executing, but something will give the session a turn without anybody
 *   sending it a message — a RESUME_SESSION watch it observes, a pending scheduled wake-up, an armed
 *   auto-retry;
 * - **holdsSlot**: a dispatched turn, and nothing wider: the turn state IN_FLIGHT, the explicit runner-slot fact
 *   (docs/session-status-retirement-plan.md §1.3). What the claim and the runner slot counts mean; a background job
 *   never blocks dispatch, and `phase` (RUNNING for a background job too) never decides it.
 *
 * The turn state moves only when a turn is dispatched and when the runner reports it complete, so the
 * work outside a turn — `engineTurnActive`, `runningSubagents`, `runningBgJobs` — leaves the row parked
 * (held, no turn state) for its whole life. Those columns, not the turn state, say whether it is executing.
 * "Has not ended" is held: `finished_at IS NULL`.
 *
 * The turn state is read through sessions/session-turn-state.ts (`turnStateOf`, `turnStateFilter`,
 * `sessionTurnStateSql`), which reads a held row's stored word only while its `turn_state` is not yet backfilled.
 *
 * Each question, and each fact it is built from, comes in three forms that answer alike on the same
 * row (session-working.pg.spec.ts holds them to it): a TypeScript predicate over a fetched row, a
 * Prisma `where` filter and an SQL fragment over a table alias. Readers that layer their own rules
 * on top (the task carrier never carries an INTERRUPTED session; `isSessionGenerating` reads only
 * the engine's own turn) compose the facts below rather than spelling the columns again.
 *
 * Background SHELLS (`runningBgShells`) are deliberately no fact here: that set also holds a
 * `service` left running on purpose — a dev server never ends, so it never wakes anyone — and the
 * engine's own background shells, which carry no kind at all.
 */

/**
 * The session columns the executing facts read: the turn state's (TURN_STATE_SELECT) and the work outside a turn.
 * An absent execution column reads as "not there", as for an old row.
 */
export interface SessionExecutionRow extends TurnStateFacts {
  engineTurnActive?: boolean | null;
  runningSubagents?: readonly string[] | null;
  runningBgJobs?: readonly string[] | null;
}

/**
 * What the wake facts read. The first two live in other tables (`watch`, `session_scheduled_wakeup`),
 * so a reader that asks in TypeScript fetches them beside the row.
 */
export interface SessionWakeRow {
  /** An ACTIVE RESUME_SESSION watch has this session as its observer. */
  hasResumeWatch?: boolean | null;
  /** A PENDING scheduled wake-up is queued for this session. */
  hasPendingWakeup?: boolean | null;
  retryAt?: Date | null;
}

export type SessionWorkingRow = SessionExecutionRow & SessionWakeRow;

/** One fact about a session row, in the three forms. */
export interface SessionFact<Row> {
  holds: (row: Row) => boolean;
  where: Prisma.SessionWhereInput;
  sql: (session: string) => string;
}

const nonEmpty = (values: readonly string[] | null | undefined): boolean => (values?.length ?? 0) > 0;

/**
 * A turn dispatched through the inbox is executing: the one fact that holds a runner slot, the turn state IN_FLIGHT
 * (what RUNNING said, plan §2.1: F). Its Prisma filter names `finishedAt` and `OR` (turnStateFilter), so it goes in an
 * `OR` or `AND` list, never spread.
 */
export const DISPATCHED_TURN: SessionFact<TurnStateFacts> = {
  holds: (row) => turnStateOf(row) === 'IN_FLIGHT',
  where: turnStateFilter(['IN_FLIGHT']),
  // IS NOT DISTINCT FROM: the turn state is NULL on a parked or released row, and the fact is false there, never NULL,
  // so the executing and wake fragments that OR and NOT it read as they say.
  sql: (s) => `${sessionTurnStateSql(s).sql} IS NOT DISTINCT FROM 'IN_FLIGHT'`,
};

/**
 * The engine is generating while the session stays parked: a background-task notification or
 * the engine's own wake-up restarted the model without passing through the inbox.
 */
export const ENGINE_TURN: SessionFact<Pick<SessionExecutionRow, 'engineTurnActive'>> = {
  holds: (row) => row.engineTurnActive === true,
  where: { engineTurnActive: true },
  sql: (s) => `${s}."engine_turn_active" = true`,
};

/** A sub-agent (Task/Agent tool) still in flight, which reports back into this session. */
export const RUNNING_SUBAGENT: SessionFact<Pick<SessionExecutionRow, 'runningSubagents'>> = {
  holds: (row) => nonEmpty(row.runningSubagents),
  where: { runningSubagents: { isEmpty: false } },
  sql: (s) => `cardinality(${s}."running_subagents") > 0`,
};

/**
 * A runner-hosted `bg_run` job or watch, any job, quiet or not: a job that has written nothing for a
 * while is still a process that will wake its session when it ends. Never `running_bg_shells`.
 */
export const RUNNING_BG_JOB: SessionFact<Pick<SessionExecutionRow, 'runningBgJobs'>> = {
  holds: (row) => nonEmpty(row.runningBgJobs),
  where: { runningBgJobs: { isEmpty: false } },
  sql: (s) => `cardinality(${s}."running_bg_jobs") > 0`,
};

/** What `task_await`, `session_await` and `watch_create` leave behind. */
export const RESUME_WATCH: SessionFact<Pick<SessionWakeRow, 'hasResumeWatch'>> = {
  holds: (row) => row.hasResumeWatch === true,
  where: { observingWatches: { some: { state: 'ACTIVE', action: 'RESUME_SESSION' } } },
  sql: (s) => `EXISTS (
      SELECT 1 FROM "watch" ${s}_watch
       WHERE ${s}_watch."observer_session_id" = ${s}."id"
         AND ${s}_watch."state" = 'ACTIVE'
         AND ${s}_watch."action" = 'RESUME_SESSION'
    )`,
};

/** `schedule_wakeup`. */
export const PENDING_WAKEUP: SessionFact<Pick<SessionWakeRow, 'hasPendingWakeup'>> = {
  holds: (row) => row.hasPendingWakeup === true,
  where: { scheduledWakeups: { some: { state: 'PENDING' } } },
  sql: (s) => `EXISTS (
      SELECT 1 FROM "session_scheduled_wakeup" ${s}_wakeup
       WHERE ${s}_wakeup."session_id" = ${s}."id"
         AND ${s}_wakeup."state" = 'PENDING'
    )`,
};

/** A failure the auto-retry sweep re-sends once it is likely to work. */
export const ARMED_RETRY: SessionFact<Pick<SessionWakeRow, 'retryAt'>> = {
  holds: (row) => row.retryAt != null,
  where: { retryAt: { not: null } },
  sql: (s) => `${s}."retry_at" IS NOT NULL`,
};

/** Work that runs outside a dispatched turn, which leaves the turn state where the last turn left it. */
const OUTSIDE_TURN_FACTS = [ENGINE_TURN, RUNNING_SUBAGENT, RUNNING_BG_JOB] as const;
const WAKE_FACTS = [RESUME_WATCH, PENDING_WAKEUP, ARMED_RETRY] as const;

// "Has not ended" is held, the release column (plan step 4.3). A runner's held rows are read through
// session_runner_held_idx (migration 1628), which answers `finished_at IS NULL` beside the runner (managed runner sleep).
const openSql = (s: string): string => sessionHeldSql(s).sql;

/**
 * Something is executing for the session: a dispatched turn, or — on a session that has not ended —
 * the engine's own turn, a subagent or a background job. An ended session's sets and flag are
 * cleared as it is released (sessions/running-work.ts), so one left behind is stale and
 * is not read.
 */
export const isSessionExecuting = (row: SessionExecutionRow): boolean =>
  DISPATCHED_TURN.holds(row)
  || (isHeld(row) && OUTSIDE_TURN_FACTS.some((fact) => fact.holds(row)));

const executingWhere = (outsideTurn: ReadonlyArray<SessionFact<never>>): Prisma.SessionWhereInput => ({
  OR: [
    DISPATCHED_TURN.where,
    { ...heldFilter(), OR: outsideTurn.map((fact) => fact.where) },
  ],
});

export const SESSION_EXECUTING_WHERE: Prisma.SessionWhereInput = executingWhere(OUTSIDE_TURN_FACTS);

/**
 * Executing for any reason but a background job: a dispatched turn, the engine's own turn or a
 * subagent. What the workspace rail's "working" tally counts; it marks a background job beside it,
 * with `SESSION_RUNNING_BG_JOB_WHERE`, so together the two are `SESSION_EXECUTING_WHERE`.
 */
export const SESSION_EXECUTING_EXCEPT_BG_JOB_WHERE: Prisma.SessionWhereInput =
  executingWhere([ENGINE_TURN, RUNNING_SUBAGENT]);

/** A session that has not ended with a background job in flight, quiet or not: executing. */
export const SESSION_RUNNING_BG_JOB_WHERE: Prisma.SessionWhereInput = {
  ...heldFilter(),
  ...RUNNING_BG_JOB.where,
};

export function sessionExecutingSql(session: string): string {
  return `(${DISPATCHED_TURN.sql(session)}
    OR ${sessionExecutingOutsideTurnSql(session)})`;
}

/**
 * The part of `sessionExecutingSql` that is not a dispatched turn: on a session that has not ended,
 * the engine's own turn, a subagent or a background job. `alsoCounting` lets a reader add work of its
 * own on top of those facts, on the same open sessions — managed runner sleep adds background shells,
 * which are no fact here (see the top of this file).
 */
export function sessionExecutingOutsideTurnSql(session: string, alsoCounting: readonly string[] = []): string {
  const facts = [...OUTSIDE_TURN_FACTS.map((fact) => fact.sql(session)), ...alsoCounting];
  return `(${openSql(session)}
      AND (${facts.join(' OR ')}))`;
}

/**
 * Nothing is executing, but something will give the session a turn without a message. Read on any
 * session, held or released: a watch, a wake-up and a retry each act on the session whatever it says.
 */
export const sessionWillWake = (row: SessionWorkingRow): boolean =>
  !isSessionExecuting(row) && WAKE_FACTS.some((fact) => fact.holds(row));

export const SESSION_WILL_WAKE_WHERE: Prisma.SessionWhereInput = {
  NOT: SESSION_EXECUTING_WHERE,
  OR: WAKE_FACTS.map((fact) => fact.where),
};

export function sessionWillWakeSql(session: string): string {
  return `(NOT ${sessionExecutingSql(session)}
    AND (${WAKE_FACTS.map((fact) => fact.sql(session)).join('\n      OR ')}))`;
}

/** A dispatched turn holds a runner slot; nothing else does. The claim and slot counts mean this. */
export const sessionHoldsSlot = (row: TurnStateFacts): boolean =>
  DISPATCHED_TURN.holds(row);

export const SESSION_HOLDS_SLOT_WHERE: Prisma.SessionWhereInput = DISPATCHED_TURN.where;

export function sessionHoldsSlotSql(session: string): string {
  return `(${DISPATCHED_TURN.sql(session)})`;
}

/**
 * "No output for a while", the one flag beside a background job (docs/session-three-state-design.md
 * §11.3 item 5). It is NOT part of executing: a job that has written nothing for
 * `BG_JOB_ACTIVITY_STALE_AFTER_MS` is still a process that will wake its session when it ends, and its
 * known false positive — a compile's silent phase, a `sleep` — is a job that is working. So every
 * surface counts a quiet job as executing and may show this flag beside it: the task carrier's
 * `runStalled`, the session row's `runningBgJobsStalled`, the workspace rail's `stalledJobs`.
 */
export interface SessionBgJobProgressRow {
  runningBgJobs?: readonly string[] | null;
  runningBgJobActivity?: unknown;
}

/** The session's background jobs whose output moved within the threshold (or was never reported). */
export const movingBgJobs = (row: SessionBgJobProgressRow, nowMs: number = Date.now()): string[] =>
  freshRunningBgJobs(row.runningBgJobs ?? [], row.runningBgJobActivity, nowMs);

/** The session has background jobs in flight and every one of them has gone quiet. */
export const bgJobsStalled = (row: SessionBgJobProgressRow, nowMs: number = Date.now()): boolean =>
  RUNNING_BG_JOB.holds(row) && movingBgJobs(row, nowMs).length === 0;
