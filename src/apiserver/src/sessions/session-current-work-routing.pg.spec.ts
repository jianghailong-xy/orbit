import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from './sessions.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  RunEventType,
  SESSION_CODEX_STEER_V1,
  SESSION_CURRENT_WORK_ROUTING_V1,
} from '@orbit/shared';

const PG_URL = process.env.ORBIT_TEST_PG_URL;
const OWNER_ID = '71111111-1111-4111-8111-111111111111';
const RUNNER_ID = '72222222-2222-4222-8222-222222222222';
const SESSION_ID = '73333333-3333-4333-8333-333333333333';
const TURN_ID = '74444444-4444-4444-8444-444444444444';
const CLIENT_TURN_ID = '75555555-5555-4555-8555-555555555555';
const MALFORMED_TURN_ID = '76666666-6666-4666-8666-666666666666';
const MALFORMED_LEGACY_ID = '77777777-7777-4777-8777-777777777777';
const MISSING_TARGET_ID = '78888888-8888-4888-8888-888888888888';
const FK_STEER_ID = '79999999-9999-4999-8999-999999999999';
const UNCONFIRMED_STEER_ID = '70000000-0000-4000-8000-000000000007';
const OTHER_SESSION_ID = '70000000-0000-4000-8000-000000000001';
const OTHER_TURN_ID = '70000000-0000-4000-8000-000000000002';
const FIRST_GENERATION = '70000000-0000-4000-8000-000000000003';
const SECOND_GENERATION = '70000000-0000-4000-8000-000000000004';
const FIRST_LEASE_OWNER = '70000000-0000-4000-8000-000000000005';
const SECOND_LEASE_OWNER = '70000000-0000-4000-8000-000000000006';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(
    `DELETE FROM "user" WHERE id = $1::uuid`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'current-work-race@example.test', 'race', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(
       id, name, owner_id, token_hash, status, last_heartbeat_at, capabilities
     ) VALUES (
       $1::uuid, 'current-work-race', $2::uuid, 'test', 'ONLINE', clock_timestamp(), $3::text[]
     )`,
    [RUNNER_ID, OWNER_ID, [SESSION_CURRENT_WORK_ROUTING_V1]],
  );
});

after(async () => {
  if (admin) {
    await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
    await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
    await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
  }
  await prisma?.$disconnect();
  await admin?.end();
});

async function seedStartingWindow(): Promise<void> {
  await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [SESSION_ID]);
  await admin.query(
    `INSERT INTO "session"(
       id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
       provider_builtin, status, num_turns, updated_at
     ) VALUES (
       $1::uuid, 'race', 'opening prompt', $2::uuid, $2::uuid, $3::uuid, 'codex',
       TRUE, 'RUNNING', 0, clock_timestamp()
     )`,
    [SESSION_ID, OWNER_ID, RUNNER_ID],
  );
  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status
     ) VALUES ($1::uuid, $2::uuid, 1, $3, 'message', 'opening prompt', 'PENDING')`,
    [TURN_ID, SESSION_ID, SessionsService.initialTurnClientId(SESSION_ID)],
  );
}

async function waitForBlockedSessionLocker(minimum: number): Promise<void> {
  // The database is isolated for this suite. Ask Postgres for real lock waiters rather than
  // matching adapter-rendered SQL text, which changes between Prisma/pg versions.
  // createTurn explicitly permits a 30s interactive transaction. Keep this database-level
  // synchronization comfortably inside that deadline while allowing a cold CI worker to open
  // the dequeue connection; the former 4s/5s pair was itself a race.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_stat_activity AS activity
        WHERE activity.datname = current_database()
          AND activity.pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(activity.pid)) > 0`,
    );
    if (Number(rows[0].n) >= minimum) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${minimum} Session row-lock waiter(s)`);
}

const pgTest = (name: string, body: () => Promise<void>) =>
  test(name, { skip: PG_URL ? false : 'set ORBIT_TEST_PG_URL to run the routing race' }, body);

