/**
 * GET /api/runner/runners — the account's runners as an in-session orchestrator reads them (`orbit runner
 * list`, the `runner_list` MCP tool) — against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty, through the production apiserver (`build/main.js`, the whole AppModule: RunnerAuthGuard, the
 * orchestration gate and PublicIdInterceptor in front of the route). What it is held to:
 *
 *   (1) every runner of the calling account is listed, its managed runner among them, in the web runner
 *       list's order, and no runner of another account — whose own call lists its own runner alone;
 *   (2) `online` and `lastHeartbeatAt` are the web runner list's (GET /api/runners), runner by runner, over
 *       each way a runner can be heard from or not: a fresh presence beat, a stale one, its own record
 *       alone, signed off with a fresh beat, draining, a managed runner put to sleep, and never heard from;
 *   (3) nothing of a credential: no runner token or its hash, and no workspace environment value, anywhere
 *       in the answer; every runner carries exactly the view's fields, `os` and `engines` only when its
 *       heartbeats reported them, `engines` the installed ones with the sign-in the web list shows;
 *   (4) the gate is the workspace list's: GET /api/runner/workspaces and this route answer the same calls
 *       with the same status — refusing no runner token, no session, no credential, a credential another
 *       runner holds, and an account whose Session orchestration is off.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-runners.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every field the view gives a runner; `os` and `engines` only when its heartbeats reported them. */
