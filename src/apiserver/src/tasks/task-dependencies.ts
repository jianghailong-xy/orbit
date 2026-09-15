import { TaskStatus } from '@orbit/shared';
import {
  LANDED_RESULTS,
  LandingReceiptFacts,
  landingBranchesFor,
  taskLanding,
} from '../projects/project-criterion-landing';
import { successorChain } from './task-supersession';
import {
  VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN,
  VerificationEpochEntry,
  VerificationEpochGate,
  verificationEpochOpenSql,
} from './verification-dependency';

/**
 * Where a task sits relative to its prerequisites (the tasks it `dependsOn`). Derived
 * live from the prerequisites' current rows — never stored — so it always reflects the
 * current graph (cf. TasksService.withRunning, which derives `running` the same way).
 *
 *   - no prerequisites                     -> NONE
 *   - any prerequisite CANCELLED / FAILED  -> BLOCKED_FAILED  (terminal failure; needs a human)
 *   - every prerequisite satisfied         -> READY
 *   - otherwise (some still OPEN / IN_PROGRESS) -> BLOCKED (waiting)
 * A prerequisite left at OPEN (e.g. a retryable run hiccup, see reclaimStalledTask) keeps
 * its dependents BLOCKED until it's retried; an explicit CANCELLED or a genuine FAILED run
 * escalates to BLOCKED_FAILED.
 *
 * "Satisfied" was `status === DONE` and nothing else, which is right for work and wrong for a
 * CHECK: a verification task goes DONE when its run ends, whatever it concluded, so a FAIL used to
 * release everything downstream of it. §13.3 DEP answers that from the subject's PASS epoch
 * instead, and `verificationEpochGate` carries which clause said no — see
 * `verification-dependency.ts`.
 */
export type DependencyState = 'NONE' | 'READY' | 'BLOCKED' | 'BLOCKED_FAILED';

/**
 * One prerequisite as this reduction reads it.
 *
 * `verificationGate` is null for an ordinary prerequisite AND for a check whose subject's PASS
 * epoch is open — in both cases the row's own status is the whole answer. It is non-null only when
 * a check is DONE (or on its way there) without a current pass behind it, which is the one case
 * where a `DONE` prerequisite must NOT read as satisfied.
 */
export interface DependencyPrerequisiteFact {
  status: TaskStatus;
  verificationGate?: VerificationEpochGate | null;
  /**
   * `[K5]`: this gate will not resolve without somebody acting — see `verificationLiveness`.
   *
   * Additive, and read only to move an answer from BLOCKED to BLOCKED_FAILED. A caller that does
   * not set it gets exactly the behaviour it had before the field existed, which is what keeps the
   * three spellings of §13.3 (this reduction, the SQL sweep and the chain walk) in agreement about
   * SATISFACTION while only one of them speaks about liveness.
   */
  verificationGateStalled?: boolean;
  /**
   * §2.5 J9: has this prerequisite's work LANDED on its project's integration line?
   *
   * Additive, and absent reads as "nothing to land" — which is what a prerequisite outside a
   * project, a codeless one, and every prerequisite of a project that has not started integrating
   * all are (§8.4 C2). Only `false` holds a dependent back, so a caller that does not gather this
   * gets exactly the behaviour it had before the field existed.
   *
   * It is a separate field from `status` because the two answer different questions and fail
   * differently. DONE says the acceptance command agreed with its exit code — inside the task's own
   * worktree, on a branch, with no statement about where that work IS. A dependent started on that
   * alone runs on a baseline that does not contain the thing it depends on.
   */
  landed?: boolean;
}

