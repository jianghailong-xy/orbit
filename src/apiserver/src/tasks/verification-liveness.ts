/**
 * `[K5]`: which of §13.3's epoch gates will resolve on their own, and which are waiting for nobody.
 *
 * `[H0V2]`'s independent audit closed on one residue and two observations, and all three are the
 * same sentence. `verificationEpochGate` answers WHY a subject's PASS epoch is shut, and every
 * caller then reads that answer through one static set — `VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN`
 * — whose comment promises that "everything else resolves on its own as the check runs". For three
 * of the gates outside that set the promise is simply false:
 *
 *   - `VERDICT_ABSENT`: the check is DONE and recorded nothing. A DONE row is never dispatched
 *     again, so no run will ever conclude it. This is the shape the audit found in 20 of 13200
 *     snapshots, where `recompute` writes nothing, `gapReason` opens nothing, §13.2 raises nothing,
 *     and the whole of the control loop's response is one WARN every sixty seconds.
 *   - `VERDICT_UNREVISIONED`: a PASS written before migration 0124. There is no revision, therefore
 *     no action identity, therefore nothing that could ever apply it.
 *   - `RUN_NOT_SETTLED` with no live run: the check is DONE and its run was completed or cancelled
 *     out from under it. Nothing is running and nothing will start.
 *
 * None of these is a SAFETY defect — downstream stays blocked, which is correct — and that is
 * exactly why it survived: the loop is wrong about liveness in a direction no test of "does it let
 * the wrong thing through" can see. What it costs is the thing this whole project exists to end:
 * a project that is stopped and says so nowhere.
 *
 * Pure, and factored out rather than written into each caller, because three faces read it — the
 * dependency reduction (BLOCKED vs BLOCKED_FAILED), §13.1 AG7's gap, and §11's blocker row — and
 * a second copy of "can this fix itself" is a second answer waiting to disagree with the first.
 */

import { TASK_OCCUPYING } from './reclaim-stalled-task';
import { RunStatus } from '@orbit/shared';
import type { VerificationEpochCheckFact, VerificationEpochGate } from './verification-dependency';

/**
 * What has to happen for a shut epoch to open, and who can make it happen.
 *
 * `WAITING` is a promise: something already in motion — a run, or the coordinator's next pass —
 * will resolve this without anybody being told. `STALLED` is its negation, and it carries the two
 * things a wait does not have to carry, because a wait ends by itself and a stall does not.
 */
export type VerificationLiveness =
  | { state: 'WAITING' }
  | {
    state: 'STALLED';
    /** Why nothing will move it. Stable code: it is written to a blocker row and read back. */
    reason: VerificationStallReason;
    /** §11.1: what has to happen. One sentence, addressed to `owner`. */
    requiredAction: string;
    /** §11.1: who can do it. `COORDINATOR` only where the loop really can act alone. */
    owner: 'USER' | 'COORDINATOR';
  };

/**
 * The stalls, named apart because they send a reader to different places.
 *
 * `CONCLUDED_NOTHING` is a check that ran and finished with no answer — look at the run. `NO_RUN`
 * is a check nothing ever ran, or whose run was taken away — look at why the session ended.
 * `UNREVISIONED_VERDICT` is data older than the mechanism that applies verdicts — re-run it.
 * `VERDICT_APPLY_EXHAUSTED` is the conclusion existing and its APPLY having failed to its bound —
 * look at the refusal. The three the epoch already escalated keep their own names so a caller can
 * report all of them in one vocabulary rather than switching between two.
 */
export type VerificationStallReason =
  | 'CONCLUDED_NOTHING'
  | 'NO_RUN'
  | 'UNREVISIONED_VERDICT'
  /** `[K5]`: the conclusion exists and the action that makes it durable ran out of attempts. */
  | 'VERDICT_APPLY_EXHAUSTED'
  | 'CONCLUDED_FAIL'
  | 'CONCLUDED_INCONCLUSIVE'
  | 'NO_LIVE_CHECK';

/** Does this check have a run that is still going? The one fact that separates a wait from a stall
 *  for `RUN_NOT_SETTLED` — and the reason this cannot be a lookup on the gate alone. */
export function hasLiveRun(check: VerificationEpochCheckFact): boolean {
  return check.runs.some((run) => run.deletedAt == null
    && TASK_OCCUPYING.includes(run.runStatus as RunStatus));
}

/** Has anything ever run this check at all? `NO_RUN` versus "a run was taken away" read the same
 *  to the epoch and differently to a person, so both land on `NO_RUN` and the detail says which. */
export function hasAnyRun(check: VerificationEpochCheckFact): boolean {
  return check.runs.some((run) => run.deletedAt == null && run.runStatus !== RunStatus.PENDING);
}

