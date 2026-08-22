"use strict";
/**
 * Parent task aggregation (contract AC7 / §13.1).
 *
 * One pure function over one snapshot of a Project's tasks. It answers a single question — given
 * what the children are RIGHT NOW, what should each parent's status be — and returns the writes
 * that would make that true. It performs none of them: the caller applies each as a compare-and-set
 * against the status this plan observed, so a snapshot that went stale changes nothing rather than
 * overwriting somebody else's newer fact.
 *
 * Being a recomputation is what makes it idempotent (AG1). There is no accumulator to double-count
 * and no permanent idempotency key to collide with, so a duplicated event, an event that arrives
 * out of order, two children completing concurrently and a process that restarts halfway all land
 * on the same answer: the one the current children imply. That is also why the plan is deliberately
 * NOT an entry in the durable action ledger (AG5) — a key built from a fact that can return to an
 * earlier value turns "do this again because the world came back" into "already did this once".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_VERDICTS = exports.TASK_COMPLETION_POLICIES = void 0;
exports.isAggregateParent = isAggregateParent;
exports.foremanPolicyConflict = foremanPolicyConflict;
exports.verificationIsLive = verificationIsLive;
exports.verificationSubjectReady = verificationSubjectReady;
exports.aggregationChildCounts = aggregationChildCounts;
exports.planTaskAggregation = planTaskAggregation;
const task_supersession_1 = require("../tasks/task-supersession");
exports.TASK_COMPLETION_POLICIES = [
    'MANUAL',
    'ALL_CHILDREN_DONE',
    'VERIFICATION_PASSED',
];
exports.TASK_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'];
/** AG6: true when the ONLY thing that may complete this task is the recomputation above. */
function isAggregateParent(fact) {
    if (fact.completionPolicy === 'MANUAL')
        return false;
    return fact.hasDirectChildren;
}
/**
 * AG6's other end: the combination that would give one task two completion owners.
 *
 * `true` means the write must be refused — an explicit Foreman is a task whose SESSION is the work,
 * and a non-MANUAL policy says the children decide when it is finished. One task cannot be both.
 * Shared by `TasksService` and by the `task_foreman_manual_policy` constraint so the API and the
 * database refuse the same pair.
 */
function foremanPolicyConflict(fact) {
    return fact.isForeman && fact.completionPolicy !== 'MANUAL';
}
/**
 * Statuses a parent may be moved OUT of by aggregation.
 *
 * `FAILED` is in the set and `CANCELLED` is not, and the difference is who said it. CANCELLED is a
 * statement somebody made ABOUT the parent — aggregation only ever answers for the children, so it
 * leaves that alone. `FAILED` on an aggregate parent is not a statement anybody made: it is the
 * residue of a run that AG6 says should never have been started, and it is the exact shape this
 * project's own incident left behind on three roll-up nodes.
 *
 * Leaving it out is a wedge with no exit, which is why it had to move. AG6's gates skip a FAILED
 * aggregate parent before the retry ladder, and `TASK_AGGREGATE_PARENT` is a NON-blocking refusal —
 * so nothing retries it, nothing opens a row about it, and if aggregation also refuses to touch it,
 * its children can all reach DONE and the parent sits FAILED for ever with no next step anywhere.
 * That is §10.3's silent idling with a status on it.
 *
 * Recovery is therefore the aggregation role simply taking the status back: a FAILED parent whose
 * children are settled becomes DONE, and one whose children are outstanding becomes OPEN, both
 * derived from the same recomputation as every other transition here. The failed Session is NOT
 * touched — it keeps its real result, its error and its place in `failureCount`. What is corrected
 * is only the claim the TASK row was making, which was never its to make.
 */
