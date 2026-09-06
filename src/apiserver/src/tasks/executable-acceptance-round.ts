/**
 * The two durable traces one EXECUTABLE acceptance round leaves behind, in one spelling.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * An acceptance round is not a row. Nothing in the schema records that a declared command ran,
 * what it exited with, or when — `runner-api.controller.ts` says so in as many words above the
 * comparison ("the exit code exists for the length of this block"). What survives the request is
 * incidental to two other rows:
 *
 *   * the reserved shell turn's `client_turn_id`, which marks the turn as a server-queued
 *     acceptance round and carries the code the declaration asked for, and
 *   * the session's `error`, which is the one place the two numbers are written down.
 *
 * Both were private to the door that writes them, which is fine while the only reader is the
 * writer. A coordinator asking "what happened in that round" is a second reader, and a second
 * reader with its own regex is a second definition — one that stays green while the writer's
 * sentence changes underneath it. So the spellings move here and the door imports them: one
 * spelling, two readers.
 *
 * This module deliberately holds no policy. What an exit code MEANS is
 * `projects/mechanical-disposition.ts`, and what derives DONE from one is
 * `task-completion-criterion.ts`.
 */

/**
 * The client-turn prefix every server-queued acceptance round carries.
 *
 * Existing `ConversationTurn` is the whole L0 execution queue. The reserved prefix marks
 * provenance and binds the expected exit code: one successful message mints one shell turn, and
 * its unique key makes a lost `/turn-complete` response unable to enqueue the command twice. It is
 * also, for a reader, the only way to tell an acceptance round from a person's `!` shell turn.
 */
export const TASK_ACCEPTANCE_CLIENT_TURN_PREFIX = 'system:task-acceptance:v1:';

/**
 * What the runner reports when the command did not return a code of its own: a start failure, a
 * timeout kill, a cancellation or a signal.
 *
 * It is compared like any other code — since 0227 removed the typed termination nothing can tell
 * those apart from a command that ran and disagreed — so it derives FAILED like any other
 * disagreement. It is named here because the coordinator's reading of a round is the one place
 * where the difference matters again, and a bare `-1` at that call site would be a magic number.
 */
export const NO_COMPARABLE_EXIT_CODE = -1;

/**
 * The session run outcome a disagreeing acceptance round leaves behind.
 *
 * Written onto the session rather than onto the task on purpose: it is the SESSION's own run
 * outcome rather than a record about the task, and diagnosis is reading the session.
 */
export function executableAcceptanceFailureReason(
  actualExitCode: number,
  expectedExitCode: number,
): string {
  return `acceptance command exited ${actualExitCode}; expected ${expectedExitCode}`;
}

/** The two numbers back out of the sentence above, or `null` for any other run outcome. */
export function readExecutableAcceptanceOutcome(
  reason: string | null | undefined,
): { actualExitCode: number; expectedExitCode: number } | null {
  const parsed = /^acceptance command exited (-?\d+); expected (-?\d+)$/.exec(reason ?? '');
  if (!parsed) return null;
  const actualExitCode = Number(parsed[1]);
  const expectedExitCode = Number(parsed[2]);
  if (!Number.isSafeInteger(actualExitCode) || !Number.isSafeInteger(expectedExitCode)) return null;
  return { actualExitCode, expectedExitCode };
}
