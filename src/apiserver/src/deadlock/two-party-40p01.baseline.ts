import assert from 'node:assert/strict';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import {
  inspectSurvivor,
  inspectVictimRollback,
  newFixtureIds,
  seedLockFixture,
  twoPartyDeadlockScenario,
} from './orbit-lock-fixture';
import { runScenario, type ScenarioOutcome } from './pg-barrier';

/**
 * BASELINE COMMAND — proves what the UNREPAIRED code does today, and nothing else.
 *
 * This is deliberately not a `*.spec.ts`. Its assertion is "Task creation loses a real
 * deadlock", which is the defect; the moment the production lock order is repaired it must
 * start failing, and a default test suite that permanently contains a test which the fix breaks
 * is a suite nobody can read. The scheduling it uses lives in `pg-barrier` and
 * `orbit-lock-fixture` and is shared verbatim with the regression that will replace it: the fix
 * task reuses `twoPartyDeadlockScenario` unchanged and asserts every party commits.
 *
 *   scripts/deadlock-barrier.sh baseline
 *
 * Exit code is the result. A round that cannot even schedule the cycle throws out of the
 * barrier's deadline rather than reporting a pass.
 */

const ROUNDS = Number(process.env.DEADLOCK_BASELINE_ROUNDS ?? 20);
/** Per-round wall clock. Generous next to the 2s detector, tight enough to fail fast. */
const ROUND_BUDGET_MS = Number(process.env.DEADLOCK_BASELINE_ROUND_BUDGET_MS ?? 30_000);
/** Production's report: the deadlock that aborted a Task creation at 2026-08-21 05:53:11. */
const EXPECTED_SQLSTATE = '40P01';
const EXPECTED_FK = 'task_creator_session_id_fkey';

function statement(outcome: ScenarioOutcome, label: string) {
  const found = outcome.statements.find((s) => s.label === label);
  assert.ok(found, `scenario never recorded an outcome for ${label}`);
  return found;
}

/** The FK the production report named must still be the constraint that puts a Session row lock
 *  in a Task insert's path; if it were renamed or dropped this baseline would be about nothing. */
