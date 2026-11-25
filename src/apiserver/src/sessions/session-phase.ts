import { Prisma } from '@prisma/client';
import {
  type RunStatus,
  SESSION_TURN_OUTCOMES,
  type SessionPhase,
  type SessionPhaseFields,
  type SessionTurnOutcome,
  type SessionWaitingOn,
} from '@orbit/shared';

import { isReleased, releaseFinishedTheWork } from '../common/session-release';
import {
  ARMED_RETRY,
  ENGINE_TURN,
  PENDING_WAKEUP,
  RESUME_WATCH,
  RUNNING_BG_JOB,
  RUNNING_SUBAGENT,
  type SessionWorkingRow,
} from '../common/session-working';
import { readOwnerDecisionsBySession } from '../projects/owner-decision-signal';
import { DISPATCH_PAUSED } from '../queue/dispatch-pause';
import { isHoldNotice } from '../queue/hold-notice';
import { runnerOfflineSql } from '../runners/runner-presence';
import { countLiveApprovalsBySession } from './abandoned-approvals';
import { legacySessionStatusSql } from './session-legacy-words';
import { sessionTurnStateSql, turnStateOf } from './session-turn-state';

/**
 * The three-state field and the facts beside it (docs/session-three-state-design.md §4, §11.5; plan step 5.1),
 * decided here and nowhere else. Every session payload kind — list row, detail, `session.created` /
 * `session.updated` / `session.ended`, link preview, guest row and the shared header — reads them through
 * `readSessionPhaseFields`, so the same session answers the same on all of them. contracts/session-state.contract.json
 * lists them per kind; the legacy fields beside them are untouched (session-state-legacy-fields.spec.ts).
 */

/** The row columns the fields read. Absent execution and wake facts read as "not there", as for an old row; an absent
 *  end reason as none asked for, and an absent kind as a conversation. */
export interface SessionPhaseRow extends Omit<SessionWorkingRow, 'status'> {
  /** The release column (common/session-release.ts). */
  finishedAt: Date | string | null;
  /** The turn state (session-turn-state.ts), read through turnStateOf: a held row without one reads its stored word
   *  `status` (not yet backfilled), and one with neither reads as parked. */
  turnState?: string | null;
  status?: string;
  lastTurnOutcome?: string | null;
  error?: string | null;
  endReason?: string | null;
  sessionKind?: string | null;
}

/** What holds a queued turn outside the row: the dispatch pause, and the runner it is assigned to. */
export interface SessionHoldFacts {
  /** The administrator's dispatch pause is on (queue/dispatch-pause.ts): no runner is handed new work. */
  dispatchPaused: boolean;
  /** Its runner will not claim it whatever the counts say: none assigned, offline, or draining for a self-update.
   *  The first two gates of the list row's `queuedReason` (`runner_offline`, `runner_updating`). */
  runnerUnavailable: boolean;
}

/** `runnerUnavailable` in SQL, for the runner row aliased `runner` (LEFT JOINed on the session's assigned runner). */
export function runnerUnavailableSql(runner: string): Prisma.Sql {
  const r = Prisma.raw(runner);
  return Prisma.sql`(${r}."id" IS NULL OR ${runnerOfflineSql(runner)} OR ${r}."heartbeat_draining" IS TRUE)`;
}

export const NO_HOLD: SessionHoldFacts = { dispatchPaused: false, runnerUnavailable: false };

/** Work that executes for a held session outside a dispatched turn (common/session-working.ts). */
const OUTSIDE_TURN_FACTS = [ENGINE_TURN, RUNNING_SUBAGENT, RUNNING_BG_JOB] as const;
const WAKE_FACTS = [RESUME_WATCH, PENDING_WAKEUP, ARMED_RETRY] as const;

/**
 * `phase`: RUNNING while anything executes for the session (a dispatched turn, the engine's own turn, a sub-agent or
 * a background job: `isSessionExecuting`'s facts), PENDING while a turn is queued and nothing executes, IDLE
 * otherwise. A released session is always IDLE (design §4.2's invariant). Read from the facts (turn state, release,
 * the execution columns), the rule migration 1611's `session_zz_phase` stores (plan §1.2), and the reference its PG
 * spec holds the trigger to; a held row not yet backfilled reads its turn state from its stored word (turnStateOf).
 */
