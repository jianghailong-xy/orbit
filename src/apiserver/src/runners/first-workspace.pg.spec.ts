/**
 * A machine with no workspace gets its first one from the conversation (docs/first-workspace-contract.md), held against
 * the production apiserver — `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/first-workspace.pg.spec.ts
 *
 * Two accounts; the owner's machines are registered the two ways `orbit register` registers one, and played over their
 * own door with their tokens. Against one server:
 *
 *   1. register_dir: approving a device registration writes the directory `orbit register` ran in, a token registration
 *      that carries one writes it too, a registration that says another overwrites it and one that says none leaves it;
 *      GET /runners and GET /runners/:id carry it;
 *   2. the directory probe relay: 400 for an offline machine, 404 for another account's; asked, it is pending; the next
 *      HTTPS heartbeat hands it over once (pending → probing) and the one after does not; the answer is stored and read
 *      back only for the path asked now — an answer about a path asked earlier is neither returned for the current one
 *      nor stored over it;
 *   3. POST /sessions with a folder already on the machine: the workspace (named for the folder, isolation off), the
 *      session (createdWorkspace) and its first message, in one request; GET /sessions/:id carries createdWorkspace, and
 *      a session opened in an existing workspace reads false;
 *   4. with a new folder: the workspace's directory is under the runner's reposRoot and the claim and the reclaim say
 *      createWorkDir; a session in a workspace made from an existing folder is not told to;
 *   5. a name the account already has gets " 2", " 3"; a deleted workspace's name and another account's are free;
 *   6. a failure after the workspace was written rolls everything back: no workspace, no session;
 *   7. another account's machine is 403; a new folder on a runner without create-workdir/v1 or without a reposRoot is
 *      409; a request that does not name one folder on one machine is 400; an engine signed out on the machine is still
 *      the 409 it was — and none of them writes a workspace;
 *   8. an access token makes a workspace only with workspaces:write, the scope POST /workspaces asks for.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ENGINE_SIGNED_OUT, toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

interface Machine {
  runnerId: string;
  token: string;
}

test('a machine with no workspace gets its first one from the conversation', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@first-workspace.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');

  server = await startApiserver(url, `first-workspace-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  const registerDirOf = async (runnerId: string): Promise<string | null> =>
    (await sql.query(`SELECT "register_dir" FROM "runner" WHERE "id" = $1::uuid`, [runnerId])).rows[0]?.register_dir ?? null;
  const workspacesOf = async (ownerId: string) =>
    (await sql.query<{ id: string; name: string; work_dir: string; deleted_at: Date | null }>(
      `SELECT "id"::text, "name", "work_dir", "deleted_at" FROM "workspace" WHERE "owner_id" = $1::uuid ORDER BY "created_at", "id"`,
      [ownerId],
    )).rows;
  /** A heartbeat over HTTPS, as a runner of today sends one, declaring `capabilities`. */
  const heartbeat = (machine: Machine, capabilities: string, body: Record<string, unknown> = {}) =>
    api('POST', '/api/runner/heartbeat', machine.token, {
      status: 'ONLINE',
      engines: [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }],
      ...body,
    }, { 'x-orbit-runner-capabilities': capabilities });

  // ── 1. register_dir ──────────────────────────────────────────────────────────────────────────────────────────
  /** `orbit register` with no token: started by the machine, approved by the owner, collected by the machine. */
  const deviceRegister = async (name: string, workDir?: string): Promise<Machine> => {
    const started = await api('POST', '/api/runner/device/start', undefined, {
      name, hostname: name, labels: [], maxConcurrent: 4, version: '0.1.250', ...(workDir === undefined ? {} : { workDir }),
    });
    assert.equal(started.status, 201, started.text);
    const approved = await api('POST', `/api/runners/device/${encodeURIComponent(started.json.userCode)}/approve`, ownerToken);
    assert.equal(approved.status, 201, approved.text);
    const polled = await api('POST', '/api/runner/device/poll', undefined, { deviceCode: started.json.deviceCode });
    assert.equal(polled.json?.status, 'approved', polled.text);
    return { runnerId: toUuid(approved.json.runnerId), token: polled.json.runnerToken };
  };
  /** `orbit register --token`: an enrollment token the owner minted. */
  const tokenRegister = async (name: string, workDir?: string): Promise<Machine> => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', ownerToken, { label: `first-workspace ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, {
      enrollmentToken: minted.json.token, name, hostname: name, ...(workDir === undefined ? {} : { workDir }),
    });
    assert.equal(registered.status, 201, registered.text);
    return { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken };
  };

  let austin!: Machine;
  let builder!: Machine;
  await t.test('1. the register directory is written as a machine is registered, and read with the runner', async () => {
    austin = await deviceRegister(`austin-${RUN}`, '/home/orbit/code/app');
    assert.equal(await registerDirOf(austin.runnerId), '/home/orbit/code/app', 'written when the registration is approved');
    const list = await api('GET', '/api/runners', ownerToken);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.find((r: { id: string }) => toUuid(r.id) === austin.runnerId)?.registerDir, '/home/orbit/code/app');
    const one = await api('GET', `/api/runners/${uuidToBase62(austin.runnerId)}`, ownerToken);
    assert.equal(one.status, 200, one.text);
    assert.equal(one.json.registerDir, '/home/orbit/code/app');

    // Registered again from another directory: the same machine, and its directory moves with the registration.
    const again = await deviceRegister(`austin-${RUN}`, '  /home/orbit  ');
    assert.equal(again.runnerId, austin.runnerId, 'one runner per machine');
    assert.equal(await registerDirOf(austin.runnerId), '/home/orbit');
    // A registration that says none leaves the one it had.
    austin = await deviceRegister(`austin-${RUN}`);
    assert.equal(await registerDirOf(austin.runnerId), '/home/orbit');

    builder = await tokenRegister(`builder-${RUN}`, '/srv/build');
    assert.equal(await registerDirOf(builder.runnerId), '/srv/build', 'a token registration that carries one writes it');
    builder = await tokenRegister(`builder-${RUN}`);
    assert.equal(await registerDirOf(builder.runnerId), '/srv/build', 'one that carries none leaves it');
    builder = await tokenRegister(`builder-${RUN}`, '/srv/build-2');
    assert.equal(await registerDirOf(builder.runnerId), '/srv/build-2', 'and the next that carries one overwrites it');
    assert.equal((await api('GET', `/api/runners/${uuidToBase62(builder.runnerId)}`, ownerToken)).json.registerDir, '/srv/build-2');
  });

  // ── 2. the directory probe relay ─────────────────────────────────────────────────────────────────────────────
  const ask = (runnerId: string, path: unknown, bearer = ownerToken) =>
    api('POST', `/api/runners/${uuidToBase62(runnerId)}/dir-probe`, bearer, { path });
  const read = (runnerId: string, path: string, bearer = ownerToken) =>
    api('GET', `/api/runners/${uuidToBase62(runnerId)}/dir-probe?path=${encodeURIComponent(path)}`, bearer);
  const answer = (machine: Machine, body: unknown) => api('POST', '/api/runner/dir-probe-result', machine.token, body);
  const slotOf = async (runnerId: string) =>
    (await sql.query(`SELECT "dir_probe_status" AS status, "dir_probe_path" AS path FROM "runner" WHERE "id" = $1::uuid`, [runnerId])).rows[0];
  const APP = { path: '/home/orbit/code/app', exists: true, isDir: true, isGit: true, branch: 'main', isHome: false, freeBytes: 52e9 };
  const API = { path: '/home/orbit/code/api', exists: false, isDir: false, isGit: false, branch: null, isHome: false, freeBytes: null };

  await t.test('2. the directory probe: asked, handed to one heartbeat once, answered only for the path asked now', async (t2) => {
    const beat = await heartbeat(austin, 'dir-probe/v1', { reposRoot: '/home/orbit/orbit-repos' });
    assert.equal(beat.status, 201, beat.text);
    assert.equal('dirProbeRequest' in beat.json, false, 'nobody is asking yet');

    await t2.test('an offline machine, another account\'s machine and a request with no path are refused', async () => {
      const gone = await prisma.runner.create({
        data: { ownerId: owner.id, name: `gone-${RUN}`, tokenHash: sha256(randomUUID()), status: 'ONLINE' },
      });
      await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() - interval '1 hour' WHERE "id" = $1::uuid`, [gone.id]);
      const offline = await ask(gone.id, '~/code/app');
      assert.equal(offline.status, 400, offline.text);
      assert.match(offline.json.message, /offline/);
      const marked = await prisma.runner.create({
        data: { ownerId: owner.id, name: `marked-${RUN}`, tokenHash: sha256(randomUUID()), status: 'OFFLINE', lastHeartbeatAt: new Date() },
      });
      assert.equal((await ask(marked.id, '~/code/app')).status, 400);
      for (const id of [gone.id, marked.id]) assert.equal((await slotOf(id)).status, null, 'nothing asked');

      for (const reply of [await ask(austin.runnerId, '~/code/app', strangerToken), await read(austin.runnerId, '~/code/app', strangerToken)]) {
        assert.equal(reply.status, 404, reply.text);
      }
      for (const path of ['', '   ', 42, `/${'x'.repeat(4096)}`]) {
        assert.equal((await ask(austin.runnerId, path)).status, 400, JSON.stringify(path).slice(0, 40));
      }
      assert.equal((await slotOf(austin.runnerId)).status, null, 'none of them wrote the slot');
    });

    await t2.test('asked, pending; the next heartbeat hands it over once; answered, done', async () => {
      const asked = await ask(austin.runnerId, '  ~/code/app  ');
      assert.equal(asked.status, 201, asked.text);
      assert.deepEqual(asked.json, { path: '~/code/app', status: 'pending' });
      assert.deepEqual((await read(austin.runnerId, '~/code/app')).json, { path: '~/code/app', status: 'pending', result: null });

      const handed = await heartbeat(austin, 'dir-probe/v1');
      assert.equal(handed.status, 201, handed.text);
      assert.equal(handed.json.dirProbeRequest?.path, '~/code/app');
      assert.ok(handed.json.dirProbeRequest?.requestedAt, 'with when it was asked');
      assert.deepEqual(await slotOf(austin.runnerId), { status: 'probing', path: '~/code/app' });
      const next = await heartbeat(austin, 'dir-probe/v1');
      assert.equal('dirProbeRequest' in next.json, false, 'handed over once, never again');
      assert.equal((await read(austin.runnerId, '~/code/app')).json.status, 'pending', 'still waiting on the runner');

      const answered = await answer(austin, { path: '~/code/app', result: APP });
      assert.equal(answered.status, 200, answered.text);
      assert.deepEqual(answered.json, { ok: true, applied: true });
      assert.deepEqual((await read(austin.runnerId, '~/code/app')).json, { path: '~/code/app', status: 'done', result: APP });
      assert.deepEqual((await read(austin.runnerId, '~/code/api')).json, { path: '~/code/api', status: 'idle', result: null });
    });

    await t2.test('only the path asked now is answered: an earlier answer is neither returned for it nor stored over it', async () => {
      assert.equal((await ask(austin.runnerId, '~/code/api')).status, 201);
      assert.deepEqual((await read(austin.runnerId, '~/code/api')).json, { path: '~/code/api', status: 'pending', result: null },
        'the answer about ~/code/app is not the answer about ~/code/api');
      assert.deepEqual((await read(austin.runnerId, '~/code/app')).json, { path: '~/code/app', status: 'idle', result: null },
        'and nobody is asking about ~/code/app any more');
      assert.equal((await heartbeat(austin, 'dir-probe/v1')).json.dirProbeRequest?.path, '~/code/api');

      const late = await answer(austin, { path: '~/code/app', result: { ...APP, branch: 'late' } });
      assert.deepEqual(late.json, { ok: true, applied: false }, 'an answer about a path asked earlier applies to nothing');
      assert.deepEqual((await read(austin.runnerId, '~/code/api')).json, { path: '~/code/api', status: 'pending', result: null });

      assert.deepEqual((await answer(austin, { path: '~/code/api', result: API })).json, { ok: true, applied: true });
      assert.deepEqual((await read(austin.runnerId, '~/code/api')).json, { path: '~/code/api', status: 'done', result: API });
      assert.equal((await answer(austin, { result: API })).status, 400, 'an answer that names no path is refused');
    });
  });

  // ── 3–5. POST /sessions with a new workspace ─────────────────────────────────────────────────────────────────
  const openSession = (body: Record<string, unknown>, bearer = ownerToken) =>
    api('POST', '/api/sessions', bearer, { prompt: 'Look around this repository', engine: 'claude', ...body });
  const onMachine = (machine: Machine, newWorkspace: unknown, extra: Record<string, unknown> = {}) =>
    openSession({ assignedRunnerId: uuidToBase62(machine.runnerId), newWorkspace, ...extra });
  const workspaceRow = async (id: string) =>
    (await sql.query(
      `SELECT "name", "runner_id"::text AS "runnerId", "work_dir" AS "workDir", "enable_worktree" AS "enableWorktree",
              "auto_create_work_dir" AS "autoCreateWorkDir", "owner_id"::text AS "ownerId", "enabled"
         FROM "workspace" WHERE "id" = $1::uuid`, [id])).rows[0];
  const sessionRow = async (id: string) =>
    (await sql.query(
      `SELECT "workspace_id"::text AS "workspaceId", "assigned_runner_id"::text AS "runnerId", "created_workspace" AS "createdWorkspace",
              "prompt", "status"
         FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0];
  const turnsOf = async (sessionId: string) =>
    (await sql.query(`SELECT "kind", "client_turn_id" AS "clientTurnId", "content" FROM "conversation_turn" WHERE "session_id" = $1::uuid`,
      [sessionId])).rows;

  let appWorkspace = '';
  await t.test('3. a folder already on the machine: the workspace, the session and its first message in one request', async () => {
    const before = (await workspacesOf(owner.id)).length;
    const created = await onMachine(austin, { workDir: ' /home/orbit/code/app ' });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.createdWorkspace, true);
    const sessionId = toUuid(created.json.id);
    appWorkspace = toUuid(created.json.workspaceId);
    assert.deepEqual(await workspaceRow(appWorkspace), {
      name: 'app', runnerId: austin.runnerId, workDir: '/home/orbit/code/app', enableWorktree: false, autoCreateWorkDir: false,
      ownerId: owner.id, enabled: true,
    });
    assert.deepEqual(await sessionRow(sessionId), {
      workspaceId: appWorkspace, runnerId: austin.runnerId, createdWorkspace: true, prompt: 'Look around this repository',
      status: 'PENDING',
    });
    assert.equal((await workspacesOf(owner.id)).length, before + 1, 'one workspace, no more');
    const detail = await api('GET', `/api/sessions/${uuidToBase62(sessionId)}`, ownerToken);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.createdWorkspace, true, 'the session read says it made its workspace');

    // A session opened in a workspace that already exists did not make it.
    const ordinary = await openSession({ workspaceId: uuidToBase62(appWorkspace) });
    assert.equal(ordinary.status, 201, ordinary.text);
    assert.equal(ordinary.json.createdWorkspace, false);
    assert.equal((await api('GET', `/api/sessions/${ordinary.json.id}`, ownerToken)).json.createdWorkspace, false);

    // A shell-first opening: its opening turn is written with the workspace and the session.
    const shell = await onMachine(austin, { workDir: '/home/orbit/scripts' }, { prompt: 'ls -la', shell: true });
    assert.equal(shell.status, 201, shell.text);
    const shellId = toUuid(shell.json.id);
    assert.deepEqual(await turnsOf(shellId), [{ kind: 'shell', clientTurnId: `initial-${shellId}`, content: 'ls -la' }]);
    assert.equal((await workspaceRow(toUuid(shell.json.workspaceId))).name, 'scripts');
  });

  await t.test('4. a new folder: under the runner\'s reposRoot, and the claim and the reclaim say createWorkDir', async () => {
    const beat = await heartbeat(builder, 'dir-probe/v1,create-workdir/v1', { reposRoot: '/srv/orbit-repos/' });
    assert.equal(beat.status, 201, beat.text);
    const fresh = await onMachine(builder, { newFolder: 'scratch' });
    assert.equal(fresh.status, 201, fresh.text);
    const freshId = toUuid(fresh.json.id);
    const freshWorkspace = toUuid(fresh.json.workspaceId);
    assert.deepEqual(await workspaceRow(freshWorkspace), {
      name: 'scratch', runnerId: builder.runnerId, workDir: '/srv/orbit-repos/scratch', enableWorktree: false,
      autoCreateWorkDir: true, ownerId: owner.id, enabled: true,
    });
    assert.equal((await sessionRow(freshId)).createdWorkspace, true);
    const existing = await onMachine(builder, { workDir: '/srv/existing' });
    assert.equal(existing.status, 201, existing.text);
    const existingId = toUuid(existing.json.id);

    const reclaimed = await api('GET', '/api/runner/sessions/reclaim', builder.token);
    assert.equal(reclaimed.status, 200, reclaimed.text);
    const held = new Map<string, Record<string, unknown>>(
      reclaimed.json.sessions.map((s: { sessionId: string }) => [toUuid(s.sessionId), s]),
    );
    assert.equal(held.get(freshId)?.createWorkDir, true, 'the reclaim says so for a folder Orbit made');
    assert.equal(held.get(freshId)?.workDir, '/srv/orbit-repos/scratch');
    assert.equal(held.has(existingId) && !('createWorkDir' in held.get(existingId)!), true, 'and says nothing for one that was there');

    const claims: Reply[] = [];
    for (let i = 0; i < 2; i += 1) {
      const claim = await api('GET', '/api/runner/sessions/claim', builder.token);
      assert.equal(claim.status, 200, claim.text);
      assert.ok(claim.json?.sessionId, `claim ${i + 1} handed out a session: ${claim.text.slice(0, 300)}`);
      claims.push(claim);
    }
    const claimed = new Map(claims.map((c) => [toUuid(c.json.sessionId), c.json as Record<string, unknown>]));
    assert.equal(claimed.get(freshId)?.createWorkDir, true, 'the claim says so for a folder Orbit made');
    assert.equal(claimed.get(freshId)?.workDir, '/srv/orbit-repos/scratch');
    assert.equal('createWorkDir' in (claimed.get(existingId) ?? { createWorkDir: 'missing' }), false,
      'and the claim of a session in a folder that was there says nothing of it');
  });

  await t.test('5. a name the account already has gets " 2", " 3"; a deleted one\'s and another account\'s are free', async () => {
    const named = async (workDir: string, machine = austin, bearer = ownerToken) => {
      const reply = await openSession({ assignedRunnerId: uuidToBase62(machine.runnerId), newWorkspace: { workDir } }, bearer);
      assert.equal(reply.status, 201, reply.text);
      return (await workspaceRow(toUuid(reply.json.workspaceId))).name as string;
    };
    assert.equal(await named('/home/orbit/other/app'), 'app 2');
    assert.equal(await named('/opt/app/'), 'app 3');
    await sql.query(`UPDATE "workspace" SET "deleted_at" = now() WHERE "owner_id" = $1::uuid AND "name" = 'app 2'`, [owner.id]);
    assert.equal(await named('/var/app'), 'app 2', 'a deleted workspace\'s name is free again');
    // Another account's machine and workspaces count for nothing here.
    const theirs = await prisma.runner.create({
      data: { ownerId: stranger.id, name: `theirs-${RUN}`, tokenHash: sha256(randomUUID()), status: 'ONLINE', lastHeartbeatAt: new Date() },
    });
    assert.equal(await named('/home/them/app', { runnerId: theirs.id, token: '' }, strangerToken), 'app');
  });

  // ── 6. one transaction ───────────────────────────────────────────────────────────────────────────────────────
  await t.test('6. a failure after the workspace is written leaves no workspace and no session', async () => {
    const title = `refused by the spec ${RUN}`;
    // A session INSERT that fails, as anything in the transaction after the workspace could.
    await sql.query(`CREATE OR REPLACE FUNCTION first_workspace_spec_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'first-workspace spec: this session INSERT is refused'; END $$ LANGUAGE plpgsql`);
    await sql.query(`CREATE TRIGGER first_workspace_spec_refuse BEFORE INSERT ON "session" FOR EACH ROW
      WHEN (NEW."title" = '${title}') EXECUTE FUNCTION first_workspace_spec_refuse()`);
    try {
      const before = await workspacesOf(owner.id);
      const refused = await onMachine(austin, { workDir: `/home/orbit/rollback-${RUN}` }, { title });
      assert.equal(refused.status, 500, refused.text);
      assert.deepEqual(await workspacesOf(owner.id), before, 'the workspace written before the failure was rolled back');
      assert.equal((await sql.query(`SELECT 1 FROM "workspace" WHERE "work_dir" = $1`, [`/home/orbit/rollback-${RUN}`])).rowCount, 0);
      assert.equal((await sql.query(`SELECT 1 FROM "session" WHERE "title" = $1`, [title])).rowCount, 0);
    } finally {
      await sql.query(`DROP TRIGGER IF EXISTS first_workspace_spec_refuse ON "session"`);
      await sql.query(`DROP FUNCTION IF EXISTS first_workspace_spec_refuse()`);
    }
    // The same request, nothing refusing it: made.
    const made = await onMachine(austin, { workDir: `/home/orbit/rollback-${RUN}` }, { title });
    assert.equal(made.status, 201, made.text);
    assert.equal((await workspaceRow(toUuid(made.json.workspaceId))).name, `rollback-${RUN}`);
  });

  // ── 7. refusals ──────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('7. refused, with nothing written: another account\'s machine 403, a runner that cannot make a folder 409, a malformed request 400', async () => {
    const ownerBefore = await workspacesOf(owner.id);
    const strangerBefore = await workspacesOf(stranger.id);

    for (const newWorkspace of [{ workDir: '/home/orbit/code/app' }, { newFolder: 'scratch' }]) {
      const reply = await openSession({ assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace }, strangerToken);
      assert.equal(reply.status, 403, `${JSON.stringify(newWorkspace)}: ${reply.text}`);
    }

    // austin declares dir-probe/v1 alone: it does not make folders.
    const tooOld = await onMachine(austin, { newFolder: 'scratch' });
    assert.equal(tooOld.status, 409, tooOld.text);
    assert.equal(tooOld.json.code, 'NEW_FOLDER_UNSUPPORTED');
    // One that does, but has not said where its folders go.
    const rootless = await prisma.runner.create({
      data: {
        ownerId: owner.id, name: `rootless-${RUN}`, tokenHash: sha256(randomUUID()), status: 'ONLINE', lastHeartbeatAt: new Date(),
        capabilities: ['dir-probe/v1', 'create-workdir/v1'], capabilitiesReportedAt: new Date(),
      },
    });
    const noRoot = await onMachine({ runnerId: rootless.id, token: '' }, { newFolder: 'scratch' });
    assert.equal(noRoot.status, 409, noRoot.text);
    assert.equal(noRoot.json.code, 'NEW_FOLDER_UNSUPPORTED');

    const malformed: Array<[string, Record<string, unknown>]> = [
      ['both', { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: { workDir: '/a', newFolder: 'b' } }],
      ['neither', { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: {} }],
      ['a workspace too', { assignedRunnerId: uuidToBase62(austin.runnerId), workspaceId: uuidToBase62(appWorkspace), newWorkspace: { workDir: '/a' } }],
      ['no machine', { newWorkspace: { workDir: '/a' } }],
      ['..', { assignedRunnerId: uuidToBase62(builder.runnerId), newWorkspace: { newFolder: '..' } }],
      ['a path for a name', { assignedRunnerId: uuidToBase62(builder.runnerId), newWorkspace: { newFolder: 'a/b' } }],
      ['an empty folder', { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: { workDir: '  ' } }],
      ['not an object', { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: '/a' }],
      ['a folder of no workspace', { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: { workDir: '/a' }, folderId: uuidToBase62(randomUUID()) }],
    ];
    for (const [what, body] of malformed) {
      const reply = await openSession(body);
      assert.equal(reply.status, 400, `${what}: ${reply.text}`);
    }

    // An engine signed out on the machine is the refusal it always was.
    const signedOut = await prisma.runner.create({
      data: {
        ownerId: owner.id, name: `signed-out-${RUN}`, tokenHash: sha256(randomUUID()), status: 'ONLINE', lastHeartbeatAt: new Date(),
        engines: [{ engine: 'claude', installed: true, auth: 'no' }],
      },
    });
    const notSignedIn = await onMachine({ runnerId: signedOut.id, token: '' }, { workDir: '/home/orbit/code/app' });
    assert.equal(notSignedIn.status, 409, notSignedIn.text);
    assert.equal(notSignedIn.json.code, ENGINE_SIGNED_OUT);

    assert.deepEqual(await workspacesOf(owner.id), ownerBefore, 'no refusal wrote a workspace of the owner\'s');
    assert.deepEqual(await workspacesOf(stranger.id), strangerBefore, 'nor of the stranger\'s');
  });

  await t.test('8. an access token makes a workspace only with workspaces:write, the scope POST /workspaces asks for', async () => {
    const issue = async (scopes: string[]) => {
      const issued = await api('POST', '/api/access-tokens', ownerToken, { name: `first-workspace ${scopes.join(' ')} ${RUN}`, scopes, expiresInDays: 30 });
      assert.equal(issued.status, 201, issued.text);
      return issued.json.token as string;
    };
    const before = await workspacesOf(owner.id);
    const narrow = await openSession(
      { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: { workDir: `/home/orbit/token-${RUN}` } },
      await issue(['sessions:write']),
    );
    assert.equal(narrow.status, 403, narrow.text);
    assert.deepEqual([narrow.json.code, narrow.json.scope], ['PAT_SCOPE_MISSING', 'workspaces:write']);
    assert.deepEqual(await workspacesOf(owner.id), before, 'refused with nothing written');
    const wide = await openSession(
      { assignedRunnerId: uuidToBase62(austin.runnerId), newWorkspace: { workDir: `/home/orbit/token-${RUN}` } },
      await issue(['sessions:write', 'workspaces:write']),
    );
    assert.equal(wide.status, 201, wide.text);
    assert.equal(wide.json.createdWorkspace, true);
    assert.equal((await workspacesOf(owner.id)).length, before.length + 1);
  });
});
