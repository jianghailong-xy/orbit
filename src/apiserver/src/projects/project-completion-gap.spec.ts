/**
 * §13.1 AG7 / §13.2 V8 — the completion gap, from the pure recomputation up to the blocker face
 * and the filing proposal.
 *
 * The shape under test is the one H0's own verification found: AG6 says only aggregation may
 * complete an aggregate parent, and aggregation cannot always answer. Every test here is either a
 * world where that is true and somebody has to be told, or a neighbouring world where it is NOT
 * true and the loop must stay quiet.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  AggregationTaskFact,
  planTaskAggregation,
  verificationSubjectReady,
} from './task-aggregation';
import {
  ProjectDecisionInput,
  hashDecisionInput,
  planProjectDecision,
} from './project-decision.service';
import {
  COMPLETION_GAP_FILING_MAX_REFUSALS,
  completionGapDisposition,
  filingHistory,
  planCompletionGaps,
} from './project-completion-gap';
import { PROJECT_BLOCKER_POLICY, planProjectBlockers } from './project-blocker';
import { implementerAgentIds } from './project-completion-gap';
import { selectDispatchableTasks } from './project-dispatch-pass';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number): string => uuidToBase62(uuid(n));

const PROJECT = id(1);
const OWNER = id(2);
const PARENT = id(10);
const CHILD_A = id(11);
const CHILD_B = id(12);
const VERIFIER = id(13);
const COORDINATOR_AGENT = id(20);
const WORKER_AGENT = id(21);
const RUNNER = id(30);

// ── the pure half ───────────────────────────────────────────────────────────────────────────────

function task(over: Partial<AggregationTaskFact> & { id: string }): AggregationTaskFact {
  return {
    status: 'OPEN',
    parentTaskId: null,
    completionPolicy: 'MANUAL',
    verifiesTaskId: null,
    verdict: null,
    ...over,
  };
}

const rollup = (over: Partial<AggregationTaskFact> = {}): AggregationTaskFact =>
  task({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE', ...over });

test('AG7: every child cancelled is a gap, not a completion and not a silence', () => {
  const plan = planTaskAggregation([
    rollup(),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  assert.deepEqual(plan.aggregations, [], 'a roll-up with no finished child may not be completed');
  assert.equal(plan.completionGaps.length, 1);
  assert.equal(plan.completionGaps[0].reason, 'NO_CHILD_CAN_COMPLETE');
  assert.equal(plan.completionGaps[0].status, 'OPEN');
  assert.deepEqual(plan.completionGaps[0].evidence.children,
    { total: 2, done: 0, cancelled: 2, outstanding: 0, unresolvable: 0 });
});

test('AG7: one DONE child is enough, so the ordinary roll-up still completes and reports nothing', () => {
  const plan = planTaskAggregation([
    rollup(),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
  assert.equal(plan.aggregations[0]?.to, 'DONE');
});

test('AG6-d + AG7: the FAILED recovery lands on OPEN and says so in the same plan', () => {
  const plan = planTaskAggregation([
    rollup({ status: 'FAILED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  // The write that H0 added, and the row that stops it being a move into silence.
  assert.deepEqual(
    plan.aggregations.map((a) => [a.from, a.to, a.reason]),
    [['FAILED', 'OPEN', 'CHILDREN_OUTSTANDING']],
  );
  assert.equal(plan.completionGaps[0]?.reason, 'NO_CHILD_CAN_COMPLETE');
  assert.equal(plan.completionGaps[0]?.status, 'FAILED');
});

test('AG7: a DONE roll-up is reopened first and reported next pass, never both at once', () => {
  const plan = planTaskAggregation([
    rollup({ status: 'DONE' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  assert.equal(plan.aggregations[0]?.to, 'OPEN');
  assert.deepEqual(plan.completionGaps, [], 'a task about to change status is not stuck on it');
});

test('AG7: a CANCELLED roll-up is somebody\'s decision, so nobody is asked for anything', () => {
  const plan = planTaskAggregation([
    rollup({ status: 'CANCELLED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

test('AG7: VERIFICATION_PASSED with its children in and no check filed is the second shape', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
  ]);
  assert.deepEqual(plan.aggregations, []);
  assert.equal(plan.completionGaps[0]?.reason, 'NO_VERIFICATION_FILED');
});

test('AG7: a check that exists and has not concluded is an ordinary wait, not a gap', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: VERIFIER, verifiesTaskId: PARENT, status: 'OPEN' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

test('AG7: children still moving means the verification clause is not asked yet', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'OPEN' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

// ── the supersession clause, which is where the order is the rule ────────────────────────────────

const replaced = (over: Partial<AggregationTaskFact> & { id: string }): AggregationTaskFact =>
  task({ parentTaskId: PARENT, supersededByTaskId: id(99), retirement: 'SUPERSEDED', ...over });

test('AG7: a retired CANCELLED child whose successor left the subtree is NOT settled', () => {
  // The order this test exists for: `status === 'CANCELLED'` used to be tested before the
  // supersession clause, and SU4 preserves a replaced attempt by CANCELLING it — so the fail-closed
  // rule never ran for the shape it was written for, and the parent completed over work that had
  // moved out from under it.
  const plan = planTaskAggregation([
    rollup(),
    replaced({ id: CHILD_A, status: 'CANCELLED' }),
    task({ id: id(99), parentTaskId: null, status: 'OPEN' }),
  ]);
  assert.deepEqual(plan.aggregations, [], 'the parent must not complete over work that left');
  assert.equal(plan.completionGaps[0]?.reason, 'SUCCESSOR_OUTSIDE_SUBTREE');
  assert.equal(plan.completionGaps[0]?.evidence.children.unresolvable, 1);
});

test('AG7: the same holds for a retired FAILED child', () => {
  const plan = planTaskAggregation([
    rollup(),
    replaced({ id: CHILD_A, status: 'FAILED' }),
    task({ id: id(99), parentTaskId: null, status: 'OPEN' }),
  ]);
  assert.equal(plan.completionGaps[0]?.reason, 'SUCCESSOR_OUTSIDE_SUBTREE');
});

test('AG7: a DONE sibling does not let the roll-up aggregate over the stranded one', () => {
  const plan = planTaskAggregation([
    rollup(),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'DONE' }),
    replaced({ id: CHILD_A, status: 'CANCELLED' }),
    task({ id: id(99), parentTaskId: null, status: 'OPEN' }),
  ]);
  assert.deepEqual(plan.aggregations, []);
  assert.equal(plan.completionGaps[0]?.reason, 'SUCCESSOR_OUTSIDE_SUBTREE');
  assert.deepEqual(plan.completionGaps[0]?.evidence.children,
    { total: 2, done: 1, cancelled: 0, outstanding: 1, unresolvable: 1 });
});

test('AG7: ABANDONED with no successor does NOT settle — it is counted and never finishable', () => {
  // The fail-closed direction, and the one a reader is most likely to want to relax. "It stopped"
  // is not "the parent's condition is satisfied": AG1 needs a DONE and an abandoned attempt supplies
  // none, while §13.6 SU6 guarantees nothing will ever dispatch it again. Reading it as settled
  // would complete a roll-up over work somebody explicitly dropped.
  const plan = planTaskAggregation([
    rollup(),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'DONE' }),
    task({
      id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED',
      supersededByTaskId: null, retirement: 'ABANDONED',
    }),
  ]);
  assert.deepEqual(plan.aggregations, [], 'a roll-up may not complete over an abandoned subtask');
  assert.equal(plan.completionGaps[0]?.reason, 'SUCCESSOR_OUTSIDE_SUBTREE');
  assert.equal(plan.completionGaps[0]?.evidence.children.unresolvable, 1);
});

test('AG7: SUPERSEDED whose successor was deleted is the same shape', () => {
  // 0128's FK is ON DELETE SET NULL, so a deleted successor leaves a retirement pointing nowhere.
  const plan = planTaskAggregation([
    rollup(),
    task({
      id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED',
      supersededByTaskId: null, retirement: 'SUPERSEDED',
    }),
  ]);
  assert.equal(plan.completionGaps[0]?.reason, 'SUCCESSOR_OUTSIDE_SUBTREE');
});

test('AG7: the required action for that row names every exit, not just re-parenting', () => {
  const action = PROJECT_BLOCKER_POLICY.SUCCESSOR_OUTSIDE_SUBTREE.requiredAction;
  assert.match(action, /re-parent/i, 'the successor can be brought back under this task');
  assert.match(action, /clear/i, 'or the retirement can be cleared so the row is a child again');
  assert.match(action, /remove/i, 'or the subtask can be removed');
});

test('AG7: a successor that IS a sibling settles, and the parent completes on the successor', () => {
  const plan = planTaskAggregation([
    rollup(),
    replaced({ id: CHILD_A, status: 'CANCELLED', supersededByTaskId: CHILD_B }),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'DONE' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
  assert.equal(plan.aggregations[0]?.to, 'DONE');
});

test('AG7: one live child is enough to make it an ordinary wait', () => {
  const plan = planTaskAggregation([
    rollup(),
    replaced({ id: CHILD_A, status: 'FAILED' }),
    task({ id: CHILD_B, parentTaskId: PARENT, status: 'OPEN' }),
    task({ id: id(99), parentTaskId: null, status: 'OPEN' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

test('AG2: a cycle answers with the cycle and does not also invent gaps for its members', () => {
  const plan = planTaskAggregation([
    task({ id: PARENT, parentTaskId: CHILD_A, completionPolicy: 'ALL_CHILDREN_DONE' }),
    task({ id: CHILD_A, parentTaskId: PARENT, completionPolicy: 'ALL_CHILDREN_DONE' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
  assert.equal(plan.cycleTaskIds.length, 2);
});

// ── AG8, the other end of the same deadlock ─────────────────────────────────────────────────────

test('AG8: a VERIFICATION_PASSED roll-up with its children in is ready to be checked', () => {
  assert.equal(verificationSubjectReady({
    status: 'OPEN',
    completionPolicy: 'VERIFICATION_PASSED',
    hasDirectChildren: true,
    childrenDone: 1,
    childrenOutstanding: 0,
  }), true);
});

test('AG8: the exception is exactly as narrow as the deadlock', () => {
  const base = {
    status: 'OPEN' as const,
    completionPolicy: 'VERIFICATION_PASSED' as const,
    hasDirectChildren: true,
    childrenDone: 1,
    childrenOutstanding: 0,
  };
  // An ordinary task still has to be DONE — nothing about it is circular.
  assert.equal(verificationSubjectReady({ ...base, completionPolicy: 'MANUAL' }), false);
  // ALL_CHILDREN_DONE has no loop: the children complete it, and then it is DONE like any other.
  assert.equal(verificationSubjectReady({ ...base, completionPolicy: 'ALL_CHILDREN_DONE' }), false);
  // A childless policy is inert (AG4), so the task is an ordinary leaf.
  assert.equal(verificationSubjectReady({ ...base, hasDirectChildren: false }), false);
  // A moving target is what precondition 3 exists to stop.
  assert.equal(verificationSubjectReady({ ...base, childrenOutstanding: 1 }), false);
  assert.equal(verificationSubjectReady({ ...base, childrenDone: 0 }), false);
  // And a settled subject is not waiting on anything.
  assert.equal(verificationSubjectReady({ ...base, status: 'CANCELLED' }), false);
  assert.equal(verificationSubjectReady({ ...base, status: 'FAILED' }), false);
  assert.equal(verificationSubjectReady({ ...base, status: 'DONE' }), true);
});

// ── the decision half: which gaps the loop closes, and which it hands over ──────────────────────

interface WorldOver {
  tasks?: ProjectDecisionInput['world']['tasks'];
  sessions?: ProjectDecisionInput['world']['sessions'];
  team?: ProjectDecisionInput['world']['team'];
  actions?: ProjectDecisionInput['world']['actions'];
  workspaces?: ProjectDecisionInput['world']['workspaces'];
  runners?: ProjectDecisionInput['world']['runners'];
  providers?: ProjectDecisionInput['world']['providers'];
  automationPolicy?: string;
  protocol?: { completionGaps: true };
}

function member(agentId: string, over: Partial<ProjectDecisionInput['world']['team'][number]> = {}) {
  return {
    projectMemberId: id(40), agentId, role: 'MEMBER', enabled: true, deletedAt: null,
    runnerId: RUNNER, model: 'claude-opus-5', effort: null,
    // The engine is the AGENT's explicit configuration, never inherited from the subject.
    providerFallbacks: [{ provider: 'claude', model: null }],
    canCreateTasks: true, canDelegate: true, maxConcurrentTasks: null,
    ...over,
  };
}

/**
 * A runner catalog in the shape production actually stores.
 *
 * `{ value, label }`, which is what the heartbeat writes and what `runtimeCatalogModels` reads. A
 * fixture that used `{ id }` — or `null` — would let a reader that guesses at the field name pass
 * here and call every real catalog empty.
 */
