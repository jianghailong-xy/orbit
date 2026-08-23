import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  HOLD_EPOCH_ROW,
  WRITE_STATUS,
  type EpochIds,
  epochsOf,
  functionFromMigration,
  newEpochIds,
  seedEpochFixture,
} from './dispatch-epoch-fixture';
import { runScenario, type ScenarioOutcome, type ScenarioSpec } from './pg-barrier';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';

/**
 * H2G — `task_dispatch_epoch` advances in ONE canonical batch (migration 0154), on a real
 * PostgreSQL, from both function bodies.
 *
 * 0137 shipped the epoch as the automatic doors' ABA-safe name and advanced it from `task` in TWO
 * passes: the rows the statement wrote, then the dependents of the rows whose `status` moved. Each
 * pass sorts, and that is as far as the argument goes — it orders the locks WITHIN a pass. Across
 * two passes the acquisition order is `sorted(own) ++ sorted(dependents)`, which is not a total
 * order, and a lock order that is not a total order is not one.
 *
 * The fixture is an ordinary chain — `a < b < c`, `b` depends on `a`, `c` depends on `b`, no cycle
 * — and two ordinary Task status writes:
 *
 *   T1 writes {a, c}:  own {a, c}, dependents {b}   0137: a, c, b     0154: a, b, c
 *   T2 writes {b}:     own {b},    dependents {c}   0137: b, c        0154: b, c
 *
 * Under 0137 that is `T1 holds a and c, wants b` against `T2 holds b, wants c`. Under 0154 both
 * take what they share in ascending id order and no cycle can be drawn.
 *
 * THE CONTROL IS THE POINT. "No deadlock" is what a test that never made the two transactions meet
 * reports too, so the first round installs 0137's body — read out of 0137 itself, not transcribed —
 * and asserts the same plan really does produce a `40P01`. Only then does the second round mean
 * anything.
 *
 * Destructive and schema-owning: it replaces a live function body mid-test and deliberately parks
 * two backends in a lock cycle, so it runs only against the disposable servers
 * `scripts/deadlock-barrier.sh dispatch-epoch` and `scripts/project-pg-matrix.sh` provision — the
 * matrix gives every spec a database of its own, which is what keeps the body swap from being
 * anything but this file's own business. It puts 0154's body back on every exit either way.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** A hard budget for every wait in this file. A barrier that times out is red, never a pass. */
const BUDGET_MS = 20_000;

const ADVANCE = 'task_dispatch_epoch_bump_update';
const TWO_PASS = functionFromMigration('0137_task_run_request_receipt', ADVANCE);
const ONE_BATCH = functionFromMigration('0154_task_dispatch_epoch_canonical_batch', ADVANCE);

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: URL });
  await client.connect();
  return client;
}