export function deriveSessionPhase(row: SessionPhaseRow): SessionPhase {
  if (isReleased(row)) return 'IDLE';
  const turn = turnStateOf(row);
  if (turn === 'IN_FLIGHT') return 'RUNNING';
  if (OUTSIDE_TURN_FACTS.some((fact) => fact.holds(row))) return 'RUNNING';
  return turn === 'QUEUED' ? 'PENDING' : 'IDLE';
}

/**
 * A queued session held with a hold notice (queue/hold-notice.ts: the sentences the claim clears, with their writers
 * listed there): a paused account, an unavailable or engine-incompatible provider, a runner that needs an upgrade, the
 * Claude region check, dsh not ready. Any other `error` on a PENDING row is a leftover the claim keeps, not a hold.
 * Clients never rebuild this from `error`: they read `waitingOn: 'HOLD'`.
 */
export function sessionHasHoldNotice(row: Pick<SessionPhaseRow, 'status' | 'finishedAt' | 'turnState' | 'error'>): boolean {
  return turnStateOf(row) === 'QUEUED' && isHoldNotice(row.error);
}

/** A queued turn that something nobody asked for keeps from starting. */
export function sessionIsHeld(
  row: Pick<SessionPhaseRow, 'status' | 'finishedAt' | 'turnState' | 'error'>,
  hold: SessionHoldFacts,
): boolean {
  return turnStateOf(row) === 'QUEUED'
    && (hold.dispatchPaused || hold.runnerUnavailable || sessionHasHoldNotice(row));
}

/**
 * `waitingOn`, in this order (the coordinator's ruling of 2026-11-22, task 5.1):
 *   1. PERSON — somebody owes the session an answer it asked for: `pendingApprovals` (live approval cards plus owner
 *      decisions, the count the list row and `session.updated` carry) is above zero. In any phase;
 *   2. a RUNNING session owes nothing else: null;
 *   3. HOLD — a PENDING one held (`sessionIsHeld`);
 *   4. WAKE — an IDLE one something will wake (`sessionWillWake`: a RESUME_SESSION watch, a scheduled wake-up, an armed
 *      retry). A released FAILED session with a retry armed is WAKE; a PENDING one is waiting on its claim, not a wake;
 *   5. null — nothing. A parked conversation that asked for nothing, and a released one with no retry armed.
 * Not wake sources here, so null when they are all an IDLE session has: an open session request it sent, and a
 * question it asked the owner as coordinator (`ask_owner`) — both answered as a turn, but neither is one of
 * `sessionWillWake`'s facts.
 */
export function deriveSessionWaitingOn(
  row: SessionPhaseRow,
  hold: SessionHoldFacts,
  pendingApprovals: number,
): SessionWaitingOn | null {
  if (pendingApprovals > 0) return 'PERSON';
  const phase = deriveSessionPhase(row);
  if (phase === 'RUNNING') return null;
  if (phase === 'PENDING') return sessionIsHeld(row, hold) ? 'HOLD' : null;
  // IDLE: nothing executes, so `sessionWillWake` is its wake facts alone.
  return WAKE_FACTS.some((fact) => fact.holds(row)) ? 'WAKE' : null;
}

function turnOutcomeOf(value: string | null | undefined): SessionTurnOutcome | null {
  return (SESSION_TURN_OUTCOMES as readonly string[]).includes(value ?? '') ? (value as SessionTurnOutcome) : null;
}

/** The fields from a row and what holds it. `endReason` is the column as stored, and `workFinished` the release
 *  module's own answer (releaseFinishedTheWork): nothing here derives either a second time. */
export function sessionPhaseFields(
  row: SessionPhaseRow,
  hold: SessionHoldFacts,
  pendingApprovals: number,
): SessionPhaseFields {
  return {
    phase: deriveSessionPhase(row),
    released: isReleased(row),
    lastTurnOutcome: turnOutcomeOf(row.lastTurnOutcome),
    waitingOn: deriveSessionWaitingOn(row, hold, pendingApprovals),
    endReason: row.endReason ?? null,
    workFinished: releaseFinishedTheWork({
      finishedAt: row.finishedAt,
      endReason: row.endReason ?? null,
      sessionKind: row.sessionKind ?? 'CONVERSATION',
    }),
  };
}

