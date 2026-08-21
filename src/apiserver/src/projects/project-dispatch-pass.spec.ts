import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  ProjectDecisionInput,
  canonicalJson,
  hashDecisionInput,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';
import { ProjectBlockerFact } from './project-blocker';
import {
  PROJECT_DISPATCH_PASS_MAX_PER_WAKE,
  PROJECT_DISPATCH_RETRY_WINDOW_MS,
  projectDispatchIdempotencyKey,
  selectDispatchableTasks,
} from './project-dispatch-pass';

/**
 * §7.8's choosing half, on frozen snapshots.
 *
 * The property under test throughout is that the pass proposes exactly what §7.4 says is a next
 * step and nothing else — and that it decides this from the snapshot alone. Every fixture here is a
 * literal `ProjectDecisionInput`: no clock is available to these tests, which is the same
 * constraint the production path runs under and the reason `assertDecisionReplay` can compare a
 * plan against a replay of itself.
 */

const PROJECT = '00000000-0000-7000-8000-000000002101';
const OWNER = '00000000-0000-7000-8000-000000002102';
const AGENT = '00000000-0000-7000-8000-000000002103';
const DECISION = '00000000-0000-7000-8000-000000002104';
const READ_AT = '2026-08-21T00:00:00.000Z';

const p = uuidToBase62(PROJECT);
const agent = uuidToBase62(AGENT);

/** Sorted low→high in Base62 byte order, so "first candidate" is unambiguous in every fixture. */
function taskId(n: number): string {
  return uuidToBase62(`00000000-0000-7000-8000-00000000${(3100 + n).toString().padStart(4, '0')}`);
}

type TaskFact = ProjectDecisionInput['world']['tasks'][number];
type SessionFact = ProjectDecisionInput['world']['sessions'][number];

function task(id: string, overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    id,
    title: `task ${id}`,
    contentHash: 'a'.repeat(64),
    status: 'OPEN',
    parentTaskId: null,
    assigneeAgentId: agent,
    provider: null,
    model: null,
    autoRunWhenReady: true,
    dispatchHold: false,
    dispatchAuthority: 'COORDINATOR',
    dispatchAttempt: '0',
    requiredCapabilities: [],
    runAt: null,
    verifiesTaskId: null,
    dependsOnTaskIds: [],
    liveSessionIds: [],
    failureCount: 0,
    lastFailureAt: null,
    failureAttributable: true,
    retryBackoffUntil: null,
    updatedAt: READ_AT,
    ...overrides,
  };
}

function session(id: string, taskRef: string, runStatus = 'RUNNING'): SessionFact {
  return {
    id,
    taskId: taskRef,
    workspaceId: agent,
    assignedRunnerId: null,
    runStatus,
    provider: 'claude',
    model: null,
    permissionMode: null,
    effort: null,
    createdAt: READ_AT,
    startedAt: READ_AT,
    finishedAt: null,
    completedAt: null,
    deletedAt: null,
  };
}

function blocker(overrides: Partial<ProjectBlockerFact> = {}): ProjectBlockerFact {
  return {
    id: uuidToBase62('00000000-0000-7000-8000-000000009001'),
    kind: 'MERGE_CONFLICT',
    owner: 'USER',
    recovery: 'HUMAN',
    severity: 'CRITICAL',
    requiredAction: 'resolve it',
    subjectType: 'TASK',
    subjectId: taskId(1),
    dedupeKey: 'pcb:v1:MERGE_CONFLICT:TASK:x',
    lifecycleGeneration: '1',
    conditionVersion: 'v',
    firstSeenAt: READ_AT,
    lastSeenAt: READ_AT,
    occurrences: 1,
    nextCheckAt: READ_AT,
    escalatedAt: null,
    ...overrides,
  };
}

type ActionFact = ProjectDecisionInput['world']['actions'][number];