pgTest('Codex create/dequeue/ACK startup race atomically binds CURRENT_WORK to one executable', async () => {
  await seedStartingWindow();
  const sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never,
  );
  const runnerApi = new RunnerApiController(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publish: () => undefined,
      publishSessionUpdated: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const dequeue = (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn.bind(runnerApi);

  let atReceiptBoundary!: () => void;
  let releaseReceiptBoundary!: () => void;
  const receiptBoundary = new Promise<void>((resolve) => { atReceiptBoundary = resolve; });
  const receiptRelease = new Promise<void>((resolve) => { releaseReceiptBoundary = resolve; });
  const createPromise = sessions.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'also verify the migration',
    intent: 'CURRENT_WORK',
  }, {
    // This hook runs after idempotency, startup placement and envelope validation, while the
    // Session row is still locked, immediately before the durable fragment is inserted.
    participateCurrentWorkTransaction: async () => {
      atReceiptBoundary();
      await receiptRelease;
    },
  });
  await receiptBoundary;
  const dequeuePromise = dequeue(
    SESSION_ID,
    RUNNER_ID,
    null,
    true,
    [SESSION_CURRENT_WORK_ROUTING_V1],
  );
  try {
    // Prove this is a database interleaving: dequeue has reached the same Session lock and is
    // waiting behind createTurn. No wall-clock sleep or RUNNING-state polling is involved.
    await waitForBlockedSessionLocker(1);
  } catch (error) {
    releaseReceiptBoundary();
    await Promise.allSettled([createPromise, dequeuePromise]);
    throw error;
  }
  releaseReceiptBoundary();

  const [receipt, delivered] = await Promise.all([createPromise, dequeuePromise]);
  assert.equal(receipt.placement, 'startup');
  assert.equal(receipt.targetTurnId, TURN_ID);
  assert.equal(delivered?.turnId, TURN_ID);
  assert.match(delivered?.content ?? '', /opening prompt/);
  assert.match(delivered?.content ?? '', /also verify the migration/);

  const executable = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "conversation_turn"
      WHERE session_id = $1::uuid AND kind IN ('message', 'shell')`,
    [SESSION_ID],
  );
  assert.equal(executable.rows[0].n, '1');
  const fragment = await admin.query<{ deliveredAt: Date | null }>(
    `SELECT delivered_at AS "deliveredAt"
       FROM "conversation_turn_startup_fragment"
      WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, CLIENT_TURN_ID],
  );
  assert.ok(fragment.rows[0].deliveredAt instanceof Date);

  // This is the Codex engine-read proof emitted only after turn/started (app-server) or the
  // first concrete turn event (legacy exec). USER(enqueued/written) is intentionally not enough.
  await runnerApi.events({ id: RUNNER_ID }, SESSION_ID, {
    events: [{
      seq: 1,
      type: RunEventType.USER_DELIVERY,
      turnId: TURN_ID,
      ts: '2026-08-30T12:00:00.000Z',
      payload: { turnId: TURN_ID, delivery: 'acknowledged' },
    }],
  });
  const acknowledged = await admin.query<{ acknowledgedAt: Date | null }>(
    `SELECT acknowledged_at AS "acknowledgedAt"
       FROM "conversation_turn_startup_fragment"
      WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, CLIENT_TURN_ID],
  );
  assert.ok(acknowledged.rows[0].acknowledgedAt instanceof Date);

  // ACK with no assistant/tool output followed by a runner crash is a continuation, not a replay
  // of the combined envelope. The provider already consumed the fragment and its side effects
  // must not be emphasized a second time in the replacement prompt.
  await admin.query(
    `UPDATE "conversation_turn"
        SET lease_deadline_at = clock_timestamp() - interval '1 minute'
      WHERE id = $1::uuid`,
    [TURN_ID],
  );
  const resumed = await dequeue(
    SESSION_ID,
    RUNNER_ID,
    null,
    true,
    [SESSION_CURRENT_WORK_ROUTING_V1],
  );
  assert.equal(resumed?.turnId, TURN_ID);
  assert.match(resumed?.content ?? '', /runner 重启/);
  assert.match(resumed?.content ?? '', /opening prompt/);
  assert.doesNotMatch(resumed?.content ?? '', /also verify the migration/);

  await runnerApi.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId: TURN_ID,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 1,
    costUsd: 0,
  } as never);
  const afterComplete = await admin.query<{
    acknowledgedAt: Date | null;
    failedAt: Date | null;
  }>(
    `SELECT acknowledged_at AS "acknowledgedAt", failed_at AS "failedAt"
       FROM "conversation_turn_startup_fragment"
      WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, CLIENT_TURN_ID],
  );
  assert.ok(afterComplete.rows[0].acknowledgedAt instanceof Date);
  assert.equal(afterComplete.rows[0].failedAt, null, 'flushed ACK must win over target completion');
});

