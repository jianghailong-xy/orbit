"use strict";
/**
 * Which blocker conditions a snapshot currently holds (§11.4).
 *
 * Every kind in §11.2's table that this deployment can observe today has a detector here, and each
 * one is a pure function of `decisionInput`. That is BL3, and it is the difference between a
 * blocker that clears itself and one that waits for an event that may never arrive: the loop asks
 * "is this still true?" of the world, not "did somebody tell me it stopped?".
 *
 * Auto-clear needs no code of its own because of that shape — `planProjectBlockers` clears every
 * open row whose key this function no longer returns.
 *
 * Two kinds have no detector, on purpose:
 *
 *   `AWAITING_USER_APPROVAL` is raised from the REQUEST_APPROVAL side, not detected: whether an
 *   approval is still outstanding is the action ledger's own state, and the pass that requests one
 *   is the pass that knows its target. Its policy row and lifecycle are equally complete here.
 *
 * `COORDINATOR_NO_PROGRESS` is §7.6 TR3's, and TR3 compares `reasonDigest`s across coordination
 * runs. It is detected here now that §7.5's rotation actually opens them, and the comparison is
 * made by the rotation planner (which is the thing that knows what a run was opened ON); this
 * function's job is to turn its answer into the row a person can act on.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_SESSION_BUDGET_WINDOW_MS = void 0;
exports.detectProjectBlockerConditions = detectProjectBlockerConditions;
const project_blocker_1 = require("./project-blocker");
const project_completion_gap_1 = require("./project-completion-gap");
const task_retry_policy_1 = require("../tasks/task-retry-policy");
const project_failed_retry_1 = require("./project-failed-retry");
const task_supersession_1 = require("../tasks/task-supersession");
const task_aggregation_1 = require("./task-aggregation");
/** §9.4: the rolling window `sessionBudgetPerDay` is measured over. */
exports.PROJECT_SESSION_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
const SETTLED_TASK_STATUSES = new Set(['DONE', 'CANCELLED']);
/**
 * Settled, or retired by §13.6 SU6 — the two ways a task stops being something §11 has to raise a
 * row about.
 *
 * A blocker is a request addressed to somebody: "look at why this keeps failing", "read the detail
 * and clear it". A replaced attempt asks that of nobody, and a row that keeps asking is worse than
 * noise — §13.4's DONE gate refuses a project holding open blockers, so one retired FAILED task
 * held its whole project's acceptance open on a failure that had already been re-done and passed.
 */
/**
 * §13.6 SU6 for one snapshot, indexed once.
 *
 * A `WeakMap` keyed on the snapshot rather than a parameter threaded through eleven detectors: they
 * are called from one place with one input, and the alternative — looking the row up with
 * `world.tasks.find` inside each detector's loop — is quadratic. Three detectors iterate every task
 * and would each pay a linear scan per task, which on a project with tens of thousands of them is
 * the reconcile pass itself becoming the thing that stops.
 */
const RETIREMENT_INDEX = new WeakMap();
function retirementIndex(input) {
    const cached = RETIREMENT_INDEX.get(input.world);
    if (cached)
        return cached;
    const index = new Map(input.world.tasks.map((task) => [task.id, (0, task_supersession_1.taskRetirement)({
            supersededByTaskId: task.supersededByTaskId ?? null,
            terminalReason: task.terminalReason ?? null,
        })]));
    RETIREMENT_INDEX.set(input.world, index);
    return index;
}
/**
 * §13.6 SU6 on its own: this attempt was replaced or abandoned, or it CHECKS work that was.
 *
 * Split out of `outsideBlockerScope` because the two halves are not the same rule and not every
 * detector wants both. "Settled" says the task reached an end; SU6 says nobody is doing this work
 * here anymore. A detector that reads a task row wants both. A detector that reads EVIDENCE a task
 * left behind wants only this one — see `namedTaskObsolete`.
 */