async function install(body: string): Promise<void> {
  const client = await connect();
  try {
    await client.query(body);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The plan — the SAME plan for both function bodies, down to the wait graph it declares.
 *
 * The same rows, the same two product statements, the same order they are issued in and the same
 * order they are settled in. Nothing here is conditional on which body is installed, so the outcome
 * is a property of that body and of nothing else.
 *
 * `hold` is a third party that takes `c` and nothing else. It exists so the round has a
 * deterministic starting point: without it, whether the two writers ever meet depends on which one
 * reaches its second lock first, and a barrier that depends on timing is not a barrier.
 *
 * Both bodies park T2 behind T1, and for opposite reasons — which is the fix, seen from the wait
 * graph. Under 0137 T1 is queued for `c` (its own batch) and has not reached `b` at all, so T2
 * takes `b` freely and then queues behind T1 for `c`; under 0154 `b` is INSIDE T1's one sorted
 * batch, so T2 queues behind T1 for `b` and never contends for `c` out of order. Same declared
 * blocker, and only one of the two can close a cycle.
 *
 * T1 is pinned as the deadlock VICTIM by giving it the only short `deadlock_timeout` — the victim
 * is whichever backend runs the check that finds the cycle, so this is a configured threshold
 * rather than a race. It is also what makes both rounds settle in the same order: T1 either aborts
 * (0137) or completes (0154), and either way T2 goes next.
 */
function plan(name: string, ids: EpochIds): ScenarioSpec {
  return {
    name,
    parties: [
      { name: 'hold', deadlockTimeout: '1h' },
      { name: 'T1', deadlockTimeout: '50ms' },
      { name: 'T2', deadlockTimeout: '1h' },
    ],
    plan: [
      { op: 'run', party: 'hold', label: 'hold-c', sql: HOLD_EPOCH_ROW, values: [ids.c] },
      // T1 takes what it can and parks on `c`, which `hold` has. Under BOTH bodies: 0137 gets there
      // through its own batch {a, c}, 0154 through the union {a, b, c} — and only 0154 is holding
      // `b` by the time it parks. That difference is the whole fix, and it shows up in the next
      // step's wait edge.
      {
        op: 'block', party: 'T1', label: 'write-a-c', sql: WRITE_STATUS,
        values: [[ids.a, ids.c]], blockedBy: ['hold'],
      },
      {
        op: 'block', party: 'T2', label: 'write-b', sql: WRITE_STATUS,
        values: [[ids.b]], blockedBy: ['T1'],
      },
      // Releasing `c` hands it to T1, which is first in its wait queue.
      { op: 'finish', party: 'hold', action: 'ROLLBACK' },
      { op: 'settle', party: 'T1' },
      { op: 'finish', party: 'T1', action: 'COMMIT' },
      { op: 'settle', party: 'T2' },
      { op: 'finish', party: 'T2', action: 'COMMIT' },
    ],
  };
}

const outcomeOf = (run: ScenarioOutcome, label: string) =>
  run.statements.find((s) => s.label === label);

test('0137 two-pass advance: two ordinary Task status writes deadlock over one chain',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const ids = newEpochIds('epoch-control');
    const seed = await connect();
    try {
      await seedEpochFixture(seed, ids);
    } finally {
      await seed.end().catch(() => undefined);
    }
    await install(TWO_PASS);
    try {
      // T2 takes `b` — free, because the two-pass advance has T1 queued for `c` and not yet
      // reaching for `b` at all — and then queues behind T1 for `c`. That is the half that closes
      // the cycle a moment later, when `hold` lets go and T1 finally reaches for `b`.
      const run = await runScenario(URL!, plan('epoch-two-pass', ids), BUDGET_MS);

      const victim = outcomeOf(run, 'write-a-c');
      assert.equal(victim?.ok, false, 'the two-pass advance must lose this to a real cycle');
      assert.equal(victim?.sqlstate, '40P01',
        `expected a deadlock, got ${victim?.sqlstate ?? 'success'}: ${victim?.message ?? ''}`);
      assert.equal(run.committed.T1, false, 'a deadlock victim does not commit');
      // The cycle was observed, not inferred: both writers really did park in a lock wait before
      // `hold` let go, which is what makes "they met" a recorded fact rather than an assumption.
      assert.deepEqual(
        run.waitEdges.map((e) => [e.label, e.waitEventType, e.blockingPids.length]),
        [['write-a-c', 'Lock', 1], ['write-b', 'Lock', 1]],
      );
      assert.equal(run.waitEdges[0].blockingPids[0], run.pids.hold);
      assert.equal(run.waitEdges[1].blockingPids[0], run.pids.T1);
      // The other side is unharmed, which is what makes this a deadlock rather than an outage: the
      // victim's rollback frees `b` and `c` and T2 finishes normally.
      assert.equal(outcomeOf(run, 'write-b')?.ok, true);
      assert.equal(run.committed.T2, true);
    } finally {
      await install(ONE_BATCH);
    }
  });

test('0154 one canonical batch: the same two writes take the rows they share in one order',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const ids = newEpochIds('epoch-fixed');
    const seed = await connect();
    try {
      await seedEpochFixture(seed, ids);
      // Belt and braces after the control round put 0137's body back on the server: this asserts
      // the body under test is the one installed, not the one the previous test left behind.
      await install(ONE_BATCH);

      // The same plan the control ran, verbatim. T1 already holds `b` when T2 asks for it, because
      // `b` is inside T1's ONE sorted batch rather than in a second pass it has not reached — so T2
      // queues behind T1 for `b` instead of taking it and then racing T1 to `c`, and there is no
      // pair of rows the two take in opposite directions.
      const run = await runScenario(URL!, plan('epoch-one-batch', ids), BUDGET_MS);

      assert.equal(run.statements.filter((s) => s.sqlstate === '40P01').length, 0,
        'the canonical batch must not deadlock');
      assert.equal(outcomeOf(run, 'write-a-c')?.ok, true);
      assert.equal(outcomeOf(run, 'write-b')?.ok, true);
      assert.equal(run.committed.T1, true);
      assert.equal(run.committed.T2, true);
      // The same two observed Lock waits the control round recorded — the transactions met here
      // too, and simply did not close a cycle.
      assert.deepEqual(
        run.waitEdges.map((e) => [e.label, e.waitEventType, e.blockingPids.length]),
        [['write-a-c', 'Lock', 1], ['write-b', 'Lock', 1]],
      );
      assert.equal(run.waitEdges[0].blockingPids[0], run.pids.hold);
      assert.equal(run.waitEdges[1].blockingPids[0], run.pids.T1);

      // ...and the counter still MEANS the same thing, which is the half a reordering could quietly
      // break. Once per Task per STATEMENT, never per row and never twice for a Task that is in
      // both halves of one statement's affected set:
      //   seeding      a=0  b=1  c=1   (each edge INSERT advances its dependent)
      //   T1 {a, c}    a=1  b=2  c=2   (own {a,c} ∪ dependents-of-a {b}; `a` is not double-counted)
      //   T2 {b}       a=1  b=3  c=3   (own {b} ∪ dependents-of-b {c})
      const epochs = await epochsOf(seed, ids);
      assert.deepEqual(
        [epochs.get(ids.a), epochs.get(ids.b), epochs.get(ids.c)],
        [1n, 3n, 3n],
      );
    } finally {
      await seed.end().catch(() => undefined);
      await install(ONE_BATCH);
    }
  });
