"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDependencyState = computeDependencyState;
exports.dependencyStateFromCounts = dependencyStateFromCounts;
exports.statusPrerequisites = statusPrerequisites;
exports.verificationGateMessage = verificationGateMessage;
exports.canRun = canRun;
exports.dependencyEpochGate = dependencyEpochGate;
exports.wouldCreateCycle = wouldCreateCycle;
exports.wouldReplacementCreateCycle = wouldReplacementCreateCycle;
exports.dependencySatisfied = dependencySatisfied;
exports.dependenciesSatisfiedSql = dependenciesSatisfiedSql;
const shared_1 = require("@orbit/shared");
const task_supersession_1 = require("./task-supersession");
const verification_dependency_1 = require("./verification-dependency");
function computeDependencyState(prerequisites) {
    if (prerequisites.length === 0)
        return 'NONE';
    if (prerequisites.some((p) => p.status === shared_1.TaskStatus.CANCELLED || p.status === shared_1.TaskStatus.FAILED))
        return 'BLOCKED_FAILED';
    // A check that concluded NO — or that has no live check left to conclude anything — is terminal
    // in exactly the way a CANCELLED prerequisite is: nothing mechanical advances it, and the
    // sentence a person needs is "go and fix this", not "come back later". Every other gate is a
    // wait, and resolves as the check runs and the coordinator applies what it found.
    if (prerequisites.some((p) => p.verificationGate != null
        && verification_dependency_1.VERIFICATION_EPOCH_GATES_NEEDING_A_HUMAN.has(p.verificationGate)))
        return 'BLOCKED_FAILED';
    if (prerequisites.every((p) => p.status === shared_1.TaskStatus.DONE && p.verificationGate == null))
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
function dependencyStateFromCounts(counts) {
    if (counts.prerequisites === 0)
        return 'NONE';
    if (counts.terminal > 0)
        return 'BLOCKED_FAILED';
    return counts.done === counts.prerequisites ? 'READY' : 'BLOCKED';
}
/** The prerequisite facts for a set of plain statuses — no check among them. */
function statusPrerequisites(statuses) {
    return statuses.map((status) => ({ status }));
}
/**
 * What to tell a person whose run was refused because of this prerequisite gate.
 *
 * One sentence per clause, because "prerequisites are not complete" on a check that concluded FAIL
 * is the message that let the incident run: it names a wait, and what happened was a refusal.
 */
function verificationGateMessage(gate) {
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
        case 'VERDICT_NOT_APPLIED':
            return 'its PASS has not been applied yet — the coordinator applies it on the next pass';
        case 'SUBJECT_NOT_DONE':
            return 'the work it verified is not DONE any more';
    }
}
/** A task may be executed only when it has no unmet prerequisites. */
function canRun(state) {
    return state === 'NONE' || state === 'READY';
}
/**
 * The gate a prerequisite's epoch imposes on THIS dependent, or null if it imposes none.
 *
 * Exported so the callers that need to SAY which clause refused (Run Now, the batch path, the
 * planner's skip reason) read the same answer the satisfaction test did, self-exemption included.
 */
function dependencyEpochGate(prerequisiteId, epochOf, dependentVerifiesTaskId) {
    const entry = epochOf?.get(prerequisiteId);
    if (!entry || entry.gate == null)
        return null;
    // The waiting task is itself a check of this epoch's subject: it cannot be made to wait for the
    // conclusion it exists to reach.
    if (dependentVerifiesTaskId != null && entry.subjectTaskId === dependentVerifiesTaskId)
        return null;
    return entry.gate;
}
/**
 * Would adding "`taskId` depends on `dependsOnTaskId`" close a cycle in the existing
 * graph? A self-edge is a trivial cycle. Otherwise a cycle forms iff the prerequisite
 * already (transitively) depends on the dependent — i.e. following dependency edges
 * (dependent -> prerequisite) from `dependsOnTaskId` can reach `taskId`. We must keep
 * the graph a DAG so the completion-triggered runner can never loop forever.
 */
function wouldCreateCycle(edges, taskId, dependsOnTaskId) {
    if (taskId === dependsOnTaskId)
        return true;
    const adjacency = new Map();
    for (const e of edges) {
        const list = adjacency.get(e.taskId);
        if (list)
            list.push(e.dependsOnTaskId);
        else
            adjacency.set(e.taskId, [e.dependsOnTaskId]);
    }
    const seen = new Set();
    const stack = [dependsOnTaskId];
    while (stack.length) {
        const node = stack.pop();
        if (node === taskId)
            return true;
        if (seen.has(node))
            continue;
        seen.add(node);
        const next = adjacency.get(node);
        if (next)
            stack.push(...next);
    }
    return false;
}
/** Would atomically replacing one task's prerequisites with `dependsOnTaskIds` form a cycle? */
function wouldReplacementCreateCycle(edges, taskId, dependsOnTaskIds) {
    // The old outgoing edges disappear as part of the replacement, so validate against
    // the graph that will remain. Every proposed edge starts at the same task; a cycle
    // exists iff any proposed prerequisite can already reach that task.
    const retainedEdges = edges.filter((edge) => edge.taskId !== taskId);
    return dependsOnTaskIds.some((dependsOnTaskId) => wouldCreateCycle(retainedEdges, taskId, dependsOnTaskId));
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
function dependencySatisfied(prerequisiteId, statusOf, edges, epochOf, dependentVerifiesTaskId) {
    const satisfied = (id) => statusOf.get(id) === 'DONE' && dependencyEpochGate(id, epochOf, dependentVerifiesTaskId) == null;
    if (satisfied(prerequisiteId))
        return true;
    const { chain, truncated } = (0, task_supersession_1.successorChain)(prerequisiteId, edges);
    if (truncated)
        return false;
    const tail = chain.at(-1);
    if (tail === undefined)
        return false;
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
function dependenciesSatisfiedSql(alias = 't') {
    return `NOT EXISTS (
    SELECT 1 FROM task_dependency dep
     WHERE dep.task_id = ${alias}.id
       AND NOT EXISTS (
         WITH RECURSIVE chain(id, status, depth) AS (
           SELECT p.id, p.status::text, 0
             FROM task p WHERE p.id = dep.depends_on_task_id
           UNION ALL
           SELECT successor.id, successor.status::text, chain.depth + 1
             FROM chain
             JOIN task current ON current.id = chain.id
             JOIN task successor ON successor.id = current.superseded_by_task_id
            WHERE chain.depth < ${task_supersession_1.TASK_SUPERSESSION_MAX_HOPS}
         )
         SELECT 1 FROM chain
           JOIN task chain_task ON chain_task.id = chain.id
          WHERE chain.status = 'DONE'
            AND ${(0, verification_dependency_1.verificationEpochOpenSql)('chain_task', alias)}
       )
  )`;
}
//# sourceMappingURL=task-dependencies.js.map