function taskObsolete(task, input) {
    const index = retirementIndex(input);
    return (0, task_supersession_1.taskIsObsolete)({
        retirement: index.get(task.id) ?? null,
        // The derived half, and it belongs to EVERY detector rather than to the failure ones: a healthy
        // OPEN check whose subject was replaced can never run, so a manual-policy hold on it is a
        // required action nobody can discharge — and §13.4's DONE gate refuses a project holding one.
        subjectRetirement: task.verifiesTaskId ? (index.get(task.verifiesTaskId) ?? null) : null,
    });
}
function outsideBlockerScope(task, input) {
    if (SETTLED_TASK_STATUSES.has(task.status))
        return true;
    return taskObsolete(task, input);
}
/** The snapshot's tasks by id, indexed once for the reason the retirements are: the two detectors
 *  below iterate evidence rows that NAME a task, and a `world.tasks.find` per row is quadratic on a
 *  project with a long branch and session history. */
const TASK_INDEX = new WeakMap();
function taskIndex(input) {
    const cached = TASK_INDEX.get(input.world);
    if (cached)
        return cached;
    const index = new Map(input.world.tasks.map((task) => [task.id, task]));
    TASK_INDEX.set(input.world, index);
    return index;
}
/**
 * §13.6 SU6 for a row that NAMES a task instead of being one — a branch, a session.
 *
 * `mergeConditions` and `awaitingUserInputConditions` iterate EVIDENCE, so neither ever had a task
 * filter at all: a branch left conflicted by an attempt that was later re-done from scratch, and a
 * question asked by a run whose task has since been replaced, both kept being raised every pass.
 * Neither is a request anybody can discharge — the branch will never be merged from and the answer
 * would reach nobody — and §13.4's DONE gate refuses a project holding an open blocker, so one
 * retired attempt held its whole project's acceptance open on work that had already moved.
 *
 * SU6 ONLY, and deliberately not `outsideBlockerScope`:
 *
 *   A DONE task with a conflicted branch is the ORDINARY case here, not a stale one — this product
 *   finishes a task and merges its branch afterwards, so `merge_status = 'conflict'` mostly lands
 *   on tasks that are already DONE. §11.2's row is the only place the control plane says a branch
 *   did not land; silencing it on settled tasks would retire the `MERGE_CONFLICT` kind in practice
 *   and leave a genuinely unmerged branch with nothing asking anybody to deal with it.
 *
 *   A session parked on a question whose task is DONE is a real problem too, and making the row
 *   invisible is not a fix for it: silence is not an answer somebody gave. It is filed on its own
 *   rather than folded in here, because the two need opposite treatment and one predicate cannot
 *   give it to them.
 *
 * A task this snapshot cannot see reads as IN scope — the same rule `taskIsObsolete` states for a
 * subject it did not read: a projection may not infer a fact from a row it has not got, and the
 * fail-closed direction is to keep asking.
 */
function namedTaskObsolete(taskId, input) {
    if (taskId == null)
        return false;
    const task = taskIndex(input).get(taskId);
    if (!task)
        return false;
    return taskObsolete(task, input);
}
/** Every condition the snapshot holds, sorted so the same world always produces the same list. */
function detectProjectBlockerConditions(input, sources) {
    const conditions = [
        ...refusedDispatchConditions(input),
        ...mergeConditions(input),
        ...spentFailureBudgetConditions(input),
        ...verificationConditions(sources.verificationVerdicts),
        ...budgetConditions(input),
        ...awaitingUserInputConditions(input),
        ...manualHoldConditions(input),
        ...dependencyCycleConditions(input, sources.aggregationCycleTaskIds),
        // §13.1 AG7. Only the gaps a person has to close land here; the ones §13.2 V8 can close by
        // filing the missing check are proposed as an action instead, by the same function. No
        // `outsideBlockerScope` filter: a gap is only ever reported for a status aggregation could
        // still move the task out of, and `recompute` answers nothing at all for a retired one — the
        // two exclusions this file applies everywhere else are already in the shape.
        ...(0, project_completion_gap_1.planCompletionGaps)(input, sources.aggregationCompletionGaps).conditions,
        ...coordinatorConditions(input, sources.coordinatorSession),
        ...coordinatorProgressConditions(input, sources.coordinatorSession),
        ...workspaceConditions(input),
        ...deadLetterConditions(input),
    ];
    return conditions.sort((a, b) => (0, project_blocker_1.compare)(`${a.kind}:${a.subjectType}:${a.subjectId}`, `${b.kind}:${b.subjectType}:${b.subjectId}`));
}
/**
 * §5.4 F22 / BL2: signals this project lost for good.
 *
 * Every other detector here asks "is this still true of the world?" and gets an answer from the
 * world itself. A dead letter cannot be asked that way — the event is consumed, its effect never
 * happened, and nothing that is still visible says so. What the snapshot carries instead is the set
 * of dead letters nobody has ACKNOWLEDGED (§6.1's `deadLetters`, which drops a row once somebody
 * resolves the blocker it opened by hand). So the condition holds until a person deals with it,
 * which is what `recovery = HUMAN` means, and §11.4 cannot clear it on the project's behalf.
 */
