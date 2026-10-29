/**
 * DELETE /api/runner/runners/:id and DELETE /api/runner/workspaces/:id — a session deleting one of the
 * account's runners or workspaces (`orbit runner delete`, `orbit agent delete`, the runner_delete and
 * agent_delete MCP tools) — against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty,
 * through the production apiserver (`build/main.js`: RunnerAuthGuard, the orchestration gate, the approvals
 * route and the owner's decision route in front of it). What it is held to:
 *
 *   (1) the card is filed through the approvals route with the server's reading of the runner — its name,
 *       that it is offline, the workspace that goes with it — and not with the words the asker sent;
 *   (2) nothing is deleted on that card while it waits, nor after the owner declines it;
 *   (3) the owner's yes, given through the app's decision route, deletes the runner and the workspace bound
 *       to it, and the answer names what was deleted;
 *   (4) a workspace goes the same way, soft-deleted as the web deletes one;
 *   (5) no card is filed about the asking session's own runner or workspace, or about another account's
 *       runner, and another account's session cannot delete the runner.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-delete.pg.spec.ts
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

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('a session deletes a runner or a workspace only on the owner\'s card, and the card says what the server reads', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-delete-spec-${randomUUID()}`;
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
    const email = `${name}-${RUN}@runner-delete.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({ data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', ...data } });
    return { id, token };
  }
  async function workspace(ownerId: string, runnerId: string, name: string) {
    const id = randomUUID();
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `${name}-${RUN}`, enabled: true } });
    return id;
  }
  /** A machine a session runs on and that session, holding the credential its runner asks for, as `orbit mcp` does. */
  async function caller(ownerId: string, name: string) {
    const machine = await runner(ownerId, name, { lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000) });
    const workspaceId = await workspace(ownerId, machine.id, `${name}-workspace`);
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id, title: `${name} orchestrator`,
        prompt: 'tidy up the runners', provider: 'claude', providerBuiltin: true, status: RunStatus.AWAITING_INPUT,
        runtimeSessionId: randomUUID(), startedAt: new Date(), runClaimedAt: new Date(), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    const issued = await call(server!, 'POST', `/api/runner/sessions/${sessionId}/orchestration-credential`, machine.token);
    assert.equal(issued.status, 200, issued.text);
    return {
      ...machine,
      workspaceId,
      sessionId,
      headers: { 'x-orbit-session-id': sessionId, 'x-orbit-session-token': issued.json.orchestrationToken as string },
    };
  }

  const alice = await owner('alice');
  const bob = await owner('bob');
  const asker = await caller(alice.id, 'alice-caller');
  const stranger = await caller(bob.id, 'bob-caller');
  // A rented machine that went quiet six hours ago, with the one workspace that ran on it.
  const rented = await runner(alice.id, 'instance', { lastHeartbeatAt: new Date(Date.now() - 6 * 3_600_000) });
  const loadtest = await workspace(alice.id, rented.id, 'c2b-loadtest');
  const spare = await workspace(alice.id, asker.id, 'spare');

  type Asker = typeof asker;
  const card = (toolName: string, input: Record<string, unknown>, who: Asker = asker) =>
    call(server!, 'POST', `/api/runner/sessions/${who.sessionId}/approvals`, who.token, { toolName, input });
  const answer = async (approvalId: string, behavior: 'allow' | 'deny') => {
    const reply = await call(server!, 'POST', `/api/sessions/${asker.sessionId}/approvals/${approvalId}/decision`,
      await alice.login(), { behavior });
    assert.ok(reply.status < 300, reply.text);
  };
  const remove = (path: string, who: Asker = asker) =>
    call(server!, 'DELETE', `/api/runner/${path}`, who.token, undefined, who.headers);
  const runnerRow = (id: string) => db.runner.findUnique({ where: { id }, select: { id: true } });

  await t.test('(1) the card says what the server reads about the runner', async () => {
    const filed = await card('orbit_runner_delete', { runnerId: uuidToBase62(rented.id), name: 'a harmless scratch box' });
    assert.ok(filed.status < 300, filed.text);
    assert.equal(filed.json.status, 'PENDING');
    const stored = await db.approval.findUniqueOrThrow({ where: { id: toUuid(filed.json.id) }, select: { input: true } });
    const input = stored.input as Record<string, unknown>;
    assert.equal(typeof input.lastHeartbeatAt, 'string');
    assert.deepEqual({ ...input, lastHeartbeatAt: '(a time)' }, {
      runnerId: rented.id,
      name: `instance-${RUN}`,
      displayName: null,
      online: false,
      lastHeartbeatAt: '(a time)',
      workspaces: [{ id: loadtest, name: `c2b-loadtest-${RUN}`, workDir: null }],
    });

    // (2) waiting, then declined: nothing is deleted.
    for (const step of ['waiting', 'declined']) {
      if (step === 'declined') await answer(filed.json.id, 'deny');
      const refused = await remove(`runners/${uuidToBase62(rented.id)}`);
      assert.equal(refused.status, 403, `${step}: ${refused.text}`);
      assert.equal(refused.json.code, 'DELETE_APPROVAL_REQUIRED', step);
      assert.ok(await runnerRow(rented.id), `${step}: the runner is still there`);
    }
  });

  await t.test('(3) the owner\'s yes deletes the runner and the workspace bound to it', async () => {
    const filed = await card('orbit_runner_delete', { runnerId: rented.id });
    await answer(filed.json.id, 'allow');
    const deleted = await remove(`runners/${uuidToBase62(rented.id)}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.ok, true);
    assert.equal(toUuid(deleted.json.deleted.runnerId), rented.id);
    assert.deepEqual(deleted.json.deleted.workspaces.map((w: { id: string }) => toUuid(w.id)), [loadtest]);
    assert.equal(await runnerRow(rented.id), null);
    assert.equal(await db.workspace.findUnique({ where: { id: loadtest }, select: { id: true } }), null);
    // Asked again, there is nothing left to delete.
    assert.equal((await remove(`runners/${rented.id}`)).status, 404);
  });

  await t.test('(4) a workspace goes on its own card, soft-deleted as the web deletes one', async () => {
    const unasked = await remove(`workspaces/${uuidToBase62(spare)}`);
    assert.equal(unasked.status, 403, unasked.text);
    const filed = await card('orbit_agent_delete', { agentId: uuidToBase62(spare) });
    assert.ok(filed.status < 300, filed.text);
    await answer(filed.json.id, 'allow');
    const deleted = await remove(`workspaces/${uuidToBase62(spare)}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(toUuid(deleted.json.deleted.agentId), spare);
    const row = await db.workspace.findUniqueOrThrow({ where: { id: spare }, select: { deletedAt: true } });
    assert.ok(row.deletedAt instanceof Date);
  });

  await t.test('(5) no card about the asking session\'s own, or another account\'s, and no reaching across', async () => {
    const before = await db.approval.count({ where: { sessionId: { in: [asker.sessionId, stranger.sessionId] } } });
    assert.equal((await card('orbit_runner_delete', { runnerId: asker.id })).status, 409);
    assert.equal((await card('orbit_agent_delete', { agentId: asker.workspaceId })).status, 409);
    assert.equal((await card('orbit_runner_delete', { runnerId: asker.id }, stranger)).status, 404);
    assert.equal(await db.approval.count({ where: { sessionId: { in: [asker.sessionId, stranger.sessionId] } } }), before);
    const across = await remove(`runners/${asker.id}`, stranger);
    assert.equal(across.status, 404, across.text);
    assert.ok(await runnerRow(asker.id));
  });
});
