import { Prisma, RunStatus } from '@prisma/client';

import { OPEN_SESSION_STATUSES } from './session-scheduling';

/**
 * The one definition of "is this session working" (docs/session-three-state-design.md §11,
 * docs/session-three-state-plan.md step 1.1), asked as three named questions about a session row:
 *
 * - **executing**: something is running for the session right now — a dispatched turn, a turn the
 *   engine started for itself, a subagent, or a runner-hosted background job;
 * - **willWake**: nothing is executing, but something will give the session a turn without anybody
 *   sending it a message — a RESUME_SESSION watch it observes, a pending scheduled wake-up, an armed
 *   auto-retry;
 * - **holdsSlot**: a dispatched turn, and nothing wider. What the claim and the runner slot counts
 *   mean (`ACTIVE_TURN_STATUSES`); a background job never blocks dispatch.
 *
 * `status` moves only when a turn is dispatched and when the runner reports it complete, so the
 * work outside a turn — `engineTurnActive`, `runningSubagents`, `runningBgJobs` — leaves the row at
 * AWAITING_INPUT for its whole life. Those columns, not the status, say whether it is executing.
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

/** The session columns the executing facts read. Absent reads as "not there", as for an old row. */
export interface SessionExecutionRow {
  status: RunStatus;
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

/** The status of a dispatched turn: the only member of `ACTIVE_TURN_STATUSES`. */
const DISPATCHED_TURN_STATUS = RunStatus.RUNNING;

const nonEmpty = (values: readonly string[] | null | undefined): boolean => (values?.length ?? 0) > 0;

/** A turn dispatched through the inbox is executing: the one fact that holds a runner slot. */
export const DISPATCHED_TURN: SessionFact<Pick<SessionExecutionRow, 'status'>> = {
  holds: (row) => row.status === DISPATCHED_TURN_STATUS,
  where: { status: DISPATCHED_TURN_STATUS },
  sql: (s) => `${s}."status" = '${DISPATCHED_TURN_STATUS}'::"run_status"`,
};

/**
 * The engine is generating while `status` stays AWAITING_INPUT: a background-task notification or
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

/** Work that runs outside a dispatched turn, which leaves `status` where the last turn left it. */
const OUTSIDE_TURN_FACTS = [ENGINE_TURN, RUNNING_SUBAGENT, RUNNING_BG_JOB] as const;
const WAKE_FACTS = [RESUME_WATCH, PENDING_WAKEUP, ARMED_RETRY] as const;

const openStatusSql = (s: string): string =>
  `${s}."status" IN (${OPEN_SESSION_STATUSES.map((status) => `'${status}'::"run_status"`).join(', ')})`;

/**
 * Something is executing for the session: a dispatched turn, or — on a session that has not ended —
 * the engine's own turn, a subagent or a background job. An ended session's sets and flag are
 * cleared as it leaves the open statuses (sessions/running-work.ts), so one left behind is stale and
 * is not read.
 */
export const isSessionExecuting = (row: SessionExecutionRow): boolean =>
  DISPATCHED_TURN.holds(row)
  || (OPEN_SESSION_STATUSES.includes(row.status) && OUTSIDE_TURN_FACTS.some((fact) => fact.holds(row)));

export const SESSION_EXECUTING_WHERE: Prisma.SessionWhereInput = {
  OR: [
    DISPATCHED_TURN.where,
    { status: { in: OPEN_SESSION_STATUSES }, OR: OUTSIDE_TURN_FACTS.map((fact) => fact.where) },
  ],
};

export function sessionExecutingSql(session: string): string {
  return `(${DISPATCHED_TURN.sql(session)}
    OR (${openStatusSql(session)}
      AND (${OUTSIDE_TURN_FACTS.map((fact) => fact.sql(session)).join(' OR ')})))`;
}

/**
 * Nothing is executing, but something will give the session a turn without a message. Read on any
 * status: a watch, a wake-up and a retry each act on the session whatever it says.
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
export const sessionHoldsSlot = (row: Pick<SessionExecutionRow, 'status'>): boolean =>
  DISPATCHED_TURN.holds(row);

export const SESSION_HOLDS_SLOT_WHERE: Prisma.SessionWhereInput = DISPATCHED_TURN.where;

export function sessionHoldsSlotSql(session: string): string {
  return `(${DISPATCHED_TURN.sql(session)})`;
}
