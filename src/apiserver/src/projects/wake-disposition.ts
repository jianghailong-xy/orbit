import type { CoordinatorWakeEvent, TaskSettlement } from './coordinator-wake';
import type { CriterionLanding } from './project-criterion-landing';

/**
 * Whether a committed fact changes what the coordinator would decide — and therefore whether it is
 * worth a judgment session at all.
 *
 * §0 — RECORDING IS UNCONDITIONAL; OPENING IS NOT
 * ===============================================
 * A wake row is cheap, idempotent and ageable, so every authorized fact leaves one. A judgment
 * session is none of those: it queues a runner, spends a model turn and produces a decision
 * somebody has to live with. Before this unit existed, every authorized wake went on to open one,
 * which made "was this worth thinking about" a question nothing asked.
 *
 * NOT OPENING IS NOT A REFUSAL. `REFUSED` means the wake was not allowed — the switch is off, the
 * project is gone, the convergence ledger says this project is no longer converging — and it
 * releases the fact's idempotency key so the same fact may be delivered again. What this unit
 * decides is what an ALLOWED wake is spent on, and every one of its answers is a terminal state
 * inside 0174's partial unique index: the fact goes on holding its key whichever it takes. A
 * reader of the ledger can therefore tell them apart — `REFUSED` was not permitted, `CONSUMED` was
 * recorded and nothing more, `SESSION_OPENED` was judged in a conversation opened for it, and
 * `DELIVERED` was handed to the conversation this project already had (§2.2).
 *
 * §1 — THE INPUT IS A CRITERION'S COVERAGE, NOT A TASK'S STATUS
 * =============================================================
 * "The task failed" is not the question. A coordinator reasons about whether the project's stated
 * conditions are still on their way to being met, so the input is what one acceptance criterion's
 * serving work says about that criterion — the same unit `CRITERION_READY` is cut in, and for the
 * same reason cutting per task is wrong at both ends.
 *
 * The two readings the project goal states, in this vocabulary:
 *
 *   * a task ends and the criterion it serves still has other work outstanding — `IN_FLIGHT`.
 *     Nothing changed: that outstanding work will finish, and the coordinator will be asked then.
 *   * a task fails and it was the only work serving a criterion — `STRANDED`. Everything changed:
 *     no work is going to deliver that criterion, and nothing but a decision can move it.
 *
 * §2 — A `BACKED` CRITERION OWES NO JUDGMENT, AND MAY STILL OWE A MERGE
 * =====================================================================
 * A criterion every serving task of which is DONE has run out of work too, and no JUDGMENT is
 * available about it. Whether the claim actually holds is the question this project states in as
 * many words that nothing in Orbit answers: the ruler is a person's editable list, and whoever
 * edits it can make any conclusion true. So a backed criterion is recorded, on the surface a
 * person reads, and no session is opened to decide something no session may decide. That much is
 * unchanged.
 *
 * What this paragraph claimed BEYOND that was wrong, and 2026-09-05 is what it cost. It concluded
 * that a finished criterion is nobody's next step AT ALL, and its evidence was a list of the
 * coordinator's moves: redispatch, succeed, split, cancel, escalate, file more work. Every item on
 * that list is a REPAIR, and repairs are what UNFINISHED work needs. The two moves that apply to
 * work which is finished were missing from it — MERGE IT, and RELEASE THE NEXT PIECE OF WORK —
 * so a list that happened to contain no counterexample was read as an argument that none exists.
 * A criterion's finished result then sat outside `main` for four hours, and the only thing that
 * would have noticed was a person deciding to look.
 *
 * The claim is therefore narrower than it was: a backed criterion owes nobody a judgment. It can
 * still owe a merge, and unlike "does the claim hold", "is a merge owed" is a question with an
 * answer nothing has to be believed for — `project-criterion-landing.ts` reads it off the merge
 * receipts, which is where a person reads it too.
 *
 * §2.1 — A MERGE IS OWED ONCE, SO IT IS ANSWERED ON THE FACT THAT REPORTS IT
 * =========================================================================
 * TWO facts are derived about one backed criterion, deliberately, for the reason the fifth door of
 * `completion-input-router.service.ts` gives: "the work is finished" and "the work is on nobody's
 * default branch" are read from rows written by different paths at different times, so folding
 * them into one event would key one fact on two independently moving projections.
 *
 * A merge, though, is owed once. Answering BOTH of those facts with a session would open two
 * sessions to perform one irreversible action — §0's loop with a merge in the middle of it, and
 * two coordinators racing each other for one branch. So the landing half of this rule is read for
 * the fact that REPORTS a landing, and every other fact about the same criterion is recorded,
 * exactly as §2 has always said.
 *
 * That is not the lookup table this rule was written to avoid, and the difference is worth stating
 * precisely. A lookup table answers FROM the event — kind X opens, kind Y records — and never
 * consults the world, which is why a case that paired two event kinds would prove nothing about
 * it. Here the event selects WHICH of a criterion's two independent conditions this fact is a
 * report of, and the answer still comes from the criterion's own rows: the same fact, delivered
 * again once those rows carry a receipt, is recorded rather than judged. And `STRANDED` is
 * selected by nothing at all — nothing is going to deliver that criterion, so every fact bearing
 * on it is answered whatever it was a report of.
 *
 * §2.2 — A MERGE IS OWED TO THE COORDINATOR THAT EXISTS, NOT TO A NEW ONE
 * =======================================================================
 * §2.1 settles WHICH fact is worth waking somebody for. Who gets woken is a second question, and
 * for this one fact the answer is not a fresh judgment session.
 *
 * `coordinator-judgment.service.ts` §0 argues that a JUDGMENT wants no continuity: the project's
 * state is in the database, so a one-shot conversation judges it as well as a long one and is
 * bounded, replayable and un-poisoned by its own earlier turns. That argument is about judging. It
 * does not carry to MERGING, and the difference is the one §2 already turns on — a merge is an
 * irreversible action owed exactly once, so two conversations that both believe they should
 * perform it are two coordinators racing for one branch. A project that has a standing coordinator
 * conversation has a row naming the one that is doing this work, and telling it is one message.
 *
 * The price is stated rather than hidden, because it is real and it is not solved here:
 *
 *   * a message is a NOTIFICATION, not an interrupt — Claude does not steer mid-turn, so a
 *     conversation that is running a turn reads it afterwards. This is enough for a merge that is
 *     already overdue and would not be enough for anything that had to stop what it interrupted;
 *   * context is finite, and a message is charged to every later turn of that conversation for the
 *     rest of its life. That is the reason this is one event kind and not every decisive fact:
 *     everything else stays exactly as §2 left it;
 *   * a message to a conversation nobody is watching is `HUMAN_INBOX` with extra steps. Changing
 *     the carrier does not make delivery reliable, and nothing here claims it does — what the
 *     ledger keeps is the fact, and a delivery that could not be made releases its key.
 *
 * §3 — A FACT THAT BEARS ON NO CRITERION CHANGES NO CRITERION'S COVERAGE
 * =====================================================================
 * Work that declares no criterion is work whose end moves nothing this unit can reason about, so
 * it is recorded and nothing more. That is the same choice `CRITERION_READY` makes about a
 * criterion nobody serves, and it is the honest one: the alternative is to open a session on the
 * strength of a task's status alone, which is the per-task cut §1 rejects.
 */

