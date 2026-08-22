import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  ProjectDecisionInput,
  hashDecisionInput,
} from './project-decision.service';
import { selectDispatchableTasks } from './project-dispatch-pass';
import { turnReasonFactsOf } from './project-turn-reason';
import { planTaskAggregation, AggregationTaskFact } from './task-aggregation';
import { detectProjectBlockerConditions } from './project-blocker-conditions';
import { blockerKindForRefusal, PROJECT_BLOCKER_NON_BLOCKING_REFUSALS } from './project-blocker';
import { acceptanceDigest, AcceptanceFacts, sha256 } from './project-acceptance';
import {
  authorizeProjectAction,
  ProjectActionAuthorizationInput,
} from './project-authorization.service';
import {
  failedTaskDisposition,
  failedTaskNeedsAttention,
  loopCanRetryFailedTask,
} from './project-failed-retry';
import {
  taskNotRetiredSql,
  taskRetirement,
  verificationFailureIsHistorySql,
} from '../tasks/task-supersession';

/**
 * §13.6 SU6 across every gate that reads it, on frozen snapshots.
 *
 * The property under test is one sentence in six places: an attempt that was REPLACED is history,
 * and no gate may treat it as a current failure. This deployment shipped with every one of these
 * gates asking `status` and stopping there, and the composition re-dispatched a review that had
 * already been re-run from scratch. So each gate gets a positive case (retired ⇒ excluded) and a
 * negative one (not retired ⇒ unchanged), and the four RETIREMENT SHAPES are enumerated rather than
 * represented by the easy one:
 *
 *   pointer + SUPERSEDED   the ordinary link;
 *   SUPERSEDED, no pointer 0128's FK is ON DELETE SET NULL, so deleting the successor leaves this;
 *   ABANDONED              dropped on purpose, and never had a pointer at all;
 *   pointer alone          only reachable on rows written before 0128's CHECK, and read as retired
 *                          rather than trusted to be impossible.
 *
 * A predicate keyed on `superseded_by_task_id IS NOT NULL` passes the first and fails the next two,
 * which is why every test below runs the whole table.
 */

const PROJECT = '00000000-0000-7000-8000-000000009101';
const OWNER = '00000000-0000-7000-8000-000000009102';
const AGENT = '00000000-0000-7000-8000-000000009103';
const READ_AT = '2026-08-21T00:00:00.000Z';

const p = uuidToBase62(PROJECT);
const agent = uuidToBase62(AGENT);

function taskId(n: number): string {
  return uuidToBase62(`00000000-0000-7000-8000-00000000${(9200 + n).toString().padStart(4, '0')}`);
}

const OLD = taskId(1);
const SUCCESSOR = taskId(2);

/** The four ways a row can say "this attempt is not the live one". */
const RETIREMENTS: Array<{
  name: string;
  facts: { supersededByTaskId: string | null; terminalReason: string | null };
  reads: 'SUPERSEDED' | 'ABANDONED';
}> = [
  {
    name: 'linked to its successor',
    facts: { supersededByTaskId: SUCCESSOR, terminalReason: 'SUPERSEDED' },
    reads: 'SUPERSEDED',
  },
  {
    name: 'successor deleted (ON DELETE SET NULL left the reason)',
    facts: { supersededByTaskId: null, terminalReason: 'SUPERSEDED' },
    reads: 'SUPERSEDED',
  },
  {
    name: 'abandoned, nothing replaced it',
    facts: { supersededByTaskId: null, terminalReason: 'ABANDONED' },
    reads: 'ABANDONED',
  },
  {
    name: 'pointer without a reason (pre-0128 row)',
    facts: { supersededByTaskId: SUCCESSOR, terminalReason: null },
    reads: 'SUPERSEDED',
  },
];

const NOT_RETIRED = { supersededByTaskId: null, terminalReason: null };

function skipReasonFor(
  selection: ReturnType<typeof selectDispatchableTasks>,
  id: string,
): string | undefined {
  return selection.skipped.find((row) => row.taskId === id)?.reason;
}