pgTest('steer dequeue commit with a lost response reaches a visible terminal receipt at target completion', async () => {
  await seedStartingWindow();
  await admin.query(
    `UPDATE "runner" SET capabilities = $2::text[], capabilities_reported_at = clock_timestamp()
      WHERE id = $1::uuid`,
    [RUNNER_ID, [SESSION_CURRENT_WORK_ROUTING_V1, SESSION_CODEX_STEER_V1]],
  );
  await admin.query(
    `UPDATE "session" SET num_turns = 1 WHERE id = $1::uuid`,
    [SESSION_ID],
  );
  await admin.query(
    `UPDATE "conversation_turn"
        SET status = 'IN_FLIGHT', delivered_at = clock_timestamp(),
            lease_deadline_at = clock_timestamp() + interval '1 minute'
      WHERE id = $1::uuid`,
    [TURN_ID],
  );
  const sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  const receipt = await sessions.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'exact-target adjustment',
    intent: 'CURRENT_WORK',
  });
  assert.equal(receipt.placement, 'steer');
  assert.equal(receipt.targetTurnId, TURN_ID);

  const runnerApi = new RunnerApiController(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publish: () => undefined,
      publishSessionUpdated: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const delivered = await (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<{ turnId: string; targetTurnId?: string } | null>;
  }).dequeueTurn(
    SESSION_ID,
    RUNNER_ID,
    null,
    true,
    [SESSION_CURRENT_WORK_ROUTING_V1, SESSION_CODEX_STEER_V1],
  );
  assert.equal(delivered?.turnId, receipt.turnId);
  assert.equal(delivered?.targetTurnId, TURN_ID);

  // Treat the successful DB commit as a lost HTTP response: no USER/USER_DELIVERY ACK arrives.
  await runnerApi.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId: TURN_ID,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 1,
    costUsd: 0,
  } as never);
  const terminal = await admin.query<{
    status: string;
    deliveryStatus: string | null;
    failureCode: string | null;
    acknowledgedAt: Date | null;
  }>(
    `SELECT status, delivery_status AS "deliveryStatus",
            delivery_failure_code AS "failureCode",
            delivery_acknowledged_at AS "acknowledgedAt"
       FROM "conversation_turn" WHERE id = $1::uuid`,
    [receipt.turnId],
  );
  assert.deepEqual(terminal.rows[0], {
    status: 'ANSWERED',
    deliveryStatus: 'FAILED',
    failureCode: 'CURRENT_WORK_TARGET_COMPLETED',
    acknowledgedAt: null,
  });
});