export function computeDependencyState(
  prerequisites: readonly DependencyPrerequisiteFact[],
): DependencyState {
  if (prerequisites.length === 0) return 'NONE';
  if (prerequisites.some((p) => p.status === TaskStatus.CANCELLED || p.status === TaskStatus.FAILED))
    return 'BLOCKED_FAILED';
  // A check that concluded NO — or that has no live check left to conclude anything — is terminal
  // in exactly the way a CANCELLED prerequisite is: nothing mechanical advances it, and the
  // sentence a person needs is "go and fix this", not "come back later". Every other gate is a
  // wait, and resolves as the check runs.
  if (prerequisites.some((p) => p.verificationGate != null
    && VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN.has(p.verificationGate)))
    return 'BLOCKED_FAILED';
  // `[K5]` / `[H0V2]` observation 1. The static set above names the gates that are terminal by
  // their own value; this names the ones that are terminal by the FACTS behind them — a check that
  // is DONE with no verdict, a PASS with no revision to apply, a run that was taken away. The
  // module's own promise about the remainder ("everything else resolves on its own as the check
  // runs") is false for exactly those, and reporting them as an ordinary wait is how a project
  // sits stopped with every liveness check green.
  if (prerequisites.some((p) => p.verificationGateStalled === true)) return 'BLOCKED_FAILED';
  // §2.5 J9: DONE and verified, AND its work is on the line this project integrates into. A wait
  // rather than a refusal — BLOCKED and not BLOCKED_FAILED — because nobody has to do anything
  // about it: the platform lands the prerequisite and the landing receipt releases this task
  // (J10). Telling a person to go and fix something would be advice to intervene in a step that
  // is already under way.
  if (prerequisites.every((p) => p.status === TaskStatus.DONE
    && p.verificationGate == null
    && p.landed !== false))
    return 'READY';
  return 'BLOCKED';
}

/**
 * The same rule as `computeDependencyState`, decided from tallies instead of from one entry per
 * prerequisite — for the callers that count in SQL because hydrating a row per edge is exactly the
 * fan-out they exist to avoid.
 *
 * It lives here, beside the rule it restates, so the two cannot drift apart unnoticed;
 * `task-dependencies.spec.ts` proves they agree on every combination of tallies.
 */
export function dependencyStateFromCounts(counts: {
  /** How many prerequisites the task has at all. Zero is what makes the state `NONE`. */
  prerequisites: number;
  /** Of those, how many are CANCELLED or FAILED — terminal, so waiting will not clear them. */
  terminal: number;
  /** Of those, how many are DONE. */
  done: number;
}): DependencyState {
  if (counts.prerequisites === 0) return 'NONE';
  if (counts.terminal > 0) return 'BLOCKED_FAILED';
  return counts.done === counts.prerequisites ? 'READY' : 'BLOCKED';
}

/** The prerequisite facts for a set of plain statuses — no check among them. */
export function statusPrerequisites(
  statuses: readonly TaskStatus[],
): DependencyPrerequisiteFact[] {
  return statuses.map((status) => ({ status }));
}

/**
 * What to tell a person whose run was refused because of this prerequisite gate.
 *
 * One sentence per clause, because "prerequisites are not complete" on a check that concluded FAIL
 * is the message that let the incident run: it names a wait, and what happened was a refusal.
 */
export function verificationGateMessage(gate: VerificationEpochGate): string {
  switch (gate) {
    case 'VERIFICATION_FAILED':
      return 'its verification concluded FAIL — fix what it found and re-run the check';
    case 'VERIFICATION_INCONCLUSIVE':
      return 'its verification concluded INCONCLUSIVE — re-run the check';
    case 'NO_LIVE_VERIFICATION':
      return 'every verification of it was cancelled or replaced — file one that can conclude';
    case 'VERIFICATION_IN_FLIGHT':
      return 'its verification has not concluded yet';
    case 'VERDICT_ABSENT':
      return 'its verification finished without recording a verdict';
    case 'VERDICT_UNREVISIONED':
      return 'its verdict predates revision tracking — re-run the check to record a new one';
    case 'RUN_NOT_SETTLED':
      return 'its verification run has not finished naturally yet';
    case 'SUBJECT_NOT_DONE':
      return 'the work it verified is not DONE any more';
  }
}

/** A task may be executed only when it has no unmet prerequisites. */
export function canRun(state: DependencyState): boolean {
  return state === 'NONE' || state === 'READY';
}

/**
 * The gate a prerequisite's epoch imposes on THIS dependent, or null if it imposes none.
 *
 * Exported so the callers that need to SAY which clause refused (Run Now, the batch path, the
 * planner's skip reason) read the same answer the satisfaction test did, self-exemption included.
 */
