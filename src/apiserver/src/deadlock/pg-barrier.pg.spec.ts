import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  newFixtureIds,
  seedLockFixture,
  seedThreePartyFixture,
  threePartyDeadlockScenario,
  twoPartyDeadlockScenario,
  type FixtureIds,
} from './orbit-lock-fixture';
import { runScenario, type ScenarioSpec } from './pg-barrier';
import {
  dropHistoricalDispatchTouch,
  installHistoricalDispatchTouch,
} from './pre-0132-dispatch-touch';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * The barrier harness's own properties, against a real fully-migrated PostgreSQL.
 *
 * Everything asserted here is true both before and after the production lock order is repaired:
 * that the scheduler advances on observed server state, that a barrier which never converges is
 * an error rather than a quiet pass, and that the row the two-party plan contends still carries
 * the foreign key the production report named. The claim that today's code LOSES that cycle is
 * the baseline command's (two-party-40p01.baseline.ts), deliberately not a test — a fix has to
 * break it, and a suite that permanently contains a case the fix breaks cannot be read.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable server
 * `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('the barrier harness schedules on observed state', { skip: !URL, timeout: 120_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());

  await t.test('a declared block advances only when PostgreSQL reports the waiter blocked', async () => {
    const ids = newFixtureIds('harness-block');
    await seedLockFixture(admin, ids);
    // Plain row-lock contention on one Session — no cycle, so nothing here depends on the
    // production lock order.
    const spec: ScenarioSpec = {
      name: 'harness/row-lock-handoff',
      parties: [
        { name: 'holder', deadlockTimeout: '30min' },
        { name: 'waiter', deadlockTimeout: '30min' },
      ],
      plan: [
        { op: 'run', party: 'holder', label: 'hold',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId] },
        { op: 'block', party: 'waiter', label: 'wait',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['holder'] },
        { op: 'finish', party: 'holder', action: 'COMMIT' },
        { op: 'settle', party: 'waiter' },
        { op: 'finish', party: 'waiter', action: 'COMMIT' },
      ],
    };
    const outcome = await runScenario(url, spec, 30_000);

    assert.equal(outcome.waitEdges.length, 1);
    const edge = outcome.waitEdges[0];
    assert.deepEqual(edge.blockingPids, [outcome.pids.holder]);
    assert.equal(edge.waitEventType, 'Lock');
    // The waiter's own ungranted lock is recorded, which is what makes the edge evidence and
    // not just a claim.
    assert.ok(
      edge.locks.some((l) => l.pid === outcome.pids.waiter && !l.granted),
      'no ungranted lock was captured for the waiter',
    );
    // Releasing the holder releases the waiter: the barrier observed a real wait, not a sleep.
    assert.deepEqual(
      outcome.statements.filter((s) => s.label === 'wait').map((s) => s.ok),
      [true],
    );
    assert.deepEqual(outcome.committed, { holder: true, waiter: true });
  });

  await t.test('a block that never blocks fails the run instead of passing', async () => {
    const ids = newFixtureIds('harness-nonblock');
    await seedLockFixture(admin, ids);
    const spec: ScenarioSpec = {
      name: 'harness/uncontended',
      parties: [
        { name: 'idle', deadlockTimeout: '30min' },
        { name: 'solo', deadlockTimeout: '30min' },
      ],
      plan: [
        // `idle` holds nothing, so this returns at once and `solo` is never blocked. The
        // scenario must fail rather than record a wait edge that did not happen.
        { op: 'block', party: 'solo', label: 'never-blocks',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['idle'] },
        { op: 'settle', party: 'solo' },
        { op: 'finish', party: 'solo', action: 'COMMIT' },
      ],
    };
    await assert.rejects(
      () => runScenario(url, spec, 1_500),
      /finished without ever blocking/,
      'an unmet barrier must be an error, never a quiet pass',
    );

    // And a plan that declares a block on nobody is rejected outright, rather than being
    // trivially satisfied by an empty blocker set.
    const [blockStep] = spec.plan;
    assert.equal(blockStep.op, 'block');
    await assert.rejects(
      () => runScenario(url, { ...spec, plan: [{ ...blockStep, blockedBy: [] }] }, 1_500),
      /declares a block on nobody/,
    );
  });

  await t.test('an aborted transaction is never reported as committed', async () => {
    const ids = newFixtureIds('harness-aborted');
    await seedLockFixture(admin, ids);
    // A `lock_timeout` is a self-inflicted abort with no bearing on the production lock order:
    // it is here only to produce an aborted transaction cheaply. PostgreSQL then answers COMMIT
    // with the tag ROLLBACK, and `committed` has to say so.
    const spec: ScenarioSpec = {
      name: 'harness/aborted-commit',
      parties: [
        { name: 'holder', deadlockTimeout: '30min' },
        { name: 'loser', deadlockTimeout: '30min' },
      ],
      plan: [
        { op: 'run', party: 'holder', label: 'hold',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId] },
        { op: 'run', party: 'loser', label: 'arm-lock-timeout', sql: `SET LOCAL lock_timeout = '1s'` },
        { op: 'block', party: 'loser', label: 'give-up',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['holder'] },
        { op: 'settle', party: 'loser' },
        { op: 'finish', party: 'loser', action: 'COMMIT' },
        { op: 'finish', party: 'holder', action: 'COMMIT' },
      ],
    };
    const outcome = await runScenario(url, spec, 30_000);
    const gaveUp = outcome.statements.find((s) => s.label === 'give-up');
    assert.equal(gaveUp?.ok, false);
    assert.equal(gaveUp?.sqlstate, '55P03', 'expected lock_not_available');
    assert.deepEqual(outcome.committed, { loser: false, holder: true });
  });

  await t.test('deadlock_timeout is pinned per party, so the victim is configured not raced', async () => {
    const ids = newFixtureIds('harness-timeout');
    await seedLockFixture(admin, ids);
    await assert.rejects(
      () =>
        runScenario(
          url,
          {
            name: 'harness/bad-timeout',
            parties: [{ name: 'p', deadlockTimeout: 'not-a-duration' }],
            plan: [],
          },
          10_000,
        ),
      /could not pin deadlock_timeout|invalid value/i,
    );
  });

  await t.test('the two-party plan still contends the row the production report named', async () => {
    const ids = newFixtureIds('harness-shape');
    const spec = twoPartyDeadlockScenario(ids);
    // The victim's blocking statement names the Session the survivor holds FOR UPDATE — the
    // whole point of the fixture, and the part a careless edit would silently drop.
    const victimStep = spec.plan.find((s) => s.op === 'block' && s.party === 'task-create');
    const survivorLock = spec.plan.find((s) => s.op === 'run' && s.label.startsWith('B1'));
    assert.ok(victimStep && victimStep.op === 'block' && survivorLock && survivorLock.op === 'run');
    assert.match(survivorLock.sql, /FOR UPDATE/);
    assert.ok(survivorLock.values?.includes(ids.contendedSessionId));
    assert.ok(victimStep.values?.includes(ids.contendedSessionId));

    const { rows } = await admin.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'task' AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = t.oid AND attname = 'creator_session_id')]`,
    );
    assert.deepEqual(rows.map((r) => r.conname), ['task_creator_session_id_fkey']);
  });
});

