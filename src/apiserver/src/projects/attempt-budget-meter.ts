import {
  AttemptBudgetReport,
  AttemptSpend,
  evaluateAttemptBudget,
} from './attempt-budget';
import { AttemptBudget } from './convergence-contract';
import { WakeFact, attemptBudgetSpentFact } from './coordinator-wake';

/**
 * Unit T5: what a measured attempt owes the coordinator.
 *
 * §0 — WHY THIS IS THE MISSING EDGE
 * =================================
 * `attempt-budget.ts` already decides whether a budget is spent, and `coordinator-wake.ts` already
 * spells the fact that says so. Both were written and neither was ever joined to a running session,
 * so `ATTEMPT_BUDGET_SPENT` had a type, a key and a derivation — and no producer. This module is
 * the join, and the service beside it is the only thing here that touches a session.
 *
 * The sentence the whole unit is for (`attempt-budget.ts` §0): the incident's hundreds of rounds
 * never crossed an attempt line because they were never hundreds of attempts. They were ONE session
 * steered hundreds of times — no new attempt, no new fingerprint, busy the whole way. So what is
 * wired here is bound to the ATTEMPT (one Session under one Task scope revision, AT1), not to a
 * turn and not to a steer, because those are exactly the units the incident produced without limit.
 *
 * §1 — PURE, FOR THE REASON EVERYTHING AROUND IT IS
 * =================================================
 * No clock, no database, no session: `now` and the measured spend arrive as arguments, so a budget
 * decision replays byte for byte. `evaluateAttemptBudget` is called rather than re-implemented and
 * `attemptBudgetSpentFact` is imported rather than re-spelled — a second spelling of either would
 * be a second answer to "did this attempt stop", which is the one question that must have one.
 *
 * §2 — THE DIMENSION IS NOT IN THE KEY
 * ====================================
 * `attemptBudgetSpentFact` keys on the attempt's SESSION and carries the dimension in `detail`, so
 * an attempt that crosses two lines in one moment wakes the coordinator once. That is also why this
 * function may be called on every turn without any state of its own to remember whether it already
 * fired: the second call re-derives the same key and the wake ledger's partial unique index answers
 * `ALREADY_AWAKE`. Idempotence by identity rather than by a flag somebody has to maintain.
 */

/**
 * The two answers a measurement produces: what was read, and what is owed because of it.
 *
 * `fact` is null exactly when `report.exhausted` is — kept as a field rather than left for the
 * caller to re-derive, because a caller that re-derives it can derive a different one.
 */
export interface AttemptBudgetVerdict {
  report: AttemptBudgetReport;
  fact: WakeFact | null;
}

/** Who the fact is about. Ids as the database holds them; the wake ledger stores raw uuids. */
export interface MeteredAttempt {
  projectId: string;
  taskId: string;
  sessionId: string;
}

/**
 * Measure one attempt against the budget it was FROZEN against, and say what that owes.
 *
 * The budget is the attempt's own (BD5), never the project's current policy: a policy edit
 * mid-flight that could end a running attempt — or revive one already asked to stop — is a result
 * being overwritten by another result. `SessionAttemptService.open` is what freezes it, out of
 * `project.attempt_budget` through `resolveAttemptBudget`, which is why a project sitting at NULL
 * (every project in production) is judged by `DEFAULT_ATTEMPT_BUDGET` rather than by nothing.
 *
 * BD1's order is `ATTEMPT_BUDGET_DIMENSIONS`' array order and is not restated here — the array is
 * the contract, `evaluateAttemptBudget` reads it, and this function reports whatever it says came
 * first. `COORDINATOR_STEERS` is a dimension like the other five FOR THIS PURPOSE: it produces the
 * fact, because a coordinator out of steers is precisely a coordinator that has to be told to open
 * a fresh generation instead of saying "keep going" again. What it does NOT produce is a wind-down
 * — `report.windDownRequired` is false for it — because it bounds the coordinator rather than the
 * worker, and stopping a worker that is already finishing is not something the coordinator's own
 * exhausted allowance has any business doing.
 */
export function meterAttempt(
  attempt: MeteredAttempt,
  budget: AttemptBudget,
  spent: AttemptSpend,
): AttemptBudgetVerdict {
  const report = evaluateAttemptBudget(budget, spent);
  if (report.exhausted === null) return { report, fact: null };
  return {
    report,
    fact: attemptBudgetSpentFact({
      projectId: attempt.projectId,
      taskId: attempt.taskId,
      sessionId: attempt.sessionId,
      dimension: report.exhausted,
    }),
  };
}

/**
 * Why a budget-spent wake was refused: the project has no coordinator to wake.
 *
 * The cheap refusal, composed BEFORE `CoordinatorConvergenceService.authorizeWake`, because a
 * judgment recorded there charges the project's convergence budget — and charging a project that
 * never asked for a coordinator would raise `COORDINATOR_NO_PROGRESS` blockers against projects
 * that are not being coordinated at all.
 *
 * A refusal releases the key rather than burning it (migration 0172's PARTIAL unique index), so a
 * project whose coordinator is switched on later is still woken by the same attempt's fact the next
 * time it is metered. That is the property `project_action` did not have, and one refusal on it
 * welded the coordinator rotation path shut for good.
 *
 * The price is one refused row per turn for as long as an exhausted attempt keeps turning, and it
 * is bounded rather than open-ended: five of the six dimensions move the attempt to `WINDING_DOWN`
 * on the pass that finds them spent, and the sixth cannot be reached on a project with no
 * coordinator, because a coordinator that does not exist charges no steers.
 *
 * Declared here rather than imported because unit T6 owns the closed set of refusal codes and has
 * not landed; `coordinator-convergence.ts` declares `PROJECT_NOT_CONVERGING` its own way for the
 * same reason.
 */
export const COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';
