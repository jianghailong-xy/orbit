/**
 * 0259's data model, against a real PostgreSQL.
 *
 * What this unit delivers IS database constraints, so there is nothing here a TypeScript assertion
 * could witness: whether a CHECK actually refuses a row, whether a partial unique index treats two
 * NULLs as distinct, and whether the planner can answer a query from an index are three questions
 * only a server answers. A hand-built schema subset would only ever be consistent with itself.
 *
 * Every assertion is therefore on BEHAVIOUR — "write a row that violates it and see it refused" —
 * rather than on the presence of a name in the catalog. The two are different propositions, and
 * only the first is what the Watch contract (`contracts/watch.contract.json`) promises. The one
 * place a catalog read appears is the index coverage, and even there the assertion is that the
 * PLANNER uses the index for the query shape, not that a row exists in `pg_indexes`.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-schema.pg.spec.ts
 *
 * Non-destructive: it writes only rows carrying its own uuid prefix and deletes them afterwards,
 * so it shares the migrated database with every other spec. It drops nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Fixture ids all carry this prefix; cleanup goes by it, never by emptying a table. */
const FIX = '0259a259-0259-4259-8259-';
const id = (n: string) => `${FIX}${n.padStart(12, '0')}`;

const OWNER = id('1');
const OTHER_OWNER = id('2');
const OBSERVER = id('10');
const TARGET_SESSION = id('11');
const TARGET_TASK = id('20');

/** An hour from now: every fixture watch is comfortably inside its TTL. */
const soon = () => new Date(Date.now() + 60 * 60 * 1000);

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const client = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function cleanup(client: Client): Promise<void> {
  // `watch` cascades to targets, matches and deliveries, but each is named explicitly so this
  // still finishes the job on a failure path that only built half a fixture.
  await client.query(`DELETE FROM "watch_delivery" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "watch_match" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "watch_target" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "watch" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "session" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "task" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "user" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
}

async function seed(client: Client): Promise<void> {
  await cleanup(client);
  // Raw-SQL fixtures must supply `updated_at` themselves on the older tables: Prisma's `@updatedAt`
  // is client-side, and `session`/`task` carry no database default for it. (0259's own four tables
  // deliberately do, which is why no INSERT below mentions it.)
  await client.query(
    `INSERT INTO "user"("id","email","name","password_hash")
     VALUES ($1,$2,'watcher','h'), ($3,$4,'other','h')`,
    [OWNER, `${FIX}a@watch.invalid`, OTHER_OWNER, `${FIX}b@watch.invalid`],
  );
  await client.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at")
     VALUES ($1,'observer','p',$2,$2,now()), ($3,'target','p',$2,$2,now())`,
    [OBSERVER, OWNER, TARGET_SESSION],
  );
  await client.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion")
     VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT')`,
    [TARGET_TASK, OWNER],
  );
}