const CATALOG = {
  claude: [
    { value: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000 },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
  codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
};

function runner(over: Partial<ProjectDecisionInput['world']['runners'][number]> = {}) {
  return {
    runnerId: RUNNER, status: 'ONLINE', labels: [], version: '1',
    lastHeartbeatAt: '2026-08-20T00:00:00.000Z', modelCatalog: CATALOG, capabilities: [],
    capabilitiesReportedAt: '2026-08-20T00:00:00.000Z', engines: null, runsAsRoot: false,
    ...over,
  };
}

function workspace(workspaceId: string, over = {}) {
  return {
    workspaceId, runnerId: RUNNER, enabled: true, deletedAt: null, model: null, effort: null,
    defaultMergeTarget: null, workDirExists: true, workDirIsGit: true, workDirProbedAt: null,
    ...over,
  };
}

function taskRow(
  over: Partial<ProjectDecisionInput['world']['tasks'][number]> & { id: string },
): ProjectDecisionInput['world']['tasks'][number] {
  return {
    title: 'work', contentHash: 'a'.repeat(64), status: 'OPEN', parentTaskId: null,
    assigneeAgentId: null, provider: 'claude', model: 'claude-opus-5', autoRunWhenReady: false,
    dispatchHold: false, dispatchAuthority: 'COORDINATOR', dispatchAttempt: '0',
    requiredCapabilities: [], runAt: null, verifiesTaskId: null, completionPolicy: 'MANUAL',
    verdict: null, verdictRevision: '0', dependsOnTaskIds: [], liveSessionIds: [],
    failureCount: 0, lastFailureAt: null, failureAttributable: true, retryBackoffUntil: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

/** A world in the shape V8 is meant to act on: a `VERIFICATION_PASSED` roll-up, its children in. */
function world(over: WorldOver = {}): ProjectDecisionInput {
  const w: ProjectDecisionInput['world'] = {
    project: {
      id: PROJECT, ownerId: OWNER, title: 'ship', goal: null, acceptanceCriteria: null,
      status: 'OPEN', coordinatorEnabled: true,
      automationPolicy: over.automationPolicy ?? 'AUTO',
      maxConcurrentTasks: 3, sessionBudgetPerDay: null, configRevision: '7',
      coordinatorAgentId: COORDINATOR_AGENT, coordinatorSessionId: null,
      coordinatorWorkspaceId: null,
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '4', coordinatorGeneration: '1',
      nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: over.team ?? [
      member(COORDINATOR_AGENT, { role: 'COORDINATOR' }),
      member(WORKER_AGENT),
    ],
    tasks: over.tasks ?? [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
      }),
      taskRow({
        id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: WORKER_AGENT,
      }),
    ],
    sessions: over.sessions ?? [], coordinatorSession: null,
    workspaces: over.workspaces ?? [workspace(COORDINATOR_AGENT), workspace(WORKER_AGENT)],
    runners: over.runners ?? [runner()],
    providers: over.providers ?? [{
      providerId: null, slug: 'claude', runtime: 'claude', enabled: true, models: [],
      defaultModel: 'claude-opus-5', scope: 'BUILTIN',
    }],
    actions: over.actions ?? [],
    blockers: [],
    protocol: 'protocol' in over ? over.protocol : { completionGaps: true },
    evidence: { branches: [], tests: [] },
  };
  const evaluation = { epoch: Date.parse('2026-08-22T00:00:00.000Z') / 1_000, dueTasks: {} };
  const signals: ProjectDecisionInput['signals'] = [];
  return {
    v: 1,
    readAt: '2026-08-22T00:00:00.000Z',
    decisionInputHash: hashDecisionInput({ world: w, evaluation, signals }),
    world: w,
    evaluation,
    signals,
  };
}

const gapsOf = (input: ProjectDecisionInput) =>
  planTaskAggregation(input.world.tasks.map((t) => ({
    id: t.id,
    status: t.status as 'OPEN',
    parentTaskId: t.parentTaskId,
    completionPolicy: (t.completionPolicy ?? 'MANUAL') as 'MANUAL',
    verifiesTaskId: t.verifiesTaskId,
    verdict: null,
    supersededByTaskId: t.supersededByTaskId ?? null,
  }))).completionGaps;

test('V8: one independent, ready agent makes the missing check the loop\'s own job', () => {
  const input = world();
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.conditions, [], 'nothing to ask a person while the loop can act');
  assert.equal(plan.filings.length, 1);
  const filing = plan.filings[0];
  assert.equal(filing.subjectTaskId, PARENT);
  assert.equal(filing.verifierAgentId, COORDINATOR_AGENT);
  assert.equal(filing.workspaceId, COORDINATOR_AGENT);
  assert.equal(filing.runnerId, RUNNER);
  assert.equal(filing.parentTaskId, null);
  assert.equal(filing.configRevision, '7');
  assert.equal(filing.generation, '1');
  // The engine is the VERIFIER's, resolved through the runner's own catalog — and it is asserted
  // against the verification plan rather than against the development task, which is the whole
  // point of not inheriting: the subject here runs `claude-sonnet-5` and the check does not.
  assert.equal(filing.provider, 'claude');
  assert.equal(filing.model, 'claude-opus-5');
  assert.equal(filing.providerId, null);
  assert.equal(filing.runtime, 'claude');
  assert.equal(filing.providerScope, 'BUILTIN');
  assert.equal(filing.authorization.result.decision, 'ALLOW');
  assert.equal(filing.authorization.result.policyRow, 'COORDINATOR_ROUTINE');
});

test('V8-a: the agents that DID the work are not independent of it — including the subtasks\'', () => {
  // The coordinator is the only other member, and here it ran the subtask. Excluding it on the
  // FACT rather than on the title is the whole clause: a roll-up's own assignee often ran nothing.
  const input = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT }),
      taskRow({
        id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: COORDINATOR_AGENT,
      }),
    ],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal(plan.conditions[0]?.kind, 'VERIFICATION_REQUIRED');
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_INDEPENDENT_AGENT');
});

