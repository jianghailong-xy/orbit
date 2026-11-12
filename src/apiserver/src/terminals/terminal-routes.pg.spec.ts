/**
 * The TERMINAL credential's allowlist (docs/terminal-session-design.md, "The terminal credential"), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. One account with two machines: runner A, whose terminal knocks, and runner B. What it is held to:
 *
 *   (a) on runner A's sessions a terminal creates, opens, sends, interrupts, reads events (page and SSE) and answers an
 *       approval card; on runner B's — and on another account's — every one of them is refused 403
 *       TERMINAL_RUNNER_OUT_OF_SCOPE and writes nothing; it cannot make a session on B, nor one that names no machine
 *       or a task;
 *   (b) GET /workspaces and GET /agents answer runner A's workspaces and none of B's;
 *   (c) every owner-channel route (pat-owner-channel-routes.ts) but the approval decision, and the ordinary routes a
 *       terminal has no business on, refuse it 403 TERMINAL_ROUTE_NOT_ALLOWED before reading anything.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/terminals/terminal-routes.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { OWNER_INTERACTIVE_ROUTES } from '../auth/pat-owner-channel-routes';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { TerminalCredentials } from '../auth/terminal-credentials';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const DECISION_ROUTE = 'POST /sessions/:id/approvals/:approvalId/decision';

test('a TERMINAL credential drives only its own runner\'s sessions, and is refused 403 everywhere else', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const jwtSecret = `terminal-routes-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  async function account(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@terminal-routes.invalid`;
    await db.user.create({ data: { id, email, name, role: 'MEMBER', passwordHash: hashPassword(`${name}-password-1`) } });
    const machine = async (label: string) => {
      const runnerId = randomUUID();
      await db.runner.create({ data: { id: runnerId, ownerId: id, name: `${name}-${label}`, tokenHash: sha256(`runner-${randomUUID()}`) } });
      const workspaceId = randomUUID();
      await db.workspace.create({ data: { id: workspaceId, ownerId: id, runnerId, name: `${name} ${label} ${RUN}`, enabled: true } });
      return { runnerId, workspaceId };
    };
    return { id, email, a: await machine('a'), b: await machine('b'), login: await jwt.signAsync({ sub: id, email }) };
  }
  const owner = await account('owner');
  const stranger = await account('stranger');

  // The owner's terminal on runner A, as an approval mints it (terminals/terminal-login.service.ts).
  const { token: terminal, tokenHash } = TerminalCredentials.newSecret();
  const approvedAt = new Date();
  await db.terminalCredential.create({
    data: {
      tokenHash, ownerId: owner.id, runnerId: owner.a.runnerId, machineName: 'owner-a',
      approvedAt, expiresAt: TerminalCredentials.expiryOf(approvedAt),
    },
  });
  server = await startApiserver(url, jwtSecret);

  const api = (method: string, path: string, bearer?: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  const outOfScope = (reply: Reply, what: string, fields: string[]) => {
    const body = expect(reply, 403, what);
    assert.equal(body.code, 'TERMINAL_RUNNER_OUT_OF_SCOPE', what);
    assert.equal(body.credentialKind, 'TERMINAL', what);
    assert.deepEqual(body.fields, fields, what);
  };
  const notAllowed = (reply: Reply, what: string) => {
    const body = expect(reply, 403, what);
    assert.equal(body.code, 'TERMINAL_ROUTE_NOT_ALLOWED', `${what}: ${reply.text}`);
  };
  /** A session the account's login opens in a workspace, with a pending approval card on it. */
  const sessionIn = async (who: { login: string }, workspaceId: string) => {
    const id = toUuid(expect(await api('POST', '/sessions', who.login, { prompt: 'opened by the app', workspaceId }), 201, 'a login opening a session').id);
    const approval = await db.approval.create({ data: { sessionId: id, toolName: 'Bash', input: { command: 'ls' } } });
    return { id, approvalId: approval.id };
  };
  const onA = await sessionIn(owner, owner.a.workspaceId);
  const onB = await sessionIn(owner, owner.b.workspaceId);
  const strangers = await sessionIn(stranger, stranger.a.workspaceId);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: onA.id } })).assignedRunnerId, owner.a.runnerId);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: onB.id } })).assignedRunnerId, owner.b.runnerId);

  await t.test('(a) runner A\'s sessions are driven; runner B\'s and another account\'s are refused 403 and untouched', async () => {
    // Create: on A, through its workspace or its runner; never on B, never nowhere in particular, never a task's work.
    const made = expect(await api('POST', '/sessions', terminal, { prompt: 'from a terminal', workspaceId: owner.a.workspaceId }), 201, 'a terminal opening a session on A');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: toUuid(made.id) } })).assignedRunnerId, owner.a.runnerId);
    const sessionsBefore = await db.session.count({ where: { ownerId: owner.id } });
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', workspaceId: owner.b.workspaceId }), 'a session in B\'s workspace', ['workspaceId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', agentId: owner.b.workspaceId }), 'the same, by its old name', ['agentId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', assignedRunnerId: owner.b.runnerId }), 'a session on runner B', ['assignedRunnerId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', assignedRunnerId: owner.b.runnerId, newWorkspace: { workDir: '/tmp/x' } }), 'a new workspace on B', ['assignedRunnerId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', assignedRunnerId: owner.a.runnerId, workspaceId: owner.b.workspaceId }), 'A\'s runner in B\'s workspace', ['workspaceId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', workspaceId: stranger.a.workspaceId }), 'another account\'s workspace', ['workspaceId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x' }), 'a session naming no machine', ['assignedRunnerId']);
    outOfScope(await api('POST', '/sessions', terminal, { prompt: 'x', workspaceId: owner.a.workspaceId, taskId: randomUUID() }), 'a task\'s work', ['taskId']);
    assert.equal(await db.session.count({ where: { ownerId: owner.id } }), sessionsBefore, 'no refused create wrote a session');

    // Open, read events (page and SSE): on A.
    assert.equal(toUuid(expect(await api('GET', `/sessions/${onA.id}`, terminal), 200, 'opening A\'s session').id), onA.id);
    expect(await api('GET', `/sessions/${onA.id}/events/page?tail=50`, terminal), 200, 'reading A\'s events page');
    const stream = await api('GET', `/sessions/${onA.id}/events`, terminal);
    assert.equal(stream.status, 200, `following A's events answered ${stream.status}: ${stream.text}`);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);

    // Send, interrupt, answer the approval card: on A, each reaching its handler and writing.
    const turnsBefore = await db.conversationTurn.count({ where: { sessionId: onA.id } });
    const sent = await api('POST', `/sessions/${onA.id}/turns`, terminal, { clientTurnId: randomUUID(), content: 'sent from a terminal' });
    assert.ok(sent.status === 200 || sent.status === 201, `sending to A's session answered ${sent.status}: ${sent.text}`);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: onA.id } }), turnsBefore + 1, 'the turn was filed');
    const interrupted = await api('POST', `/sessions/${onA.id}/interrupt`, terminal);
    assert.ok(![401, 403].includes(interrupted.status) && interrupted.status < 500, `interrupting A's session answered ${interrupted.status}: ${interrupted.text}`);
    const answered = await api('POST', `/sessions/${onA.id}/approvals/${onA.approvalId}/decision`, terminal, { behavior: 'allow' });
    assert.ok(answered.status === 200 || answered.status === 201, `answering A's card answered ${answered.status}: ${answered.text}`);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: onA.approvalId } })).status, 'ALLOWED');

    // The same seven doors on B's session and on another account's: 403, and nothing moves.
    for (const other of [onB, strangers]) {
      const what = other === onB ? 'runner B\'s session' : 'another account\'s session';
      const turns = await db.conversationTurn.count({ where: { sessionId: other.id } });
      const session = await db.session.findUniqueOrThrow({ where: { id: other.id } });
      outOfScope(await api('GET', `/sessions/${other.id}`, terminal), `opening ${what}`, [':id']);
      outOfScope(await api('GET', `/sessions/${other.id}/events/page?tail=50`, terminal), `reading ${what}'s events page`, [':id']);
      outOfScope(await api('GET', `/sessions/${other.id}/events`, terminal), `following ${what}'s events`, [':id']);
      outOfScope(await api('POST', `/sessions/${other.id}/turns`, terminal, { clientTurnId: randomUUID(), content: 'x' }), `sending to ${what}`, [':id']);
      outOfScope(await api('POST', `/sessions/${other.id}/interrupt`, terminal), `interrupting ${what}`, [':id']);
      outOfScope(await api('POST', `/sessions/${other.id}/approvals/${other.approvalId}/decision`, terminal, { behavior: 'allow' }), `answering ${what}'s card`, [':id']);
      assert.equal(await db.conversationTurn.count({ where: { sessionId: other.id } }), turns, `${what}: no turn`);
      assert.equal((await db.approval.findUniqueOrThrow({ where: { id: other.approvalId } })).status, 'PENDING', `${what}: card unanswered`);
      const after = await db.session.findUniqueOrThrow({ where: { id: other.id } });
      assert.equal(after.status, session.status, `${what}: status unchanged`);
      assert.equal(after.cancelRequestedAt?.getTime(), session.cancelRequestedAt?.getTime(), `${what}: not interrupted`);
    }
    outOfScope(await api('GET', `/sessions/${randomUUID()}`, terminal), 'a session that does not exist', [':id']);
    // The owner's app login still reaches B: the refusal is the terminal's alone.
    expect(await api('GET', `/sessions/${onB.id}`, owner.login), 200, 'the owner\'s login opening B\'s session');
  });

  await t.test('(b) the workspace list answers runner A\'s workspaces only', async () => {
    for (const path of ['/workspaces', '/agents']) {
      const listed = (expect(await api('GET', path, terminal), 200, `a terminal listing ${path}`) as Array<{ id: string }>).map((w) => toUuid(w.id));
      assert.deepEqual(listed, [owner.a.workspaceId], path);
      const all = (expect(await api('GET', path, owner.login), 200, `the login listing ${path}`) as Array<{ id: string }>).map((w) => toUuid(w.id));
      assert.deepEqual(all.sort(), [owner.a.workspaceId, owner.b.workspaceId].sort(), `${path} by the login`);
    }
    notAllowed(await api('GET', `/workspaces/${owner.a.workspaceId}`, terminal), 'a terminal reading one workspace');
  });

  await t.test('(c) every owner-channel route but the approval decision, and the ordinary routes, refuse it 403', async () => {
    const fill = (route: string) => route.split(' ')[1].replace(/:approvalId/g, onA.approvalId).replace(/:id\b/g, onA.id).replace(/:\w+/g, randomUUID());
    const sessionsBefore = await db.session.count({ where: { ownerId: owner.id } });
    const refused: string[] = [];
    for (const route of OWNER_INTERACTIVE_ROUTES) {
      if (route === DECISION_ROUTE) continue;
      notAllowed(await api(route.split(' ')[0], fill(route), terminal, {}), `a terminal on ${route}`);
      refused.push(route);
    }
    assert.ok(refused.length >= 20, `knocked on ${refused.length} owner-channel routes`);
    const ordinary = [
      'GET /sessions', `GET /sessions/${onA.id}/approvals`, `POST /sessions/${onA.id}/end`, `PATCH /sessions/${onA.id}/config`,
      `DELETE /sessions/${onA.id}`, `POST /sessions/${onA.id}/merge`, `GET /sessions/${onA.id}/diff`, 'POST /workspaces',
      `PATCH /workspaces/${owner.a.workspaceId}`, 'GET /tasks', 'POST /tasks', 'GET /projects', 'POST /projects', 'GET /runners',
      'GET /users/me', 'GET /terminals', 'GET /access-tokens', 'GET /terminals/requests',
    ];
    for (const knock of ordinary) {
      const [method, path] = knock.split(' ');
      notAllowed(await api(method, path, terminal, method === 'GET' ? undefined : {}), `a terminal on ${knock}`);
    }
    assert.equal(await db.session.count({ where: { ownerId: owner.id } }), sessionsBefore, 'nothing was written');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: onA.id } })).deletedAt, null, 'A\'s session is not deleted');
  });
});
