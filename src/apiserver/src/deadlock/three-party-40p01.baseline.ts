import assert from 'node:assert/strict';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import {
  inspectThreePartyRollback,
  inspectThreePartySurvivors,
  newFixtureIds,
  seedThreePartyFixture,
  threePartyDeadlockScenario,
} from './orbit-lock-fixture';
import { runScenario, type LockRow, type ScenarioOutcome } from './pg-barrier';
import {
  dropHistoricalDispatchTouch,
  installHistoricalDispatchTouch,
} from './pre-0132-dispatch-touch';

/**
 * BASELINE COMMAND — proves what the UNREPAIRED code does today, and nothing else.
 *
 * The 2026-08-21 05:47:43 three-party deadlock: a dependency write loses a cycle it closes
 * through a runner inbox transaction and a telemetry transaction. Like the two-party baseline
 * this is deliberately not a `*.spec.ts` — its assertion is the defect, so the fix must break
 * it, and it reuses `pg-barrier` and `orbit-lock-fixture` verbatim so the post-fix regression
 * can keep the same schedule and only change the claim.
 *
 *   scripts/deadlock-barrier.sh three-party
 *
 * Exit code is the result. A round that cannot even schedule the cycle throws out of the
 * barrier's deadline rather than reporting a pass.
 */

const ROUNDS = Number(process.env.DEADLOCK_BASELINE_ROUNDS ?? 20);
/** Per-round wall clock. Generous next to the 2s detector, tight enough to fail fast. */
const ROUND_BUDGET_MS = Number(process.env.DEADLOCK_BASELINE_ROUND_BUDGET_MS ?? 30_000);
const EXPECTED_SQLSTATE = '40P01';
const VICTIM = 'dependency';
const CLOSING_EDGE = 'D3 insert-task-dependency';

/** The ring this baseline claims, as party names. */
const EXPECTED_CYCLE: Array<[string, string]> = [
  ['dependency', 'runner-inbox'],
  ['runner-inbox', 'telemetry'],
  ['telemetry', 'dependency'],
];

function statement(outcome: ScenarioOutcome, label: string) {
  const found = outcome.statements.find((s) => s.label === label);
  assert.ok(found, `scenario never recorded an outcome for ${label}`);
  return found;
}

/** PostgreSQL's own description of the cycle, read back as party-name edges. */
function cycleFromDetail(outcome: ScenarioOutcome, detail: string): Array<[string, string]> {
  const nameOf = new Map(Object.entries(outcome.pids).map(([name, pid]) => [pid, name]));
  const edges: Array<[string, string]> = [];
  for (const m of detail.matchAll(/Process (\d+) waits for \w+ on transaction \d+; blocked by process (\d+)\./g)) {
    const waiter = nameOf.get(Number(m[1]));
    const blocker = nameOf.get(Number(m[2]));
    assert.ok(waiter && blocker, `deadlock DETAIL named a backend outside the scenario: ${m[0]}`);
    edges.push([waiter, blocker]);
  }
  return edges;
}

const sortEdges = (edges: Array<[string, string]>) =>
  [...edges].map((e) => e.join('->')).sort();

const describe = (locks: LockRow[]) =>
  locks.map((l) => `${l.relation ?? l.locktype}/${l.mode}${l.tuple == null ? '' : ` tuple ${l.tuple}`}`);

/**
 * The schema facts this baseline is about. If any of them moved, the run would still deadlock
 * but would no longer be evidence for the production report, so they are checked once up front
 * rather than inferred from a stack trace.
 */