const AGGREGATABLE_FROM = new Set([
    'OPEN',
    'IN_PROGRESS',
    'FAILED',
]);
/**
 * Is this check still one the subject can be waiting ON (§13.2 V8-d)?
 *
 * Two ways to stop being one, and they are the same sentence twice: RETIRED (the re-run that
 * replaced it is itself pointed at this subject and counted on its own row) and CANCELLED
 * (somebody stopped it, so the subject is back to having no check at all). Neither is a wait —
 * counting either would leave a `VERIFICATION_PASSED` subject outstanding for ever on a row nobody
 * will run, which is the same silent idling AG7 exists to end, one table over.
 *
 * Shared with the commit point on purpose. The planner decides "there is no live check, file one"
 * and the effect re-decides "there is still no live check" under the lock; two spellings of that
 * would eventually disagree about a CANCELLED one, and then the loop would file a check the effect
 * refuses, for ever, at one generation per pass.
 */
function verificationIsLive(fact) {
    return !fact.retired && fact.status !== 'CANCELLED';
}
/**
 * AG8 — §7.4 precondition 3, asked as a question about the SUBJECT rather than about its status.
 *
 * "A check may not run before the thing it checks is finished" is right for every ordinary subject
 * and is a deadlock for one shape: a `VERIFICATION_PASSED` aggregate parent is finished BY the
 * check, so requiring it to be DONE first makes the check undispatchable and the subject
 * uncompletable, each waiting on the other. AG7 reports that as `NO_VERIFICATION_FILED`; this is
 * the other half — filing the check is pointless if nothing will ever run it.
 *
 * The exception is exactly as narrow as the deadlock:
 *
 *  - Only `VERIFICATION_PASSED`, and only WITH children. `ALL_CHILDREN_DONE` has no such loop (the
 *    children complete it), and a childless task is an ordinary leaf whose policy is inert (AG4).
 *  - Only when the children are in — `outstanding === 0 && done > 0`, the same clause AG1 uses.
 *    A check dispatched over unfinished subtasks would be checking a moving target, which is the
 *    thing precondition 3 exists to prevent.
 *  - `unresolvable === 0` follows from `outstanding === 0` and is asserted by the caller's counts
 *    rather than restated: a subtree with a replacement outside it has AG7's own row to answer.
 *
 * The parent still gets NO Session of its own — AG6 is untouched, and this is about a DIFFERENT
 * task (the check) being allowed to run.
 */
function verificationSubjectReady(fact) {
    if (fact.status === 'DONE')
        return true;
    if (fact.status !== 'OPEN' && fact.status !== 'IN_PROGRESS')
        return false;
    if (fact.completionPolicy !== 'VERIFICATION_PASSED' || !fact.hasDirectChildren)
        return false;
    return fact.childrenOutstanding === 0 && fact.childrenDone > 0;
}
/**
 * The child counts AG8 needs, for every task in one snapshot, from the same walk `recompute` uses.
 *
 * Exported so the planner and any commit-point re-read ask ONE function rather than each writing
 * "outstanding means not DONE and not CANCELLED" and drifting on the supersession clause — which is
 * precisely the clause that was wrong above.
 */
function aggregationChildCounts(tasks) {
    const plan = planTaskAggregation(tasks);
    const counts = new Map();
    for (const entry of plan.childCounts)
        counts.set(entry.taskId, entry.counts);
    return counts;
}
/**
 * Recompute every parent in `tasks` from its direct children.
 *
 * Bottom-up and multi-level in one pass (AG2): a grandparent is evaluated against what this same
 * plan concluded about its children, so a leaf finishing settles the whole chain above it in one
 * reconcile rather than one level per delivered event.
 *
 * `tasks` is one Project's tasks. A `parentTaskId` pointing outside the set is treated as no parent
 * here — a subtask must be in its parent's project (TasksService.assertParentEligible), so the only
 * way to observe that is a task on its way between projects, and guessing about the half of a tree
 * this snapshot cannot see is worse than waiting for the write that moved it to wake the loop.
 */