/** The statuses in which a task is still expected to deliver, with nobody deciding anything. */
export const PENDING_TASK_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

export function isPendingTaskStatus(status: string): boolean {
  return (PENDING_TASK_STATUSES as readonly string[]).includes(status);
}

/** What the work serving one acceptance criterion says about that criterion. */
export type CriterionCoverage =
  /** Work other than the one this fact is about is still expected to deliver it. */
  | 'IN_FLIGHT'
  /** Every task serving it is DONE. The claim is backed; §2 says that owes no judgment. */
  | 'BACKED'
  /** Nothing is going to deliver it and nothing did. Only a decision moves this criterion. */
  | 'STRANDED';

/**
 * Fold one criterion's serving work into its coverage.
 *
 * `endedTaskId` is the task whose attempt this fact is ABOUT, and it is excluded from the "still
 * expected to deliver" half on purpose: its run just ended, so whatever its status column says, it
 * is not work anybody is waiting on. It stays in the second half, because whether the criterion is
 * BACKED is a question about all of its work, including the piece that just stopped.
 *
 * An empty serving set is STRANDED rather than BACKED. `[].every` is vacuously true, and a
 * criterion nobody has filed any work against has not been met — it has not been attempted.
 */
export function criterionCoverage(
  serving: readonly TaskSettlement[],
  endedTaskId?: string,
): CriterionCoverage {
  const awaited = serving.filter((task) => task.taskId !== endedTaskId);
  if (awaited.some((task) => isPendingTaskStatus(task.status))) return 'IN_FLIGHT';
  if (serving.length === 0) return 'STRANDED';
  if (serving.every((task) => task.status === 'DONE')) return 'BACKED';
  return 'STRANDED';
}

