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
 * TWO BRANCHES, SO TWO LEVELS OF LANDED
 * -------------------------------------
 * A code project names two branches in its `project_codebase` binding: its upstream, which is what
 * "on main" means for it, and its integration line, where its finished tasks land — the upstream
 * itself for a project that goes straight to main, a `project/<id>` branch for one that does not
 * (`docs/project-integration-line-contract.md` §1.4). Work merged into the project branch has
 * landed somewhere real, and it is not on main. So a task answers ON_UPSTREAM or
 * ON_INTEGRATION_LINE, and a criterion is LANDED only when all of its work is on the upstream;
 * work that has only reached the project branch reads ON_INTEGRATION_LINE. The two readings answer
 * two questions — "has this prerequisite landed" wants the task's, "is the project done" wants the
 * criterion's — and neither of them is a NOT_LANDED.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *  - It never moves `satisfied`. That field means "the work settled", it is decided where the
 *    clauses are folded, and this lane is about something else entirely. An unlanded criterion is
 *    not an unmet one, and turning UNKNOWN into a missing clause would be the false red above,
 *    wearing the derivation's vocabulary.
 *  - It gates nothing, and `project.status = 'DONE'` is still unguarded: 0223 recorded that the
 *    protection it removed was removed rather than relocated, and making a fact visible is not a
 *    way to reinstate a guard. The sentence that used to end this bullet — "no caller of this
 *    consults it before a write" — stopped being true on 2026-09-08, and is corrected rather
 *    than deleted because it is what a reader of this lane will have been told. One caller does:
 *    `project-done-derived.ts` folds this answer into a conjunction with `satisfied`, the
 *    separation-of-duties answer in `project-criterion-independence.ts` and the owner's
 *    standard-set confirmation, and writes what they project into `project.status`.
 *    That is a change of fact and not a loosening of 0229, which recorded the owner's choice not
 *    to put a narrower guard back: the owner was asked again on 2026-09-08 with that sentence
 *    quoted back to them and answered that the projection should be built, and a projection
 *    refuses nobody — everything that could set `status` before it can still set it. What this
 *    lane still does not do is decide. It hands that caller the same answer it hands a screen, and
 *    anything but LANDED there withholds DONE rather than asserting the work did not land.
 *  - UNKNOWN names no tasks, where an unmet clause names every task holding it up. That asymmetry
 *    is the point: naming "the serving tasks with no receipt" would be read as "these tasks did
 *    not land", which is the one thing this lane refuses to say.
 */
export type CriterionLanding = 'LANDED' | 'ON_INTEGRATION_LINE' | 'UNKNOWN';

/**
 * One task's answer, the unit a criterion's is folded from. `NOT_KNOWN` rather than a denial, for
 * the reason at the top of this file: a task with no receipt on either branch may still have landed
 * by a path that leaves none.
 */
export type TaskLanding = 'ON_UPSTREAM' | 'ON_INTEGRATION_LINE' | 'NOT_KNOWN';

/**
 * The two results that mean the source is in the target.
 *
 * `ALREADY_MERGED` counts, and leaving it out would be the whole bug in miniature: it is the
 * answer in the external fast-forward case — a branch an agent merged itself and Orbit found out
 * about afterwards — which is how most of this work actually lands.
 */
const LANDED_RESULTS: ReadonlyArray<string> = ['MERGED', 'ALREADY_MERGED'];

/**
 * The branches a receipt has to name to be evidence, for one project: its upstream, and the
 * integration line its tasks land on. Short names, because that is how a receipt spells
 * `target_branch` — the runner reports the branch it merged into, not a ref.
 */
export interface LandingBranches {
  upstream: readonly string[];
  integration: readonly string[];
}

/**
 * The branches of a project with no `project_codebase` binding, and the one place this lane names
 * main and master.
 *
 * They are the names the runner itself auto-detects when a merge names no target (`mergeToMain`
 * in `src/runner-go/worktree.go`: main, else master), so for a project that never said which
 * branch is its upstream this is the branch its receipts are about rather than a second convention
 * invented here. A project with a binding says it for itself and gets no fallback: guessing a
 * branch name is a convention of one repository, and this lane is about all of them.
 */
export const LEGACY_LANDING_BRANCHES: LandingBranches = {
  upstream: ['main', 'master'],
  integration: ['main', 'master'],
};

/** A binding's two refs, as `project_codebase` stores them: full names (PSC SR9). */
export interface LandingCodebase {
  upstreamRef: string;
  integrationRef: string;
}