async function assertProductionLockSourcesStillExist(client: Client): Promise<string[]> {
  const fk = async (table: string, column: string, references: RegExp): Promise<string> => {
    const { rows } = await client.query<{ conname: string; def: string; internal: boolean }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def,
              bool_and(t.tgisinternal) AS internal
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_trigger t ON t.tgconstraint = c.oid
        WHERE r.relname = $1 AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = r.oid AND attname = $2)]
        GROUP BY c.conname, c.oid`,
      [table, column],
    );
    assert.equal(rows.length, 1, `${table}.${column} has no single foreign key`);
    assert.match(rows[0].def, references);
    // The FOR KEY SHARE two of the three edges wait on is taken by these internal constraint
    // triggers, not by any application statement: no SQL in the plan writes `FOR …`.
    assert.equal(rows[0].internal, true, `${rows[0].conname} is not backed by internal RI triggers`);
    return `${rows[0].conname} ${rows[0].def}`;
  };
  const { rows: touch } = await client.query<{ tgname: string; internal: boolean; def: string }>(
    `SELECT t.tgname, t.tgisinternal AS internal, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
      WHERE r.relname = 'task_dependency' AND t.tgname = 'task_dependency_dispatch_touch'`,
  );
  assert.equal(touch.length, 1, 'task_dependency_dispatch_touch is gone');
  // An ordinary user trigger, unlike the two FK checks above — the distinction the lock graph
  // turns on: this one issues the UPDATE, the RI triggers take the row locks it needs.
  assert.equal(touch[0].internal, false);
  assert.match(touch[0].def, /AFTER INSERT OR DELETE OR UPDATE ON public\.task_dependency/);
  return [
    await fk('task', 'creator_session_id', /REFERENCES session\(id\)/),
    await fk('session', 'owner_id', /REFERENCES "user"\(id\)/),
    `${touch[0].tgname} (user trigger)`,
  ];
}

async function main(): Promise<void> {
  const url = process.env.COORDINATOR_PG_URL;
  assertCoordinatorPgUrlIsIsolated(url);

  const admin = new Client({ connectionString: url });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  // The cycle this baseline is evidence for ran through `task_dependency_dispatch_touch`, which
  // 0132 removed. The replayed statements are unchanged; the schema they were issued against is
  // rebuilt here and dropped again in the `finally`, so the baseline stays what it was without
  // holding the schema still. See pre-0132-dispatch-touch.ts.
  await installHistoricalDispatchTouch(admin);
  const sources = await assertProductionLockSourcesStillExist(admin);
  console.log(`three-party 40P01 baseline · ${ROUNDS} rounds`);
  for (const s of sources) console.log(`  lock source · ${s}`);

  let firstEvidence: unknown;
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      const ids = newFixtureIds(`p47-${round}`);
      await seedThreePartyFixture(admin, ids);
      const outcome = await runScenario(url, threePartyDeadlockScenario(ids), ROUND_BUDGET_MS);

      // 1. The victim, its SQLSTATE, and where the lock it died on came from.
      const victim = statement(outcome, CLOSING_EDGE);
      assert.equal(victim.ok, false, 'the dependency write was expected to lose the deadlock');
      assert.equal(victim.sqlstate, EXPECTED_SQLSTATE, `victim SQLSTATE was ${victim.sqlstate}`);
      const context = String(victim.context ?? '');
      // The whole provenance chain in one string: the edge insert fired the dispatch touch, the
      // touch's UPDATE re-ran the foreign key, and the foreign key asked for FOR KEY SHARE on a
      // session row. None of that appears in the statement the party issued.
      assert.match(context, /task_dependency_dispatch_touch/,
        'the victim did not block inside the dispatch touch trigger');
      assert.match(context, /UPDATE "task"/, 'the touch trigger did not reach its task UPDATE');
      assert.match(context, /FOR KEY SHARE/, 'the victim did not block inside a FOR KEY SHARE row check');
      assert.match(context, /"session"/, 'the FOR KEY SHARE the victim blocked on was not taken on session');

      // 2. PostgreSQL's own report of the ring: three edges, in the order this baseline claims.
      assert.deepEqual(
        sortEdges(cycleFromDetail(outcome, String(victim.detail ?? ''))),
        sortEdges(EXPECTED_CYCLE),
        `deadlock DETAIL did not describe the expected three-party cycle: ${victim.detail}`,
      );

      // 3. The same ring, observed while the parties were still waiting.
      const edges = Object.fromEntries(outcome.waitEdges.map((e) => [e.label, e]));
      const preview = edges['P2 session-preview-update'];
      const inbox = edges['I3 telemetry-session-update'];
      const closing = edges[CLOSING_EDGE];
      assert.ok(preview && inbox && closing, 'the scenario did not observe all three wait edges');
      assert.deepEqual(preview.blockingPids, [outcome.pids[VICTIM]]);
      assert.deepEqual(inbox.blockingPids, [outcome.pids.telemetry]);
      assert.deepEqual(closing.blockingPids, [outcome.pids['runner-inbox']]);
      for (const e of [preview, inbox, closing]) assert.equal(e.waitEventType, 'Lock');

      // 4. pg_locks at the moment the ring closed.
      const locksOf = (party: string, granted: boolean) =>
        closing.locks.filter((l) => l.pid === outcome.pids[party] && l.granted === granted);
      for (const party of ['dependency', 'runner-inbox', 'telemetry']) {
        assert.deepEqual(
          describe(locksOf(party, false)),
          ['transactionid/ShareLock'],
          `${party} was not waiting on exactly one other transaction`,
        );
      }
      const held = (party: string) => describe(locksOf(party, true));
      const dependencyHeld = held('dependency');
      // D1's explicit FOR UPDATE, and the rows the victim has already written — including the
      // outbox signal its event-source triggers enqueued. It has something to lose.
      for (const lock of ['"user"/RowShareLock', 'task/RowExclusiveLock',
                          'task_dependency/RowExclusiveLock', 'project_event/RowExclusiveLock']) {
        assert.ok(dependencyHeld.includes(lock), `dependency was not holding ${lock}: ${dependencyHeld}`);
      }
      const inboxHeld = held('runner-inbox');
      assert.ok(inboxHeld.includes('session/RowShareLock'),
        `runner-inbox was not holding I1's FOR UPDATE row-share lock on session: ${inboxHeld}`);
      assert.ok(inboxHeld.includes('run_event/RowExclusiveLock'),
        `runner-inbox had not written its event: ${inboxHeld}`);
      const telemetryHeld = held('telemetry');
      assert.ok(telemetryHeld.includes('session/RowExclusiveLock'),
        `telemetry was not holding the Session row it wrote: ${telemetryHeld}`);
      // The tuple lock names the table whose row the waiter is queued on. `"user"` for the
      // preview update is the foreign key's row lock: the statement itself never mentions user.
      const tupleOn = (party: string) =>
        closing.locks.filter((l) => l.pid === outcome.pids[party] && l.locktype === 'tuple')
          .map((l) => l.relation);
      assert.deepEqual(tupleOn('telemetry'), ['"user"'],
        'the telemetry waiter was not queued on a user row');
      assert.deepEqual(tupleOn('dependency'), ['session'],
        'the dependency waiter was not queued on a session row');

      // 5. Both survivors committed, and each left a mark only it could have written.
      assert.equal(statement(outcome, 'P2 session-preview-update').ok, true);
      assert.equal(statement(outcome, 'I3 telemetry-session-update').ok, true);
      assert.deepEqual(outcome.committed,
        { dependency: false, telemetry: true, 'runner-inbox': true });
      const survivors = await inspectThreePartySurvivors(admin, ids);
      assert.deepEqual(survivors, {
        runEvents: 1,
        telemetryLastTurnAt: ids.inboxTurnAt.toISOString(),
        telemetryPreview: `${ids.label}-telemetry-preview`,
        // project_session_event_source ran on both Session writes and enqueued nothing: a
        // telemetry-only write changes no status and no merge status. So every project_event
        // this round could leave behind is the dependency transaction's, which is what makes
        // the rollback count below exact.
        sessionProjectEvents: 0,
      });

      // 6. The victim rolled back whole: no edge, no status write, no dispatch touch, no outbox.
      const rollback = await inspectThreePartyRollback(admin, ids);
      assert.deepEqual(rollback, {
        dependencies: 0,
        projectEvents: 0,
        dispatchActions: 0,
        dependentTaskStatus: 'OPEN',
        dependentTaskTouched: false,
        dependentTaskDispatchAttempt: '0',
        prerequisiteTouched: false,
      });

      if (round === 1) firstEvidence = { pids: outcome.pids, victim, waitEdges: outcome.waitEdges };
      console.log(
        `round ${String(round).padStart(2)}/${ROUNDS} · victim=${VICTIM} ${victim.sqlstate} · ring ` +
          `${EXPECTED_CYCLE.map(([w, b]) => `${w}→${b}`).join(' ')} · rollback clean`,
      );
    }
  } finally {
    if (firstEvidence) {
      console.log('\n--- round 1 evidence ---');
      console.log(JSON.stringify(firstEvidence, null, 2));
    }
    await dropHistoricalDispatchTouch(admin).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
  console.log(
    `\nBASELINE HOLDS: ${ROUNDS}/${ROUNDS} rounds ended in ${EXPECTED_SQLSTATE} on the dependency write.`,
  );
}

main().catch((e) => {
  console.error(`\nBASELINE FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
