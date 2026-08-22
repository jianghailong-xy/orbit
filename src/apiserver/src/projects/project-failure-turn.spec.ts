import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { TaskStatus, uuidToBase62 } from '@orbit/shared';
import {
  ProjectDecisionInput,
  ProjectDecisionOutcome,
  hashDecisionInput,
  planProjectDecision,
} from './project-decision.service';
import { openCoordinatorTurnIdempotencyKey } from './project-turn-reason';
import { projectPolicyCell } from './project-authorization.service';
import { computeDependencyState } from '../tasks/task-dependencies';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';

/**
 * The regression fixture for `PC-CX-63`, built out of the state a real failure actually leaves.
 *
 * Every earlier fixture in this directory describes a failure by setting `failureCount` on a task
 * that is still `OPEN`. That shape cannot occur: a genuine `FAILED` run lands the task at `FAILED`
 * (`runner-api.controller` and `reaper.service` both call `reclaimStalledTask(..., FAILED)`), and a
 * `FAILED` task is refused by §7.4's first precondition (`TASK_NOT_OPEN`) forever after. Reading
 * the old shape, the loop looks like it is between retries. Reading this one, it is not between
 * anything: nothing will dispatch the task again, `failureCount = 1` is below the threshold that
 * would open a `TEST_FAILED` blocker, and before v1.17 no reason opened a turn. The project woke
 * every 60 seconds and decided nothing, with every clause of the contract satisfied.
 *
 * So the fixture is the four facts the defect report named, together:
 * `Task = FAILED`, `Session = FAILED`, the downstream task at `BLOCKED_FAILED`, and a Coordinator
 * Session sitting at `AWAITING_INPUT` — alive, addressable, and never addressed.
 */

const PROJECT = '00000000-0000-7000-8000-000000002001';
const OWNER = '00000000-0000-7000-8000-000000002002';
const FAILED_TASK = '00000000-0000-7000-8000-000000002003';
const DOWNSTREAM_TASK = '00000000-0000-7000-8000-000000002004';
const FAILED_SESSION = '00000000-0000-7000-8000-000000002005';
const COORDINATOR_SESSION = '00000000-0000-7000-8000-000000002006';
const COORDINATOR_AGENT = '00000000-0000-7000-8000-000000002007';
const WORKSPACE = '00000000-0000-7000-8000-000000002008';
const MEMBER = '00000000-0000-7000-8000-000000002009';
const DECISION = '00000000-0000-7000-8000-00000000200a';

const AT = '2026-08-21T09:00:00.000Z';
const EPOCH = Date.parse('2026-08-21T09:05:00.000Z') / 1_000;

const id = uuidToBase62;

interface FixtureOptions {
  /** The dispatch whose run failed — TF6's episode identity. */
  dispatchAttempt?: string;
  /** What the failed task's status actually is. The old fake fixture left this `OPEN`. */
  failedTaskStatus?: string;
  /** The coordination run's state. `AWAITING_INPUT` is the production case: live, and idle. */
  coordinatorRunStatus?: string;
  automationPolicy?: string;
  actions?: ProjectDecisionInput['world']['actions'];
  turnWindows?: ProjectDecisionInput['evaluation']['turnWindows'];
  /** Emit the tasks in the opposite order, to show the digest does not read array order. */
  reverseTasks?: boolean;
}