interface FactsRow {
  id: string;
  ownerId: string;
  taskId: string | null;
  /** The projected word (legacySessionStatusSql), which countLiveApprovalsBySession reads. */
  status: RunStatus;
  finishedAt: Date | null;
  /** Resolved in SQL (sessionTurnStateSql), the stored word's fallback included. */
  turnState: string | null;
  lastTurnOutcome: string | null;
  error: string | null;
  endReason: string | null;
  sessionKind: string;
  engineTurnActive: boolean;
  runningSubagents: string[];
  runningBgJobs: string[];
  runningBgShells: string[];
  retryAt: Date | null;
  hasResumeWatch: boolean;
  hasPendingWakeup: boolean;
  runnerUnavailable: boolean;
  dispatchPaused: boolean;
}

type Db = Prisma.TransactionClient;

/**
 * The fields for the sessions `ids`, by id; a session that is not there is absent. One statement reads the row,
 * its wake facts, its runner and the dispatch pause. `pendingApprovals` is the count the caller already has (the list
 * row, the realtime summary, the link preview); a session it does not name is counted here, the way
 * `session.updated` counts it (`countLiveApprovals` plus the owner decisions on it), for all of them in one batch
 * (`countLiveApprovalsBySession`), so the statements do not grow with the number of sessions.
 */
export async function readSessionPhaseFields(
  db: Db,
  ids: readonly string[],
  pendingApprovals?: ReadonlyMap<string, number>,
): Promise<Map<string, SessionPhaseFields>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<FactsRow[]>(Prisma.sql`
    SELECT s."id" AS "id", s."owner_id"::text AS "ownerId", s."task_id" AS "taskId",
           ${legacySessionStatusSql('s')} AS "status", ${sessionTurnStateSql('s')} AS "turnState", s."finished_at" AS "finishedAt", s."last_turn_outcome" AS "lastTurnOutcome", s."error" AS "error",
           s."end_reason" AS "endReason", s."kind"::text AS "sessionKind",
           s."engine_turn_active" AS "engineTurnActive", s."running_subagents" AS "runningSubagents",
           s."running_bg_jobs" AS "runningBgJobs", s."running_bg_shells" AS "runningBgShells", s."retry_at" AS "retryAt",
           (${Prisma.raw(RESUME_WATCH.sql('s'))}) AS "hasResumeWatch",
           (${Prisma.raw(PENDING_WAKEUP.sql('s'))}) AS "hasPendingWakeup",
           ${runnerUnavailableSql('r')} AS "runnerUnavailable",
           ${DISPATCH_PAUSED} AS "dispatchPaused"
      FROM "session" s
      LEFT JOIN "runner" r ON r."id" = s."assigned_runner_id"
     WHERE s."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`);
  const counted = new Map(pendingApprovals ?? []);
  const uncounted = rows.filter((row) => !counted.has(row.id));
  for (const [ownerId, owned] of groupBy(uncounted, (row) => row.ownerId)) {
    const decisions = await readOwnerDecisionsBySession(db, ownerId, { sessionIds: owned.map((row) => row.id) });
    // Counted for all of them at once: a search page of 50 hits is the same few statements as one session.
    const live = await countLiveApprovalsBySession(db, owned);
    for (const row of owned) {
      counted.set(row.id, (live.get(row.id) ?? 0) + (decisions.get(row.id)?.count ?? 0));
    }
  }
  return new Map(rows.map((row) => [row.id, sessionPhaseFields(
    row,
    { dispatchPaused: row.dispatchPaused === true, runnerUnavailable: row.runnerUnavailable === true },
    counted.get(row.id) ?? 0,
  )]));
}

/** `readSessionPhaseFields` for one session; null when it is not there. */
export async function readOneSessionPhaseFields(
  db: Db,
  id: string,
  pendingApprovals?: number,
): Promise<SessionPhaseFields | null> {
  const given = pendingApprovals === undefined ? undefined : new Map([[id, pendingApprovals]]);
  return (await readSessionPhaseFields(db, [id], given)).get(id) ?? null;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
