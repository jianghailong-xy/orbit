/**
 * A personal access token and Documents (docs/personal-access-token-design.md §4; drive/drive.controller.ts), through
 * the production apiserver — `build/main.js`, the whole AppModule — against a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-pat.pg.spec.ts
 *
 *   (1) a token holding the `documents` scope lists and writes through /documents/*: it makes a folder, reads it back,
 *       lists, renames, moves to Trash and reads Trash;
 *   (2) a token without it is refused 403 PAT_SCOPE_MISSING on a read and on a write, and nothing is written;
 *   (3) another account's token holding `documents` is answered 404 for this account's entry and Trash group;
 *   (4) a token confined to workspaces is refused 403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE;
 *   (5) /drive/* is an alias of the same handlers: the same GETs and POSTs answer there as under /documents;
 *   (6) the old scope name `files`: a client asking for it is minted `documents`, a token row stored with `files` (before
 *       migration 1550, or written by an older apiserver) still opens /documents and /drive, and migration 1550 rewrites
 *       such a row to `documents`, which still opens them.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const MIGRATION_1550 = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/1550_pat_scope_documents/migration.sql'), 'utf8');
const RUN = randomUUID().slice(0, 8);

test('the documents scope opens /documents/* and its /drive/* alias to a token, and only that scope, and only for its own account', {
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
  const withFiles = await issue(ownerId, 'documents', ['documents']);
  const without = await issue(ownerId, 'everything but documents', PAT_SCOPES.filter((scope) => scope !== 'documents'));
  const others = await issue(otherId, 'other documents', ['documents']);

  server = await startApiserver(url, `drive-pat-${randomUUID()}`);
  const api = (method: string, path: string, bearer: string, body?: unknown) => call(server!, method, `/api${path}`, bearer, body);

  // (1)
  const made = await api('POST', '/documents/folders', withFiles, { name: `reports ${RUN}` });
  assert.equal(made.status, 201, made.text);
  const folderId: string = made.json.id;
  const listed = await api('GET', '/documents/entries', withFiles);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(JSON.stringify(listed.json).includes(folderId), 'the folder is listed');
  assert.equal((await api('GET', `/documents/entries/${folderId}`, withFiles)).status, 200);
  assert.equal((await api('PATCH', `/documents/entries/${folderId}`, withFiles, { name: `renamed ${RUN}` })).status, 200);
  const trashed = await api('DELETE', `/documents/entries/${folderId}`, withFiles);
  assert.equal(trashed.status, 200, trashed.text);
  assert.equal((await api('GET', '/documents/trash', withFiles)).status, 200);
  const groupId: string = trashed.json.id ?? trashed.json.groupId;

  // (2)
  const refusedRead = await api('GET', '/documents/entries', without);
  assert.equal(refusedRead.status, 403);
  assert.equal(refusedRead.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(refusedRead.json.scope, 'documents');
  const before = await db.documentEntry.count({ where: { ownerId } });
  const refusedWrite = await api('POST', '/documents/folders', without, { name: `never ${RUN}` });
  assert.equal(refusedWrite.status, 403);
  assert.equal(refusedWrite.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(await db.documentEntry.count({ where: { ownerId } }), before, 'a refused write wrote nothing');

  // (3)
  assert.equal((await api('GET', `/documents/entries/${folderId}`, others)).status, 404);
  assert.equal((await api('PATCH', `/documents/entries/${folderId}`, others, { name: 'taken' })).status, 404);
  assert.equal((await api('GET', `/documents/trash/groups/${groupId}`, others)).status, 404);

  // (4)
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'a runner', tokenHash: `drive-pat-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `orbit ${RUN}`, enabled: true } });
  const confined = await issue(ownerId, 'confined', ['documents'], [workspaceId]);
  const refusedConfined = await api('GET', '/documents/entries', confined);
  assert.equal(refusedConfined.status, 403);
  assert.equal(refusedConfined.json.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE');

  // (5) The same handlers under /drive: a read and a write with the same token, and each sees what the other wrote.
  const viaDrive = await api('POST', '/drive/folders', withFiles, { name: `via drive ${RUN}` });
  assert.equal(viaDrive.status, 201, viaDrive.text);
  const viaDocuments = await api('POST', '/documents/folders', withFiles, { name: `via documents ${RUN}` });
  assert.equal(viaDocuments.status, 201, viaDocuments.text);
  for (const prefix of ['/documents', '/drive']) {
    const page = await api('GET', `${prefix}/entries`, withFiles);
    assert.equal(page.status, 200, `${prefix}: ${page.text}`);
    for (const id of [viaDrive.json.id, viaDocuments.json.id]) {
      assert.ok(JSON.stringify(page.json).includes(id), `${prefix}/entries lists ${id}`);
    }
    assert.equal((await api('GET', `${prefix}/entries/${viaDrive.json.id}`, withFiles)).json.id, viaDrive.json.id);
    const refused = await api('GET', `${prefix}/entries`, without);
    assert.equal(refused.status, 403, `${prefix} refuses a token without the scope`);
    assert.equal(refused.json.scope, 'documents');
  }

  // (6) A client built before the rename asks for `files`, and is minted `documents`.
  const askedOldName = await pats.issue(ownerId, {
    name: 'asked for files', scopes: ['files'], expiresInDays: 90, createdVia: 'CLI_DEVICE', workspaceIds: [],
  });
  assert.deepEqual(askedOldName.scopes, ['documents']);
  assert.deepEqual((await db.personalAccessToken.findUniqueOrThrow({ where: { id: askedOldName.id } })).scopes, ['documents']);
  assert.deepEqual(
    (await pats.issue(ownerId, { name: 'both names', scopes: ['files', 'documents', 'notify'], expiresInDays: 90, createdVia: 'WEB' })).scopes,
    ['documents', 'notify'], 'both names are one scope');
  // A row stored with `files`, the way every token holding it was stored before migration 1550.
  const storedOld = `orbit_pat_stored-files-${randomUUID()}`;
  const storedOldId = randomUUID();
  await sql.query(
    `INSERT INTO "personal_access_token" ("id", "owner_id", "name", "token_hash", "token_hint", "scopes", "created_via")
     VALUES ($1, $2, $3, $4, 'iles', ARRAY['tasks:read', 'files']::text[], 'WEB')`,
    [storedOldId, ownerId, `stored files ${RUN}`, createHash('sha256').update(storedOld).digest('hex')],
  );
  const opens = async (label: string) => {
    for (const prefix of ['/documents', '/drive']) {
      const read = await api('GET', `${prefix}/entries`, storedOld);
      assert.equal(read.status, 200, `${label}: GET ${prefix}/entries ${read.text}`);
      const write = await api('POST', `${prefix}/folders`, storedOld, { name: `${label} ${prefix.slice(1)} ${RUN}` });
      assert.equal(write.status, 201, `${label}: POST ${prefix}/folders ${write.text}`);
    }
  };
  await opens('stored as files');
  // Migration 1550 itself, run against that row and a pending device login: `files` becomes `documents` in place.
  const deviceLoginId = randomUUID();
  await sql.query(
    `INSERT INTO "pat_device_login" ("id", "device_code_hash", "user_code", "name", "scopes", "expires_at")
     VALUES ($1, $2, $3, 'cli', ARRAY['files', 'documents', 'wiki:read']::text[], now() + interval '10 minutes')`,
    [deviceLoginId, `device-${deviceLoginId}`, `U${RUN}`],
  );
  await sql.query(MIGRATION_1550);
  await sql.query(MIGRATION_1550);
  assert.deepEqual((await db.personalAccessToken.findUniqueOrThrow({ where: { id: storedOldId } })).scopes, ['tasks:read', 'documents']);
  assert.deepEqual((await db.patDeviceLogin.findUniqueOrThrow({ where: { id: deviceLoginId } })).scopes, ['documents', 'wiki:read']);
  const untouched = await db.personalAccessToken.findUniqueOrThrow({ where: { id: askedOldName.id } });
  assert.deepEqual(untouched.scopes, ['documents'], 'a row without `files` is left as it was');
  await opens('migrated');
});
