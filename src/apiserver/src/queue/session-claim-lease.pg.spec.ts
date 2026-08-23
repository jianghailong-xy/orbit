import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { RunStatus } from '@prisma/client';
import type { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ReaperService } from '../realtime/reaper.service';
import { QueueService } from './queue.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The claim lease against a real PostgreSQL, with the failures injected where they actually happen.
 *
 * The stubbed specs beside this one can only report the statements they were handed. The property
 * this file exists for is not a statement: it is that after ANY failure between the claim's commit
 * and the runner hearing about it, the session is either being driven or is claimable again — never
 * RUNNING with nobody behind it, holding a slot nothing will give back.
 *
 * So every fault here is injected into the real path rather than mocked around it:
 *
 *   seed        a trigger that refuses the first-turn INSERT
 *   model       a trigger that refuses the model materialization compare-and-set
 *   build       a trigger that refuses the runtime-session-id write
 *   credential  a configured provider whose stored key does not decrypt
 *   provider    the ModelProvider lookup failing the way a lost connection fails it
 *
 * and the races are driven from inside the fault, which is the only place the interleaving they
 * are about can be produced deterministically: the closure runs at exactly the moment between the
 * committed claim and the compensation.
 *
 * Needs a database: `scripts/project-pg-matrix.sh` gives every `*.pg.spec` its own migrated clone.
 * Without COORDINATOR_PG_URL the file reports that it did not run rather than passing quietly.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const OWNER = '00000000-0000-7000-8000-000000000901';
const RUNNER = '00000000-0000-7000-8000-000000000902';
const WORKSPACE = '00000000-0000-7000-8000-000000000903';
const SESSION = '00000000-0000-7000-8000-000000000904';
const OTHER_SESSION = '00000000-0000-7000-8000-000000000905';
// v4-shaped on purpose: `parseLeaseGeneration` refuses anything outside versions 1-5, and the
// runner mints these itself rather than taking them from a table of v7 row ids.
const LEASE_OWNER = '00000000-0000-4000-8000-000000000906';

let client: Client;
let prisma: PrismaService;

type ClientCtor = new (config: { connectionString?: string }) => Client;

before(async () => {
  if (!URL) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  prisma = prismaClientFor(URL) as unknown as PrismaService;
});

after(async () => {
  await (prisma as unknown as { $disconnect(): Promise<void> })?.$disconnect();
  await client?.end();
});

beforeEach(async () => {
  if (!URL) return;
  await dropFaults();
  // Scoped to this file's own fixtures. The migrated schema is not empty — 0080 seeds a reserved
  // `opencode` ModelProvider row whose delete guard raises — so a blanket TRUNCATE here would be a
  // test of the migrations rather than of the claim.
  await resetFixtures();
  await client.query(
    `INSERT INTO "user"(id, email, name, password_hash) VALUES ($1::uuid, 'lease@test', 'lease', 'x')`,
    [OWNER],
  );
  await client.query(
    `INSERT INTO "runner"(id, name, owner_id, status, max_concurrent, token_hash, last_heartbeat_at)
     VALUES ($1::uuid, 'lease-runner', $2::uuid, 'ONLINE', 1, 'x', now())`,
    [RUNNER, OWNER],
  );
  await client.query(
    `INSERT INTO "workspace"(id, name, owner_id, runner_id, work_dir)
     VALUES ($1::uuid, 'lease-ws', $2::uuid, $3::uuid, '/tmp/lease')`,
    [WORKSPACE, OWNER, RUNNER],
  );
  await queueSession(SESSION);
});

/** Remove only what this file creates, in foreign-key order. */
async function resetFixtures(): Promise<void> {
  const ours = [SESSION, OTHER_SESSION];
  await client.query(`DELETE FROM "conversation_turn" WHERE "session_id" = ANY($1::uuid[])`, [ours]);
  await client.query(
    `DELETE FROM "inbox_lease_generation" WHERE "session_id" = ANY($1::uuid[])`,
    [ours],
  );
  await client.query(`DELETE FROM "session" WHERE id = ANY($1::uuid[])`, [ours]);
  await client.query(`DELETE FROM "workspace" WHERE id = $1::uuid`, [WORKSPACE]);
  await client.query(`DELETE FROM "runner" WHERE id = $1::uuid`, [RUNNER]);
  await client.query(`DELETE FROM "model_provider" WHERE slug = 'byok-lease'`);
  await client.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER]);
}