function fixture(options: FixtureOptions = {}): ProjectDecisionInput {
  const {
    dispatchAttempt = '1',
    failedTaskStatus = 'FAILED',
    coordinatorRunStatus = 'AWAITING_INPUT',
    automationPolicy = 'GUARDED_AUTO',
    actions = [],
    turnWindows,
    reverseTasks = false,
  } = options;

  const tasks: ProjectDecisionInput['world']['tasks'] = [
    {
      id: id(FAILED_TASK), title: 'build the thing', contentHash: 'a'.repeat(64),
      status: failedTaskStatus, parentTaskId: null, assigneeAgentId: id(COORDINATOR_AGENT),
      provider: null, model: null, autoRunWhenReady: true, dispatchHold: false, runAt: null,
      verifiesTaskId: null, dispatchAuthority: 'COORDINATOR', dispatchAttempt,
      requiredCapabilities: [], completionPolicy: 'MANUAL', verdict: null, verdictRevision: '0',
      dependsOnTaskIds: [], liveSessionIds: [],
      // One FAILED session with an error on it: attributable, and one short of the threshold that
      // would have opened a `TEST_FAILED` blocker. This is the ordinary case, not the extreme one.
      failureCount: 1, lastFailureAt: AT, failureAttributable: true, retryBackoffUntil: null,
      updatedAt: AT,
    },
    {
      id: id(DOWNSTREAM_TASK), title: 'ship the thing', contentHash: 'b'.repeat(64),
      status: 'OPEN', parentTaskId: null, assigneeAgentId: id(COORDINATOR_AGENT),
      provider: null, model: null, autoRunWhenReady: true, dispatchHold: false, runAt: null,
      verifiesTaskId: null, dispatchAuthority: 'COORDINATOR', dispatchAttempt: '0',
      requiredCapabilities: [], completionPolicy: 'MANUAL', verdict: null, verdictRevision: '0',
      dependsOnTaskIds: [id(FAILED_TASK)], liveSessionIds: [],
      failureCount: 0, lastFailureAt: null, failureAttributable: true, retryBackoffUntil: null,
      updatedAt: AT,
    },
  ];

  const world: ProjectDecisionInput['world'] = {
    project: {
      id: id(PROJECT), ownerId: id(OWNER), title: 'coordinate', goal: null,
      acceptanceCriteria: null, status: 'OPEN', coordinatorEnabled: true,
      automationPolicy, maxConcurrentTasks: 3, sessionBudgetPerDay: null, configRevision: '2',
      coordinatorAgentId: id(COORDINATOR_AGENT), coordinatorSessionId: id(COORDINATOR_SESSION),
      coordinatorWorkspaceId: id(WORKSPACE),
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '9', coordinatorGeneration: '3',
      coordinatorSessionId: id(COORDINATOR_SESSION), nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [{
      projectMemberId: id(MEMBER), agentId: id(COORDINATOR_AGENT), role: 'COORDINATOR',
      enabled: true, deletedAt: null, runnerId: null, model: null, effort: null,
      providerFallbacks: [], canCreateTasks: true, canDelegate: true, maxConcurrentTasks: null,
    }],
    tasks: reverseTasks ? [...tasks].reverse() : tasks,
    sessions: [{
      id: id(FAILED_SESSION), taskId: id(FAILED_TASK), workspaceId: id(WORKSPACE),
      assignedRunnerId: null, runStatus: 'FAILED', provider: 'claude', model: null,
      permissionMode: null, effort: null, createdAt: AT, startedAt: AT, finishedAt: AT,
      completedAt: null, deletedAt: null,
    }],
    coordinatorSession: {
      id: id(COORDINATOR_SESSION), runStatus: coordinatorRunStatus, workspaceId: id(WORKSPACE),
      assignedRunnerId: null, startedAt: AT, finishedAt: null, completedAt: null, deletedAt: null,
    },
    workspaces: [{
      workspaceId: id(WORKSPACE), runnerId: null, enabled: true, deletedAt: null, model: null,
      effort: null, defaultMergeTarget: null, workDirExists: null, workDirIsGit: null,
      workDirProbedAt: null,
    }],
    runners: [], providers: [], actions, blockers: [], deadLetters: [],
    evidence: { branches: [], tests: [] },
  };
  const evaluation: ProjectDecisionInput['evaluation'] = {
    epoch: EPOCH,
    dueTasks: {
      [id(FAILED_TASK)]: { runAtDue: true, retryBackoffExpired: true },
      [id(DOWNSTREAM_TASK)]: { runAtDue: true, retryBackoffExpired: true },
    },
    ...(turnWindows ? { turnWindows } : {}),
  };
  const signals: ProjectDecisionInput['signals'] = [];
  return {
    v: 1,
    readAt: AT,
    decisionInputHash: hashDecisionInput({ world, evaluation, signals }),
    world,
    evaluation,
    signals,
  };
}

function plan(input: ProjectDecisionInput): ProjectDecisionOutcome {
  return planProjectDecision(input, { decisionId: DECISION });
}

function turnActions(outcome: ProjectDecisionOutcome): ProjectDecisionOutcome['actions'] {
  return outcome.actions.filter((action) => action.type === 'OPEN_COORDINATOR_TURN');
}

/** The ledger's own view of a turn this project has already applied. */
function appliedTurn(
  key: string,
  resultSessionId: string | null = id(COORDINATOR_SESSION),
): ProjectDecisionInput['world']['actions'][number] {
  return {
    actionId: id('00000000-0000-7000-8000-0000000020ff'),
    type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED', subjectType: 'PROJECT',
    subjectId: id(PROJECT), decisionId: null, resultSessionId, refusalCode: null,
    reasonCode: 'TASK_FAILURE',
    idempotencyKeyHash: sha256Hex(key), detailHash: sha256Hex('detail'),
    createdAt: AT,
  };
}

/** The ledger hashes the RAW key string, and `project-decision.service` does the same on the way
 *  in, so a fixture that wants to be found by TR3 has to hash it the same way. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('the fixture is the production shape: Task FAILED, Session FAILED, downstream BLOCKED_FAILED', () => {
  const input = fixture();
  const failed = input.world.tasks.find((task) => task.id === id(FAILED_TASK))!;
  const downstream = input.world.tasks.find((task) => task.id === id(DOWNSTREAM_TASK))!;

  assert.equal(failed.status, 'FAILED', 'the failed task is FAILED, not an OPEN one with a counter');
  assert.equal(failed.liveSessionIds.length, 0, 'nothing is still running it');
  assert.equal(input.world.sessions[0].runStatus, 'FAILED', 'the run that failed is on the snapshot');
  assert.equal(
    computeDependencyState([failed.status as TaskStatus]),
    'BLOCKED_FAILED',
    'the downstream task is terminally blocked, which is what makes this need a decision',
  );
  assert.equal(downstream.dependsOnTaskIds[0], failed.id);
  // The ordinary case, deliberately: one failure, far below the threshold §9.5 Q3 opens a blocker
  // at. If this fixture only reproduced the extreme case it would not reproduce the defect.
  assert.ok(failed.failureCount < MAX_AUTO_RUN_FAILURES);
  assert.equal(input.world.coordinatorSession!.runStatus, 'AWAITING_INPUT');
});

test('PC-CX-63: a settled task failure opens exactly one TASK_FAILURE turn', () => {
  const outcome = plan(fixture());

  assert.equal(outcome.turnReason, 'TASK_FAILURE');
  assert.deepEqual(outcome.suppressedTurnReasons, []);
  assert.equal(outcome.turn?.verdict, 'OPEN');
  assert.deepEqual(outcome.turn?.turnFacts, [`${id(FAILED_TASK)}#1`]);

  // I15 / TU5: at most one.
  const turns = turnActions(outcome);
  assert.equal(turns.length, 1);
  assert.equal(
    turns[0].idempotencyKey,
    openCoordinatorTurnIdempotencyKey(id(PROJECT), '3', outcome.turn!.reasonDigest),
  );
  assert.deepEqual(turns[0].subject, { type: 'PROJECT', id: id(PROJECT) });

  // The silence this replaces: no blocker was opened, and the state is the fall-through one. Both
  // were true before v1.17 as well — which is exactly why nothing happened.
  assert.deepEqual(outcome.blockersOpened, []);
  assert.equal(outcome.runStateAfter, 'PLANNING');
});

test('PC-CX-63: the fake fixture — the same world with the task left OPEN — opens nothing', () => {
  // This is the shape the earlier tests used, and the reason the defect survived them: with the
  // task at OPEN the loop is between retries, and being quiet is correct.
  const outcome = plan(fixture({ failedTaskStatus: 'OPEN' }));
  assert.equal(outcome.turnReason, null);
  assert.deepEqual(turnActions(outcome), []);
});

test('§7.6 TR1: repeated and reordered delivery of one failure is one digest and one key', () => {
  const first = plan(fixture());
  const again = plan(fixture());
  const reordered = plan(fixture({ reverseTasks: true }));

  assert.equal(again.turn!.reasonDigest, first.turn!.reasonDigest);
  assert.equal(reordered.turn!.reasonDigest, first.turn!.reasonDigest);
  assert.equal(again.turn!.idempotencyKey, first.turn!.idempotencyKey);
  assert.equal(reordered.turn!.idempotencyKey, first.turn!.idempotencyKey);
  // Reordering the tasks really does change the snapshot's identity — so this is the digest being
  // stable across a different input, not two identical inputs being compared.
  assert.notEqual(
    fixture({ reverseTasks: true }).decisionInputHash,
    fixture().decisionInputHash,
  );
});

test('§7.6 TR1 / TF6: a new failure episode is a new key', () => {
  const first = plan(fixture({ dispatchAttempt: '1' }));
  // A person reopened the task, it was dispatched again (`dispatch_attempt` advanced, DA1), and it
  // failed again. Same task, same status, same failure count — a different episode.
  const second = plan(fixture({ dispatchAttempt: '2' }));

  assert.notEqual(second.turn!.reasonDigest, first.turn!.reasonDigest);
  assert.notEqual(second.turn!.idempotencyKey, first.turn!.idempotencyKey);
  assert.equal(second.turn!.verdict, 'OPEN');
});

test('§7.6 TR3: a second look at the same episode is a no-progress blocker, not a second turn', () => {
  const first = plan(fixture());
  const internalKey = openCoordinatorTurnIdempotencyKey(PROJECT, '3', first.turn!.reasonDigest);

  const outcome = plan(fixture({ actions: [appliedTurn(internalKey)] }));
  assert.equal(outcome.turnReason, 'TASK_FAILURE');
  assert.equal(outcome.turn!.verdict, 'NO_PROGRESS');
  assert.equal(outcome.turn!.lastTurnSessionId, id(COORDINATOR_SESSION));
  assert.deepEqual(turnActions(outcome), [], 'the foreman accident is opening this turn twice');
});

test('§7.6 TR1: the same turn still in flight is ALREADY_APPLIED, not no-progress', () => {
  const first = plan(fixture());
  const internalKey = openCoordinatorTurnIdempotencyKey(PROJECT, '3', first.turn!.reasonDigest);

  // The coordination run is mid-turn. Nothing has failed to progress yet — it has not finished.
  const outcome = plan(fixture({
    actions: [appliedTurn(internalKey)],
    coordinatorRunStatus: 'RUNNING',
  }));
  assert.equal(outcome.turn!.verdict, 'IN_FLIGHT');
  assert.deepEqual(turnActions(outcome), []);
});

test('§7.6 TR2: inside the window the turn is held, not lost', () => {
  const outcome = plan(fixture({
    turnWindows: {
      TASK_FAILURE: { windowEndsAt: '2026-08-21T09:05:30.000Z', rateLimitExpired: false },
    },
  }));
  assert.equal(outcome.turnReason, 'TASK_FAILURE', 'the reason is still the decision');
  assert.equal(outcome.turn!.verdict, 'RATE_LIMITED');
  assert.equal(outcome.turn!.windowEndsAt, '2026-08-21T09:05:30.000Z');
  assert.deepEqual(turnActions(outcome), [], 'TR2-b ①: a held turn takes no key');

  const expired = plan(fixture({
    turnWindows: {
      TASK_FAILURE: { windowEndsAt: '2026-08-21T09:04:30.000Z', rateLimitExpired: true },
    },
  }));
  assert.equal(expired.turn!.verdict, 'OPEN');
  assert.equal(turnActions(expired).length, 1);
});

test('TU7: with no live coordination run the rotation goes first and the reason survives it', () => {
  const outcome = plan(fixture({ coordinatorRunStatus: 'FAILED' }));
  assert.equal(outcome.turnReason, 'TASK_FAILURE', 'the failure is still what this project needs');
  assert.equal(outcome.turn!.verdict, 'NO_LIVE_RUN');
  assert.deepEqual(turnActions(outcome), []);
  assert.ok(
    outcome.actions.some((action) => action.type === 'ROTATE_COORDINATOR_SESSION'),
    'a dead coordination run is rotated, and the turn is decided again on the next pass',
  );
});

test('§9.2: the policy boundary is the one OPEN_COORDINATOR_TURN already has, in all three cells', () => {
  // TU6: a failure turn is not a riskier action than any other turn — it starts a conversation, it
  // does not touch the work — so it takes no row of its own. What it must not do is become silent
  // under MANUAL, and it does not: the decision is planned under every policy, and MANUAL turns it
  // into an approval a person can see (§9.2 P2), not into nothing.
  assert.equal(projectPolicyCell('MANUAL', 'COORDINATOR_ROUTINE'), 'REQUIRE_APPROVAL');
  assert.equal(projectPolicyCell('GUARDED_AUTO', 'COORDINATOR_ROUTINE'), 'ALLOW');
  assert.equal(projectPolicyCell('AUTO', 'COORDINATOR_ROUTINE'), 'ALLOW');

  for (const automationPolicy of ['MANUAL', 'GUARDED_AUTO', 'AUTO']) {
    const outcome = plan(fixture({ automationPolicy }));
    assert.equal(outcome.turnReason, 'TASK_FAILURE', `${automationPolicy} decided nothing`);
    assert.equal(outcome.turn!.verdict, 'OPEN', `${automationPolicy} suppressed the decision`);
    assert.equal(turnActions(outcome).length, 1, `${automationPolicy} planned no turn`);
  }
});

test('the same snapshot replays to the same turn, byte for byte', () => {
  const frozen = fixture();
  const first = plan(frozen);
  const replay = plan(JSON.parse(JSON.stringify(frozen)) as ProjectDecisionInput);
  assert.deepEqual(replay.turn, first.turn);
  assert.deepEqual(replay.actions, first.actions);
});
