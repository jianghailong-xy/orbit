/**
 * The owner's drive work grouped by session and day (`GET /drive/activity`, drive/drive-activity.ts; migrations 1780,
 * 1781), held against the production apiserver over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-activity.pg.spec.ts
 *
 *   (1) grouping: an ordinary session's writes (each file once, however often written), its move and its burst of
 *       deletes; a Drive chat's renames; a sync's files (and not its writes again); and the owner's own rename and delete
 *       are four groups, each naming its session, with the right ops, counts, folder paths and bytes. Writes of no
 *       session are nobody's. A chat's change group is answered as its Undo, which the chat's undo route accepts; a
 *       deletion as its Trash group, which POST /drive/trash/groups/:id/restore accepts;
 *   (2) owner isolation: another account's session work is never in the owner's answer, and the owner's never in theirs;
 *       the other account cannot restore the owner's group;
 *   (3) paging: whole days a page, newest first, until a page holds 20 groups; `before=<nextBefore>` answers the days
 *       before, and the last page's nextBefore is null; a bad `before` or `tz` is refused 400.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { toUuid, uuidToBase62, type DriveActivityGroup, type DriveActivityPage } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pub = (id: string) => uuidToBase62(id);
const q = encodeURIComponent;
const uuidOf = (id: string | null) => (id === null ? null : toUuid(id));

const ok = (reply: Reply, what: string): Reply => {
  assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
  return reply;
};

test('Drive activity: the owner\'s drive work grouped by session and day', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const filesDir = mkdtempSync(path.join(tmpdir(), 'drive-activity-'));
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(filesDir, { recursive: true, force: true });
  });

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@drive-activity.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    const runnerToken = `drive-activity-${randomUUID()}`;
    const runnerId = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: id, name: `${name}-laptop-${RUN}`, tokenHash: sha256(Buffer.from(runnerToken)) } });
    return { id, email, password, runnerToken, runnerId };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  const pager = await account('pager');

  server = await startApiserver(url, `drive-activity-${RUN}`, { ORBIT_DRIVE_DIR: filesDir, DEEPSEEK_API_KEY: '' });
  const api = (method: string, route: string, bearer?: string, body?: unknown) => call(server!, method, route, bearer, body);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);
  const pagerToken = await signIn(pager);

  let turnSeq = 0;
  /** A session of `who`'s on their runner, opened by `openedBy`, working on a turn. */
  const session = async (who: { id: string; runnerId: string }, openedBy: string, title: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session"(id, title, prompt, owner_id, creator_id, assigned_runner_id, opened_by, turn_state, num_turns, updated_at)
       VALUES ($1, $2, 'p', $3, $3, $4, $5, 'IN_FLIGHT', 0, clock_timestamp())`,
      [id, title, who.id, who.runnerId, openedBy],
    );
    turnSeq += 1;
    await sql.query(
      `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
       VALUES ($1, $2, $3, $4, 'message', 'work on my files', 'IN_FLIGHT')`,
      [randomUUID(), id, turnSeq, randomUUID()],
    );
    return id;
  };

  // ── the runner door, as the drive tools call it ────────────────────────────────────────────
  type Writer = { sessionId: string; burstKey?: string };
  const doorOf = (who: { runnerToken: string }) => {
    const door = (method: string, route: string, body?: unknown) => api(method, `/api/runner/drive${route}`, who.runnerToken, body);
    const raw = (route: string, bytes: Buffer): Promise<number> => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server!.port, method: 'PUT', path: route,
        headers: {
          authorization: `Bearer ${who.runnerToken}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
          'x-orbit-chunk-sha256': sha256(bytes),
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(bytes);
    });
    /** What `drive_put` does: mkdir -p of the folder, create or overwrite, a staging, its chunk, one commit. */
    const put = async (drivePath: string, text: string, writer?: Writer) => {
      const bytes = Buffer.from(text);
      const folder = drivePath.slice(0, drivePath.lastIndexOf('/')) || '/';
      if (folder !== '/') ok(await door('POST', '/mkdir', { path: folder, parents: true, writer }), `mkdir ${folder}`);
      const seen = await door('GET', `/stat?path=${q(drivePath)}`);
      const handleId = randomUUID();
      let entry;
      let mode: 'CONTINUE' | 'OVERWRITE';
      if (seen.status === 404) {
        entry = ok(await door('POST', '/create', { path: drivePath, handleId, writer }), `create ${drivePath}`).json;
        mode = 'CONTINUE';
      } else {
        entry = ok(seen, `stat ${drivePath}`).json;
        mode = 'OVERWRITE';
      }
      const staging = ok(await door('POST', '/stagings', { entryId: entry.id }), 'a staging').json;
      assert.equal(await raw(`/api/runner/drive/stagings/${staging.id}/chunks/0`, bytes), 200, 'the chunk');
      return ok(await door('POST', '/commit', {
        commitId: randomUUID(), entryId: entry.id, handleId, mode, baseVersionId: entry.currentVersionId, stagingId: staging.id,
        chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }], writer,
      }), `commit ${drivePath}`);
    };
    const move = async (from: string, to: string, writer?: Writer) => ok(await door('POST', '/rename', { from, to, writer }), `move ${from}`);
    const remove = async (drivePath: string, writer?: Writer) => ok(await door('POST', '/delete', { path: drivePath, writer }), `delete ${drivePath}`);
    const stat = async (drivePath: string) => ok(await door('GET', `/stat?path=${q(drivePath)}`), `stat ${drivePath}`).json;
    return { put, move, remove, stat, door };
  };
  const activity = async (token: string, query = ''): Promise<DriveActivityPage> =>
    ok(await api('GET', `/api/drive/activity${query}`, token), `activity${query}`).json;
  const groupOf = (page: DriveActivityPage, sessionId: string | null) => {
    const found = page.groups.filter((g) => uuidOf(g.sessionId) === sessionId);
    assert.equal(found.length, 1, `one group for ${sessionId}: ${JSON.stringify(page.groups)}`);
    return found[0];
  };
  /** A group's lines as `OP count folder [bytes] [undo kind]`, newest first. */
  const linesOf = (group: DriveActivityGroup) =>
    group.lines.map((l) => [l.op, l.count, l.folderPath, l.bytes ?? '-', l.undo?.kind ?? '-'].join(' '));

  // ── (1) grouping ───────────────────────────────────────────────────────────────────────────
  const drive = doorOf(owner);
  // A drive written by no session: nobody's work.
  for (const [p, text] of [
    ['/Books/a.jpg', 'cover a'], ['/Books/b.jpg', 'cover b'], ['/Books/c.jpg', 'cover c'], ['/Reports/old.txt', 'last year'],
    ['/scratch/x.tmp', 'x'], ['/scratch/y.tmp', 'yy'], ['/Home/notes.txt', 'notes'], ['/Home/draft.txt', 'draft'],
  ] as const) {
    await drive.put(p, text);
  }
  ok(await api('POST', '/api/drive/folders', ownerToken, { name: 'Archive' }), 'the Archive folder');
  assert.deepEqual((await activity(ownerToken)).groups, [], 'writes of no session are nobody\'s');

  const plain = await session(owner, 'PERSON', 'Write the quarterly report');
  const chat = await session(owner, 'DRIVE_CHAT', 'Tidy up Books');
  const syncer = await session(owner, 'PERSON', 'Sync the covers');
  const asPlain = { sessionId: pub(plain) };
  const asChat = { sessionId: pub(chat) };
  const asSyncer = { sessionId: pub(syncer) };

  // The ordinary session: three files written (one of them twice), one moved, two deleted in one burst.
  await drive.put('/Reports/q1.md', 'quarter one', asPlain);
  await drive.put('/Reports/q2.md', 'quarter two', asPlain);
  await drive.put('/Reports/q3.md', 'quarter three, first', asPlain);
  await drive.put('/Reports/q3.md', 'quarter three, final', asPlain);
  await drive.move('/Reports/old.txt', '/Archive/old.txt', asPlain);
  await drive.remove('/scratch/x.tmp', { ...asPlain, burstKey: `tidy-${RUN}` });
  await drive.remove('/scratch/y.tmp', { ...asPlain, burstKey: `tidy-${RUN}` });
  const wroteBytes = ['quarter one', 'quarter two', 'quarter three, final'].reduce((n, s) => n + Buffer.byteLength(s), 0);

  // The Drive chat: three renames in Books, one change group.
  for (const name of ['a', 'b', 'c']) await drive.move(`/Books/${name}.jpg`, `/Books/0412-${name}.jpg`, asChat);
  const chatGroups = ok(await api('GET', `/api/drive/chats/${pub(chat)}/groups`, ownerToken), 'the chat\'s groups').json.groups;
  assert.equal(chatGroups.length, 1, 'the chat made one change group');

  // A sync: the files it sends are its line, not WROTE lines as well.
  const sync = await db.driveSync.create({
    data: { ownerId: owner.id, runnerId: owner.runnerId, sessionId: syncer, sourceName: 'covers', destPath: '/Books', status: 'UPLOADING' },
  });
  await drive.put('/Books/d.jpg', 'cover d from the laptop', asSyncer);
  await drive.put('/Books/e.jpg', 'cover e from the laptop', asSyncer);
  await db.driveSync.update({ where: { id: sync.id }, data: { status: 'DONE', filesDone: 2, bytesSent: 46n, endedAt: new Date() } });

  // The owner: one rename and one delete.
  const notes = await drive.stat('/Home/notes.txt');
  ok(await api('PATCH', `/api/drive/entries/${notes.id}`, ownerToken, { name: 'notes-2026.txt' }), 'the owner\'s rename');
  const draft = await drive.stat('/Home/draft.txt');
  ok(await api('DELETE', `/api/drive/entries/${draft.id}`, ownerToken), 'the owner\'s delete');

  // Another account's session work, in a folder of the same name.
  const theirs = await session(stranger, 'PERSON', 'Stranger private work');
  const strangerDrive = doorOf(stranger);
  await strangerDrive.put('/Reports/secret.md', 'theirs', { sessionId: pub(theirs) });
  await strangerDrive.move('/Reports/secret.md', '/Reports/secret-2.md', { sessionId: pub(theirs) });

  const page = await activity(ownerToken);
  assert.equal(page.nextBefore, null, 'all of it is one day');
  assert.deepEqual(page.groups.map((g) => uuidOf(g.sessionId)).sort(), [plain, chat, syncer, null].sort(),
    `four groups, each naming its session: ${JSON.stringify(page.groups)}`);
  const ats = page.groups.map((g) => g.at);
  assert.deepEqual(ats, [...ats].sort().reverse(), 'newest first');

  const plainGroup = groupOf(page, plain);
  assert.equal(plainGroup.sessionTitle, 'Write the quarterly report');
  assert.equal(plainGroup.isDriveChat, false);
  assert.deepEqual(linesOf(plainGroup).sort(), [
    `WROTE 3 /Reports ${wroteBytes} -`, 'MOVED 1 /Archive - -', 'DELETED 2 /scratch 3 TRASH_GROUP',
  ].sort(), 'the ordinary session: each file written once, its move, its burst of deletes');
  assert.deepEqual(plainGroup.lines.map((l) => l.at), plainGroup.lines.map((l) => l.at).sort().reverse(), 'its lines newest first');

  const chatGroup = groupOf(page, chat);
  assert.equal(chatGroup.sessionTitle, 'Tidy up Books');
  assert.equal(chatGroup.isDriveChat, true);
  assert.deepEqual(linesOf(chatGroup), ['RENAMED 3 /Books - CHANGE_GROUP'], 'the chat\'s renames, once, as its change group');
  assert.equal(toUuid(chatGroup.lines[0].undo!.id), toUuid(chatGroups[0].id), 'the undo names the chat\'s change group');

  const syncGroup = groupOf(page, syncer);
  assert.equal(syncGroup.sessionTitle, 'Sync the covers');
  assert.deepEqual(linesOf(syncGroup), ['SYNCED 2 /Books 46 -'], 'the sync\'s files, not its writes again');

  const ownGroup = groupOf(page, null);
  assert.equal(ownGroup.sessionTitle, null);
  assert.equal(ownGroup.isDriveChat, false);
  assert.deepEqual(linesOf(ownGroup).sort(), [`DELETED 1 /Home ${Buffer.byteLength('draft')} TRASH_GROUP`, 'RENAMED 1 /Home - -'].sort(),
    'the owner\'s own rename and delete');

  // ── (2) owner isolation ────────────────────────────────────────────────────────────────────
  const everything = JSON.stringify(page);
  assert.ok(!everything.includes(pub(theirs)) && !everything.includes(theirs) && !everything.includes('Stranger private work'),
    'nothing of the other account\'s session');
  assert.ok(!page.groups.some((g) => g.lines.some((l) => l.folderPath === '/Reports' && l.op === 'RENAMED')),
    'nor its rename in a folder of the same name');
  const strangerPage = await activity(strangerToken);
  assert.deepEqual(strangerPage.groups.map((g) => uuidOf(g.sessionId)), [theirs], 'theirs holds only their own session');
  assert.deepEqual(linesOf(strangerPage.groups[0]).sort(),
    [`WROTE 1 /Reports ${Buffer.byteLength('theirs')} -`, 'RENAMED 1 /Reports - -'].sort());
  for (const mine of [plain, chat, syncer]) assert.ok(!JSON.stringify(strangerPage).includes(pub(mine)), 'none of the owner\'s');

  // ── the references are the ones the existing routes take ──────────────────────────────────
  const deleted = plainGroup.lines.find((l) => l.op === 'DELETED')!;
  const foreign = await api('POST', `/api/drive/trash/groups/${deleted.undo!.id}/restore`, strangerToken);
  assert.equal(foreign.status, 404, `another account cannot restore it: ${foreign.text}`);
  ok(await api('POST', `/api/drive/trash/groups/${deleted.undo!.id}/restore`, ownerToken), 'the restore of the deletion');
  await drive.stat('/scratch/x.tmp');
  await drive.stat('/scratch/y.tmp');
  ok(await api('POST', `/api/drive/chats/${pub(chat)}/groups/${chatGroup.lines[0].undo!.id}/undo`, ownerToken), 'the chat\'s undo');
  await drive.stat('/Books/a.jpg');
  const after = await activity(ownerToken);
  assert.ok(!after.groups.some((g) => uuidOf(g.sessionId) === chat), 'an undone change group is no longer the chat\'s work');
  assert.ok(!groupOf(after, plain).lines.some((l) => l.op === 'DELETED'), 'a restored deletion is no longer in Trash to restore');

  // ── (3) paging ─────────────────────────────────────────────────────────────────────────────
  // 21 sessions moved something on 2026-01-10 (UTC), one on 2026-01-08: whole days a page, until a page holds 20 groups.
  const busyDay: string[] = [];
  for (let i = 0; i < 21; i += 1) busyDay.push(await session(pager, 'PERSON', `Busy ${i}`));
  const quietDay = await session(pager, 'PERSON', 'Quiet');
  const moved = async (sessionId: string, at: string) => sql.query(
    `INSERT INTO "drive_move"(id, owner_id, entry_id, kind, folder_id, actor_kind, actor_session_id, actor_runner_id, at)
     VALUES ($1, $2, $3, 'MOVE', $4, 'AGENT', $5, $6, $7)`,
    [randomUUID(), pager.id, randomUUID(), randomUUID(), sessionId, pager.runnerId, at],
  );
  for (const [i, id] of busyDay.entries()) await moved(id, `2026-01-10T10:${String(i).padStart(2, '0')}:00Z`);
  await moved(quietDay, '2026-01-08T23:30:00Z');
  const first = await activity(pagerToken, '?tz=UTC');
  assert.equal(first.groups.length, 21, 'the whole busy day, past 20 groups, never split');
  assert.deepEqual(first.groups.map((g) => uuidOf(g.sessionId)), [...busyDay].reverse(), 'newest first');
  assert.equal(first.groups[0].lines[0].folderPath, null, 'a folder gone for good has no path');
  assert.equal(first.nextBefore, '2026-01-10T00:00:00.000Z', 'the next page is before the busy day');
  const second = await activity(pagerToken, `?tz=UTC&before=${q(first.nextBefore!)}`);
  assert.deepEqual(second.groups.map((g) => uuidOf(g.sessionId)), [quietDay], 'the day before');
  assert.equal(second.nextBefore, null, 'nothing older');
  // In Shanghai (UTC+8) the quiet move was on 2026-01-09: the busy day still pages alone.
  const shanghai = await activity(pagerToken, '?tz=Asia/Shanghai');
  assert.equal(shanghai.nextBefore, '2026-01-09T16:00:00.000Z', 'the busy day starts at midnight in Shanghai');
  assert.equal((await api('GET', '/api/drive/activity?before=yesterday', pagerToken)).status, 400, 'a bad before');
  assert.equal((await api('GET', '/api/drive/activity?tz=Mars%2FOlympus', pagerToken)).status, 400, 'a bad tz');
});