test('V8: the check does not inherit the engine the WORK ran on', () => {
  const input = world({
    tasks: [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
        provider: 'codex', model: 'gpt-5.6-sol',
      }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: WORKER_AGENT }),
    ],
  });
  const filing = planCompletionGaps(input, gapsOf(input)).filings[0];
  assert.equal(filing.provider, 'claude', 'the verifier\'s configuration decides, not the subject');
  assert.equal(filing.model, 'claude-opus-5');
});

test('V8: a model the runner does not serve is not a runnable combination', () => {
  const input = world({
    team: [
      member(COORDINATOR_AGENT, {
        role: 'COORDINATOR', providerFallbacks: [{ provider: 'claude', model: 'claude-gone-6' }],
      }),
      member(WORKER_AGENT),
    ],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION');
});

test('V8: a bare string catalog is not the canonical shape, and is read fail-closed', () => {
  // `runtimeCatalogModels` is the one parser for this column and it requires `{ value }` — which
  // is what the heartbeat writes. A list of bare strings is a shape nothing produces, so accepting
  // it here would be this module inventing a second catalog dialect that the dispatcher, the
  // picker and the effort normaliser do not share.
  const input = world({ runners: [runner({ modelCatalog: { claude: ['claude-opus-5'] } })] });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION');
});

test('V8: an empty or missing catalog is fail-closed, never an assumed model', () => {
  for (const modelCatalog of [null, {}, { claude: [] }, { codex: [{ value: 'gpt-5.6-sol' }] }]) {
    const input = world({ runners: [runner({ modelCatalog })] });
    const plan = planCompletionGaps(input, gapsOf(input));
    assert.deepEqual(plan.filings, [], JSON.stringify(modelCatalog));
    assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
      .filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION', JSON.stringify(modelCatalog));
  }
});

test('V8: an agent with no configured fallback has no engine to be given one', () => {
  const input = world({
    team: [
      member(COORDINATOR_AGENT, { role: 'COORDINATOR', providerFallbacks: [] }),
      member(WORKER_AGENT),
    ],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION');
});

test('V8: two runnable engines on one agent is as ambiguous as two agents', () => {
  const input = world({
    team: [
      member(COORDINATOR_AGENT, {
        role: 'COORDINATOR',
        providerFallbacks: [
          { provider: 'claude', model: 'claude-opus-5' },
          { provider: 'claude', model: 'claude-sonnet-5' },
        ],
      }),
      member(WORKER_AGENT),
    ],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'AMBIGUOUS_VERIFIER_ASSIGNMENT');
});

test('V8-a: two candidates is a question, not a coin flip', () => {
  const third = id(22);
  const input = world({
    team: [
      member(COORDINATOR_AGENT, { role: 'COORDINATOR' }),
      member(WORKER_AGENT),
      member(third),
    ],
    workspaces: [workspace(COORDINATOR_AGENT), workspace(WORKER_AGENT), workspace(third)],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'AMBIGUOUS_VERIFIER_ASSIGNMENT');
});

test('V8-a: a runner that is not ONLINE is not a determinable WHERE', () => {
  const input = world({
    runners: [{
      runnerId: RUNNER, status: 'OFFLINE', labels: [], version: '1', lastHeartbeatAt: null,
      modelCatalog: null, capabilities: [], capabilitiesReportedAt: '2026-08-20T00:00:00.000Z',
      engines: null, runsAsRoot: false,
    }],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_INDEPENDENT_AGENT');
});

test('V8-a: a runner that never reported its capabilities is the same answer', () => {
  const input = world({
    runners: [{
      runnerId: RUNNER, status: 'ONLINE', labels: [], version: '1', lastHeartbeatAt: null,
      modelCatalog: null, capabilities: [], capabilitiesReportedAt: null,
      engines: null, runsAsRoot: false,
    }],
  });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_INDEPENDENT_AGENT');
});

test('V8: a provider this project cannot see is not a runnable combination', () => {
  const input = world({ providers: [] });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION');
});

test('V8: a disabled provider is not available just because an agent names it', () => {
  const input = world({
    providers: [{
      providerId: null, slug: 'claude', runtime: 'claude', enabled: false, models: [],
      defaultModel: 'claude-opus-5', scope: 'BUILTIN',
    }],
  });
  assert.equal((planCompletionGaps(input, gapsOf(input)).conditions[0]?.detail as
    { filingRefusedBecause: string }).filingRefusedBecause, 'NO_RUNNABLE_VERIFIER_COMBINATION');
});

test('V8: a configured provider carries its row id, runtime and scope into the plan', () => {
  const input = world({
    team: [
      member(COORDINATOR_AGENT, {
        role: 'COORDINATOR', providerFallbacks: [{ provider: 'deepseek', model: 'claude-opus-5' }],
      }),
      member(WORKER_AGENT),
    ],
    providers: [{
      providerId: id(80), slug: 'deepseek', runtime: 'claude', enabled: true, models: [],
      defaultModel: null, scope: 'PROJECT_OWNER',
    }],
  });
  const filing = planCompletionGaps(input, gapsOf(input)).filings[0];
  assert.equal(filing.provider, 'deepseek');
  assert.equal(filing.providerId, id(80));
  // Borrowed runtime: the catalog is reported under `claude`, which is what the check is asked in.
  assert.equal(filing.runtime, 'claude');
  assert.equal(filing.providerScope, 'PROJECT_OWNER');
});

test('V8: a MANUAL project does not get its verification filed for it', () => {
  const input = world({ automationPolicy: 'MANUAL' });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'POLICY_REQUIRES_APPROVAL');
});

test('V8: a coordinator that may not create tasks or delegate may not file one', () => {
  for (const permission of ['canCreateTasks', 'canDelegate'] as const) {
    const input = world({
      team: [
        member(COORDINATOR_AGENT, { role: 'COORDINATOR', [permission]: false }),
        member(WORKER_AGENT),
      ],
    });
    const plan = planCompletionGaps(input, gapsOf(input));
    assert.deepEqual(plan.filings, [], permission);
    assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
      .filingRefusedBecause, 'COORDINATOR_CANNOT_FILE', permission);
  }
});

test('AG7: the two shapes the loop can never file for go straight to a person', () => {
  const cancelled = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE' }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
    ],
  });
  const plan = planCompletionGaps(cancelled, gapsOf(cancelled));
  assert.deepEqual(plan.filings, []);
  assert.equal(plan.conditions[0]?.kind, 'AGGREGATE_PARENT_UNSATISFIABLE');
  assert.equal(plan.conditions[0]?.subjectType, 'TASK');
  assert.equal(plan.conditions[0]?.subjectId, PARENT);
});

// ── V8-e: the generation ────────────────────────────────────────────────────────────────────────

function filingAction(status: string, at: string) {
  return {
    actionId: id(50), type: 'FILE_VERIFICATION_TASK', status, subjectType: 'TASK',
    subjectId: PARENT, decisionId: null, resultSessionId: null, refusalCode: null,
    idempotencyKeyHash: 'x'.repeat(64), detailHash: 'y'.repeat(64), createdAt: at,
  };
}

test('V8-e: the generation is the ledger row count, so a replay of one world proposes one key', () => {
  const input = world();
  const first = planCompletionGaps(input, gapsOf(input)).filings[0];
  const again = planCompletionGaps(input, gapsOf(input)).filings[0];
  assert.equal(first.generation, '1');
  assert.deepEqual(first, again, 'the same snapshot must propose the same key, every time');
});

test('V8-e: a refusal that filed nothing advances the generation, so the gap can be retried', () => {
  const input = world({ actions: [filingAction('REFUSED', '2026-08-22T00:00:01.000Z')] });
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings[0].generation, '2');
});

test('V8-e: a landed filing that later went away advances it too', () => {
  const input = world({ actions: [filingAction('APPLIED', '2026-08-22T00:00:01.000Z')] });
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings[0].generation, '2');
});

test('V8-e: SUPERSEDED counts against the bound, or the mint is unbounded', () => {
  // The failure this exists for: an effect that keeps finding the world moved would otherwise mint
  // a brand-new generation on every pass, for ever, and never open a row saying so.
  const actions = Array.from({ length: COMPLETION_GAP_FILING_MAX_REFUSALS }, (_, i) =>
    filingAction('SUPERSEDED', `2026-08-22T00:00:0${i + 1}.000Z`));
  const input = world({ actions });
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, []);
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'FILING_REFUSALS_EXHAUSTED');
});