/** The branch a full ref names, spelled the way a receipt spells it. A ref outside `refs/heads/` is
 *  not a branch anything merges into, and comes back whole, which no receipt matches. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** What counts as landed for one project: its binding's two branches, or the legacy pair without one. */
export function landingBranchesFor(codebase: LandingCodebase | null): LandingBranches {
  if (!codebase) return LEGACY_LANDING_BRANCHES;
  return {
    upstream: [branchName(codebase.upstreamRef)],
    integration: [branchName(codebase.integrationRef)],
  };
}

/** The two fields of a receipt that decide whether it is evidence of a landing. Kept structural so
 *  the fold is testable without Prisma. */
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
 * Whether one receipt is evidence that this work landed on either of the project's branches.
 *
 * Both halves are asked here rather than in the query's WHERE clause, so what "landed" MEANS is
 * one readable predicate in one place instead of a condition spread across a database filter and
 * a fold that no longer says what it is filtering for.
 */
export function receiptIsLandingEvidence(receipt: LandingReceiptFacts, branches: LandingBranches): boolean {
  return LANDED_RESULTS.includes(receipt.result)
    && (branches.upstream.includes(receipt.targetBranch)
      || branches.integration.includes(receipt.targetBranch));
}

/**
 * Where one task's work landed, by the best of its receipts: the upstream outranks the integration
 * line, because work on main is also everywhere a project branch will ever take it.
 */
export function taskLanding(
  receipts: ReadonlyArray<LandingReceiptFacts>,
  branches: LandingBranches,
): TaskLanding {
  const landed = receipts.filter((receipt) => LANDED_RESULTS.includes(receipt.result));
  if (landed.some((receipt) => branches.upstream.includes(receipt.targetBranch))) return 'ON_UPSTREAM';
  if (landed.some((receipt) => branches.integration.includes(receipt.targetBranch))) {
    return 'ON_INTEGRATION_LINE';
  }
  return 'NOT_KNOWN';
}

/**
 * The fold: one criterion is LANDED when every task serving it is on the upstream, and
 * ON_INTEGRATION_LINE when every one of them landed on one of the two branches and not all of them
 * on the upstream.
 *
 * A conjunction, for the same reason clause 2 of the work side's answer is one — three tasks serve
 * a criterion and one of them landed is not a criterion whose work is on main, and saying LANDED
 * there would be the false green this lane exists to break up. A criterion nobody serves has no
 * evidence to stand on either, so it is UNKNOWN rather than vacuously landed.
 */
export function criterionLanding(
  definitions: ReadonlyArray<CriterionWithLandingFacts>,
  branches: LandingBranches,
): CriterionLandingAnswer[] {
  return definitions.map((definition) => {
    const tasks = definition.servingTasks.map((task) => taskLanding(task.mergeReceipts, branches));
    let landing: CriterionLanding = 'UNKNOWN';
    if (tasks.length > 0 && tasks.every((task) => task === 'ON_UPSTREAM')) landing = 'LANDED';
    else if (tasks.length > 0 && !tasks.includes('NOT_KNOWN')) landing = 'ON_INTEGRATION_LINE';
    return { definitionId: definition.id, landing };
  });
}

/** One project's landing branches, off its primary binding. One statement. */
export async function readLandingBranches(
  prisma: Pick<PrismaService, 'projectCodebase'>,
  projectId: string,
): Promise<LandingBranches> {
  return landingBranchesFor(await prisma.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: { upstreamRef: true, integrationRef: true },
  }));
}

/**
 * Every criterion this project states, each with its serving work's merge receipts.
 *
 * One call, whose nested select carries every serving task's receipts with it — not one query per
 * criterion and not one per task. It reads the criterion rows again rather than borrowing the work
 * side's, which keeps this lane genuinely bolted on: the three clauses are untouched, and nothing
 * here can change the answer they fold.
 */
export function readCriterionLandingFacts(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionWithLandingFacts[]> {
  return prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    select: {
      id: true,
      servingTasks: {
        where: { ownerId },
        select: { mergeReceipts: { select: { result: true, targetBranch: true } } },
      },
    },
  });
}

/** Every criterion this project states, and where the work filed under each has landed. */
export async function readCriterionLanding(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition' | 'projectCodebase'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionLandingAnswer[]> {
  const [definitions, branches] = await Promise.all([
    readCriterionLandingFacts(prisma, ownerId, projectId),
    readLandingBranches(prisma, projectId),
  ]);
  return criterionLanding(definitions, branches);
}
