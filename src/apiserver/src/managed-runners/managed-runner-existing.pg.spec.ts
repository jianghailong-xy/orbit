/**
 * "Disable existing state" (docs/managed-runner-design.md, "Verification and implementation
 * handoff"): mappings an earlier enabled deployment left behind — one READY with its Pod and PVC
 * identities, one mid-provisioning with a resource operation in flight, one FAILED and retryable —
 * and then the production apiserver started with the feature off, run with its normal background
 * workers, and restarted. Over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty.
 *
 * Switching the feature off freezes management. Held here, across both boots:
 *   - every managed_runner row is byte-for-byte what was seeded: no state moved, no intent consumed,
 *     no lease taken, nothing cleaned up;
 *   - the runner rows and their credentials stay (no revocation), and the default workspaces stay;
 *   - no Kubernetes client is constructed and no timer started by managed runner code (the tripwire
 *     of `managed-runner-boot.pg.spec.ts`), so nothing can stop or delete a Pod or a PVC;
 *   - the existing managed runner still heartbeats and reads itself: execution continues;
 *   - the capability and status reads allocate nothing; every managed write is 404;
 *   - unregistering or removing the managed runner, or deleting its owner, is refused.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-existing.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';

import { call } from '../auth/pat-test-apiserver';
import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { assertTripwireQuiet, bootScrubbedApiserver } from '../test-support/managed-runner-apiserver';
import { managedPodName, managedPvcName } from './managed-runner-resources';

const URL = process.env.COORDINATOR_PG_URL;

test('managed runners switched off with existing state: nothing is stopped, deleted, cleaned up or revoked, across a restart', {
  skip: !URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-existing-'));
  t.after(async () => {
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const JWT_SECRET = randomBytes(32).toString('hex');
  const jwt = new JwtService({ secret: JWT_SECRET });
  const RUN = randomUUID().slice(0, 8);

  // ── what an enabled deployment left behind ─────────────────────────────────────────────────
  const user = async (label: string, role = 'MEMBER') =>
    (await sql.query(
      `INSERT INTO "user" (id, email, name, password_hash, role) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
      [`${label}-${RUN}@example.invalid`, label, hashPassword('irrelevant'), role],
    )).rows[0].id as string;
  const admin = await user('admin', 'ADMIN');
  const bystander = await user('bystander');

  interface Seeded { ownerId: string; runnerId: string; workspaceId: string; token: string; mappingId: string }
  async function seed(label: string, mapping: Record<string, unknown>): Promise<Seeded> {
    const ownerId = await user(label);
    const token = generateToken(32);
    const runnerId = (await sql.query(
      `INSERT INTO runner (id, name, owner_id, token_hash, status, last_heartbeat_at, max_concurrent)
         VALUES (gen_random_uuid(), 'orbit-managed', $1, $2, 'ONLINE', now() - interval '10 seconds', 2) RETURNING id`,
      [ownerId, sha256(token)],
    )).rows[0].id as string;
    const workspaceId = (await sql.query(
      `INSERT INTO workspace (id, name, owner_id, runner_id, target_runner_id, work_dir, auto_init_git, enable_worktree)
         VALUES (gen_random_uuid(), 'Default', $1, $2, $2, '/var/lib/orbit/home/orbit-repos/default', true, true) RETURNING id`,
      [ownerId, runnerId],
    )).rows[0].id as string;
    const columns = {
      id: randomUUID(), owner_id: ownerId, runner_id: runnerId, default_workspace_id: workspaceId,
      cluster_key: 'previous-cluster', namespace: 'orbit-managed-test', pvc_name: managedPvcName(runnerId),
      resource_profile_id: 'invited-test-v1', last_request_key: 'ensure-before-the-switch', updated_at: new Date(),
      ...mapping,
    } as Record<string, unknown>;
    if (columns.pod_uid) columns.pod_name = managedPodName(runnerId);
    const names = Object.keys(columns);
    await sql.query(
      `INSERT INTO managed_runner (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      names.map((n) => columns[n]),
    );
    return { ownerId, runnerId, workspaceId, token, mappingId: columns.id as string };
  }

  const ready = await seed('ready', {
    desired_state: 'RUNNING', management_state: 'READY', generation: 1, revision: 9,
    pvc_uid: randomUUID(), pv_uid: randomUUID(), volume_handle: `0001-0009-ceph-${randomUUID()}`,
    pod_uid: randomUUID(), node_name: 'node-a',
  });
  const inFlight = await seed('in-flight', {
    desired_state: 'RUNNING', management_state: 'PROVISIONING', revision: 4,
    pvc_uid: randomUUID(), resource_operation_id: randomUUID(), resource_operation_kind: 'CREATE_SECRET',
    resource_operation_state: 'PENDING', startup_deadline_at: new Date(Date.now() - 60_000),
    lease_holder: 'replica-before-the-switch', lease_expires_at: new Date(Date.now() - 60_000),
  });
  const failed = await seed('failed', {
    desired_state: 'RUNNING', management_state: 'FAILED', revision: 6, attempt: 3,
    last_error: JSON.stringify({ code: 'RETRY_EXHAUSTED', message: 'stopped', retryable: true }),
  });

  const snapshot = async () => ({
    mappings: (await sql.query(`SELECT row_to_json(m)::text AS row FROM managed_runner m ORDER BY id`)).rows.map((r) => r.row),
    runners: (await sql.query(`SELECT id, owner_id, name, token_hash FROM runner ORDER BY id`)).rows,
    workspaces: (await sql.query(`SELECT id, owner_id, runner_id, target_runner_id, deleted_at FROM workspace ORDER BY id`)).rows,
    users: Number((await sql.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n),
  });
  const seeded = await snapshot();
  assert.equal(seeded.mappings.length, 3);

  const login = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });

  async function disabledBoot(label: string, extra: NodeJS.ProcessEnv) {
    const server = await bootScrubbedApiserver(scratch, label, { DATABASE_URL: url, JWT_SECRET, ...extra });
    try {
      // The normal background workers run: the scheduled-wakeup worker's first pass is at boot, and
      // the rest get a few seconds of their own.
      await sleep(5_000);
      const owner = await login(ready.ownerId);

      const capabilities = await call(server, 'GET', '/api/auth/capabilities', owner);
      assert.deepEqual(capabilities.json, { managedRunners: { enabled: false, contractVersion: 1 } });
      const status = await call(server, 'GET', '/api/managed-runner', owner);
      assert.equal(status.status, 200, status.text);
      assert.equal(status.json.enabled, false);
      assert.equal(status.json.managementState, 'READY', 'the stored state is reported as it is');
      assert.equal(status.json.revision, 9);
      assert.equal(status.json.reason.code, 'MANAGED_RUNNER_DISABLED');
      assert.deepEqual(status.json.actions, { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false });

      // A capability or status read by someone without a mapping allocates nothing.
      const none = await call(server, 'GET', '/api/managed-runner', await login(bystander));
      assert.equal(none.json.managementState, 'NOT_PROVISIONED');

      for (const [action, who, revision] of [['ensure', bystander, undefined], ['retry', failed.ownerId, 6], ['sleep', ready.ownerId, 9], ['delete', ready.ownerId, 9], ['wake', inFlight.ownerId, 4]] as const) {
        const refused = await call(server, 'POST', `/api/managed-runner/${action}`, await login(who), { idempotencyKey: `${label}-${action}`, revision });
        assert.equal(refused.status, 404, `${action}: ${refused.text}`);
        assert.equal(refused.json.code, 'MANAGED_RUNNER_DISABLED');
      }

      // The running instance keeps working: it heartbeats and reads itself with its credential.
      const beat = await call(server, 'POST', '/api/runner/heartbeat', ready.token, {});
      assert.ok(beat.status === 200 || beat.status === 201, `heartbeat: ${beat.text}`);
      const me = await call(server, 'GET', '/api/runner/me', ready.token);
      assert.equal(me.status, 200, me.text);
      assert.equal(me.json.workspaces.length, 1);

      // Removing it any ordinary way is refused, with the switch off as well.
      const removed = await call(server, 'DELETE', `/api/runners/${ready.runnerId}`, owner);
      assert.equal(removed.status, 409, removed.text);
      assert.equal(removed.json.code, 'MANAGED_RUNNER_DELETE_REFUSED');
      const unregistered = await call(server, 'POST', '/api/runner/deregister', ready.token, {});
      assert.equal(unregistered.status, 409, unregistered.text);
      assert.equal(unregistered.json.code, 'MANAGED_RUNNER_DELETE_REFUSED');
      const ownerDeleted = await call(server, 'DELETE', `/api/admin/users/${ready.ownerId}`, await login(admin));
      assert.equal(ownerDeleted.status, 409, `the owner of a mapping cannot be deleted under it: ${ownerDeleted.text}`);
    } finally {
      await server.stop();
    }
    assertTripwireQuiet(server, label);

    const after = await snapshot();
    assert.deepEqual(after.mappings, seeded.mappings, `${label}: every mapping row is exactly as it was`);
    assert.deepEqual(after.runners, seeded.runners, `${label}: every runner row and credential stays`);
    assert.deepEqual(after.workspaces, seeded.workspaces, `${label}: every default workspace stays`);
    assert.equal(after.users, seeded.users);
  }

  await t.test('first boot, with the variable absent', () => disabledBoot('absent', {}));
  await t.test('restart, with the variable explicitly false', () => disabledBoot('restart-false', { ORBIT_MANAGED_RUNNERS_ENABLED: 'false' }));
});
