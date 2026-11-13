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
 *       terminal has no business on, refuse it 403 TERMINAL_ROUTE_NOT_ALLOWED before reading anything;
 *   (d) POST /attachments takes a file for runner A's session, and is refused 403 with no session, with B's or
 *       another account's session, or as a task's input, storing nothing; GET /runners answers runner A alone, never
 *       B; GET /providers answers the account's providers with no key and no endpoint in it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/terminals/terminal-routes.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
  // A provider of the owner's, with a key and an endpoint GET /providers must never carry.
  const providerSlug = `terminal-routes-${RUN}`;
  const providerKey = `iv:tag:secret-${randomUUID()}`;
  const providerUrl = `https://secret-endpoint-${RUN}.test`;
  await db.modelProvider.create({
    data: { slug: providerSlug, label: 'terminal routes', runtime: 'claude', ownerId: owner.id, baseUrl: providerUrl, apiKeyEnc: providerKey, enabled: true },
  });
  // Uploads land in a folder of this run's, on the local backend, as the file specs keep them.
  const filesDir = mkdtempSync(path.join(os.tmpdir(), 'terminal-routes-files-'));
  t.after(() => rmSync(filesDir, { recursive: true, force: true }));
  server = await startApiserver(url, jwtSecret, { ORBIT_FILES_BACKEND: 'local', ORBIT_FILES_DIR: filesDir });

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
  /** POST /attachments as the clients send it: multipart/form-data with one `file`. */
  const upload = (query: string, bearer: string): Promise<Reply> => new Promise((resolve, reject) => {
    const boundary = `----terminal-routes-${randomUUID()}`;
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`
        + `a file from a terminal\r\n--${boundary}--\r\n`,
    );
    const req = http.request({
      host: '127.0.0.1', port: server!.port, path: `/api/attachments${query}`, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': payload.length },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
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
    const clientTurnId = randomUUID();
    const sent = await api('POST', `/sessions/${onA.id}/turns`, terminal, { clientTurnId, content: 'sent from a terminal' });
    assert.ok(sent.status === 200 || sent.status === 201, `sending to A's session answered ${sent.status}: ${sent.text}`);
    // The turn itself (a session never claimed files its opening turn beside it, so a count says less).
    const filed = await db.conversationTurn.findMany({ where: { sessionId: onA.id, clientTurnId }, select: { content: true } });
    assert.deepEqual(filed, [{ content: 'sent from a terminal' }], 'the turn was filed');
    const interrupted = await api('POST', `/sessions/${onA.id}/interrupt`, terminal);
    assert.ok(![401, 403].includes(interrupted.status) && interrupted.status < 500, `interrupting A's session answered ${interrupted.status}: ${interrupted.text}`);
    const answered = await api('POST', `/sessions/${onA.id}/approvals/${onA.approvalId}/decision`, terminal, { behavior: 'allow' });
    assert.ok(answered.status === 200 || answered.status === 201, `answering A's card answered ${answered.status}: ${answered.text}`);
    const card = await db.approval.findUniqueOrThrow({ where: { id: onA.approvalId } });
    assert.equal(card.status, 'ALLOWED');
    assert.equal(card.decidedCredentialKind, 'TERMINAL', 'the answer says it came from a terminal (0661)');

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
      `PATCH /workspaces/${owner.a.workspaceId}`, 'GET /tasks', 'POST /tasks', 'GET /projects', 'POST /projects', `GET /runners/${owner.a.runnerId}`,
      'GET /providers/mine', 'GET /attachments/usage',
      'GET /users/me', 'GET /terminals', 'GET /access-tokens', 'GET /terminals/requests',
    ];
    for (const knock of ordinary) {
      const [method, path] = knock.split(' ');
      notAllowed(await api(method, path, terminal, method === 'GET' ? undefined : {}), `a terminal on ${knock}`);
    }
    assert.equal(await db.session.count({ where: { ownerId: owner.id } }), sessionsBefore, 'nothing was written');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: onA.id } })).deletedAt, null, 'A\'s session is not deleted');
  });
  await t.test('(d) attachments to A\'s sessions only; GET /runners is runner A alone; GET /providers carries no secret', async () => {
    const stored = () => db.attachment.count({ where: { ownerId: owner.id } });
    const before = await stored();
    const ok = await upload(`?sessionId=${onA.id}`, terminal);
    assert.ok(ok.status === 200 || ok.status === 201, `a file for A's session answered ${ok.status}: ${ok.text}`);
    const attached = await db.attachment.findUniqueOrThrow({ where: { id: toUuid((ok.json as { id: string }).id) } });
    assert.equal(attached.sessionId, onA.id);
    assert.equal(await stored(), before + 1);

    outOfScope(await upload(`?sessionId=${onB.id}`, terminal), 'a file for runner B\'s session', ['sessionId']);
    outOfScope(await upload(`?sessionId=${strangers.id}`, terminal), 'a file for another account\'s session', ['sessionId']);
    outOfScope(await upload('', terminal), 'a file for no session', ['sessionId']);
    outOfScope(await upload(`?taskId=${randomUUID()}`, terminal), 'a task\'s input', ['taskId', 'sessionId']);
    assert.equal(await stored(), before + 1, 'no refused upload stored a file');
    const byLogin = await upload(`?sessionId=${onB.id}`, owner.login);
    assert.ok(byLogin.status === 200 || byLogin.status === 201, `the login's file for B's session answered ${byLogin.status}`);

    const runners = (expect(await api('GET', '/runners', terminal), 200, 'a terminal listing runners') as Array<{ id: string }>).map((r) => toUuid(r.id));
    assert.deepEqual(runners, [owner.a.runnerId], 'a terminal sees its own runner and never B');
    const all = (expect(await api('GET', '/runners', owner.login), 200, 'the login listing runners') as Array<{ id: string }>).map((r) => toUuid(r.id));
    assert.deepEqual(all.sort(), [owner.a.runnerId, owner.b.runnerId].sort(), 'the login sees both');

    const providers = await api('GET', '/providers', terminal);
    const rows = expect(providers, 200, 'a terminal listing providers') as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r.slug === providerSlug);
    assert.ok(mine, 'the owner\'s provider is listed');
    for (const secret of [providerKey, providerUrl]) assert.ok(!providers.text.includes(secret), `the answer carries ${secret}`);
    for (const row of rows) {
      const fields = Object.keys(row).filter((k) => /apikey|secret|token|baseurl|password/i.test(k));
      assert.deepEqual(fields, [], `provider ${String(row.slug)} carries ${fields.join(', ')}`);
    }
  });
});
