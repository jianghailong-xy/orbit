/**
 * A personal access token and the drive (docs/personal-access-token-design.md §4; documents/documents.controller.ts), through the
 * production apiserver — `build/main.js`, the whole AppModule — against a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/documents/documents-pat.pg.spec.ts
 *
 *   (1) a token holding the `files` scope lists and writes the drive through /drive/*: it makes a folder, reads it back, lists,
 *       renames, moves to Trash and reads Trash;
 *   (2) a token without it is refused 403 PAT_SCOPE_MISSING on a read and on a write, and nothing is written;
 *   (3) another account's token holding `files` is answered 404 for this account's entry and Trash group;
 *   (4) a token confined to workspaces is refused 403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('the files scope opens /drive/* to a token, and only that scope, and only for its own account', {
  skip: !URL, concurrency: 1, timeout: 300_000,
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

  const mkUser = async (label: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `drive-pat-${label}-${RUN}@personal-access-token.invalid`, name: label, passwordHash: 'x' } });
    return id;
  };
  const [ownerId, otherId] = [await mkUser('owner'), await mkUser('other')];
  const pats = new PatService(db as unknown as PrismaService);
  const issue = async (userId: string, name: string, scopes: readonly string[], workspaceIds: string[] = []) =>
    (await pats.issue(userId, { name, scopes: [...scopes], expiresInDays: 90, createdVia: 'WEB', workspaceIds })).token;
  const withFiles = await issue(ownerId, 'files', ['files']);
  const without = await issue(ownerId, 'everything but files', PAT_SCOPES.filter((scope) => scope !== 'files'));
  const others = await issue(otherId, 'other files', ['files']);

  server = await startApiserver(url, `drive-pat-${randomUUID()}`);
  const api = (method: string, path: string, bearer: string, body?: unknown) => call(server!, method, `/api${path}`, bearer, body);

  // (1)
  const made = await api('POST', '/drive/folders', withFiles, { name: `reports ${RUN}` });
  assert.equal(made.status, 201, made.text);
  const folderId: string = made.json.id;
  const listed = await api('GET', '/drive/entries', withFiles);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(JSON.stringify(listed.json).includes(folderId), 'the folder is listed');
  assert.equal((await api('GET', `/drive/entries/${folderId}`, withFiles)).status, 200);
  assert.equal((await api('PATCH', `/drive/entries/${folderId}`, withFiles, { name: `renamed ${RUN}` })).status, 200);
  const trashed = await api('DELETE', `/drive/entries/${folderId}`, withFiles);
  assert.equal(trashed.status, 200, trashed.text);
  assert.equal((await api('GET', '/drive/trash', withFiles)).status, 200);
  const groupId: string = trashed.json.id ?? trashed.json.groupId;

  // (2)
  const refusedRead = await api('GET', '/drive/entries', without);
  assert.equal(refusedRead.status, 403);
  assert.equal(refusedRead.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(refusedRead.json.scope, 'files');
  const before = await db.driveEntry.count({ where: { ownerId } });
  const refusedWrite = await api('POST', '/drive/folders', without, { name: `never ${RUN}` });
  assert.equal(refusedWrite.status, 403);
  assert.equal(refusedWrite.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(await db.driveEntry.count({ where: { ownerId } }), before, 'a refused write wrote nothing');

  // (3)
  assert.equal((await api('GET', `/drive/entries/${folderId}`, others)).status, 404);
  assert.equal((await api('PATCH', `/drive/entries/${folderId}`, others, { name: 'taken' })).status, 404);
  assert.equal((await api('GET', `/drive/trash/groups/${groupId}`, others)).status, 404);

  // (4)
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'a runner', tokenHash: `drive-pat-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `orbit ${RUN}`, enabled: true } });
  const confined = await issue(ownerId, 'confined', ['files'], [workspaceId]);
  const refusedConfined = await api('GET', '/drive/entries', confined);
  assert.equal(refusedConfined.status, 403);
  assert.equal(refusedConfined.json.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE');
});