/** One PENDING session assigned to the runner, i.e. exactly what the claim SQL selects. */
async function queueSession(id: string, provider = 'claude'): Promise<void> {
  await client.query(
    // `updated_at` is written by Prisma's client-side @updatedAt, so a raw insert has to supply it.
    `INSERT INTO "session"(id, title, prompt, owner_id, creator_id, assigned_runner_id,
                           workspace_id, provider, provider_builtin, model, status,
                           inbox_lease_owner, updated_at)
     VALUES ($1::uuid, 'lease', 'do the thing', $2::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5, true, 'claude-opus-5', 'PENDING', $6::uuid, now())`,
    [id, OWNER, RUNNER, WORKSPACE, provider, LEASE_OWNER],
  );
}

/** The session as the control plane sees it: what holds a slot, and what still names a handover. */
async function read(id = SESSION): Promise<{
  status: string;
  claimToken: string | null;
  expiresAt: Date | null;
  cancelRequestedAt: Date | null;
}> {
  const { rows } = await client.query(
    `SELECT status, claim_token, claim_lease_expires_at, cancel_requested_at
       FROM "session" WHERE id = $1::uuid`,
    [id],
  );
  return {
    status: rows[0].status,
    claimToken: rows[0].claim_token,
    expiresAt: rows[0].claim_lease_expires_at,
    cancelRequestedAt: rows[0].cancel_requested_at,
  };
}

/** RUNNING is the runner-slot truth, so this is the count the claim's capacity fence reads. */
async function slotsHeld(): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM "session"
      WHERE "assigned_runner_id" = $1::uuid AND status = 'RUNNING'`,
    [RUNNER],
  );
  return rows[0].n;
}

// ── Fault injection ────────────────────────────────────────────────────────────────────────────
//
// Triggers rather than contended unique indexes or stubbed clients: the failure has to arrive
// through the same statement the production path issues, or what is being tested is the harness.

async function failOn(table: string, when: string): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION "claim_lease_fault"() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'INJECTED_FAULT: ${when}' USING ERRCODE = 'raise_exception';
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER "claim_lease_fault_trg"
      BEFORE ${when === 'seed' ? 'INSERT' : `UPDATE OF ${when}`} ON "${table}"
      FOR EACH ROW EXECUTE FUNCTION "claim_lease_fault"();
  `);
}

async function dropFaults(): Promise<void> {
  await client.query(`DROP TRIGGER IF EXISTS "claim_lease_fault_trg" ON "conversation_turn"`);
  await client.query(`DROP TRIGGER IF EXISTS "claim_lease_fault_trg" ON "session"`);
}

/**
 * A client that fails one read, the way a lost connection fails it.
 *
 * The two steps this reaches — the ModelProvider lookup and the first Session read — issue no
 * statement a trigger can intercept, and they are exactly the steps a database blip hits. `run` is
 * called at the moment of the fault, which is how the races below are made deterministic: it is
 * the interleaving point between the committed claim and the compensation.
 */
