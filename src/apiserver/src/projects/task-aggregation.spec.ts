import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AggregationTaskFact,
  AggregationTaskStatus,
  PlannedTaskAggregation,
  TaskCompletionPolicyValue,
  TaskVerdictValue,
  planTaskAggregation,
  taskStartOwnedByCompletion,
} from './task-aggregation';

/**
 * Terse fixture spelling. Ids are single letters so a whole tree fits on one line and the table
 * below reads as the tree it describes rather than as a list of object literals.
 */
function task(
  id: string,
  status: AggregationTaskStatus,
  options: {
    parent?: string;
    policy?: TaskCompletionPolicyValue;
    criterion?: AggregationTaskFact['completionCriterion'];
    verifies?: string;
    verdict?: TaskVerdictValue;
  } = {},
): AggregationTaskFact {
  return {
    id,
    status,
    parentTaskId: options.parent ?? null,
    completionPolicy: options.policy ?? 'MANUAL',
    completionCriterion: options.criterion,
    verifiesTaskId: options.verifies ?? null,
    verdict: options.verdict ?? null,
  };
}

function moves(plan: { aggregations: PlannedTaskAggregation[] }): string[] {
  return plan.aggregations.map((one) => `${one.taskId}:${one.from}->${one.to}`);
}

test('task_start is owned by an independent verifier even on a childless subject', () => {
  assert.equal(taskStartOwnedByCompletion({
    completionPolicy: 'VERIFICATION_PASSED',
    completionCriterion: 'VERIFICATION',
    verifiesTaskId: null,
    hasDirectChildren: false,
  }), true);
  assert.equal(taskStartOwnedByCompletion({
    completionPolicy: 'MANUAL',
    completionCriterion: 'VERIFICATION',
    verifiesTaskId: 'subject',
    hasDirectChildren: false,
  }), false, 'the independent verifier is executable work');
});

interface Case {
  name: string;
  tasks: AggregationTaskFact[];
  expect: string[];
  cycles?: string[];
}