/**
 * The one rule, for one shut epoch.
 *
 * `newest` is the check the gate was decided on — `verificationEpochGate` picks the newest live
 * one and answers about it, so answering about any other row here would describe a different world
 * than the gate does.
 *
 * `null` for an open epoch: there is nothing to be waiting for.
 */
export function verificationLiveness(
  gate: VerificationEpochGate | null,
  newest: VerificationEpochCheckFact | null,
): VerificationLiveness {
  switch (gate) {
    case null:
      return { state: 'WAITING' };

    // The three the epoch already escalates. Restated here rather than deferred to the static set,
    // so that every caller can ask ONE function and get one vocabulary back.
    case 'VERIFICATION_FAILED':
      return {
        state: 'STALLED',
        reason: 'CONCLUDED_FAIL',
        requiredAction: 'fix what the check found, then re-run it',
        owner: 'COORDINATOR',
      };
    case 'VERIFICATION_INCONCLUSIVE':
      return {
        state: 'STALLED',
        reason: 'CONCLUDED_INCONCLUSIVE',
        requiredAction: 're-run the check so it can reach a conclusion',
        owner: 'COORDINATOR',
      };
    case 'NO_LIVE_VERIFICATION':
      return {
        state: 'STALLED',
        reason: 'NO_LIVE_CHECK',
        requiredAction: 'file a verification of this task that can conclude',
        owner: 'COORDINATOR',
      };

    // `[H0V2]`'s residue. A DONE check that recorded nothing is not an unfinished check: it is a
    // finished one with no answer, and the difference is that no event exists which would give it
    // one. The subject cannot complete, everything downstream is blocked, and until this row nobody
    // was told. Owned by a USER because the loop must NOT answer it by filing another check — the
    // old one still counts toward the epoch, so an automatic re-file would produce one more check
    // per pass, for ever, and each of them could end the same way.
    case 'VERDICT_ABSENT':
      return {
        state: 'STALLED',
        reason: 'CONCLUDED_NOTHING',
        requiredAction:
          'the check finished without recording a verdict: record one, or cancel it and file a '
          + 'replacement — it will not conclude on its own',
        owner: 'USER',
      };
    case 'VERDICT_UNREVISIONED':
      return {
        state: 'STALLED',
        reason: 'UNREVISIONED_VERDICT',
        requiredAction:
          'this PASS predates verdict revisions and can never be applied: cancel the check and '
          + 'file a replacement',
        owner: 'USER',
      };

    // The one gate whose answer is a function of the facts rather than of the gate. A live run WILL
    // end, one way or another, and the epoch is re-read when it does.
    case 'RUN_NOT_SETTLED':
      if (newest && hasLiveRun(newest)) return { state: 'WAITING' };
      return {
        state: 'STALLED',
        reason: 'NO_RUN',
        requiredAction: newest && hasAnyRun(newest)
          ? 'the check\'s run ended without finishing the task (it was completed or cancelled): '
            + 'cancel the check and file a replacement'
          : 'the check reached DONE with nothing having run it: cancel it and file a replacement',
        owner: 'USER',
      };

    // `[K5]` criterion 7. Ordinarily a wait: the conclusion is recorded and the coordinator's next
    // pass makes it durable, which is a pass that is already scheduled. What made that sentence
    // false was the ledger, not the clock — the action key is permanent, and a refusal used to
    // retire it, so "the next pass will do it" described a pass that could no longer propose it.
    //
    // The retries are bounded now, and when they are spent the ledger says so. THAT is the stall:
    // the check has a verdict, the subject can never reach the PASS its policy waits for, and no
    // pass is going to change either fact. Asked of the same row the gate was decided on, so the
    // two faces cannot describe different worlds.
    case 'VERDICT_NOT_APPLIED':
      if (!newest?.verdictApplyExhausted) return { state: 'WAITING' };
      return {
        state: 'STALLED',
        reason: 'VERDICT_APPLY_EXHAUSTED',
        requiredAction:
          'the verdict was recorded but could not be applied within its retry budget: read the '
          + 'refusal on the action, resolve what it names, then revoke and re-record the verdict '
          + 'to give it a fresh revision',
        owner: 'USER',
      };

    // Genuine waits. `VERIFICATION_IN_FLIGHT` ends when the run does; `SUBJECT_NOT_DONE` ends when
    // the work is finished again. Neither needs a person told about it.
    case 'VERIFICATION_IN_FLIGHT':
    case 'SUBJECT_NOT_DONE':
      return { state: 'WAITING' };
  }
  return { state: 'WAITING' };
}

/** `verificationLiveness(...).state === 'STALLED'`, for the callers that only need the boolean. */
export function verificationGateStalled(
  gate: VerificationEpochGate | null,
  newest: VerificationEpochCheckFact | null,
): boolean {
  return verificationLiveness(gate, newest).state === 'STALLED';
}
