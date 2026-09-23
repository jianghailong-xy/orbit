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
 * ON_INTEGRATION_LINE, and a criterion is LANDED only when all of its work THAT HAS A COMMIT TO LAND
 * is on the upstream; work that has only reached the project branch reads ON_INTEGRATION_LINE. The
 * two readings answer two questions — "has this prerequisite landed" wants the task's, "is the
 * project done" wants the criterion's — and neither of them is a NOT_LANDED.
 *
 * WORK THAT WAS NEVER GOING TO LAND
 * ---------------------------------
 * One kind of serving task breaks that conjunction and always did: work that declares it needs no
 * code. An acceptance task whose deliverable is evidence, a documentation task inside a code project
 * — SR5's escape hatch, recorded on the task itself as `codeless` — resolves no source, so it has no
 * branch, and no receipt can ever put its work on `main`. A criterion demanding a landing from one
 * was demanding something that was never going to exist. On 2026-09-22 a project of 48 finished
 * tasks could not reach DONE for exactly this reason: its criterion 12 was served by two landed
 * tasks and one zero-commit acceptance task, and it read ON_INTEGRATION_LINE for ever.
 *
 * The declaration was the first half of the answer, and honouring it was not enough: the same
 * project went on reading ON_INTEGRATION_LINE for the same criterion afterwards. The task holding it
 * declares nothing, and cannot be made to — `codeless` is written when a task is created and no door
 * writes it afterwards, so a task created without it can never gain it. What it has instead is a
 * better fact, and the LINE's own: it ran a branch, committed nothing to it, and when the line was
 * handed that branch — after the session that ran it had finished with it — it answered that the tip
 * was already ON THE UPSTREAM. That answer is §2.2's `ALREADY_LANDED`, it is on the task's own job
 * row, and it says what SR27's rule says one contract over — there was nothing of this task's to
 * land, because it never had a commit of its own.
 *
 * §2.5 J9 already exempts the very same tasks from a dependent's wait, in SR27's words: a "write the
 * docs" prerequisite must not make the task after it demand a checkpoint that was never going to
 * exist. This lane reads the same declaration through `taskHasNothingToLand`, and the line's answer
 * beside it, and lets such work out of the roll-up. Neither is a way round the landing judgment: a
 * task that ran a branch and HAS commits of its own keeps participating, whatever its newest session
 * looks like and whatever its title says, and work on the project branch keeps reading
 * ON_INTEGRATION_LINE. `taskHasNothingToLand` is the whole of what gets anything out.
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
export const LANDED_RESULTS: ReadonlyArray<string> = ['MERGED', 'ALREADY_MERGED'];

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
 * One integration job's facts, as the fold reads them (§2.2 J-T5): what the line answered about the
 * branch it was handed, the three tips that answer was computed against, and what the work session
 * that branch belongs to had reported by then (`jobSawTheFinishedBranch`).
 *
 * Kept structural for the same reason the receipts are — it is what `integrate.go`'s result carries
 * up, and the fold's own reading of an `ALREADY_LANDED` is a statement about these columns rather
 * than about a repository this process has no checkout for.
 */
export interface LandingJobFacts {
  state: string;
  /** The merge of the upstream into the target this job made, when it made one (J-S2). */
  mainSyncSha: string | null;
  /** The target tip this job worked from. */
  targetShaBefore: string | null;
  /** The upstream tip the same job read, in the same fetch. */
  upstreamSha: string | null;
  /** The branch the line was handed: `refs/heads/<session branch>`, frozen at enqueue (J-T1a). */
  sourceRef: string;
  /** The job's first claim. The runner resolves the branch after it (J-S1), so no answer is older. */
  startedAt: Date | null;
  /** The work session the landing was queued for. Null once that session row is gone. */
  session: LandingJobSessionFacts | null;
}

/** What a work session's runner reported when it finished with the worktree (its finalize). */
export interface LandingJobSessionFacts {
  /** When that report was recorded, which is after the runner's last commit to the branch. */
  finishedAt: Date | null;
  /** The branch the checkout's HEAD was on when it finished. */
  worktreeBranch: string | null;
  /** Whether finishing left anything uncommitted in the checkout. */
  worktreeDirty: boolean | null;
}

