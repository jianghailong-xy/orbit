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
 *   - the existing managed runner still heartbeats and reads itself as the instance it is:
 *     execution continues, and its credential stays bound to that instance (a request from another
 *     Pod or an older runner is refused, and writes nothing);
 *   - the capability and status reads allocate nothing; every managed write is 404;
 *   - unregistering or removing the managed runner, or deleting its owner, is refused;
 *   - work addressed to a sleeping managed runner — a message, a task run, a due scheduled wakeup, a
 *     watch's delivery and an armed auto retry — goes exactly the self-managed way (queued, waiting
 *     for its runner; the retry gives up after the ordinary 30 minutes) and wakes nothing: no demand,
 *     no desired state, no capacity pool written;
 *   - a draining mapping holds nothing back while management is off: its instance still claims, is
 *     asked to stop for nothing, and its workload report is not stored;
 *   - an account an administrator disabled is acted on by nothing managed while management is off:
 *     its READY mapping is not drained and its unprovisioned one not put to sleep, its runner's
 *     credential is not replaced, and work addressed to its runner wakes nothing. Its runner is
 *     still refused 403 ACCOUNT_DISABLED at the runner door, which holds whatever the switch says.
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
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  MANAGED_RUNNER_SLEEP_CAPABILITY,
  toUuid,
} from '@orbit/shared';
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

  interface Seeded { ownerId: string; runnerId: string; workspaceId: string; token: string; mappingId: string; podUid?: string }
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
    return { ownerId, runnerId, workspaceId, token, mappingId: columns.id as string, podUid: columns.pod_uid as string | undefined };
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
  // Asleep: compute stopped, the volume kept, the runner silent since.
  const asleep = await seed('asleep', {
    desired_state: 'SLEEPING', management_state: 'SLEEPING', generation: 2, revision: 14, demand_revision: 3,
    pvc_uid: randomUUID(), pv_uid: randomUUID(), volume_handle: `0001-0009-ceph-${randomUUID()}`,
    reservation: JSON.stringify({ version: 1, pool: randomUUID(), storage: { durableBytes: 21474836480, reservedAt: '2026-10-08T00:00:00.000Z' }, compute: null }),
  });
  await sql.query(`UPDATE runner SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`, [asleep.runnerId]);
  // Draining to sleep when the switch went off: its instance asked to stop, not yet accepted.
  const draining = await seed('draining', {
    desired_state: 'SLEEPING', management_state: 'DRAINING', generation: 1, revision: 21, demand_revision: 5,
    drain_demand_revision: 5, stop_requested_at: new Date(Date.now() - 60_000),
    pvc_uid: randomUUID(), pv_uid: randomUUID(), volume_handle: `0001-0009-ceph-${randomUUID()}`,
    pod_uid: randomUUID(), node_name: 'node-b',
  });
  // Accounts an administrator disabled: one whose runner was READY, one whose intent was never provisioned.
  const disabledReady = await seed('disabled-ready', {
    desired_state: 'RUNNING', management_state: 'READY', generation: 1, revision: 7,
    pvc_uid: randomUUID(), pv_uid: randomUUID(), volume_handle: `0001-0009-ceph-${randomUUID()}`,
    pod_uid: randomUUID(), node_name: 'node-c',
  });
  const disabledRequested = await seed('disabled-requested', { desired_state: 'RUNNING', management_state: 'REQUESTED', revision: 1 });
  await sql.query(`UPDATE "user" SET disabled_at = now() WHERE id IN ($1, $2)`, [disabledReady.ownerId, disabledRequested.ownerId]);

  const snapshot = async () => ({
    mappings: (await sql.query(`SELECT row_to_json(m)::text AS row FROM managed_runner m ORDER BY id`)).rows.map((r) => r.row),
    runners: (await sql.query(`SELECT id, owner_id, name, token_hash, managed_workload FROM runner ORDER BY id`)).rows,
    pools: Number((await sql.query(`SELECT count(*)::int AS n FROM managed_runner_capacity`)).rows[0].n),
    workspaces: (await sql.query(`SELECT id, owner_id, runner_id, target_runner_id, deleted_at FROM workspace ORDER BY id`)).rows,
    users: Number((await sql.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n),
  });
  const seeded = await snapshot();
  assert.equal(seeded.mappings.length, 7);
  assert.equal(seeded.pools, 0);

  const login = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });

  /** A session of a seeded runner's default workspace, as earlier work left it. */
  async function session(of: Seeded, status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const columns: Record<string, unknown> = {
      id, owner_id: of.ownerId, creator_id: of.ownerId, workspace_id: of.workspaceId, assigned_runner_id: of.runnerId,
      title: 'earlier work', prompt: 'the opening prompt', provider: 'claude', provider_builtin: true, status, num_turns: 1,
      runtime_session_id: randomUUID(), ...extra,
    };
    const names = Object.keys(columns);
    await sql.query(
      // started_at and updated_at by the database's clock: they are timestamps without a zone.
      `INSERT INTO "session" (${names.map((n) => `"${n}"`).join(', ')}, "started_at", "updated_at")
       VALUES (${names.map((n, i) => (n === 'status' ? `$${i + 1}::"run_status"` : `$${i + 1}`)).join(', ')}, now(), now())`,
      names.map((n) => columns[n]),
    );
    return id;
  }
  const statusOf = async (sessionId: string) =>
    (await sql.query(`SELECT status::text AS status, retry_at AS "retryAt", retry_attempts AS "retryAttempts" FROM "session" WHERE id = $1`, [sessionId])).rows[0];

  async function disabledBoot(label: string, extra: NodeJS.ProcessEnv) {
    // Work addressed to the sleeping managed runner, one of each kind, written before the boot so the
    // server's own workers meet it: a parked session a message goes to, one a due wakeup belongs to,
    // one a watch observes, and a failed run armed for retry 45 minutes after it failed.
    const messaged = await session(asleep, 'AWAITING_INPUT');
    const scheduled = await session(asleep, 'AWAITING_INPUT');
    await sql.query(
      `INSERT INTO "session_scheduled_wakeup" ("id", "session_id", "state", "delay_seconds", "reason", "prompt", "due_at")
       VALUES (gen_random_uuid(), $1, 'PENDING', 60, 'check the build', 'check the build', now() - interval '1 second')`,
      [scheduled],
    );
    const observer = await session(asleep, 'AWAITING_INPUT');
    const retried = await session(asleep, 'FAILED', { retry_attempts: 1, error: 'overloaded' });
    // Timestamps without a zone, written by the database's own clock as the application writes them.
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 second', finished_at = now() - interval '45 minutes' WHERE id = $1`, [retried]);
    await sql.query(
      `INSERT INTO "run_event"("id","session_id","seq","type","payload") VALUES (gen_random_uuid(),$1,1,'user','{"text":"do the work"}'::jsonb)`,
      [retried],
    );
    const queuedForDraining = await session(draining, 'PENDING');
    // And a due wakeup on a parked session of the disabled account's runner.
    const disabledParked = await session(disabledReady, 'AWAITING_INPUT');
    await sql.query(
      `INSERT INTO "session_scheduled_wakeup" ("id", "session_id", "state", "delay_seconds", "reason", "prompt", "due_at")
       VALUES (gen_random_uuid(), $1, 'PENDING', 60, 'check the build', 'check the build', now() - interval '1 second')`,
      [disabledParked],
    );
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

      // The running instance keeps working: it heartbeats and reads itself with its credential, as
      // the instance it is (managed-runner-instance.ts) — whatever the switch says.
      const asItself = {
        'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
        [MANAGED_RUNNER_GENERATION_HEADER]: '1',
        [MANAGED_RUNNER_POD_UID_HEADER]: ready.podUid!,
      };
      const beat = await call(server, 'POST', '/api/runner/heartbeat', ready.token, {}, asItself);
      assert.ok(beat.status === 200 || beat.status === 201, `heartbeat: ${beat.text}`);
      const me = await call(server, 'GET', '/api/runner/me', ready.token, undefined, asItself);
      assert.equal(me.status, 200, me.text);
      assert.equal(me.json.workspaces.length, 1);
      // Switching management off does not hand the credential to another instance.
      for (const [who, headers, code] of [
        ['another Pod', { ...asItself, [MANAGED_RUNNER_POD_UID_HEADER]: randomUUID() }, 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED'],
        ['an older runner', {}, 'MANAGED_RUNNER_INSTANCE_REQUIRED'],
      ] as const) {
        const refused = await call(server, 'POST', '/api/runner/heartbeat', ready.token, {}, headers);
        assert.equal(refused.status, 403, `${who}: ${refused.text}`);
        assert.equal(refused.json.code, code, who);
      }

      // A disabled account's runner is refused at the runner door whatever the switch says, before its
      // instance is considered; nothing managed is done about the account (its rows are checked below).
      const disabledBeat = await call(server, 'POST', '/api/runner/heartbeat', disabledReady.token, {}, {
        'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
        [MANAGED_RUNNER_GENERATION_HEADER]: '1',
        [MANAGED_RUNNER_POD_UID_HEADER]: disabledReady.podUid!,
      });
      assert.equal(disabledBeat.status, 403, disabledBeat.text);
      assert.equal(disabledBeat.json.code, 'ACCOUNT_DISABLED');

      // Removing it any ordinary way is refused, with the switch off as well.
      const removed = await call(server, 'DELETE', `/api/runners/${ready.runnerId}`, owner);
      assert.equal(removed.status, 409, removed.text);
      assert.equal(removed.json.code, 'MANAGED_RUNNER_DELETE_REFUSED');
      const unregistered = await call(server, 'POST', '/api/runner/deregister', ready.token, {}, asItself);
      assert.equal(unregistered.status, 409, unregistered.text);
      assert.equal(unregistered.json.code, 'MANAGED_RUNNER_DELETE_REFUSED');
      const ownerDeleted = await call(server, 'DELETE', `/api/admin/users/${ready.ownerId}`, await login(admin));
      assert.equal(ownerDeleted.status, 409, `the owner of a mapping cannot be deleted under it: ${ownerDeleted.text}`);

      // Demand for the sleeping runner, each kind, is the self-managed queue's and wakes nothing.
      const sleeper = await login(asleep.ownerId);
      const sent = await call(server, 'POST', `/api/sessions/${messaged}/turns`, sleeper, { clientTurnId: randomUUID(), content: 'are you there?' });
      assert.equal(sent.status, 201, `a message: ${sent.text}`);
      assert.equal((await statusOf(messaged)).status, 'PENDING', 'a message waits for its runner, as for any runner');
      const task = await call(server, 'POST', '/api/tasks', sleeper, { title: `build ${label}`, description: 'build it', assigneeId: asleep.workspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      assert.equal(task.status, 201, task.text);
      const ran = await call(server, 'POST', `/api/tasks/${task.json.id}/execute`, sleeper, {});
      assert.ok(ran.status === 200 || ran.status === 201, `a task run: ${ran.text}`);
      const taskDone = randomUUID();
      await sql.query(
        `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
         VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT','DONE')`,
        [taskDone, asleep.ownerId],
      );
      const watched = await call(server, 'POST', '/api/watches', sleeper, {
        predicateVersion: 1,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [{ kind: 'TASK', id: taskDone }],
        action: 'RESUME_SESSION',
        observerSessionId: observer,
      });
      assert.equal(watched.status, 201, `a watch: ${watched.text}`);
      // The scheduled-wakeup and watch workers deliver within their 5-second polls, and the
      // auto-retry sweep runs 30 seconds after boot: wait for all three to have done their part.
      const deadline = Date.now() + 75_000;
      for (;;) {
        const [wakeup, watch, retry, disabledWakeup] = [await statusOf(scheduled), await statusOf(observer), await statusOf(retried), await statusOf(disabledParked)];
        if (wakeup.status === 'PENDING' && watch.status === 'PENDING' && retry.retryAt === null && disabledWakeup.status === 'PENDING') break;
        if (Date.now() > deadline) assert.fail(`the workers did not deliver: ${JSON.stringify({ wakeup, watch, retry, disabledWakeup })}`);
        await sleep(500);
      }
      const retry = await statusOf(retried);
      assert.equal(retry.status, 'FAILED');
      assert.equal(retry.retryAttempts, 1, 'the retry gave up the ordinary way, after 30 minutes offline, spending nothing');

      // The draining mapping holds nothing back while management is off: its instance claims, is not
      // asked to stop, and its workload report is not stored.
      const drainingInstance = {
        'x-orbit-runner-capabilities': `${MANAGED_RUNNER_INSTANCE_CAPABILITY},${MANAGED_RUNNER_SLEEP_CAPABILITY}`,
        [MANAGED_RUNNER_GENERATION_HEADER]: '1',
        [MANAGED_RUNNER_POD_UID_HEADER]: draining.podUid!,
      };
      const drainingBeat = await call(server, 'POST', '/api/runner/heartbeat', draining.token,
        { managedWorkload: { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 3600 } }, drainingInstance);
      assert.ok(drainingBeat.status === 200 || drainingBeat.status === 201, drainingBeat.text);
      assert.equal(drainingBeat.json.managedSleep, undefined, 'nothing is asked of it');
      const claimed = await call(server, 'GET', '/api/runner/sessions/claim', draining.token, undefined, drainingInstance);
      assert.equal(claimed.status, 200, claimed.text);
      assert.equal(toUuid(claimed.json.sessionId), queuedForDraining, 'its queued turn is still handed out');
      // Its turn ran: settled, so the next boot finds nothing of this one's left running.
      await sql.query(`UPDATE "session" SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`, [queuedForDraining]);
    } finally {
      await server.stop();
    }
    assertTripwireQuiet(server, label);

    const after = await snapshot();
    assert.deepEqual(after.mappings, seeded.mappings, `${label}: every mapping row is exactly as it was — no demand, no desire, no state`);
    assert.deepEqual(after.runners, seeded.runners, `${label}: every runner row and credential stays, and no workload is stored`);
    assert.equal(after.pools, 0, `${label}: no capacity pool is written`);
    assert.deepEqual(after.workspaces, seeded.workspaces, `${label}: every default workspace stays`);
    assert.equal(after.users, seeded.users);
  }

  await t.test('first boot, with the variable absent', () => disabledBoot('absent', {}));
  await t.test('restart, with the variable explicitly false', () => disabledBoot('restart-false', { ORBIT_MANAGED_RUNNERS_ENABLED: 'false' }));
});
