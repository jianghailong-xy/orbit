import type { PrismaService } from '../prisma/prisma.service';

/**
 * "Did the work land?" — a fourth fact about a stated criterion, read from merge receipts and
 * served BESIDE the work side's answer rather than folded into it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `satisfied` says the work filed under a criterion has SETTLED. For an EXECUTABLE task that means
 * its declared command ran and agreed with its declared exit code — in the task session's OWN
 * worktree, on a branch, with no statement of any kind about the default branch. On 2026-09-04 the
 * two came apart in life: a criterion read `satisfied` while the migration that implemented it did
 * not exist on `main` at all. Nothing was wrong with the derivation. It answered the question it
 * was asked, and "is this on main" is a different question that nobody was asking.
 *
 * Serving `satisfied` to people made that gap worth closing, because a green light on a screen is
 * read as "done", and the one thing the reader most wants to know next is whether the work is
 * anywhere they can get at it.
 *
 * THE PATH THIS PROJECT CHOSE, AND WHY
 * ------------------------------------
 * The owner and the coordinating session settled on: READ THE MERGE RECEIPTS, and publish the
 * answer as an ADDITIONAL fact. `SessionMergeReceipt` (table `session_merge_receipt`) is already
 * the durable record of a merge HOWEVER it was made — including the case these branches are
 * actually merged in, an agent running `git merge --ff-only` in its own worktree — which is
 * precisely why `session.merge_status` could not be this answer and why that table was built. And
 * it is cheap: `task_id` and `project_id` are denormalised onto every receipt so that, in the
 * schema's own words, "which merges does this project's acceptance get to stand on" is one indexed
 * read. This lane reads receipts through `task_id`, off the serving work each criterion already
 * has.
 *
 * The alternatives were not free and were not chosen. Asking a repository would mean the API
 * server resolving refs it has no checkout for. Comparing SHAs would mean storing a baseline
 * nobody records today. Both are a different unit of work; the receipts are already written, by
 * three writers, for exactly this question.
 *
 * WHY THREE-VALUED, AND NOT A BOOLEAN
 * -----------------------------------
 * The honest logic here has THREE values — landed, not landed, and unknown — and only two of them
 * are ever knowable from a receipt table. A boolean has room for two, so adopting one forces a
 * collapse, and the only collapse available is "no receipt ⇒ not landed". That reading is FALSE:
 * `session_merge` has paths that land work without leaving a receipt behind (again, the very
 * observation this table was created for), so absence of a receipt is absence of EVIDENCE, not
 * evidence of absence. A boolean would therefore trade today's false green for a false red — the
 * same lie, told in the other direction, and a worse one to act on because a reader chasing a
 * merge that already happened has nothing to find.
 *
 * So the third value is not merely never produced: `NOT_LANDED` is absent from
 * {@link CriterionLanding} altogether. There is no evidence this read can obtain that would
 * justify asserting it, and a value in the type is an invitation to somebody to assert it later.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *  - It never moves `satisfied`. That field means "the work settled", it is decided where the
 *    clauses are folded, and this lane is about something else entirely. An unlanded criterion is
 *    not an unmet one, and turning UNKNOWN into a missing clause would be the false red above,
 *    wearing the derivation's vocabulary.
 *  - It gates nothing. `project.status = 'DONE'` is unguarded — 0223 recorded that the protection
 *    it removed was removed rather than relocated, and 0229 recorded the owner's choice not to put
 *    a narrower one back. Making a fact visible is not a way to reinstate a guard, and no caller
 *    of this consults it before a write.
 *  - UNKNOWN names no tasks, where an unmet clause names every task holding it up. That asymmetry
 *    is the point: naming "the serving tasks with no receipt" would be read as "these tasks did
 *    not land", which is the one thing this lane refuses to say.
 */
export type CriterionLanding = 'LANDED' | 'UNKNOWN';