function deadLetterConditions(input) {
    const dead = input.world.deadLetters ?? [];
    if (dead.length === 0)
        return [];
    return [(0, project_blocker_1.projectDeadLetterCondition)(input.world.project.id, dead)];
}
/**
 * §11.2's first seven rows: the resolution chain refused, and the refusal code IS the kind.
 *
 * The condition is "this task's MOST RECENT dispatch attempt was refused", which gives the whole
 * lifecycle for free: a later attempt that is not refused makes the condition false and the row
 * clears itself; a later attempt refused the same way after that is a genuinely new failure and
 * BE1 gives it `lifecycle_generation + 1`.
 *
 * A refusal code that is in neither of §11.2's two frozen lists lands on `UNKNOWN_FAILURE` (BL2) —
 * it does not fall through, because a refusal nobody classified is exactly the case where carrying
 * on would be the dangerous answer.
 */
function refusedDispatchConditions(input) {
    const latest = new Map();
    for (const action of input.world.actions) {
        if (action.type !== 'DISPATCH_TASK' || !action.subjectId)
            continue;
        // A dispatch the blocker guard itself stopped is TRANSPARENT here. It is the CONSEQUENCE of an
        // open blocker, not an independent fact about the task, and treating it as the latest verdict
        // would clear the very row that produced it — then the next pass dispatches, is refused for the
        // original reason again, and opens a new episode. That flap would advance `lifecycle_generation`
        // once per tick and make §7.6 TR3 read a stuck project as a stream of brand-new failures.
        if (action.status === 'REFUSED' && action.refusalCode === 'PROJECT_BLOCKED')
            continue;
        // `world.actions` is ordered by `(created_at, id)`, so the last one seen is the latest.
        latest.set(action.subjectId, action);
    }
    const conditions = [];
    for (const task of input.world.tasks) {
        if (outsideBlockerScope(task, input))
            continue;
        const action = latest.get(task.id);
        if (!action || action.status !== 'REFUSED')
            continue;
        const kind = (0, project_blocker_1.blockerKindForRefusal)(action.refusalCode);
        if (!kind)
            continue;
        conditions.push({
            kind,
            subjectType: 'TASK',
            subjectId: task.id,
            // TF2: the FACTS, not how often they were seen. The action id is deliberately absent — a
            // retry that fails the same way is the same condition, and putting the attempt's identity in
            // here would give it a new digest and therefore a new coordinator turn every attempt.
            facts: { taskId: task.id, refusalCode: action.refusalCode },
            detail: {
                taskId: task.id,
                refusalCode: action.refusalCode,
                actionId: action.actionId,
                refusedAt: action.createdAt,
            },
        });
    }
    return conditions;
}
/**
 * `merge.conflict`'s two shapes, told apart rather than merged.
 *
 * A conflict is a conflict — somebody resolves it and merges again. A merge that failed for any
 * other reason is a failure nobody classified, and BL2 says that is `UNKNOWN_FAILURE`, not a
 * conflict with a misleading required action.
 */
