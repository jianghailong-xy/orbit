/**
 * Unit L4's plan preflight, as a decision over facts.
 *
 * What this file is for: the preflight's whole value is that it answers COMPLETELY and the same way
 * every time, before anything is written. A validator that stops at the first problem, or that
 * answers differently depending on item order, would be a validator a fifty-item plan has to be
 * negotiated with. So the tests below pin the findings as a SET and as an ORDER, and each rule is
 * exercised through the shape it actually arrives in — an existing task, an item of this same
 * batch, a replayed winner.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PLAN_PREFLIGHT_COVERAGE,
  PLAN_PREFLIGHT_DIMENSIONS,
  planItemLandings,
  planPreflightRefusalBody,
  planPreflightRefusals,
  planPreviewBody,
  preflightPlan,
  type PlanFacts,
  type PlanItemFacts,
  type PlanWorldFacts,
} from './task-plan-preflight';
import type { HandoffApproval } from '../projects/project-scope-decision';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_IN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_IN_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WORKSPACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const item = (over: Partial<PlanItemFacts> = {}): PlanItemFacts => ({
  index: 0,
  ref: null,
  projectId: A,
  parentTaskId: null,
  parentRef: null,
  verifiesTaskId: null,
  verifiesRef: null,
  dependsOnTaskIds: [],
  dependsOnRefs: [],
  assigneeId: null,
  listId: null,
  autoRunWhenReady: true,
  acceptanceEpoch: null,
  ...over,
});

const project = (over: Partial<PlanWorldFacts['projects'][string]> = {}) => ({
  title: 'a project',
  status: 'OPEN' as const,
  acceptanceEpoch: '0',
  maxConcurrentTasks: 3,
  sessionBudgetPerDay: null,
  memberWorkspaceIds: new Set<string>(),
  ...over,
});

const facts = (items: PlanItemFacts[], over: Partial<PlanWorldFacts> = {}): PlanFacts => ({
  items,
  world: {
    principal: 'COORDINATOR',
    projects: { [A]: project(), [B]: project() },
    tasks: { [TASK_IN_A]: { projectId: A, verifiesTaskId: null }, [TASK_IN_B]: { projectId: B, verifiesTaskId: null } },
    workspaces: { [WORKSPACE]: { hasRunner: true } },
    dependencyAnswers: {},
    ...over,
  },
});

const approved: HandoffApproval = { state: 'APPROVED', fromProjectId: A, toProjectId: B, taskId: null };

test('the coverage register answers for every dimension, and its own checks are here', () => {
  for (const dimension of PLAN_PREFLIGHT_DIMENSIONS) {
    const checks = PLAN_PREFLIGHT_COVERAGE[dimension];
    assert.ok(checks?.length, `${dimension} claims no checks at all`);
    for (const check of checks) {
      assert.ok(check.check.length > 10, `${dimension} has a check with no sentence`);
      assert.ok(check.where === 'here' || /^[A-Za-z]/.test(check.where),
        `${dimension}: "${check.where}" is neither here nor a named function`);
    }
  }
  // Every dimension the task names has a row, and no dimension exists that nothing checks.
  assert.deepEqual(Object.keys(PLAN_PREFLIGHT_COVERAGE).sort(), [...PLAN_PREFLIGHT_DIMENSIONS].sort());
});

test('a parent or a verification across a project line is refused, whichever shape it arrives in', () => {
  const found = preflightPlan(facts([
    item({ index: 0, parentTaskId: TASK_IN_B }),
    item({ index: 1, verifiesTaskId: TASK_IN_B }),
    item({ index: 2, ref: 'root', projectId: B }),
    item({ index: 3, parentRef: 'root', projectId: A }),
  ]));
  assert.deepEqual(found.map((f) => f.code), [
    'PLAN_PARENT_CROSSES_PROJECT',
    'PLAN_VERIFICATION_CROSSES_PROJECT',
    'PLAN_PARENT_CROSSES_PROJECT',
  ]);
  // Never approvable, and the required action says so rather than sending anybody to ask.
  assert.match(found[0].requiredAction, /never approvable/);
});

test('a check of a check has nothing left to verify, in either shape', () => {
  const found = preflightPlan(facts([
    item({ index: 0, verifiesTaskId: TASK_IN_A }),
    item({ index: 1, ref: 'check', verifiesTaskId: TASK_IN_A }),
    item({ index: 2, verifiesRef: 'check' }),
  ], { tasks: { [TASK_IN_A]: { projectId: A, verifiesTaskId: TASK_IN_B } } }));
  assert.deepEqual(found.map((f) => [f.index, f.code]), [
    [0, 'PLAN_VERIFIES_A_VERIFICATION'],
    [1, 'PLAN_VERIFIES_A_VERIFICATION'],
    [2, 'PLAN_VERIFIES_A_VERIFICATION'],
  ]);
});

test('one ref, one item: a link is never resolved by input order', () => {
  const found = preflightPlan(facts([
    item({ index: 0, ref: 'db', projectId: A }),
    item({ index: 1, ref: 'db', projectId: B }),
    item({ index: 2, parentRef: 'db' }),
  ]));
  assert.equal(found[0].code, 'PLAN_AMBIGUOUS_REF');
  assert.equal(found[0].index, -1, 'an ambiguous ref is a fact about the plan, not about one item');
});

test('a cross-project edge is refused unless an approval names it, with L1 codes', () => {
  const cases: Array<[HandoffApproval | null | undefined, string | null]> = [
    [undefined, 'CROSS_PROJECT_APPROVAL_REQUIRED'],
    [null, 'CROSS_PROJECT_APPROVAL_REQUIRED'],
    [{ ...approved, state: 'PENDING' }, 'APPROVAL_PENDING'],
    [{ ...approved, state: 'DENIED' }, 'APPROVAL_DENIED'],
    [{ ...approved, state: 'EXPIRED' }, 'APPROVAL_EXPIRED'],
    [approved, null],
  ];
  for (const [answer, expected] of cases) {
    const found = preflightPlan(facts([item({ dependsOnTaskIds: [TASK_IN_B] })], {
      dependencyAnswers: answer === undefined ? {} : { [`0:${TASK_IN_B}`]: answer },
    }));
    assert.deepEqual(found.map((f) => f.code), expected ? [expected] : [],
      `answer ${answer?.state ?? 'none'}`);
  }
});

test('an edge inside one project, or onto unfiled work, is nobody\'s crossing', () => {
  assert.deepEqual(preflightPlan(facts([item({ dependsOnTaskIds: [TASK_IN_A] })])), []);
  assert.deepEqual(
    preflightPlan(facts([item({ dependsOnTaskIds: ['unfiled'] })], {
      tasks: { unfiled: { projectId: null, verifiesTaskId: null } },
    })),
    [],
  );
  // And the owner's own edge is an authorization in itself (§4 R1).
  assert.deepEqual(
    preflightPlan(facts([item({ dependsOnTaskIds: [TASK_IN_B] })], { principal: 'USER' })),
    [],
  );
});

test('an edge onto an item this same plan files elsewhere cannot be approved, so it is refused', () => {
  const found = preflightPlan(facts([
    item({ index: 0, ref: 'over-there', projectId: B }),
    item({ index: 1, projectId: A, dependsOnRefs: ['over-there'] }),
  ]));
  assert.deepEqual(found.map((f) => f.code), ['PLAN_BATCH_DEPENDENCY_CROSSES_PROJECT']);
  assert.match(found[0].requiredAction, /cannot be named by one/);
  // Same two items in one project: an ordinary chain, and not this rule's business.
  assert.deepEqual(preflightPlan(facts([
    item({ index: 0, ref: 'first', projectId: A }),
    item({ index: 1, projectId: A, dependsOnRefs: ['first'] }),
  ])), []);
});

test('a plan that names the epoch it was made against is judged on it', () => {
  const moved = preflightPlan(facts([item({ acceptanceEpoch: '3' })], {
    projects: { [A]: project({ acceptanceEpoch: '4' }) },
  }));
  assert.deepEqual(moved.map((f) => f.code), ['PLAN_ACCEPTANCE_EPOCH_MOVED']);
  assert.deepEqual(preflightPlan(facts([item({ acceptanceEpoch: '4' })], {
    projects: { [A]: project({ acceptanceEpoch: '4' }) },
  })), []);
  // A client that names none is not making the claim.
  assert.deepEqual(preflightPlan(facts([item({ acceptanceEpoch: null })], {
    projects: { [A]: project({ acceptanceEpoch: '4' }) },
  })), []);
});

test('execution identity warns and never refuses', () => {
  const found = preflightPlan(facts([item({ assigneeId: WORKSPACE })], {
    workspaces: { [WORKSPACE]: { hasRunner: false } },
  }));
  assert.deepEqual(found.map((f) => [f.code, f.severity]), [
    ['PLAN_ASSIGNEE_HAS_NO_RUNNER', 'WARN'],
    ['PLAN_ASSIGNEE_NOT_ON_PROJECT_TEAM', 'WARN'],
  ]);
  assert.deepEqual(planPreflightRefusals(found), []);
  // On the team and on a runner: nothing to say.
  assert.deepEqual(preflightPlan(facts([item({ assigneeId: WORKSPACE })], {
    projects: { [A]: project({ memberWorkspaceIds: new Set([WORKSPACE]) }) },
  })), []);
});

test('a budget that admits nothing refuses; one that queues warns', () => {
  const admits = preflightPlan(facts([item()], {
    projects: { [A]: project({ maxConcurrentTasks: 0 }) },
  }));
  assert.deepEqual(admits.map((f) => [f.code, f.severity]), [['PLAN_BUDGET_ADMITS_NOTHING', 'REFUSE']]);
  const zeroBudget = preflightPlan(facts([item()], {
    projects: { [A]: project({ sessionBudgetPerDay: 0 }) },
  }));
  assert.deepEqual(zeroBudget.map((f) => f.code), ['PLAN_BUDGET_ADMITS_NOTHING']);

  const starting = Array.from({ length: 4 }, (_, index) => item({
    index,
    assigneeId: WORKSPACE,
    dependsOnTaskIds: [TASK_IN_A],
  }));
  const queued = preflightPlan(facts(starting, {
    projects: { [A]: project({ maxConcurrentTasks: 2, sessionBudgetPerDay: 1, memberWorkspaceIds: new Set([WORKSPACE]) }) },
  }));
  assert.deepEqual(queued.map((f) => [f.code, f.severity]), [
    ['PLAN_EXCEEDS_PROJECT_CONCURRENCY', 'WARN'],
    ['PLAN_EXCEEDS_SESSION_BUDGET', 'WARN'],
  ]);
  assert.deepEqual(planPreflightRefusals(queued), []);
});

test('a replayed winner is a fact, not a plan: named by others, judged by nothing', () => {
  const found = preflightPlan(facts([
    // Every one of these would be refused if it were being written.
    item({ index: 0, frozen: true, ref: 'done', projectId: B, parentTaskId: TASK_IN_A, dependsOnTaskIds: [TASK_IN_B] }),
    item({ index: 1, projectId: B, parentRef: 'done' }),
  ]));
  assert.deepEqual(found, [], 'a committed row is not re-earned against a world that has moved');
  // ...and it is still the thing a later item's ref resolves to.
  const crossing = preflightPlan(facts([
    item({ index: 0, frozen: true, ref: 'done', projectId: B }),
    item({ index: 1, projectId: A, parentRef: 'done' }),
  ]));
  assert.deepEqual(crossing.map((f) => f.code), ['PLAN_PARENT_CROSSES_PROJECT']);
});

test('every finding comes back, in a fixed order, and the body says nothing was written', () => {
  const plan = facts([
    item({ index: 0, parentTaskId: TASK_IN_B }),
    item({ index: 1, dependsOnTaskIds: [TASK_IN_B] }),
    item({ index: 2, acceptanceEpoch: '9', assigneeId: WORKSPACE }),
  ], { projects: { [A]: project({ acceptanceEpoch: '10' }), [B]: project() } });
  const once = preflightPlan(plan);
  const twice = preflightPlan(plan);
  assert.deepEqual(once, twice, 'two runs over one plan must produce one answer');
  assert.deepEqual(once.map((f) => `${f.index}:${f.code}`), [
    '0:PLAN_PARENT_CROSSES_PROJECT',
    '1:CROSS_PROJECT_APPROVAL_REQUIRED',
    '2:PLAN_ACCEPTANCE_EPOCH_MOVED',
    '2:PLAN_ASSIGNEE_NOT_ON_PROJECT_TEAM',
  ]);
  const body = planPreflightRefusalBody(once, plan);
  assert.equal(body.code, 'PLAN_PREFLIGHT_FAILED');
  assert.equal(body.written, 0);
  assert.equal(body.findings.length, 3, 'the body carries every refusal, and only refusals');
  assert.match(body.message, /3 checks/);
  // Unit L7: a refusal says where every item WOULD have landed, not only the broken ones. The
  // thing most often actually wrong with a refused plan is the items that were not refused.
  assert.equal(body.plan.length, 3);
  assert.deepEqual(body.plan.map((row) => row.projectTitle), ['a project', 'a project', 'a project']);
  assert.deepEqual(body.plan.map((row) => row.acceptanceEpoch), ['10', '10', '10']);
});

test('L7: a dry run reports what a refusal throws, plus the warnings a refusal leaves out', () => {
  const plan = facts([
    item({ index: 0, ref: 'db' }),
    item({ index: 1, assigneeId: WORKSPACE, autoRunWhenReady: true }),
  ], { projects: { [A]: project({ title: 'Alpha', maxConcurrentTasks: 1 }), [B]: project() } });
  const preview = planPreviewBody(preflightPlan(plan), plan);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.refused, false);
  assert.equal(preview.wouldWrite, 2);
  assert.deepEqual(preview.plan.map((row) => [row.index, row.ref, row.projectTitle]), [
    [0, 'db', 'Alpha'],
    [1, null, 'Alpha'],
  ]);
  assert.ok(
    preview.findings.some((finding) => finding.severity === 'WARN'),
    'a preview is read to decide, so the warnings a refusal body drops belong in it',
  );
});

test('L7: a refused plan would write nothing, not "the items that were fine"', () => {
  const plan = facts([
    item({ index: 0, parentTaskId: TASK_IN_B }),
    item({ index: 1 }),
  ]);
  const preview = planPreviewBody(preflightPlan(plan), plan);
  assert.equal(preview.refused, true);
  assert.equal(preview.wouldWrite, 0);
  assert.equal(preview.plan.length, 2, 'every item is still shown, refused or not');
});

test('L7: an item already committed by an earlier attempt is shown as frozen, not as a write', () => {
  const plan = facts([item({ index: 0, frozen: true }), item({ index: 1 })]);
  const preview = planPreviewBody(preflightPlan(plan), plan);
  assert.deepEqual(preview.plan.map((row) => row.frozen), [true, false]);
  assert.equal(preview.wouldWrite, 1, 'a replayed row is not a row this call would add');
});

test('L7: an item landing under a project nothing could be read for still gets a row', () => {
  const plan = facts([item({ index: 0, projectId: null }), item({ index: 1 })], {
    projects: { [B]: project() },
  });
  const landings = planItemLandings(plan);
  assert.equal(landings.length, 2);
  assert.deepEqual(landings[0], {
    index: 0, ref: null, projectId: null, projectTitle: null, projectStatus: null,
    acceptanceEpoch: null, frozen: false,
  });
  assert.equal(landings[1].projectId, A, 'the id is reported even when the project is unreadable');
  assert.equal(landings[1].projectTitle, null);
});