async function assertProductionFkStillExists(client: Client): Promise<string> {
  const { rows } = await client.query<{ conname: string; confupdtype: string; def: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'task' AND c.contype = 'f'
        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                               WHERE attrelid = t.oid AND attname = 'creator_session_id')]`,
  );
  assert.equal(rows.length, 1, 'task.creator_session_id has no single foreign key');
  assert.equal(rows[0].conname, EXPECTED_FK);
  assert.match(rows[0].def, /REFERENCES session\(id\)/);
  return rows[0].def;
}

async function main(): Promise<void> {
  const url = process.env.COORDINATOR_PG_URL;
  assertCoordinatorPgUrlIsIsolated(url);

  const admin = new Client({ connectionString: url });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const fkDef = await assertProductionFkStillExists(admin);
  console.log(`two-party 40P01 baseline · ${ROUNDS} rounds · ${EXPECTED_FK} ${fkDef}`);

  let firstEvidence: unknown;
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      const ids = newFixtureIds(`p40-${round}`);
      await seedLockFixture(admin, ids);
      const outcome = await runScenario(url, twoPartyDeadlockScenario(ids), ROUND_BUDGET_MS);

      // 1. The victim, its SQLSTATE, and the wait edge that produced it.
      const victim = statement(outcome, 'A5 insert-task-creator-session');
      assert.equal(victim.ok, false, 'the Task insert was expected to lose the deadlock');
      assert.equal(victim.sqlstate, EXPECTED_SQLSTATE, `victim SQLSTATE was ${victim.sqlstate}`);
      // PostgreSQL reports the RI check as the waiting statement, which is what identifies the
      // wait as the foreign key's row lock rather than an explicit one in application SQL.
      assert.match(String(victim.context ?? ''), /FOR KEY SHARE/,
        'the victim did not block inside a FOR KEY SHARE row check');
      assert.match(String(victim.context ?? ''), /"session"/,
        'the FOR KEY SHARE the victim blocked on was not taken on session');

      // 2. Both wait edges, as PostgreSQL reported them while the parties were waiting.
      const edges = Object.fromEntries(outcome.waitEdges.map((e) => [e.label, e]));
      const events = edges['B3 telemetry-session-update'];
      const create = edges['A5 insert-task-creator-session'];
      assert.ok(events && create, 'the scenario did not observe both wait edges');
      assert.deepEqual(events.blockingPids, [outcome.pids['task-create']]);
      assert.deepEqual(create.blockingPids, [outcome.pids['runner-events']]);
      assert.equal(events.waitEventType, 'Lock');
      assert.equal(create.waitEventType, 'Lock');
      // PostgreSQL's own report of the cycle, naming both backends in both directions.
      assert.match(
        String(victim.detail ?? ''),
        new RegExp(
          `Process ${outcome.pids['task-create']} waits for ShareLock on transaction \\d+; ` +
            `blocked by process ${outcome.pids['runner-events']}\\.\\n` +
            `Process ${outcome.pids['runner-events']} waits for ShareLock on transaction \\d+; ` +
            `blocked by process ${outcome.pids['task-create']}\\.`,
        ),
        `deadlock DETAIL did not describe the expected two-party cycle: ${victim.detail}`,
      );

      // The closing edge is a wait on the other transaction, not on a relation: that is the
      // shape of a row-lock conflict (FOR KEY SHARE requested against a held FOR UPDATE).
      const locksOf = (edgeLocks: typeof create.locks, party: string, granted: boolean) =>
        edgeLocks.filter((l) => l.pid === outcome.pids[party] && l.granted === granted);
      const victimWait = locksOf(create.locks, 'task-create', false);
      assert.deepEqual(
        victimWait.map((l) => `${l.locktype}/${l.mode}`),
        ['transactionid/ShareLock'],
        'the victim was not waiting on the other transaction',
      );
      // What the survivor holds while the victim waits: the row lock queue position on the
      // Session it took FOR UPDATE.
      const survivorHeld = locksOf(create.locks, 'runner-events', true);
      assert.ok(
        survivorHeld.some((l) => l.locktype === 'relation' && l.relation === 'session' && l.mode === 'RowShareLock'),
        'the survivor was not holding the FOR UPDATE row-share lock on session',
      );
      // What the victim already holds when it blocks. `user` RowShareLock is
      // TasksService.lockDependencyGraph; the project_event write lock is the outbox trigger
      // that fired on the task insert — i.e. the victim really does have rows to lose.
      const victimHeld = locksOf(create.locks, 'task-create', true).map(
        (l) => `${l.relation ?? l.locktype}/${l.mode}`,
      );
      for (const held of ['\"user\"/RowShareLock', 'task/RowExclusiveLock',
                          'task_dependency/RowExclusiveLock', 'project_event/RowExclusiveLock']) {
        assert.ok(victimHeld.includes(held), `victim was not holding ${held}: ${victimHeld.join(', ')}`);
      }

      // 3. The survivor: its telemetry write and its durable event both commit.
      const survivorWrite = statement(outcome, 'B3 telemetry-session-update');
      assert.equal(survivorWrite.ok, true, `survivor failed: ${survivorWrite.sqlstate}`);
      assert.equal(outcome.committed['runner-events'], true);
      assert.equal(outcome.committed['task-create'], false);
      const survivor = await inspectSurvivor(admin, ids);
      assert.equal(survivor.runEvents, 1);
      assert.equal(survivor.telemetryLastTurnAt, ids.survivorTurnAt.toISOString());

      // 4. The victim rolled back whole — no partial Task, dependency, project_event or dispatch.
      const rollback = await inspectVictimRollback(admin, ids);
      assert.deepEqual(rollback, {
        tasks: 0,
        dependencies: 0,
        projectEvents: 0,
        dispatchActions: 0,
        prerequisiteTouched: false,
      });

      if (round === 1) firstEvidence = { pids: outcome.pids, victim, waitEdges: outcome.waitEdges };
      console.log(
        `round ${String(round).padStart(2)}/${ROUNDS} · victim=task-create ${victim.sqlstate} · ` +
          `edges ${events.waiter}→${events.blockedBy.join()} (${events.waitEvent}) ` +
          `${create.waiter}→${create.blockedBy.join()} (${create.waitEvent}) · rollback clean`,
      );
    }
  } finally {
    if (firstEvidence) {
      console.log('\n--- round 1 evidence ---');
      console.log(JSON.stringify(firstEvidence, null, 2));
    }
    await admin.end().catch(() => undefined);
  }
  console.log(`\nBASELINE HOLDS: ${ROUNDS}/${ROUNDS} rounds ended in ${EXPECTED_SQLSTATE} on Task creation.`);
}

main().catch((e) => {
  console.error(`\nBASELINE FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
