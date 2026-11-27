/**
 * A personal access token and Drive (docs/personal-access-token-design.md §4; drive/drive.controller.ts), through
 * the production apiserver — `build/main.js`, the whole AppModule — against a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-pat.pg.spec.ts
 *
 *   (1) a token holding the `drive` scope lists and writes through /drive/*: it makes a folder, reads it back,
 *       lists, renames, moves to Trash and reads Trash;
 *   (2) a token without it is refused 403 PAT_SCOPE_MISSING on a read and on a write, and nothing is written;
 *   (3) another account's token holding `drive` is answered 404 for this account's entry and Trash group;
 *   (4) a token confined to workspaces is refused 403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE;
 *   (5) /documents/* is an alias of the same handlers: the same GETs and POSTs answer there as under /drive;
 *   (6) the old scope names `documents` and `files`: a client asking for either is minted `drive`; token rows stored
 *       with `files` (before migration 1550), with `documents` (1550 to 1590, or written by an older apiserver) and with
 *       both still open /drive and /documents; migrations 1550 and 1590 rewrite those rows and pending device logins to
 *       `drive`, which still opens them.
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
const migration = (name: string) => readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
const MIGRATION_1550 = migration('1550_pat_scope_documents');
const MIGRATION_1590 = migration('1590_pat_scope_drive');
const RUN = randomUUID().slice(0, 8);

test('the drive scope opens /drive/* and its /documents/* alias to a token, and only that scope, and only for its own account', {
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
  const withDrive = await issue(ownerId, 'drive', ['drive']);
  const without = await issue(ownerId, 'everything but drive', PAT_SCOPES.filter((scope) => scope !== 'drive'));
  const others = await issue(otherId, 'other drive', ['drive']);

  server = await startApiserver(url, `drive-pat-${randomUUID()}`);
  const api = (method: string, path: string, bearer: string, body?: unknown) => call(server!, method, `/api${path}`, bearer, body);

  // (1)
  const made = await api('POST', '/drive/folders', withDrive, { name: `reports ${RUN}` });
  assert.equal(made.status, 201, made.text);
  const folderId: string = made.json.id;
  const listed = await api('GET', '/drive/entries', withDrive);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(JSON.stringify(listed.json).includes(folderId), 'the folder is listed');
  assert.equal((await api('GET', `/drive/entries/${folderId}`, withDrive)).status, 200);
  assert.equal((await api('PATCH', `/drive/entries/${folderId}`, withDrive, { name: `renamed ${RUN}` })).status, 200);
  const trashed = await api('DELETE', `/drive/entries/${folderId}`, withDrive);
  assert.equal(trashed.status, 200, trashed.text);
  assert.equal((await api('GET', '/drive/trash', withDrive)).status, 200);
  const groupId: string = trashed.json.id ?? trashed.json.groupId;

  // (2)
  const refusedRead = await api('GET', '/drive/entries', without);
  assert.equal(refusedRead.status, 403);
  assert.equal(refusedRead.json.code, 'PAT_SCOPE_MISSING');
  assert.equal(refusedRead.json.scope, 'drive');
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
  const confined = await issue(ownerId, 'confined', ['drive'], [workspaceId]);
  const refusedConfined = await api('GET', '/drive/entries', confined);
  assert.equal(refusedConfined.status, 403);
  assert.equal(refusedConfined.json.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE');

  // (5) The same handlers under /documents: a read and a write with the same token, and each sees what the other wrote.
  const viaDrive = await api('POST', '/drive/folders', withDrive, { name: `via drive ${RUN}` });
  assert.equal(viaDrive.status, 201, viaDrive.text);
  const viaDocuments = await api('POST', '/documents/folders', withDrive, { name: `via documents ${RUN}` });
  assert.equal(viaDocuments.status, 201, viaDocuments.text);
  for (const prefix of ['/drive', '/documents']) {
    const page = await api('GET', `${prefix}/entries`, withDrive);
    assert.equal(page.status, 200, `${prefix}: ${page.text}`);
    for (const id of [viaDrive.json.id, viaDocuments.json.id]) {
      assert.ok(JSON.stringify(page.json).includes(id), `${prefix}/entries lists ${id}`);
    }
    assert.equal((await api('GET', `${prefix}/entries/${viaDrive.json.id}`, withDrive)).json.id, viaDrive.json.id);
    const refused = await api('GET', `${prefix}/entries`, without);
    assert.equal(refused.status, 403, `${prefix} refuses a token without the scope`);
    assert.equal(refused.json.scope, 'drive');
  }

  // (6) Clients built before the rename ask for `files` or `documents`, and are minted `drive`.
  for (const old of ['files', 'documents']) {
    const asked = await pats.issue(ownerId, {
      name: `asked for ${old}`, scopes: [old], expiresInDays: 90, createdVia: 'CLI_DEVICE', workspaceIds: [],
    });
    assert.deepEqual(asked.scopes, ['drive'], `asked for ${old}`);
    assert.deepEqual((await db.personalAccessToken.findUniqueOrThrow({ where: { id: asked.id } })).scopes, ['drive']);
  }
  assert.deepEqual(
    (await pats.issue(ownerId, { name: 'every name', scopes: ['files', 'documents', 'drive', 'notify'], expiresInDays: 90, createdVia: 'WEB' })).scopes,
    ['drive', 'notify'], 'all three names are one scope');
  // Rows stored the way tokens were stored before migration 1550 (`files`), between 1550 and 1590 (`documents`), by an
  // older apiserver during a rolling deploy (both), and one that already holds `drive` beside an old name.
  const stored = async (label: string, scopes: string[]) => {
    const token = `orbit_pat_stored-${label}-${randomUUID()}`;
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "personal_access_token" ("id", "owner_id", "name", "token_hash", "token_hint", "scopes", "created_via")
       VALUES ($1, $2, $3, $4, 'ored', $5::text[], 'WEB')`,
      [id, ownerId, `stored ${label} ${RUN}`, createHash('sha256').update(token).digest('hex'), scopes],
    );
    return { label, token, id };
  };
  const rows = [
    await stored('files', ['tasks:read', 'files']),
    await stored('documents', ['tasks:read', 'documents']),
    await stored('both', ['documents', 'wiki:read', 'files']),
    await stored('drive-and-files', ['files', 'drive']),
  ];
  const opens = async (when: string) => {
    for (const row of rows) {
      for (const prefix of ['/drive', '/documents']) {
        const label = `${row.label} ${when}`;
        const read = await api('GET', `${prefix}/entries`, row.token);
        assert.equal(read.status, 200, `${label}: GET ${prefix}/entries ${read.text}`);
        const write = await api('POST', `${prefix}/folders`, row.token, { name: `${row.label} ${when} ${prefix.slice(1)} ${RUN}` });
        assert.equal(write.status, 201, `${label}: POST ${prefix}/folders ${write.text}`);
      }
    }
  };
  await opens('as stored');
  // A pending device login asked for under each name.
  const deviceLogin = async (scopes: string[]) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "pat_device_login" ("id", "device_code_hash", "user_code", "name", "scopes", "expires_at")
       VALUES ($1, $2, $3, 'cli', $4::text[], now() + interval '10 minutes')`,
      [id, `device-${id}`, `U${id.slice(0, 8)}`, scopes],
    );
    return id;
  };
  const loginFiles = await deviceLogin(['files', 'wiki:read']);
  const loginBoth = await deviceLogin(['files', 'documents', 'wiki:read']);
  const loginDocuments = await deviceLogin(['wiki:read', 'documents']);
  // The migrations themselves, in order and each twice: 1550 (`files` → `documents`), then 1590 (both → `drive`).
  await sql.query(MIGRATION_1550);
  await sql.query(MIGRATION_1550);
  await sql.query(MIGRATION_1590);
  await sql.query(MIGRATION_1590);
  const scopesOf = async (id: string) => (await db.personalAccessToken.findUniqueOrThrow({ where: { id } })).scopes;
  assert.deepEqual(await scopesOf(rows[0].id), ['tasks:read', 'drive']);
  assert.deepEqual(await scopesOf(rows[1].id), ['tasks:read', 'drive']);
  assert.deepEqual(await scopesOf(rows[2].id), ['drive', 'wiki:read']);
  assert.deepEqual(await scopesOf(rows[3].id), ['drive']);
  const loginScopesOf = async (id: string) => (await db.patDeviceLogin.findUniqueOrThrow({ where: { id } })).scopes;
  assert.deepEqual(await loginScopesOf(loginFiles), ['drive', 'wiki:read']);
  assert.deepEqual(await loginScopesOf(loginBoth), ['drive', 'wiki:read']);
  assert.deepEqual(await loginScopesOf(loginDocuments), ['wiki:read', 'drive']);
  const plain = await db.personalAccessToken.findFirstOrThrow({ where: { ownerId, name: 'drive' } });
  assert.deepEqual(plain.scopes, ['drive'], 'a row holding only `drive` is left as it was');
  await opens('migrated');
  // 1590 run alone on a row 1550 never saw (an older apiserver wrote `files` after 1550 ran): `drive` all the same.
  const late = await stored('files-after-1550', ['files']);
  await sql.query(MIGRATION_1590);
  assert.deepEqual(await scopesOf(late.id), ['drive']);
});
