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

import type { ProjectDecisionInput } from './project-decision.service';
import type { CoordinatorSessionPlan } from './project-coordinator-session';
import {
  ObservedBlockerCondition,
  blockerKindForRefusal,
  compare,
  projectDeadLetterCondition,
} from './project-blocker';
import { planCompletionGaps } from './project-completion-gap';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';
import { failedTaskBlockerKind } from './project-failed-retry';
import { TaskRetirement, taskIsObsolete, taskRetirement } from '../tasks/task-supersession';
import type { PlannedVerificationVerdict } from './task-verification-verdict';
import {
  TaskCompletionGap,
  TaskCompletionPolicyValue,
  isAggregateParent,
} from './task-aggregation';

/** §9.4: the rolling window `sessionBudgetPerDay` is measured over. */
export const PROJECT_SESSION_BUDGET_WINDOW_MS = 24 * 60 * 60_000;

const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set(['DONE', 'CANCELLED']);

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
const RETIREMENT_INDEX = new WeakMap<object, Map<string, TaskRetirement | null>>();

function retirementIndex(input: ProjectDecisionInput): Map<string, TaskRetirement | null> {
  const cached = RETIREMENT_INDEX.get(input.world);
  if (cached) return cached;
  const index = new Map(input.world.tasks.map((task) => [task.id, taskRetirement({
    supersededByTaskId: task.supersededByTaskId ?? null,
    terminalReason: task.terminalReason ?? null,
  })]));
  RETIREMENT_INDEX.set(input.world, index);
  return index;
}

function outsideBlockerScope(
  task: { id: string; status: string; verifiesTaskId?: string | null },
  input: ProjectDecisionInput,
): boolean {
  if (SETTLED_TASK_STATUSES.has(task.status)) return true;
  const index = retirementIndex(input);
  return taskIsObsolete({
    retirement: index.get(task.id) ?? null,
    // The derived half, and it belongs to EVERY detector rather than to the failure ones: a healthy
    // OPEN check whose subject was replaced can never run, so a manual-policy hold on it is a
    // required action nobody can discharge — and §13.4's DONE gate refuses a project holding one.
    subjectRetirement: task.verifiesTaskId ? (index.get(task.verifiesTaskId) ?? null) : null,
  });
}

/** Facts this pass has already planned elsewhere. They are passed in rather than recomputed: two
 *  copies of "what is a cycle" or "what did this verdict conclude" would eventually disagree, and
 *  the blocker face has to say the same thing the guard that stopped the work says. */
export interface ProjectBlockerConditionSources {
  /** §13.1's cycle set, computed once by the aggregation planner rather than twice. */
  aggregationCycleTaskIds: readonly string[];
  /**
   * §13.1 AG7's shapes, from the same `planTaskAggregation` pass that produced the writes.
   *
   * Passed in rather than recomputed for the reason the cycle ids are: one recomputation answers
   * for the whole snapshot, and a second reading of the same tasks is a second opinion waiting to
   * differ from the first.
   */
  aggregationCompletionGaps: readonly TaskCompletionGap[];
  /** §13.2's plan for this same snapshot, computed once by the decision planner. */
  verificationVerdicts: readonly PlannedVerificationVerdict[];
  /**
   * §7.5's plan for this same snapshot. It is passed in rather than recomputed for the reason the
   * other two are: the sentence the blocker shows a user has to be the same one that stopped the
   * rotation, and two copies of "may this project open a coordination run" would eventually differ.
   */
  coordinatorSession: CoordinatorSessionPlan;
}