test('V8-e: a landing in the middle resets the run, so a healthy project never exhausts', () => {
  const input = world({
    actions: [
      filingAction('REFUSED', '2026-08-22T00:00:01.000Z'),
      filingAction('REFUSED', '2026-08-22T00:00:02.000Z'),
      filingAction('APPLIED', '2026-08-22T00:00:03.000Z'),
      filingAction('REFUSED', '2026-08-22T00:00:04.000Z'),
    ],
  });
  assert.equal(filingHistory(input, PARENT).consecutiveRefusals, 1);
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings[0].generation, '5');
});

test('V8-e: another subject\'s attempts are not this one\'s', () => {
  const other = { ...filingAction('REFUSED', '2026-08-22T00:00:01.000Z'), subjectId: CHILD_A };
  const input = world({ actions: [other] });
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings[0].generation, '1');
});

// ── the blocker face, and its idempotence ───────────────────────────────────────────────────────

test('AG7-d: two reconciles of one world raise one row, and the second only touches it', () => {
  const cancelled = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE' }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
    ],
  });
  const observed = planCompletionGaps(cancelled, gapsOf(cancelled)).conditions;
  const epoch = cancelled.evaluation.epoch;
  const first = planProjectBlockers({ epoch, open: [], observed });
  assert.equal(first.raises.length, 1);
  assert.equal(first.raises[0].dedupeKey, `AGGREGATE_PARENT_UNSATISFIABLE:TASK:${PARENT}`);
  assert.equal(first.raises[0].owner, 'USER');
  assert.equal(first.raises[0].recovery, 'HUMAN');
  assert.ok(first.raises[0].requiredAction.endsWith('.'));
  assert.ok(Date.parse(first.raises[0].nextCheckAt) > epoch * 1_000);

  const open = [{
    id: id(60), kind: first.raises[0].kind, owner: first.raises[0].owner,
    recovery: first.raises[0].recovery, severity: first.raises[0].severity,
    requiredAction: first.raises[0].requiredAction, subjectType: 'TASK' as const,
    subjectId: PARENT, dedupeKey: first.raises[0].dedupeKey, lifecycleGeneration: '1',
    conditionVersion: first.raises[0].conditionVersion,
    firstSeenAt: first.raises[0].firstSeenAt, lastSeenAt: first.raises[0].firstSeenAt,
    occurrences: 1, nextCheckAt: first.raises[0].nextCheckAt, escalatedAt: null,
  }];
  const second = planProjectBlockers({ epoch, open, observed });
  assert.deepEqual(second.raises, [], 'the same condition twice is one episode');
  assert.equal(second.touches.length, 1);
  assert.deepEqual(second.clears, []);
});

