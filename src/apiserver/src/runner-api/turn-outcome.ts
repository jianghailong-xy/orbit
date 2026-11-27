import { RunStatus } from '@orbit/shared';

/** `conversation_turn.outcome` and `session.last_turn_outcome` (migration 1201 and its CHECKs). */
export type TurnOutcome = 'ANSWERED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';

/** What the turn-complete handler has already read about the completion it is applying. */
export interface TurnOutcomeInput {
  /** The completed turn's kind; undefined when the completion names no turn. */
  kind: string | undefined;
  /** The run status the runner reported. */
  status: string;
  /** The completion is the Claude region stop (§10 of the handler). */
  regionStopped: boolean;
  /** The message was handed over its delivery budget with no answer. */
  swallowed: boolean;
  /** A success that answered nothing; the turn goes back in the queue. */
  unanswered: boolean;
  /** The session-error form of the runner's failure, used when the turn failed. */
  failureError: string;
  /**
   * The task's acceptance comparison failed on this turn, or could not be made (design §12.1 W1a, W1b): the
   * sentence the session's error is written with. Null when the turn is not a reserved acceptance turn, or it
   * passed.
   */
  acceptanceFailure: string | null;
  /** The runner's reported error and result. */
  error: string | undefined;
  result: string | undefined;
}

/**
 * How a turn ended, for the turn row and the session's copy of it (docs/session-three-state-design.md
 * §4.2), with the words it ended with. This is the translation of the old runner protocol's turn status
 * words into the turn outcome; it goes when plan phase 6 lets the runner report the outcome itself.
 *
 * Only a turn of work has an outcome, a `message` or a `!`-shell turn: a steer and a withdraw settle
 * before this is asked, and a control turn or a kind this build does not know gets none, unless it is the
 * turn the session fails on. A region stop ends the turn as an interrupt does, and a swallowed delivery is
 * a failure. A success nothing answered is put back in the queue and has not ended: the completion that
 * answers it says how it did. Null means nothing is recorded.
 *
 * Every completion that releases its session as failed records FAILED on its turn, the turn that carries
 * the failure (design §12.1): the reserved acceptance turn whose comparison failed or could not be made,
 * with the session's error (W1a, W1b), and a failed turn of any kind (W1c).
 */
export function turnOutcomeOf(input: TurnOutcomeInput): { outcome: TurnOutcome; error: string | null } | null {
  if (input.acceptanceFailure) return { outcome: 'FAILED', error: input.acceptanceFailure };
  const failed = input.status === RunStatus.FAILED;
  if (input.kind !== 'message' && input.kind !== 'shell') {
    return failed && !input.regionStopped
      ? { outcome: 'FAILED', error: input.failureError }
      : null;
  }
  const outcome: TurnOutcome | null = input.regionStopped
    ? 'INTERRUPTED'
    : input.swallowed || failed
      ? 'FAILED'
      : input.status === RunStatus.INTERRUPTED
        ? 'INTERRUPTED'
        : input.status === RunStatus.CANCELLED
          ? 'CANCELLED'
          : input.status === RunStatus.SUCCEEDED && !input.unanswered
            ? 'ANSWERED'
            : null;
  if (!outcome) return null;
  // The runner's failure (in the session error's own form), the region's stopped sentence, or the error a
  // stop was reported with. An answered turn has none.
  const error = outcome === 'FAILED'
    ? input.failureError
    : outcome === 'ANSWERED'
      ? null
      : input.regionStopped
        ? input.error || input.result || null
        : input.error || null;
  return { outcome, error };
}
