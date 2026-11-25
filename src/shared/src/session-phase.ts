/**
 * The session's three activity states and the facts beside them, as every session payload carries them
 * (docs/session-three-state-design.md §4, §11.5; plan step 5.1). The server decides each one in one place
 * (apiserver `sessions/session-phase.ts`), and contracts/session-state.contract.json lists them per
 * payload kind. They ride beside the legacy fields (`status`, `runStatus`, `runState`, `sessionState`,
 * `filingState`), which are sent unchanged.
 *
 * No client reads them yet. A client that does must read a value it does not know as absent: the lists
 * below can grow.
 */

import type { SessionActivity } from './task-run-reason';

/**
 * What the session is doing (`phase`; the name `activity` is taken by `SessionActivity`):
 *   - `RUNNING`: something is executing for it — a dispatched turn, a turn the engine started for itself,
 *     a sub-agent or a runner-hosted background job;
 *   - `PENDING`: a turn is queued and nothing is executing;
 *   - `IDLE`: neither. A released session is always IDLE.
 */
export const SESSION_PHASES = ['PENDING', 'RUNNING', 'IDLE'] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

/**
 * What the session is waiting on (`waitingOn`), or null for nothing:
 *   - `PERSON`: somebody owes it an answer it asked for, an approval card or an owner decision. In any
 *     phase: a RUNNING turn blocked on a permission prompt waits on a person;
 *   - `HOLD`: a queued turn that something nobody asked for keeps from starting — the dispatch pause,
 *     its runner offline or updating, or a hold notice on the row (a paused account, an unavailable
 *     provider, the region check);
 *   - `WAKE`: nothing executes, and something will give it a turn without a message — a watch it
 *     observes, a scheduled wake-up, an armed auto-retry.
 * A parked conversation that asked for nothing is null: it waits for its next message, which nobody owes.
 */
export const SESSION_WAITING_ON = ['PERSON', 'HOLD', 'WAKE'] as const;
export type SessionWaitingOn = (typeof SESSION_WAITING_ON)[number];

/** How the session's last turn ended (`session.last_turn_outcome`), or null before any turn recorded one. */
export const SESSION_TURN_OUTCOMES = ['ANSWERED', 'FAILED', 'INTERRUPTED', 'CANCELLED'] as const;
export type SessionTurnOutcome = (typeof SESSION_TURN_OUTCOMES)[number];

/** The fields, as each session payload kind carries them. Optional on the wire types: an older
 *  control plane omits them. */
export interface SessionPhaseFields {
  phase: SessionPhase;
  /** No runner holds the session (`session.finished_at` is set): the next message must be claimed again. */
  released: boolean;
  lastTurnOutcome: SessionTurnOutcome | null;
  waitingOn: SessionWaitingOn | null;
  /** Why an end was asked for (`session.end_reason`, a SessionEndReason value or a legacy one), or null when
   *  none was. Read from the row; a value a client does not know reads as an end it cannot name. */
  endReason: string | null;
  /** Released having finished its work: its task ended DONE (`endReason` task_done) or, as a landing
   *  container, it settled. The server decides it (common/session-release.ts releaseFinishedTheWork), so a
   *  client words "Finished" from this and never from the session kind. */
  workFinished: boolean;
}

/** The field names, in the order the contract lists them. */
export const SESSION_PHASE_FIELD_NAMES = [
  'phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished',
] as const;

/** What the Background mark reads beside the six facts, as the list row has always carried it: `activity`
 *  (`sessionActivitySql`, apiserver `sessions/task-work-carrier.ts`) and `runningBgCount`, the runner-hosted jobs
 *  and shells still running (`cardinality(session.running_bg_shells)`). Optional on the wire types: an older control
 *  plane omits them. */
export interface SessionBackgroundFields {
  activity: SessionActivity | null;
  runningBgCount: number;
}

/** Their names, in the order the contract lists them. */
export const SESSION_BACKGROUND_FIELD_NAMES = ['activity', 'runningBgCount'] as const;
