/**
 * The signed-in pass (docs/managed-runner-signed-in-accounts-design.md) over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, with the manager against the in-memory Kubernetes
 * namespace of test-support/fake-kube-client.ts. The switch is on; no cluster or credential is involved.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-signed-in.pg.spec.ts
 *
 *   (1) an account signed in before the switch went on — a live refresh token, no mapping — gets
 *       exactly one mapping, its runner and its default workspace from one pass, keyed `signed-in:`,
 *       and the manager provisions it to READY. A second pass makes nothing more;
 *   (2) no live login session — only revoked tokens, only expired ones, or none — gets nothing;
 *   (3) a disabled account gets nothing, and neither does one the eligibility rule refuses;
 *   (4) a mapping in any state is left exactly as stored, a deleted one included: nothing recreated;
 *   (5) two services passing over the same accounts at once make one mapping each;
 *   (6) a full pool: the pass still records the mapping, and it waits for capacity.
 *
 * Every case signs its accounts out when it ends, so a later case's pass, which sees the whole
 * database, gives them nothing. Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import { MANAGED_RUNNER_NAME, MANAGED_WORKSPACE_NAME } from './managed-runner-resources';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const ON = { enabled: true, problem: null } as const;
const DAY = 24 * 60 * 60 * 1000;

test('every signed-in account gets its managed runner from the signed-in pass', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  /** A refresh token as AuthService stores one: `expiresIn` from now, revoked or not. */
  const token = (userId: string, opts: { expiresIn?: number; revoked?: boolean } = {}) =>
    db.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(randomBytes(32).toString('hex')),
        expiresAt: new Date(Date.now() + (opts.expiresIn ?? 30 * DAY)),
        revokedAt: opts.revoked ? new Date() : null,
      },
    });
  const signOut = (...userIds: string[]) => db.refreshToken.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: new Date() } });
  const mappings = (userIds: string[]) => db.managedRunner.findMany({ where: { ownerId: { in: userIds } } });

  await t.test('(1) signed in before the switch: one pass gives one mapping, and it provisions', async () => {
    const w = managedRunnerWorld(db);
    const ownerId = await w.makeUser('refresh-only');
    await token(ownerId, { revoked: true });
    await token(ownerId);
    // Their own machine and workspace: kept as they are.
    const own = await db.runner.create({ data: { ownerId, name: 'their-mac', tokenHash: sha256(randomUUID()), status: 'ONLINE' } });
    const ownWs = await db.workspace.create({ data: { ownerId, name: 'their-workspace', runnerId: own.id, workDir: '/tmp/x' } });

    assert.ok((await w.service.provisionSignedIn()) >= 1);
    const [mapping] = await mappings([ownerId]);
    assert.ok(mapping, 'a mapping was made');
    assert.match(mapping.lastRequestKey ?? '', /^signed-in:/);
    assert.equal(mapping.desiredState, 'RUNNING');
    const runner = await db.runner.findUniqueOrThrow({ where: { id: mapping.runnerId } });
    assert.equal(runner.name, MANAGED_RUNNER_NAME);
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: mapping.defaultWorkspaceId! } });
    assert.equal(workspace.name, MANAGED_WORKSPACE_NAME);
    assert.equal(workspace.runnerId, mapping.runnerId);
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: own.id } })).name, 'their-mac');
    assert.equal((await db.workspace.findUniqueOrThrow({ where: { id: ownWs.id } })).runnerId, own.id);

    assert.equal(await w.service.provisionSignedIn(), 0, 'the next pass makes nothing more');
    assert.equal((await mappings([ownerId])).length, 1);
    assert.equal(await db.runner.count({ where: { ownerId } }), 2);

    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    await signOut(ownerId);
  });

  await t.test('(2) no live login session: nothing', async () => {
    const w = managedRunnerWorld(db);
    const revoked = await w.makeUser('revoked');
    await token(revoked, { revoked: true });
    const expired = await w.makeUser('expired');
    await token(expired, { expiresIn: -1_000 });
    const never = await w.makeUser('never-signed-in');
    assert.equal(await w.service.provisionSignedIn(), 0);
    assert.equal((await mappings([revoked, expired, never])).length, 0);
    assert.equal(await db.runner.count({ where: { ownerId: { in: [revoked, expired, never] } } }), 0);
  });

  await t.test('(3) a disabled account, and one the rule refuses: nothing', async () => {
    const w = managedRunnerWorld(db);
    const disabled = await w.makeUser('disabled');
    await token(disabled);
    await sql.query(`UPDATE "user" SET disabled_at = now() WHERE id = $1`, [disabled]);
    const refused = await w.makeUser('refused');
    await token(refused);
    const asked: string[] = [];
    const ruled = new ManagedRunnerService(w.prisma, ON, w.runtime, { eligible: async (ownerId) => (asked.push(ownerId), ownerId !== refused) });
    assert.equal(await ruled.provisionSignedIn(), 0);
    assert.ok(asked.includes(refused), 'the rule was asked about the refused account');
    assert.ok(!asked.includes(disabled), 'and never about the disabled one');
    assert.equal((await mappings([disabled, refused])).length, 0);
    await signOut(disabled, refused);
  });

  await t.test('(4) a mapping in any state is left as stored; a deleted one is not recreated', async () => {
    const w = managedRunnerWorld(db);
    const deleted = await w.makeUser('deleted');
    const failed = await w.makeUser('failed');
    for (const ownerId of [deleted, failed]) {
      await w.service.ensure(ownerId, `ensure-${ownerId}`);
      await token(ownerId);
    }
    await sql.query(`UPDATE managed_runner SET desired_state = 'DELETED', management_state = 'DELETED' WHERE owner_id = $1`, [deleted]);
    await sql.query(`UPDATE managed_runner SET management_state = 'FAILED' WHERE owner_id = $1`, [failed]);
    const rows = async () =>
      (await sql.query(`SELECT row_to_json(m)::text AS row FROM managed_runner m WHERE owner_id = ANY($1::uuid[]) ORDER BY owner_id`, [[deleted, failed]])).rows.map((r) => r.row as string);
    const before = await rows();
    assert.equal(await w.service.provisionSignedIn(), 0);
    assert.deepEqual(await rows(), before, 'byte for byte');
    assert.equal(await db.runner.count({ where: { ownerId: { in: [deleted, failed] } } }), 2);
    await signOut(deleted, failed);
  });

  await t.test('(5) two services passing at once: one mapping per account', async () => {
    const w = managedRunnerWorld(db);
    const owners = await Promise.all(['race-a', 'race-b', 'race-c'].map((label) => w.makeUser(label)));
    for (const ownerId of owners) await token(ownerId);
    const other = new ManagedRunnerService(w.prisma, ON, w.runtime);
    await Promise.all([w.service.provisionSignedIn(), other.provisionSignedIn(), w.service.signedIn({ id: owners[1] })]);
    const made = await mappings(owners);
    assert.deepEqual(made.map((m) => m.ownerId).sort(), [...owners].sort());
    assert.equal(await db.runner.count({ where: { ownerId: { in: owners } } }), 3, 'one runner each');
    assert.equal(await db.workspace.count({ where: { ownerId: { in: owners } } }), 3, 'one workspace each');
    await signOut(...owners);
  });

  await t.test('(6) a full pool: the mapping is recorded and waits for capacity', async () => {
    const w = managedRunnerWorld(db, { capacity: { maxActiveUsers: 1 } });
    await w.readyRunner('holds-the-slot');
    const ownerId = await w.makeUser('waits');
    await token(ownerId);
    assert.ok((await w.service.provisionSignedIn()) >= 1);
    const outcomes = await w.drive(ownerId, ['WAITING_CAPACITY']);
    assert.equal(outcomes.at(-1), 'WAITING_CAPACITY', outcomes.join(' → '));
    assert.equal((await w.mappingOf(ownerId)).managementState, 'WAITING_CAPACITY');
    await signOut(ownerId);
  });
});