/** The blocker detectors take §7.5's plan; nothing here is about rotation, so it stays out of it. */
const UNSUPPORTED_COORDINATOR = {
  status: 'UNSUPPORTED' as const,
  trigger: null,
  fromSessionId: null,
  landingWorkspaceId: null,
};

// ---------------------------------------------------------------------------------------------
// The predicate itself
// ---------------------------------------------------------------------------------------------

test('taskRetirement reads every shape that means "not the live attempt", not just the pointer', () => {
  for (const shape of RETIREMENTS) {
    assert.equal(taskRetirement(shape.facts), shape.reads, shape.name);
  }
  assert.equal(taskRetirement(NOT_RETIRED), null);
});

test('the SQL predicate reads both columns, so a deleted successor is still retired', () => {
  // Spelled once and pasted by six raw gates. If this stops naming both columns, the recovery scan
  // re-arms a project for an attempt whose successor was deleted — the second row of the table.
  const sql = taskNotRetiredSql('t');
  assert.match(sql, /t\."terminal_reason" IS NULL/);
  assert.match(sql, /t\."superseded_by_task_id" IS NULL/);
  assert.equal(taskNotRetiredSql('x'), taskNotRetiredSql('x'));
  assert.match(taskNotRetiredSql('x'), /^\(x\./);
});

test('a verification failure is history when its verifier OR its subject was replaced', () => {
  const sql = verificationFailureIsHistorySql();
  // Either side, because either one makes the later PASS that is the ONLY thing which resolves the
  // row impossible to ever arrive.
  assert.match(sql, /verifier\."terminal_reason"/);
  assert.match(sql, /subject\."terminal_reason"/);
  assert.match(sql, /verifier\."superseded_by_task_id"/);
  assert.match(sql, /subject\."superseded_by_task_id"/);
});

// ---------------------------------------------------------------------------------------------
// §9.5 Q3's ladder
// ---------------------------------------------------------------------------------------------

function failedFacts(overrides: Record<string, unknown> = {}) {
  return {
    status: 'FAILED',
    hasLiveSession: false,
    failureCount: 1,
    failureAttributable: true,
    retryBackoffExpired: true,
    ...overrides,
  };
}

test('a retired FAILED task is RETIRED, on every shape, and the loop may not retry it', () => {
  for (const shape of RETIREMENTS) {
    const disposition = failedTaskDisposition(
      failedFacts({ retirement: taskRetirement(shape.facts) }),
    );
    assert.equal(disposition, 'RETIRED', shape.name);
    assert.equal(loopCanRetryFailedTask(disposition), false, shape.name);
    // ...and it asks nothing of anybody. A person called to a failure that has already been re-done
    // is the foreman shape TU2 exists to prevent, arriving through the door TU2 opened.
    assert.equal(failedTaskNeedsAttention(disposition), false, shape.name);
  }
});

test('RETIRED outranks OCCUPIED, so a retired attempt does not flip as sessions come and go', () => {
  // A stated fact about the attempt beats a passing property of it. If a live session could make a
  // retired task read as OCCUPIED, TF6's episode identity would move when the session ended and the
  // planner would mint a second permanent turn key for one dead task.
  assert.equal(
    failedTaskDisposition(failedFacts({ retirement: 'SUPERSEDED', hasLiveSession: true })),
    'RETIRED',
  );
});

test('an ordinary failure is untouched: no retirement means the v1.18 ladder still applies', () => {
  assert.equal(failedTaskDisposition(failedFacts()), 'RETRY_DUE');
  assert.equal(failedTaskDisposition(failedFacts({ retirement: null })), 'RETRY_DUE');
  assert.equal(
    failedTaskDisposition(failedFacts({ retryBackoffExpired: false })),
    'RETRY_BACKOFF',
  );
  assert.equal(failedTaskDisposition(failedFacts({ failureCount: 5 })), 'ATTEMPTS_EXHAUSTED');
  // Absent (an older snapshot) reads as "not retired" — that is what every one of those rows was.
  const { ...withoutField } = failedFacts();
  assert.equal(failedTaskDisposition(withoutField), 'RETRY_DUE');
});

// ---------------------------------------------------------------------------------------------
// §7.8's pass
// ---------------------------------------------------------------------------------------------

type TaskFact = ProjectDecisionInput['world']['tasks'][number];

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
    dispatchAttempt: '3',
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

function input(tasks: TaskFact[]): ProjectDecisionInput {
  const world: ProjectDecisionInput['world'] = {
    project: {
      id: p, ownerId: uuidToBase62(OWNER), title: 'ship', goal: null, acceptanceCriteria: null,
      status: 'OPEN', coordinatorEnabled: true, automationPolicy: 'GUARDED_AUTO',
      maxConcurrentTasks: 3, sessionBudgetPerDay: null, configRevision: '7',
      coordinatorAgentId: agent, coordinatorSessionId: null, coordinatorWorkspaceId: null,
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '4', coordinatorGeneration: '1',
      coordinatorSessionId: null, nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [{
      projectMemberId: uuidToBase62('00000000-0000-7000-8000-000000009401'),
      agentId: agent, role: 'MEMBER', enabled: true, deletedAt: null, runnerId: null,
      model: null, effort: null, providerFallbacks: [], canCreateTasks: false, canDelegate: false,
      maxConcurrentTasks: null,
    }],
    tasks,
    sessions: [],
    coordinatorSession: null, workspaces: [], runners: [], providers: [],
    actions: [],
    blockers: [],
    evidence: { branches: [], tests: [] },
  };
  const evaluation = {
    epoch: Date.parse(READ_AT) / 1_000,
    dueTasks: Object.fromEntries(
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

test('the pass proposes no retired attempt, and says TASK_SUPERSEDED rather than TASK_NOT_OPEN', () => {
  for (const shape of RETIREMENTS) {
    const selection = selectDispatchableTasks(input([
      task(OLD, { status: 'FAILED', failureCount: 1, ...shape.facts }),
    ]));
    assert.deepEqual(selection.candidates, [], shape.name);
    // Its OWN reason. `TASK_NOT_OPEN` and "somebody else finished this" send a reader to opposite
    // places, and the incident's whole visible symptom was that nothing said the second one.
    assert.deepEqual(
      selection.skipped,
      [{ taskId: OLD, reason: 'TASK_SUPERSEDED' }],
      shape.name,
    );
  }
});

test('a retired attempt is explained whatever status it holds, including CANCELLED', () => {
  // The production row this unit exists for is CANCELLED, not FAILED. Before this change the skip
  // list did not consider a CANCELLED task at all, so "why is this not running" had no answer that
  // distinguished "dropped" from "re-done over there".
  const selection = selectDispatchableTasks(input([
    task(OLD, { status: 'CANCELLED', supersededByTaskId: SUCCESSOR, terminalReason: 'SUPERSEDED' }),
  ]));
  assert.deepEqual(selection.skipped, [{ taskId: OLD, reason: 'TASK_SUPERSEDED' }]);
});

test('the negative case: an identical FAILED task with no retirement is still dispatched', () => {
  // The v1.18 retry ladder is not narrowed by this change. If this ever goes red, SU6 has been
  // implemented as "FAILED means stop" and PC-CX-64 has been undone.
  const selection = selectDispatchableTasks(input([
    task(OLD, { status: 'FAILED', failureCount: 1 }),
  ]));
  assert.deepEqual(selection.candidates, [{ taskId: OLD, attempt: '3' }]);
});

test('a pre-0129 snapshot carries neither column and dispatches exactly as it used to', () => {
  // Mixed-version replay: an old decision must replay to what it originally produced, not to
  // today's rules applied to yesterday's world.
  const legacy = task(OLD, { status: 'FAILED', failureCount: 1 });
  delete (legacy as Record<string, unknown>).supersededByTaskId;
  delete (legacy as Record<string, unknown>).terminalReason;
  const selection = selectDispatchableTasks(input([legacy]));
  assert.deepEqual(selection.candidates, [{ taskId: OLD, attempt: '3' }]);
});

// ---------------------------------------------------------------------------------------------
// §7.2 TU2's turn predicate
// ---------------------------------------------------------------------------------------------

const turnContext = {
  openBlockers: [],
  verdicts: [],
  coordinator: { status: 'HEALTHY' as const, trigger: null, rotate: false, sessionId: null },
};

test('a retired failure opens no TASK_FAILURE turn, on every shape', () => {
  for (const shape of RETIREMENTS) {
    const facts = turnReasonFactsOf(
      input([task(OLD, { status: 'FAILED', failureCount: 5, ...shape.facts })]),
      turnContext as never,
    );
    assert.equal(
      Object.hasOwn(facts, 'TASK_FAILURE'), false,
      `${shape.name} must not wake a person about work that was already re-done`,
    );
  }
});

test('the negative case: an exhausted failure nobody replaced still opens its turn', () => {
  const facts = turnReasonFactsOf(
    input([task(OLD, { status: 'FAILED', failureCount: 5 })]),
    turnContext as never,
  );
  assert.deepEqual(facts.TASK_FAILURE, [`${OLD}#3`]);
});

// ---------------------------------------------------------------------------------------------
// §11's detectors
// ---------------------------------------------------------------------------------------------

test('no blocker is raised about a retired attempt, so acceptance is not held by one', () => {
  for (const shape of RETIREMENTS) {
    const conditions = detectProjectBlockerConditions(
      input([task(OLD, { status: 'FAILED', failureCount: 5, failureAttributable: false, ...shape.facts })]),
      { verificationVerdicts: [], aggregationCycleTaskIds: [], aggregationCompletionGaps: [], coordinatorSession: UNSUPPORTED_COORDINATOR },
    );
    assert.deepEqual(
      conditions.filter((condition) => condition.subjectId === OLD), [],
      shape.name,
    );
  }
  // Negative: the same history with nothing replacing it still raises its row.
  const raised = detectProjectBlockerConditions(
    input([task(OLD, { status: 'FAILED', failureCount: 5, failureAttributable: false })]),
    { verificationVerdicts: [], aggregationCycleTaskIds: [], aggregationCompletionGaps: [], coordinatorSession: UNSUPPORTED_COORDINATOR },
  );
  assert.deepEqual(raised.map((condition) => condition.kind), ['UNKNOWN_FAILURE']);
});

test('TASK_SUPERSEDED is a non-blocking refusal: a replaced attempt breeds no blocker', () => {
  assert.equal(PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('TASK_SUPERSEDED'), true);
  assert.equal(blockerKindForRefusal('TASK_SUPERSEDED'), null);
  // A refusal nobody classified still lands on UNKNOWN_FAILURE — the fallback is not weakened.
  assert.equal(blockerKindForRefusal('SOMETHING_NEW'), 'UNKNOWN_FAILURE');
});

// ---------------------------------------------------------------------------------------------
// §9.2's commit-point gate
// ---------------------------------------------------------------------------------------------

function authInput(
  taskOverrides: Partial<NonNullable<ProjectActionAuthorizationInput['task']>> = {},
): ProjectActionAuthorizationInput {
  return {
    v: 1,
    sourceDecisionInputHash: 'd'.repeat(64),
    idempotencyKey: 'pc:v1:x:dispatch:y:3',
    evaluatedAt: READ_AT,
    action: 'DISPATCH_TASK',
    requiredPermission: 'COORDINATE',
    project: {
      id: p, status: 'OPEN', coordinatorEnabled: true, automationPolicy: 'AUTO',
      configRevision: '7', inFlightTasks: 0, maxConcurrentTasks: 3,
      coordinatorSessionsStartedLast24h: 0, sessionBudgetPerDay: null,
    },
    principal: {
      agentId: agent, coordinatorAgentId: agent, memberRole: 'COORDINATOR', agentEnabled: true,
      agentDeleted: false, canCoordinate: true, canCreateTasks: true, canDelegate: true,
    },
    task: {
      id: OLD, status: 'FAILED', dispatchHold: false, runAtDue: true, dependenciesReady: true,
      verificationBlock: null, hasLiveSession: false, assigneeAgentId: agent,
      assigneeIsProjectMember: true, assigneeEnabled: true, agentInFlightTasks: 0,
      agentMaxConcurrentTasks: null, failureCount: 1, failureAttributable: true,
      maxAutoRunFailures: 5, retryBackoffUntil: null,
      ...taskOverrides,
    },
    approval: { state: 'NONE' },
  } as ProjectActionAuthorizationInput;
}

test('the commit point DENIES a dispatch of a retired attempt — no Session, no fake success', () => {
  for (const shape of RETIREMENTS) {
    const result = authorizeProjectAction(authInput({ retirement: taskRetirement(shape.facts) }));
    // DENY and not DEFER: a deferral says "not yet", and there is no later instant at which a
    // replaced attempt becomes the live one again.
    assert.equal(result.decision, 'DENY', shape.name);
    assert.equal(result.reasonCode, 'TASK_SUPERSEDED', shape.name);
  }
});

test('the race this closes: the snapshot said dispatch, the commit point says superseded', () => {
  // §7.8's pass chose this task from a snapshot taken before anything locked it. Between that
  // snapshot and this transaction somebody linked a successor. The pass was not wrong and the
  // snapshot is not stale — the world moved, and the answer has to be a refusal with a name.
  const planned = selectDispatchableTasks(input([task(OLD, { status: 'FAILED', failureCount: 1 })]));
  assert.deepEqual(planned.candidates, [{ taskId: OLD, attempt: '3' }]);
  const atCommit = authorizeProjectAction(authInput({ retirement: 'SUPERSEDED' }));
  assert.equal(atCommit.decision, 'DENY');
  assert.equal(atCommit.reasonCode, 'TASK_SUPERSEDED');
});

test('the negative case: the same task without a retirement is still admitted', () => {
  const result = authorizeProjectAction(authInput());
  assert.equal(result.decision, 'ALLOW');
  // Absent (an older caller that does not send the field) reads as not retired.
  const legacy = authInput();
  delete (legacy.task as Record<string, unknown>).retirement;
  assert.equal(authorizeProjectAction(legacy).decision, 'ALLOW');
});

// ---------------------------------------------------------------------------------------------
// §13.1 aggregation
// ---------------------------------------------------------------------------------------------

function child(id: string, overrides: Partial<AggregationTaskFact> = {}): AggregationTaskFact {
  return {
    id,
    status: 'DONE',
    parentTaskId: 'parent',
    completionPolicy: 'MANUAL',
    verifiesTaskId: null,
    verdict: null,
    ...overrides,
  };
}

test('a replaced child settles the parent when its successor is under the same parent', () => {
  const plan = planTaskAggregation([
    { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'ALL_CHILDREN_DONE' },
    child('replaced', {
      status: 'FAILED', retirement: 'SUPERSEDED', supersededByTaskId: 'successor',
    }),
    child('successor'),
  ]);
  assert.deepEqual(plan.aggregations.map((a) => [a.taskId, a.to]), [['parent', 'DONE']]);
  // Counted as CANCELLED — an attempt that ended without finishing, whose ending is now history and
  // whose work is represented by the sibling that took it over.
  assert.deepEqual(plan.aggregations[0].evidence.children,
    { total: 2, done: 1, cancelled: 1, outstanding: 0 });
});

test('...and does NOT settle it when the successor left the subtree', () => {
  // SU3 requires the successor to share a PROJECT, not a parent. A replacement filed under another
  // parent — or under none — takes the work out of this subtree, and settling here would complete
  // the parent over work that is still going somewhere else. Fail closed.
  for (const successorParent of [null, 'other-parent'] as const) {
    const plan = planTaskAggregation([
      { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'ALL_CHILDREN_DONE' },
      child('done'),
      child('replaced', {
        status: 'FAILED', retirement: 'SUPERSEDED', supersededByTaskId: 'successor',
      }),
      child('successor', { parentTaskId: successorParent, status: 'OPEN' }),
    ]);
    assert.deepEqual(plan.aggregations, [], String(successorParent));
  }
});

test('a chain that cannot be followed leaves the child outstanding', () => {
  // A successor this snapshot cannot see, and a retirement with no successor at all. Both are
  // "cannot tell", and a parent may not be completed on one.
  for (const facts of [
    { retirement: 'SUPERSEDED' as const, supersededByTaskId: 'not-in-snapshot' },
    { retirement: 'ABANDONED' as const, supersededByTaskId: null },
  ]) {
    const plan = planTaskAggregation([
      { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'ALL_CHILDREN_DONE' },
      child('done'),
      child('replaced', { status: 'FAILED', ...facts }),
    ]);
    assert.deepEqual(plan.aggregations, [], JSON.stringify(facts));
  }
});

test('the negative case: an ordinary FAILED child still holds its parent open', () => {
  const plan = planTaskAggregation([
    { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'ALL_CHILDREN_DONE' },
    child('done'),
    child('broken', { status: 'FAILED' }),
  ]);
  assert.deepEqual(plan.aggregations, []);
});

test('a replaced verification stops being an outstanding check', () => {
  // 04R / 04R2 / 04R3: three cancelled attempts at one review. With every re-filed check counted as
  // outstanding, VERIFICATION_PASSED is unreachable for any subject whose check was ever re-run.
  const plan = planTaskAggregation([
    { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'VERIFICATION_PASSED' },
    child('work'),
    child('oldCheck', {
      parentTaskId: null, status: 'CANCELLED', verifiesTaskId: 'parent',
      retirement: 'SUPERSEDED', supersededByTaskId: 'freshCheck',
    }),
    child('freshCheck', { parentTaskId: null, verifiesTaskId: 'parent', verdict: 'PASS' }),
  ]);
  assert.deepEqual(plan.aggregations.map((a) => [a.taskId, a.to]), [['parent', 'DONE']]);
});

test('the negative case: a live check that has not concluded still holds the parent', () => {
  const plan = planTaskAggregation([
    { ...child('parent', { parentTaskId: null }), status: 'OPEN', completionPolicy: 'VERIFICATION_PASSED' },
    child('work'),
    child('check', { parentTaskId: null, status: 'OPEN', verifiesTaskId: 'parent' }),
  ]);
  assert.deepEqual(plan.aggregations, []);
});

// ---------------------------------------------------------------------------------------------
// §13.6 SU9: a dependency on a replaced attempt
// ---------------------------------------------------------------------------------------------

const DOWNSTREAM = taskId(3);

test('a prerequisite that was replaced is satisfied by the attempt that took over', () => {
  // The edge names OLD, which is CANCELLED and will never be dispatched again. Read literally it is
  // a prerequisite nothing can complete, and everything downstream of it waits for ever with no
  // blocker and nothing to act on.
  const selection = selectDispatchableTasks(input([
    task(OLD, {
      status: 'CANCELLED', supersededByTaskId: SUCCESSOR, terminalReason: 'SUPERSEDED',
    }),
    task(SUCCESSOR, { status: 'DONE' }),
    task(DOWNSTREAM, { dependsOnTaskIds: [OLD] }),
  ]));
  assert.deepEqual(selection.candidates.map((c) => c.taskId), [DOWNSTREAM]);
});

test('...and is NOT satisfied while that successor is still going', () => {
  const selection = selectDispatchableTasks(input([
    task(OLD, {
      status: 'CANCELLED', supersededByTaskId: SUCCESSOR, terminalReason: 'SUPERSEDED',
    }),
    task(SUCCESSOR, { status: 'OPEN' }),
    task(DOWNSTREAM, { dependsOnTaskIds: [OLD] }),
  ]));
  assert.equal(skipReasonFor(selection, DOWNSTREAM), 'TASK_DEPENDENCIES_INCOMPLETE');
});

test('a chain with nothing at the end of it stays unsatisfied, in every shape', () => {
  // Fail-closed: `SUCCESSOR_DELETED` and `ABANDONED` both mean nothing took the work over, so the
  // edge is a question for a person rather than something to walk past.
  for (const facts of [
    { supersededByTaskId: null, terminalReason: 'SUPERSEDED' },
    { supersededByTaskId: null, terminalReason: 'ABANDONED' },
  ]) {
    const selection = selectDispatchableTasks(input([
      task(OLD, { status: 'CANCELLED', ...facts }),
      task(DOWNSTREAM, { dependsOnTaskIds: [OLD] }),
    ]));
    assert.equal(
      skipReasonFor(selection, DOWNSTREAM), 'TASK_DEPENDENCIES_INCOMPLETE',
      JSON.stringify(facts),
    );
  }
});

test('a successor this snapshot cannot see is an unknown, not a pass', () => {
  // Project-scoped read: a row it did not read is a row it may not infer. The same rule an
  // out-of-project prerequisite already follows.
  const selection = selectDispatchableTasks(input([
    task(OLD, {
      status: 'CANCELLED', supersededByTaskId: taskId(9), terminalReason: 'SUPERSEDED',
    }),
    task(DOWNSTREAM, { dependsOnTaskIds: [OLD] }),
  ]));
  assert.equal(skipReasonFor(selection, DOWNSTREAM), 'TASK_DEPENDENCIES_INCOMPLETE');
});

test('the negative case: an ordinary unfinished prerequisite still blocks', () => {
  const selection = selectDispatchableTasks(input([
    task(OLD, { status: 'OPEN' }),
    task(DOWNSTREAM, { dependsOnTaskIds: [OLD] }),
  ]));
  assert.equal(skipReasonFor(selection, DOWNSTREAM), 'TASK_DEPENDENCIES_INCOMPLETE');
});

// ---------------------------------------------------------------------------------------------
// The two hashes
// ---------------------------------------------------------------------------------------------

function acceptanceFacts(taskRow: [string, string, string, string, string]): AcceptanceFacts {
  return {
    criteriaRevision: sha256('every suite green'),
    taskSet: [taskRow],
    verdicts: [],
    mergeEvidence: [],
  };
}

test('the acceptance digest moves on BOTH supersession columns, independently', () => {
  const base = acceptanceFacts([OLD, 'FAILED', 'MANUAL', '', '']);
  const withReason = acceptanceFacts([OLD, 'FAILED', 'MANUAL', 'SUPERSEDED', '']);
  const withBoth = acceptanceFacts([OLD, 'FAILED', 'MANUAL', 'SUPERSEDED', SUCCESSOR]);
  const abandoned = acceptanceFacts([OLD, 'FAILED', 'MANUAL', 'ABANDONED', '']);

  // Each of the three transitions is a different world, and the DONE gate reads all of them.
  assert.notEqual(acceptanceDigest(PROJECT, base), acceptanceDigest(PROJECT, withReason));
  // The pointer alone: `SUCCESSOR_DELETED` re-pointed at a new attempt keeps the reason and moves
  // only this column. A digest carrying one of the two would agree about worlds that differ.
  assert.notEqual(acceptanceDigest(PROJECT, withReason), acceptanceDigest(PROJECT, withBoth));
  assert.notEqual(acceptanceDigest(PROJECT, withReason), acceptanceDigest(PROJECT, abandoned));
});

test('the snapshot hash moves on the same change, so the two never disagree about it', () => {
  const before = input([task(OLD, { status: 'FAILED' })]);
  const linked = input([task(OLD, {
    status: 'FAILED', supersededByTaskId: SUCCESSOR, terminalReason: 'SUPERSEDED',
    supersededAt: READ_AT,
  })]);
  assert.notEqual(before.decisionInputHash, linked.decisionInputHash);

  // Only the pointer moves (a successor deleted, then re-pointed) — still a different world.
  const successorDeleted = input([task(OLD, {
    status: 'FAILED', supersededByTaskId: null, terminalReason: 'SUPERSEDED', supersededAt: READ_AT,
  })]);
  assert.notEqual(linked.decisionInputHash, successorDeleted.decisionInputHash);
});

test('a pre-0129 snapshot replays to its own hash: the new fields are absent, not null', () => {
  // Mixed-version safety. If adding the fields had changed how an OLD decision hashes, every
  // in-flight decision written by the previous binary would fail `assertDecisionReplay` on deploy.
  const legacy = task(OLD, { status: 'FAILED' });
  delete (legacy as Record<string, unknown>).supersededByTaskId;
  delete (legacy as Record<string, unknown>).supersededAt;
  delete (legacy as Record<string, unknown>).terminalReason;
  const snapshot = input([legacy]);
  assert.equal(
    hashDecisionInput({
      world: snapshot.world, evaluation: snapshot.evaluation, signals: snapshot.signals,
    }),
    snapshot.decisionInputHash,
  );
});