pgTest('new heartbeat admission followed by an old poller terminalizes startup and releases the seed', async () => {
  await seedStartingWindow();
  await admin.query(
    `UPDATE "runner" SET capabilities = $2::text[], capabilities_reported_at = clock_timestamp()
      WHERE id = $1::uuid`,
    [RUNNER_ID, [SESSION_CURRENT_WORK_ROUTING_V1]],
  );
  const sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  const receipt = await sessions.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'must not be lost or claimed delivered',
    intent: 'CURRENT_WORK',
  });
  assert.equal(receipt.placement, 'startup');

  const runnerApi = new RunnerApiController(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      publishQueuedTurnsChanged: () => undefined,
      drainInterrupts: async () => [],
      drainMergeRequests: async () => [],
      drainCommitRequests: async () => [],
      drainArtifactRequests: async () => [],
    } as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );

  // An omitted header is a heartbeat from an N-1/downgraded process and must clear the newer
  // process's durable snapshot. The inbox request itself repeats that capability claim.
  await runnerApi.heartbeat(
    { id: RUNNER_ID, version: null },
    { status: 'ONLINE' } as never,
    undefined,
  );
  const capability = await admin.query<{ capabilities: string[] }>(
    `SELECT capabilities FROM "runner" WHERE id = $1::uuid`,
    [RUNNER_ID],
  );
  assert.deepEqual(capability.rows[0].capabilities, []);

  const delivered = await (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(SESSION_ID, RUNNER_ID, null, true, []);
  assert.equal(delivered?.turnId, TURN_ID);
  assert.equal(delivered?.content, 'opening prompt');

  const fragment = await admin.query<{
    failedAt: Date | null;
    failureCode: string | null;
    acknowledgedAt: Date | null;
  }>(
    `SELECT failed_at AS "failedAt", failure_code AS "failureCode",
            acknowledged_at AS "acknowledgedAt"
       FROM "conversation_turn_startup_fragment"
      WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, CLIENT_TURN_ID],
  );
  assert.ok(fragment.rows[0].failedAt instanceof Date);
  assert.equal(fragment.rows[0].failureCode, 'CURRENT_WORK_RUNTIME_CAPABILITY_LOST');
  assert.equal(fragment.rows[0].acknowledgedAt, null);
});

pgTest('old poller takeover retires expired lost-response startup and re-leases only the seed', async () => {
  await seedStartingWindow();
  await admin.query(
    `UPDATE "runner" SET capabilities = $2::text[], capabilities_reported_at = clock_timestamp()
      WHERE id = $1::uuid`,
    [RUNNER_ID, [SESSION_CURRENT_WORK_ROUTING_V1]],
  );
  await admin.query(
    `INSERT INTO "inbox_lease_generation"(generation, session_id, lease_owner)
     VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [FIRST_GENERATION, SESSION_ID, FIRST_LEASE_OWNER],
  );
  await admin.query(
    `UPDATE "session"
        SET inbox_lease_generation = $2::uuid, inbox_lease_owner = $3::uuid
      WHERE id = $1::uuid`,
    [SESSION_ID, FIRST_GENERATION, FIRST_LEASE_OWNER],
  );

  const sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  const receipt = await sessions.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'context accepted by the first generation',
    intent: 'CURRENT_WORK',
  });
  assert.equal(receipt.placement, 'startup');

  const runnerApi = new RunnerApiController(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: () => undefined,
      publish: () => undefined,
      publishSessionUpdated: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const dequeue = (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn.bind(runnerApi);

  // The DB commit succeeds, but model the HTTP response being lost before this generation can
  // persist an engine-read ACK. The seed and receipt are both still durable.
  const lost = await dequeue(
    SESSION_ID,
    RUNNER_ID,
    FIRST_GENERATION,
    true,
    [SESSION_CURRENT_WORK_ROUTING_V1],
  );
  assert.equal(lost?.turnId, TURN_ID);
  assert.match(lost?.content ?? '', /context accepted by the first generation/);
  await admin.query(
    `UPDATE "conversation_turn"
        SET lease_deadline_at = clock_timestamp() - interval '1 minute'
      WHERE id = $1::uuid`,
    [TURN_ID],
  );

  // A new generation is now the one validated under the Session lock. The old generation's
  // expired lease proves its unacknowledged envelope can no longer be completed by a live owner.
  await admin.query(
    `UPDATE "inbox_lease_generation" SET retired_at = clock_timestamp()
      WHERE generation = $1::uuid`,
    [FIRST_GENERATION],
  );
  await admin.query(
    `INSERT INTO "inbox_lease_generation"(generation, session_id, lease_owner)
     VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [SECOND_GENERATION, SESSION_ID, SECOND_LEASE_OWNER],
  );
  await admin.query(
    `UPDATE "session"
        SET inbox_lease_generation = $2::uuid, inbox_lease_owner = $3::uuid
      WHERE id = $1::uuid`,
    [SESSION_ID, SECOND_GENERATION, SECOND_LEASE_OWNER],
  );

  const redelivered = await dequeue(SESSION_ID, RUNNER_ID, SECOND_GENERATION, true, []);
  assert.equal(redelivered?.turnId, TURN_ID);
  assert.equal(redelivered?.content, 'opening prompt');

  const fragment = await admin.query<{
    n: string;
    deliveryStatus: string | null;
    failedAt: Date | null;
    failureCode: string | null;
    acknowledgedAt: Date | null;
  }>(
    `SELECT count(*) OVER ()::text AS n, delivery_status AS "deliveryStatus",
            failed_at AS "failedAt",
            failure_code AS "failureCode", acknowledged_at AS "acknowledgedAt"
       FROM "conversation_turn_startup_fragment"
      WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, CLIENT_TURN_ID],
  );
  assert.equal(fragment.rows[0].n, '1', 'takeover never creates a replacement fragment');
  assert.equal(fragment.rows[0].deliveryStatus, 'UNCONFIRMED');
  assert.ok(fragment.rows[0].failedAt instanceof Date);
  assert.equal(fragment.rows[0].failureCode, 'CURRENT_WORK_RUNTIME_CAPABILITY_LOST');
  assert.equal(fragment.rows[0].acknowledgedAt, null);
  const seed = await admin.query<{ status: string; leaseGeneration: string | null }>(
    `SELECT status, lease_generation AS "leaseGeneration"
       FROM "conversation_turn" WHERE id = $1::uuid`,
    [TURN_ID],
  );
  assert.deepEqual(seed.rows[0], { status: 'IN_FLIGHT', leaseGeneration: SECOND_GENERATION });
});