export function dependencyEpochGate(
  prerequisiteId: string,
  epochOf: ReadonlyMap<string, VerificationEpochEntry> | undefined,
  dependentVerifiesTaskId?: string | null,
): VerificationEpochGate | null {
  const entry = epochOf?.get(prerequisiteId);
  if (!entry || entry.gate == null) return null;
  // The waiting task is itself a check of this epoch's subject: it cannot be made to wait for the
  // conclusion it exists to reach.
  if (dependentVerifiesTaskId != null && entry.subjectTaskId === dependentVerifiesTaskId) return null;
  return entry.gate;
}

/**
 * `[K5]`: does that same gate need somebody to act, rather than time to pass?
 *
 * A sibling of `dependencyEpochGate` and not a field on its return, because it has to observe the
 * SAME self-exemption: a check waiting on its own subject is not gated at all, so it is not stalled
 * either — telling a person to go and unstick a check that is about to conclude the thing it is
 * waiting for would be advice to break it.
 */
export function dependencyEpochStalled(
  prerequisiteId: string,
  epochOf: ReadonlyMap<string, VerificationEpochEntry> | undefined,
  dependentVerifiesTaskId?: string | null,
): boolean {
  if (dependencyEpochGate(prerequisiteId, epochOf, dependentVerifiesTaskId) == null) return false;
  return epochOf?.get(prerequisiteId)?.stalled === true;
}

/** A dependency edge: `taskId` (the dependent) waits on `dependsOnTaskId` (the prerequisite). */
export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

/**
 * Would adding "`taskId` depends on `dependsOnTaskId`" close a cycle in the existing
 * graph? A self-edge is a trivial cycle. Otherwise a cycle forms iff the prerequisite
 * already (transitively) depends on the dependent — i.e. following dependency edges
 * (dependent -> prerequisite) from `dependsOnTaskId` can reach `taskId`. We must keep
 * the graph a DAG so the completion-triggered runner can never loop forever.
 */
export function wouldCreateCycle(
  edges: DependencyEdge[],
  taskId: string,
  dependsOnTaskId: string,
): boolean {
  if (taskId === dependsOnTaskId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.taskId);
    if (list) list.push(e.dependsOnTaskId);
    else adjacency.set(e.taskId, [e.dependsOnTaskId]);
  }
  const seen = new Set<string>();
  const stack = [dependsOnTaskId];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === taskId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    const next = adjacency.get(node);
    if (next) stack.push(...next);
  }
  return false;
}

/** Would atomically replacing one task's prerequisites with `dependsOnTaskIds` form a cycle? */
export function wouldReplacementCreateCycle(
  edges: DependencyEdge[],
  taskId: string,
  dependsOnTaskIds: string[],
): boolean {
  // The old outgoing edges disappear as part of the replacement, so validate against
  // the graph that will remain. Every proposed edge starts at the same task; a cycle
  // exists iff any proposed prerequisite can already reach that task.
  const retainedEdges = edges.filter((edge) => edge.taskId !== taskId);
  return dependsOnTaskIds.some((dependsOnTaskId) =>
    wouldCreateCycle(retainedEdges, taskId, dependsOnTaskId),
  );
}

/**
 * §13.6 SU9: is a PREREQUISITE satisfied, when the attempt it names was replaced?
 *
 * A dependency edge points at an attempt. When that attempt is superseded the work did not stop —
 * it moved to the successor — and the edge, which nobody re-pointed, still names the old row. Read
 * literally (`status = 'DONE'`) it is a prerequisite that can never complete: the old attempt will
 * never be dispatched again, so every task downstream of it is blocked for good, and the project
 * idles with no blocker and nothing to act on. That is the same silent shape this whole unit is
 * about, reached through the relation instead of through the status.
 *
 * So the edge is followed to the END of the supersession chain and answered from there: the work
 * this dependency is waiting on is whatever attempt currently holds it.
 *
 * Fail-closed in every case where the chain cannot be trusted:
 *
 *   - a cycle or an over-long chain (`successorChain` reports `truncated`) — the walk found data
 *     0128's trigger says is unwritable, and guessing about it is worse than waiting;
 *   - a successor this snapshot cannot see — a project-scoped read may not infer a row it did not
 *     read, the same rule an unknown prerequisite already follows;
 *   - `SUCCESSOR_DELETED` (retired with no pointer) and `ABANDONED` — nothing took the work over,
 *     so nothing will complete it. The edge stays unsatisfied and a person has to decide.
 *
 * §13.3 DEP rides on the same walk: `epochOf` carries, per task id, whose PASS epoch that row
 * belongs to and why it is not open, and a non-null gate makes `DONE` stop meaning satisfied. It is
 * applied to the CHAIN TAIL as well as to the named row for the same reason SU9 walks at all — the
 * attempt that currently holds the work is the one whose epoch decides. Omitted (or absent for an
 * id) reads as "nothing checks this", which is what most prerequisites are and what a snapshot
 * taken before DEP recorded.
 *
 * `dependentVerifiesTaskId` is the subject the WAITING task checks, and it breaks the one loop this
 * rule can create: a check that depends on the subject it checks — or on a sibling check of it —
 * would otherwise be waiting on its own conclusion, which nothing can ever produce.
 */