function mergeConditions(input) {
    const conditions = [];
    for (const branch of input.world.evidence.branches) {
        if (branch.mergeStatus !== 'conflict' && branch.mergeStatus !== 'error')
            continue;
        if (!branch.taskId)
            continue;
        // §13.6 SU6. The branch row is not touched — it stays exactly the record of what that attempt
        // did; this only stops asking somebody to merge work that was replaced.
        if (namedTaskObsolete(branch.taskId, input))
            continue;
        const paths = changedPaths(branch.changedFiles);
        conditions.push({
            kind: branch.mergeStatus === 'conflict' ? 'MERGE_CONFLICT' : 'UNKNOWN_FAILURE',
            subjectType: 'TASK',
            subjectId: branch.taskId,
            // TF2 names this projection for MERGE_CONFLICT exactly: the target branch, the sorted path
            // set, and a digest of the conflicting side.
            facts: {
                targetBranch: branch.mergeTarget ?? null,
                paths,
                sourceSha: branch.mergedSourceSha ?? branch.baseSha ?? null,
            },
            detail: {
                sessionId: branch.sessionId,
                taskId: branch.taskId,
                branch: branch.branch,
                mergeStatus: branch.mergeStatus,
                mergeTarget: branch.mergeTarget ?? null,
                paths,
            },
        });
    }
    return conditions;
}
/**
 * §9.5 Q3's terminal rows — **one** condition per task, never two (v1.18, `PC-CX-64`).
 *
 * Inside the backoff there is deliberately no blocker: nobody needs to do anything and the loop has
 * not stopped — it scheduled a definite retry, which shows up as §10.4's clause 3 wake and a NOOP
 * audit line (Q3-a). `failureCount` is a persisted fact that advances only on a real failure, so it
 * belongs in the digest; it is not one of TF1's delivery counters.
 *
 * Which row a spent budget lands on is `failedTaskBlockerKind`'s to say, and it is asked ONCE for
 * both. The two conditions are not mutually exclusive in the world — a task whose five failures all
 * died without an error holds `failureCount >= MAX` and "nothing attributed it" simultaneously — and
 * §11.3's dedupe key carries the KIND, so two detectors reading the raw facts would open two rows
 * for one failure rather than deduplicating to one. See that function for which row wins and why.
 */
function spentFailureBudgetConditions(input) {
    const conditions = [];
    for (const task of input.world.tasks) {
        if (outsideBlockerScope(task, input))
            continue;
        const kind = (0, project_failed_retry_1.failedTaskBlockerKind)(task);
        if (!kind)
            continue;
        conditions.push({
            kind,
            subjectType: 'TASK',
            subjectId: task.id,
            // TF2: the facts, not the attempts. Both rows are digested over the same two properties of
            // the run history, so a task that crosses from one row to the other — the sixth failure
            // finally records an error — is a genuinely different condition and says so.
            facts: {
                taskId: task.id,
                failureCount: task.failureCount,
                failureAttributable: task.failureAttributable,
            },
            detail: kind === 'TEST_FAILED'
                ? {
                    taskId: task.id,
                    failureCount: task.failureCount,
                    maxAutoRunFailures: task_retry_policy_1.MAX_AUTO_RUN_FAILURES,
                }
                : {
                    taskId: task.id,
                    failureCount: task.failureCount,
                    reason: 'this task\'s failed runs recorded no error, so nothing can say whether a '
                        + 'retry would do anything different',
                },
        });
    }
    return conditions;
}
/**
 * §13.2's verdict, projected onto the general blocker face (unit 16 → unit 17).
 *
 * The projection is deliberately one-way: `task_verification_failure` keeps its own row, its own
 * revision key and its own downstream dispatch guard. This adds the control-plane view — one
 * condition per non-PASS conclusion, with TF2's frozen `(verifierTaskId, verifiesTaskId, verdict)`
 * digest — so that a failing check shows up in the same place as every other reason the project is
 * not moving, and clears itself the moment the check passes or is re-run.
 */
function verificationConditions(verdicts) {
    return verdicts
        .filter((verdict) => verdict.consequences.raiseCondition)
        .map((verdict) => ({
        kind: 'VERIFICATION_FAILED',
        subjectType: 'TASK',
        subjectId: verdict.subjectTaskId,
        facts: {
            verifierTaskId: verdict.verifierTaskId,
            verifiesTaskId: verdict.subjectTaskId,
            verdict: verdict.verdict,
        },
        detail: {
            verifierTaskId: verdict.verifierTaskId,
            subjectTaskId: verdict.subjectTaskId,
            verdict: verdict.verdict,
            verdictRevision: verdict.verdictRevision,
            evidence: verdict.evidence,
        },
    }));
}
/**
 * §9.4's second row: the daily budget, which recovers by TIME.
 *
 * "Started by the control loop" is exactly the APPLIED `DISPATCH_TASK` ledger — a session a person
 * started by hand has no action row and does not count, which is what the contract says and what
 * an action ledger is for. `recoveryAt` is the oldest counted row rolling out of the window: a
 * committed timestamp, so BL5's `next_check_at` is a fact rather than a clock reading.
 */
