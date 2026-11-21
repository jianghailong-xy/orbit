/**
 * The release row shapes of docs/session-three-state-design.md §12.2, for specs: every shape a writer of the project
 * branch leaves (after removal step R2, and option A of R3/R4: a release with no end asked and no failure records
 * CANCELLED on the turn it cuts off), the shapes earlier releases left in production, and the rows a deploy-1 server
 * releases during deploy 2's hand-over. Each carries the columns the release questions of common/session-release.ts
 * read, the `release_cause` its writer records (still written until removal step R5), and what changes for it.
 *
 * `CAUSE_READING` is the reading before R3: a failure is a failure cause, the work finished exactly when the cause is
 * task_done or landing_settled. The specs compare the questions with it; nothing in the product reads it.
 */
import type { RunStatus } from '@prisma/client';

import type { SessionReleaseCause, SessionReleaseFacts } from './session-release';

/** The reading before removal step R3, by cause: what `isFailedRelease` and `isWorkFinishedRelease` answered. */
const FAILURE_CAUSES: readonly string[] = ['turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed'];
const WORK_FINISHED_CAUSES: readonly string[] = ['task_done', 'landing_settled'];
export const CAUSE_READING = {
  failureCauses: FAILURE_CAUSES,
  workFinishedCauses: WORK_FINISHED_CAUSES,
  failed: (cause: string | null): boolean => cause != null && FAILURE_CAUSES.includes(cause),
  finished: (cause: string | null): boolean => cause != null && WORK_FINISHED_CAUSES.includes(cause),
};

/** Why a shape's answer to "released by a failure" is not the cause reading's (design §12.2, §12.3). */
export type FailureChange =
  /** An end was asked for (an end reason is recorded) and the session was released FAILED: a stop, not a failure. */
  | 'END_ASKED'
  /** Released FAILED by an earlier writer whose cause 1262 named as a stop: the status and the turn say failed, as the
   *  deploy-1 readers (the status) answer today; only the project branch's cause reading, never deployed, said not. */
  | 'LEGACY_FAILED'
  /** The copy of a failed turn kept by a held session that is then released by no failure and with nothing cut off:
   *  the turn says failed, the release does not (the coordinator's residual shape, 2026-11-21). */
  | 'RESIDUAL';

export interface ReleaseShape {
  /** The shape's name in design §12.2 (or the coordinator's ruling), and what it is. */
  name: string;
  what: string;
  /** Who leaves it: a writer (file and function) or a migration. */
  writer: string;
  status: RunStatus;
  released: boolean;
  /** The cause its writer records beside the release (null while held). */
  releaseCause: SessionReleaseCause | null;
  endReason: string | null;
  lastTurnOutcome: 'ANSWERED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED' | null;
  sessionKind: 'CONVERSATION' | 'LANDING';
  /** Its writer records the turn outcome (§12.1), so the answer does not need the status bridge. */
  carriesTurnOutcome: boolean;
  /**
   * The answer changes once removal step R7 drops the bridge, and why: an end asked for with no reason recorded, whose
   * cut-off turn says CANCELLED (W7's rule, reached through the turn instead of the end reason).
   */
  withoutBridge?: 'END_ASKED';
  /** How many production rows have the shape, where measured (design §12.2, the coordinator's counts). */
  production?: string;
  /** Why "released by a failure" answers otherwise than the cause reading; absent when it answers the same. */
  failureChange?: FailureChange;
}

const W = 'src/apiserver/src';