/**
 * One piece of work serving a criterion, as this lane needs it: whether it has a commit to land at
 * all, and nothing else but the merges and the line's answers recorded against it. It carries no
 * identity on purpose — a task is named here only when something can be said about it, and "has no
 * receipt" is not something that can be said.
 *
 * `codeless` is §1.1 `isCodeTask`'s first half, and `taskHasNothingToLand` below is what reads it.
 */
export interface LandingServingTask {
  codeless: boolean;
  mergeReceipts: ReadonlyArray<LandingReceiptFacts>;
  integrationJobs: ReadonlyArray<LandingJobFacts>;
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

/** A full ref as its branch name, in SQL — the same `branchName` fold one expression over. */
export function branchNameSql(ref: string): string {
  return `regexp_replace(${ref}, '^refs/heads/', '')`;
}

/**
 * `taskLanding` (§1.4) as SQL, correlated to a TASK alias: which side of the line this task's work
 * is on, as the three-valued answer the TypeScript fold gives.
 *
 * The same three values and the same precedence: upstream wins, because work on main is also
 * everywhere the project branch will ever take it. A task in a project with no binding answers
 * `NOT_KNOWN` — the legacy pair is deliberately NOT applied here, since this exists to classify a
 * project's finished work against the line that project actually has, and one it does not have
 * cannot put work anywhere.
 */
export function taskLandingSql(alias: string): string {
  const results = LANDED_RESULTS.map((result) => `'${result}'`).join(', ');
  const receiptOn = (ref: string) => `EXISTS (
        SELECT 1 FROM "session_merge_receipt" landing_receipt
          JOIN "project_codebase" receipt_line
            ON receipt_line."project_id" = ${alias}."project_id"
           AND receipt_line."slot" = 'primary'
         WHERE landing_receipt."task_id" = ${alias}."id"
           AND landing_receipt."result" IN (${results})
           AND landing_receipt."target_branch" = ${branchNameSql(`receipt_line."${ref}"`)}
      )`;
  return `CASE
      WHEN ${receiptOn('upstream_ref')} THEN 'ON_UPSTREAM'
      WHEN ${receiptOn('integration_ref')} THEN 'ON_INTEGRATION_LINE'
      ELSE 'NOT_KNOWN'
    END`;
}

/**
 * `isCodeTask` (§1.1) as SQL: work that has a commit to land at all.
 *
 * Its newest work session ran in a worktree on a branch, and the row is not declared codeless. The
 * negation of the middle two disjuncts of `prerequisiteLandedSql`, stated positively because this
 * asks the question the other way round — that one asks "is there nothing left to wait for", this
 * asks "is this the kind of work that lands".
 */
export function isCodeTaskSql(alias: string): string {
  return `(
      ${alias}."project_id" IS NOT NULL
      AND ${alias}."codeless" = false
      AND EXISTS (
        SELECT 1 FROM "session" code_work
         WHERE code_work."id" = (
                 SELECT newest_work."id" FROM "session" newest_work
                  WHERE newest_work."task_id" = ${alias}."id"
                    AND newest_work."starts_task_work" = true
                    AND newest_work."deleted_at" IS NULL
                  ORDER BY newest_work."created_at" DESC, newest_work."id" DESC
                  LIMIT 1
               )
           AND code_work."isolation_status" = 'worktree'
           AND code_work."branch" IS NOT NULL
      )
    )`;
}

/** `lineStarted` (§1.1) as SQL: this task's project has a binding that has begun integrating. */
export function lineStartedSql(alias: string): string {
  return `EXISTS (
      SELECT 1 FROM "project_codebase" started_line
       WHERE started_line."project_id" = ${alias}."project_id"
         AND started_line."slot" = 'primary'
         AND started_line."integration_started_at" IS NOT NULL
    )`;
}

/**
 * Whether this job is the line saying, in its own words, that the branch it was handed had nothing
 * on it that the upstream did not already have.
 *
 * `ALREADY_LANDED` is §2.4 J-S3's answer, and on its own it is NOT that statement. The runner
 * reaches it by asking whether the source tip is an ancestor of the base it is working from, and for
 * a project with a line of its own that base is the TARGET — so a branch whose work was merged into
 * the project branch an hour ago and a branch that carries nothing at all are answered identically.
 * The other two conditions are what makes the base the UPSTREAM instead:
 *
 *  - no merge of the upstream into the target ran (`main_sync_sha` is null), so the base is the
 *    target tip itself rather than a commit that absorbed the upstream into it; and
 *  - the target tip was the same commit as the upstream tip (`target_sha_before = upstream_sha`),
 *    read by the same fetch.
 *
 * Together: `isAncestor(sourceSha, targetTip)` where the target tip IS the upstream tip — the tip,
 * and with it every commit the branch carried, is on the upstream. The line observed the branch and
 * found no commit of its own on it. Nothing here resolves ancestry: the answer is what the runner
 * resolved, and these are the columns it reports beside it.
 *
 * What it does NOT cover, said here rather than left to be discovered: an answer computed against a
 * line that has moved PAST the upstream proves only that the tip is inside the LINE, and a task whose
 * branch is offered to such a line goes on withholding LANDED. That is not a new answer — it is the
 * one this lane has always given where it cannot tell, and withholding is the safe direction.
 *
 * And the OTHER reading of "it never had a commit of its own" — the branch never moved from the
 * commit it forked at — is not in this data, which is why the fact is read off the job instead of
 * off the session: `session.source_base_sha` is the column that would hold the fork point, and it is
 * null on 4,560 of the 4,580 worktree sessions on this deployment (measured 2026-09-22), while
 * `base_sha` beside it is healed by `resolveBaseSha` on reclaim to serve the diff view (SR13) and is
 * not the fork point either. A fact a table does not carry cannot be one this lane decides by.
 *
 * A moment: the row records what was true when it was computed, nothing rewrites a terminal job (the
 * schema's `project_integration_job_terminal_guard`), and the upstream losing a commit is the one
 * direction a default branch does not move. The line growing past the upstream afterwards cannot
 * hurt either: at the moment of this observation the line WAS the upstream. What CAN move afterwards
 * is the branch itself, which is why this answer lets nothing out on its own — see
 * `jobSawTheFinishedBranch`.
 */
export function jobSawTipOnUpstream(job: LandingJobFacts): boolean {
  return job.state === 'ALREADY_LANDED'
    && job.mainSyncSha === null
    && job.targetShaBefore !== null
    && job.targetShaBefore === job.upstreamSha;
}

/**
 * Whether the branch the line looked at is the one this task's work ENDED on, looked at after it
 * ended — the condition under which `jobSawTipOnUpstream` speaks for everything the session left,
 * and not for a branch that went on growing after the line looked.
 *
 * That answer is true of one branch at one moment, and "this task never had a commit of its own" is a
 * claim about all of its work. Three things stand between the two, and each has happened:
 *
 *  - THE MOMENT. The runner commits a worktree when it finishes the session, and a landing is queued
 *    by the DONE that ends it (J-T1a), so the line can be handed the branch before the commit that
 *    carries the work exists. On 2026-09-22 the first delivery of this very rule was lost that way:
 *    the line answered ALREADY_LANDED at 04:23:09Z and the commit appeared at 04:23:24Z, on a branch
 *    nothing offers the line a second time. The finish is recorded as `session.finished_at` after
 *    that commit, and a job first claimed later than it saw every commit the session made. 2 of the
 *    14 upstream answers on this deployment were taken before their session finished (measured
 *    2026-09-23) — both on branches that stayed empty, but an answer that turned out true by timing is
 *    not one this lane can stand on.
 *  - THE BRANCH. The line is handed the branch the session was started on. An agent that runs
 *    `git checkout -b` in its checkout commits somewhere else, and the finish reports where HEAD
 *    ended as `worktree_branch` (a different branch on 20 of the 4,758 worktree sessions here). The
 *    answer is about the task's work only when the two are the same branch.
 *  - WHAT WAS LEFT UNCOMMITTED. A finish that could not commit everything says so (`worktree_dirty`),
 *    and what it left can still reach the branch later, from the session's own Commit action.
 *
 * Every condition withholds and none can grant: a session never finished, a runner too old to say
 * where HEAD was, a session row that is gone — each reads as "cannot tell", the answer this lane has
 * always given where it cannot. And reviving the session clears `finished_at` and finishing it again
 * writes a later one, so an answer about a branch that went back to work stops counting by itself.
 *
 * This reads a session, and it is not §1.1's second half, which `taskHasNothingToLand` refuses to
 * read: that half asks which session is NEWEST and lets a task out when it took no worktree. This
 * asks about the session the line was handed, and can only keep a task in.
 */
export function jobSawTheFinishedBranch(job: LandingJobFacts): boolean {
  const session = job.session;
  return session !== null
    && job.startedAt !== null
    && session.finishedAt !== null
    && job.startedAt.getTime() > session.finishedAt.getTime()
    && session.worktreeBranch !== null
    && branchName(job.sourceRef) === session.worktreeBranch
    && session.worktreeDirty === false;
}

/**
 * One job's answer that the task's work carried nothing the upstream did not already have: the tip on
 * the upstream (`jobSawTipOnUpstream`), of the branch the work ended on, after it ended
 * (`jobSawTheFinishedBranch`).
 */
export function jobFoundNothingOfItsOwn(job: LandingJobFacts): boolean {
  return jobSawTipOnUpstream(job) && jobSawTheFinishedBranch(job);
}

/**
 * The job states in which the line never reported on the branch at all: it has not looked yet, it is
 * looking, or the job was taken out of the queue before or after it could.
 *
 * An ALLOWLIST, and that is the point: a state added to §2.1's closed set later withholds this lane's
 * exemption until somebody decides otherwise, where a denylist would silently grant it.
 */
const JOB_SAID_NOTHING_ABOUT_THE_BRANCH: ReadonlyArray<string> = [
  'QUEUED', 'RUNNING', 'CANCELLED', 'SUPERSEDED',
];

/**
 * Whether the line's whole record of this task is "there was nothing of it to land": every job its
 * branch was handed either never got as far as reporting, or reported the finished branch's tip
 * already on the upstream (`jobFoundNothingOfItsOwn`) — and no receipt says a target ever MOVED with
 * this task's work.
 *
 * WHY EVERY JOB, AND NOT JUST ONE
 * -------------------------------
 * `jobFoundNothingOfItsOwn` is a statement about ONE attempt's branch at ONE moment. A task can be
 * reopened and run again, and an exemption read off any single job would let a task out of the
 * roll-up while a LATER attempt's commits sit on the line unlanded — the same false green, arrived
 * at the long way round. So the task's whole record has to agree, and the two things that can
 * disagree are both here: a job that got as far as reporting says the branch had commits the line
 * did not (`LANDED` put them there, `CONFLICT`, `CHECK_FAILED` and `ERROR` are the line trying and
 * failing, and a promotion's `READY` passed the same check), or is an `ALREADY_LANDED` that cannot
 * say the branch was empty (the line had moved past the upstream, or it looked before the session
 * finished) — and a receipt that says a target moved says it even when no job of this task's is the
 * one that moved it.
 *
 * WHY `MERGED` AND NOT `ALREADY_MERGED`
 * -------------------------------------
 * `MERGED` is the only result in `LANDED_RESULTS` that means the target CHANGED; `ALREADY_MERGED` is
 * this table's word for the case where nothing moved — it is written for exactly the answer this
 * function reads. So "a target moved" is `MERGED`, and that is the receipt that says this task had
 * commits of its own wherever it was recorded from: the platform's own landing, or the door an agent
 * records a merge it made itself with, which is how most of this work lands.
 */
export function lineSawNothingToLand(task: LandingServingTask): boolean {
  if (!task.integrationJobs.some(jobFoundNothingOfItsOwn)) return false;
  const saidSomethingElse = task.integrationJobs.some((job) => !jobFoundNothingOfItsOwn(job)
    && !JOB_SAID_NOTHING_ABOUT_THE_BRANCH.includes(job.state));
  return !saidSomethingElse && !task.mergeReceipts.some((receipt) => receipt.result === 'MERGED');
}

/**
 * Whether this work has nothing to land at all — and there are two ways for that to be true: the
 * task DECLARES it needs no code, or the line's own record says it never had a commit of its own.
 *
 * §1.1 `isCodeTask` has two halves and the first is the declaration: a task that declares itself
 * `codeless` "needs no code, even though its project is bound to a codebase", which is SR5's escape
 * hatch for the research, documentation and evidence work inside an otherwise code-bearing project.
 * Its schema comment says what that buys here: "a codeless task resolves no SOURCE" — so it has no
 * branch, no commit of its own, and no receipt can ever put its work on `main`. A criterion that
 * demanded a landing from one would be demanding something that was never going to exist, which is
 * SR27's rule one contract over: "a 'write the docs' prerequisite must not make the task after it
 * demand a checkpoint that was never going to exist". §2.5 J9 exempts the very same tasks from a
 * dependent's wait, and `ProjectIntegrationBuckets.doneNotIntegrated` already calls them "DONE work
 * with nothing to land". This is that same answer arriving at §1.4.
 *
 * THE SECOND WAY, AND WHY IT HAD TO BE ADDED
 * ------------------------------------------
 * The declaration is a fact about an intention, and it is the ONLY fact of its kind: `codeless` is
 * written when a task is created and no door writes it afterwards, so a task created without it can
 * never gain it. On 2026-09-22 that cost a project of 48 finished tasks its DONE a second time: its
 * criterion 12 was served by a finished acceptance task that ran a branch, committed nothing to it
 * and declared nothing, and no receipt could ever put its work on `main` — the same deadlock the
 * declaration had just been taught to break, one task over, with no declaration anywhere to read.
 *
 * What that task has instead is the line's own answer, and it is the better fact of the two: the
 * task's branch was offered to the line after its session had finished with it, and the line replied
 * that the tip was already on the upstream (`jobFoundNothingOfItsOwn`). A task whose whole record at
 * the line is that answer has no commit of its own — see `lineSawNothingToLand` for why that is the
 * whole of the claim and not a guess from it.
 *
 * WHY §1.1's SECOND HALF IS STILL NOT READ HERE
 * ---------------------------------------------
 * `isCodeTask`'s other half — whether the NEWEST work session ran in a worktree on a branch — is
 * deliberately NOT read, and the difference is what this lane is FOR. §1.1 asks it to decide
 * dispatch and closure, where "the latest attempt is not a branch-bearing one" is the right input.
 * This lane is an audit of where work IS, and a receipt is attached to the TASK rather than to the
 * session it was recorded against: a task that landed from one attempt and then ran another without
 * a worktree is a task whose work is really on the integration line, and reading it as "nothing to
 * land" would say LANDED over it. That is the false green this lane exists to break up.
 *
 * The line's answer has no such gap, and the guard is where the difference shows. That same task —
 * landed from one attempt, then run again — has a MERGED receipt, because the landing it did is a
 * target that moved, and that alone keeps it in the roll-up whatever its sessions look like. And it
 * has commits of its own in every other sense this lane can see: a branch the line was handed and
 * found something on answers `LANDED`, `CONFLICT`, `CHECK_FAILED`, `ERROR` or `READY`, none of which
 * is `ALREADY_LANDED`-on-the-upstream, and none of which this exemption overlooks. Only work whose
 * whole record is "there was nothing of it to land" gets anything out — and a declaration, which is
 * §1.1's first half and authoritative wherever this lane reads it.
 *
 * The one session this does read is not that half either: `jobSawTheFinishedBranch` looks at the
 * session a landing was queued FOR, never at which session is newest, and it can only keep a task in.
 */
export function taskHasNothingToLand(task: LandingServingTask): boolean {
  return task.codeless || lineSawNothingToLand(task);
}

/**
 * The fold: one criterion is LANDED when every task serving it THAT HAS A COMMIT TO LAND is on the
 * upstream, and ON_INTEGRATION_LINE when every one of those landed on one of the two branches and
 * not all of them on the upstream.
 *
 * Work with nothing to land (`taskHasNothingToLand`) is not delivery and does not take part in
 * either: it neither withholds LANDED nor supplies it. So a criterion served by three tasks, two of
 * them on `main` and the third an acceptance task that declares it needs no code — or, since this
 * unit, one the line looked at and found no commit of its own on — is LANDED, and before this rule it
 * could not be, at any time, by any receipt, which left every project holding
 * such a task unable to reach DONE (2026-09-22: 48 finished tasks, one of them a criteria-12
 * acceptance task, and still 48 of them after the declaration alone was honoured, because that task
 * declared nothing). A criterion served only by such work is LANDED too — all of zero commits are on
 * the upstream, and §2.5 J9 answers TRUE for the same facts one level down ("nothing left to wait
 * for"). But one that NOBODY serves is still UNKNOWN, which is the case that answer has always been
 * about: nothing is filed under the criterion, so there is nothing to stand on.
 *
 * A conjunction otherwise, for the same reason clause 2 of the work side's answer is one — three
 * tasks serve a criterion and one of them landed is not a criterion whose work is on main, and
 * saying LANDED there would be the false green this lane exists to break up.
 */
export function criterionLanding(
  definitions: ReadonlyArray<CriterionWithLandingFacts>,
  branches: LandingBranches,
): CriterionLandingAnswer[] {
  return definitions.map((definition) => {
    const delivery = definition.servingTasks.filter((task) => !taskHasNothingToLand(task));
    const tasks = delivery.map((task) => taskLanding(task.mergeReceipts, branches));
    let landing: CriterionLanding = 'UNKNOWN';
    if (delivery.length === 0) {
      landing = definition.servingTasks.length > 0 ? 'LANDED' : 'UNKNOWN';
    } else if (tasks.every((task) => task === 'ON_UPSTREAM')) {
      landing = 'LANDED';
    } else if (!tasks.includes('NOT_KNOWN')) {
      landing = 'ON_INTEGRATION_LINE';
    }
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
 * Every criterion this project states, each with its serving work's merge receipts and the line's
 * answers about its branches.
 *
 * One call, whose nested select carries every serving task's receipts and jobs with it — not one
 * query per criterion and not one per task. It reads the criterion rows again rather than borrowing
 * the work side's, which keeps this lane genuinely bolted on: the three clauses are untouched, and
 * nothing here can change the answer they fold.
 *
 * `codeless` rides along as a scalar on the same `task` row the receipts hang off, so reading what
 * `taskHasNothingToLand` needs costs this read no statement at all — which is why the project detail
 * page's fixed cost does not move for it. The jobs cost two: their own relation beside the receipts,
 * and the sessions they were queued for one level below it — each one statement for all of the
 * project's serving tasks together (`project-get-query-count.pg.spec.ts` carries the number and the
 * argument).
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
        select: LANDING_SERVING_WORK_SELECT,
      },
    },
  });
}

/**
 * What the fold reads about one serving task, as a Prisma `select`.
 *
 * Spelled ONCE, here, and spread by every caller that folds this lane: the criterion a project page
 * shows, the facts the coordinator is woken for, the settled card, and the mirror those are asserted
 * against. A reader that wrote its own copy would be a second author of the fold's input, and the
 * copy that drifts is the one that quietly keeps answering a question the fold stopped asking —
 * which is what these three facts are: SR5's escape hatch, the merges recorded against the task, and
 * the answers the line gave about its branches (§2.2 J-T5), with what each branch's session had
 * reported by then.
 */
export const LANDING_SERVING_WORK_SELECT = {
  codeless: true,
  mergeReceipts: { select: { result: true, targetBranch: true } },
  integrationJobs: {
    select: {
      state: true,
      mainSyncSha: true,
      targetShaBefore: true,
      upstreamSha: true,
      sourceRef: true,
      startedAt: true,
      session: { select: { finishedAt: true, worktreeBranch: true, worktreeDirty: true } },
    },
  },
} as const;

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