test('AG7-d: neither kind opens a coordinator turn', () => {
  for (const kind of [
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
  ] as const) {
    assert.equal(PROJECT_BLOCKER_POLICY[kind].opensTurn, false, kind);
    assert.equal(PROJECT_BLOCKER_POLICY[kind].owner, 'USER', kind);
  }
});

test('BL3: a kind this build does not know is never auto-cleared, and still stops its task', () => {
  // The mixed-version half only the OLDER replica can perform. It has no detector for a kind a
  // newer one raised, and "I did not observe it" must not be spelled "it is over".
  const open = [{
    id: id(61), kind: 'A_KIND_FROM_THE_FUTURE' as never, owner: 'USER' as const,
    recovery: 'HUMAN' as const, severity: 'CRITICAL' as const,
    requiredAction: 'Ask a newer replica.', subjectType: 'TASK' as const, subjectId: PARENT,
    dedupeKey: `A_KIND_FROM_THE_FUTURE:TASK:${PARENT}`, lifecycleGeneration: '1',
    conditionVersion: 'c'.repeat(64), firstSeenAt: '2026-08-22T00:00:00.000Z',
    lastSeenAt: '2026-08-22T00:00:00.000Z', occurrences: 1,
    nextCheckAt: '2026-08-22T01:00:00.000Z', escalatedAt: null,
  }];
  const plan = planProjectBlockers({
    epoch: Date.parse('2026-08-22T00:00:00.000Z') / 1_000, open, observed: [],
  });
  assert.deepEqual(plan.clears, [], 'silence about a kind you cannot evaluate is ignorance');
  assert.equal(plan.openAfter.length, 1);
  assert.equal(plan.openAfter[0].subjectId, PARENT);
});