export function dependencySatisfied(
  prerequisiteId: string,
  statusOf: ReadonlyMap<string, string>,
  edges: ReadonlyMap<string, string | null>,
  epochOf?: ReadonlyMap<string, VerificationEpochEntry>,
  dependentVerifiesTaskId?: string | null,
): boolean {
  const satisfied = (id: string): boolean =>
    statusOf.get(id) === 'DONE' && dependencyEpochGate(id, epochOf, dependentVerifiesTaskId) == null;
  if (satisfied(prerequisiteId)) return true;
  const { chain, truncated } = successorChain(prerequisiteId, edges);
  if (truncated) return false;
  const tail = chain.at(-1);
  if (tail === undefined) return false;
  return satisfied(tail);
}

/**
 * §13.6 SU9 as a correlated SQL predicate: every prerequisite of `alias` is satisfied.
 *
 * The legacy sweeps ask this question in SQL, and the Coordinator's pass asks it in TypeScript
 * (`dependencySatisfied`). They have to give the same answer or a task is ready to one and blocked
 * to the other, which is how the two dispatch paths come to disagree about the same row.
 *
 * A prerequisite is satisfied when its chain CONTAINS a DONE. That is the same thing as "its tail
 * is DONE": SU4 only lets a CANCELLED or FAILED task name a successor, so no interior link of a
 * chain can be DONE — only the end of it can. Written this way because it needs no ORDER BY and
 * stops as soon as it finds one.
 *
 * ...and §13.3 DEP, joined onto the chain row rather than bolted on outside it, so "DONE" is
 * qualified for whichever attempt actually holds the work. `verificationEpochOpenSql` is TRUE for
 * every task that is not a check, so ordinary prerequisites are untouched by it.
 *
 * The depth cap mirrors `TASK_SUPERSESSION_MAX_HOPS`: 0128's trigger refuses a cycle, and a walk
 * that reaches the cap has found data no writer here produced, so it stops rather than spinning.
 */
export function dependenciesSatisfiedSql(
  alias = 't',
  { ignoreLanding = false }: { ignoreLanding?: boolean } = {},
): string {
  // `ignoreLanding` answers a DIFFERENT question — "would this task be ready if landing were not
  // required" — and it exists for exactly one reader: the run queue, which subtracts the two to say
  // how many tasks are held up by nothing but a landing (§7.2 V6). It is never the dispatch gate.
  const landed = ignoreLanding ? 'TRUE' : prerequisiteLandedSql('chain_task');
  return `NOT EXISTS (
    SELECT 1 FROM task_dependency dep
     WHERE dep.task_id = ${alias}.id
       AND NOT EXISTS (
         SELECT 1
           FROM task chain_task
          WHERE chain_task.id = task_dependency_tail_id(dep.depends_on_task_id)
            AND chain_task.status = 'DONE'
            AND ${verificationEpochOpenSql('chain_task', alias)}
            AND ${landed}
       )
  )`;
}

/** A full ref as a merge receipt spells `target_branch`: the runner reports a branch, not a ref. */
function branchNameSql(ref: string): string {
  return `regexp_replace(${ref}, '^refs/heads/', '')`;
}

