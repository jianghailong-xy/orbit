/**
 * Unit L6, the loop's half: §11.4's detector, and the coordinator dispatch that refuses before it.
 *
 * These are the two paths the pg replay cannot reach cheaply — the reconcile pass wants a whole
 * snapshot and the dispatcher wants a lease and a decision — so the snapshot is built directly and
 * the dispatcher's one structural property is asserted mechanically rather than described.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';

import { detectProjectBlockerConditions } from './project-blocker-conditions';
import { PROJECT_BLOCKER_POLICY, PROJECT_BLOCKER_REFUSAL_KINDS } from './project-blocker';
import { hashDecisionInput, type ProjectDecisionInput } from './project-decision.service';
import { OWNERSHIP_MISMATCH_REFUSAL } from './project-ownership-gate';

const READ_AT = '2026-08-23T12:00:00.000Z';
const OWNER = '00000000-0000-7000-8000-0000000060a0';
const PROJECT_B = uuidToBase62('00000000-0000-7000-8000-0000000060b0');
const PROJECT_A = uuidToBase62('00000000-0000-7000-8000-0000000060a1');
const AGENT = uuidToBase62('00000000-0000-7000-8000-0000000060c0');
const MISFILED = uuidToBase62('00000000-0000-7000-8000-0000000060d0');

const SOURCES = {
  verificationVerdicts: [],
  aggregationCycleTaskIds: [],
  aggregationCompletionGaps: [],
  coordinatorSession: {
    status: 'HEALTHY' as const, trigger: null, rotate: false, sessionId: null,
  },
} as never;

type TaskFact = ProjectDecisionInput['world']['tasks'][number];

function task(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    id: MISFILED,
    title: 'work that belongs to A',
    contentHash: 'a'.repeat(64),
    status: 'OPEN',
    parentTaskId: null,
    assigneeAgentId: AGENT,
    provider: null,
    model: null,
    autoRunWhenReady: true,
    dispatchHold: false,
    dispatchAuthority: 'COORDINATOR',
    dispatchAttempt: '1',
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
    creatorCoordinatorProjectId: PROJECT_A,
    creatorCoordinatorGeneration: '2',
    ownershipCrossingApproved: false,
    ...overrides,
  };
}

function input(tasks: TaskFact[]): ProjectDecisionInput {
  const world: ProjectDecisionInput['world'] = {
    project: {
      id: PROJECT_B, ownerId: uuidToBase62(OWNER), title: 'ship B', goal: null,
      acceptanceCriteria: null, status: 'OPEN', coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO', maxConcurrentTasks: 3, sessionBudgetPerDay: null,
      configRevision: '1', coordinatorAgentId: AGENT, coordinatorSessionId: null,
      coordinatorWorkspaceId: null,
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '1', coordinatorGeneration: '1',
      coordinatorSessionId: null, nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [],
    tasks,
    sessions: [],
    coordinatorSession: null, workspaces: [], runners: [], providers: [],
    actions: [], blockers: [],
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

const ownershipRows = (tasks: TaskFact[]) =>
  detectProjectBlockerConditions(input(tasks), SOURCES)
    .filter((condition) => condition.kind === 'PROJECT_OWNERSHIP_MISMATCH');

test('L6 §11.4: a mis-filed task raises a row nobody has to try to run first', () => {
  // The dispatcher's refusal would raise this too — but only for a task something ATTEMPTED. A
  // mis-filed task sitting OPEN trips no gate and still distorts this project's acceptance, so the
  // detector has to see it from the world rather than from an attempt.
  const [row] = ownershipRows([task()]);
  assert.ok(row, 'the snapshot holds the condition');
  assert.equal(row.subjectType, 'TASK');
  assert.equal(row.subjectId, MISFILED);
  assert.equal(row.detail.fromProjectId, PROJECT_A);
  assert.equal(row.detail.toProjectId, PROJECT_B);
  assert.equal(row.detail.creatorCoordinatorGeneration, '2');
  assert.equal(
    row.detail.requiredAction,
    PROJECT_BLOCKER_POLICY.PROJECT_OWNERSHIP_MISMATCH.requiredAction,
  );
});

test('L6 §11.4: the target is the project the snapshot is OF, not a column on the row', () => {
  // Every task in `world.tasks` is selected by `project_id = <this project>`, so the detector must
  // read the project from the world. A snapshot answering about a project its task is not in is
  // the shape that would let a moved task raise a row in the place it left.
  const [row] = ownershipRows([task()]);
  assert.equal(row.detail.toProjectId, input([task()]).world.project.id);
});

test('L6 §11.4: an approved crossing raises nothing, and neither does own-scope work', () => {
  assert.deepEqual(ownershipRows([task({ ownershipCrossingApproved: true })]), []);
  assert.deepEqual(ownershipRows([task({ creatorCoordinatorProjectId: PROJECT_B })]), []);
  assert.deepEqual(ownershipRows([task({ creatorCoordinatorProjectId: null })]), []);
});

test('L6 §11.4: the repair clears the row, because an abandoned task is out of scope', () => {
  // What the supported repair leaves behind, exactly: CANCELLED with ABANDONED. If this ever goes
  // red the blocker outlives its own fix and keeps asking for a refile that already happened.
  assert.deepEqual(
    ownershipRows([task({ status: 'CANCELLED', terminalReason: 'ABANDONED' })]), [],
  );
  assert.deepEqual(ownershipRows([task({ status: 'DONE' })]), []);
});

test('L6 §11.4: a pre-L6 snapshot replays to what it originally decided', () => {
  // Mixed-version replay. A decision captured before migration 0156 carries no scope at all, and
  // reading its absence as a mismatch would refuse work on a snapshot that never made a claim.
  const legacy = task();
  delete (legacy as Record<string, unknown>).creatorCoordinatorProjectId;
  delete (legacy as Record<string, unknown>).creatorCoordinatorGeneration;
  delete (legacy as Record<string, unknown>).ownershipCrossingApproved;
  assert.deepEqual(ownershipRows([legacy]), []);
});

test('L6 §11.4: an absent approval flag does not EXCUSE a crossing either', () => {
  // The other direction of the same compatibility rule: a snapshot that records a scope but not the
  // approval must still refuse, or a rolling deploy would be a window in which every mis-filing
  // reads as lawful.
  const partial = task();
  delete (partial as Record<string, unknown>).ownershipCrossingApproved;
  assert.equal(ownershipRows([partial]).length, 1);
});

test('L6 §12: the dispatcher refusal is carried across to the kind, not renamed', () => {
  assert.equal(
    PROJECT_BLOCKER_REFUSAL_KINDS[OWNERSHIP_MISMATCH_REFUSAL], 'PROJECT_OWNERSHIP_MISMATCH',
  );
});

test('L6: the coordinator dispatch asks about ownership BEFORE anything with an effect', () => {
  // Mechanical, because the property is an ORDER and a unit test that called `dispatch` would need
  // a lease, a decision and a project runtime to assert it. What must hold: the gate runs before
  // the authorization commit point and before the Session insert — a refusal placed after either
  // would refuse a dispatch that had already taken the project's capacity or written a run.
  // Read from the SOURCE tree, not the build: what has to hold is an order in the file somebody
  // edits, and a compiled copy can reorder statements a reader never sees.
  const source = readFileSync(
    path.resolve(__dirname, '../../src/projects/project-task-dispatcher.service.ts'), 'utf8',
  );
  const gate = source.indexOf('decideTaskOwnership(');
  const authorize = source.indexOf('this.authorization.authorizeInTransaction(');
  assert.ok(gate > 0, 'the dispatcher no longer evaluates the ownership gate at all');
  assert.ok(authorize > 0);
  assert.ok(
    gate < authorize,
    'the ownership gate must be asked before the authorization commit point',
  );
});
