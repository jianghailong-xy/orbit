/**
 * Session folders, and the folder half of `POST /sessions/:id/move` (migration 0348,
 * docs/session-folders-move-design.md §3.1, §3.2, §5.4), over real HTTP — the real
 * SessionFoldersController and SessionsController behind main.ts's pipe, interceptors and filters,
 * the JWT guard fed by a stubbed verifier — against a real, fully migrated PostgreSQL. Held to:
 *
 *   (1) folders are created, listed, renamed and deleted by their owner, and by nobody else;
 *   (2) one workspace never has two folders of one name (409), while two workspaces may;
 *   (3) deleting a folder deletes no session: the ones in it go back to the list (folder_id NULL);
 *   (4) a folder of another workspace, or of another owner, is refused with a 400 — by the move and
 *       by session create alike — and nothing is written;
 *   (5) the folder-only move files a session, moves it between folders and takes it out again, a
 *       running and a completed session included; Trash is refused (409), and so is another
 *       workspace for a session that has not ended (session-move-workspace.pg.spec has the rest);
 *   (6) a session created with a folderId is created in that folder, including when the folder
 *       disappears between the check and the INSERT (a 400, not a 500);
 *   (7) the session list (Open, Completed, Trash) and the session detail carry folderId, and a
 *       session restored from Trash is back in its folder;
 *   (8) a move that meets a folder delete in flight waits for it and answers 400 — the lock order
 *       (common/lock-order.ts, rank 25 before 30) leaves it nothing to deadlock on.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-folders/session-folders.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { BadRequestException, type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { SessionFoldersController } from './session-folders.controller';
import { SessionFoldersService } from './session-folders.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

// What main.ts installs before the app serves anything: the session detail carries BIGINT columns,
// and without this JSON.stringify refuses them and every read of a real session is a 500.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

type Json = Record<string, any>;
type Answer = { status: number; text: string; json: Json };

/** One request on a connection of its own (agent: false), so no answer rides a pooled socket. */
function send(
  base: string,
  method: string,
  path: string,
  options: { as?: 'owner' | 'other'; body?: unknown } = {},
): Promise<Answer> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.as) headers.authorization = `Bearer ${options.as}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Json = {};
        try { json = JSON.parse(text) as Json; } catch { /* an empty body */ }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('session folders: owned, unique per workspace, deleted without deleting a session; the folder-only move', {
  skip: !URL, concurrency: 1, timeout: 480_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const server: PrismaClient = prismaClientFor(url);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await server.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = server as unknown as PrismaService;
  const pub = uuidToBase62;

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const otherId = randomUUID();
  for (const [id, name] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
    await db.user.create({
      data: { id, email: `${name}-${RUN}-${id}@session-folders.invalid`, name, passwordHash: 'x' },
    });
  }
  const runnerId = randomUUID();
  const otherRunnerId = randomUUID();
  for (const [id, owner] of [[runnerId, ownerId], [otherRunnerId, otherId]] as const) {
    await db.runner.create({
      data: {
        id, ownerId: owner, name: `runner ${RUN}`, tokenHash: `session-folders-${id}`,
        status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [],
      },
    });
  }
  const alpha = randomUUID();
  const beta = randomUUID();
  const gone = randomUUID();
  const theirs = randomUUID();
  await db.workspace.create({ data: { id: alpha, ownerId, runnerId, name: `alpha ${RUN}`, enabled: true } });
  await db.workspace.create({ data: { id: beta, ownerId, runnerId, name: `beta ${RUN}`, enabled: true } });
  await db.workspace.create({
    data: { id: gone, ownerId, runnerId, name: `gone ${RUN}`, enabled: true, deletedAt: new Date() },
  });
  await db.workspace.create({
    data: { id: theirs, ownerId: otherId, runnerId: otherRunnerId, name: `theirs ${RUN}`, enabled: true },
  });

  /** A session written straight into the table, in whatever state the case needs. */
  async function conversation(
    title: string,
    extra: {
      workspaceId?: string;
      status?: RunStatus;
      folderId?: string;
      completedAt?: Date;
      deletedAt?: Date;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: extra.workspaceId ?? alpha, assignedRunnerId: runnerId,
        title, prompt: title, status: extra.status ?? RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        folderId: extra.folderId ?? null,
        ...(extra.completedAt ? { completedAt: extra.completedAt } : {}),
        ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
      },
    });
    return id;
  }
  /** A folder written straight into the table — for the cases that are not about creating one. */
  async function folder(workspaceId: string, name: string, owner = ownerId): Promise<string> {
    const id = randomUUID();
    await db.sessionFolder.create({ data: { id, ownerId: owner, workspaceId, name } });
    return id;
  }
  const folderOf = async (sessionId: string): Promise<string | null | undefined> =>
    (await sql.query('SELECT folder_id FROM session WHERE id = $1::uuid', [sessionId])).rows[0]?.folder_id;
  const folderRow = async (id: string): Promise<Json | undefined> =>
    (await sql.query('SELECT * FROM session_folder WHERE id = $1::uuid', [id])).rows[0];
  const folderCount = async (): Promise<number> =>
    Number((await sql.query(
      'SELECT count(*)::int AS n FROM session_folder WHERE owner_id IN ($1::uuid, $2::uuid)',
      [ownerId, otherId],
    )).rows[0].n);

  /** What the services announced, oldest first. The hub itself is stream-for-user.spec's subject. */
  const published: string[] = [];
  const announced = (): string[] => published.splice(0);
  const realtime = {
    publishForUser: (owner: string, type: string, id: string) => { published.push(`${type} ${owner} ${id}`); },
    publishSessionUpdated: (id: string) => { published.push(`session_updated ${id}`); },
    publishSessionCreated: (id: string) => { published.push(`session_created ${id}`); },
    publishWorkspaceChanged: () => undefined,
  } as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined };

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  const sessions = new SessionsService(prisma, queue as never, realtime);
  const folders = new SessionFoldersService(prisma, realtime);
  @Module({
    controllers: [SessionFoldersController, SessionsController],
    providers: [
      { provide: SessionFoldersService, useValue: folders },
      { provide: SessionsService, useValue: sessions },
      // SessionsController's other dependencies: the routes used here touch none of them.
      { provide: PrismaService, useValue: {} },
      { provide: RealtimeService, useValue: {} },
      { provide: SessionTagsService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: AutoRetryService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      // `Bearer other` is the second account; any other bearer is the owner.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token === 'other' ? otherId : ownerId }) } },
    ],
  })
  class SessionFoldersHarness {}

  // Errors only: a 500 here should arrive with its stack, and nothing else is worth printing.
  app = await NestFactory.create(SessionFoldersHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const other = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'other', body });
  const move = (sessionId: string, body: unknown, as = owner) => as('POST', `/sessions/${pub(sessionId)}/move`, body);

  await t.test('(1) folders are created, listed, renamed and deleted by their owner, and by nobody else', async () => {
    const made = await owner('POST', '/session-folders', { workspaceId: pub(alpha), name: '  Inbox  ' });
    assert.equal(made.status, 201, made.text);
    const inbox = toUuid(made.json.id);
    const row = await folderRow(inbox);
    assert.ok(row, 'no session_folder row behind the answer');
    assert.equal(row.owner_id, ownerId);
    assert.equal(row.workspace_id, alpha);
    assert.equal(row.name, 'Inbox', 'the name is stored without its surrounding whitespace');
    assert.equal(row.id[14], '7', 'the id is a uuid7');
    assert.deepEqual(
      { id: made.json.id, workspaceId: made.json.workspaceId, name: made.json.name },
      { id: pub(inbox), workspaceId: pub(alpha), name: 'Inbox' },
      'ids are answered in their public spelling',
    );
    assert.equal('ownerId' in made.json || 'createdAt' in made.json, false, 'the answer leaks the row');
    assert.deepEqual(announced(), [`folder_changed ${ownerId} ${inbox}`]);

    // A raw UUID is as good as the public spelling, and 60 characters is 60 as a person counts them.
    const archive = toUuid((await owner('POST', '/session-folders', { workspaceId: alpha, name: 'Archive' })).json.id);
    const backlog = toUuid((await owner('POST', '/session-folders', { workspaceId: pub(beta), name: 'Backlog' })).json.id);
    const wide = await owner('POST', '/session-folders', { workspaceId: pub(beta), name: '📁'.repeat(60) });
    assert.equal(wide.status, 201, wide.text);
    // Out of the way of the ordering below, which is about names whose order no collation disputes.
    await sql.query('DELETE FROM session_folder WHERE id = $1::uuid', [toUuid(wide.json.id)]);
    const elsewhere = toUuid((await other('POST', '/session-folders', { workspaceId: pub(theirs), name: 'Elsewhere' })).json.id);
    announced();

    // Every workspace's folders, by name, and only the caller's.
    const mine = await owner('GET', '/session-folders');
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(
      (mine.json as unknown as Json[]).map((f) => [f.name, toUuid(f.workspaceId), toUuid(f.id)]),
      [['Archive', alpha, archive], ['Backlog', beta, backlog], ['Inbox', alpha, inbox]],
    );
    const theirList = await other('GET', '/session-folders');
    assert.deepEqual((theirList.json as unknown as Json[]).map((f) => toUuid(f.id)), [elsewhere]);

    // Rename: trimmed like a new name, announced like one.
    const renamed = await owner('PATCH', `/session-folders/${pub(archive)}`, { name: ' Later ' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json.name, 'Later');
    assert.equal((await folderRow(archive))?.name, 'Later');
    assert.deepEqual(announced(), [`folder_changed ${ownerId} ${archive}`]);

    // Refused — and each refusal writes nothing and announces nothing.
    const before = await folderCount();
    const refusals: Array<[string, Promise<Answer>, number]> = [
      ['a name of spaces alone', owner('POST', '/session-folders', { workspaceId: pub(alpha), name: '   ' }), 400],
      ['61 characters', owner('POST', '/session-folders', { workspaceId: pub(alpha), name: 'x'.repeat(61) }), 400],
      ['no name', owner('POST', '/session-folders', { workspaceId: pub(alpha) }), 400],
      ['a workspace id that is not one', owner('POST', '/session-folders', { workspaceId: 'not a uuid', name: 'A' }), 400],
      ['a deleted workspace', owner('POST', '/session-folders', { workspaceId: pub(gone), name: 'A' }), 403],
      ['another owner\'s workspace', owner('POST', '/session-folders', { workspaceId: pub(theirs), name: 'A' }), 403],
      ['renaming another owner\'s folder', other('PATCH', `/session-folders/${pub(inbox)}`, { name: 'Mine now' }), 404],
      ['deleting another owner\'s folder', other('DELETE', `/session-folders/${pub(inbox)}`), 404],
      ['renaming to an empty name', owner('PATCH', `/session-folders/${pub(inbox)}`, { name: ' ' }), 400],
      ['renaming a folder that does not exist', owner('PATCH', `/session-folders/${pub(randomUUID())}`, { name: 'B' }), 404],
    ];
    for (const [what, answer, status] of refusals) {
      const got = await answer;
      assert.equal(got.status, status, `${what}: ${got.text}`);
    }
    assert.equal(await folderCount(), before);
    assert.equal((await folderRow(inbox))?.name, 'Inbox');
    assert.deepEqual(announced(), []);

    // Delete: the row goes, the owner's other clients are told, and a second delete has nothing left.
    const deleted = await owner('DELETE', `/session-folders/${pub(archive)}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.deepEqual(deleted.json, { ok: true });
    assert.equal(await folderRow(archive), undefined);
    assert.deepEqual(announced(), [`folder_changed ${ownerId} ${archive}`]);
    assert.equal((await owner('DELETE', `/session-folders/${pub(archive)}`)).status, 404);
    assert.deepEqual(announced(), []);
  });

  await t.test('(2) one workspace never has two folders of one name: 409; two workspaces may', async () => {
    const taken = await folder(alpha, 'Taken');
    const spare = await folder(alpha, 'Spare');
    const before = await folderCount();

    for (const name of ['Taken', '  Taken ']) {
      const clash = await owner('POST', '/session-folders', { workspaceId: pub(alpha), name });
      assert.equal(clash.status, 409, `${JSON.stringify(name)}: ${clash.text}`);
      assert.match(clash.json.message, /already exists/);
    }
    const renameClash = await owner('PATCH', `/session-folders/${pub(spare)}`, { name: 'Taken' });
    assert.equal(renameClash.status, 409, renameClash.text);
    assert.equal((await folderRow(spare))?.name, 'Spare', 'the clashing rename changed the folder');
    assert.equal(await folderCount(), before);
    assert.deepEqual(announced(), []);

    // The same name in another workspace is another folder; a folder keeping its own name is no clash.
    const twin = await owner('POST', '/session-folders', { workspaceId: pub(beta), name: 'Taken' });
    assert.equal(twin.status, 201, twin.text);
    const same = await owner('PATCH', `/session-folders/${pub(taken)}`, { name: 'Taken' });
    assert.equal(same.status, 200, same.text);
    announced();
  });

  await t.test('(3) deleting a folder deletes no session: the ones in it go back to the list', async () => {
    const doomed = await folder(alpha, 'Doomed');
    const kept = await folder(alpha, 'Kept');
    const idle = await conversation('Idle, in the doomed folder', { folderId: doomed });
    const running = await conversation('Running, in the doomed folder', { folderId: doomed, status: RunStatus.RUNNING });
    const trashed = await conversation('Trashed, in the doomed folder', { folderId: doomed, deletedAt: new Date() });
    const neighbour = await conversation('In another folder', { folderId: kept });
    const sessionsBefore = Number((await sql.query(
      'SELECT count(*)::int AS n FROM session WHERE owner_id = $1::uuid', [ownerId],
    )).rows[0].n);

    const deleted = await owner('DELETE', `/session-folders/${pub(doomed)}`);
    assert.equal(deleted.status, 200, deleted.text);

    assert.equal(await folderRow(doomed), undefined);
    for (const sessionId of [idle, running, trashed]) {
      assert.equal(await folderOf(sessionId), null, `${sessionId} still names the deleted folder (or is gone)`);
    }
    assert.equal(await folderOf(neighbour), kept, 'a session in another folder was touched');
    assert.equal(
      Number((await sql.query('SELECT count(*)::int AS n FROM session WHERE owner_id = $1::uuid', [ownerId])).rows[0].n),
      sessionsBefore,
      'deleting a folder deleted a session',
    );
    assert.deepEqual(announced(), [`folder_changed ${ownerId} ${doomed}`]);
  });

  await t.test('(4) a folder of another workspace, or of another owner, is refused with a 400', async () => {
    const home = await folder(alpha, 'Home');
    const away = await folder(beta, 'Away');
    const foreign = await folder(theirs, 'Foreign', otherId);
    const filed = await conversation('Filed at home', { folderId: home });

    for (const [what, folderId] of [
      ['a folder of another workspace', away],
      ['a folder of another owner', foreign],
      ['a folder that does not exist', randomUUID()],
    ] as const) {
      const got = await move(filed, { folderId: pub(folderId) });
      assert.equal(got.status, 400, `${what}: ${got.text}`);
      assert.equal(await folderOf(filed), home, `${what}: the refused move changed the session`);
    }
    assert.equal((await move(filed, { folderId: 'not a uuid' })).status, 400);
    assert.deepEqual(announced(), []);

    // Session create holds a folder to the workspace the session is created in, the same way.
    const opened = (title: string, body: Json) =>
      owner('POST', '/sessions', { prompt: title, title, effort: '', ...body });
    for (const [what, body] of [
      ['a folder of another workspace', { workspaceId: pub(alpha), folderId: pub(away) }],
      ['a folder of another owner', { workspaceId: pub(alpha), folderId: pub(foreign) }],
      ['a folder that does not exist', { workspaceId: pub(alpha), folderId: pub(randomUUID()) }],
      ['a folder with no workspace to belong to', { assignedRunnerId: pub(runnerId), folderId: pub(home) }],
      ['a folder id that is not one', { workspaceId: pub(alpha), folderId: 'not a uuid' }],
      ['a folder id that is not a string', { workspaceId: pub(alpha), folderId: 42 }],
    ] as const) {
      const title = `refused: ${what} ${RUN}`;
      const got = await opened(title, body);
      assert.equal(got.status, 400, `${what}: ${got.text}`);
      assert.match(got.json.message, /folderId/);
      assert.equal(
        (await sql.query('SELECT count(*)::int AS n FROM session WHERE title = $1', [title])).rows[0].n,
        0,
        `${what}: a session was created anyway`,
      );
    }
    assert.deepEqual(announced(), []);
  });

  await t.test('(5) the folder-only move: in, across, out — running and completed too; Trash and another workspace refused', async () => {
    const first = await folder(alpha, 'First');
    const second = await folder(alpha, 'Second');
    const idle = await conversation('Idle');

    // In, by the public id; the answer says where the session now is.
    const filed = await move(idle, { folderId: pub(first) });
    assert.equal(filed.status, 201, filed.text);
    assert.deepEqual(
      { id: filed.json.id, workspaceId: filed.json.workspaceId, folderId: filed.json.folderId },
      { id: pub(idle), workspaceId: pub(alpha), folderId: pub(first) },
    );
    assert.equal(await folderOf(idle), first);
    assert.deepEqual(announced(), [`session_updated ${idle}`]);

    // Across, by the raw UUID and naming the session's own workspace — which is allowed.
    const across = await move(idle, { workspaceId: pub(alpha), folderId: second });
    assert.equal(across.status, 201, across.text);
    assert.equal(await folderOf(idle), second);
    assert.deepEqual(announced(), [`session_updated ${idle}`]);

    // Where it already is: answered, and nothing written or announced.
    const already = await move(idle, { folderId: pub(second) });
    assert.equal(already.status, 201, already.text);
    assert.equal(await folderOf(idle), second);
    assert.deepEqual(announced(), []);

    // Out: null, and a folderId left out altogether (a Swift encoder drops a nil optional).
    const out = await move(idle, { folderId: null });
    assert.equal(out.status, 201, out.text);
    assert.equal(out.json.folderId, null);
    assert.equal(await folderOf(idle), null);
    assert.deepEqual(announced(), [`session_updated ${idle}`]);
    await move(idle, { folderId: pub(first) });
    const omitted = await move(idle, {});
    assert.equal(omitted.status, 201, omitted.text);
    assert.equal(await folderOf(idle), null);
    announced();

    // A running session moves like any other: a folder is filing, and nothing running reads it.
    const running = await conversation('Running', { status: RunStatus.RUNNING });
    await sql.query(
      'UPDATE session SET engine_turn_active = true, engine_started_at = now() WHERE id = $1::uuid',
      [running],
    );
    const live = await move(running, { folderId: pub(first) });
    assert.equal(live.status, 201, live.text);
    assert.equal(await folderOf(running), first);
    const stillRunning = (await sql.query('SELECT status::text AS status FROM session WHERE id = $1::uuid', [running])).rows[0];
    assert.equal(stillRunning.status, 'RUNNING', 'moving a running session touched its run');
    const completed = await conversation('Completed', { status: RunStatus.CANCELLED, completedAt: new Date() });
    assert.equal((await move(completed, { folderId: pub(second) })).status, 201);
    assert.equal(await folderOf(completed), second);
    assert.deepEqual(announced(), [`session_updated ${running}`, `session_updated ${completed}`]);

    // Refused, unchanged, unannounced.
    const trashed = await conversation('Trashed', { folderId: first, deletedAt: new Date() });
    const inTrash = await move(trashed, { folderId: pub(second) });
    assert.equal(inTrash.status, 409, inTrash.text);
    assert.match(inTrash.json.message, /Trash/);
    assert.equal(await folderOf(trashed), first);
    // Another workspace takes only an ended session — sessions/session-move-workspace.pg.spec.
    const elsewhere = await move(idle, { workspaceId: pub(beta), folderId: null });
    assert.equal(elsewhere.status, 409, elsewhere.text);
    assert.equal(elsewhere.json.message, 'End the session first.');
    assert.equal((await move(idle, { folderId: pub(first) }, other)).status, 404, 'another owner moved my session');
    assert.equal((await move(randomUUID(), { folderId: null })).status, 404);
    assert.equal(await folderOf(idle), null);
    assert.deepEqual(announced(), []);
  });

  await t.test('(6) a session created with a folderId is created in that folder', async () => {
    const landing = await folder(alpha, 'Landing');
    const created = await owner('POST', '/sessions', {
      prompt: 'Opened from the folder page', title: `Folder page ${RUN}`, effort: '',
      workspaceId: pub(alpha), folderId: pub(landing),
    });
    assert.equal(created.status, 201, created.text);
    const id = toUuid(created.json.id);
    assert.equal(created.json.folderId, pub(landing));
    assert.equal(await folderOf(id), landing);
    const plain = await owner('POST', '/sessions', {
      prompt: 'Opened from the list', title: `List ${RUN}`, effort: '', workspaceId: pub(alpha),
    });
    assert.equal(plain.status, 201, plain.text);
    assert.equal(plain.json.folderId, null);
    assert.equal(await folderOf(toUuid(plain.json.id)), null);
    announced();

    // The folder is deleted between the check and the INSERT: its foreign key refuses the row, and
    // that is answered as the 400 a folder that was never there gets — not as a 500.
    const doomed = await folder(alpha, 'Gone mid-create');
    const racing = new Proxy(server, {
      get(target, prop) {
        if (prop === 'session') {
          return new Proxy(target.session, {
            get(delegate, method) {
              if (method !== 'create') return Reflect.get(delegate, method);
              return async (args: unknown) => {
                await sql.query('DELETE FROM session_folder WHERE id = $1::uuid', [doomed]);
                return (delegate.create as (a: unknown) => unknown)(args);
              };
            },
          });
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racer = new SessionsService(racing as unknown as PrismaService, queue as never, realtime);
    const title = `Raced ${RUN}`;
    await assert.rejects(
      () => racer.create(ownerId, { prompt: title, title, effort: '', workspaceId: alpha, folderId: doomed }),
      (e: unknown) => e instanceof BadRequestException && /folderId/.test(e.message),
    );
    assert.equal(await folderRow(doomed), undefined, 'the race was not run');
    assert.equal(
      (await sql.query('SELECT count(*)::int AS n FROM session WHERE title = $1', [title])).rows[0].n,
      0,
    );
    announced();
  });

  await t.test('(7) the session list and detail carry folderId; Trash keeps it and a restore brings it back', async () => {
    const shelf = await folder(beta, 'Shelf');
    const filed = await conversation('Filed', { workspaceId: beta, folderId: shelf });
    const loose = await conversation('Loose', { workspaceId: beta });
    const done = await conversation('Done', { workspaceId: beta, folderId: shelf, status: RunStatus.CANCELLED, completedAt: new Date() });
    const binned = await conversation('Binned', { workspaceId: beta, folderId: shelf, deletedAt: new Date() });

    const rows = async (view: string): Promise<Map<string, Json>> => {
      const got = await owner('GET', `/sessions?workspaceId=${pub(beta)}&view=${view}`);
      assert.equal(got.status, 200, got.text);
      return new Map((got.json as unknown as Json[]).map((row) => [toUuid(row.id), row]));
    };
    const open = await rows('open');
    assert.equal(open.get(filed)?.folderId, pub(shelf));
    assert.ok(open.has(loose));
    assert.equal(open.get(loose)?.folderId, null, 'an unfiled row says so with null');
    assert.equal((await rows('completed')).get(done)?.folderId, pub(shelf));
    assert.equal((await rows('trash')).get(binned)?.folderId, pub(shelf), 'Trash dropped the folder');

    const detail = await owner('GET', `/sessions/${pub(filed)}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.folderId, pub(shelf));
    const looseDetail = await owner('GET', `/sessions/${pub(loose)}`);
    assert.equal(looseDetail.status, 200, looseDetail.text);
    assert.equal(looseDetail.json.folderId, null);

    // Back out of Trash, back in the folder it was filed in.
    assert.equal((await owner('POST', `/sessions/${pub(binned)}/restore`)).status, 201);
    assert.equal((await rows('open')).get(binned)?.folderId, pub(shelf));
    announced();
  });

  await t.test('(8) a move that meets a folder delete in flight waits for it, then answers 400', async () => {
    const leaving = await folder(alpha, 'Leaving');
    const session = await conversation('Waiting to be filed');
    const deleter = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await deleter.connect();
    try {
      await verifyCoordinatorPgIdentity(deleter);
      await deleter.query('BEGIN');
      await deleter.query('DELETE FROM session_folder WHERE id = $1::uuid', [leaving]);

      const pending = move(session, { folderId: pub(leaving) });
      // The move's FOR KEY SHARE on the folder conflicts with the delete's row lock: wait until the
      // server's own backend is seen waiting on it, so the case below is the race and not a re-run.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { rows: waiting } = await sql.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%session_folder%FOR KEY SHARE%'`,
        );
        if (waiting[0].n > 0) break;
        assert.ok(Date.now() < deadline, 'the move never waited on the folder delete');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await deleter.query('COMMIT');

      const got = await pending;
      assert.equal(got.status, 400, got.text);
      assert.equal(await folderOf(session), null);
      assert.deepEqual(announced(), []);
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      await deleter.end().catch(() => undefined);
    }
  });
});