function faultAt(model: string, method: string, run: () => Promise<void> = async () => {}): PrismaService {
  return new Proxy(prisma as object, {
    get(target, property, receiver) {
      if (property === model) {
        const delegate = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(delegate, {
          get(inner, call) {
            if (call === method) {
              return async () => {
                await run();
                throw new Error(`INJECTED_FAULT: ${model}.${method}`);
              };
            }
            const value = Reflect.get(inner, call);
            return typeof value === 'function' ? value.bind(inner) : value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

function queue(on: PrismaService = prisma): QueueService {
  return new QueueService(on);
}

/** A claim from a runner that advertised `session-claim-lease-v1`, i.e. one that will activate. */
function claim(on: PrismaService = prisma, capable = true): Promise<unknown> {
  return queue(on).claimSessionForRunner({ id: RUNNER }, 0, false, capable);
}

function reaper(): { sweep(): Promise<void> } {
  const realtime = { requestCancel: () => undefined, publish: () => undefined } as never;
  return new ReaperService(prisma, realtime) as unknown as { sweep(): Promise<void> };
}

function controller(): RunnerApiController {
  return new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _s: unknown, content?: string) => content } as never,
  );
}

/** Move the deadline into the past. Time passing is the only thing this stands in for. */
async function expireLease(id = SESSION): Promise<void> {
  await client.query(
    `UPDATE "session" SET "claim_lease_expires_at" = now() - interval '1 second'
      WHERE id = $1::uuid AND "claim_lease_expires_at" IS NOT NULL`,
    [id],
  );
}

// ── The failures the claim itself sees ─────────────────────────────────────────────────────────

test('every buildSession fault leaves the session claimable and the slot free', { skip }, async () => {
  const faults: Array<[string, () => Promise<void>, () => Promise<unknown>]> = [
    // The first-turn seed, inside the retried transaction buildSession owns.
    ['seed', () => failOn('conversation_turn', 'seed'), () => claim()],
    // The model materialization compare-and-set. Reached by a session with no model of its own.
    [
      'model',
      async () => {
        await client.query(`UPDATE "session" SET model = NULL WHERE id = $1::uuid`, [SESSION]);
        await failOn('session', 'model');
      },
      () => claim(),
    ],
    // The runtime-session-id write — a Claude row that has no conversation to resume yet.
    ['build', () => failOn('session', 'runtime_session_id'), () => claim()],
    // A configured provider whose stored key does not decrypt: `decryptSecret` throws inside
    // provider resolution, before anything is handed over.
    [
      'credential',
      async () => {
        await client.query(
          `INSERT INTO "model_provider"(id, slug, label, runtime, base_url, api_key_enc, enabled,
                                        updated_at)
           VALUES (gen_random_uuid(), 'byok-lease', 'BYOK', 'claude', 'https://x', 'not-encrypted',
                   true, now())`,
        );
        await client.query(
          `UPDATE "session" SET provider = 'byok-lease', provider_builtin = false WHERE id = $1::uuid`,
          [SESSION],
        );
      },
      () => claim(),
    ],
    // The ModelProvider lookup itself failing, which is what a database blip looks like here.
    [
      'provider',
      async () => {
        await client.query(
          `UPDATE "session" SET provider = 'byok-lease', provider_builtin = false WHERE id = $1::uuid`,
          [SESSION],
        );
      },
      () => claim(faultAt('modelProvider', 'findFirst')),
    ],
  ];

  for (const [name, arm, run] of faults) {
    await dropFaults();
    await client.query(`DELETE FROM "conversation_turn" WHERE "session_id" = $1::uuid`, [SESSION]);
    await client.query(`DELETE FROM "session" WHERE id = $1::uuid`, [SESSION]);
    await queueSession(SESSION);
    await arm();

    await assert.rejects(run(), /INJECTED_FAULT|malformed encrypted secret/, `${name} should fail`);

    const after = await read();
    assert.equal(after.status, RunStatus.PENDING, `${name}: the session is claimable again`);
    assert.equal(after.claimToken, null, `${name}: the handover is no longer named`);
    assert.equal(after.expiresAt, null, `${name}: and neither is its deadline`);
    assert.equal(await slotsHeld(), 0, `${name}: the runner slot is free`);
  }
});

test('a session put back by the compensation is claimed again, on the same slot', { skip }, async () => {
  // The bug this whole unit is about is a slot that never comes back. `max_concurrent` is 1, so a
  // wedged RUNNING row would make every later claim return null forever.
  await failOn('conversation_turn', 'seed');
  await assert.rejects(claim(), /INJECTED_FAULT/);
  await dropFaults();

  const job = (await claim()) as { sessionId: string } | null;
  assert.equal(job?.sessionId, SESSION);
  assert.equal(await slotsHeld(), 1);
  const held = await read();
  assert.match(String(held.claimToken), /^[0-9a-f-]{36}$/);
  assert.notEqual(held.expiresAt, null);
});

test('a RUNNING claim really does hold the runner slot while it stands', { skip }, async () => {
  await queueSession(OTHER_SESSION);
  assert.notEqual(await claim(), null);
  assert.equal(await slotsHeld(), 1);
  // Which is why an unactivated claim that nothing takes back is an outage and not an untidiness.
  assert.equal(await claim(), null, 'the second session cannot be claimed while the slot is held');
});

// ── Claim uniqueness ───────────────────────────────────────────────────────────────────────────

test('concurrent claims produce one winner and one handover', { skip }, async () => {
  await client.query(`UPDATE "runner" SET max_concurrent = 4 WHERE id = $1::uuid`, [RUNNER]);
  const results = await Promise.all([claim(), claim(), claim()]);
  const won = results.filter((job) => job !== null);
  assert.equal(won.length, 1, 'exactly one claim of one PENDING session');
  assert.equal(await slotsHeld(), 1);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM "session" WHERE "claim_token" IS NOT NULL`,
  );
  assert.equal(rows[0].n, 1, 'and exactly one row names a handover');
});

test('two claimed sessions never share a token', { skip }, async () => {
  await client.query(`UPDATE "runner" SET max_concurrent = 4 WHERE id = $1::uuid`, [RUNNER]);
  await queueSession(OTHER_SESSION);
  await claim();
  await claim();
  const { rows } = await client.query(
    `SELECT count(DISTINCT "claim_token")::int AS distinct_tokens, count(*)::int AS claimed
       FROM "session" WHERE "claim_token" IS NOT NULL`,
  );
  assert.equal(rows[0].claimed, 2);
  assert.equal(rows[0].distinct_tokens, 2);
});

// ── The races the compensation must lose ───────────────────────────────────────────────────────

test('a compensation cannot requeue a session that was cancelled meanwhile', { skip }, async () => {
  const cancel = async () => {
    await client.query(`UPDATE "session" SET cancel_requested_at = now() WHERE id = $1::uuid`, [
      SESSION,
    ]);
  };
  await assert.rejects(claim(faultAt('runEvent', 'aggregate', cancel)), /INJECTED_FAULT/);

  const after = await read();
  // It has to SETTLE, and the reaper's cancel grace is what settles it. Putting it back into a
  // queue whose predicate excludes cancelled rows would strand it with nobody coming.
  assert.equal(after.status, RunStatus.RUNNING);
  assert.notEqual(after.cancelRequestedAt, null);
});

test('a compensation cannot undo a resume that already requeued the session', { skip }, async () => {
  const resume = async () => {
    // What `SessionsService.resume` writes: the row goes back to PENDING under its own row lock.
    await client.query(`UPDATE "session" SET status = 'PENDING' WHERE id = $1::uuid`, [SESSION]);
  };
  await assert.rejects(claim(faultAt('runEvent', 'aggregate', resume)), /INJECTED_FAULT/);

  const after = await read();
  assert.equal(after.status, RunStatus.PENDING);
  // The resume's own queued turn is what runs next; the token the dead claim left is inert and the
  // next claim overwrites it.
  assert.notEqual(after.claimToken, null, 'the stale token was not cleared by a compensation');
});

test('a compensation cannot take back a claim that has since been activated', { skip }, async () => {
  const activate = async () => {
    await controller().activateLeases({ id: RUNNER }, SESSION, {
      leaseGeneration: randomUUID(),
      leaseOwner: LEASE_OWNER,
    });
  };
  await assert.rejects(claim(faultAt('runEvent', 'aggregate', activate)), /INJECTED_FAULT/);

  const after = await read();
  assert.equal(after.status, RunStatus.RUNNING, 'an engine is driving it; it keeps its slot');
  assert.equal(after.claimToken, null, 'activation retired the lease');
});

test('a compensation cannot take back a claim a newer one replaced', { skip }, async () => {
  const reclaim = async () => {
    // What a second claim writes: the same transition, a different handover. The first claim's
    // compensation names a token this row no longer carries.
    await client.query(
      `UPDATE "session" SET "claim_token" = gen_random_uuid() WHERE id = $1::uuid`,
      [SESSION],
    );
  };
  await assert.rejects(claim(faultAt('runEvent', 'aggregate', reclaim)), /INJECTED_FAULT/);

  assert.equal((await read()).status, RunStatus.RUNNING);
  assert.notEqual((await read()).claimToken, null);
});

// ── The failure the API server never sees ──────────────────────────────────────────────────────

test('a lost claim response is reclaimed by the watchdog once the lease expires', { skip }, async () => {
  // Nothing failed here: the claim committed and the payload was built. The response never
  // arrived, so no process is driving a session that is holding a slot — the one failure the
  // synchronous compensation cannot see.
  assert.notEqual(await claim(), null);
  assert.equal(await slotsHeld(), 1);

  await reaper().sweep();
  assert.equal((await read()).status, RunStatus.RUNNING, 'not while the lease still stands');

  await expireLease();
  await reaper().sweep();

  const after = await read();
  assert.equal(after.status, RunStatus.PENDING);
  assert.equal(after.claimToken, null);
  assert.equal(after.expiresAt, null);
  assert.equal(await slotsHeld(), 0);
  assert.notEqual(await claim(), null, 'and the work is picked up again');
});

test('an activation beats an expiry, whichever order they arrive in', { skip }, async () => {
  assert.notEqual(await claim(), null);
  await expireLease();
  await controller().activateLeases({ id: RUNNER }, SESSION, {
    leaseGeneration: randomUUID(),
    leaseOwner: LEASE_OWNER,
  });

  await reaper().sweep();

  const after = await read();
  assert.equal(after.status, RunStatus.RUNNING, 'the sweep must not interrupt a live turn');
  assert.equal(after.claimToken, null);
  assert.equal(await slotsHeld(), 1);
});

// ── Mixed versions ─────────────────────────────────────────────────────────────────────────────

test('a runner that cannot activate is never swept, however long its claim stands', { skip }, async () => {
  const job = (await claim(prisma, false)) as { sessionId: string } | null;
  assert.equal(job?.sessionId, SESSION);

  const claimed = await read();
  assert.notEqual(claimed.claimToken, null, 'it is still a named handover the claim can undo');
  assert.equal(claimed.expiresAt, null, 'but it may never be reclaimed by the sweep');

  await expireLease(); // a no-op: there is no deadline to move
  await reaper().sweep();
  assert.equal((await read()).status, RunStatus.RUNNING);
  assert.equal(await slotsHeld(), 1);
});

test('a legacy claim is still compensated when its build fails', { skip }, async () => {
  // The half of the fix every runner gets: it happens before that runner is handed anything, so it
  // needs no promise from it.
  await failOn('conversation_turn', 'seed');
  await assert.rejects(claim(prisma, false), /INJECTED_FAULT/);

  assert.equal((await read()).status, RunStatus.PENDING);
  assert.equal(await slotsHeld(), 0);
});

// ── Rollback ───────────────────────────────────────────────────────────────────────────────────

test('the flag returns the old behaviour, and drains rather than stranding', { skip }, async () => {
  // 1. A lease is outstanding when the flag is flipped.
  assert.notEqual(await claim(), null);
  assert.notEqual((await read()).claimToken, null);

  process.env.ORBIT_CLAIM_LEASE = 'off';
  try {
    // 2. The watchdog stops, so the outstanding lease is inert rather than reclaimed under a
    //    process that no longer maintains it. This is what "drain before flipping" means: the
    //    activation that clears it still works, because clearing is unconditional.
    await expireLease();
    await reaper().sweep();
    assert.equal((await read()).status, RunStatus.RUNNING);

    await controller().activateLeases({ id: RUNNER }, SESSION, {
      leaseGeneration: randomUUID(),
      leaseOwner: LEASE_OWNER,
    });
    assert.equal((await read()).claimToken, null, 'the drain completes on the old path too');

    // 3. And a claim taken with the flag off is exactly what it was before migration 0157 — on a
    //    session that has never been claimed, so the seed it fails on is the real first one.
    await client.query(`UPDATE "session" SET status = 'SUCCEEDED' WHERE id = $1::uuid`, [SESSION]);
    await queueSession(OTHER_SESSION);
    await failOn('conversation_turn', 'seed');
    await assert.rejects(claim(), /INJECTED_FAULT/);
    const wedged = await read(OTHER_SESSION);
    assert.equal(wedged.status, RunStatus.RUNNING, 'the old behaviour, restored in full');
    assert.equal(wedged.claimToken, null, 'nothing was written to be left behind');
    assert.equal(await slotsHeld(), 1, 'including the slot leak this unit exists to fix');
  } finally {
    delete process.env.ORBIT_CLAIM_LEASE;
  }
});