function budgetConditions(input) {
    const budget = input.world.project.sessionBudgetPerDay;
    if (budget == null || budget <= 0)
        return [];
    const windowStart = input.evaluation.epoch * 1_000 - exports.PROJECT_SESSION_BUDGET_WINDOW_MS;
    const counted = input.world.actions
        .filter((action) => action.type === 'DISPATCH_TASK'
        && action.status === 'APPLIED'
        && Date.parse(action.createdAt) > windowStart)
        .map((action) => Date.parse(action.createdAt))
        .sort((a, b) => a - b);
    if (counted.length < budget)
        return [];
    return [{
            kind: 'BUDGET_EXHAUSTED',
            subjectType: 'PROJECT',
            subjectId: input.world.project.id,
            facts: { sessionBudgetPerDay: budget, used: counted.length },
            detail: {
                sessionBudgetPerDay: budget,
                used: counted.length,
                windowEndsAt: new Date(counted[0] + exports.PROJECT_SESSION_BUDGET_WINDOW_MS).toISOString(),
            },
            recoveryAt: new Date(counted[0] + exports.PROJECT_SESSION_BUDGET_WINDOW_MS).toISOString(),
        }];
}
/** §11.2: an in-flight session parked on the user. One condition per session, so answering one
 *  clears one. */
function awaitingUserInputConditions(input) {
    return input.world.sessions
        .filter((session) => session.taskId != null
        && !session.deletedAt
        && session.runStatus === 'AWAITING_INPUT'
        // §13.6 SU6. A question asked on behalf of an attempt that was replaced is addressed to
        // nobody: answering it cannot make that attempt go forward. The Session is left exactly as
        // it is — the row is dropped, never the history.
        && !namedTaskObsolete(session.taskId, input))
        .map((session) => ({
        kind: 'AWAITING_USER_INPUT',
        subjectType: 'SESSION',
        subjectId: session.id,
        facts: { sessionId: session.id, taskId: session.taskId },
        detail: { sessionId: session.id, taskId: session.taskId },
    }));
}
/**
 * §11.2: MANUAL policy with a next step that COULD have run.
 *
 * The point of the row is that "I turned automation off" and "it is broken" stay distinguishable:
 * a MANUAL project with nothing to do raises nothing, and a MANUAL project holding real work says
 * so on the control plane instead of looking idle.
 */
function manualHoldConditions(input) {
    if (input.world.project.automationPolicy !== 'MANUAL')
        return [];
    const held = eligibleTaskIds(input);
    if (held.length === 0)
        return [];
    return [{
            kind: 'POLICY_MANUAL_HOLD',
            subjectType: 'PROJECT',
            subjectId: input.world.project.id,
            facts: { taskIds: held },
            detail: { automationPolicy: 'MANUAL', taskIds: held },
        }];
}
/**
 * §11.2's `DEPENDENCY_CYCLE`, over both graphs a task can be on.
 *
 * `dependsOnTaskIds` is the ordering graph and `parentTaskId` the containment one; a cycle on
 * either stops the same work, and unit 15 already refuses to aggregate a parent cycle. Merging them
 * into one condition keeps that refusal and this blocker from disagreeing about what is stuck.
 */
function dependencyCycleConditions(input, aggregationCycleTaskIds) {
    const onCycle = new Set([
        ...aggregationCycleTaskIds,
        ...dependencyCycleTaskIds(input),
    ]);
    if (onCycle.size === 0)
        return [];
    // TF2 names this projection: the sorted set of ids on the cycle. Break one edge and the digest
    // changes; add an unrelated task and it does not.
    const taskIds = [...onCycle].sort(project_blocker_1.compare);
    return [{
            kind: 'DEPENDENCY_CYCLE',
            subjectType: 'PROJECT',
            subjectId: input.world.project.id,
            facts: { taskIds },
            detail: {
                taskIds,
                aggregationCycleTaskIds: [...aggregationCycleTaskIds].sort(project_blocker_1.compare),
            },
        }];
}
/**
 * §11.2: the coordination seat WAS there and is no longer usable — soft-deleted, disabled, or
 * pointing at a workspace that is gone. Project-wide, because nothing semantic can happen for any
 * task until somebody fixes it.
 *
 * "This project has never had a coordinator" is deliberately NOT this condition. A project that has
 * not been set up yet is not broken, and §7.4 already answers it where it actually bites: the first
 * dispatch is refused `COORDINATOR_NOT_ASSIGNED`, and §11.2's refusal mapping turns that into this
 * kind. Raising it eagerly would put every newly created project into AWAITING_HUMAN before its
 * owner had done anything wrong.
 */