pgTest('database constraints reject malformed intent/target rows and preserve startup audit', async () => {
  await seedStartingWindow();
  await assert.rejects(
    admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, send_intent
       ) VALUES ($1::uuid, $2::uuid, 2, 'malformed-current', 'message', 'bad', 'PENDING', 'CURRENT_WORK')`,
      [MALFORMED_TURN_ID, SESSION_ID],
    ),
    /conversation_turn_send_intent_shape_check/,
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id
       ) VALUES ($1::uuid, $2::uuid, 2, 'self-target', 'steer', 'bad', 'PENDING',
                 'CURRENT_WORK', $1::uuid)`,
      [MALFORMED_TURN_ID, SESSION_ID],
    ),
    /conversation_turn_send_intent_shape_check/,
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, target_turn_id
       ) VALUES ($1::uuid, $2::uuid, 2, 'malformed-legacy-target', 'message', 'bad', 'PENDING', $3::uuid)`,
      [MALFORMED_LEGACY_ID, SESSION_ID, TURN_ID],
    ),
    /conversation_turn_send_intent_shape_check/,
  );

  await admin.query('BEGIN');
  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id
     ) VALUES ($1::uuid, $2::uuid, 2, 'missing-target', 'steer', 'bad', 'PENDING',
               'CURRENT_WORK', $3::uuid)`,
    [FK_STEER_ID, SESSION_ID, MISSING_TARGET_ID],
  );
  await assert.rejects(admin.query('COMMIT'), /conversation_turn_target_turn_id_fkey/);
  await admin.query('ROLLBACK').catch(() => undefined);

  await assert.rejects(
    admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id,
         delivery_status, delivery_failure_code, delivery_failure_reason, delivery_terminal_at,
         delivery_acknowledged_at
       ) VALUES (
         $1::uuid, $2::uuid, 2, 'contradictory-terminal', 'steer', 'bad', 'ANSWERED',
         'CURRENT_WORK', $3::uuid, 'FAILED', 'FAILED_AFTER_ACK', 'contradictory proof',
         clock_timestamp(), clock_timestamp()
       )`,
      [FK_STEER_ID, SESSION_ID, TURN_ID],
    ),
    /conversation_turn_delivery_terminal_check/,
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO "conversation_turn_startup_fragment"(
         id, session_id, target_turn_id, client_turn_id, content,
         acknowledged_at, failed_at, failure_code, failure_reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'contradictory-startup', 'bad',
         clock_timestamp(), clock_timestamp(), 'FAILED_AFTER_ACK', 'contradictory proof'
       )`,
      [MISSING_TARGET_ID, SESSION_ID, TURN_ID],
    ),
    /conversation_turn_startup_fragment_terminal_check/,
  );

  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id,
       delivered_at, answered_at, delivery_status, delivery_failure_code,
       delivery_failure_reason, delivery_terminal_at
     ) VALUES (
       $1::uuid, $2::uuid, 2, 'unconfirmed-steer', 'steer', 'maybe consumed', 'ANSWERED',
       'CURRENT_WORK', $3::uuid, clock_timestamp(), clock_timestamp(), 'UNCONFIRMED',
       'CURRENT_WORK_SESSION_REAPED', 'Delivery could not be confirmed.', clock_timestamp()
     )`,
    [UNCONFIRMED_STEER_ID, SESSION_ID, TURN_ID],
  );
  await assert.rejects(
    admin.query(
      `UPDATE "conversation_turn"
          SET delivery_status = 'ACKNOWLEDGED',
              delivery_acknowledged_at = clock_timestamp()
        WHERE id = $1::uuid`,
      [UNCONFIRMED_STEER_ID],
    ),
    /conversation_turn_delivery_terminal_check/,
    'a late ACK may not coexist with ambiguous failure fields',
  );
  await admin.query(
    `UPDATE "conversation_turn"
        SET delivery_status = 'ACKNOWLEDGED',
            delivery_acknowledged_at = clock_timestamp(),
            delivery_failure_code = NULL,
            delivery_failure_reason = NULL,
            delivery_terminal_at = NULL
      WHERE id = $1::uuid`,
    [UNCONFIRMED_STEER_ID],
  );
  const resolved = await admin.query<{ status: string; failureCode: string | null }>(
    `SELECT delivery_status AS status, delivery_failure_code AS "failureCode"
       FROM "conversation_turn" WHERE id = $1::uuid`,
    [UNCONFIRMED_STEER_ID],
  );
  assert.deepEqual(resolved.rows[0], { status: 'ACKNOWLEDGED', failureCode: null });
  await admin.query(`DELETE FROM "conversation_turn" WHERE id = $1::uuid`, [UNCONFIRMED_STEER_ID]);

  await admin.query(
    `INSERT INTO "session"(
       id, title, prompt, owner_id, creator_id, status, num_turns, updated_at
     ) VALUES ($1::uuid, 'other', 'other', $2::uuid, $2::uuid, 'RUNNING', 1, clock_timestamp())`,
    [OTHER_SESSION_ID, OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status
     ) VALUES ($1::uuid, $2::uuid, 1, 'other-target', 'message', 'other', 'IN_FLIGHT')`,
    [OTHER_TURN_ID, OTHER_SESSION_ID],
  );
  await admin.query('BEGIN');
  await admin.query(
    `INSERT INTO "conversation_turn"(
       id, session_id, seq, client_turn_id, kind, content, status, send_intent, target_turn_id
     ) VALUES ($1::uuid, $2::uuid, 2, 'cross-session-target', 'steer', 'bad', 'PENDING',
               'CURRENT_WORK', $3::uuid)`,
    [FK_STEER_ID, SESSION_ID, OTHER_TURN_ID],
  );
  await assert.rejects(admin.query('COMMIT'), /conversation_turn_target_turn_id_fkey/);
  await admin.query('ROLLBACK').catch(() => undefined);

  await admin.query(
    `INSERT INTO "conversation_turn_startup_fragment"(
       id, session_id, target_turn_id, client_turn_id, content
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'audit-fragment', 'keep this')`,
    [CLIENT_TURN_ID, SESSION_ID, TURN_ID],
  );
  await admin.query('BEGIN');
  await admin.query(`DELETE FROM "conversation_turn" WHERE id = $1::uuid`, [TURN_ID]);
  await assert.rejects(
    admin.query('COMMIT'),
    /conversation_turn_startup_fragment_target_turn_id_fkey/,
  );
  await admin.query('ROLLBACK').catch(() => undefined);

  const retained = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "conversation_turn_startup_fragment"
      WHERE id = $1::uuid`,
    [CLIENT_TURN_ID],
  );
  assert.equal(retained.rows[0].n, '1');
});