/**
 * The two results that mean the source is in the target.
 *
 * `ALREADY_MERGED` counts, and leaving it out would be the whole bug in miniature: it is the
 * answer in the external fast-forward case — a branch an agent merged itself and Orbit found out
 * about afterwards — which is how most of this work actually lands.
 */
const LANDED_RESULTS: ReadonlyArray<string> = ['MERGED', 'ALREADY_MERGED'];

/**
 * What "the default branch" is, from a process with no repository to ask.
 *
 * These are the names the runner itself auto-detects when a merge names no target (`mergeToMain`
 * in `src/runner-go/worktree.go`: main, else master), so this is the same branch the receipt is
 * about rather than a second convention invented here. A receipt into any OTHER branch is a real
 * merge into somewhere else: it is evidence about that branch and no evidence at all about this
 * one, so it leaves the answer UNKNOWN — never NOT_LANDED.
 */
const DEFAULT_BRANCH_NAMES: ReadonlyArray<string> = ['main', 'master'];

/** The two fields of a receipt that decide whether it is evidence of a landing on the default
 *  branch. Kept structural so the fold is testable without Prisma. */
export interface LandingReceiptFacts {
  result: string;
  targetBranch: string;
}

/**
 * One piece of work serving a criterion, as this lane needs it: nothing but the merges recorded
 * against its session branches. It carries no identity on purpose — a task is named here only when
 * something can be said about it, and "has no receipt" is not something that can be said.
 */
export interface LandingServingTask {
  mergeReceipts: ReadonlyArray<LandingReceiptFacts>;
}

/** The rows the fold needs: one criterion's identity and its serving work's receipts. */
export interface CriterionWithLandingFacts {
  id: string;
  servingTasks: ReadonlyArray<LandingServingTask>;
}

/** One criterion's landing answer, addressed the same way the satisfaction answer is. */
export interface CriterionLandingAnswer {
  definitionId: string;
  landing: CriterionLanding;
}

/**
 * Whether one receipt is evidence that this work is on the default branch.
 *
 * Both halves are asked here rather than in the query's WHERE clause, so what "landed" MEANS is
 * one readable predicate in one place instead of a condition spread across a database filter and
 * a fold that no longer says what it is filtering for.
 */
export function receiptIsLandingEvidence(receipt: LandingReceiptFacts): boolean {
  return LANDED_RESULTS.includes(receipt.result)
    && DEFAULT_BRANCH_NAMES.includes(receipt.targetBranch);
}

/**
 * The fold: one criterion is LANDED when every task serving it has landing evidence.
 *
 * A conjunction, for the same reason clause 2 of the work side's answer is one — three tasks serve
 * a criterion and one of them landed is not a criterion whose work is on main, and saying LANDED
 * there would be the false green this lane exists to break up. A criterion nobody serves has no
 * evidence to stand on either, so it is UNKNOWN rather than vacuously landed.
 */
export function criterionLanding(
  definitions: ReadonlyArray<CriterionWithLandingFacts>,
): CriterionLandingAnswer[] {
  return definitions.map((definition) => ({
    definitionId: definition.id,
    landing:
      definition.servingTasks.length > 0
        && definition.servingTasks.every((task) => task.mergeReceipts.some(receiptIsLandingEvidence))
        ? 'LANDED'
        : 'UNKNOWN',
  }));
}

/**
 * Every criterion this project states, and whether the work filed under each has a merge receipt
 * putting it on the default branch.
 *
 * One call, whose nested select carries every serving task's receipts with it — not one query per
 * criterion and not one per task. It reads the criterion rows again rather than borrowing the work
 * side's, which keeps this lane genuinely bolted on: the three clauses are untouched, and nothing
 * here can change the answer they fold.
 */
export async function readCriterionLanding(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionLandingAnswer[]> {
  const definitions = await prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    select: {
      id: true,
      servingTasks: {
        where: { ownerId },
        select: { mergeReceipts: { select: { result: true, targetBranch: true } } },
      },
    },
  });
  return criterionLanding(definitions);
}