test('BL3: a kind this build DOES know is still cleared the moment its condition ends', () => {
  const open = [{
    id: id(62), kind: 'AGGREGATE_PARENT_UNSATISFIABLE' as const, owner: 'USER' as const,
    recovery: 'HUMAN' as const, severity: 'CRITICAL' as const,
    requiredAction: PROJECT_BLOCKER_POLICY.AGGREGATE_PARENT_UNSATISFIABLE.requiredAction,
    subjectType: 'TASK' as const, subjectId: PARENT,
    dedupeKey: `AGGREGATE_PARENT_UNSATISFIABLE:TASK:${PARENT}`, lifecycleGeneration: '1',
    conditionVersion: 'c'.repeat(64), firstSeenAt: '2026-08-22T00:00:00.000Z',
    lastSeenAt: '2026-08-22T00:00:00.000Z', occurrences: 1,
    nextCheckAt: '2026-08-22T01:00:00.000Z', escalatedAt: null,
  }];
  const plan = planProjectBlockers({
    epoch: Date.parse('2026-08-22T00:00:00.000Z') / 1_000, open, observed: [],
  });
  assert.equal(plan.clears.length, 1);
  assert.deepEqual(plan.openAfter, []);
});

// ── the protocol marker ─────────────────────────────────────────────────────────────────────────

