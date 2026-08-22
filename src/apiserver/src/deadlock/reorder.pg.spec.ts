import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  REORDER_ARRIVALS,
  cleanupReorderFixture,
  newReorderFixtureIds,
  orderedReorderScenario,
  positionsFor,
  requestedOrders,
  seedReorderFixture,
  unorderedReorderScenario,
  type ReorderFixtureIds,
} from './reorder-fixture';
import { runScenario, type ScenarioOutcome } from './pg-barrier';

const URL = process.env.COORDINATOR_PG_URL;
/** Strict: every wait in these plans is one row lock deep. A slow run is a wedged run. */
const BUDGET_MS = 20_000;

/**
 * The multi-row write this audit went looking for, against a real PostgreSQL.
 *
 * `WorkspacesService.reorder` wrote its position updates in the order the caller dragged them
 * into. Two drags that move the same workspaces opposite ways send exactly reversed arrays, so the
 * two transactions took the same `workspace` rows in opposite orders — a 40P01 with no trigger and
 * no foreign key in it, surfacing to a person as an unexplained failure on a sidebar drag.
 *
 * Two claims are made here and they are different:
 *
 *  1. **The control still deadlocks.** The pre-fix statement sequence is replayed and asserted to
 *     produce 40P01 on this exact schema. Without it, the post-fix run below would prove only that
 *     the barrier failed to make two transactions meet.
 *  2. **The fix holds from both arrival orders, and loses nothing.** The statements the endpoint
 *     issues today — every party in id order — are replayed with each party arriving first, and
 *     every party commits inside a strict deadline. The final positions are then read back and
 *     required to be a whole valid order belonging to ONE of the two requests: a lost update or a
 *     half-interleaved result would leave two workspaces sharing a position, which is the failure
 *     "no deadlock" alone would not catch.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable server
 * `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */

function assertAllCommitted(outcome: ScenarioOutcome): void {
  const failed = outcome.statements.filter((s) => !s.ok);
  assert.deepEqual(
    failed.map((s) => `${s.party}/${s.label}: ${s.sqlstate ?? '?'} ${s.message ?? ''}`),
    [],
    `${outcome.name}: every statement must succeed`,
  );
  for (const [party, committed] of Object.entries(outcome.committed)) {
    assert.equal(committed, true, `${outcome.name}: ${party} did not commit`);
  }
  assert.equal(
    outcome.statements.some((s) => s.sqlstate === '40P01'),
    false,
    `${outcome.name}: a deadlock was detected`,
  );
}

async function storedPositions(admin: Client, ids: ReorderFixtureIds): Promise<Map<string, number>> {
  const { rows } = await admin.query<{ id: string; position: number }>(
    `SELECT "id", "position" FROM "workspace" WHERE "owner_id" = $1::uuid ORDER BY "id"`,
    [ids.ownerId],
  );
  return new Map(rows.map((row) => [row.id, row.position]));
}

test('a reversed sidebar reorder', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());

  await t.test('the pre-fix statement order really does deadlock', async () => {
    const ids = newReorderFixtureIds('reorder-control');
    await seedReorderFixture(admin, ids);
    try {
      const outcome = await runScenario(url, unorderedReorderScenario(ids), BUDGET_MS);
      const victims = outcome.statements.filter((s) => s.sqlstate === '40P01');
      assert.equal(
        victims.length,
        1,
        'the control must produce exactly one 40P01 — if it produces none, this barrier has ' +
          'stopped discriminating and the ordered case below proves nothing',
      );
      assert.equal(victims[0].party, 'forward', 'the party whose detector runs is the victim');
      // The ring, as PostgreSQL itself reported it while the two were parked.
      const byPid = new Map(Object.entries(outcome.pids).map(([name, pid]) => [pid, name]));
      assert.deepEqual(
        outcome.waitEdges.map(
          (edge) => `${edge.waiter} -> ${edge.blockingPids.map((p) => byPid.get(p) ?? p).join('+')}`,
        ),
        ['reversed -> forward', 'forward -> reversed'],
        'the two wait edges that close the cycle',
      );
      // The victim rolled back whole: it committed nothing, so no half-applied order survives.
      assert.equal(outcome.committed.forward, false, 'the victim must not commit');
    } finally {
      await cleanupReorderFixture(admin, ids);
    }
  });

  for (const arrival of REORDER_ARRIVALS) {
    await t.test(`ordered statements commit from both sides · ${arrival}`, async () => {
      const ids = newReorderFixtureIds(`reorder-${arrival}`);
      await seedReorderFixture(admin, ids);
      try {
        const outcome = await runScenario(url, orderedReorderScenario(ids, arrival), BUDGET_MS);
        assertAllCommitted(outcome);

        // Exactly one wait, and it is the follower parked on the leader's first row. More than one
        // would mean the follower caught up and blocked again, which the shared order rules out.
        assert.equal(outcome.waitEdges.length, 1, 'one wait, not a cycle');
        const byPid = new Map(Object.entries(outcome.pids).map(([name, pid]) => [pid, name]));
        const [edge] = outcome.waitEdges;
        assert.deepEqual(
          edge.blockingPids.map((pid) => byPid.get(pid)),
          [arrival === 'forward-first' ? 'forward' : 'reversed'],
          'the follower waits for the leader and for nobody else',
        );

        // No lost update: every workspace ends up with exactly one position, the positions are a
        // permutation, and the whole result belongs to ONE of the two requests rather than being
        // stitched together out of both.
        const stored = await storedPositions(admin, ids);
        const { forward, reversed } = requestedOrders(ids);
        assert.equal(stored.size, ids.workspaceIds.length, 'every workspace still has a row');
        assert.deepEqual(
          [...stored.values()].sort((a, b) => a - b),
          ids.workspaceIds.map((_, index) => index),
          'the stored positions are a permutation — no two workspaces share one',
        );
        const asRequested = (order: string[]) => {
          const wanted = positionsFor(order);
          return [...stored].every(([id, position]) => wanted.get(id) === position);
        };
        assert.ok(
          asRequested(forward) || asRequested(reversed),
          'the surviving order is one whole request, not a mixture of the two',
        );
        // The follower commits last, so the order that survives is the follower's.
        const follower = arrival === 'forward-first' ? reversed : forward;
        assert.ok(asRequested(follower), 'last writer wins, which is what a sidebar order means');
      } finally {
        await cleanupReorderFixture(admin, ids);
      }
    });
  }
});