function coordinatorConditions(input, rotation) {
    const project = input.world.project;
    const seat = project.coordinatorAgentId
        ? input.world.team.find((member) => member.agentId === project.coordinatorAgentId)
        : undefined;
    const workspace = project.coordinatorWorkspaceId
        ? input.world.workspaces.find((row) => row.workspaceId === project.coordinatorWorkspaceId)
        : undefined;
    const seatReason = !project.coordinatorAgentId
        ? null
        : !seat
            ? 'COORDINATOR_NOT_IN_TEAM'
            : seat.deletedAt || !seat.enabled
                ? 'COORDINATOR_AGENT_DISABLED'
                : workspace && (workspace.deletedAt || !workspace.enabled)
                    ? 'COORDINATION_WORKSPACE_UNAVAILABLE'
                    : null;
    // §7.5's other way to be unavailable, and the one only the rotation planner can see: a run has to
    // be replaced and there is nowhere it may open. Second, so a project whose seat is already broken
    // keeps naming the seat — that is the sentence its owner can act on, and both refusals name the
    // same kind and the same subject, so the dedupe key would otherwise depend on which was asked
    // first. `UNSUPPORTED` is a pre-0126 snapshot: no clause of this ran when it was captured.
    const reason = seatReason
        ?? (rotation.status === 'UNAVAILABLE' ? rotation.reason : null);
    if (!reason)
        return [];
    return [{
            kind: 'COORDINATOR_UNAVAILABLE',
            subjectType: 'PROJECT',
            subjectId: project.id,
            facts: { reason },
            detail: {
                reason,
                coordinatorAgentId: project.coordinatorAgentId,
                coordinatorWorkspaceId: project.coordinatorWorkspaceId,
                ...(seatReason ? {} : {
                    rotationTrigger: rotation.status === 'UNAVAILABLE' ? rotation.trigger : null,
                    coordinatorSessionId: rotation.status === 'UNAVAILABLE' ? rotation.fromSessionId : null,
                }),
            },
        }];
}
/**
 * §7.6 TR3: the last coordination run was opened on exactly these facts and changed none of them.
 *
 * The subject is the DIGEST, not the project — that is what makes the row fall away on its own
 * (§11.4 BL3 recomputes the condition, and a world that has moved computes a different digest, so
 * the key stops being observed and the row resolves). It also makes the episode counting right: the
 * same project going quiet twice on two different worlds is two rows, not one row seen twice.
 */
function coordinatorProgressConditions(input, rotation) {
    if (rotation.status !== 'NO_PROGRESS')
        return [];
    return [{
            kind: 'COORDINATOR_NO_PROGRESS',
            subjectType: 'PROJECT',
            subjectId: input.world.project.id,
            facts: { reasonDigest: rotation.reasonDigest },
            detail: {
                reasonDigest: rotation.reasonDigest,
                trigger: rotation.trigger,
                lastRunSessionId: rotation.lastRunSessionId,
                coordinatorSessionId: rotation.fromSessionId,
            },
        }];
}
/**
 * PAC §12's `NO_PROJECT_WORKSPACE`: every candidate location this project had is gone or disabled.
 *
 * An EMPTY candidate list is a different sentence — nothing has been assigned yet — and it belongs
 * to the WHO chain, which says so as `WHO_UNRESOLVED` on the task that has no assignee. Reading it
 * as "no workspace" would blame the wrong thing on every project before its first assignment.
 */
