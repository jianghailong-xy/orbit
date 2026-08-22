import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AggregationTaskFact,
  AggregationTaskStatus,
  TaskCompletionPolicyValue,
  TaskVerdictValue,
  planTaskAggregation,
} from './task-aggregation';

/**
 * Independent verification of §13.1 (unit 18), as properties over generated task forests rather
 * than as a table of hand-picked shapes.
 *
 * The unit-15 spec beside this one enumerates the cases its author thought of; this one states what
 * has to be true of EVERY snapshot and lets a seeded generator look for a snapshot where it is not.
 * Every seed is fixed and printed, so a failure names the exact forest that produced it.
 */

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

const STATUSES: AggregationTaskStatus[] = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED'];
const POLICIES: TaskCompletionPolicyValue[] = ['MANUAL', 'ALL_CHILDREN_DONE', 'VERIFICATION_PASSED'];
const VERDICTS: Array<TaskVerdictValue | null> = ['PASS', 'FAIL', 'INCONCLUSIVE', null];

/** mulberry32 — small, seeded, and identical on every machine, which is the whole point. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

/** Base62-ish opaque ids, deliberately NOT in tree order, so nothing can rely on id order. */
function taskId(index: number, salt: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = (index + 1) * 2654435761 + salt * 40503;
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length) + 7;
  }
  return out;
}

/**
 * A random forest: `count` tasks whose parent is always an EARLIER index, so the containment graph
 * is acyclic by construction (the cycle case gets its own generator below). Widths and depths vary
 * with the seed — `parentSpread` biases towards a few wide parents or a long spine.
 */