/** Insert a watch; defaults are a legal one-shot RESUME_SESSION watch. Override to build a counter-example. */
function insertWatch(client: Client, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: id('100'),
    owner_id: OWNER,
    observer_type: 'SESSION',
    observer_session_id: OBSERVER,
    predicate: JSON.stringify({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }),
    mode: 'ONE_SHOT',
    action: 'RESUME_SESSION',
    expires_at: soon(),
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "watch"(${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

function insertTarget(client: Client, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: id('200'),
    watch_id: id('100'),
    target_kind: 'TASK',
    target_resource_id: TARGET_TASK,
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "watch_target"(${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

function insertMatch(client: Client, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: id('300'),
    watch_id: id('100'),
    generation: 1,
    reason: 'every target reached a terminal status',
    predicate_version: 1,
    per_target_snapshot: JSON.stringify({ targets: [{ kind: 'TASK', state: 'SATISFIED' }] }),
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "watch_match"(${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

function insertDelivery(client: Client, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: id('400'),
    match_id: id('300'),
    action: 'RESUME_SESSION',
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "watch_delivery"(${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

/** Assert the statement is refused, and that the refusal names the constraint we meant. */
async function refuses(run: () => Promise<unknown>, expected: RegExp, why: string): Promise<void> {
  const error = await run().then(() => null, (e: Error) => e);
  assert.ok(error, `${why} — this write should have been refused, but it succeeded`);
  assert.match(error.message, expected, why);
}

test('0259 · the Watch data model', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const client = await connect();
  t.after(async () => {
    await cleanup(client).catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  // ── the headline: a duplicate is impossible, not unlikely ───────────────────────────────────

  await t.test('a one-shot watch cannot record a second Match', async () => {
    await seed(client);
    await insertWatch(client, { generation: 1, state: 'MATCHED' });
    await insertMatch(client);

    // The same crossing arriving twice — a duplicated hint, a restarted evaluator, two workers.
    await refuses(() => insertMatch(client, { id: id('301') }),
      /watch_match_watch_generation_key/,
      'a second Match at the same generation is what the unique key exists to make impossible');

    // And the generation that would have made a second Match legal cannot be reached either. Both
    // halves are needed: without this CHECK, advancing to 2 and inserting again would be allowed.
    await refuses(
      () => client.query(`UPDATE "watch" SET "generation" = 2 WHERE "id" = $1`, [id('100')]),
      /watch_one_shot_generation_chk/,
      'ONE_SHOT settles at MATCHED; generation 2 is the state a second Match would be legal from');
  });

  await t.test('a continuous watch may cross again — the positive control for the two above',
    async () => {
      await seed(client);
      // Identical to the refused case in every respect except the mode — and the debounce window and
      // wake budget 0271 requires of a CONTINUOUS watch, with room for generation 2 — so the two
      // refusals above are attributable to one-shot semantics and not to some other constraint.
      await insertWatch(client, { mode: 'CONTINUOUS', generation: 2, debounce_seconds: 10, wake_budget: 2 });
      await insertMatch(client, { generation: 1 });
      await insertMatch(client, { id: id('302'), generation: 2 });
      const matches = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "watch_match" WHERE "watch_id" = $1`, [id('100')]);
      assert.equal(matches.rows[0].n, '2', 'a continuous watch records one Match per crossing');
    });

  await t.test('one Match causes one Delivery per action', async () => {
    await seed(client);
    await insertWatch(client, { generation: 1, state: 'MATCHED' });
    await insertMatch(client);
    await insertDelivery(client);

    await refuses(() => insertDelivery(client, { id: id('401') }),
      /watch_delivery_match_action_key/,
      'a redelivered Match must adopt the delivery already recorded, not enqueue a second wake');

    // A Match with no generation-2 sibling still has room for the OTHER action, which is what the
    // key is keyed on — this is the boundary, not an accident of the row being unique by id.
    await insertDelivery(client, { id: id('402'), action: 'NOTIFY_USER' });
  });

  // ── the three queries the acceptance names, proven by the planner ───────────────────────────

  await t.test('the target, owner and due-evaluation queries are answered from an index',
    async () => {
      await seed(client);
      await insertWatch(client);
      await insertTarget(client);

      // `enable_seqscan = off` does not force an index that cannot answer the query: with no
      // usable index the planner still returns a sequential scan (at a punitive cost). So a plan
      // naming the index is evidence the index COVERS this query shape, which is the property
      // being claimed — stronger than reading the name back out of `pg_indexes`.
      const planFor = async (sql: string): Promise<string> => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`);
          return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        } finally {
          await client.query('ROLLBACK');
        }
      };

      const cases: Array<[string, string, string]> = [
        ['by target',
          `SELECT "watch_id" FROM "watch_target"
            WHERE "target_kind" = 'TASK' AND "target_resource_id" = '${TARGET_TASK}'`,
          'watch_target_resource_idx'],
        ['by owner',
          `SELECT "id" FROM "watch" WHERE "owner_id" = '${OWNER}' AND "state" = 'ACTIVE'`,
          'watch_owner_state_idx'],
        ['by due evaluation',
          `SELECT "id" FROM "watch" WHERE "next_evaluate_at" <= now()`,
          'watch_due_idx'],
        ['by observer session',
          `SELECT "id" FROM "watch" WHERE "observer_session_id" = '${OBSERVER}'`,
          'watch_observer_session_idx'],
        ['by due delivery',
          `SELECT "id" FROM "watch_delivery"
            WHERE "state" = 'PENDING' AND "next_attempt_at" <= now()`,
          'watch_delivery_due_idx'],
      ];
      for (const [name, sql, index] of cases) {
        assert.match(await planFor(sql), new RegExp(index),
          `the ${name} query does not use ${index} — an unindexed sweep over every watch is the ` +
          'cost this index exists to remove');
      }
    });

  // ── TTL, scheduling and the sweep's invariants ──────────────────────────────────────────────

  await t.test('a terminal watch is never left scheduled, and nothing is scheduled past its TTL',
    async () => {
      await seed(client);
      const expires = soon();
      await insertWatch(client, { expires_at: expires, next_evaluate_at: new Date(Date.now() + 1000) });

      for (const terminal of ['MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE']) {
        await refuses(
          () => client.query(`UPDATE "watch" SET "state" = $2 WHERE "id" = $1`, [id('100'), terminal]),
          /watch_terminal_not_scheduled_chk/,
          `a ${terminal} watch that is still scheduled would be swept forever, and would sit in ` +
          'the due index doing it');
      }
      // Settling it means clearing the schedule in the same statement, which is the whole point.
      await client.query(
        `UPDATE "watch" SET "state" = 'MATCHED', "next_evaluate_at" = NULL WHERE "id" = $1`,
        [id('100')]);

      // And the TTL bound that lets one sweep serve both evaluation and expiry.
      await refuses(
        () => insertWatch(client, {
          id: id('101'), expires_at: expires, next_evaluate_at: new Date(expires.getTime() + 1000),
        }),
        /watch_next_evaluate_within_ttl_chk/,
        'a watch scheduled after it expires is one the sweep reaches only once it is too late');
    });

  await t.test('the TTL itself is mandatory', async () => {
    await seed(client);
    await refuses(() => insertWatch(client, { expires_at: null }),
      /null value in column "expires_at"|not-null/,
      'there is no "watch forever": a watch nobody sees expiring is the failure being designed out');
  });

  // ── the observer, and the action that needs one ─────────────────────────────────────────────

  await t.test('the observer is a session or a user, and never half of each', async () => {
    await seed(client);
    // PostgreSQL evaluates CHECKs in alphabetical order by constraint name and reports the FIRST
    // one a row violates, so an input that breaks two of them says nothing about which rule is
    // being tested. Each row below therefore violates exactly one: `action` is NOTIFY_USER
    // wherever the session is null, so `watch_resume_needs_session_chk` stays satisfied, and the
    // ROBOT row keeps its session null so `watch_observer_shape_chk` does too.
    await refuses(
      () => insertWatch(client, {
        observer_type: 'SESSION', observer_session_id: null, action: 'NOTIFY_USER',
      }),
      /watch_observer_shape_chk/, 'a SESSION observer with no session can never be resumed');
    await refuses(
      () => insertWatch(client, { observer_type: 'USER', observer_session_id: OBSERVER, action: 'NOTIFY_USER' }),
      /watch_observer_shape_chk/,
      'a USER-observed watch carrying a session would wake a conversation its owner thinks is only notified');
    await refuses(
      () => insertWatch(client, {
        observer_type: 'ROBOT', observer_session_id: null, action: 'NOTIFY_USER',
      }),
      /watch_observer_type_chk/, 'the observer kinds are a closed set');

    // RESUME_SESSION has nowhere to put a turn without one, so the column refuses it.
    await refuses(
      () => insertWatch(client, { observer_type: 'USER', observer_session_id: null, action: 'RESUME_SESSION' }),
      /watch_resume_needs_session_chk/,
      'a resume with no session to resume is an action that cannot be carried out');
    // The legal pairing of the same shape: a user-observed NOTIFY_USER watch.
    await insertWatch(client, {
      id: id('102'), observer_type: 'USER', observer_session_id: null, action: 'NOTIFY_USER',
    });
  });

  // ── the target set: frozen, deduplicated, and outliving its targets ─────────────────────────

  await t.test('a target appears once per watch', async () => {
    await seed(client);
    await insertWatch(client);
    await insertTarget(client);
    await refuses(() => insertTarget(client, { id: id('201') }),
      /watch_target_watch_resource_key/,
      'a target named twice is counted twice by ALL and ANY, and fires a debounced watch twice');
    // The same resource under the other kind, and the same resource on another watch, are both
    // different rows — the key is what makes them different, not the id.
    await insertTarget(client, { id: id('202'), target_kind: 'SESSION', target_resource_id: TARGET_SESSION });
  });

  await t.test('deleting a target leaves the observation standing, so it can be recorded as GONE',
    async () => {
      await seed(client);
      await insertWatch(client);
      await insertTarget(client);

      // The deliberate absence of a foreign key, stated as behaviour. With one, this DELETE would
      // either be refused or would take the watch_target row with it — and "every target is GONE"
      // is how a watch reaches UNRESOLVABLE, so the evidence has to outlive the target.
      await client.query(`DELETE FROM "task" WHERE "id" = $1`, [TARGET_TASK]);
      const survived = await client.query<{ state: string; resource: string }>(
        `SELECT "state", "target_resource_id"::text AS resource FROM "watch_target" WHERE "id" = $1`,
        [id('200')]);
      assert.equal(survived.rowCount, 1,
        'the target row was erased with its target — the watch can no longer say what went missing');
      assert.equal(survived.rows[0].resource, TARGET_TASK);

      await client.query(`UPDATE "watch_target" SET "state" = 'GONE' WHERE "id" = $1`, [id('200')]);
      await refuses(
        () => client.query(`UPDATE "watch_target" SET "state" = 'VANISHED' WHERE "id" = $1`, [id('200')]),
        /watch_target_state_chk/, 'the target states are a closed set');
    });

  await t.test('the snapshot source is recorded whole or not at all', async () => {
    await seed(client);
    await insertWatch(client);
    await refuses(() => insertTarget(client, { snapshot_source_kind: 'TASK_LIST' }),
      /watch_target_snapshot_source_shape_chk/, 'a source kind naming no row resolves to nothing');
    await refuses(() => insertTarget(client, { snapshot_source_id: id('900') }),
      /watch_target_snapshot_source_shape_chk/,
      'a source id with no kind cannot be resolved — the two kinds live in different tables');
    await refuses(
      () => insertTarget(client, { snapshot_source_kind: 'SESSION', snapshot_source_id: id('900') }),
      /watch_target_snapshot_source_kind_chk/,
      'only TASK_LIST and PROJECT are snapshot sources; SESSION is a target kind');
    await insertTarget(client, { snapshot_source_kind: 'PROJECT', snapshot_source_id: id('900') });
  });

  // ── the delivery lane: lease, retry, dead letter ────────────────────────────────────────────

  await t.test('IN_FLIGHT and "held under a lease" are the same statement', async () => {
    await seed(client);
    await insertWatch(client, { generation: 1, state: 'MATCHED' });
    await insertMatch(client);

    await refuses(() => insertDelivery(client, { state: 'IN_FLIGHT' }),
      /watch_delivery_lease_shape_chk/,
      'an IN_FLIGHT delivery no worker owns is one nothing will ever reclaim');
    await refuses(
      () => insertDelivery(client, { state: 'IN_FLIGHT', lease_owner: id('500'), lease_generation: id('501') }),
      /watch_delivery_lease_shape_chk/,
      'a lease with no deadline never expires, so a dead worker holds it forever');
    // And the other direction: a lease on a row that is not in flight.
    await refuses(
      () => insertDelivery(client, {
        state: 'PENDING', lease_owner: id('500'), lease_generation: id('501'),
        lease_deadline_at: soon(),
      }),
      /watch_delivery_lease_shape_chk/, 'a PENDING row carrying a lease is two workers waiting to happen');

    await insertDelivery(client, {
      state: 'IN_FLIGHT', lease_owner: id('500'), lease_generation: id('501'),
      lease_deadline_at: soon(), attempts: 1,
    });
  });

  await t.test('each terminal delivery state carries its moment, and the budget is capped',
    async () => {
      await seed(client);
      await insertWatch(client, { generation: 1, state: 'MATCHED' });
      await insertMatch(client);

      await refuses(() => insertDelivery(client, { state: 'DELIVERED' }),
        /watch_delivery_delivered_shape_chk/, 'a delivery that succeeded at no particular time');
      await refuses(() => insertDelivery(client, { state: 'PENDING', delivered_at: new Date() }),
        /watch_delivery_delivered_shape_chk/, 'a delivery moment on a row that has not been delivered');
      await refuses(() => insertDelivery(client, { state: 'DEAD_LETTER' }),
        /watch_delivery_dead_letter_shape_chk/, 'a dead letter nobody can date');
      await refuses(() => insertDelivery(client, { state: 'SENT' }),
        /watch_delivery_state_chk/, 'the delivery states are a closed set');

      // `maxDeliveryAttempts` is 8 in the contract's limits, so a ninth attempt is not recordable.
      await refuses(() => insertDelivery(client, { attempts: 9 }),
        /watch_delivery_attempts_chk/,
        'past the budget the row is a dead letter; a ninth attempt is not a state it can be in');
      await insertDelivery(client, { attempts: 8, state: 'DEAD_LETTER', dead_lettered_at: new Date() });
    });

  // ── the two jsonb columns that must stay structured ─────────────────────────────────────────

  await t.test('a predicate and a trigger snapshot are objects, never prose', async () => {
    await seed(client);
    // Contract §2's "no shell, no SQL, no log regex, no free-text expression" is a claim about
    // this column, and a JSON string is exactly the shape that would quietly contradict it.
    await refuses(() => insertWatch(client, { predicate: JSON.stringify('tail -f log | grep DONE') }),
      /watch_predicate_object_chk/, 'a predicate that is a string is a free-text expression');

    await insertWatch(client, { generation: 1, state: 'MATCHED' });
    await refuses(
      () => insertMatch(client, { per_target_snapshot: JSON.stringify('$ npm test\nall green\n') }),
      /watch_match_snapshot_object_chk/,
      'shell transcript text in the payload is what contract §6 forbids outright');
    // A Match is also never generation 0 — that number means "never matched".
    await refuses(() => insertMatch(client, { id: id('303'), generation: 0 }),
      /watch_match_generation_chk/, 'generation 0 is the absence of a Match, not a Match');
  });

  // ── tenancy and lifecycle ───────────────────────────────────────────────────────────────────

  await t.test('creation idempotency is per account, and absent keys do not collide', async () => {
    await seed(client);
    await insertWatch(client, { idempotency_key: 'watch:retry:1' });
    await refuses(() => insertWatch(client, { id: id('103'), idempotency_key: 'watch:retry:1' }),
      /watch_owner_idempotency_key/, 'a retried create must resolve to the watch already made');

    // Another account reusing the string is a different watch, not a collision.
    await client.query(
      `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at")
       VALUES ($1,'other observer','p',$2,$2,now())`, [id('12'), OTHER_OWNER]);
    await insertWatch(client, {
      id: id('104'), owner_id: OTHER_OWNER, observer_session_id: id('12'),
      idempotency_key: 'watch:retry:1',
    });
    // And the common case — no key at all — never collides with itself, which is what makes the
    // index partial rather than a row per watch ever made.
    await insertWatch(client, { id: id('105') });
    await insertWatch(client, { id: id('106') });
  });

  await t.test('deleting the watch takes its targets, matches and deliveries with it', async () => {
    await seed(client);
    await insertWatch(client, { generation: 1, state: 'MATCHED' });
    await insertTarget(client);
    await insertMatch(client);
    await insertDelivery(client);

    await client.query(`DELETE FROM "watch" WHERE "id" = $1`, [id('100')]);
    for (const table of ['watch_target', 'watch_match', 'watch_delivery']) {
      const left = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
      assert.equal(left.rows[0].n, '0', `${table} kept a row belonging to a deleted watch`);
    }
  });

  await t.test('deleting the observer session takes the watch it was parked on', async () => {
    await seed(client);
    await insertWatch(client);
    await client.query(`DELETE FROM "session" WHERE "id" = $1`, [OBSERVER]);
    const left = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "watch" WHERE "id" = $1`, [id('100')]);
    assert.equal(left.rows[0].n, '0',
      'an observation nobody can be told about is not an observation');
  });
});