function planTaskAggregation(tasks) {
    const byId = new Map();
    for (const task of tasks)
        byId.set(task.id, task);
    const cycleTaskIds = findParentCycles(byId);
    // AG2: a cycle has no bottom, so there is no "current children" to recompute anybody from — and
    // therefore nothing to say about whether a parent's condition is satisfiable either. The
    // DEPENDENCY_CYCLE row is the one a person acts on, and a second, derived row per member would
    // describe the same inconsistency in worse words.
    if (cycleTaskIds.length > 0) {
        return { aggregations: [], completionGaps: [], childCounts: [], cycleTaskIds };
    }
    const children = new Map();
    const verifiers = new Map();
    for (const task of tasks) {
        if (task.parentTaskId && byId.has(task.parentTaskId)) {
            push(children, task.parentTaskId, task);
        }
        if (task.verifiesTaskId && byId.has(task.verifiesTaskId)) {
            push(verifiers, task.verifiesTaskId, task);
        }
    }
    // §13.6 SU6's derived half, resolved once for the whole snapshot: a task is obsolete when it was
    // itself retired OR when it checks work that was. Both settle, and computing it here rather than
    // in `recompute` is what keeps the parent's answer and the verification's answer consistent.
    const obsolete = new Set();
    for (const task of tasks) {
        if ((0, task_supersession_1.taskIsObsolete)({
            retirement: task.retirement ?? null,
            subjectRetirement: task.verifiesTaskId
                ? (byId.get(task.verifiesTaskId)?.retirement ?? null)
                : null,
        })) {
            obsolete.add(task.id);
        }
    }
    const planned = new Map();
    const gaps = new Map();
    const childCounts = [];
    // `effective` is the status the parent above should be judged against: the recomputed one where
    // this plan changes it, the stored one everywhere else.
    const effective = new Map();
    // Sorted ids, each expanded bottom-up. Starting mid-tree is harmless: that node's own subtree is
    // evaluated first, and an ancestor reached later skips everything already settled.
    for (const root of [...byId.keys()].sort()) {
        for (const id of postOrder(root, children, effective)) {
            const task = byId.get(id);
            const { write, gap, counts } = recompute(task, children.get(id) ?? [], verifiers.get(id) ?? [], effective, obsolete, byId);
            if (write)
                planned.set(id, write);
            if (gap)
                gaps.set(id, gap);
            if (counts)
                childCounts.push({ taskId: id, counts });
            effective.set(id, write ? write.to : task.status);
        }
    }
    return {
        aggregations: [...planned.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
        completionGaps: [...gaps.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
        childCounts: childCounts.sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
        cycleTaskIds,
    };
}
/**
 * Does this replaced child's work stay under `parentId`?
 *
 * Walks the supersession chain to its end and asks whether that attempt is a child of the same
 * parent. Truncation (a cycle, or a chain longer than the database can write) answers NO, and so
 * does a successor this snapshot cannot see: both are cases where the honest answer is "cannot
 * tell", and a parent may not be completed on one.
 */
function chainStaysUnder(child, parentId, byId) {
    const edges = new Map([...byId].map(([id, task]) => [id, task.supersededByTaskId ?? null]));
    const { chain, truncated } = (0, task_supersession_1.successorChain)(child.id, edges);
    if (truncated)
        return false;
    const tail = chain.at(-1);
    if (tail === undefined)
        return false;
    return byId.get(tail)?.parentTaskId === parentId;
}
const NOTHING = { write: null, gap: null, counts: null };
function recompute(task, childTasks, verifierTasks, effective, obsolete, byId) {
    // §13.6 SU6, about the task being RECOMPUTED rather than about its children. A retired parent's
    // CANCELLED or FAILED is the audit fact SU4 preserves, and aggregation may not rewrite it — not
    // to DONE when its children happen to have finished, and not back to OPEN when one is reopened.
    //
    // Left in, this is not merely wrong but LOUD: 0130's `task_retirement_status_check` refuses the
    // write, the caller logs a failure, and the next event recomputes the same plan and fails the
    // same way — a retired parent with subtasks would produce an error on every reconcile forever.
    //
    // It is also why a retired parent gets no AG7 gap: nothing is waiting on it, and asking somebody
    // to give a replaced attempt a subtask is a request addressed to no one.
    if (obsolete.has(task.id))
        return NOTHING;
    if (task.completionPolicy === 'MANUAL')
        return NOTHING;
    // AG4. A policy on a childless task is inert, and stays inert rather than becoming inert-until-
    // someone-adds-a-child: nothing here writes when there is nothing to aggregate over. It is not a
    // gap either — AG6 does not refuse to dispatch it, so an ordinary leaf is exactly what it is.
    if (childTasks.length === 0)
        return NOTHING;
    let done = 0;
    let cancelled = 0;
    let outstanding = 0;
    let unresolvable = 0;
    for (const child of childTasks) {
        // DONE and CANCELLED settle; everything else — including FAILED — is outstanding. A failed
        // child is the case this distinction exists for: it has stopped, which is not the same as
        // being finished, and counting it as settled would complete a parent over a broken subtask.
        //
        // §13.6 SU6 adds the one exception, and it is the same sentence read the other way: a REPLACED
        // attempt has stopped AND is not the work anymore. Its successor is a sibling in this very
        // project, outstanding on its own account until it finishes, so counting the retired attempt
        // as unfinished counts one piece of work twice and holds the parent open on a row nobody will
        // ever move again. It settles as CANCELLED, which is what it is: an attempt that ended without
        // finishing, whose ending is now history.
        const status = effective.get(child.id) ?? child.status;
        // A replaced child settles ONLY when the work is still represented in this parent's subtree —
        // which means its chain ends at another child of THIS parent, counted on its own row.
        //
        // "The successor is a sibling" is a natural assumption and an unenforced one: SU3 requires the
        // same project, and nothing requires the same parent. A child superseded by a task under a
        // different parent (or under none) would otherwise settle here while the work that replaced it
        // is outside this subtree entirely, and the parent would report DONE over it. Fail closed: the
        // child stays outstanding, and re-parenting the successor — or unlinking — is a decision
        // somebody makes.
        const retired = obsolete.has(child.id);
        const replacedWithin = retired && chainStaysUnder(child, task.id, byId);
        // ORDER IS THE RULE HERE, and it was wrong in exactly one place. `CANCELLED` used to be tested
        // before the supersession clause, which meant a child that was cancelled BECAUSE it was
        // superseded settled on its status alone — and the fail-closed answer above, whose entire job
        // is to stop a parent completing over work that left its subtree, never ran for the shape it
        // was written for. SU4 preserves the retirement of a replaced attempt by CANCELLING it, so
        // that is not a corner case, it is the normal spelling.
        //
        // DONE stays first, and deliberately: if the child FINISHED, the work under this parent was
        // done here, and where a later attempt went is somebody else's ledger.
        if (status === 'DONE')
            done += 1;
        // A retired attempt whose work is NOT represented under this parent. Outstanding — the parent
        // is genuinely not finished — and outstanding FOREVER, because §13.6 SU6 never dispatches this
        // row again. `unresolvable` is what separates that from an ordinary wait; see AG7.
        //
        // Deliberately BEFORE the settled clause, and deliberately not narrowed to "names a successor".
        // Both halves are the fail-closed direction:
        //
        //  - Before, because SU4 preserves a replaced attempt by CANCELLING it. Testing `CANCELLED`
        //    first meant the fail-closed rule never ran for the shape it was written for, and the
        //    parent completed over work that had moved out from under it.
        //  - Not narrowed, because a retirement with no successor — ABANDONED, or SUPERSEDED whose
        //    successor was deleted (0128's FK is ON DELETE SET NULL) — is a subtask this parent is
        //    still counting and nobody will ever finish. "It stopped" is not "the parent's condition
        //    is satisfied": AG1 needs a DONE, and an abandoned attempt supplies none. Reading it as
        //    settled would complete a roll-up over work that was explicitly dropped.
        //
        // Both shapes are recoverable, and by a WRITE rather than by waiting, which is why they are a
        // §11 row and not a status: re-parent the successor here, clear the retirement so the row is an
        // ordinary child again, or remove the subtask.
        else if (retired && !replacedWithin) {
            outstanding += 1;
            unresolvable += 1;
        }
        // Settled: cancelled on its own account, or replaced by an attempt that is a sibling here and
        // is counted on its own row. An ABANDONED child with no successor lands here too — its chain
        // ends at itself, under this parent, which is what "dropped on purpose" means.
        else if (status === 'CANCELLED' || replacedWithin)
            cancelled += 1;
        else
            outstanding += 1;
    }
    const childrenSettled = outstanding === 0 && done > 0;
    let passed = 0;
    let verificationsOutstanding = 0;
    for (const verifier of verifierTasks) {
        // A retired check is neither a pass nor an outstanding one: the re-run that replaced it is
        // itself pointed at this subject and is counted on its own row. Leaving it outstanding would
        // make VERIFICATION_PASSED unreachable for every subject whose check was ever re-filed, which
        // is precisely the shape this project's own 04R / 04R2 / 04R3 history has.
        const status = effective.get(verifier.id) ?? verifier.status;
        if (!verificationIsLive({ status, retired: obsolete.has(verifier.id) }))
            continue;
        if (status === 'DONE' && verifier.verdict === 'PASS')
            passed += 1;
        else
            verificationsOutstanding += 1;
    }
    // Same shape as AG4 and for the same reason: "every one of zero verifications passed" is true and
    // means nothing, so VERIFICATION_PASSED with nothing pointed at this task never completes it.
    const verified = task.completionPolicy === 'VERIFICATION_PASSED'
        ? verificationsOutstanding === 0 && passed > 0
        : true;
    const satisfied = childrenSettled && verified;
    const counts = { done, outstanding, unresolvable };
    const evidence = {
        children: { total: childTasks.length, done, cancelled, outstanding },
        verifications: {
            total: verifierTasks.length,
            passed,
            outstanding: verificationsOutstanding,
        },
    };
    if (satisfied) {
        // A CANCELLED parent is left alone: that is a statement somebody made about the parent itself,
        // and aggregation only ever answers for the children. See `AGGREGATABLE_FROM` for why FAILED
        // is not in the same sentence any more.
        if (!AGGREGATABLE_FROM.has(task.status))
            return { ...NOTHING, counts };
        return {
            counts,
            write: {
                taskId: task.id,
                from: task.status,
                to: 'DONE',
                policy: task.completionPolicy,
                reason: task.completionPolicy === 'VERIFICATION_PASSED'
                    ? 'VERIFICATION_PASSED'
                    : 'ALL_CHILDREN_DONE',
                evidence,
            },
            gap: null,
        };
    }
    // AG7, computed from the counts above rather than from a second read of the same rows.
    //
    // Only for a status aggregation could still move this task out of: a DONE parent is not stuck —
    // AG3 below reopens it in this very plan, and reporting both would open a row against a task
    // that is about to change status under it. CANCELLED is somebody's decision about the parent and
    // needs no next step from anybody.
    const reason = AGGREGATABLE_FROM.has(task.status)
        ? gapReason({
            policy: task.completionPolicy,
            done,
            outstanding,
            unresolvable,
            childrenSettled,
            passed,
            verificationsOutstanding,
        })
        : null;
    const gap = reason === null
        ? null
        : {
            taskId: task.id,
            status: task.status,
            policy: task.completionPolicy,
            reason,
            evidence: { ...evidence, children: { ...evidence.children, unresolvable } },
        };
    // AG3. The reverse direction is the half that keeps this a recomputation: without it a reopened
    // child, a new child, a revoked verdict or a verification that came back FAIL would leave the
    // parent asserting a completion its own subtree no longer supports.
    //
    // `FAILED` joins `DONE` here for the reason `AGGREGATABLE_FROM` gives: it is the other status an
    // aggregate parent can be stuck in while its children are still moving, and the only difference
    // is which wrong claim the row is making. OPEN is what both become — the children are
    // outstanding, so the parent is outstanding.
    if (task.status !== 'DONE' && task.status !== 'FAILED')
        return { write: null, gap, counts };
    return {
        counts,
        write: {
            taskId: task.id,
            from: task.status,
            to: 'OPEN',
            policy: task.completionPolicy,
            reason: childrenSettled ? 'VERIFICATION_OUTSTANDING' : 'CHILDREN_OUTSTANDING',
            evidence,
        },
        gap,
    };
}
/**
 * Which half of the completion condition the current rows can never satisfy, if either.
 *
 * Both clauses are the same sentence AG4 makes about a childless parent, read one level in: a
 * count that is zero and can no longer move is not "not yet", it is "not from here". Nothing about
 * TIME closes either one — no child left will change status, and no check exists to conclude — so
 * waiting is not a strategy and the loop says so instead.
 *
 * Order matters when both hold. `NO_CHILD_CAN_COMPLETE` wins because it is the one that has to be
 * fixed first: a `VERIFICATION_PASSED` roll-up with no completed child would still not complete on
 * a PASS, so asking for the check first would send somebody to file a check that changes nothing.
 */
function gapReason(counts) {
    const { policy, done, outstanding, unresolvable, childrenSettled } = counts;
    // Every child settled and not one of them finished. AG1's forward clause needs `done > 0`, and
    // no event these rows can still produce provides it.
    if (outstanding === 0 && done === 0)
        return 'NO_CHILD_CAN_COMPLETE';
    // Outstanding, and every one of them on a row §13.6 SU6 will never dispatch again. ONE live
    // child is enough to make this an ordinary wait instead — the parent is then blocked on work
    // that is still moving, which is what a parent is for.
    if (outstanding > 0 && outstanding === unresolvable)
        return 'SUCCESSOR_OUTSIDE_SUBTREE';
    // The children are in; the policy waits on a check, and not one live check names this task.
    // `passed` and `verificationsOutstanding` both zero is exactly "there are none" — a FAIL or an
    // unfinished check counts as outstanding, and that is an ordinary wait rather than a gap.
    if (policy === 'VERIFICATION_PASSED' && childrenSettled
        && counts.passed === 0 && counts.verificationsOutstanding === 0) {
        return 'NO_VERIFICATION_FILED';
    }
    return null;
}
/**
 * Every task that lies on a `parentTaskId` cycle, sorted.
 *
 * Iterative rather than recursive, and bounded by the node count rather than by a depth constant:
 * this exists precisely for data that should be impossible, so it must not trust the shape it is
 * handed. Nodes that merely hang BELOW a cycle are not reported — they are not themselves the
 * inconsistency — but they get no aggregation either, because the whole Project is skipped.
 */
function findParentCycles(byId) {
    const state = new Map();
    const onCycle = new Set();
    for (const start of [...byId.keys()].sort()) {
        if (state.has(start))
            continue;
        const path = [];
        let cursor = start;
        while (cursor && !state.has(cursor)) {
            state.set(cursor, 'VISITING');
            path.push(cursor);
            const next = byId.get(cursor)?.parentTaskId ?? null;
            cursor = next && byId.has(next) ? next : null;
        }
        if (cursor && state.get(cursor) === 'VISITING') {
            for (const id of path.slice(path.indexOf(cursor)))
                onCycle.add(id);
        }
        for (const id of path)
            state.set(id, 'DONE');
    }
    return [...onCycle].sort();
}
/** Ids of `root`'s not-yet-evaluated subtree, children before parents. */
function postOrder(root, children, evaluated) {
    if (evaluated.has(root))
        return [];
    const out = [];
    const stack = [{ id: root, expanded: false }];
    const queued = new Set([root]);
    while (stack.length > 0) {
        const frame = stack.pop();
        if (frame.expanded) {
            out.push(frame.id);
            continue;
        }
        stack.push({ id: frame.id, expanded: true });
        for (const child of children.get(frame.id) ?? []) {
            if (evaluated.has(child.id) || queued.has(child.id))
                continue;
            queued.add(child.id);
            stack.push({ id: child.id, expanded: false });
        }
    }
    return out;
}
function push(map, key, value) {
    const bucket = map.get(key);
    if (bucket)
        bucket.push(value);
    else
        map.set(key, [value]);
}
//# sourceMappingURL=task-aggregation.js.map