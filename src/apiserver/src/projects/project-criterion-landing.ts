import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { sessionReportedWork } from './landing-source-branch';

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
 * declared nothing, and then could not be made to — `codeless` was written only when a task was
 * created. (Since 0346 the edit doors write it too, with a reason, and never for a task that has
 * commits of its own.) What it has instead is a better fact, and the LINE's own: it ran a branch,
 * committed nothing to it, and when the line was handed that branch — after the session that ran it
 * had finished with it — it answered that the tip was already ON THE UPSTREAM. That answer is
 * §2.2's `ALREADY_LANDED`, it is on the task's own job row, and it says what SR27's rule says one
 * contract over — there was nothing of this task's to land, because it never had a commit of its own.
 *
 * §2.5 J9 already exempts the very same tasks from a dependent's wait, in SR27's words: a "write the
 * docs" prerequisite must not make the task after it demand a checkpoint that was never going to
 * exist. This lane reads the same facts through `taskHasNothingToLand`, and the line's answer
 * beside it, and lets such work out of the roll-up. Since revision 42 (§12.15 P-M3) the declaration
 * itself is no longer read: what keeps such work out is that it ran no branch or committed nothing. Neither is a way round the landing judgment: a
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

/** The stable, de-duplicated target-branch spellings a receipt may store for one ref. */
export function receiptTargetBranches(ref: string): string[] {
  const short = branchName(ref);
  return short === ref ? [ref] : [short, ref];
}

/** A project's main branch by name, as the reads whose words say "main" carry it (`mainBranch`):
 *  its binding's upstream, or null when it has no repository bound — and the words then say main. */
export function mainBranchOf(codebase: { upstreamRef: string } | null | undefined): string | null {
  return codebase ? branchName(codebase.upstreamRef) : null;
}

/**
 * A remote URL as repository identity (PSC SR36): trimmed, scheme and host lower-cased, any
 * `user@` dropped, the scp form `git@host:owner/repo` spelled as `ssh://host/owner/repo`, and no
 * trailing `/` or `.git`. Used to compare and to satisfy `project_codebase_canonical_url_chk`, never
 * to clone. Null when nothing is left.
 */
export function canonicalRepoUrl(raw: string): string | null {
  let url = raw.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `ssh://${scp[1]}/${scp[2]}`;
  const remote = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/]*)(.*)$/i.exec(url);
  if (remote) url = `${remote[1]!.toLowerCase()}://${remote[2]!.toLowerCase()}${remote[3]}`;
  for (let trimmed = url.replace(/\/+$/, '').replace(/\.git$/, ''); trimmed !== url;
    trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '')) {
    url = trimmed;
  }
  return url === '' ? null : url;
}

/**
 * §1.1 `isCodeTask`'s repository condition (revision 29, §10.5 O-L7): no repository is KNOWN to
 * differ from the one the project's line is bound to — the workspace a work session ran in names,
 * through SR36, that repository, or names none. Only a known, different repository takes work off
 * the line. A project with no binding has none to differ from — its first integration binds it to
 * this work's repository (L3) — and a session with no workspace, or a workspace with no `repo_url`,
 * names none: that work stays this line's, queued, waited on and in its criterion's conjunction, so
 * a repository nobody recorded is answered where it always was rather than read as nothing to land.
 * The binding's own URL is read through SR36 as well: that changes nothing for one `bind()` wrote,
 * which is canonical already, and keeps one written by hand comparable. `workOnProjectRepositorySql`
 * is the same condition in SQL, where a NULL on either side of its `<>` holds.
 */