const CASES: Case[] = [
  // ---- MANUAL is the compatible default -------------------------------------------------------
  {
    name: 'MANUAL never completes a parent, however finished its children are',
    tasks: [task('p', 'OPEN'), task('a', 'DONE', { parent: 'p' }), task('b', 'DONE', { parent: 'p' })],
    expect: [],
  },
  {
    name: 'MANUAL never reopens a parent either — its status is nobody else’s to recompute',
    tasks: [task('p', 'DONE'), task('a', 'OPEN', { parent: 'p' })],
    expect: [],
  },

  // ---- AG4: the empty parent ------------------------------------------------------------------
  {
    name: 'AG4: ALL_CHILDREN_DONE on a childless task is inert',
    tasks: [task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' })],
    expect: [],
  },
  {
    name: 'AG4: VERIFICATION_PASSED on a childless task is inert even with a passing verification',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'PASS' }),
    ],
    expect: [],
  },
  {
    name: 'AG4: a childless DONE parent is not reopened by its own empty policy',
    tasks: [task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' })],
    expect: [],
  },

  // ---- ALL_CHILDREN_DONE ----------------------------------------------------------------------
  {
    name: 'ALL_CHILDREN_DONE completes when every child is DONE',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'DONE', { parent: 'p' }),
    ],
    expect: ['p:OPEN->DONE'],
  },
  {
    name: 'ALL_CHILDREN_DONE accepts CANCELLED children beside at least one DONE',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'CANCELLED', { parent: 'p' }),
    ],
    expect: ['p:OPEN->DONE'],
  },
  {
    name: 'all children CANCELLED is not a completion — nothing was actually done',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'CANCELLED', { parent: 'p' }),
      task('b', 'CANCELLED', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'an IN_PROGRESS child holds the parent open',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'IN_PROGRESS', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'a FAILED child holds the parent open — stopped is not finished',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'FAILED', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'an IN_PROGRESS parent may be completed by its children',
    tasks: [
      task('p', 'IN_PROGRESS', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: ['p:IN_PROGRESS->DONE'],
  },
  {
    name: 'a CANCELLED parent is not resurrected by finished children',
    tasks: [
      task('p', 'CANCELLED', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    // AG6's recovery half. This case asserted `[]` until AG6 existed, on the reading that FAILED is
    // a statement somebody made about the parent. It is not: an aggregate parent can only reach
    // FAILED by having been dispatched, which AG6 says must never happen, so the status is the
    // residue of a run that should not exist. Left untouched it is a wedge with no exit — the
    // dispatch gates skip it before the retry ladder and `TASK_AGGREGATE_PARENT` is non-blocking,
    // so nothing retries it and nothing opens a row about it. The aggregation role taking the
    // status back is the only next step there is.
    name: 'AG6: a FAILED parent is recomputed from its finished children',
    tasks: [
      task('p', 'FAILED', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: ['p:FAILED->DONE'],
  },
  {
    name: 'AG6: a FAILED parent with outstanding children goes back to OPEN, not DONE',
    tasks: [
      task('p', 'FAILED', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'OPEN', { parent: 'p' }),
    ],
    expect: ['p:FAILED->OPEN'],
  },
  {
    name: 'AG6: a FAILED VERIFICATION_PASSED parent completes once its check passes',
    tasks: [
      task('p', 'FAILED', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'PASS' }),
    ],
    expect: ['p:FAILED->DONE'],
  },
  {
    name: 'AG6: a FAILED VERIFICATION_PASSED parent whose check has not passed stays outstanding',
    tasks: [
      task('p', 'FAILED', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'OPEN', { verifies: 'p' }),
    ],
    expect: ['p:FAILED->OPEN'],
  },
  {
    name: 'a MANUAL FAILED parent is left alone — AG6 recovers only what aggregation owns',
    tasks: [
      task('p', 'FAILED', { policy: 'MANUAL' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'an already-DONE satisfied parent produces no write',
    tasks: [
      task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: [],
  },

  // ---- AG3: reopen ----------------------------------------------------------------------------
  {
    name: 'AG3: a reopened child pulls its DONE parent back to OPEN',
    tasks: [
      task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'OPEN', { parent: 'p' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    name: 'AG3: a newly added child reopens the parent it was added to',
    tasks: [
      task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('fresh', 'OPEN', { parent: 'p' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    name: 'AG3: a child that fails after the parent completed reopens it',
    tasks: [
      task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'FAILED', { parent: 'p' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    // CANCELLED only. A cancellation is a statement somebody made about the parent itself, and
    // aggregation only ever answers for the children — so it stays, in both directions. FAILED left
    // this case when AG6 landed; see the AG6 rows above for why the two stopped being the same
    // sentence.
    name: 'AG3: reopening never touches a CANCELLED parent',
    tasks: [
      task('p', 'CANCELLED', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'OPEN', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'AG3: a CANCELLED parent is not completed by finished children either',
    tasks: [
      task('p', 'CANCELLED', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: [],
  },

  // ---- VERIFICATION_PASSED --------------------------------------------------------------------
  {
    name: 'VERIFICATION_PASSED completes on settled children plus a passing verification',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'PASS' }),
    ],
    expect: ['p:OPEN->DONE'],
  },
  {
    name: 'explicit VERIFICATION is derived from PASS without a forbidden verifier DONE write',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED', criterion: 'VERIFICATION' }),
      task('v', 'OPEN', { verifies: 'p', verdict: 'PASS' }),
    ],
    expect: ['p:OPEN->DONE'],
  },
  {
    name: 'an explicit VERIFICATION PASS revocation reopens the derived subject',
    tasks: [
      task('p', 'DONE', { policy: 'VERIFICATION_PASSED', criterion: 'VERIFICATION' }),
      task('v', 'OPEN', { verifies: 'p' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    name: 'a verification that finished without a verdict is not a pass',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'a FAIL verdict does not complete the subject',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'FAIL' }),
    ],
    expect: [],
  },
  {
    name: 'an INCONCLUSIVE verdict does not complete the subject',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'INCONCLUSIVE' }),
    ],
    expect: [],
  },
  {
    name: 'a verification still running holds the subject open, verdict or not',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'IN_PROGRESS', { verifies: 'p', verdict: 'PASS' }),
    ],
    expect: [],
  },
  {
    name: 'every verification pointed at the subject must pass, not just one',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v1', 'DONE', { verifies: 'p', verdict: 'PASS' }),
      task('v2', 'DONE', { verifies: 'p', verdict: 'FAIL' }),
    ],
    expect: [],
  },
  {
    name: 'revoking the verdict reopens a subject VERIFICATION_PASSED had completed',
    tasks: [
      task('p', 'DONE', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    name: 'a verdict flipped to FAIL reopens the subject',
    tasks: [
      task('p', 'DONE', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'FAIL' }),
    ],
    expect: ['p:DONE->OPEN'],
  },
  {
    name: 'ALL_CHILDREN_DONE ignores verifications entirely',
    tasks: [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'FAIL' }),
    ],
    expect: ['p:OPEN->DONE'],
  },
  {
    name: 'a verification that is also a child is counted on both axes',
    tasks: [
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('v', 'OPEN', { parent: 'p', verifies: 'p', verdict: 'PASS' }),
    ],
    expect: [],
  },

  // ---- AG2: multi-level ------------------------------------------------------------------------
  {
    name: 'AG2: a leaf finishing settles three levels in one pass',
    tasks: [
      task('gp', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'OPEN', { parent: 'gp', policy: 'ALL_CHILDREN_DONE' }),
      task('leaf', 'DONE', { parent: 'p' }),
    ],
    expect: ['p:OPEN->DONE', 'gp:OPEN->DONE'],
  },
  {
    name: 'AG2: an outstanding leaf stops the chain at the level that owns it',
    tasks: [
      task('gp', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'OPEN', { parent: 'gp', policy: 'ALL_CHILDREN_DONE' }),
      task('l1', 'DONE', { parent: 'p' }),
      task('l2', 'OPEN', { parent: 'p' }),
    ],
    expect: [],
  },
  {
    name: 'AG2: a reopened leaf unwinds the whole chain in one pass',
    tasks: [
      task('gp', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'DONE', { parent: 'gp', policy: 'ALL_CHILDREN_DONE' }),
      task('leaf', 'OPEN', { parent: 'p' }),
    ],
    expect: ['p:DONE->OPEN', 'gp:DONE->OPEN'],
  },
  {
    name: 'AG2: a MANUAL middle level stops the recomputation from propagating through it',
    tasks: [
      task('gp', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'OPEN', { parent: 'gp' }),
      task('leaf', 'DONE', { parent: 'p', policy: 'ALL_CHILDREN_DONE' }),
    ],
    expect: [],
  },
  {
    name: 'AG2: mixed policies settle bottom-up in one pass',
    tasks: [
      task('gp', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('p', 'OPEN', { parent: 'gp', policy: 'ALL_CHILDREN_DONE' }),
      task('leaf', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'gp', verdict: 'PASS' }),
    ],
    expect: ['p:OPEN->DONE', 'gp:OPEN->DONE'],
  },
  {
    name: 'AG2: five levels converge in one pass',
    tasks: [
      task('a', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('b', 'OPEN', { parent: 'a', policy: 'ALL_CHILDREN_DONE' }),
      task('c', 'OPEN', { parent: 'b', policy: 'ALL_CHILDREN_DONE' }),
      task('d', 'OPEN', { parent: 'c', policy: 'ALL_CHILDREN_DONE' }),
      task('e', 'DONE', { parent: 'd' }),
    ],
    expect: ['d:OPEN->DONE', 'c:OPEN->DONE', 'b:OPEN->DONE', 'a:OPEN->DONE'],
  },

  // ---- Structural edges -------------------------------------------------------------------------
  {
    name: 'a parent outside the snapshot is treated as no parent, not as an outstanding child',
    tasks: [task('a', 'DONE', { parent: 'elsewhere', policy: 'ALL_CHILDREN_DONE' })],
    expect: [],
  },
  {
    name: 'sibling subtrees are independent',
    tasks: [
      task('p1', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p2', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p1' }),
      task('b', 'OPEN', { parent: 'p2' }),
    ],
    expect: ['p1:OPEN->DONE'],
  },

  // ---- AG2: cycles ------------------------------------------------------------------------------
  {
    name: 'AG2: a two-node parent cycle stops aggregation and is reported',
    tasks: [
      task('x', 'OPEN', { parent: 'y', policy: 'ALL_CHILDREN_DONE' }),
      task('y', 'OPEN', { parent: 'x', policy: 'ALL_CHILDREN_DONE' }),
    ],
    expect: [],
    cycles: ['x', 'y'],
  },
  {
    name: 'AG2: a self-parent is a cycle',
    tasks: [task('x', 'OPEN', { parent: 'x', policy: 'ALL_CHILDREN_DONE' })],
    expect: [],
    cycles: ['x'],
  },
  {
    name: 'AG2: a cycle anywhere stops aggregation for the whole snapshot',
    tasks: [
      task('x', 'OPEN', { parent: 'y' }),
      task('y', 'OPEN', { parent: 'x' }),
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ],
    expect: [],
    cycles: ['x', 'y'],
  },
  {
    name: 'AG2: a task hanging below a cycle is not itself reported as on it',
    tasks: [
      task('x', 'OPEN', { parent: 'y' }),
      task('y', 'OPEN', { parent: 'x' }),
      task('below', 'OPEN', { parent: 'x' }),
    ],
    expect: [],
    cycles: ['x', 'y'],
  },
];

test('planTaskAggregation recomputes a parent from its current children', async (t) => {
  for (const one of CASES) {
    await t.test(one.name, () => {
      const plan = planTaskAggregation(one.tasks);
      assert.deepEqual(moves(plan), one.expect);
      assert.deepEqual(plan.cycleTaskIds, one.cycles ?? []);
    });
  }
});

test('the plan is a pure recomputation, so it is idempotent by construction', async (t) => {
  await t.test('input order does not change the plan', () => {
    const tasks = [
      task('gp', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'OPEN', { parent: 'gp', policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('b', 'CANCELLED', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict: 'PASS' }),
    ];
    const forward = planTaskAggregation(tasks);
    const backward = planTaskAggregation([...tasks].reverse());
    assert.deepEqual(forward, backward);
    assert.deepEqual(moves(forward), ['p:OPEN->DONE', 'gp:OPEN->DONE']);
  });

  await t.test('replanning the world the plan produced yields nothing to do', () => {
    let tasks = [
      task('gp', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('p', 'OPEN', { parent: 'gp', policy: 'ALL_CHILDREN_DONE' }),
      task('leaf', 'DONE', { parent: 'p' }),
    ];
    const first = planTaskAggregation(tasks);
    assert.equal(first.aggregations.length, 2);
    // Apply it, exactly as the reconcile CAS would.
    tasks = tasks.map((one) => {
      const move = first.aggregations.find((planned) => planned.taskId === one.id);
      return move ? { ...one, status: move.to as AggregationTaskStatus } : one;
    });
    assert.deepEqual(planTaskAggregation(tasks).aggregations, []);
    // And a third time, because "converged" has to mean converged.
    assert.deepEqual(planTaskAggregation(tasks).aggregations, []);
  });

  await t.test('DONE -> OPEN -> DONE plans the same write the first time did (PC-CX-17)', () => {
    const settled = [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ];
    assert.deepEqual(moves(planTaskAggregation(settled)), ['p:OPEN->DONE']);

    const reopened = [
      task('p', 'DONE', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'OPEN', { parent: 'p' }),
    ];
    assert.deepEqual(moves(planTaskAggregation(reopened)), ['p:DONE->OPEN']);

    // The child comes back. A digest-keyed ledger action would recognise this world as one it had
    // already handled and skip it, stranding the parent OPEN forever; a recomputation cannot.
    const again = [
      task('p', 'OPEN', { policy: 'ALL_CHILDREN_DONE' }),
      task('a', 'DONE', { parent: 'p' }),
    ];
    assert.deepEqual(moves(planTaskAggregation(again)), ['p:OPEN->DONE']);
  });
});

test('every planned write carries the evidence it was decided from', () => {
  const plan = planTaskAggregation([
    task('p', 'DONE', { policy: 'VERIFICATION_PASSED' }),
    task('a', 'DONE', { parent: 'p' }),
    task('b', 'CANCELLED', { parent: 'p' }),
    task('c', 'FAILED', { parent: 'p' }),
    task('v', 'DONE', { verifies: 'p', verdict: 'PASS' }),
    task('w', 'OPEN', { verifies: 'p' }),
  ]);
  assert.deepEqual(plan.aggregations, [{
    taskId: 'p',
    from: 'DONE',
    to: 'OPEN',
    policy: 'VERIFICATION_PASSED',
    reason: 'CHILDREN_OUTSTANDING',
    evidence: {
      children: { total: 3, done: 1, cancelled: 1, outstanding: 1 },
      // `[K5]`: `w` is OPEN, so it is outstanding and can still conclude — `unconcludable` counts
      // only the ones that are DONE with nothing recorded.
      verifications: { total: 2, passed: 1, outstanding: 1, unconcludable: 0 },
    },
  }]);
});

test('a reopen caused only by verification says so', () => {
  const plan = planTaskAggregation([
    task('p', 'DONE', { policy: 'VERIFICATION_PASSED' }),
    task('a', 'DONE', { parent: 'p' }),
    task('v', 'DONE', { verifies: 'p', verdict: 'FAIL' }),
  ]);
  assert.equal(plan.aggregations[0]?.reason, 'VERIFICATION_OUTSTANDING');
});

test('a deep chain does not overflow the stack', () => {
  const depth = 5_000;
  const tasks: AggregationTaskFact[] = [];
  for (let level = 0; level < depth; level += 1) {
    tasks.push(task(
      `n${String(level).padStart(6, '0')}`,
      'OPEN',
      {
        policy: 'ALL_CHILDREN_DONE',
        ...(level === 0 ? {} : { parent: `n${String(level - 1).padStart(6, '0')}` }),
      },
    ));
  }
  tasks.push(task('leaf', 'DONE', { parent: `n${String(depth - 1).padStart(6, '0')}` }));
  assert.equal(planTaskAggregation(tasks).aggregations.length, depth);
});

// `[K5]` / `[H0V2]`: the 20 cells that had no write, no gap, no condition and one WARN a minute.

test('a roll-up whose only check is DONE with no verdict now reports a gap', () => {
  const plan = planTaskAggregation([
    task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
    task('a', 'DONE', { parent: 'p' }),
    task('v', 'DONE', { verifies: 'p' }),
  ]);
  // Still no write — the children are in but nothing passed, which is correct and unchanged.
  assert.deepEqual(plan.aggregations, []);
  assert.equal(plan.completionGaps.length, 1);
  assert.equal(plan.completionGaps[0]?.reason, 'VERIFICATION_CANNOT_CONCLUDE');
  assert.equal(plan.completionGaps[0]?.evidence.verifications.unconcludable, 1);
});

test('one check that can still conclude keeps it an ordinary wait', () => {
  // The narrowness that makes the clause safe: a live check means somebody IS going to answer, and
  // opening a row against that is telling a person to fix something that is not broken.
  const plan = planTaskAggregation([
    task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
    task('a', 'DONE', { parent: 'p' }),
    task('v', 'DONE', { verifies: 'p' }),
    task('w', 'OPEN', { verifies: 'p' }),
  ]);
  assert.deepEqual(plan.completionGaps, []);
});

test('a FAIL is not this gap: §13.2 already raises its own row', () => {
  for (const verdict of ['FAIL', 'INCONCLUSIVE'] as const) {
    const plan = planTaskAggregation([
      task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
      task('a', 'DONE', { parent: 'p' }),
      task('v', 'DONE', { verifies: 'p', verdict }),
    ]);
    assert.deepEqual(plan.completionGaps, [], verdict);
  }
});

test('the missing-check gap still wins where there is no check at all', () => {
  // Ordering, and it matters: `NO_VERIFICATION_FILED` is the one §13.2 V8 can close by itself, and
  // reporting the un-closable one instead would send a person to look at a check that does not
  // exist.
  const plan = planTaskAggregation([
    task('p', 'OPEN', { policy: 'VERIFICATION_PASSED' }),
    task('a', 'DONE', { parent: 'p' }),
  ]);
  assert.equal(plan.completionGaps[0]?.reason, 'NO_VERIFICATION_FILED');
});

test('aggregation never completes a check that has concluded nothing', () => {
  // The other end of migration 0141's trigger: the one writer with no person behind it must not
  // mint `status = DONE, verdict = NULL` on a check. Reopening it stays allowed — that direction
  // claims no conclusion.
  const plan = planTaskAggregation([
    task('v', 'OPEN', { verifies: 's', policy: 'ALL_CHILDREN_DONE' }),
    task('c', 'DONE', { parent: 'v' }),
    task('s', 'DONE', {}),
  ]);
  assert.deepEqual(plan.aggregations, []);
});

test('a check that DID conclude is aggregated exactly as before', () => {
  const plan = planTaskAggregation([
    task('v', 'OPEN', { verifies: 's', verdict: 'FAIL', policy: 'ALL_CHILDREN_DONE' }),
    task('c', 'DONE', { parent: 'v' }),
    task('s', 'DONE', {}),
  ]);
  assert.equal(plan.aggregations[0]?.taskId, 'v');
  assert.equal(plan.aggregations[0]?.to, 'DONE');
});