/**
 * Where the three-party plan's locks come from, proved one edge at a time.
 *
 * Two of its three wait edges are taken by a foreign key rather than by any statement the plan
 * writes, and both only exist because the row being written was ALREADY written by the same
 * transaction (ri_triggers.c fires an unchanged-key check when the old row's xmin is the current
 * xact). That is the whole mechanism, and it is invisible in the SQL — so each edge is asserted
 * here against its own control: the same plan minus the earlier write must NOT block.
 *
 * Everything here stays true after the production lock order is repaired. The claim that today's
 * code loses the resulting cycle is three-party-40P01.baseline.ts's, deliberately not a test.
 */
test('the three-party plan blocks where the fixture says it does', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());

  /** The dependency transaction's two statements, with the arming UPDATE optional. */
  const dispatchTouchSpec = (ids: FixtureIds, armed: boolean): ScenarioSpec => ({
    name: `harness/dispatch-touch-${armed ? 'armed' : 'control'}`,
    parties: [
      { name: 'holder', deadlockTimeout: '30min' },
      { name: 'dependency', deadlockTimeout: '30min' },
    ],
    plan: [
      { op: 'run', party: 'holder', label: 'hold-contended-session',
        sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
        values: [ids.contendedSessionId] },
      ...(armed
        ? [{ op: 'run' as const, party: 'dependency', label: 'update-task',
             sql: `UPDATE "task" SET "status" = $2::task_status, "updated_at" = $3 WHERE "id" = $1::uuid`,
             values: [ids.dependentTaskId, 'IN_PROGRESS', ids.telemetryTurnAt] }]
        : []),
      { op: 'block', party: 'dependency', label: 'insert-task-dependency',
        sql: `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
              VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        values: [ids.dependencyId, ids.dependentTaskId, ids.prerequisiteTaskId],
        blockedBy: ['holder'] },
      { op: 'finish', party: 'holder', action: 'ROLLBACK' },
      { op: 'settle', party: 'dependency' },
      { op: 'finish', party: 'dependency', action: 'ROLLBACK' },
    ],
  });

  /** The telemetry transaction's two Session writes, with the first one optional. */
  const sessionWriteSpec = (ids: FixtureIds, armed: boolean): ScenarioSpec => ({
    name: `harness/session-fk-recheck-${armed ? 'armed' : 'control'}`,
    parties: [
      { name: 'owner-lock', deadlockTimeout: '30min' },
      { name: 'telemetry', deadlockTimeout: '30min' },
    ],
    plan: [
      { op: 'run', party: 'owner-lock', label: 'lock-dependency-graph',
        sql: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', values: [ids.ownerId] },
      ...(armed
        ? [{ op: 'run' as const, party: 'telemetry', label: 'telemetry-session-update',
             sql: `UPDATE "session" SET "last_turn_at" = $2, "updated_at" = $2 WHERE "id" = $1::uuid`,
             values: [ids.telemetrySessionId, ids.telemetryTurnAt] }]
        : []),
      { op: 'block', party: 'telemetry', label: 'session-preview-update',
        sql: `UPDATE "session" SET "last_assistant_text" = $2, "updated_at" = $3 WHERE "id" = $1::uuid`,
        values: [ids.telemetrySessionId, 'preview', ids.telemetryTurnAt],
        blockedBy: ['owner-lock'] },
      { op: 'finish', party: 'owner-lock', action: 'ROLLBACK' },
      { op: 'settle', party: 'telemetry' },
      { op: 'finish', party: 'telemetry', action: 'ROLLBACK' },
    ],
  });

  // The harness property this case reads out — a statement naming no Session queueing on one —
  // was observed through `task_dependency_dispatch_touch`, and 0132 removed that trigger. The
  // trigger is rebuilt for the case and dropped again, exactly as the three-party baseline does:
  // what is being asserted is the HARNESS's ability to see a lock nobody wrote, and the touch is
  // the sharpest instrument for it that this repo ever shipped.
  await t.test('the dispatch touch takes a Session row lock only once the task row is ours', async () => {
    await installHistoricalDispatchTouch(admin);
    try {
      const armed = newFixtureIds('touch-armed');
      await seedThreePartyFixture(admin, armed);
      const outcome = await runScenario(url, dispatchTouchSpec(armed, true), 30_000);
      const edge = outcome.waitEdges[0];
      assert.ok(edge, 'the edge insert never blocked');
      assert.deepEqual(edge.blockingPids, [outcome.pids.holder]);
      // The waiter is queued on a `session` row, from a statement that names no session at all.
      assert.deepEqual(
        edge.locks.filter((l) => l.pid === outcome.pids.dependency && l.locktype === 'tuple')
          .map((l) => l.relation),
        ['session'],
      );

      // The control: drop the arming UPDATE and the same insert takes no Session lock whatsoever.
      const control = newFixtureIds('touch-control');
      await seedThreePartyFixture(admin, control);
      await assert.rejects(
        () => runScenario(url, dispatchTouchSpec(control, false), 5_000),
        /finished without ever blocking/,
        'without the earlier task UPDATE the foreign key must not be re-checked',
      );
    } finally {
      // Dropped here rather than at the end of the file's `after`: every later case in this run
      // must measure the schema 0132 leaves behind, not the one this case rebuilt.
      await dropHistoricalDispatchTouch(admin);
    }
  });

  await t.test('a Session write re-checks its owner foreign key only when it is the second one', async () => {
    const armed = newFixtureIds('session-armed');
    await seedThreePartyFixture(admin, armed);
    const outcome = await runScenario(url, sessionWriteSpec(armed, true), 30_000);
    const edge = outcome.waitEdges[0];
    assert.ok(edge, 'the second Session write never blocked');
    assert.deepEqual(edge.blockingPids, [outcome.pids['owner-lock']]);
    assert.deepEqual(
      edge.locks.filter((l) => l.pid === outcome.pids.telemetry && l.locktype === 'tuple')
        .map((l) => l.relation),
      ['"user"'],
    );

    const control = newFixtureIds('session-control');
    await seedThreePartyFixture(admin, control);
    await assert.rejects(
      () => runScenario(url, sessionWriteSpec(control, false), 5_000),
      /finished without ever blocking/,
      'a first Session write must not re-check the owner foreign key',
    );
  });

  await t.test('every project_event in a round is attributable to a named event source', async () => {
    const ids = newFixtureIds('event-source');
    await seedThreePartyFixture(admin, ids);
    const kinds = async (sourceId: string): Promise<string[]> => {
      const { rows } = await admin.query<{ kind: string }>(
        `SELECT "kind" FROM "project_event" WHERE "source_id" = $1::uuid ORDER BY "kind"`,
        [sourceId],
      );
      return rows.map((r) => r.kind);
    };
    // project_session_event_source on a telemetry-only write: the trigger runs and decides there
    // is no signal, which is why the baseline can count the round's outbox rows exactly.
    await admin.query(
      `UPDATE "session" SET "last_turn_at" = $2, "updated_at" = $2 WHERE "id" = $1::uuid`,
      [ids.telemetrySessionId, ids.telemetryTurnAt],
    );
    assert.deepEqual(await kinds(ids.telemetrySessionId), ['session.started']);
    // The same trigger on a status change does enqueue one.
    await admin.query(
      `UPDATE "session" SET "status" = 'AWAITING_INPUT'::run_status, "updated_at" = $2 WHERE "id" = $1::uuid`,
      [ids.telemetrySessionId, ids.telemetryTurnAt],
    );
    assert.deepEqual(await kinds(ids.telemetrySessionId), ['session.awaiting_input', 'session.started']);

    // project_task_event_source and project_task_dependency_event_source, the two the victim's
    // rollback has to erase. `task.created` is the seed's and must survive.
    assert.deepEqual(await kinds(ids.dependentTaskId), ['task.created']);
    await admin.query(
      `UPDATE "task" SET "status" = 'IN_PROGRESS'::task_status, "updated_at" = $2 WHERE "id" = $1::uuid`,
      [ids.dependentTaskId, ids.telemetryTurnAt],
    );
    await admin.query(
      `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [ids.dependencyId, ids.dependentTaskId, ids.prerequisiteTaskId],
    );
    assert.deepEqual(
      await kinds(ids.dependentTaskId),
      ['task.created', 'task.dependency_changed', 'task.status_changed'],
    );
  });

  await t.test('the three-party plan still contends the rows the production report named', async () => {
    const ids = newFixtureIds('three-party-shape');
    const spec = threePartyDeadlockScenario(ids);
    assert.deepEqual(spec.parties.map((p) => p.name), ['dependency', 'runner-inbox', 'telemetry']);
    // Exactly one party may detect the cycle, or the victim would be a race rather than a setting.
    assert.deepEqual(
      spec.parties.filter((p) => p.deadlockTimeout !== '30min').map((p) => p.name),
      ['dependency'],
    );
    // Three declared blocks, forming the ring the baseline asserts.
    const blocks = spec.plan.filter((s) => s.op === 'block');
    assert.deepEqual(
      blocks.map((s) => `${s.party}->${s.op === 'block' ? s.blockedBy.join() : ''}`),
      ['telemetry->dependency', 'runner-inbox->telemetry', 'dependency->runner-inbox'],
    );
    // The closing edge must name the Session the inbox party holds FOR UPDATE, through the task
    // whose creator_session_id it is — the part a careless edit would silently drop.
    const inboxLock = spec.plan.find((s) => s.op === 'run' && s.label.startsWith('I1'));
    const closing = blocks.find((s) => s.party === 'dependency');
    assert.ok(inboxLock && inboxLock.op === 'run' && closing && closing.op === 'block');
    assert.match(inboxLock.sql, /FOR UPDATE/);
    assert.ok(inboxLock.values?.includes(ids.contendedSessionId));
    assert.ok(closing.values?.includes(ids.dependentTaskId));

    // And the seeded row really carries the foreign key the closing edge travels down: without
    // creator_session_id pointing at the contended Session there is no third edge at all.
    await seedThreePartyFixture(admin, ids);
    const { rows } = await admin.query<{ creator_session_id: string | null }>(
      `SELECT "creator_session_id" FROM "task" WHERE "id" = $1::uuid`,
      [ids.dependentTaskId],
    );
    assert.deepEqual(rows.map((r) => r.creator_session_id), [ids.contendedSessionId]);
  });
});