test('AG7: a snapshot captured before this build replays to what its own binary decided', () => {
  const cancelled = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE' }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'CANCELLED' }),
    ],
  });
  const old = { ...cancelled.world };
  delete (old as { protocol?: unknown }).protocol;
  const before: ProjectDecisionInput = {
    ...cancelled,
    world: old,
    decisionInputHash: hashDecisionInput({
      world: old, evaluation: cancelled.evaluation, signals: cancelled.signals,
    }),
  };
  const outcome = planProjectDecision(before, { decisionId: uuid(70) });
  assert.deepEqual(outcome.blockersOpened, [], 'an old decision may not grow a blocker on replay');
  const now = planProjectDecision(cancelled, { decisionId: uuid(70) });
  assert.deepEqual(now.blockersOpened, [`AGGREGATE_PARENT_UNSATISFIABLE:TASK:${PARENT}`]);
});

test('AG7: the marked snapshot still replays to itself, byte for byte', () => {
  const marked = world();
  const outcome = planProjectDecision(marked, { decisionId: uuid(71) });
  const replayed = planProjectDecision(marked, {
    decisionId: uuid(71),
    decidedBy: outcome.decidedBy,
    consumedEventIds: outcome.consumedEventIds,
    actions: outcome.actions,
    authorizations: outcome.authorizations,
  });
  assert.deepEqual(replayed, outcome);
});

test('V8: an unmarked snapshot proposes no filing either', () => {
  const marked = world();
  const old = { ...marked.world };
  delete (old as { protocol?: unknown }).protocol;
  const before: ProjectDecisionInput = {
    ...marked,
    world: old,
    decisionInputHash: hashDecisionInput({
      world: old, evaluation: marked.evaluation, signals: marked.signals,
    }),
  };
  assert.deepEqual(completionGapDisposition(before, {
    taskId: PARENT, status: 'OPEN', policy: 'VERIFICATION_PASSED', reason: 'NO_VERIFICATION_FILED',
    evidence: {
      children: { total: 1, done: 1, cancelled: 0, outstanding: 0, unresolvable: 0 },
      verifications: { total: 0, passed: 0, outstanding: 0, unconcludable: 0 },
    },
  }).action, 'FILE_VERIFICATION', 'the disposition itself is unconditional…');
  // …and the gate is on the PLAN, which is the one place both consumers go through.
  assert.deepEqual(planProjectDecision(before, { decisionId: uuid(72) }).blockersOpened, []);
});

// ── V8-a's independence, over the whole subtree and its history ─────────────────────────────────

const GRANDCHILD = id(14);
const OTHER_AGENT = id(23);

function session(over: Partial<ProjectDecisionInput['world']['sessions'][number]> = {}) {
  return {
    id: id(90), taskId: CHILD_A, workspaceId: WORKER_AGENT, assignedRunnerId: RUNNER,
    runStatus: 'SUCCEEDED', provider: 'claude', model: 'claude-opus-5', permissionMode: null,
    effort: null, createdAt: '2026-08-21T00:00:00.000Z', startedAt: '2026-08-21T00:00:00.000Z',
    finishedAt: '2026-08-21T01:00:00.000Z', completedAt: '2026-08-21T01:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

test('V8-a: a grandchild\'s assignee did the work too', () => {
  const input = world({
    tasks: [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
      }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: null }),
      taskRow({
        id: GRANDCHILD, parentTaskId: CHILD_A, status: 'DONE',
        assigneeAgentId: COORDINATOR_AGENT,
      }),
    ],
  });
  assert.equal(implementerAgentIds(input, PARENT).has(COORDINATOR_AGENT), true);
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, [], 'the author two levels down may not check their own work');
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_INDEPENDENT_AGENT');
});

test('V8-a: stopping at depth one would have handed the check straight back', () => {
  // The control for the test above: with the grandchild gone, the coordinator IS eligible. So the
  // refusal above is caused by the recursion and by nothing else.
  const input = world({
    tasks: [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
      }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: null }),
    ],
  });
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings[0]?.verifierAgentId,
    COORDINATOR_AGENT);
});

test('V8-a: re-assigning a finished subtask does not make its author eligible again', () => {
  // The pointer moved; the history did not. This is the shape the Session source exists for.
  const input = world({
    tasks: [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
      }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: OTHER_AGENT }),
    ],
    sessions: [session({ workspaceId: COORDINATOR_AGENT })],
  });
  assert.deepEqual([...implementerAgentIds(input, PARENT)].sort(),
    [COORDINATOR_AGENT, OTHER_AGENT, WORKER_AGENT].sort());
  const plan = planCompletionGaps(input, gapsOf(input));
  assert.deepEqual(plan.filings, [], 'the agent that ran it is still the agent that ran it');
  assert.equal((plan.conditions[0]?.detail as { filingRefusedBecause: string })
    .filingRefusedBecause, 'NO_INDEPENDENT_AGENT');
});