export function workOnProjectRepository(
  repoUrl: string | null | undefined,
  binding: { canonicalRepoUrl?: string | null } | null | undefined,
): boolean {
  const bound = binding?.canonicalRepoUrl ? canonicalRepoUrl(binding.canonicalRepoUrl) : null;
  const repository = repoUrl ? canonicalRepoUrl(repoUrl) : null;
  return bound === null || repository === null || repository === bound;
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
  /** What `upstreamReceiptCarriesLine` compares to tell a rework still on the line from work
   *  already on the upstream. A reader that selects only the two fields above gets the older,
   *  coarser answer: any upstream receipt counts. `LANDING_SERVING_WORK_SELECT` selects all three. */
  sourceSha?: string;
  createdAt?: Date;
  detail?: Prisma.JsonValue;
  /** Where a MERGED receipt left its target: on a line receipt, the commit its landing job recorded as
   *  `landed_sha`, which a promotion's upstream receipt names as its `sourceSha`. */
  targetShaAfter?: string | null;
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
  /** With NOTHING_TO_LAND: whether the runner measured the source tip an ancestor of that upstream
   *  tip (0346). Null when it measured nothing — every older row, and every older runner. */
  sourceOnUpstream: boolean | null;
  /** With NOTHING_TO_LAND: whether the runner measured that the branch carried commits of its own and
   *  the base already had every one of them (0410) — true, or false for a branch that carried none.
   *  Null when it measured nothing, as above. */
  sourceFullyApplied: boolean | null;
  /** The receipts the answer wrote. A NOTHING_TO_LAND writes one only when no work session of the
   *  task had reported work of its own anywhere (J8) — or, for a branch whose commits the target
   *  already had, anywhere but on that branch — so an empty list there is the line saying the task's
   *  work is on a branch it was not handed (`jobAnsweredForTheWholeTask`). */
  receiptIds: readonly string[];
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
 * `taskHasNothingToLand` below reads it; no label the task carries takes part (§12.15 P-M3).
 */
export interface LandingServingTask {
  /** The task's status: only a DONE task has delivered, so only a DONE one can have delivered
   *  nothing (`ranNoBranch`). A reader that did not select it reads as one that has not. */
  status?: string;
  mergeReceipts: ReadonlyArray<LandingReceiptFacts>;
  integrationJobs: ReadonlyArray<LandingJobFacts>;
  /** §1.1's repository condition (revision 29, O-L7) as this lane reads it: the task's newest work
   *  session — the workspace whose `repo_url` it ran in — and the binding of the project the task is
   *  filed under (`workInAnotherRepository`). A reader that did not select them has nothing to say
   *  about the repository, which reads as work in the project's own. */
  sessions?: ReadonlyArray<{ workspace?: { repoUrl: string | null } | null } & WorkReport>;
  project?: { codebases: ReadonlyArray<{ canonicalRepoUrl: string }> } | null;
  /** §12.15 P-M1's facts (`deliveredNothingOfItsOwn`). A reader that did not select them reads as a
   *  task that delivered something. */
  deliveredSha?: string | null;
  deliveredBaseSha?: string | null;
}

/** The rows the fold needs: one criterion's identity and its serving work's receipts. */
export interface CriterionWithLandingFacts {
  id: string;
  servingTasks: ReadonlyArray<LandingServingTask>;
  /** A CONFIRMATION criterion (migration 0545) takes no part in landing: it is met by somebody
   *  saying it holds, not by work reaching a branch. Absent reads as TASKS. */
  satisfiedBy?: 'TASKS' | 'CONFIRMATION';
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
  const onLine = newestLineReceipt(landed, branches);
  if (landed.some((receipt) => branches.upstream.includes(receipt.targetBranch)
    && upstreamReceiptCarriesLine(receipt, onLine, landed, branches))) return 'ON_UPSTREAM';
  if (landed.some((receipt) => branches.integration.includes(receipt.targetBranch))) {
    return 'ON_INTEGRATION_LINE';
  }
  return 'NOT_KNOWN';
}

/** The task's newest landed receipt on an integration line that is not also its upstream: the
 *  work that line holds now. None on a MAIN-line project, whose one branch is both. */
function newestLineReceipt(
  landed: ReadonlyArray<LandingReceiptFacts>,
  branches: LandingBranches,
): LandingReceiptFacts | undefined {
  let newest: LandingReceiptFacts | undefined;
  for (const receipt of landed) {
    if (!branches.integration.includes(receipt.targetBranch)
      || branches.upstream.includes(receipt.targetBranch)) continue;
    if (!newest || (receipt.createdAt && newest.createdAt && receipt.createdAt > newest.createdAt)) {
      newest = receipt;
    }
  }
  return newest;
}

/**
 * Whether one landed upstream receipt says the work the task's newest line receipt landed is on the
 * upstream — decided from receipts alone, never from a repository. `taskLandingSql` is the same rule
 * in SQL, and `tasksOnTheLine` (project-promotion.service.ts) reads it through `taskLanding`, so the
 * promotion's task set, `integration.state` and a criterion's landing cannot disagree.
 *
 * - With no line receipt, any upstream receipt does.
 * - One naming the commit that line receipt landed does, whoever wrote it.
 * - One a landing or a promotion wrote does when it is newer than that line receipt. An older one is
 *   about an earlier revision: the task was reopened and its rework landed on the line after it
 *   (F1-4, 2026-11-08), and only a promotion carrying the rework writes a newer one.
 * - One an observation wrote (`detail.observed`) does only by naming the commit (task
 *   34vJmfV0DZk5cySoXlB3r, 2026-11-10): it is about the commit the task's identity was frozen as,
 *   which can be a stale tip already on the upstream.
 * - One naming the commit an earlier line landing left (that line receipt's `targetShaAfter`), when a
 *   later line receipt of the task moved the line again, does not, however new it is (task
 *   34xkUZ2LOP5x9cqm7wrle, 2026-11-15): a promotion confirmed before the rework landed merges the
 *   source it froze, and its receipt names the landing that source carries (`upstreamReceiptWork`).
 *
 * Receipts with no `createdAt` (a reader that did not select it) keep the older answer, and so do
 * line receipts with no `targetShaAfter`.
 */
function upstreamReceiptCarriesLine(
  upstream: LandingReceiptFacts,
  onLine: LandingReceiptFacts | undefined,
  landed: ReadonlyArray<LandingReceiptFacts>,
  branches: LandingBranches,
): boolean {
  if (!onLine) return true;
  if (upstream.sourceSha !== undefined && upstream.sourceSha === onLine.sourceSha) return true;
  if (observedReceiptDetail(upstream.detail)) return false;
  if (namesASupersededLineLanding(upstream, landed, branches)) return false;
  return !upstream.createdAt || !onLine.createdAt || upstream.createdAt > onLine.createdAt;
}

/** Whether the upstream receipt names a line landing of the task that a later MERGED line receipt
 *  moved past (`upstreamReceiptCarriesLine`'s last rule). `taskLandingSql` has the same test. */
function namesASupersededLineLanding(
  upstream: LandingReceiptFacts,
  landed: ReadonlyArray<LandingReceiptFacts>,
  branches: LandingBranches,
): boolean {
  if (!upstream.sourceSha) return false;
  const line = landed.filter((receipt) => branches.integration.includes(receipt.targetBranch)
    && !branches.upstream.includes(receipt.targetBranch));
  return line.some((named) => named.targetShaAfter === upstream.sourceSha && named.createdAt
    && line.some((later) => later.result === 'MERGED' && !!later.targetShaAfter
      && later.targetShaAfter !== upstream.sourceSha
      && !!later.createdAt && later.createdAt > named.createdAt!));
}

function observedReceiptDetail(detail: Prisma.JsonValue | undefined): boolean {
  return !!detail && typeof detail === 'object' && !Array.isArray(detail) && detail.observed === true;
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
  // `upstreamReceiptCarriesLine`, receipt for receipt: an upstream receipt counts with no line
  // receipt under it, by naming the newest line receipt's commit, or — unless an observation wrote
  // it, or it names the commit an earlier line landing left that a later MERGED line receipt moved
  // past (`namesASupersededLineLanding`) — by being newer than that receipt.
  const upstreamName = branchNameSql('upstream_line."upstream_ref"');
  const integrationName = branchNameSql('upstream_line."integration_ref"');
  const onUpstream = `EXISTS (
        SELECT 1 FROM "session_merge_receipt" upstream_receipt
          JOIN "project_codebase" upstream_line
            ON upstream_line."project_id" = ${alias}."project_id"
           AND upstream_line."slot" = 'primary'
          LEFT JOIN LATERAL (
            SELECT newest_line."source_sha", newest_line."created_at"
              FROM "session_merge_receipt" newest_line
             WHERE newest_line."task_id" = ${alias}."id"
               AND newest_line."result" IN (${results})
               AND newest_line."target_branch" = ${integrationName}
               AND ${integrationName} <> ${upstreamName}
             ORDER BY newest_line."created_at" DESC, newest_line."id" DESC
             LIMIT 1
          ) line_receipt ON true
         WHERE upstream_receipt."task_id" = ${alias}."id"
           AND upstream_receipt."result" IN (${results})
           AND upstream_receipt."target_branch" = ${upstreamName}
           AND (line_receipt."source_sha" IS NULL
             OR upstream_receipt."source_sha" = line_receipt."source_sha"
             OR (upstream_receipt."detail" -> 'observed' IS DISTINCT FROM 'true'::jsonb
               AND NOT EXISTS (
                 SELECT 1 FROM "session_merge_receipt" named_line
                   JOIN "session_merge_receipt" later_line
                     ON later_line."task_id" = named_line."task_id"
                    AND later_line."target_branch" = named_line."target_branch"
                    AND later_line."result" = 'MERGED'
                    AND later_line."target_sha_after" <> upstream_receipt."source_sha"
                    AND later_line."created_at" > named_line."created_at"
                  WHERE named_line."task_id" = ${alias}."id"
                    AND named_line."result" IN (${results})
                    AND named_line."target_branch" = ${integrationName}
                    AND named_line."target_sha_after" = upstream_receipt."source_sha")
               AND upstream_receipt."created_at" > line_receipt."created_at"))
      )`;
  return `CASE
      WHEN ${onUpstream} THEN 'ON_UPSTREAM'
      WHEN ${receiptOn('integration_ref')} THEN 'ON_INTEGRATION_LINE'
      ELSE 'NOT_KNOWN'
    END`;
}

/**
 * `isCodeTask` (§1.1) as SQL: work that has a commit to land at all.
 *
 * Its newest work session ran in a worktree on a branch, in no repository known to differ from the
 * one the project's line is bound to (revision 29, §10.5 O-L7). The `codeless` flag is not read (revision 42,
 * §12.15 P-M3): a codeless task with commits lands like any other. The negation of the
 * middle two disjuncts of `prerequisiteLandedSql`, stated positively because this asks the question
 * the other way round — that one asks "is there nothing left to wait for", this asks "is this the
 * kind of work that lands".
 */
export function isCodeTaskSql(alias: string): string {
  return `(
      ${alias}."project_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "session" code_work
          LEFT JOIN "workspace" code_workspace ON code_workspace."id" = code_work."workspace_id"
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
           AND ${workOnProjectRepositorySql(`${alias}."project_id"`, 'code_workspace."repo_url"')}
      )
    )`;
}

/**
 * `canonicalRepoUrl` (PSC SR36, `project-integration-line.ts`) as one SQL expression over `raw`, step
 * for step: trimmed; the scp form `git@host:owner/repo` spelled `ssh://host/owner/repo`; scheme and
 * host lower-cased and any `user@` dropped; every trailing `/` and `.git` taken off; NULL when
 * nothing is left. The two are held to one corpus by `delivered-identity.pg.spec.ts`, because a
 * predicate that compares repositories in the database has to reach the answer the TypeScript does.
 */
export function canonicalRepoUrlSql(raw: string): string {
  // No CASE: the scp spelling is skipped by a lookahead for a scheme, and a URL with no scheme to
  // lower-case falls through COALESCE as it is — a `WHEN` here would land inside the readiness arms
  // that embed this, which their own readers delimit by `WHEN`.
  return `(SELECT NULLIF(regexp_replace(repo_lowered."url", '(/|\\.git)+$', ''), '')
      FROM (SELECT COALESCE(lower(repo_parts."parts"[1]) || '://' || lower(repo_parts."parts"[2])
                              || repo_parts."parts"[3],
                            repo_parts."url") AS "url"
              FROM (SELECT repo_spelled."url",
                           regexp_match(repo_spelled."url",
                                        '^([a-z][a-z0-9+.-]*)://(?:[^@/]*@)?([^/]*)(.*)$', 'i') AS "parts"
                      FROM (SELECT regexp_replace(repo_trimmed."url",
                                     '^(?![a-z][a-z0-9+.-]*://)(?:[^@/[:space:]]+@)?([^:/[:space:]]+):(?!/)([^[:space:]]+)$',
                                     'ssh://\\1/\\2', 'i') AS "url"
                              FROM (SELECT regexp_replace(${raw}, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS "url")
                                   repo_trimmed) repo_spelled) repo_parts) repo_lowered)`;
}

/**
 * `isCodeTask`'s repository condition (revision 29, §10.5 O-L7) as SQL: no binding of the project
 * names a repository KNOWN to differ from the one `repoUrl` — a work session's workspace `repo_url` —
 * reads as through SR36. A project with no binding has none to differ from: its first integration
 * binds it to this work's repository (L3). A session with no workspace, or a workspace with no
 * `repo_url`, names no repository, and `<>` against its NULL is not true, so the condition holds:
 * only a known, different repository takes work off the line. The binding's URL is read through
 * SR36 too, as `workOnProjectRepository` reads it.
 */
export function workOnProjectRepositorySql(projectId: string, repoUrl: string): string {
  return `NOT EXISTS (
        SELECT 1 FROM "project_codebase" work_line
         WHERE work_line."project_id" = ${projectId}
           AND work_line."slot" = 'primary'
           AND ${canonicalRepoUrlSql('work_line."canonical_repo_url"')} <> ${canonicalRepoUrlSql(repoUrl)}
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

/** One work session of a task, as the landing readers select it. */
export interface WorkReport {
  id?: string;
  isolationStatus?: string | null;
  branch?: string | null;
  /** The branch the checkout's HEAD ended on, as the finalize reported it. */
  worktreeBranch?: string | null;
  /** When the runner finished with the checkout; null while the session can still commit. */
  finishedAt?: Date | null;
  changedFiles?: Prisma.JsonValue | null;
  /** The tip of the session's own branch, as the runner last reported it (migration 0370). */
  branchSha?: string | null;
  /** The commit that branch forked from. */
  baseSha?: string | null;
  /** Whether the runner last found the checkout holding changes no commit carries. */
  worktreeDirty?: boolean | null;
}

/** The work-session columns `sessionHoldsWorkOfItsOwn` reads, as a Prisma `select`. */
export const WORK_OF_ITS_OWN_SELECT = {
  isolationStatus: true, branch: true, branchSha: true, baseSha: true, worktreeDirty: true,
} as const;

/**
 * Whether one work session holds work of its own (§12.15 P-M1, owner's ruling of 2026-11-20 on the
 * regression P-M1 shipped with): its own branch has a commit past its own base (`branch_sha` and
 * `base_sha` both reported, and different), or its checkout was left with changes no commit carries
 * (`worktree_dirty`).
 *
 * BOTH ARE ABOUT THE SESSION'S OWN BRANCH AND CHECKOUT, AND `changed_files` IS NOT
 * ------------------------------------------------------------------------------
 * The runner's finalize (runner-go `finalizeWorktree`) stages and commits whatever the checkout holds
 * onto HEAD, then reports `changed_files` as `git diff <base>..HEAD` — wherever HEAD is. A run told to
 * `git checkout --detach origin/project/<id>` and to commit nothing reports the whole diff from its base
 * to the commit it checked out: on 2026-11-20 one verification task reported 61 files nobody had
 * changed, and P-M1 read that as work somewhere else and held a settled project's criteria. `branch_sha`
 * is the tip of the session's own branch (`effectiveBranchSha`: the branch HEAD is on, else the branch
 * the session started on), so a detached checkout leaves it at the base, and that run measures empty.
 *
 * The finalize commit can fail. It then reports `capture_error`, no diff, and `worktree_dirty = true`,
 * and the runner keeps the checkout (`checkoutWorkIsCaptured`): that work is on no branch, and it is
 * not nothing. A file the finalize held back on purpose — one holding a runner-held secret, or a path
 * a stopped SubAgent was writing — leaves the checkout dirty the same way, and holds the task for a
 * person to look at; that cost was chosen over reading a failed capture as nothing.
 *
 * A session that never reported a tip or a base (an older runner) says nothing either way, as a
 * session that never reported `changed_files` said nothing under the old reading.
 */
export function sessionHoldsWorkOfItsOwn(session: WorkReport): boolean {
  if (session.isolationStatus !== 'worktree' || !session.branch) return false;
  if (session.worktreeDirty === true) return true;
  return typeof session.branchSha === 'string' && typeof session.baseSha === 'string'
    && session.branchSha !== session.baseSha;
}

/** The facts §12.15 P-M1 reads about one DONE task, as the readers select them. */
export interface DeliveredNothingFacts {
  /** Only a DONE task has delivered (`unnamedIdentityMeasuresNothing`). */
  status?: string;
  /** The frozen delivered identity (§10.5 O-L4): the commit, and the commit it forked from. */
  deliveredSha?: string | null;
  deliveredBaseSha?: string | null;
  /** EVERY work session of the task (`WORK_SESSIONS_NEWEST_FIRST`), with what it reported. */
  sessions?: ReadonlyArray<WorkReport>;
  /** The merges recorded against the task: a MERGED one says a target moved with its work. */
  mergeReceipts?: ReadonlyArray<{ result: string }>;
}

/**
 * §12.15 P-M1, the fact itself: this task delivered no commit of its own, and nothing of its work
 * is anywhere else either — so it has nothing to land, and was given no route to a line.
 *
 * Both halves are committed rows. `delivered_sha = delivered_base_sha` is the branch with no commit
 * past its base, frozen when the work settled (O-L4; NULL until then, and cleared when the task
 * leaves DONE). And no work session of the task holds work of its own (`sessionHoldsWorkOfItsOwn`):
 * one that does means the task's work is somewhere it was not delivered from, which is
 * `WORK_ELSEWHERE` and not nothing.
 *
 * The delivered session is asked too. The freeze copies that session's `branch_sha` and `base_sha`
 * once, after every work session has finished (`readDeliveredIdentity`), so an empty identity always
 * comes from a session whose own branch was empty at that moment. The session row goes on: a session
 * revived after the DONE, or committed from its own Commit action, moves `branch_sha` past the
 * identity, which is never frozen again while the task stays DONE. Measured on 2026-11-20: a task frozen
 * empty on 10-29 at 07:20 whose delivered session finished again at 07:42 with a commit on its branch.
 *
 * Read off the task's work sessions rather than counted in SQL: a filtered relation count is an
 * aggregate over the whole session table in the statement Prisma writes for it. A reader that did not
 * select the session columns cannot tell, and gets `false` — the withholding answer.
 *
 * The enqueue (`enqueueForDoneTask`), the dependency predicate (§2.5 J9), and the landing fold
 * (`taskHasNothingToLand`) all read this, in this spelling or `deliveredNothingOfItsOwnSql`.
 */
export function deliveredNothingOfItsOwn(task: DeliveredNothingFacts): boolean {
  return frozenIdentityMeasuresNothing(task) || unnamedIdentityMeasuresNothing(task);
}

/** The frozen half: an identity with no commit past its base, and no work session holding work of its own. */
function frozenIdentityMeasuresNothing(task: DeliveredNothingFacts): boolean {
  if (typeof task.deliveredSha !== 'string' || task.deliveredSha !== task.deliveredBaseSha) return false;
  const sessions = task.sessions;
  if (!sessions || sessions.some((session) => !('branchSha' in session) || !('baseSha' in session)
    || !('worktreeDirty' in session))) {
    return false;
  }
  return !sessions.some(sessionHoldsWorkOfItsOwn);
}

/**
 * The half for an identity Orbit cannot name (owner's ruling of 2026-11-20): a DONE task whose identity
 * was never frozen because the work session that finished last reported no tip (`branch_sha`, recorded
 * from 0370 on; `readDeliveredIdentity` answers UNKNOWN) — work finished before the runner reported one,
 * and code work only since §12.15 P-M3 stopped reading the `codeless` flag. Such a task measures nothing
 * of its own when every work session has finished, holds nothing of its own (`sessionHoldsWorkOfItsOwn`),
 * and reported `changed_files` as an EMPTY list, and no receipt says a target moved with its work.
 *
 * WHY AN EMPTY LIST IS A MEASUREMENT WHEN A FULL ONE IS NOT
 * --------------------------------------------------------
 * The list is `git diff <base>..HEAD` of the checkout (runner-go `finalizeWorktree`), sent explicitly as
 * `[]` whenever the finalize has a base (since 2026-08-29), and the server never writes `[]` itself. A
 * non-empty list does not prove work of its own — HEAD may be a commit the run only checked out — but an
 * empty one is the runner saying the checkout held nothing past its base. NULL, or a list with anything
 * in it, leaves the identity unknown, and unknown is not nothing.
 *
 * WHAT IT CANNOT SEE, said rather than left to be discovered: a run that committed on its own branch and
 * then moved HEAD back to a tree equal to its base before the finalize; and a finalize whose staging or
 * commit failed on a runner older than 2026-09-16, which reported `[]` for a checkout still holding
 * uncommitted work and no `worktree_dirty`. No row shows either.
 */
export function unnamedIdentityMeasuresNothing(task: DeliveredNothingFacts): boolean {
  if (task.status !== 'DONE' || !('deliveredSha' in task) || task.deliveredSha != null) return false;
  const sessions = task.sessions;
  if (!sessions || sessions.length === 0 || !task.mergeReceipts) return false;
  if (sessions.some((session) => !('id' in session) || !('finishedAt' in session) || !('worktreeBranch' in session)
    || !('changedFiles' in session) || !('branchSha' in session) || !('baseSha' in session)
    || !('worktreeDirty' in session))) {
    return false;
  }
  if (task.mergeReceipts.some((receipt) => receipt.result === 'MERGED')) return false;
  const measuredEmpty = sessions.every((session) => session.finishedAt != null
    && Array.isArray(session.changedFiles) && session.changedFiles.length === 0
    && !sessionHoldsWorkOfItsOwn(session));
  if (!measuredEmpty) return false;
  // The session the work ended on (`workBranchEndedOn`): the last to finish on a branch, ties by id.
  let ended: WorkReport | null = null;
  for (const session of sessions) {
    if ((session.worktreeBranch ?? session.branch) == null) continue;
    const at = session.finishedAt!.getTime();
    const best = ended?.finishedAt?.getTime() ?? -Infinity;
    if (ended === null || at > best || (at === best && (session.id ?? '') > (ended.id ?? ''))) ended = session;
  }
  return ended !== null && ended.branchSha == null;
}

/** `sessionHoldsWorkOfItsOwn` as SQL, over a SESSION alias. */
export function sessionHoldsWorkOfItsOwnSql(alias: string): string {
  return `(
      ${alias}."isolation_status" = 'worktree'
      AND ${alias}."branch" IS NOT NULL
      AND ${alias}."branch" <> ''
      AND (
        ${alias}."worktree_dirty" = true
        OR (${alias}."branch_sha" IS NOT NULL AND ${alias}."base_sha" IS NOT NULL
            AND ${alias}."branch_sha"::text <> ${alias}."base_sha")
      )
    )`;
}

/** `deliveredNothingOfItsOwn` as SQL, correlated to a TASK alias. */
export function deliveredNothingOfItsOwnSql(alias: string): string {
  return `(${frozenIdentityMeasuresNothingSql(alias)} OR ${unnamedIdentityMeasuresNothingSql(alias)})`;
}

/** The frozen half of `deliveredNothingOfItsOwnSql`. */
export function frozenIdentityMeasuresNothingSql(alias: string): string {
  return `(
      ${alias}."delivered_sha" IS NOT NULL
      AND ${alias}."delivered_sha" = ${alias}."delivered_base_sha"
      AND NOT EXISTS (
        SELECT 1 FROM "session" own_work
         WHERE own_work."task_id" = ${alias}."id"
           AND own_work."starts_task_work" = true
           AND own_work."deleted_at" IS NULL
           AND ${sessionHoldsWorkOfItsOwnSql('own_work')}
      )
    )`;
}

/** `unnamedIdentityMeasuresNothing` as SQL, correlated to a TASK alias. */
export function unnamedIdentityMeasuresNothingSql(alias: string): string {
  return `(
      ${alias}."status" = 'DONE'
      AND ${alias}."delivered_sha" IS NULL
      AND EXISTS (
        SELECT 1 FROM "session" any_work
         WHERE any_work."task_id" = ${alias}."id"
           AND any_work."starts_task_work" = true
           AND any_work."deleted_at" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "session" unmeasured_work
         WHERE unmeasured_work."task_id" = ${alias}."id"
           AND unmeasured_work."starts_task_work" = true
           AND unmeasured_work."deleted_at" IS NULL
           AND (unmeasured_work."finished_at" IS NULL
             OR jsonb_typeof(unmeasured_work."changed_files") IS DISTINCT FROM 'array'
             OR unmeasured_work."changed_files" <> '[]'::jsonb
             OR ${sessionHoldsWorkOfItsOwnSql('unmeasured_work')})
      )
      AND NOT EXISTS (
        SELECT 1 FROM "session_merge_receipt" moved_target
         WHERE moved_target."task_id" = ${alias}."id"
           AND moved_target."result" = 'MERGED'
      )
      AND EXISTS (
        SELECT 1 FROM (
          SELECT ended_work."branch_sha" FROM "session" ended_work
           WHERE ended_work."task_id" = ${alias}."id"
             AND ended_work."starts_task_work" = true
             AND ended_work."deleted_at" IS NULL
             AND COALESCE(ended_work."worktree_branch", ended_work."branch") IS NOT NULL
           ORDER BY ended_work."finished_at" DESC, ended_work."id" DESC
           LIMIT 1
        ) ended WHERE ended."branch_sha" IS NULL
      )
    )`;
}

/**
 * Code work of this line that delivered something to land: `isCodeTaskSql` without the tasks §12.15
 * P-M1 gave no route (`deliveredNothingOfItsOwnSql`). What the task row and the project's buckets
 * read as "this task integrates": a DONE that measured no commit of its own reads as nothing to land
 * (`NOT_APPLICABLE`, `doneNotIntegrated`) rather than as a landing that never comes.
 */
export function hasWorkToLandSql(alias: string): string {
  return `(${isCodeTaskSql(alias)} AND NOT ${deliveredNothingOfItsOwnSql(alias)})`;
}

/**
 * Whether a task's work is still moving: a work session of it has not finished (the negation of
 * `landingWorkHasSettled`, J-T1e). Its delivered identity is not frozen yet, and the finish that
 * freezes it is where its landing is decided (§12.15 P-M1), so a DONE in this state has queued
 * nothing and started no line yet.
 */
export function workStillMovingSql(alias: string): string {
  return `EXISTS (
      SELECT 1 FROM "session" moving_work
       WHERE moving_work."task_id" = ${alias}."id"
         AND moving_work."starts_task_work" = true
         AND moving_work."deleted_at" IS NULL
         AND moving_work."finished_at" IS NULL
    )`;
}

/** A DONE code task whose finish still has to decide its landing (§12.15 P-M1). */
export function landingDeferredSql(alias: string): string {
  return `(
      ${alias}."status" = 'DONE'
      AND ${alias}."delivered_at" IS NULL
      AND ${isCodeTaskSql(alias)}
      AND ${workStillMovingSql(alias)}
      AND (${taskLandingSql(alias)}) = 'NOT_KNOWN'
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
 * What it does NOT cover, said here rather than left to be discovered: an `ALREADY_LANDED` computed
 * against a line that has moved PAST the upstream proves only that the tip is inside the LINE, and a
 * task whose branch is offered to such a line goes on withholding LANDED. That is not a new answer —
 * it is the one this lane has always given where it cannot tell, and withholding is the safe
 * direction.
 *
 * `NOTHING_TO_LAND` (0300) is the line saying the branch never moved off the commit its session
 * started at — "no commit of its own" — and since 0346 it is read by ONE fact: the runner's own
 * measurement, taken when it gives that answer, that the source tip is an ancestor of the upstream
 * (`source_on_upstream`). That is the guarantee the two conditions above give, without needing the
 * line to BE the upstream for it to be known. It was read with those two conditions until then, and
 * they hold only until a project branch's first landing: on 2026-10-01 a project's rollout task, which
 * never had a commit, held its criterion at ON_INTEGRATION_LINE for ever on a line ahead of main
 * (34WzvgkHWbY1VwXmSPUZi).
 *
 * WHY THE STATE NEVER COUNTS ON ITS OWN: it says the branch was empty, not that the branch was the
 * task's WORK — a task whose session died before it delivered, and one whose work went to another
 * branch, get the same answer, and letting either out of the roll-up on the state, or on a session
 * or task status beside it, would be the false green this file refuses to give. So a
 * NOTHING_TO_LAND that measured nothing (every row written before 0346, and every row an older
 * runner writes) and one that measured the tip OFF the upstream (an empty branch forked from the
 * project line: nothing on the branch, but not nothing that main lacks) both withhold — and one that
 * measured it on the upstream is still only about one branch at one moment, which is what
 * `jobSawTheFinishedBranch` and `jobAnsweredForTheWholeTask` are asked beside it for.
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
 * hurt either: at the moment of this observation the line WAS the upstream, or the tip was measured
 * against the upstream itself, and an ancestor of the upstream stays one. What CAN move afterwards
 * is the branch itself, which is why this answer lets nothing out on its own — see
 * `jobSawTheFinishedBranch`.
 */
export function jobSawTipOnUpstream(job: LandingJobFacts): boolean {
  if (job.state === 'NOTHING_TO_LAND') return job.sourceOnUpstream === true;
  return job.state === 'ALREADY_LANDED'
    && job.mainSyncSha === null
    && job.targetShaBefore !== null
    && job.targetShaBefore === job.upstreamSha;
}

/**
 * Whether this job is the line saying that every commit the branch carried was already on the
 * UPSTREAM: the branch had commits of its own, and the upstream had all of their changes.
 *
 * This is not `jobSawTipOnUpstream`. That predicate is about a tip; here the tip is NOT on the
 * upstream, and the runner says so (`source_on_upstream` false). What is on the upstream is the work:
 * the rebase of the branch onto the base dropped every commit it carried as "patch contents already
 * upstream", so the replay came back at the base and nothing was pushed (`source_fully_applied`,
 * 0410). On 2026-10-09 a line was rebuilt from main's tip after main had taken a project's work in
 * by another route (project 34PBlWiEZytRLTcPufJht). Every task's branch was then handed to the line
 * and answered exactly this, as LANDED with a receipt, before the runner learned to say it.
 *
 * The measurement is about the BASE, and it says "the upstream" only where the base was the upstream.
 * That takes the two conditions `jobSawTipOnUpstream` reads an ALREADY_LANDED by: no merge of the
 * upstream into the target ran, and the target tip was the upstream tip, read by the same fetch. On a
 * line ahead of main the same answer says the work is on the LINE, which its receipt records. Main
 * may not have it, so the task stays in the roll-up as ON_INTEGRATION_LINE, the shape any landing on
 * the line has. A line a main sync ran on, where the base was the line plus the upstream, is read the
 * same cautious way: the answer cannot say which of the two held the commits.
 *
 * `sourceFullyApplied` is the measurement, and nothing stands in for it: a NOTHING_TO_LAND that did
 * not measure it (every older row and runner) and the empty branch's (false) are read exactly as
 * before. Like every answer this lane reads, it is about one branch at one moment, which is what
 * `jobSawTheFinishedBranch` and `jobAnsweredForTheWholeTask` are asked beside it for.
 */
export function jobSawWorkOnUpstream(job: LandingJobFacts): boolean {
  return job.state === 'NOTHING_TO_LAND'
    && job.sourceFullyApplied === true
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
 * Whether a NOTHING_TO_LAND is the line's answer about the TASK, and not only about the empty branch
 * it was handed: true when the answer wrote its receipt.
 *
 * That receipt is written by the same transaction as the answer, and only when no work session of the
 * task had reported work of its own anywhere (J8, `workSessionsReportingWork` in the relay) — the fact
 * §2.5 J9 releases dependents on. When one had, the line was handed an empty branch while the task's
 * work sat on another one: the shape of 2026-09-23, a retry that died with nothing beside the session
 * that delivered. The answer then writes no receipt and tells the task which branch holds its work,
 * and this lane reads the same fact the same way: that task has commits of its own, and the empty tip
 * being on the upstream says nothing about them.
 *
 * A branch whose commits the target already had (`sourceFullyApplied`, 0410) is not empty: its own
 * session reported that work, and the line measured it. So its receipt is withheld only for work
 * reported on ANOTHER branch, or for work that ended on another branch. The question asked here is
 * the same.
 *
 * An ALREADY_LANDED is not asked: it writes its receipt whenever it is written down, and it is read by
 * the conditions `jobSawTipOnUpstream` already gives it.
 */
export function jobAnsweredForTheWholeTask(job: LandingJobFacts): boolean {
  return job.state !== 'NOTHING_TO_LAND' || job.receiptIds.length > 0;
}

/**
 * One job's answer that the task's work carried nothing the upstream did not already have: the tip on
 * the upstream (`jobSawTipOnUpstream`), or every commit of the branch already there
 * (`jobSawWorkOnUpstream`), of the branch the work ended on, after it ended
 * (`jobSawTheFinishedBranch`), with no work of the task's reported anywhere else
 * (`jobAnsweredForTheWholeTask`).
 */
export function jobFoundNothingOfItsOwn(job: LandingJobFacts): boolean {
  return (jobSawTipOnUpstream(job) || jobSawWorkOnUpstream(job))
    && jobSawTheFinishedBranch(job) && jobAnsweredForTheWholeTask(job);
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
 * Whether this work has nothing to land at all — and there are four ways for that to be true, each a
 * fact Orbit measured rather than a label somebody wrote: no work session of the task ever ran a
 * branch (`ranNoBranch`), its work was done in another repository than the one its line is bound to
 * (`workInAnotherRepository`), the line's own record says it never had a commit of its own, or its
 * DONE measured that (§12.15 P-M1, `deliveredNothingOfItsOwn`) and so queued nothing for the line to
 * answer.
 *
 * NO LABEL DECIDES IT (revision 42, §12.15 P-M3, P-M4)
 * ---------------------------------------------------
 * Until revision 42 the first way was a declaration: a task flagged `codeless` left the conjunction
 * whatever it did, and a project marked `non_code` read no landing at all. Both were labels, and a
 * label can disagree with the work — a codeless task with commits left work on its branch that no
 * criterion asked after. Neither is read now. A codeless run that changed nothing never makes a
 * branch (its checkout is detached until it has something to commit, design §3 B2), so it is out by
 * `ranNoBranch`; one that committed has commits, and is in like any other. A project whose tasks
 * never ran a branch reads every criterion LANDED for the same reason, with no mark needed.
 *
 * THE LINE'S OWN ANSWER
 * ---------------------
 * On 2026-09-22 a project of 48 finished tasks could not reach DONE: its criterion 12 was served by
 * a finished acceptance task that ran a branch, committed nothing to it and declared nothing, and no
 * receipt could ever put its work on `main`. What that task has is the line's own answer: the
 * task's branch was offered to the line after its session had finished with it, and the line replied
 * that the tip was already on the upstream (`jobFoundNothingOfItsOwn`). A task whose whole record at
 * the line is that answer has no commit of its own — see `lineSawNothingToLand` for why that is the
 * whole of the claim and not a guess from it.
 *
 * WHY §1.1's NEWEST-SESSION HALF IS NOT READ HERE
 * -----------------------------------------------
 * `isCodeTask` asks whether the NEWEST work session ran in a worktree on a branch, and that is the
 * right input for dispatch and closure. This lane is an audit of where work IS, and a receipt is
 * attached to the TASK rather than to the session it was recorded against: a task that landed from
 * one attempt and then ran another without a worktree is a task whose work is really on the
 * integration line, and reading it as "nothing to land" would say LANDED over it. That is the false
 * green this lane exists to break up — which is why `ranNoBranch` asks about EVERY work session, and
 * about the receipts and the line's answers beside them, not about the newest one.
 *
 * `workInAnotherRepository` reads the newest work session for its REPOSITORY alone (O-L7), because
 * §1.1 does, and no receipt overrides it: a task that landed on the project branch from one attempt
 * and ran its newest attempt in another repository leaves the conjunction, MERGED receipt and all.
 */
export function taskHasNothingToLand(task: LandingServingTask): boolean {
  return ranNoBranch(task) || workInAnotherRepository(task) || lineSawNothingToLand(task)
    // §12.15 P-M1: the DONE measured no commit of its own and queued nothing, so there is no job for
    // the line's answer to come from; the fact the DONE decided on is read instead.
    || deliveredNothingOfItsOwn(task);
}

/**
 * Whether a DONE task's work sessions never ran a branch or reported changed files, and nothing at the
 * line or in a receipt says otherwise: such work delivered no commit Orbit can see, and so has none
 * to land (§12.15 P-M3). A task that is not DONE has delivered nothing yet, which is not the same as
 * delivering nothing, and stays in — which is what a project with no repository, or one whose work is documents
 * and accounts, is made of. A session with no branch that DID report changed files is work Orbit
 * knows of and cannot place, and keeps the task in (it reads NO_BRANCH). A reader that did not select
 * the sessions' `isolationStatus` and `branch` cannot tell, and gets `false` — the withholding answer.
 */
export function ranNoBranch(task: LandingServingTask): boolean {
  const sessions = task.sessions;
  if (task.status !== 'DONE' || !sessions
    || sessions.some((session) => !('isolationStatus' in session) || !('branch' in session))) {
    return false;
  }
  return task.mergeReceipts.length === 0 && task.integrationJobs.length === 0
    && !sessions.some((session) => (session.isolationStatus === 'worktree' && !!session.branch)
      || sessionReportedWork({ changedFiles: session.changedFiles ?? null }));
}

/**
 * Whether the task's work was done in another repository than the one its project's line is bound to
 * (§1.1 `isCodeTask`'s repository condition, revision 29 §10.5 O-L7), read off the NEWEST work
 * session as §1.1 reads it. No commit of such work can ever be on this line, and the task cannot be
 * left out by any label either — it has commits — so without this a criterion it serves would wait for
 * a landing that never comes. It leaves the conjunction exactly as work with no branch does (§1.4). A task with no work session, one whose newest work session names no
 * repository (no workspace, or no `repo_url`), or one in a project with no binding has none KNOWN to
 * differ, and stays in.
 */
export function workInAnotherRepository(task: LandingServingTask): boolean {
  const newest = task.sessions?.[0];
  if (!newest) return false;
  return !workOnProjectRepository(newest.workspace?.repoUrl, task.project?.codebases?.[0]);
}

/**
 * The fold: one criterion is LANDED when every task serving it THAT HAS A COMMIT TO LAND is on the
 * upstream, and ON_INTEGRATION_LINE when every one of those landed on one of the two branches and
 * not all of them on the upstream.
 *
 * Work with nothing to land (`taskHasNothingToLand`) is not delivery and does not take part in
 * either: it neither withholds LANDED nor supplies it. So a criterion served by three tasks, two of
 * them on `main` and the third an acceptance task that declares it needs no code — or, since this
 * unit, one the line looked at and found no commit of its own on, or (O-L7) one whose work was done
 * in another repository — is LANDED, and before this rule it
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
    if (definition.satisfiedBy === 'CONFIRMATION') {
      return { definitionId: definition.id, landing: 'LANDED' as CriterionLanding };
    }
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
 * Two reads, neither of them per criterion or per task: the definitions with their serving tasks'
 * receipts, and then the integration jobs of exactly those tasks. It reads the criterion rows again
 * rather than borrowing the work side's, which keeps this lane genuinely bolted on: the three clauses
 * are untouched, and nothing here can change the answer they fold.
 *
 * The work sessions ride along one relation below the same `task` row the receipts hang off, so
 * reading what `taskHasNothingToLand` needs costs this read no statement of its own. The jobs are the second read rather than a nested relation
 * because `task_id` is a history reference with no foreign key (0423) and Prisma has nothing to nest;
 * they and the sessions they were queued for still cost one statement each for the whole project's
 * serving tasks (`project-get-query-count.pg.spec.ts` carries the number and the argument).
 */
export async function readCriterionLandingFacts(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition' | 'projectIntegrationJob' | 'session'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionWithLandingFacts[]> {
  const definitions = await prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    select: {
      id: true,
      satisfiedBy: true,
      servingTasks: {
        where: { ownerId },
        // `id` is not the fold's to read; it is how the jobs below are keyed to these rows.
        select: { id: true, ...LANDING_SERVING_WORK_SELECT },
      },
    },
  });
  const jobs = await readLandingJobsByTask(
    prisma, definitions.flatMap((definition) => definition.servingTasks.map((task) => task.id)),
  );
  return definitions.map((definition) => ({
    ...definition,
    servingTasks: definition.servingTasks.map((task) => ({
      ...task, integrationJobs: jobs.get(task.id) ?? [],
    })),
  }));
}

/**
 * Every session that started a task's work, newest first: the first is §1.1's newest work session,
 * with the repository its workspace names (O-L7); all of them carry what they reported — `changed_files`
 * for `ranNoBranch`, and their own branch and checkout for §12.15 P-M1's `deliveredNothingOfItsOwn`.
 */
export const WORK_SESSIONS_NEWEST_FIRST = {
  where: { startsTaskWork: true, deletedAt: null },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  select: {
    ...WORK_OF_ITS_OWN_SELECT, id: true, worktreeBranch: true, finishedAt: true, changedFiles: true,
    workspace: { select: { repoUrl: true } },
  },
} satisfies Prisma.Task$sessionsArgs;

/**
 * What the fold reads about one serving task, as a Prisma `select`.
 *
 * Spelled ONCE, here, and spread by every caller that folds this lane: the criterion a project page
 * shows, the facts the coordinator is woken for, the settled card, and the mirror those are asserted
 * against. A reader that wrote its own copy would be a second author of the fold's input, and the
 * copy that drifts is the one that quietly keeps answering a question the fold stopped asking —
 * which is what these facts are: the merges recorded against the task, whether any of its work
 * sessions ran a branch, and where its newest work ran beside where its project's line is bound
 * (O-L7).
 *
 * The last one, the answers the line gave about its branches (§2.2 J-T5), is not here: it is about
 * the task rather than ON it, and it is read beside this select by `readLandingJobsByTask`. An empty
 * `integrationJobs` in this shape is not "the task has none" but "they have not been attached yet" —
 * a distinction nothing can enforce, which is why every caller in this tree attaches them in the same
 * function that ran the select.
 */
export const LANDING_SERVING_WORK_SELECT = {
  // Only a DONE task has delivered (`ranNoBranch`).
  status: true,
  mergeReceipts: { select: { result: true, targetBranch: true, sourceSha: true, createdAt: true, detail: true, targetShaAfter: true } },
  // §1.1's repository condition (O-L7): where the newest work session ran, and where the project's
  // line is bound. Two relation levels each, not a statement per task (`workInAnotherRepository`).
  sessions: WORK_SESSIONS_NEWEST_FIRST,
  project: { select: { codebases: { where: { slot: 'primary' }, select: { canonicalRepoUrl: true } } } },
  // §12.15 P-M1 (`deliveredNothingOfItsOwn`): the frozen identity, beside the sessions above.
  deliveredSha: true,
  deliveredBaseSha: true,
} as const;

/**
 * One integration job's columns as the fold reads them, and the session it was queued for.
 *
 * Kept beside `LANDING_SERVING_WORK_SELECT` because the two are one input, split only by 0423: the
 * jobs stopped being a relation on `task`, so the reader names their columns here and fetches them
 * by `task_id`. The session stopped being one in 0424, so it is fetched by `session_id` beside them.
 */
const LANDING_JOB_SELECT = {
  state: true,
  mainSyncSha: true,
  targetShaBefore: true,
  upstreamSha: true,
  sourceOnUpstream: true,
  sourceFullyApplied: true,
  receiptIds: true,
  sourceRef: true,
  startedAt: true,
  sessionId: true,
} as const;

/**
 * Each named task's integration jobs, keyed by the task — ONE statement for the page, and one more
 * for the sessions those jobs were queued for.
 *
 * `task_id` is a history reference with no foreign key (0423): it may name a task that was deleted
 * (that is the trace the column exists for) and a promotion job has none, so this reads a keyed map
 * rather than a relation, and every caller attaches the result to the tasks it already has.
 * `session_id` is one too (0424), so the sessions are read by id rather than nested: a session
 * purged from Trash is not found, and its job's `session` reads null — what the key's SET NULL used
 * to leave there.
 */
export async function readLandingJobsByTask(
  prisma: Pick<PrismaService, 'projectIntegrationJob' | 'session'>,
  taskIds: readonly string[],
): Promise<Map<string, LandingJobFacts[]>> {
  if (taskIds.length === 0) return new Map();
  const jobs = await prisma.projectIntegrationJob.findMany({
    where: { taskId: { in: [...taskIds] } },
    select: { taskId: true, ...LANDING_JOB_SELECT },
  });
  const sessionIds = [...new Set(jobs.flatMap((job) => (job.sessionId ? [job.sessionId] : [])))];
  const sessions = new Map((sessionIds.length === 0 ? [] : await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, finishedAt: true, worktreeBranch: true, worktreeDirty: true },
  })).map(({ id, ...facts }) => [id, facts]));
  const byTask = new Map<string, LandingJobFacts[]>();
  for (const { sessionId, ...job } of jobs) {
    // Not every job names a task: `promotion_id` is what a promotion's job carries, and 0293 gives
    // those no task at all. They are not this fold's input — nothing here is about a promotion.
    if (!job.taskId) continue;
    const session = (sessionId && sessions.get(sessionId)) || null;
    byTask.set(job.taskId, [...(byTask.get(job.taskId) ?? []), { ...job, session }]);
  }
  return byTask;
}

/** Every criterion this project states, and where the work filed under each has landed. */
export async function readCriterionLanding(
  prisma: Pick<PrismaService,
    'projectAcceptanceCriterionDefinition' | 'projectCodebase' | 'projectIntegrationJob' | 'session'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionLandingAnswer[]> {
  const [definitions, branches] = await Promise.all([
    readCriterionLandingFacts(prisma, ownerId, projectId),
    readLandingBranches(prisma, projectId),
  ]);
  return criterionLanding(definitions, branches);
}