function forest(seed: number, count: number): AggregationTaskFact[] {
  const random = rng(seed);
  const tasks: AggregationTaskFact[] = [];
  const spine = random() < 0.4;
  for (let i = 0; i < count; i += 1) {
    const id = taskId(i, seed);
    let parentTaskId: string | null = null;
    if (i > 0 && random() < 0.75) {
      const parentIndex = spine
        ? i - 1
        : Math.floor(random() * i);
      parentTaskId = taskId(parentIndex, seed);
    }
    tasks.push({
      id,
      status: pick(random, STATUSES),
      parentTaskId,
      completionPolicy: pick(random, POLICIES),
      verifiesTaskId: null,
      verdict: null,
    });
  }
  // Verifications, added afterwards so a verifier may point anywhere in the forest — including at
  // its own parent, which is the shape §13.1's VERIFICATION_PASSED row is actually used in.
  for (const task of tasks) {
    if (random() < 0.25) {
      const subject = tasks[Math.floor(random() * tasks.length)];
      if (subject.id === task.id) continue;
      task.verifiesTaskId = subject.id;
      task.verdict = pick(random, VERDICTS);
    }
  }
  return tasks;
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Apply a plan the way `ProjectReconcileService.applyAggregations` does: a CAS on `from`. */
function apply(
  tasks: readonly AggregationTaskFact[],
  plan: ReturnType<typeof planTaskAggregation>,
): AggregationTaskFact[] {
  const byId = new Map(tasks.map((task) => [task.id, { ...task }]));
  for (const aggregation of plan.aggregations) {
    const row = byId.get(aggregation.taskId)!;
    if (row.status !== aggregation.from) continue;
    row.status = aggregation.to;
  }
  return [...byId.values()];
}

function childrenOf(
  task: AggregationTaskFact,
  tasks: readonly AggregationTaskFact[],
): AggregationTaskFact[] {
  return tasks.filter((row) => row.parentTaskId === task.id);
}

/** What §13.1's table says a parent's status has to be, read straight off the settled snapshot. */
function satisfied(task: AggregationTaskFact, tasks: readonly AggregationTaskFact[]): boolean {
  const children = childrenOf(task, tasks);
  if (children.length === 0) return false;
  const done = children.filter((row) => row.status === 'DONE').length;
  const settled = children.every((row) => row.status === 'DONE' || row.status === 'CANCELLED');
  if (!settled || done === 0) return false;
  if (task.completionPolicy !== 'VERIFICATION_PASSED') return true;
  const verifiers = tasks.filter((row) => row.verifiesTaskId === task.id);
  return verifiers.length > 0
    && verifiers.every((row) => row.status === 'DONE' && row.verdict === 'PASS');
}

test('§13.1 aggregation properties over generated forests', async (t) => {
  await t.test('AG1: the plan is a function of the snapshot, not of the array order', () => {
    for (const seed of SEEDS) {
      const tasks = forest(seed, 24);
      const baseline = planTaskAggregation(tasks);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const permuted = planTaskAggregation(shuffle(rng(seed * 1000 + attempt), tasks));
        assert.deepEqual(permuted, baseline,
          `seed=${seed} attempt=${attempt}: aggregation depends on input order`);
      }
    }
  });

  await t.test('AG5: every planned write names the status this snapshot actually read', () => {
    for (const seed of SEEDS) {
      const tasks = forest(seed, 24);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      for (const aggregation of planTaskAggregation(tasks).aggregations) {
        assert.equal(aggregation.from, byId.get(aggregation.taskId)!.status,
          `seed=${seed}: CAS 'from' is not the observed status of ${aggregation.taskId}`);
        assert.notEqual(aggregation.from, aggregation.to,
          `seed=${seed}: a write that changes nothing was planned for ${aggregation.taskId}`);
      }
    }
  });

  await t.test('AG1: re-planning after applying reaches a fixpoint and stays there', () => {
    for (const seed of SEEDS) {
      let tasks = forest(seed, 24);
      let passes = 0;
      for (; passes < 40; passes += 1) {
        const plan = planTaskAggregation(tasks);
        if (plan.aggregations.length === 0) break;
        tasks = apply(tasks, plan);
      }
      assert.ok(passes < 40, `seed=${seed}: aggregation never converged (oscillating plan)`);
      // Idempotence at the fixpoint: replaying the same delivery any number of times writes nothing.
      for (let replay = 0; replay < 3; replay += 1) {
        assert.deepEqual(planTaskAggregation(tasks).aggregations, [],
          `seed=${seed}: replaying a settled snapshot planned another write`);
      }
    }
  });

  await t.test('a parent is DONE at the fixpoint if and only if §13.1 says it must be', () => {
    for (const seed of SEEDS) {
      let tasks = forest(seed, 24);
      const initial = new Map(tasks.map((task) => [task.id, task.status]));
      for (let pass = 0; pass < 40; pass += 1) {
        const plan = planTaskAggregation(tasks);
        if (plan.aggregations.length === 0) break;
        tasks = apply(tasks, plan);
      }
      for (const task of tasks) {
        if (task.completionPolicy === 'MANUAL') {
          assert.equal(task.status, initial.get(task.id),
            `seed=${seed}: MANUAL task ${task.id} was rewritten by aggregation`);
          continue;
        }
        const was = initial.get(task.id)!;
        // CANCELLED only, since AG6. A cancellation is a statement somebody made ABOUT the parent,
        // and aggregation only ever answers for the children — so it is preserved in both
        // directions. FAILED is no longer in the same sentence: an aggregate parent can only reach
        // FAILED by having been dispatched, which AG6 forbids, so that status is the residue of a
        // run that should not exist rather than anybody's statement. Preserving it made a wedge
        // with no exit — the dispatch gates skip such a task before the retry ladder and
        // `TASK_AGGREGATE_PARENT` is a non-blocking refusal, so nothing retried it and nothing
        // opened a row about it. It falls through to the ordinary rules below: childless means
        // inert (so a FAILED leaf keeps its status), and with children it is recomputed.
        if (was === 'CANCELLED') {
          assert.equal(task.status, was,
            `seed=${seed}: aggregation overwrote a ${was} parent ${task.id}`);
          continue;
        }
        if (childrenOf(task, tasks).length === 0) {
          // AG4: a policy on a childless task is inert in BOTH directions — it neither completes
          // one nor reopens one that somebody else completed.
          assert.equal(task.status, was,
            `seed=${seed}: childless ${task.id} was rewritten from ${was} to ${task.status}`);
          continue;
        }
        if (satisfied(task, tasks)) {
          assert.equal(task.status, 'DONE',
            `seed=${seed}: ${task.id} satisfies its policy but settled at ${task.status}`);
        } else {
          assert.notEqual(task.status, 'DONE',
            `seed=${seed}: ${task.id} is DONE while its own subtree does not support it`);
        }
      }
    }
  });

  await t.test('AG3: reopening any leaf pulls every ancestor that derived from it back to OPEN', () => {
    for (const seed of SEEDS) {
      let tasks: AggregationTaskFact[] = forest(seed, 20).map((task) => ({
        ...task,
        // A forest that is entirely finished, so every derived parent is DONE before the reopen.
        status: task.status === 'FAILED' || task.status === 'IN_PROGRESS' ? 'DONE' : task.status,
        completionPolicy: task.completionPolicy === 'MANUAL'
          ? 'ALL_CHILDREN_DONE'
          : task.completionPolicy,
        verifiesTaskId: null,
        verdict: null,
      }));
      for (let pass = 0; pass < 40 && planTaskAggregation(tasks).aggregations.length > 0; pass += 1) {
        tasks = apply(tasks, planTaskAggregation(tasks));
      }
      const settled = tasks.map((task) => ({ ...task }));
      const parents = new Set(settled.map((task) => task.parentTaskId).filter(Boolean));
      const leaf = settled.find((task) => !parents.has(task.id) && task.status === 'DONE');
      if (!leaf) continue;

      let reopened: AggregationTaskFact[] = settled.map((task) =>
        task.id === leaf.id ? { ...task, status: 'OPEN' as const } : { ...task });
      for (let pass = 0; pass < 40; pass += 1) {
        const plan = planTaskAggregation(reopened);
        if (plan.aggregations.length === 0) break;
        reopened = apply(reopened, plan);
      }
      const byId = new Map(reopened.map((task) => [task.id, task]));
      const before = new Map(settled.map((task) => [task.id, task.status]));
      let cursor = leaf.parentTaskId;
      while (cursor) {
        // A CANCELLED ancestor is somebody's statement about the parent itself, and §13.1 leaves it
        // alone; it also counts as settled for ITS parent, so the chain legitimately stops there.
        if (before.get(cursor) === 'CANCELLED') break;
        const ancestor = byId.get(cursor)!;
        assert.equal(ancestor.status, 'OPEN',
          `seed=${seed}: ancestor ${cursor} stayed ${ancestor.status} after ${leaf.id} reopened`);
        cursor = ancestor.parentTaskId;
      }
    }
  });

  await t.test('AG2: a parent cycle stops aggregation and names exactly its members', () => {
    for (const seed of SEEDS) {
      const random = rng(seed + 7777);
      const tasks = forest(seed, 18).map((task) => ({
        ...task,
        completionPolicy: 'ALL_CHILDREN_DONE' as const,
        status: 'DONE' as const,
      }));
      // Close a cycle of a random length over the first `size` ids, leaving the rest of the forest
      // alone: the contract stops the WHOLE project's aggregation, and only the ring is reported.
      const size = 2 + Math.floor(random() * 4);
      const ring = tasks.slice(0, size);
      ring.forEach((task, index) => {
        task.parentTaskId = ring[(index + 1) % ring.length].id;
      });
      const plan = planTaskAggregation(tasks);
      assert.deepEqual(plan.aggregations, [],
        `seed=${seed}: aggregation ran on a project that contains a parent cycle`);
      assert.deepEqual(plan.cycleTaskIds, [...ring].map((task) => task.id).sort(),
        `seed=${seed}: the reported cycle is not exactly the ring`);
      // And it must not depend on where the walk happened to start.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.deepEqual(
          planTaskAggregation(shuffle(rng(seed * 31 + attempt), tasks)),
          plan,
          `seed=${seed} attempt=${attempt}: cycle detection depends on input order`,
        );
      }
    }
  });

  await t.test('AG2: one pass settles a whole containment tree, however deep', () => {
    for (const seed of SEEDS) {
      const tasks = forest(seed, 24).map((task) => ({
        ...task,
        verifiesTaskId: null,
        verdict: null,
      }));
      const settled = apply(tasks, planTaskAggregation(tasks));
      assert.deepEqual(planTaskAggregation(settled).aggregations, [],
        `seed=${seed}: aggregation needed a second delivery to cross the tree (AG2 is one pass)`);
    }
  });

  await t.test('AG4: no policy completes a task that has no children, at any depth', () => {
    for (const seed of SEEDS) {
      const tasks = forest(seed, 24);
      const parents = new Set(tasks.map((task) => task.parentTaskId).filter(Boolean));
      const planned = new Set(planTaskAggregation(tasks).aggregations
        .filter((aggregation) => aggregation.to === 'DONE')
        .map((aggregation) => aggregation.taskId));
      for (const id of planned) {
        assert.ok(parents.has(id), `seed=${seed}: childless task ${id} was completed by its policy`);
      }
    }
  });
});