test('V8-a: two execution Sessions exclude both agents', () => {
  const input = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: null }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: null }),
    ],
    sessions: [
      session({ id: id(91), workspaceId: WORKER_AGENT }),
      session({ id: id(92), workspaceId: COORDINATOR_AGENT }),
    ],
  });
  assert.deepEqual([...implementerAgentIds(input, PARENT)].sort(),
    [COORDINATOR_AGENT, WORKER_AGENT].sort());
});

test('V8-a: the coordinator\'s own run is not work in the subtree', () => {
  const input = world({
    sessions: [session({ id: id(93), taskId: null, workspaceId: COORDINATOR_AGENT })],
  });
  assert.equal(implementerAgentIds(input, PARENT).has(COORDINATOR_AGENT), false);
  assert.equal(planCompletionGaps(input, gapsOf(input)).filings.length, 1);
});

test('V8-a: a Session on a task OUTSIDE the subtree says nothing about this check', () => {
  const outside = id(15);
  const input = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: WORKER_AGENT }),
      taskRow({ id: outside, status: 'DONE', assigneeAgentId: null }),
    ],
    sessions: [session({ taskId: outside, workspaceId: COORDINATOR_AGENT })],
  });
  assert.equal(implementerAgentIds(input, PARENT).has(COORDINATOR_AGENT), false);
});

// ── V8-d: a cancelled check is not one the subject is waiting on ────────────────────────────────

test('V8-d: a CANCELLED check leaves the subject with none, and a new episode is filed', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: VERIFIER, verifiesTaskId: PARENT, status: 'CANCELLED' }),
  ]);
  assert.equal(plan.completionGaps[0]?.reason, 'NO_VERIFICATION_FILED');
  assert.equal(plan.completionGaps[0]?.evidence.verifications.outstanding, 0);
});

test('V8-d: a RETIRED check is the same — its re-run is counted on its own row', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({
      id: VERIFIER, verifiesTaskId: PARENT, status: 'CANCELLED',
      supersededByTaskId: id(98), retirement: 'SUPERSEDED',
    }),
  ]);
  assert.equal(plan.completionGaps[0]?.reason, 'NO_VERIFICATION_FILED');
});

test('V8-d: a FAILED check is still one somebody can re-run, so it is a wait', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: VERIFIER, verifiesTaskId: PARENT, status: 'FAILED' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

test('AG1: a PASS on the filed check completes the roll-up, which is the point of filing it', () => {
  const plan = planTaskAggregation([
    rollup({ completionPolicy: 'VERIFICATION_PASSED' }),
    task({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE' }),
    task({ id: VERIFIER, verifiesTaskId: PARENT, status: 'DONE', verdict: 'PASS' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
  assert.deepEqual(plan.aggregations.map((a) => [a.taskId, a.to, a.reason]),
    [[PARENT, 'DONE', 'VERIFICATION_PASSED']]);
});

// ── AG8 at the dispatch gate ────────────────────────────────────────────────────────────────────

function checkedWorld(protocol?: { completionGaps: true }): ProjectDecisionInput {
  return world({
    protocol,
    tasks: [
      taskRow({
        id: PARENT, completionPolicy: 'VERIFICATION_PASSED', assigneeAgentId: WORKER_AGENT,
      }),
      taskRow({ id: CHILD_A, parentTaskId: PARENT, status: 'DONE', assigneeAgentId: WORKER_AGENT }),
      taskRow({ id: VERIFIER, verifiesTaskId: PARENT, assigneeAgentId: COORDINATOR_AGENT }),
    ],
  });
}

test('AG8: the filed check becomes dispatchable, and the roll-up never does', () => {
  const selection = selectDispatchableTasks(checkedWorld({ completionGaps: true }));
  assert.deepEqual(selection.candidates.map((c) => c.taskId), [VERIFIER]);
  assert.equal(
    selection.skipped.find((s) => s.taskId === PARENT)?.reason,
    'TASK_AGGREGATE_PARENT',
    'AG6 is untouched: the subject still gets no Session of its own',
  );
});

test('AG8: a snapshot from before this build still refuses the check, exactly as it did', () => {
  const selection = selectDispatchableTasks(checkedWorld(undefined));
  assert.deepEqual(selection.candidates.map((c) => c.taskId), []);
  assert.equal(
    selection.skipped.find((s) => s.taskId === VERIFIER)?.reason,
    'VERIFICATION_SUBJECT_NOT_DONE',
  );
});

test('AG8: a check on an ordinary unfinished subject is still refused', () => {
  const input = world({
    tasks: [
      taskRow({ id: PARENT, completionPolicy: 'MANUAL', assigneeAgentId: WORKER_AGENT }),
      taskRow({ id: VERIFIER, verifiesTaskId: PARENT, assigneeAgentId: COORDINATOR_AGENT }),
    ],
  });
  assert.equal(
    selectDispatchableTasks(input).skipped.find((s) => s.taskId === VERIFIER)?.reason,
    'VERIFICATION_SUBJECT_NOT_DONE',
  );
});