function action(subjectId: string, overrides: Partial<ActionFact> = {}): ActionFact {
  return {
    actionId: uuidToBase62('00000000-0000-7000-8000-00000000a001'),
    type: 'DISPATCH_TASK',
    status: 'REFUSED',
    subjectType: 'TASK',
    subjectId,
    decisionId: null,
    resultSessionId: null,
    refusalCode: 'NO_MATCHING_RUNNER',
    reasonCode: 'RUNNER_UNAVAILABLE',
    idempotencyKeyHash: 'b'.repeat(64),
    detailHash: 'c'.repeat(64),
    createdAt: READ_AT,
    ...overrides,
  };
}

interface WorldOverrides {
  tasks?: TaskFact[];
  actions?: ActionFact[];
  sessions?: SessionFact[];
  blockers?: ProjectBlockerFact[];
  maxConcurrentTasks?: number;
  agentMaxConcurrentTasks?: number | null;
  status?: 'OPEN' | 'DONE' | 'CANCELLED';
  coordinatorEnabled?: boolean;
  runState?: ProjectDecisionInput['world']['runtime']['runState'];
  due?: Record<string, { runAtDue: boolean; retryBackoffExpired: boolean }>;
}

function input(overrides: WorldOverrides = {}): ProjectDecisionInput {
  const tasks = overrides.tasks ?? [task(taskId(1))];
  const world: ProjectDecisionInput['world'] = {
    project: {
      id: p, ownerId: uuidToBase62(OWNER), title: 'ship', goal: null, acceptanceCriteria: null,
      status: overrides.status ?? 'OPEN',
      coordinatorEnabled: overrides.coordinatorEnabled ?? true,
      automationPolicy: 'GUARDED_AUTO',
      maxConcurrentTasks: overrides.maxConcurrentTasks ?? 3,
      sessionBudgetPerDay: null, configRevision: '7',
      coordinatorAgentId: agent, coordinatorSessionId: null, coordinatorWorkspaceId: null,
    },
    runtime: {
      runState: overrides.runState ?? 'PLANNING', fencingToken: '4', coordinatorGeneration: '1',
      coordinatorSessionId: null, nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [{
      projectMemberId: uuidToBase62('00000000-0000-7000-8000-000000004001'),
      agentId: agent, role: 'MEMBER', enabled: true, deletedAt: null, runnerId: null,
      model: null, effort: null, providerFallbacks: [], canCreateTasks: false, canDelegate: false,
      maxConcurrentTasks: overrides.agentMaxConcurrentTasks ?? null,
    }],
    tasks,
    sessions: overrides.sessions ?? [],
    coordinatorSession: null, workspaces: [], runners: [], providers: [],
    actions: overrides.actions ?? [],
    ...(overrides.blockers ? { blockers: overrides.blockers } : {}),
    evidence: { branches: [], tests: [] },
  };
  const evaluation = {
    epoch: Date.parse(READ_AT) / 1_000,
    dueTasks: overrides.due ?? Object.fromEntries(
      tasks.map((row) => [row.id, { runAtDue: true, retryBackoffExpired: true }]),
    ),
  };
  const signals: ProjectDecisionInput['signals'] = [];
  return {
    v: 1,
    readAt: READ_AT,
    decisionInputHash: hashDecisionInput({ world, evaluation, signals }),
    world,
    evaluation,
    signals,
  };
}

function chosen(snapshot: ProjectDecisionInput): string[] {
  return selectDispatchableTasks(snapshot).candidates.map((candidate) => candidate.taskId);
}

function skipReason(snapshot: ProjectDecisionInput, id: string): string | undefined {
  return selectDispatchableTasks(snapshot).skipped.find((row) => row.taskId === id)?.reason;
}

test('a ready task on an open coordinator project is proposed, with the attempt it was read at', () => {
  const selection = selectDispatchableTasks(input({
    tasks: [task(taskId(1), { dispatchAttempt: '4' })],
  }));
  assert.deepEqual(selection.candidates, [{ taskId: taskId(1), attempt: '4' }]);
  assert.equal(selection.freeSlots, 3);
  assert.deepEqual(selection.skipped, []);
});

test('selection is a pure function of the snapshot: same input, byte-identical answer', () => {
  const snapshot = input({
    tasks: [task(taskId(3)), task(taskId(1)), task(taskId(2))],
    maxConcurrentTasks: 2,
  });
  const first = selectDispatchableTasks(snapshot);
  const second = selectDispatchableTasks(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(canonicalJson(first), canonicalJson(second));
  // Byte order over the id, which for Orbit's UUIDv7-derived ids is oldest-first. The cap keeps
  // the third out; it is reported, not silently dropped.
  assert.deepEqual(first.candidates.map((c) => c.taskId), [taskId(1), taskId(2)]);
  assert.equal(skipReason(snapshot, taskId(3)), 'PROJECT_CONCURRENCY_LIMIT');
});

test('the plan built from a selection replays byte-for-byte through the planner', () => {
  const snapshot = input();
  const candidate = selectDispatchableTasks(snapshot).candidates[0];
  const key = projectDispatchIdempotencyKey(PROJECT, '00000000-0000-7000-8000-000000003101', candidate.attempt);
  const actions = [{
    type: 'DISPATCH_TASK',
    idempotencyKey: publicIdempotencyKey(key),
    subject: { type: 'TASK', id: candidate.taskId },
  }];
  const once = planProjectDecision(snapshot, { decisionId: DECISION, actions });
  const twice = planProjectDecision(snapshot, { decisionId: DECISION, actions });
  assert.equal(canonicalJson(once), canonicalJson(twice));
  assert.deepEqual(once.actions, actions);
});

test('the idempotency key is the ledger spelling, keyed by the attempt the snapshot read', () => {
  assert.equal(
    projectDispatchIdempotencyKey(PROJECT, '00000000-0000-7000-8000-000000003101', '2'),
    `pc:v1:${PROJECT}:dispatch:00000000-0000-7000-8000-000000003101:2`,
  );
  // §8.2: the audit spells the same key in Base62. Two spellings, one key.
  assert.equal(
    publicIdempotencyKey(projectDispatchIdempotencyKey(PROJECT, '00000000-0000-7000-8000-000000003101', '2')),
    `pc:v1:${p}:dispatch:${taskId(1)}:2`,
  );
});

test('§7.4 precondition 1: a task that is not OPEN, is held, or is not due is not proposed', () => {
  assert.deepEqual(chosen(input({ tasks: [task(taskId(1), { status: 'DONE' })] })), []);
  assert.deepEqual(chosen(input({ tasks: [task(taskId(1), { status: 'IN_PROGRESS' })] })), []);

  const held = input({ tasks: [task(taskId(1), { dispatchHold: true })] });
  assert.deepEqual(chosen(held), []);
  assert.equal(skipReason(held, taskId(1)), 'TASK_DISPATCH_HELD');

  const notDue = input({
    due: { [taskId(1)]: { runAtDue: false, retryBackoffExpired: true } },
  });
  assert.deepEqual(chosen(notDue), []);
  assert.equal(skipReason(notDue, taskId(1)), 'TASK_NOT_DUE');

  const backingOff = input({
    due: { [taskId(1)]: { runAtDue: true, retryBackoffExpired: false } },
  });
  assert.deepEqual(chosen(backingOff), []);
  assert.equal(skipReason(backingOff, taskId(1)), 'RETRY_BACKOFF_ACTIVE');
});

test('§12.3: a LEGACY-authority task belongs to the existing sweeps and is never proposed', () => {
  const legacy = input({ tasks: [task(taskId(1), { dispatchAuthority: 'LEGACY' })] });
  assert.deepEqual(chosen(legacy), []);
  assert.equal(skipReason(legacy, taskId(1)), 'NOT_COORDINATOR_AUTHORITY');
});

test('§12.3 D4: autoRunWhenReady is the legacy switch and does NOT gate the control loop', () => {
  const off = input({ tasks: [task(taskId(1), { autoRunWhenReady: false })] });
  assert.deepEqual(chosen(off), [taskId(1)]);
});

test('§7.4 precondition 4: a task with a live session is already running', () => {
  const running = input({
    tasks: [task(taskId(1), { liveSessionIds: ['s'] })],
    sessions: [session('s', taskId(1))],
  });
  assert.deepEqual(chosen(running), []);
  assert.equal(skipReason(running, taskId(1)), 'TASK_ALREADY_RUNNING');
});

test('§7.4 precondition 3: prerequisites must be DONE, and an unseen one reads as outstanding', () => {
  const waiting = input({
    tasks: [
      task(taskId(1), { status: 'OPEN' }),
      task(taskId(2), { dependsOnTaskIds: [taskId(1)] }),
    ],
  });
  assert.deepEqual(chosen(waiting), [taskId(1)]);
  assert.equal(skipReason(waiting, taskId(2)), 'TASK_DEPENDENCIES_INCOMPLETE');

  const ready = input({
    tasks: [
      task(taskId(1), { status: 'DONE' }),
      task(taskId(2), { dependsOnTaskIds: [taskId(1)] }),
    ],
  });
  assert.deepEqual(chosen(ready), [taskId(2)]);

  // A prerequisite outside this project is absent from a project-scoped snapshot. Fail closed.
  const foreign = input({ tasks: [task(taskId(2), { dependsOnTaskIds: [taskId(9)] })] });
  assert.deepEqual(chosen(foreign), []);
  assert.equal(skipReason(foreign, taskId(2)), 'TASK_DEPENDENCIES_INCOMPLETE');
});

test('§7.4 precondition 3: a check may not run before the thing it checks is DONE', () => {
  const early = input({
    tasks: [task(taskId(1)), task(taskId(2), { verifiesTaskId: taskId(1) })],
  });
  assert.deepEqual(chosen(early), [taskId(1)]);
  assert.equal(skipReason(early, taskId(2)), 'VERIFICATION_SUBJECT_NOT_DONE');

  const settled = input({
    tasks: [task(taskId(1), { status: 'DONE' }), task(taskId(2), { verifiesTaskId: taskId(1) })],
  });
  assert.deepEqual(chosen(settled), [taskId(2)]);
});

test('§4.2: AWAITING_VERIFICATION does not stop dispatch — the state is a summary, not a gate', () => {
  // The state `runStateOf` computes for exactly this world: a verification task exists and is not
  // DONE. If the pass read it, the subject would never run, the check would never run, and nothing
  // could ever clear the state — the deadlock this decision exists to refuse.
  const snapshot = input({
    runState: 'AWAITING_VERIFICATION',
    tasks: [task(taskId(1)), task(taskId(2), { verifiesTaskId: taskId(1) })],
  });
  assert.deepEqual(chosen(snapshot), [taskId(1)]);

  // EXECUTING likewise: §9.4's cap bounds parallelism, the label does not.
  const executing = input({
    runState: 'EXECUTING',
    maxConcurrentTasks: 2,
    tasks: [task(taskId(1), { liveSessionIds: ['s'] }), task(taskId(2))],
    sessions: [session('s', taskId(1))],
  });
  assert.deepEqual(chosen(executing), [taskId(2)]);
});

test('§11 BL1: a PROJECT blocker stops everything; a TASK blocker stops its own task', () => {
  const projectWide = input({
    tasks: [task(taskId(1)), task(taskId(2))],
    blockers: [blocker({ subjectType: 'PROJECT', subjectId: p, kind: 'BUDGET_EXHAUSTED' })],
  });
  assert.deepEqual(chosen(projectWide), []);
  assert.equal(skipReason(projectWide, taskId(1)), 'PROJECT_BLOCKED');
  assert.equal(skipReason(projectWide, taskId(2)), 'PROJECT_BLOCKED');

  const oneTask = input({
    tasks: [task(taskId(1)), task(taskId(2))],
    blockers: [blocker({ subjectId: taskId(1) })],
  });
  assert.deepEqual(chosen(oneTask), [taskId(2)]);
  assert.equal(skipReason(oneTask, taskId(1)), 'TASK_BLOCKED');

  // A SESSION-subject row stops nothing else, exactly as `openBlockersStoppingDispatch` says.
  const oneSession = input({
    blockers: [blocker({ subjectType: 'SESSION', subjectId: 'sess', kind: 'AWAITING_USER_INPUT' })],
  });
  assert.deepEqual(chosen(oneSession), [taskId(1)]);
});

test('§11.4: a resolution-chain blocker must NOT stop the attempt that could clear it', () => {
  for (const kind of ['WHO_UNRESOLVED', 'NO_MATCHING_RUNNER', 'PROVIDER_UNAVAILABLE'] as const) {
    const snapshot = input({ blockers: [blocker({ kind, subjectId: taskId(1) })] });
    assert.deepEqual(chosen(snapshot), [taskId(1)], kind);
  }
});

test('§9.4: candidates are capped by the free project slots the snapshot reports', () => {
  const full = input({
    maxConcurrentTasks: 1,
    tasks: [task(taskId(1), { liveSessionIds: ['s'] }), task(taskId(2))],
    sessions: [session('s', taskId(1))],
  });
  assert.deepEqual(chosen(full), []);
  assert.equal(selectDispatchableTasks(full).freeSlots, 0);
  assert.equal(skipReason(full, taskId(2)), 'PROJECT_CONCURRENCY_LIMIT');

  // A finished session is not in flight and does not hold a slot.
  const finished = input({
    maxConcurrentTasks: 1,
    tasks: [task(taskId(1), { status: 'DONE' }), task(taskId(2))],
    sessions: [session('s', taskId(1), 'SUCCEEDED')],
  });
  assert.deepEqual(chosen(finished), [taskId(2)]);
});

test('§9.4: one agent’s cap is counted against its own live sessions and this pass’s picks', () => {
  const capped = input({
    maxConcurrentTasks: 5,
    agentMaxConcurrentTasks: 1,
    tasks: [task(taskId(1)), task(taskId(2))],
  });
  assert.deepEqual(chosen(capped), [taskId(1)]);
  assert.equal(skipReason(capped, taskId(2)), 'AGENT_CONCURRENCY_LIMIT');

  const already = input({
    maxConcurrentTasks: 5,
    agentMaxConcurrentTasks: 1,
    tasks: [task(taskId(1), { liveSessionIds: ['s'] }), task(taskId(2))],
    sessions: [session('s', taskId(1))],
  });
  assert.deepEqual(chosen(already), []);
  assert.equal(skipReason(already, taskId(2)), 'AGENT_CONCURRENCY_LIMIT');
});

test('an unassigned task is not ranked here; §9.2 is what DENYs it', () => {
  const unassigned = input({ tasks: [task(taskId(1), { assigneeAgentId: null })] });
  assert.deepEqual(chosen(unassigned), []);
  assert.equal(skipReason(unassigned, taskId(1)), 'WHO_UNRESOLVED');
});

test('a closed or coordinator-disabled project proposes nothing at all', () => {
  assert.deepEqual(chosen(input({ status: 'DONE' })), []);
  assert.deepEqual(chosen(input({ status: 'CANCELLED' })), []);
  assert.deepEqual(chosen(input({ coordinatorEnabled: false })), []);
  assert.deepEqual(selectDispatchableTasks(input({ status: 'DONE' })).skipped, []);
});

test('one pass proposes at most PROJECT_DISPATCH_PASS_MAX_PER_WAKE, and says what it left', () => {
  const many = Array.from({ length: PROJECT_DISPATCH_PASS_MAX_PER_WAKE + 2 }, (_, i) => task(taskId(i + 1)));
  const snapshot = input({ tasks: many, maxConcurrentTasks: 100 });
  const selection = selectDispatchableTasks(snapshot);
  assert.equal(selection.candidates.length, PROJECT_DISPATCH_PASS_MAX_PER_WAKE);
  assert.equal(
    selection.skipped.filter((row) => row.reason === 'PASS_LIMIT_REACHED').length,
    2,
  );
  // An explicit smaller limit is honoured, for a caller that wants one dispatch at a time.
  assert.equal(selectDispatchableTasks(snapshot, 1).candidates.length, 1);
});

test('a refusal does not feed itself another attempt inside the retry window', () => {
  // §8.3 advances `dispatch_attempt` for a REFUSED action too, and migration 0117 turns that
  // scalar write into the `task.updated` signal that wakes this pass again. Without the window the
  // pass answers its own signal with another attempt, forever.
  const justRefused = input({ actions: [action(taskId(1), { createdAt: READ_AT })] });
  assert.deepEqual(chosen(justRefused), []);
  assert.equal(skipReason(justRefused, taskId(1)), 'RECENTLY_REFUSED');

  const oneMsShort = input({
    actions: [action(taskId(1), {
      createdAt: new Date(Date.parse(READ_AT) - PROJECT_DISPATCH_RETRY_WINDOW_MS + 1).toISOString(),
    })],
  });
  assert.deepEqual(chosen(oneMsShort), []);

  const windowPassed = input({
    actions: [action(taskId(1), {
      createdAt: new Date(Date.parse(READ_AT) - PROJECT_DISPATCH_RETRY_WINDOW_MS).toISOString(),
    })],
  });
  assert.deepEqual(chosen(windowPassed), [taskId(1)],
    '§11.4 clears a resolution-chain row only by letting an attempt through, so one must come');
});

test('the window is keyed on the LATEST attempt per task, and only on a refused one', () => {
  const older = new Date(Date.parse(READ_AT) - 10 * 60_000).toISOString();
  // An applied dispatch does not park anything: the live session it created is what stops the
  // task being proposed, and when that session ends the task is free immediately.
  const applied = input({
    actions: [action(taskId(1), { status: 'APPLIED', refusalCode: null, reasonCode: null })],
  });
  assert.deepEqual(chosen(applied), [taskId(1)]);

  // An old refusal followed by nothing newer is out of the window.
  assert.deepEqual(chosen(input({ actions: [action(taskId(1), { createdAt: older })] })), [taskId(1)]);

  // …but a fresh refusal AFTER it is what counts, in `world.actions` order.
  const refreshed = input({
    actions: [action(taskId(1), { createdAt: older }), action(taskId(1), { createdAt: READ_AT })],
  });
  assert.deepEqual(chosen(refreshed), []);

  // One task's refusal never parks another's.
  const neighbour = input({
    tasks: [task(taskId(1)), task(taskId(2))],
    actions: [action(taskId(1), { createdAt: READ_AT })],
  });
  assert.deepEqual(chosen(neighbour), [taskId(2)]);

  // A ROTATE action on this project is not a dispatch attempt and says nothing about a task.
  const rotation = input({
    actions: [action(taskId(1), { type: 'ROTATE_COORDINATOR_SESSION', subjectType: 'PROJECT' })],
  });
  assert.deepEqual(chosen(rotation), [taskId(1)]);
});

test('a snapshot taken before migration 0125 has no blockers and is read as such, not as blocked', () => {
  const legacy = input();
  assert.equal(legacy.world.blockers, undefined);
  assert.deepEqual(chosen(legacy), [taskId(1)]);
});