/**
 * §2.5 J9 in SQL, correlated to a PREREQUISITE alias: is there nothing left for it to land?
 *
 * TRUE — nothing to wait for — in three cases, and they are disjuncts rather than a filter because
 * each one means "this prerequisite has no landing to do", not "skip the check":
 *
 *  1. **Its project has not started integrating** (§8.4 C2), which includes a task filed under no
 *     project at all. Nothing lands work on a line that does not exist yet, so requiring a landing
 *     would hold every dependent of every project in this repository for ever.
 *  2. **It is not code work** (§1.1 `isCodeTask`): declared codeless, or its newest work session did
 *     not run in a worktree on a branch. A documentation prerequisite has no commit to land, and
 *     SR27 says the same thing one contract over.
 *  3. **A receipt says it landed** on the project's integration line or on its upstream (§1.4
 *     `taskLanding` ∈ {ON_INTEGRATION_LINE, ON_UPSTREAM}) — the upstream counts because work on main
 *     is also everywhere the project branch will ever take it.
 *
 * It reads `project_codebase` and `session_merge_receipt` only, never the integration job table:
 * whether the platform has a job queued is a different fact from whether the work is THERE, and
 * keeping the job table out is what lets this ship before the queue that fills it does.
 */
export function prerequisiteLandedSql(alias = 'chain_task'): string {
  const results = LANDED_RESULTS.map((result) => `'${result}'`).join(', ');
  return `(
      NOT EXISTS (
        SELECT 1 FROM "project_codebase" landing_line
         WHERE landing_line."project_id" = ${alias}."project_id"
           AND landing_line."slot" = 'primary'
           AND landing_line."integration_started_at" IS NOT NULL
      )
      OR ${alias}."codeless" = true
      OR NOT EXISTS (
        SELECT 1 FROM "session" landing_work
         WHERE landing_work."id" = (
                 SELECT newest_work."id" FROM "session" newest_work
                  WHERE newest_work."task_id" = ${alias}."id"
                    AND newest_work."starts_task_work" = true
                    AND newest_work."deleted_at" IS NULL
                  ORDER BY newest_work."created_at" DESC, newest_work."id" DESC
                  LIMIT 1
               )
           AND landing_work."isolation_status" = 'worktree'
           AND landing_work."branch" IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM "session_merge_receipt" landing_receipt
          JOIN "project_codebase" receipt_line
            ON receipt_line."project_id" = ${alias}."project_id"
           AND receipt_line."slot" = 'primary'
         WHERE landing_receipt."task_id" = ${alias}."id"
           AND landing_receipt."result" IN (${results})
           AND landing_receipt."target_branch" IN (
                 ${branchNameSql('receipt_line."integration_ref"')},
                 ${branchNameSql('receipt_line."upstream_ref"')}
               )
      )
    )`;
}

/** One prerequisite's rows, as the TypeScript spelling of J9 reads them. */
export interface PrerequisiteLandingFacts {
  codeless: boolean;
  projectId: string | null;
  /** The project's primary binding, or null when it has none. */
  codebase: { upstreamRef: string; integrationRef: string; integrationStartedAt: Date | null } | null;
  /** Its newest work session — §1.1's whole evidence that a task is code work. */
  work: { isolationStatus: string | null; branch: string | null } | null;
  receipts: readonly LandingReceiptFacts[];
}

/**
 * §2.5 J9 as a pure function, so the dispatch paths that read rows and the sweeps that count in SQL
 * cannot answer differently — the same hazard `dependenciesSatisfiedSql` names about SU9, one
 * clause further along. The three disjuncts are `prerequisiteLandedSql`'s, in the same order.
 */
export function prerequisiteLanded(facts: PrerequisiteLandingFacts): boolean {
  if (!facts.codebase?.integrationStartedAt) return true;
  if (facts.codeless || facts.projectId === null) return true;
  if (facts.work?.isolationStatus !== 'worktree' || !facts.work.branch) return true;
  return taskLanding(facts.receipts, landingBranchesFor(facts.codebase)) !== 'NOT_KNOWN';
}

/**
 * What to tell a person whose run was refused because a prerequisite is finished but not yet on the
 * line. A wait, and one nobody has to act on — so it says who is doing it, rather than sending the
 * reader to look for something to fix.
 */
export const PREREQUISITE_NOT_LANDED_MESSAGE =
  'A prerequisite is finished but its work has not landed on this project\'s integration line yet '
  + '— it starts by itself once the landing is recorded';