/** What an authorized wake is spent on. All three are terminal; none of them is a refusal. */
export type WakeDisposition =
  /** Open the one judgment session this fact gets. */
  | 'OPEN_JUDGMENT'
  /** Hand it to the coordinator conversation this project already has. See §2.2. */
  | 'DELIVER_TO_COORDINATOR'
  /** Leave the ledger row and stop. The fact is durable, ageable, and nobody is interrupted. */
  | 'RECORD_ONLY';

/**
 * One criterion the fact bears on, in the two dimensions this rule reads.
 *
 * `landing` is `project-criterion-landing.ts`'s answer over that criterion's merge receipts,
 * borrowed rather than re-derived: which merge results count and which branch names count is one
 * reading in one module, and a second one here would be a second definition of "landed" able to
 * drift from the one a person is shown.
 */
export interface CriterionState {
  coverage: CriterionCoverage;
  landing: CriterionLanding;
}

/**
 * The decision, over what this fact reports about the criteria it bears on.
 *
 * One stranded criterion is enough, and it is enough whatever the fact was about: a fact that
 * leaves any stated condition with no work and no backing is a fact the coordinator has to answer,
 * whatever the rest of the project looks like. It is asked first so that the answer for a stranded
 * criterion cannot depend on the second clause, on a receipt, or on which fact arrived.
 *
 * The second clause is §2.1's, and §2.2's is what it answers WITH. It reads `!== 'LANDED'` rather
 * than `=== 'UNKNOWN'` because that is the question the merge receipts can answer:
 * `CriterionLanding` has no `NOT_LANDED` — absence of a receipt is absence of evidence — and what
 * owes a merge is work that is not KNOWN to be on the default branch, which is every value that is
 * not `LANDED` however many of them there come to be.
 *
 * The two decisive answers are deliberately different values rather than one with a flag beside
 * it. A stranded criterion needs a judgment and gets a conversation opened to make it; work that is
 * merely off the branch needs an action performed once and goes to the conversation already
 * performing them. Collapsing them would put this unit's caller in the position of asking the
 * event a second time to find out which it meant.
 */
export function wakeDisposition(
  event: CoordinatorWakeEvent,
  criteria: readonly CriterionState[],
): WakeDisposition {
  if (criteria.some((criterion) => criterion.coverage === 'STRANDED')) return 'OPEN_JUDGMENT';
  if (event === 'CRITERION_UNLANDED' && criteria.some(
    (criterion) => criterion.coverage === 'BACKED' && criterion.landing !== 'LANDED',
  )) {
    return 'DELIVER_TO_COORDINATOR';
  }
  return 'RECORD_ONLY';
}