/** Every release row shape (design §12.2), with the held ones a release question must answer no for. */
export const RELEASE_SHAPES: readonly ReleaseShape[] = [
  // The failure writers of design §12.1, as removal step R2 left them: FAILED, no end reason, the carrying turn FAILED.
  { name: 'W1', what: 'turn-complete: a failed work turn', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W1 swallowed', what: 'turn-complete: a delivery nobody answered past its budget', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W1a', what: 'turn-complete: an EXECUTABLE exit code the declaration did not ask for', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W1b', what: 'turn-complete: an acceptance result that cannot be compared', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W1c', what: 'turn-complete: a failed turn of a kind that is no work turn', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W2', what: 'the reaper: runner offline while RUNNING (first turn, or a later one)', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'runner_lost', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W3', what: 'the reaper: the runtime never initialized', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'setup_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W4', what: 'the runner refused the source', writer: `${W}/projects/session-source.ts freezeSessionSourcePin`,
    status: 'FAILED', released: true, releaseCause: 'setup_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W4 after an end', what: 'the source refused after an end was asked between the claim and the pin', writer: `${W}/projects/session-source.ts freezeSessionSourcePin`,
    status: 'FAILED', released: true, releaseCause: 'setup_failed', endReason: 'ended', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, failureChange: 'END_ASKED' },
  { name: 'W5', what: 'a failed transcript import (no engine, no turn; in Trash)', writer: `${W}/runner-api/runner-api.controller.ts importResult`,
    status: 'FAILED', released: true, releaseCause: 'import_failed', endReason: null, lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: false },
  { name: 'W6', what: 'runner finalize, no end asked, FAILED: mid-turn, never started, or events given up', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'FAILED', released: true, releaseCause: 'engine_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'W7 running', what: 'the reaper: an end asked for and not honoured, a turn in flight (CANCELLED)', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'end_not_honored', endReason: 'cancelled', lastTurnOutcome: 'CANCELLED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, failureChange: 'END_ASKED' },
  { name: 'W7 idle', what: 'the reaper: an end asked for and not honoured on an idle session (the last outcome kept)', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'end_not_honored', endReason: 'completed', lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, failureChange: 'END_ASKED' },
  { name: 'W7 no reason', what: 'the reaper: a cancel recorded with no end reason, not honoured (no current writer leaves one: every end request writes its reason)', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'end_not_honored', endReason: null, lastTurnOutcome: 'CANCELLED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, withoutBridge: 'END_ASKED' },
  { name: 'W7 after a failed turn', what: 'the reaper: an end not honoured, the turn before it failed during the end (N2)', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'end_not_honored', endReason: 'deleted', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, failureChange: 'END_ASKED' },
  { name: 'W8', what: 'the reaper: the API-error backstop on an idle task session', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'FAILED', released: true, releaseCause: 'turn_failed', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  // Releases that are no failure.
  { name: 'N1', what: 'an end asked for and honoured', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'ended', endReason: 'ended', lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N1 late', what: 'a graceful end the reaper settled late, as asked', writer: `${W}/realtime/reaper.service.ts forceFinalize`,
    status: 'CANCELLED', released: true, releaseCause: 'task_cancelled', endReason: 'task_cancelled', lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N1 queued', what: 'a session ended while still queued', writer: `${W}/sessions/sessions.service.ts transitionEnd`,
    status: 'CANCELLED', released: true, releaseCause: 'ended', endReason: 'ended', lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N2', what: 'a turn failed while its session was being ended, then CANCELLED', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'ended', endReason: 'ended', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N3', what: 'its task ended DONE (task_done)', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'SUCCEEDED', released: true, releaseCause: 'task_done', endReason: 'task_done', lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N4', what: 'runner finalize, no end asked, CANCELLED: the turn it cut off CANCELLED (option A)', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'CANCELLED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N4 nothing cut off', what: 'runner finalize, no end asked, CANCELLED, no turn in flight or queued', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N4 SUCCEEDED', what: 'runner finalize, no end asked, SUCCEEDED (logged; no runner the server accepts sends it)', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'SUCCEEDED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'CANCELLED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'N5', what: 'a LANDING container whose landing settled', writer: `${W}/projects/landing-session.ts`,
    status: 'SUCCEEDED', released: true, releaseCause: 'landing_settled', endReason: null, lastTurnOutcome: null,
    sessionKind: 'LANDING', carriesTurnOutcome: true },
  { name: 'N5 not landed', what: 'a LANDING container whose landing settled without landing', writer: `${W}/projects/landing-session.ts`,
    status: 'CANCELLED', released: true, releaseCause: 'landing_settled', endReason: null, lastTurnOutcome: null,
    sessionKind: 'LANDING', carriesTurnOutcome: true },
  { name: 'A1', what: 'a failure release revived, then finalized CANCELLED with no end asked before a turn completed (option A)', writer: `${W}/runner-api/runner-api.controller.ts finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'CANCELLED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'A2', what: 'a late failed completion copied onto an idle session, then a no-end, no-failure finalize with no turn to cut off', writer: `${W}/runner-api/runner-api.controller.ts turnComplete, then finalize`,
    status: 'CANCELLED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: '0 (coordinator, 2026-11-21: all 931 rows with FAILED are FAILED)',
    failureChange: 'RESIDUAL' },
  // Held: no release question answers yes for them.
  { name: 'R1', what: 'revived after a failed turn, not yet answered (PENDING)', writer: `${W}/sessions/sessions.service.ts resume`,
    status: 'PENDING', released: false, releaseCause: null, endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: '0 held rows carry FAILED (coordinator, 2026-11-21)' },
  { name: 'held idle', what: 'a session parked idle with a retry armed', writer: `${W}/runner-api/runner-api.controller.ts turnComplete`,
    status: 'AWAITING_INPUT', released: false, releaseCause: null, endReason: null, lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'held ending', what: 'a running session with an end asked, not yet honoured', writer: `${W}/sessions/sessions.service.ts transitionEnd`,
    status: 'RUNNING', released: false, releaseCause: null, endReason: 'ended', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  // Rows earlier releases left in production (migrations 1202 and 1262; design §12.2 B1-B3).
  { name: 'B1 completed', what: '1262: an old FAILED row with an end reason, cause = that reason', writer: 'migration 1262 (1202: FAILED outcome)',
    status: 'FAILED', released: true, releaseCause: 'completed', endReason: 'completed', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: '13 of the 85 FAILED rows with no failure cause' },
  { name: 'B1 task_done', what: '1262: an old FAILED row whose task ended DONE', writer: 'migration 1262 (1202: FAILED outcome)',
    status: 'FAILED', released: true, releaseCause: 'task_done', endReason: 'task_done', lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'B1 engine', what: '1262: an old FAILED finalize with no end asked, named engine_exited', writer: 'migration 1262 (1202: FAILED outcome)',
    status: 'FAILED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: '71 of the 85', failureChange: 'LEGACY_FAILED' },
  { name: 'B2', what: '1262: an old FAILED "cancel not honored" with no end reason, cause cancelled', writer: 'migration 1262 (1202: FAILED outcome)',
    status: 'FAILED', released: true, releaseCause: 'cancelled', endReason: null, lastTurnOutcome: 'FAILED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: 'at most 1 of the 85 (cause cancelled)', failureChange: 'LEGACY_FAILED' },
  { name: 'B3', what: '1262: an old SUCCEEDED with no end, engine_exited', writer: 'migration 1262',
    status: 'SUCCEEDED', released: true, releaseCause: 'engine_exited', endReason: null, lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true, production: '318' },
  { name: 'B6', what: '1262: an old CANCELLED with a cancel asked and no reason, cause cancelled', writer: 'migration 1262',
    status: 'CANCELLED', released: true, releaseCause: 'cancelled', endReason: null, lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: true },
  { name: 'B7', what: '1262: an old LANDING container', writer: 'migration 1262',
    status: 'SUCCEEDED', released: true, releaseCause: 'landing_settled', endReason: null, lastTurnOutcome: null,
    sessionKind: 'LANDING', carriesTurnOutcome: true },
  // A deploy-1 server's releases during deploy 2's hand-over: the status says FAILED, the turn outcome is the last
  // turn's from before (design §12.6 fact 1). The status bridge carries them until R6 backfills them (deploy 3).
  { name: 'H2', what: 'deploy-1 reaper: runner lost, no turn outcome recorded', writer: 'deploy 1 realtime/reaper.service.ts',
    status: 'FAILED', released: true, releaseCause: 'runner_lost', endReason: null, lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: false },
  { name: 'H6', what: 'deploy-1 finalize: the engine failed, no turn outcome recorded', writer: 'deploy 1 runner-api/runner-api.controller.ts',
    status: 'FAILED', released: true, releaseCause: 'engine_failed', endReason: null, lastTurnOutcome: null,
    sessionKind: 'CONVERSATION', carriesTurnOutcome: false },
  { name: 'H4', what: 'deploy-1 refused source, no turn outcome recorded', writer: 'deploy 1 projects/session-source.ts',
    status: 'FAILED', released: true, releaseCause: 'setup_failed', endReason: null, lastTurnOutcome: 'ANSWERED',
    sessionKind: 'CONVERSATION', carriesTurnOutcome: false },
];

/** A shape's release facts at `at`, as the questions read them. */
export function releaseFactsOfShape(shape: ReleaseShape, at: Date = new Date()): SessionReleaseFacts & { releaseCause: string | null } {
  return {
    status: shape.status,
    finishedAt: shape.released ? at : null,
    releaseCause: shape.releaseCause,
    endReason: shape.endReason,
    lastTurnOutcome: shape.lastTurnOutcome,
    sessionKind: shape.sessionKind,
  };
}

/** The shape named `name` (RELEASE_SHAPES). */
export function releaseShape(name: string): ReleaseShape {
  const shape = RELEASE_SHAPES.find((s) => s.name === name);
  if (!shape) throw new Error(`no release shape named ${name}`);
  return shape;
}

/**
 * The release facts the project branch's writers store with `cause` at `at` (one shape per cause), or a session still
 * held (null): for specs that build a row from a cause, so they spell a release the way the writers do.
 */
export function releaseFactsOf(cause: SessionReleaseCause | null, at: Date = new Date()): SessionReleaseFacts & { releaseCause: string | null } {
  if (cause === null) return releaseFactsOfShape(releaseShape('held idle'), at);
  const byCause: Partial<Record<SessionReleaseCause, string>> = {
    task_done: 'N3', task_cancelled: 'N1 late', ended: 'N1', turn_failed: 'W1', runner_lost: 'W2', setup_failed: 'W3',
    engine_exited: 'N4', engine_failed: 'W6', end_not_honored: 'W7 running', import_failed: 'W5', landing_settled: 'N5',
  };
  const named = byCause[cause];
  if (named) return releaseFactsOfShape(releaseShape(named), at);
  // The other end reasons, current and legacy (completed, deleted, cancelled, idle, orphaned): an end asked for and
  // honoured, released CANCELLED with the reason it recorded.
  return { ...releaseFactsOfShape(releaseShape('N1'), at), releaseCause: cause, endReason: cause };
}