/** Every condition the snapshot holds, sorted so the same world always produces the same list. */
export function detectProjectBlockerConditions(
  input: ProjectDecisionInput,
  sources: ProjectBlockerConditionSources,
): ObservedBlockerCondition[] {
  const conditions: ObservedBlockerCondition[] = [
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
    ...planCompletionGaps(input, sources.aggregationCompletionGaps).conditions,
    ...coordinatorConditions(input, sources.coordinatorSession),
    ...coordinatorProgressConditions(input, sources.coordinatorSession),
    ...workspaceConditions(input),
    ...deadLetterConditions(input),
  ];
  return conditions.sort((a, b) => compare(
    `${a.kind}:${a.subjectType}:${a.subjectId}`,
    `${b.kind}:${b.subjectType}:${b.subjectId}`,
  ));
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
function deadLetterConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  const dead = input.world.deadLetters ?? [];
  if (dead.length === 0) return [];
  return [projectDeadLetterCondition(input.world.project.id, dead)];
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
function refusedDispatchConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  const latest = new Map<string, ProjectDecisionInput['world']['actions'][number]>();
  for (const action of input.world.actions) {
    if (action.type !== 'DISPATCH_TASK' || !action.subjectId) continue;
    // A dispatch the blocker guard itself stopped is TRANSPARENT here. It is the CONSEQUENCE of an
    // open blocker, not an independent fact about the task, and treating it as the latest verdict
    // would clear the very row that produced it — then the next pass dispatches, is refused for the
    // original reason again, and opens a new episode. That flap would advance `lifecycle_generation`
    // once per tick and make §7.6 TR3 read a stuck project as a stream of brand-new failures.
    if (action.status === 'REFUSED' && action.refusalCode === 'PROJECT_BLOCKED') continue;
    // `world.actions` is ordered by `(created_at, id)`, so the last one seen is the latest.
    latest.set(action.subjectId, action);
  }
  const conditions: ObservedBlockerCondition[] = [];
  for (const task of input.world.tasks) {
    if (outsideBlockerScope(task, input)) continue;
    const action = latest.get(task.id);
    if (!action || action.status !== 'REFUSED') continue;
    const kind = blockerKindForRefusal(action.refusalCode);
    if (!kind) continue;
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
function mergeConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  const conditions: ObservedBlockerCondition[] = [];
  for (const branch of input.world.evidence.branches) {
    if (branch.mergeStatus !== 'conflict' && branch.mergeStatus !== 'error') continue;
    if (!branch.taskId) continue;
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
function spentFailureBudgetConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  const conditions: ObservedBlockerCondition[] = [];
  for (const task of input.world.tasks) {
    if (outsideBlockerScope(task, input)) continue;
    const kind = failedTaskBlockerKind(task);
    if (!kind) continue;
    conditions.push({
      kind,
      subjectType: 'TASK' as const,
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
            maxAutoRunFailures: MAX_AUTO_RUN_FAILURES,
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
function verificationConditions(
  verdicts: readonly PlannedVerificationVerdict[],
): ObservedBlockerCondition[] {
  return verdicts
    .filter((verdict) => verdict.consequences.raiseCondition)
    .map((verdict) => ({
      kind: 'VERIFICATION_FAILED' as const,
      subjectType: 'TASK' as const,
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
function budgetConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  const budget = input.world.project.sessionBudgetPerDay;
  if (budget == null || budget <= 0) return [];
  const windowStart = input.evaluation.epoch * 1_000 - PROJECT_SESSION_BUDGET_WINDOW_MS;
  const counted = input.world.actions
    .filter((action) => action.type === 'DISPATCH_TASK'
      && action.status === 'APPLIED'
      && Date.parse(action.createdAt) > windowStart)
    .map((action) => Date.parse(action.createdAt))
    .sort((a, b) => a - b);
  if (counted.length < budget) return [];
  return [{
    kind: 'BUDGET_EXHAUSTED',
    subjectType: 'PROJECT',
    subjectId: input.world.project.id,
    facts: { sessionBudgetPerDay: budget, used: counted.length },
    detail: {
      sessionBudgetPerDay: budget,
      used: counted.length,
      windowEndsAt: new Date(counted[0] + PROJECT_SESSION_BUDGET_WINDOW_MS).toISOString(),
    },
    recoveryAt: new Date(counted[0] + PROJECT_SESSION_BUDGET_WINDOW_MS).toISOString(),
  }];
}

/** §11.2: an in-flight session parked on the user. One condition per session, so answering one
 *  clears one. */
function awaitingUserInputConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  return input.world.sessions
    .filter((session) => session.taskId != null
      && !session.deletedAt
      && session.runStatus === 'AWAITING_INPUT')
    .map((session) => ({
      kind: 'AWAITING_USER_INPUT' as const,
      subjectType: 'SESSION' as const,
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
function manualHoldConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  if (input.world.project.automationPolicy !== 'MANUAL') return [];
  const held = eligibleTaskIds(input);
  if (held.length === 0) return [];
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
function dependencyCycleConditions(
  input: ProjectDecisionInput,
  aggregationCycleTaskIds: readonly string[],
): ObservedBlockerCondition[] {
  const onCycle = new Set<string>([
    ...aggregationCycleTaskIds,
    ...dependencyCycleTaskIds(input),
  ]);
  if (onCycle.size === 0) return [];
  // TF2 names this projection: the sorted set of ids on the cycle. Break one edge and the digest
  // changes; add an unrelated task and it does not.
  const taskIds = [...onCycle].sort(compare);
  return [{
    kind: 'DEPENDENCY_CYCLE',
    subjectType: 'PROJECT',
    subjectId: input.world.project.id,
    facts: { taskIds },
    detail: {
      taskIds,
      aggregationCycleTaskIds: [...aggregationCycleTaskIds].sort(compare),
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
function coordinatorConditions(
  input: ProjectDecisionInput,
  rotation: CoordinatorSessionPlan,
): ObservedBlockerCondition[] {
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
  if (!reason) return [];
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
function coordinatorProgressConditions(
  input: ProjectDecisionInput,
  rotation: CoordinatorSessionPlan,
): ObservedBlockerCondition[] {
  if (rotation.status !== 'NO_PROGRESS') return [];
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
function workspaceConditions(input: ProjectDecisionInput): ObservedBlockerCondition[] {
  if (input.world.workspaces.length === 0) return [];
  const usable = input.world.workspaces.filter((row) => row.enabled && !row.deletedAt);
  if (usable.length > 0) return [];
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
function eligibleTaskIds(input: ProjectDecisionInput): string[] {
  const done = new Set(input.world.tasks
    .filter((task) => task.status === 'DONE')
    .map((task) => task.id));
  // §13.1 AG6, from the same snapshot index §7.8's pass builds. An aggregate parent is not an
  // executable next step under ANY policy, so listing one here would ask a person to Run by hand
  // exactly the task every gate refuses — and on a MANUAL project that request is the whole
  // content of the `POLICY_MANUAL_HOLD` row. The observation surface and the admission surface
  // have to answer the same question the same way, or the control plane tells people to do
  // something the product will not let them do.
  const parentsWithChildren = new Set(
    input.world.tasks.map((task) => task.parentTaskId).filter((id): id is string => id != null),
  );
  return input.world.tasks
    .filter((task) => task.status === 'OPEN'
      && !task.dispatchHold
      && task.liveSessionIds.length === 0
      && task.dependsOnTaskIds.every((id) => done.has(id))
      && (input.evaluation.dueTasks[task.id]?.retryBackoffExpired ?? true)
      && (input.evaluation.dueTasks[task.id]?.runAtDue ?? true)
      && !isAggregateParent({
        // Absent (pre-0123) reads as MANUAL, which is what those rows held.
        completionPolicy: (task.completionPolicy ?? 'MANUAL') as TaskCompletionPolicyValue,
        hasDirectChildren: parentsWithChildren.has(task.id),
      })
      // §13.6 SU6, and it is the same predicate every other detector in this file uses. A manual
      // hold is a required action addressed to a person; an obsolete task asks nothing of anyone,
      // and a hold on one can never be discharged — while §13.4's DONE gate refuses a project that
      // holds an open blocker.
      && !outsideBlockerScope(task, input))
    .map((task) => task.id)
    .sort(compare);
}

/** Tasks on a `dependsOnTaskIds` cycle. Iterative colouring, because a project's graph is user
 *  data and a recursive walk over it is a stack overflow waiting for a big enough project. */
function dependencyCycleTaskIds(input: ProjectDecisionInput): string[] {
  const edges = new Map(input.world.tasks.map((task) => [task.id, task.dependsOnTaskIds]));
  const state = new Map<string, 0 | 1 | 2>();
  const onCycle = new Set<string>();
  for (const start of edges.keys()) {
    if (state.get(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
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
      if (!edges.has(child)) continue;
      const colour = state.get(child) ?? 0;
      if (colour === 1) {
        // A back edge. Everything from `child` to the top of the path is on the cycle.
        for (let i = path.lastIndexOf(child); i >= 0 && i < path.length; i += 1) {
          onCycle.add(path[i]);
        }
        continue;
      }
      if (colour === 2) continue;
      state.set(child, 1);
      stack.push({ id: child, next: 0 });
      path.push(child);
    }
  }
  return [...onCycle].sort(compare);
}

/** The changed-file list a runner reported, as a sorted path set. Shape varies by runner version,
 *  so anything unrecognisable becomes an empty set rather than a crash inside a digest. */
function changedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .map((entry) => typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string'
        ? (entry as { path: string }).path
        : null)
    .filter((path): path is string => path !== null);
  return [...new Set(paths)].sort(compare);
}