function workspaceConditions(input) {
    if (input.world.workspaces.length === 0)
        return [];
    const usable = input.world.workspaces.filter((row) => row.enabled && !row.deletedAt);
    if (usable.length > 0)
        return [];
    return [{
            kind: 'NO_PROJECT_WORKSPACE',
            subjectType: 'PROJECT',
            subjectId: input.world.project.id,
            facts: { workspaceCount: input.world.workspaces.length },
            detail: { workspaceCount: input.world.workspaces.length },
        }];
}
/**
 * Tasks that have somewhere to go: open, not held, not already running, dependencies done, and not
 * inside a retry backoff. This is the "executable next step" §11.2's MANUAL row asks about, and it
 * deliberately does NOT re-derive §7.4's full precondition list — that belongs to the dispatcher,
 * and a second copy of it would drift.
 */
function eligibleTaskIds(input) {
    const done = new Set(input.world.tasks
        .filter((task) => task.status === 'DONE')
        .map((task) => task.id));
    // §13.1 AG6, from the same snapshot index §7.8's pass builds. An aggregate parent is not an
    // executable next step under ANY policy, so listing one here would ask a person to Run by hand
    // exactly the task every gate refuses — and on a MANUAL project that request is the whole
    // content of the `POLICY_MANUAL_HOLD` row. The observation surface and the admission surface
    // have to answer the same question the same way, or the control plane tells people to do
    // something the product will not let them do.
    const parentsWithChildren = new Set(input.world.tasks.map((task) => task.parentTaskId).filter((id) => id != null));
    return input.world.tasks
        .filter((task) => task.status === 'OPEN'
        && !task.dispatchHold
        && task.liveSessionIds.length === 0
        && task.dependsOnTaskIds.every((id) => done.has(id))
        && (input.evaluation.dueTasks[task.id]?.retryBackoffExpired ?? true)
        && (input.evaluation.dueTasks[task.id]?.runAtDue ?? true)
        && !(0, task_aggregation_1.isAggregateParent)({
            // Absent (pre-0123) reads as MANUAL, which is what those rows held.
            completionPolicy: (task.completionPolicy ?? 'MANUAL'),
            hasDirectChildren: parentsWithChildren.has(task.id),
        })
        // §13.6 SU6, and it is the same predicate every other detector in this file uses. A manual
        // hold is a required action addressed to a person; an obsolete task asks nothing of anyone,
        // and a hold on one can never be discharged — while §13.4's DONE gate refuses a project that
        // holds an open blocker.
        && !outsideBlockerScope(task, input))
        .map((task) => task.id)
        .sort(project_blocker_1.compare);
}
/** Tasks on a `dependsOnTaskIds` cycle. Iterative colouring, because a project's graph is user
 *  data and a recursive walk over it is a stack overflow waiting for a big enough project. */
function dependencyCycleTaskIds(input) {
    const edges = new Map(input.world.tasks.map((task) => [task.id, task.dependsOnTaskIds]));
    const state = new Map();
    const onCycle = new Set();
    for (const start of edges.keys()) {
        if (state.get(start))
            continue;
        const stack = [{ id: start, next: 0 }];
        state.set(start, 1);
        const path = [start];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const children = edges.get(frame.id) ?? [];
            if (frame.next >= children.length) {
                state.set(frame.id, 2);
                stack.pop();
                path.pop();
                continue;
            }
            const child = children[frame.next];
            frame.next += 1;
            if (!edges.has(child))
                continue;
            const colour = state.get(child) ?? 0;
            if (colour === 1) {
                // A back edge. Everything from `child` to the top of the path is on the cycle.
                for (let i = path.lastIndexOf(child); i >= 0 && i < path.length; i += 1) {
                    onCycle.add(path[i]);
                }
                continue;
            }
            if (colour === 2)
                continue;
            state.set(child, 1);
            stack.push({ id: child, next: 0 });
            path.push(child);
        }
    }
    return [...onCycle].sort(project_blocker_1.compare);
}
/** The changed-file list a runner reported, as a sorted path set. Shape varies by runner version,
 *  so anything unrecognisable becomes an empty set rather than a crash inside a digest. */
function changedPaths(value) {
    if (!Array.isArray(value))
        return [];
    const paths = value
        .map((entry) => typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof entry.path === 'string'
            ? entry.path
            : null)
        .filter((path) => path !== null);
    return [...new Set(paths)].sort(project_blocker_1.compare);
}
//# sourceMappingURL=project-blocker-conditions.js.map