const VIEW_FIELDS = [
  'displayName', 'engines', 'id', 'lastHeartbeatAt', 'maxConcurrent', 'name', 'online', 'os', 'publicId', 'status',
  'version', 'workspaceCount',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listed = Record<string, any>;

test('GET /api/runner/runners: the account’s runners, online as the web list reads them, with nothing of a credential', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-runners-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  server = await startApiserver(url, jwtSecret);

  async function owner(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@runner-runners.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  const tokens: string[] = [];
  async function runner(ownerId: string, name: string, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    tokens.push(token);
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', ...data },
    });
    return { id, token };
  }
  const beat = (runnerId: string, agoMs: number) =>
    db.runnerPresence.create({ data: { runnerId, lastBeatAt: new Date(Date.now() - agoMs), linkState: 'HTTP' } });
  async function workspace(ownerId: string, runnerId: string, name: string, data: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `${name}-${RUN}`, enabled: true, ...data } });
    return id;
  }
  /**
   * A machine a session runs on, and that session: open and waiting, with the credential its runner asks the
   * control plane for, as `orbit mcp` holds it. The machine's own record is two hours ahead, as the census's
   * is, so no reaper reads it offline and ends the session while the run is still asking as it.
   */
  async function caller(ownerId: string, name: string) {
    const machine = await runner(ownerId, name, { lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000) });
    const workspaceId = await workspace(ownerId, machine.id, `${name}-workspace`);
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id, title: `${name} orchestrator`,
        prompt: 'list the runners', provider: 'claude', providerBuiltin: true, status: RunStatus.AWAITING_INPUT,
        runtimeSessionId: randomUUID(), startedAt: new Date(), runClaimedAt: new Date(), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    const issued = await call(server!, 'POST', `/api/runner/sessions/${sessionId}/orchestration-credential`, machine.token);
    assert.equal(issued.status, 200, issued.text);
    const credential = issued.json.orchestrationToken as string;
    assert.equal(typeof credential, 'string');
    return {
      ...machine,
      workspaceId,
      sessionId,
      headers: { 'x-orbit-session-id': sessionId, 'x-orbit-session-token': credential } as Record<string, string>,
    };
  }

  const alice = await owner('alice');
  const bob = await owner('bob');
  const aliceCalls = await caller(alice.id, 'alice-caller');
  const bobCalls = await caller(bob.id, 'bob-caller');
  const listAs = (who: { token: string; headers: Record<string, string> }) =>
    call(server!, 'GET', '/api/runner/runners', who.token, undefined, who.headers);

  // ── the account's machines, each heard from — or not — another way ──────────────────────────────
  const live = await runner(alice.id, 'live', {
    displayName: 'Build box', version: '0.9.1', maxConcurrent: 8, position: 1,
    lastHeartbeatAt: new Date(Date.now() - 10 * MINUTE),
    // What its heartbeats reported: the OS its process names, and its engines — two installed, one not.
    capabilities: ['runner-v1', 'provider:claude', 'os:linux'],
    capabilitiesReportedAt: new Date(),
    engines: [
      { engine: 'claude', installed: true, version: '2.1.0', auth: 'yes' },
      { engine: 'codex', installed: true, version: '0.164.0', auth: 'no' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ],
  });
  await beat(live.id, 5_000);
  const stale = await runner(alice.id, 'stale', { position: 0, lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  await beat(stale.id, 10 * MINUTE);
  const recordOnly = await runner(alice.id, 'record-only', { lastHeartbeatAt: new Date(Date.now() - 20_000) });
  const signedOff = await runner(alice.id, 'signed-off', { status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  await beat(signedOff.id, 5_000);
  const draining = await runner(alice.id, 'draining', { status: 'DRAINING', lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  await beat(draining.id, 5_000);
  const never = await runner(alice.id, 'never-heard');
  // The account's managed runner, put to sleep by its manager: its row as the manager writes one, and its default workspace.
  const managed = await runner(alice.id, 'managed', { status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  const managedWorkspaceId = await workspace(alice.id, managed.id, 'managed-default');
  await db.managedRunner.create({
    data: {
      ownerId: alice.id, runnerId: managed.id, defaultWorkspaceId: managedWorkspaceId, clusterKey: 'runner-runners-spec',
      namespace: 'orbit', pvcName: `mr-data-${managed.id}`, desiredState: 'SLEEPING', managementState: 'SLEEPING',
    },
  });
  // Bound to `live`: two of the account's workspaces, one carrying a secret in its environment, and one deleted.
  const secret = `workspace-secret-${randomUUID()}`;
  await workspace(alice.id, live.id, 'live-one', { env: { API_KEY: secret } });
  await workspace(alice.id, live.id, 'live-two');
  await workspace(alice.id, live.id, 'live-deleted', { deletedAt: new Date() });

  const expectedOnline: Record<string, boolean> = {
    [aliceCalls.id]: true,
    [live.id]: true,
    [stale.id]: false,
    [recordOnly.id]: true,
    [signedOff.id]: false,
    [draining.id]: true,
    [never.id]: false,
    [managed.id]: false,
  };
  const aliceIds = Object.keys(expectedOnline);

  // Both readings at once, so no runner crosses the offline line between them.
  const [listed, web] = await Promise.all([
    listAs(aliceCalls),
    call(server!, 'GET', '/api/runners', await alice.login()),
  ]);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(web.status, 200, web.text);
  const mine = listed.json as Listed[];
  const webList = web.json as Listed[];
  const byId = new Map(mine.map((r) => [toUuid(String(r.id)), r]));

  await t.test('(1) every runner of the account, in the web list’s order, and nobody else’s', async () => {
    assert.deepEqual([...byId.keys()].sort(), [...aliceIds].sort(), 'exactly the account’s eight runners, the managed one included');
    assert.deepEqual(
      mine.map((r) => toUuid(String(r.id))),
      webList.map((r) => toUuid(String(r.id))),
      'the web runner list’s order: by position, then enrollment',
    );
    assert.deepEqual(mine.slice(0, 2).map((r) => toUuid(String(r.id))), [stale.id, live.id], 'the positioned two first');
    assert.equal(byId.has(bobCalls.id), false, 'another account’s runner is not listed');

    const theirs = await listAs(bobCalls);
    assert.equal(theirs.status, 200, theirs.text);
    assert.deepEqual((theirs.json as Listed[]).map((r) => toUuid(String(r.id))), [bobCalls.id], 'and that account lists its own alone');
  });

  await t.test('(2) online and lastHeartbeatAt answer as the web runner list does, runner by runner', async () => {
    const webById = new Map(webList.map((r) => [toUuid(String(r.id)), r]));
    for (const id of aliceIds) {
      const ours = byId.get(id)!;
      const theirs = webById.get(id)!;
      assert.equal(ours.online, theirs.online, `${ours.name}: online as the web list reads it`);
      assert.equal(ours.online, expectedOnline[id], `${ours.name}: online ${expectedOnline[id]}`);
      assert.equal(ours.lastHeartbeatAt, theirs.lastHeartbeatAt, `${ours.name}: the same last beat`);
      assert.equal(ours.status, theirs.status, `${ours.name}: the status it reported`);
    }
    assert.equal(byId.get(never.id)!.lastHeartbeatAt, null, 'never heard from: no last beat');
    assert.equal(
      new Date(byId.get(live.id)!.lastHeartbeatAt).getTime() > Date.now() - MINUTE,
      true,
      'the presence beat, not the ten-minute-old record',
    );
  });

  await t.test('(3) nothing of a credential, and exactly the view’s fields', async () => {
    for (const token of tokens) {
      assert.equal(listed.text.includes(token), false, 'no runner token');
      assert.equal(listed.text.includes(sha256(token)), false, 'no runner token hash');
    }
    assert.equal(listed.text.includes(secret), false, 'no workspace environment value');
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(listed.json);
    assert.deepEqual([...keys].filter((key) => /token|secret|hash|password|env$|key/i.test(key)), [], 'no field that could carry one');
    for (const r of mine) {
      assert.deepEqual(Object.keys(r).filter((key) => !VIEW_FIELDS.includes(key)), [], `${r.name}: only the view's fields`);
      assert.equal(r.publicId, r.id, `${r.name}: its id is the public id`);
      assert.equal(r.id, uuidToBase62(toUuid(String(r.id))), `${r.name}: spelled base62`);
    }

    const box = byId.get(live.id)!;
    assert.deepEqual(Object.keys(box).sort(), [...VIEW_FIELDS].sort(), 'a runner that reported everything has every field');
    assert.equal(box.name, `live-${RUN}`);
    assert.equal(box.displayName, 'Build box');
    assert.equal(box.version, '0.9.1');
    assert.equal(box.maxConcurrent, 8);
    assert.equal(box.os, 'linux');
    assert.deepEqual(box.engines, [{ engine: 'claude', auth: 'yes' }, { engine: 'codex', auth: 'no' }], 'the installed engines and their sign-in');
    const webBox = webList.find((r) => toUuid(String(r.id)) === live.id)!;
    assert.deepEqual(
      box.engines,
      (webBox.engines as Listed[]).filter((e) => e.installed).map(({ engine, auth }) => ({ engine, auth })),
      'signed in or not as the web list shows each engine',
    );
    assert.equal(box.workspaceCount, 2, 'the two workspaces bound to it, not the deleted one');

    const quiet = byId.get(stale.id)!;
    assert.equal('os' in quiet, false, 'no OS reported: none given');
    assert.equal('engines' in quiet, false, 'no engines reported: none given');
    assert.equal(quiet.workspaceCount, 0);
    assert.equal(byId.get(managed.id)!.workspaceCount, 1, 'the managed runner’s default workspace');
    assert.equal(byId.get(aliceCalls.id)!.workspaceCount, 1);
  });

  await t.test('(4) refused exactly where the workspace list is refused', async () => {
    const both = async (token: string | undefined, headers: Record<string, string>): Promise<[Reply, Reply]> =>
      Promise.all([
        call(server!, 'GET', '/api/runner/runners', token, undefined, headers),
        call(server!, 'GET', '/api/runner/workspaces', token, undefined, headers),
      ]);
    const cases: Array<[string, string | undefined, Record<string, string>, number]> = [
      ['the session’s own credential', aliceCalls.token, aliceCalls.headers, 200],
      ['no runner token', undefined, aliceCalls.headers, 401],
      ['no session', aliceCalls.token, {}, 400],
      ['no credential', aliceCalls.token, { 'x-orbit-session-id': aliceCalls.sessionId }, 403],
      ['another account’s runner holding this credential', bobCalls.token, aliceCalls.headers, 403],
      ['this credential for another account’s session', aliceCalls.token, { ...aliceCalls.headers, 'x-orbit-session-id': bobCalls.sessionId }, 403],
    ];
    for (const [what, token, headers, status] of cases) {
      const [runners, workspaces] = await both(token, headers);
      assert.equal(workspaces.status, status, `${what}: the workspace list answers ${status} (${workspaces.text})`);
      assert.equal(runners.status, status, `${what}: and so does the runner list (${runners.text})`);
    }

    await db.user.update({ where: { id: alice.id }, data: { preferences: { enableOrchestration: false } } });
    try {
      const [runners, workspaces] = await both(aliceCalls.token, aliceCalls.headers);
      assert.equal(workspaces.status, 403, `Session orchestration off: the workspace list refuses (${workspaces.text})`);
      assert.equal(runners.status, 403, `and so does the runner list (${runners.text})`);
    } finally {
      await db.user.update({ where: { id: alice.id }, data: { preferences: {} } });
    }
    const [again] = await both(aliceCalls.token, aliceCalls.headers);
    assert.equal(again.status, 200, `switched back on, it answers again (${again.text})`);
  });
});
