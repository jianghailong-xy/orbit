import type { MainTipAnswer } from './main-tip-probe';

/**
 * The four readings of an acceptance round that need no judgement, and the one action each calls
 * for.
 *
 * §0 — WHERE THIS TABLE COMES FROM
 * ================================
 * On 2026-09-05 and 06 one person pushed a project's eight tasks through by hand. Four kinds of
 * round came up over and over, and none of them took any judgement at all — the same four inputs
 * produced the same four answers every time:
 *
 *   | the round said                                   | what they did                       |
 *   |--------------------------------------------------|-------------------------------------|
 *   | the declared code                                | merge it, record it, release next   |
 *   | no comparable code, other rounds were running    | re-run it — the red was the machine |
 *   | another code, and `main` says the same           | rebase it — the red is not its own  |
 *   | another code, and `main` does not                | send it back, with the red named    |
 *
 * That is a fold, and it is written here as one. What made these four mechanical is that every
 * input is a fact somebody could go and check, and this module's whole claim is that they still
 * are: `round` is what the runner reported, `concurrentRounds` is counted from the rounds that
 * were in flight, and `mainTip` is what the check answered when it was RUN at the tip. None of the
 * three is a flag, which is why the answers below can be trusted to be about the world.
 *
 * §1 — WHY `null` IS MOST OF THE TABLE
 * ====================================
 * Every input this fold does not recognise answers `null`, which means "not a mechanical
 * judgement" and nothing else. It is not "do nothing": what happens to a round nobody can judge
 * mechanically is a person's call and a blocker's job, and saying `null` is how this unit declines
 * to pre-empt one. Two of those cases are worth naming because they look decidable and are not:
 *
 *   * a round that did not come back with a code, with nothing else running. That is `-1`, and
 *     since 0227 removed the typed termination, `-1` means killed, cancelled, signalled or never
 *     started — indistinguishable from a command that ran and returned it. Concurrency is what
 *     makes the first reading the likely one; without it, guessing "re-run" would keep a genuine
 *     failure looping forever.
 *   * a red whose `main` answer is `UNKNOWN`. Nobody asked the tip, or the asking did not finish.
 *     Reading that as GREEN sends work back over a red that was never its own, and reading it as
 *     RED excuses a real one.
 *
 * §2 — MERGING IS DECIDED HERE AND DONE ELSEWHERE
 * ===============================================
 * `MERGE_AND_RELEASE_NEXT` is a decision, not a merge. This module computes it, the delivery
 * returns it, and the session that acts on it is the one that already holds the merge protocol.
 * Merging is the coordinator's one irreversible outward action, and the account owner drew the
 * line on 2026-09-06 exactly there: the apiserver may work out that a merge is what this round
 * calls for, and may not perform one. The other three actions are reversible and are the
 * coordinator's own.
 */

/** What one round's declared command did, in the vocabulary the coordinator reasons in. */
export type RoundOutcome =
  /** It exited the code the declaration asked for. */
  | 'PASSED'
  /** It ran, came back, and the code was not that one. */
  | 'RAN_AND_DISAGREED'
  /** It came back with no code of its own: killed, cancelled, signalled, or never started. */
  | 'NO_COMPARABLE_RESULT';

/**
 * The closed set of actions this fold may choose, spelled so that no two of them can be confused
 * for each other by a reader or by an assertion.
 */
export const MECHANICAL_ACTIONS = [
  /** Merge the finished work, record the trunk evidence, and release the next task. */
  'MERGE_AND_RELEASE_NEXT',
  /** Deliver the same task again, unchanged. Explicitly NOT a rejection of the work. */
  'REDISPATCH_UNCHANGED',
  /** Rebase onto the tip that is already red and run it again there. */
  'REBASE_AND_RERUN',
  /** Return it to the task with the red named. */
  'SEND_BACK',
] as const;

export type MechanicalAction = (typeof MECHANICAL_ACTIONS)[number];

/** Everything the fold is allowed to look at. Each field is an observation, none is a setting. */
export interface RoundObservations {
  round: RoundOutcome;
  /**
   * How many OTHER acceptance rounds were in flight while this one ran.
   *
   * A count rather than a boolean because it is counted, and because the number is what a person
   * reading the decision afterwards wants: "it was killed while three other rounds were running"
   * is an explanation, and "concurrent: true" is a claim.
   */
  concurrentRounds: number;
  /** What the same check answered when it was run at the tip of the integration ref. */
  mainTip: MainTipAnswer;
}

/**
 * The table in §0, and nothing else.
 *
 * Pure for the reason `wake-disposition.ts` and `attempt-budget.ts` are pure: a decision that can
 * be replayed byte for byte from its inputs is a decision that can be argued about afterwards.
 * Reading a row, running a check or asking the clock happens in the caller, where a reader can see
 * what was observed and when.
 */
export function mechanicalAction(observed: RoundObservations): MechanicalAction | null {
  if (observed.round === 'PASSED') return 'MERGE_AND_RELEASE_NEXT';

  if (observed.round === 'NO_COMPARABLE_RESULT') {
    return observed.concurrentRounds > 0 ? 'REDISPATCH_UNCHANGED' : null;
  }

  if (observed.mainTip === 'RED') return 'REBASE_AND_RERUN';
  if (observed.mainTip === 'GREEN') return 'SEND_BACK';
  return null;
}
