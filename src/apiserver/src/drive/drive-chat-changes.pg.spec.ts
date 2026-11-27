/**
 * A Drive chat's changes (owner decision Q2 A, board docs/mocks/drive-chat/01-board.html frames ③ ④; drive/
 * drive-chat-change-record.ts, drive-chat-changes.ts; migration 1700), held against the production apiserver —
 * `build/main.js`, every guard and pipe — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-chat-changes.pg.spec.ts
 *
 *   (1) grouping: one turn's writes through the runner drive door — mkdir -p, a move, a rename, a move to Trash, a new
 *       file, an overwrite — are one DONE group with counts per kind and every item, before and after; a write of no
 *       session, or of a session that is no Drive chat, is in none; the next turn is a group of its own; the routes are
 *       the owner's (another account is not found, a session header is refused);
 *   (2) Undo of each kind: the group reversed, last first — the edit's earlier version current again, the new file in
 *       Trash, the trashed file back, the rename and the move back under their ids, the new folder removed while empty
 *       (and one holding only what went to Trash moved to Trash with it); a second Undo is refused;
 *   (3) an item changed since is skipped and reported, not clobbered: a file the owner renamed after the chat did, a
 *       file the owner took back out of Trash, and both of two moves of one file whose later one the owner overtook;
 *   (4) no overwrite: a chat's move onto a live file is refused 409 with both files named (path, size, last writer,
 *       modified), nothing changed, kept as one question however often it is retried; KEEP_BOTH moves the incoming file
 *       to a numbered name beside the one there, REPLACE moves it onto it, which keeps its id and its old content as a
 *       version in Trash; a question whose file went meanwhile is STALE;
 *   (5) the 200-item hold: past the turn's 200th change — twenty racing writes at 190 included — each new folder, move,
 *       rename and move to Trash is refused 409 DRIVE_CHAT_HELD and held in one PENDING group that changes nothing; a
 *       new file is refused outright; Apply makes them in order and Undo reverses what Apply made.
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

import { toUuid, uuidToBase62 } from '@orbit/shared';
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

const ok = (reply: Reply, what: string): Reply => {
  assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
  return reply;
};
const refused = (reply: Reply, status: number, code: string, what: string): Reply => {
  assert.equal(reply.status, status, `${what}: ${reply.text}`);
  assert.equal(reply.json?.code, code, `${what}: ${reply.text}`);
  return reply;
};

test('Drive chat changes: one group a turn with Undo, no overwrite, the 200-item Apply hold', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const filesDir = mkdtempSync(path.join(tmpdir(), 'drive-chat-changes-'));
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
    const email = `${name}-${RUN}@drive-chat-changes.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');
  const runnerToken = `drive-chat-changes-${randomUUID()}`;
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId: owner.id, name: `laptop-${RUN}`, tokenHash: sha256(Buffer.from(runnerToken)) } });

  server = await startApiserver(url, `drive-chat-changes-${RUN}`, { ORBIT_DRIVE_DIR: filesDir, DEEPSEEK_API_KEY: '' });
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  // ── sessions and turns ─────────────────────────────────────────────────────────────────────
  let turnSeq = 0;
  /** A session of the owner's on the runner, opened by `openedBy`, working on its first turn. */
  const session = async (openedBy: string, title: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session"(id, title, prompt, owner_id, creator_id, assigned_runner_id, opened_by, turn_state, num_turns, updated_at)
       VALUES ($1, $2, 'p', $3, $3, $4, $5, 'IN_FLIGHT', 0, clock_timestamp())`,
      [id, title, owner.id, runnerId, openedBy],
    );
    const turnId = await nextTurn(id);
    return { id, turnId };
  };
  /** The session's turn in flight answered, and a new one in flight: what the chat works on now. */
  async function nextTurn(sessionId: string): Promise<string> {
    await sql.query(`UPDATE "conversation_turn" SET status = 'ANSWERED' WHERE session_id = $1 AND status = 'IN_FLIGHT'`, [sessionId]);
    const id = randomUUID();
    turnSeq += 1;
    await sql.query(
      `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
       VALUES ($1, $2, $3, $4, 'message', 'sort my files', 'IN_FLIGHT')`,
      [id, sessionId, turnSeq, randomUUID()],
    );
    return id;
  }
  const chat = await session('DRIVE_CHAT', 'Sort October receipts');
  const plain = await session('PERSON', 'An ordinary session');
  const chatWriter = { sessionId: pub(chat.id) };

  // ── the runner door, as the drive tools call it ────────────────────────────────────────────
  const door = (method: string, route: string, body?: unknown) => api(method, `/api/runner/drive${route}`, runnerToken, body);
  const raw = (route: string, bytes: Buffer): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server!.port, method: 'PUT', path: route,
      headers: {
        authorization: `Bearer ${runnerToken}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
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
  const put = async (drivePath: string, text: string, writer?: { sessionId: string }) => {
    const bytes = Buffer.from(text);
    const folder = drivePath.slice(0, drivePath.lastIndexOf('/')) || '/';
    if (folder !== '/') {
      const made = await door('POST', '/mkdir', { path: folder, parents: true, writer });
      if (made.status >= 300) return made;
    }
    const seen = await door('GET', `/stat?path=${q(drivePath)}`);
    const handleId = randomUUID();
    let entry;
    let mode: 'CONTINUE' | 'OVERWRITE';
    if (seen.status === 404) {
      const created = await door('POST', '/create', { path: drivePath, handleId, writer });
      if (created.status >= 300) return created;
      entry = created.json;
      mode = 'CONTINUE';
    } else {
      entry = ok(seen, `stat ${drivePath}`).json;
      mode = 'OVERWRITE';
    }
    const staging = ok(await door('POST', '/stagings', { entryId: entry.id }), 'a staging').json;
    assert.equal(await raw(`/api/runner/drive/stagings/${staging.id}/chunks/0`, bytes), 200, 'the chunk');
    return door('POST', '/commit', {
      commitId: randomUUID(), entryId: entry.id, handleId, mode, baseVersionId: entry.currentVersionId, stagingId: staging.id,
      chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }], writer,
    });
  };
  const stat = (drivePath: string) => door('GET', `/stat?path=${q(drivePath)}`);
  const live = async (drivePath: string) => ok(await stat(drivePath), `stat ${drivePath}`).json;
  const gone = async (drivePath: string) => refused(await stat(drivePath), 404, 'DRIVE_ENTRY_NOT_FOUND', `${drivePath} is not there`);
  const contentOf = async (drivePath: string) =>
    ok(await door('GET', `/manifest?path=${q(drivePath)}`), `manifest ${drivePath}`).json.chunks.map((c: { sha256: string }) => c.sha256);
  const move = (from: string, to: string, writer?: { sessionId: string }, extra: Record<string, unknown> = {}) =>
    door('POST', '/rename', { from, to, writer, ...extra });

  // ── the owner's routes ─────────────────────────────────────────────────────────────────────
  const base = `/api/drive/chats/${pub(chat.id)}`;
  const groupsOf = async () => ok(await api('GET', `${base}/groups`, ownerToken), 'the groups').json.groups;
  const groupsOfTurn = async (turnId: string) =>
    (await groupsOf()).filter((g: { turnId: string }) => toUuid(g.turnId) === turnId);
  const kinds = (group: { items: Array<{ kind: string }> }) => group.items.map((i) => i.kind);

  // A small drive the chat works on, written by no session: none of it is any chat's.
  for (const [p, text] of [
    ['/Scans/a.pdf', 'receipt a'], ['/Scans/b.pdf', 'receipt b'], ['/Scans/c.jpg', 'photo c'], ['/Scans/d.jpg', 'photo d, first'],
    ['/Scans/e.pdf', 'receipt e'], ['/Scans/x.pdf', 'receipt x'], ['/Scans/lease.pdf', 'the signed lease, 14 pages'],
    ['/Home/lease.pdf', 'a 2-page draft'], ['/Scans/plan.pdf', 'the new plan'], ['/Home/plan.pdf', 'the old plan'],
    ['/Scans/note.txt', 'a note'], ['/Home/note.txt', 'another note'],
  ] as const) {
    ok(await put(p, text), `setup ${p}`);
  }
  const ids: Record<string, string> = {};
  for (const p of ['/Scans/a.pdf', '/Scans/b.pdf', '/Scans/c.jpg', '/Scans/d.jpg', '/Scans/e.pdf', '/Home/lease.pdf', '/Home/plan.pdf']) {
    ids[p] = toUuid((await live(p)).id);
  }
  const dFirst = await contentOf('/Scans/d.jpg');

  let firstGroup: { id: string } = { id: '' };

  await t.test('(1) one turn of a Drive chat is one group of its changes, with counts and every item', async () => {
    ok(await door('POST', '/mkdir', { path: '/Receipts/2026-10', parents: true, writer: chatWriter }), 'mkdir -p');
    ok(await move('/Scans/a.pdf', '/Receipts/2026-10/2026-10-03 Blue Bottle.pdf', chatWriter), 'a move with a new name');
    ok(await move('/Scans/b.pdf', '/Scans/b renamed.pdf', chatWriter), 'a rename');
    ok(await door('POST', '/delete', { path: '/Scans/c.jpg', writer: chatWriter }), 'to Trash');
    ok(await put('/Receipts/notes.md', 'what I sorted', chatWriter), 'a new file');
    ok(await put('/Scans/d.jpg', 'photo d, second', chatWriter), 'an overwrite');
    // Not the chat's: no session, and a session that is no Drive chat.
    ok(await put('/Scans/f.pdf', 'from no session'), 'a write of no session');
    ok(await door('POST', '/mkdir', { path: '/Elsewhere', writer: { sessionId: pub(plain.id) } }), 'a write of another session');

    const groups = await groupsOf();
    assert.equal(groups.length, 1, 'one group');
    const [group] = groups;
    firstGroup = group;
    assert.equal(group.status, 'DONE');
    assert.equal(group.held, false);
    assert.equal(toUuid(group.turnId), chat.turnId, 'keyed by the turn');
    assert.equal(toUuid(group.sessionId), chat.id);
    assert.deepEqual(kinds(group), ['NEW_FOLDER', 'NEW_FOLDER', 'MOVE', 'RENAME', 'TRASH', 'NEW_FILE', 'EDIT'], 'every change, in order');
    assert.deepEqual(group.counts, { NEW_FOLDER: 2, MOVE: 1, RENAME: 1, TRASH: 1, NEW_FILE: 1, EDIT: 1 });
    assert.equal(group.total, 7);
    const [receipts, october, moved, renamed, trashed] = group.items;
    assert.deepEqual([receipts.after.parentPath, receipts.after.name, receipts.before.name], ['/', 'Receipts', null]);
    assert.deepEqual([october.after.parentPath, october.after.name], ['/Receipts', '2026-10']);
    assert.equal(toUuid(moved.entryId), ids['/Scans/a.pdf']);
    assert.deepEqual([moved.before.parentPath, moved.before.name], ['/Scans', 'a.pdf']);
    assert.deepEqual([moved.after.parentPath, moved.after.name], ['/Receipts/2026-10', '2026-10-03 Blue Bottle.pdf']);
    assert.deepEqual([renamed.before.name, renamed.after.name, renamed.after.parentPath], ['b.pdf', 'b renamed.pdf', '/Scans']);
    assert.deepEqual([trashed.before.parentPath, trashed.before.name, toUuid(trashed.entryId)], ['/Scans', 'c.jpg', ids['/Scans/c.jpg']]);
    assert.ok(group.items.every((i: { state: string }) => i.state === 'DONE'));

    const one = ok(await api('GET', `${base}/groups/${group.id}`, ownerToken), 'the group').json;
    assert.deepEqual(one, group, 'the group alone reads as in the list');

    // The next turn is a group of its own.
    const second = await nextTurn(chat.id);
    ok(await door('POST', '/mkdir', { path: '/Other', writer: chatWriter }), 'the next turn\'s mkdir');
    const after = await groupsOf();
    assert.equal(after.length, 2);
    assert.equal(toUuid(after[1].turnId), second);
    assert.deepEqual(after[1].counts, { NEW_FOLDER: 1 });

    // The owner's alone.
    refused(await api('GET', `${base}/groups`, strangerToken), 404, 'DRIVE_CHAT_NOT_FOUND', 'another account');
    refused(await api('GET', `/api/drive/chats/${pub(plain.id)}/groups`, ownerToken), 404, 'DRIVE_CHAT_NOT_FOUND', 'a session that is no chat');
    refused(await api('GET', `${base}/groups`, ownerToken, undefined, { 'x-orbit-session-id': pub(chat.id) }), 403,
      'DRIVE_CHAT_OWNER_CHANNEL_ONLY', 'a session header');
    refused(await api('POST', `${base}/groups/${group.id}/undo`, strangerToken), 404, 'DRIVE_CHAT_NOT_FOUND', 'another account\'s Undo');
  });

  await t.test('(2) Undo reverses each kind, last first', async () => {
    const undone = ok(await api('POST', `${base}/groups/${firstGroup.id}/undo`, ownerToken), 'Undo').json;
    assert.equal(undone.status, 'UNDONE');
    assert.ok(undone.undoneAt);
    assert.equal(undone.skipped, 0, JSON.stringify(undone.items.filter((i: { state: string }) => i.state !== 'UNDONE')));
    assert.ok(undone.items.every((i: { state: string }) => i.state === 'UNDONE'));

    // EDIT: the version it replaced is current again.
    assert.deepEqual(await contentOf('/Scans/d.jpg'), dFirst, 'the edit undone');
    // NEW_FILE: in Trash.
    await gone('/Receipts/notes.md');
    const notes = await db.driveEntry.findFirstOrThrow({ where: { ownerId: owner.id, name: 'notes.md' } });
    assert.ok(notes.trashedAt, 'the new file is in Trash');
    // TRASH: back where it was, by the Trash's own restore.
    assert.equal(toUuid((await live('/Scans/c.jpg')).id), ids['/Scans/c.jpg']);
    // RENAME and MOVE: back under their ids.
    assert.equal(toUuid((await live('/Scans/b.pdf')).id), ids['/Scans/b.pdf']);
    assert.equal(toUuid((await live('/Scans/a.pdf')).id), ids['/Scans/a.pdf']);
    await gone('/Scans/b renamed.pdf');
    // NEW_FOLDER: 2026-10, empty again, removed outright; Receipts, holding only the new file in Trash, moved to Trash with it.
    await gone('/Receipts');
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner.id, name: '2026-10' } }), 0, 'the empty new folder is removed');
    const receipts = await db.driveEntry.findFirstOrThrow({ where: { ownerId: owner.id, name: 'Receipts' } });
    assert.ok(receipts.trashedAt, 'the new folder holding Trash went to Trash');
    assert.equal(notes.parentId, receipts.id);

    refused(await api('POST', `${base}/groups/${firstGroup.id}/undo`, ownerToken), 409, 'DRIVE_CHAT_GROUP_STATE', 'a second Undo');
    assert.equal((await groupsOf())[1].status, 'DONE', 'the other turn\'s group is untouched');
    await live('/Other');
  });

  await t.test('(3) an item changed since is skipped and reported, not clobbered', async () => {
    const turn = await nextTurn(chat.id);
    ok(await move('/Scans/a.pdf', '/Scans/a2.pdf', chatWriter), 'rename a');
    ok(await move('/Scans/b.pdf', '/Scans/b2.pdf', chatWriter), 'rename b');
    ok(await door('POST', '/delete', { path: '/Scans/e.pdf', writer: chatWriter }), 'trash e');
    ok(await move('/Scans/d.jpg', '/Scans/d1.jpg', chatWriter), 'move d once');
    ok(await move('/Scans/d1.jpg', '/Scans/d2.jpg', chatWriter), 'and again');
    const [group] = await groupsOfTurn(turn);
    assert.deepEqual(kinds(group), ['RENAME', 'RENAME', 'TRASH', 'RENAME', 'RENAME']);

    // The owner, since: renames a2 and d2, and takes e back out of Trash.
    ok(await api('PATCH', `/api/drive/entries/${pub(ids['/Scans/a.pdf'])}`, ownerToken, { name: 'a3.pdf' }), 'the owner renames a');
    ok(await api('PATCH', `/api/drive/entries/${pub(ids['/Scans/d.jpg'])}`, ownerToken, { name: 'd3.jpg' }), 'the owner renames d');
    const e = await db.driveEntry.findUniqueOrThrow({ where: { id: ids['/Scans/e.pdf'] } });
    ok(await api('POST', `/api/drive/trash/groups/${pub(e.trashGroupId!)}/restore`, ownerToken), 'the owner restores e');

    const undone = ok(await api('POST', `${base}/groups/${group.id}/undo`, ownerToken), 'Undo').json;
    assert.equal(undone.status, 'UNDONE');
    assert.deepEqual(undone.items.map((i: { state: string }) => i.state), ['SKIPPED', 'UNDONE', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
    assert.equal(undone.skipped, 4);
    const [a, , trashed, dOnce, dTwice] = undone.items;
    assert.match(a.reason, /^"a2\.pdf" changed after this chat changed it, so it was left as it is\.$/);
    assert.match(trashed.reason, /^"e\.pdf" is no longer in Trash/);
    assert.match(dTwice.reason, /^"d2\.jpg" changed after this chat changed it/);
    assert.match(dOnce.reason, /^"d1\.jpg" was left as it is: a later change to it could not be undone\.$/);
    // Left as the owner made them; the one nobody touched went back.
    assert.equal(toUuid((await live('/Scans/a3.pdf')).id), ids['/Scans/a.pdf']);
    assert.equal(toUuid((await live('/Scans/d3.jpg')).id), ids['/Scans/d.jpg']);
    assert.equal(toUuid((await live('/Scans/e.pdf')).id), ids['/Scans/e.pdf']);
    assert.equal(toUuid((await live('/Scans/b.pdf')).id), ids['/Scans/b.pdf']);
  });

  await t.test('(4) a Drive chat never overwrites: refused with both files named, then Keep both or Replace', async () => {
    const turn = await nextTurn(chat.id);
    const leaseDraft = await contentOf('/Home/lease.pdf');
    const leaseSigned = await contentOf('/Scans/lease.pdf');
    const first = refused(await move('/Scans/lease.pdf', '/Home/lease.pdf', chatWriter), 409, 'DRIVE_CHAT_NO_OVERWRITE', 'a move onto a file');
    const text: string = first.json.message;
    assert.match(text, /^Not moved: \/Home\/lease\.pdf is already there, and a Drive chat never replaces a file\./);
    assert.match(text, /Moving: \/Scans\/lease\.pdf \(26 bytes, last written by an agent, modified \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    assert.match(text, /Already there: \/Home\/lease\.pdf \(14 bytes, last written by an agent, modified \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    assert.match(text, /keep both .* or replace the one there .*do not retry this move\.$/);
    assert.equal(first.json.moving.path, '/Scans/lease.pdf');
    assert.equal(first.json.moving.sizeBytes, 26);
    assert.equal(first.json.existing.path, '/Home/lease.pdf');
    assert.equal(first.json.existing.lastWriter.kind, 'AGENT');
    assert.ok(first.json.moving.modifiedAt && first.json.existing.modifiedAt);
    // Nothing changed, nothing recorded.
    assert.deepEqual(await contentOf('/Home/lease.pdf'), leaseDraft);
    assert.deepEqual(await contentOf('/Scans/lease.pdf'), leaseSigned);
    assert.equal(toUuid((await live('/Home/lease.pdf')).id), ids['/Home/lease.pdf']);
    assert.deepEqual(await groupsOfTurn(turn), []);
    // Asked again, the same question; noReplace false changes nothing for a chat.
    const again = refused(await move('/Scans/lease.pdf', '/Home/lease.pdf', chatWriter, { noReplace: false }), 409,
      'DRIVE_CHAT_NO_OVERWRITE', 'asked again');
    assert.equal(again.json.questionId, first.json.questionId);
    const asked = ok(await api('GET', `${base}/questions`, ownerToken), 'the questions').json.questions;
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0].id, asked[0].status, toUuid(asked[0].turnId)], [first.json.questionId, 'OPEN', turn]);
    assert.equal(asked[0].destination.name, 'lease.pdf');

    // KEEP_BOTH: the incoming file beside the one there, under the first free number.
    assert.equal((await api('POST', `${base}/questions/${first.json.questionId}`, ownerToken, { choice: 'BOTH' })).status, 400, 'a choice it does not take');
    refused(await api('POST', `${base}/questions/${first.json.questionId}`, strangerToken, { choice: 'KEEP_BOTH' }), 404,
      'DRIVE_CHAT_NOT_FOUND', 'another account answers');
    const kept = ok(await api('POST', `${base}/questions/${first.json.questionId}`, ownerToken, { choice: 'KEEP_BOTH' }), 'Keep both').json;
    assert.equal(kept.status, 'ANSWERED');
    assert.equal(kept.choice, 'KEEP_BOTH');
    assert.equal(kept.outcome.path, '/Home/lease (2).pdf');
    assert.deepEqual(await contentOf('/Home/lease (2).pdf'), leaseSigned);
    assert.deepEqual(await contentOf('/Home/lease.pdf'), leaseDraft, 'the one there untouched');
    await gone('/Scans/lease.pdf');
    refused(await api('POST', `${base}/questions/${first.json.questionId}`, ownerToken, { choice: 'REPLACE' }), 409,
      'DRIVE_CHAT_QUESTION_STATE', 'answered twice');

    // REPLACE: onto the file there, which keeps its id and keeps its old content as a version in Trash.
    const planOld = await contentOf('/Home/plan.pdf');
    const planNew = await contentOf('/Scans/plan.pdf');
    const plan = refused(await move('/Scans/plan.pdf', '/Home/plan.pdf', chatWriter), 409, 'DRIVE_CHAT_NO_OVERWRITE', 'the plan');
    const target = await db.driveEntry.findUniqueOrThrow({ where: { id: ids['/Home/plan.pdf'] } });
    const replaced = ok(await api('POST', `${base}/questions/${plan.json.questionId}`, ownerToken, { choice: 'REPLACE' }), 'Replace').json;
    assert.equal(replaced.status, 'ANSWERED');
    assert.equal(replaced.outcome.path, '/Home/plan.pdf');
    assert.equal(toUuid(replaced.outcome.entryId), ids['/Home/plan.pdf'], 'the file there keeps its id');
    assert.deepEqual(await contentOf('/Home/plan.pdf'), planNew);
    await gone('/Scans/plan.pdf');
    const old = await db.driveVersion.findUniqueOrThrow({ where: { id: target.currentVersionId! } });
    assert.ok(old.replacedAt, 'the old content is a replaced version');
    assert.equal(old.entryId, ids['/Home/plan.pdf']);
    assert.equal((await db.driveTrashGroup.findUniqueOrThrow({ where: { id: old.trashGroupId! } })).kind, 'VERSION');
    const oldChunks = await db.driveVersionChunk.findMany({ where: { versionId: old.id }, orderBy: { idx: 'asc' } });
    assert.deepEqual(oldChunks.map((c) => c.sha256), planOld, 'and that version holds the old plan');

    // A question whose file went meanwhile is STALE.
    const note = refused(await move('/Scans/note.txt', '/Home/note.txt', chatWriter), 409, 'DRIVE_CHAT_NO_OVERWRITE', 'the note');
    const noteId = (await live('/Scans/note.txt')).id as string;
    ok(await api('DELETE', `/api/drive/entries/${noteId}`, ownerToken), 'the owner trashes the note');
    const stale = refused(await api('POST', `${base}/questions/${note.json.questionId}`, ownerToken, { choice: 'KEEP_BOTH' }), 409,
      'DRIVE_CHAT_QUESTION_STATE', 'a file gone meanwhile');
    assert.equal(stale.json.status, 'STALE');
    assert.match(stale.json.message, /^This can no longer be answered: the file being moved is gone or in Trash now\.$/);
    const listed = ok(await api('GET', `${base}/questions`, ownerToken), 'the questions').json.questions;
    assert.deepEqual(listed.map((x: { status: string }) => x.status), ['ANSWERED', 'ANSWERED', 'STALE']);
    // The owner's answers are not the chat's changes.
    assert.deepEqual(await groupsOfTurn(turn), []);
  });

  await t.test('(5) past 200 changes a turn is held as a PENDING group that changes nothing until Apply', async () => {
    const turn = await nextTurn(chat.id);
    const deep = '/Deep/' + Array.from({ length: 189 }, (_, i) => `f${i + 1}`).join('/');
    ok(await door('POST', '/mkdir', { path: deep, parents: true, writer: chatWriter }), '190 folders');
    // Twenty racing writes at 190: exactly ten are made, ten held.
    const racing = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      door('POST', '/mkdir', { path: `/p${String(i).padStart(2, '0')}`, writer: chatWriter })));
    const made = racing.filter((r) => r.status === 201);
    const held = racing.filter((r) => r.status === 409);
    assert.equal(made.length, 10, racing.map((r) => `${r.status} ${r.json?.code ?? ''}`).join(', '));
    assert.equal(held.length, 10);
    for (const r of held) assert.equal(r.json.code, 'DRIVE_CHAT_HELD', r.text);
    assert.match(held[0].json.message,
      /^Held for the owner, not done: this turn has already made 200 changes in their Drive, so from the 201st on each change waits on one card in this chat until the owner presses Apply \(\d+ waiting now\)\. Nothing was changed\. Do not retry it: finish the turn by telling the owner what is waiting for their Apply\.$/);
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner.id, name: { startsWith: 'p' }, kind: 'FOLDER', trashedAt: null, parent: { is: { parentId: null } } } }), 10);

    // Each organising write after is held, even into a folder only a held write makes; a new file is refused outright.
    refused(await door('POST', '/mkdir', { path: '/Sorted', writer: chatWriter }), 409, 'DRIVE_CHAT_HELD', 'a new folder');
    refused(await move('/Scans/b.pdf', '/Sorted/b.pdf', chatWriter), 409, 'DRIVE_CHAT_HELD', 'a move into it');
    refused(await move('/Scans/c.jpg', '/Scans/c renamed.jpg', chatWriter), 409, 'DRIVE_CHAT_HELD', 'a rename');
    refused(await door('POST', '/delete', { path: '/Scans/x.pdf', writer: chatWriter }), 409, 'DRIVE_CHAT_HELD', 'to Trash');
    const file = refused(await put('/Scans/new.md', 'new', chatWriter), 409, 'DRIVE_CHAT_TURN_FULL', 'a new file');
    assert.match(file.json.message, /^Not written: this turn has already made 200 changes in the owner's Drive, and a new file or new content cannot wait for their Apply, so nothing was written\./);
    // Nothing changed.
    await gone('/Sorted');
    await gone('/Scans/new.md');
    await gone('/Scans/c renamed.jpg');
    assert.equal(toUuid((await live('/Scans/b.pdf')).id), ids['/Scans/b.pdf']);
    await live('/Scans/x.pdf');

    const [done, pending] = await groupsOfTurn(turn);
    assert.deepEqual([done.status, done.held, done.total], ['DONE', false, 200], 'two hundred made');
    assert.equal(await db.driveChatChange.count({ where: { groupId: toUuid(done.id) } }), 200);
    assert.deepEqual([pending.status, pending.held, pending.total], ['PENDING', true, 14]);
    assert.deepEqual(pending.counts, { NEW_FOLDER: 11, MOVE: 1, RENAME: 1, TRASH: 1 });
    assert.deepEqual(pending.items, []);
    const sorted = pending.heldItems.find((h: { toPath: string | null }) => h.toPath === '/Sorted/b.pdf');
    assert.deepEqual([sorted.kind, sorted.name, sorted.fromPath, sorted.state], ['MOVE', 'b.pdf', '/Scans/b.pdf', 'PENDING']);
    refused(await api('POST', `${base}/groups/${pending.id}/undo`, ownerToken), 409, 'DRIVE_CHAT_GROUP_STATE', 'Undo of what was not made');

    // Apply: made in order, as the owner, and recorded into the group.
    const applied = ok(await api('POST', `${base}/groups/${pending.id}/apply`, ownerToken), 'Apply').json;
    assert.equal(applied.status, 'DONE');
    assert.ok(applied.appliedAt);
    assert.ok(applied.heldItems.every((h: { state: string }) => h.state === 'APPLIED'), JSON.stringify(applied.heldItems));
    assert.deepEqual(applied.counts, { NEW_FOLDER: 11, MOVE: 1, RENAME: 1, TRASH: 1 });
    assert.equal(toUuid((await live('/Sorted/b.pdf')).id), ids['/Scans/b.pdf']);
    assert.equal(toUuid((await live('/Scans/c renamed.jpg')).id), ids['/Scans/c.jpg']);
    await gone('/Scans/x.pdf');
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner.id, name: { startsWith: 'p' }, kind: 'FOLDER', trashedAt: null, parent: { is: { parentId: null } } } }), 20);
    refused(await api('POST', `${base}/groups/${pending.id}/apply`, ownerToken), 409, 'DRIVE_CHAT_GROUP_STATE', 'a second Apply');

    // Undo reverses what Apply made.
    const undone = ok(await api('POST', `${base}/groups/${pending.id}/undo`, ownerToken), 'Undo of the applied group').json;
    assert.equal(undone.status, 'UNDONE');
    assert.equal(undone.skipped, 0, JSON.stringify(undone.items.filter((i: { state: string }) => i.state !== 'UNDONE')));
    assert.equal(toUuid((await live('/Scans/b.pdf')).id), ids['/Scans/b.pdf']);
    assert.equal(toUuid((await live('/Scans/c.jpg')).id), ids['/Scans/c.jpg']);
    await live('/Scans/x.pdf');
    await gone('/Sorted');
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner.id, name: { startsWith: 'p' }, kind: 'FOLDER', trashedAt: null, parent: { is: { parentId: null } } } }), 10);
  });
});
