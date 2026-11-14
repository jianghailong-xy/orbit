/**
 * An approval card answered with a TERMINAL credential is recorded as the terminal's, with its machine name
 * (docs/terminal-session-design.md, "The terminal credential"; docs/human-only-authority.md, the TERMINAL row; 0663).
 * Held against the production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. What it is held to:
 *
 *   (a) allow once, always allow and deny, each sent by a terminal to POST /sessions/:id/approvals/:approvalId/decision,
 *       write the decision with decided_credential_kind = TERMINAL and decided_terminal_machine_name = the machine
 *       name, and, beside it, one activity row `terminal.approval.decided` with credential_kind = TERMINAL naming
 *       the session, the approval, the answer, the terminal, its runner and the machine;
 *   (b) a second answer to a card already decided writes neither the decision nor another activity row;
 *   (c) the app's login answering a card records LOGIN, no machine name, and no terminal activity row;
 *   (d) the database refuses a TERMINAL decision with no machine name, and a machine name on any other kind
 *       (approval_decided_via_chk).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/terminals/terminal-approval-audit.pg.spec.ts
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
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { TerminalCredentials } from '../auth/terminal-credentials';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const MACHINE = `owner-laptop-${RUN}`;

test('an approval answered by a TERMINAL credential records TERMINAL and the machine name, on the decision and in activity', {
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

  const jwtSecret = `terminal-approval-audit-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const ownerId = randomUUID();
  const email = `owner-${RUN}@terminal-approval-audit.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', role: 'MEMBER', passwordHash: hashPassword('owner-password-1') } });
  const login = await jwt.signAsync({ sub: ownerId, email });
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: `laptop-${RUN}`, tokenHash: sha256(`runner-${randomUUID()}`) } });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `laptop ${RUN}`, enabled: true } });

  // The owner's terminal on that machine, as an approval in the app mints it (terminals/terminal-login.service.ts).
  const { token: terminal, tokenHash } = TerminalCredentials.newSecret();
  const approvedAt = new Date();
  const credential = await db.terminalCredential.create({
    data: { tokenHash, ownerId, runnerId, machineName: MACHINE, approvedAt, expiresAt: TerminalCredentials.expiryOf(approvedAt) },
  });

  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status === 200 || reply.status === 201, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };

  const sessionId = toUuid(ok(await api('POST', '/sessions', login, { prompt: 'opened by the app', workspaceId }), 'the login opening a session').id);
  const card = async () => (await db.approval.create({ data: { sessionId, toolName: 'Bash', input: { command: `ls ${randomUUID()}` } } })).id;
  const decide = (approvalId: string, bearer: string, body: unknown) =>
    api('POST', `/sessions/${sessionId}/approvals/${approvalId}/decision`, bearer, body);
  const activityOf = (approvalId: string) =>
    db.activity.findMany({ where: { payload: { path: ['approvalId'], equals: approvalId } } });

  await t.test('(a) allow once, always allow and deny from a terminal record TERMINAL and the machine name, with one activity row each', async () => {
    const answers = [
      { key: 'y', body: { behavior: 'allow' }, status: 'ALLOWED', remember: null },
      { key: 'a', body: { behavior: 'allow', rememberRules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }, status: 'ALLOWED', remember: [{ toolName: 'Bash', ruleContent: 'ls:*' }] },
      { key: 'n', body: { behavior: 'deny' }, status: 'DENIED', remember: null },
    ] as const;
    for (const answer of answers) {
      const approvalId = await card();
      ok(await decide(approvalId, terminal, answer.body), `the terminal's ${answer.key}`);
      const row = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.equal(row.status, answer.status, answer.key);
      assert.equal(row.decidedCredentialKind, 'TERMINAL', `${answer.key}: the decision says a terminal answered it`);
      assert.equal(row.decidedTerminalMachineName, MACHINE, `${answer.key}: the decision names the machine`);
      assert.equal(row.decidedById, ownerId, answer.key);
      assert.deepEqual(row.rememberRule, answer.remember, `${answer.key}: remember rules`);
      const activity = await activityOf(approvalId);
      assert.equal(activity.length, 1, `${answer.key}: one activity row`);
      assert.equal(activity[0].type, 'terminal.approval.decided');
      assert.equal(activity[0].credentialKind, 'TERMINAL');
      assert.equal(activity[0].credentialId, null);
      assert.equal(activity[0].actorId, ownerId);
      assert.deepEqual(activity[0].payload, {
        sessionId, approvalId, behavior: answer.body.behavior,
        terminalId: credential.id, runnerId, machineName: MACHINE,
      }, `${answer.key}: the activity row names the session, card, answer, terminal, runner and machine`);
    }
  });

  await t.test('(b) a second answer to a decided card writes nothing more', async () => {
    const approvalId = await card();
    ok(await decide(approvalId, terminal, { behavior: 'deny' }), 'the first answer');
    const first = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    ok(await decide(approvalId, terminal, { behavior: 'allow' }), 'the second answer');
    const after = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    assert.equal(after.status, 'DENIED');
    assert.equal(after.decidedAt?.getTime(), first.decidedAt?.getTime());
    assert.equal((await activityOf(approvalId)).length, 1, 'still one activity row');
  });

  await t.test('(c) the app login answering records LOGIN, no machine name and no terminal activity row', async () => {
    const approvalId = await card();
    ok(await decide(approvalId, login, { behavior: 'allow' }), 'the login\'s answer');
    const row = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    assert.equal(row.status, 'ALLOWED');
    assert.equal(row.decidedCredentialKind, 'LOGIN');
    assert.equal(row.decidedTerminalMachineName, null);
    assert.deepEqual(await activityOf(approvalId), []);
  });

  await t.test('(d) approval_decided_via_chk ties the machine name to a TERMINAL decision', async () => {
    const approvalId = await card();
    await assert.rejects(
      sql.query(`UPDATE "approval" SET "decided_credential_kind" = 'TERMINAL' WHERE "id" = $1`, [approvalId]),
      /approval_decided_via_chk/, 'a TERMINAL decision with no machine name',
    );
    await assert.rejects(
      sql.query(`UPDATE "approval" SET "decided_credential_kind" = 'LOGIN', "decided_terminal_machine_name" = 'x' WHERE "id" = $1`, [approvalId]),
      /approval_decided_via_chk/, 'a machine name on a LOGIN decision',
    );
    await assert.rejects(
      sql.query(`INSERT INTO "activity" ("id", "type", "credential_kind", "credential_id") VALUES ($1, 'x', 'TERMINAL', $2)`, [randomUUID(), randomUUID()]),
      /activity_credential_chk/, 'a TERMINAL activity row carrying a credential_id',
    );
  });
});
