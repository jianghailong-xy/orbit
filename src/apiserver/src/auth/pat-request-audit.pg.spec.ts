/**
 * The request-level audit of personal access tokens (docs/personal-access-token-design.md §6.4),
 * held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. Every write a token makes leaves one
 * `activity` row once it has been answered: the user's, with credential PAT and the token's id.
 * What it is held to:
 *
 *   (1) a write the token's scope lets through leaves `pat.request`: its method, its route template,
 *       the status it was answered — whatever that status is — and the ids its path names, as public
 *       ids however the path spelled them; nothing its body carried. A task it creates keeps its own
 *       `task.created` row beside it;
 *   (2) a write refused for what the token may not do leaves `pat.request.denied` with the refusal's
 *       code: a scope it lacks, a route only the owner acts on, a field only the owner sets, a route
 *       closed to every token, a workspace the token is not confined to;
 *   (3) reads and logins leave nothing: a GET through a token, let through or refused; a write
 *       through a login; a token the server does not know (401);
 *   (4) a record that cannot be written changes nothing for the request: the write is made and
 *       answered as before, a refusal is answered as before, each failure is one log line, and
 *       neither is tried again;
 *   (5) every request-level row there is, is one a request above was answered with.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/pat-request-audit.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates, and the constraint (4) puts on
 * `activity` refuses only that user's records and is dropped again.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PAT_PREFIX, PatService } from './pat.service';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('every write a personal access token makes leaves one activity row once it is answered, let through or refused, and nothing else leaves one', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const probe = `pat_request_audit_probe_${RUN}`;
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await sql.query(`ALTER TABLE activity DROP CONSTRAINT IF EXISTS ${probe}`).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // One account with a workspace, and three tokens: one that writes tasks and projects, one that
  // only reads tasks, and one confined to the workspace.
  const userId = randomUUID();
  const email = `request-audit-${RUN}-${userId}@personal-access-token.invalid`;
  await db.user.create({ data: { id: userId, email, name: 'Audited', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId: userId, name: 'a runner', tokenHash: `request-audit-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId: userId, runnerId, name: `orbit ${RUN}`, enabled: true } });

  const pats = new PatService(db as unknown as PrismaService);
  const issue = (name: string, scopes: string[], workspaceIds?: string[]) =>
    pats.issue(userId, { name, scopes, workspaceIds, expiresInDays: 90, createdVia: 'WEB' });
  const writer = await issue('writer', ['tasks:read', 'tasks:write', 'projects:read', 'projects:write']);
  const reader = await issue('reader', ['tasks:read']);
  const confined = await issue('confined', ['tasks:read', 'tasks:write'], [workspaceId]);
  const jwtSecret = `request-audit-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const answered = (reply: Reply, status: number) => {
    assert.equal(reply.status, status, reply.text);
    return reply;
  };

  /** Every request-level row of this user. */
  const requestRows = async () => (await sql.query(
    `SELECT id, actor_id, type, payload, credential_kind, credential_id FROM activity
      WHERE actor_id = $1 AND type IN ('pat.request', 'pat.request.denied')`,
    [userId],
  )).rows;
  const recorded = new Set<string>();
  /**
   * The row the request just answered left. It is written after the answer, so it is waited for;
   * and every request here is answered before the next is sent, so any row nobody waited for shows
   * up beside it.
   */
  const lastRow = async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const fresh = (await requestRows()).filter((row) => !recorded.has(row.id));
      if (fresh.length > 0) {
        assert.equal(fresh.length, 1, `one request, one row: ${JSON.stringify(fresh)}`);
        recorded.add(fresh[0].id);
        const { id: _id, ...row } = fresh[0];
        return row;
      }
      if (Date.now() > deadline) assert.fail('the request left no activity row');
      await sleep(25);
    }
  };
  /** A row as a token's request leaves it. */
  const through = (token: { id: string }, payload: Record<string, unknown>, type = 'pat.request') => ({
    actor_id: userId,
    type,
    payload,
    credential_kind: 'PAT',
    credential_id: token.id,
  });

  /** What request bodies carry below, none of which may reach the record. */
  const secret = `body text ${RUN} that stays out of the audit`;
  let taskId = '';
  let scopeRefusal: Reply | undefined;

  await t.test('(1) a write the scope lets through leaves pat.request: method, route template, status and the ids its path names, as public ids; nothing its body carried', async () => {
    const created = answered(await api('POST', '/tasks', writer.token, {
      title: `audited: ${secret}`,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    }), 201);
    taskId = created.json.id;
    assert.deepEqual(await lastRow(), through(writer, { method: 'POST', route: '/tasks', status: 201, params: {} }));
    // The task keeps the record its creating transaction wrote: two rows for two uses, not one.
    const createdRows = await sql.query(
      `SELECT type, credential_kind, credential_id FROM activity WHERE payload->>'taskId' = $1`,
      [toUuid(taskId)],
    );
    assert.deepEqual(createdRows.rows, [{ type: 'task.created', credential_kind: 'PAT', credential_id: writer.id }]);

    const comment = answered(await api('POST', `/tasks/${taskId}/comments`, writer.token, { body: secret }), 201);
    assert.deepEqual(await lastRow(), through(writer, { method: 'POST', route: '/tasks/:id/comments', status: 201, params: { id: taskId } }));

    // A path that spells its ids as uuids is recorded in public ids all the same.
    answered(await api('DELETE', `/tasks/${toUuid(taskId)}/comments/${toUuid(comment.json.id)}`, writer.token), 200);
    assert.deepEqual(await lastRow(), through(writer, {
      method: 'DELETE',
      route: '/tasks/:id/comments/:commentId',
      status: 200,
      params: { id: taskId, commentId: comment.json.id },
    }));

    answered(await api('PATCH', `/tasks/${taskId}`, writer.token, { title: `renamed: ${secret}` }), 200);
    assert.deepEqual(await lastRow(), through(writer, { method: 'PATCH', route: '/tasks/:id', status: 200, params: { id: taskId } }));

    // Let through and answered with something else, it is recorded with what it was answered.
    const nowhere = uuidToBase62(randomUUID());
    answered(await api('PATCH', `/tasks/${nowhere}`, writer.token, { title: secret }), 404);
    assert.deepEqual(await lastRow(), through(writer, { method: 'PATCH', route: '/tasks/:id', status: 404, params: { id: nowhere } }));

    const leaked = await sql.query(`SELECT count(*)::int AS rows FROM activity WHERE payload::text LIKE $1`, [`%${secret}%`]);
    assert.deepEqual(leaked.rows, [{ rows: 0 }], 'nothing a request body carried is in the record');
  });

  await t.test("(2) a write refused for what the token may not do leaves pat.request.denied with the refusal's code", async () => {
    const denied = (token: { id: string }, payload: Record<string, unknown>) => through(token, payload, 'pat.request.denied');

    // A scope the token was not granted.
    scopeRefusal = answered(await api('POST', `/tasks/${taskId}/comments`, reader.token, { body: secret }), 403);
    assert.equal(scopeRefusal.json.code, 'PAT_SCOPE_MISSING');
    assert.deepEqual(await lastRow(), denied(reader, {
      method: 'POST',
      route: '/tasks/:id/comments',
      status: 403,
      params: { id: taskId },
      code: 'PAT_SCOPE_MISSING',
      scope: 'tasks:write',
    }));

    // A route only the account owner acts on (§5), refused whatever the token holds.
    const ownerRoute = answered(await api('POST', `/tasks/${taskId}/owner-confirmation`, writer.token, {}), 403);
    assert.equal(ownerRoute.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    assert.deepEqual(await lastRow(), denied(writer, {
      method: 'POST',
      route: '/tasks/:taskId/owner-confirmation',
      status: 403,
      params: { taskId },
      code: 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED',
      reason: 'OWNER_INTERACTIVE',
    }));

    // A field only the owner sets, on a route the token's scope reaches: refused past the guard.
    const project = answered(await api('POST', '/projects', login, {
      title: `audited ${RUN}`,
      acceptanceCriteriaItems: [{ text: 'every token write is recorded', verificationMethod: 'this spec' }],
    }), 201);
    const ownerField = answered(await api('PATCH', `/projects/${project.json.id}`, writer.token, { title: 'renamed', status: 'DONE' }), 403);
    assert.equal(ownerField.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    assert.deepEqual(await lastRow(), denied(writer, {
      method: 'PATCH',
      route: '/projects/:id',
      status: 403,
      params: { id: project.json.id },
      code: 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED',
      reason: 'OWNER_INTERACTIVE',
      fields: ['status'],
    }));

    // A route closed to every token.
    const share = answered(await api('PUT', `/tasks/${taskId}/share`, writer.token, {}), 403);
    assert.equal(share.json.code, 'PAT_FORBIDDEN');
    assert.deepEqual(await lastRow(), denied(writer, {
      method: 'PUT',
      route: '/tasks/:id/share',
      status: 403,
      params: { id: taskId },
      code: 'PAT_FORBIDDEN',
      reason: 'SHARE_LINK',
    }));

    // A task outside the workspace a confined token is confined to.
    const outside = answered(await api('PATCH', `/tasks/${taskId}`, confined.token, { title: secret }), 403);
    assert.equal(outside.json.code, 'PAT_WORKSPACE_OUT_OF_SCOPE');
    assert.deepEqual(await lastRow(), denied(confined, {
      method: 'PATCH',
      route: '/tasks/:id',
      status: 403,
      params: { id: taskId },
      code: 'PAT_WORKSPACE_OUT_OF_SCOPE',
      fields: [':id'],
    }));
  });

  await t.test('(3) reads, writes through a login and tokens the server does not know leave nothing', async () => {
    answered(await api('GET', `/tasks/${taskId}`, writer.token), 200);
    // A read refused its scope is still a read.
    answered(await api('GET', '/projects', reader.token), 403);
    answered(await api('POST', `/tasks/${taskId}/comments`, login, { body: secret }), 201);
    answered(await api('PATCH', `/tasks/${taskId}`, login, { title: 'renamed through a login' }), 200);
    answered(await api('POST', `/tasks/${taskId}/comments`, `${PAT_PREFIX}${'x'.repeat(43)}`, { body: secret }), 401);
    // A row for any of them would have been written right after its answer: the next token write
    // has to be the only new one.
    await sleep(500);
    answered(await api('PATCH', `/tasks/${taskId}`, writer.token, { title: 'after them' }), 200);
    assert.deepEqual(await lastRow(), through(writer, { method: 'PATCH', route: '/tasks/:id', status: 200, params: { id: taskId } }));
  });

  await t.test('(4) a record that cannot be written changes nothing for the request: answered as before, logged once, not tried again', async () => {
    const rowsBefore = (await requestRows()).length;
    // From here PostgreSQL refuses every request-level row of this user.
    await sql.query(
      `ALTER TABLE activity ADD CONSTRAINT ${probe}
         CHECK (actor_id IS DISTINCT FROM '${userId}'::uuid OR type NOT IN ('pat.request', 'pat.request.denied')) NOT VALID`,
    );

    const title = 'renamed while nothing records it';
    const renamed = answered(await api('PATCH', `/tasks/${taskId}`, writer.token, { title }), 200);
    assert.equal(renamed.json.title, title);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: toUuid(taskId) } })).title, title, 'the write was made');
    const refused = answered(await api('POST', `/tasks/${taskId}/comments`, reader.token, { body: secret }), 403);
    assert.deepEqual(refused.json, scopeRefusal!.json, 'the refusal is answered as it was');

    const failures = [
      `could not record PATCH /tasks/:id by access token ${writer.id}: `,
      `could not record POST /tasks/:id/comments by access token ${reader.id}: `,
    ];
    const deadline = Date.now() + 15_000;
    while (!failures.every((line) => server!.output().includes(line))) {
      if (Date.now() > deadline) assert.fail(`the records that could not be written were not logged:\n${server!.output().slice(-6_000)}`);
      await sleep(25);
    }
    await sql.query(`ALTER TABLE activity DROP CONSTRAINT ${probe}`);

    // The next write is recorded again; neither failed record is tried a second time, which would
    // now succeed: one log line each, and no row for either.
    answered(await api('PATCH', `/tasks/${taskId}`, writer.token, { title: 'recorded again' }), 200);
    assert.deepEqual(await lastRow(), through(writer, { method: 'PATCH', route: '/tasks/:id', status: 200, params: { id: taskId } }));
    await sleep(1_000);
    for (const line of failures) assert.equal(server!.output().split(line).length - 1, 1, `logged once: ${line}`);
    assert.equal((await requestRows()).length, rowsBefore + 1, 'no row for either record that could not be written');
  });

  await t.test('(5) every request-level row there is, is one a request above was answered with, and the only other row is the created task', async () => {
    const rows = await requestRows();
    assert.deepEqual(rows.map((row) => row.id).sort(), [...recorded].sort());
    assert.equal(recorded.size, 12);
    const others = await sql.query(
      `SELECT type, credential_kind, credential_id FROM activity
        WHERE actor_id = $1 AND type NOT IN ('pat.request', 'pat.request.denied')`,
      [userId],
    );
    assert.deepEqual(others.rows, [{ type: 'task.created', credential_kind: 'PAT', credential_id: writer.id }]);
  });
});
