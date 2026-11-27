/**
 * A Drive chat's writes through the Cloud ~/Files mount (docs/drive-technical-design.md §5.8; drive/
 * runner-drive.controller.ts `writer`, drive-chat-change-record.ts), held to the rules its drive tools are held to,
 * against the production apiserver — `build/main.js`, every guard and pipe — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-chat-mount.pg.spec.ts
 *
 * Every write here is sent as the mount daemon sends it (src/drive-mount/door): the mount credential of one managed-
 * runner generation with its instance headers, entries named by id, `mkdir` without `parents`, a rename with
 * `noReplace: false` (rename(2)), and `writer` the session the privileged parent read from /proc, or null.
 *
 *   (1) attributed: a mkdir, a move, a rename and an unlink from the chat's process are one DONE group of its turn,
 *       which one Undo reverses;
 *   (2) attributed: a rename onto a live file is refused 409 DRIVE_CHAT_NO_OVERWRITE naming both files, nothing
 *       changed, and the owner's Keep both / Replace question is filed;
 *   (3) attributed: past the turn's 200th change the 201st is held for Apply (409 DRIVE_CHAT_HELD, nothing made), and a
 *       new file is refused DRIVE_CHAT_TURN_FULL;
 *   (4) unattributed (a Docker mount, pid 0): a mount write naming no session while the chat is the runner's only live
 *       session is the chat's — grouped, and refused onto a live file — but not while another session is live (a
 *       background job running), and never one through the runner credential.
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  toUuid,
  uuidToBase62,
} from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { issueDriveMountCredential } from './drive-mount-credential';

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

test('Drive chat through the Cloud mount: grouped with Undo, no overwrite, the 200-item hold, unattributed writes', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const filesDir = mkdtempSync(path.join(tmpdir(), 'drive-chat-mount-'));
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(filesDir, { recursive: true, force: true });
  });

  // ── the account and its Cloud runner ───────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const password = `pw-${RUN}`;
  const email = `owner-${RUN}@drive-chat-mount.invalid`;
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, 'owner', $3, 'MEMBER')`,
    [ownerId, email, hashPassword(password)]);
  const runnerId = randomUUID();
  const runnerToken = `drive-chat-mount-${randomUUID()}`;
  await db.runner.create({ data: { id: runnerId, ownerId, name: `cloud-${RUN}`, tokenHash: sha256(Buffer.from(runnerToken)) } });
  const podUid = randomUUID();
  await db.managedRunner.create({
    data: {
      ownerId, runnerId, clusterKey: 'drive-chat-mount-spec', namespace: 'orbit', pvcName: `mr-data-${runnerId}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  const mountToken = (await issueDriveMountCredential(db as never, { ownerId, runnerId, generation: 1 })).token;
  const instance = {
    'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
    [MANAGED_RUNNER_GENERATION_HEADER]: '1',
    [MANAGED_RUNNER_POD_UID_HEADER]: podUid,
  };

  server = await startApiserver(url, `drive-chat-mount-${RUN}`, { ORBIT_DRIVE_DIR: filesDir, DEEPSEEK_API_KEY: '' });
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);
  const signedIn = await api('POST', '/api/auth/login', undefined, { email, password });
  assert.equal(signedIn.status, 201, signedIn.text);
  const ownerToken = signedIn.json.accessToken as string;

  // ── sessions and turns ─────────────────────────────────────────────────────────────────────
  let turnSeq = 0;
  /** A session of the owner's on the Cloud runner, opened by `openedBy`, parked until a turn is put in flight. */
  const session = async (openedBy: string, title: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session"(id, title, prompt, owner_id, creator_id, assigned_runner_id, opened_by, num_turns, updated_at)
       VALUES ($1, $2, 'p', $3, $3, $4, $5, 0, clock_timestamp())`,
      [id, title, ownerId, runnerId, openedBy],
    );
    return id;
  };
  /** The session's turn in flight answered, and a new one in flight: what the chat works on now. */
  const nextTurn = async (sessionId: string): Promise<string> => {
    await sql.query(`UPDATE "conversation_turn" SET status = 'ANSWERED' WHERE session_id = $1 AND status = 'IN_FLIGHT'`, [sessionId]);
    await sql.query(`UPDATE "session" SET turn_state = 'IN_FLIGHT' WHERE id = $1`, [sessionId]);
    const id = randomUUID();
    turnSeq += 1;
    await sql.query(
      `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
       VALUES ($1, $2, $3, $4, 'message', 'sort my files', 'IN_FLIGHT')`,
      [id, sessionId, turnSeq, randomUUID()],
    );
    return id;
  };
  const chat = await session('DRIVE_CHAT', 'Sort the scans');
  const plain = await session('PERSON', 'An ordinary session on the same runner');
  const fromChat = { sessionId: pub(chat) };

  // ── the door, as the mount daemon and the runner call it ───────────────────────────────────
  const mount = (method: string, route: string, body?: unknown) =>
    api(method, `/api/runner/drive${route}`, mountToken, body, instance);
  const asRunner = (method: string, route: string, body?: unknown) =>
    api(method, `/api/runner/drive${route}`, runnerToken, body, instance);
  const chunk = (token: string, stagingId: string, bytes: Buffer): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server!.port, method: 'PUT', path: `/api/runner/drive/stagings/${stagingId}/chunks/0`,
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
        'x-orbit-chunk-sha256': sha256(bytes), ...instance,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(bytes);
  });
  /** A file made through the mount: create (an empty first version), its staging and chunk, one CONTINUE commit. */
  const mountWrite = async (drivePath: string, text: string, writer: { sessionId: string } | null) => {
    const handleId = randomUUID();
    const created = await mount('POST', '/create', { path: drivePath, handleId, writer });
    if (created.status >= 300) return created;
    const staging = ok(await mount('POST', '/stagings', { entryId: created.json.id }), 'a staging').json;
    const bytes = Buffer.from(text);
    assert.equal(await chunk(mountToken, staging.id, bytes), 200, 'the chunk');
    return mount('POST', '/commit', {
      commitId: randomUUID(), entryId: created.json.id, handleId, mode: 'CONTINUE', baseVersionId: created.json.currentVersionId,
      stagingId: staging.id, chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }], writer,
    });
  };
  const stat = (drivePath: string) => mount('GET', `/stat?path=${q(drivePath)}`);
  const live = async (drivePath: string) => ok(await stat(drivePath), `stat ${drivePath}`).json;
  const gone = async (drivePath: string) => refused(await stat(drivePath), 404, 'DRIVE_ENTRY_NOT_FOUND', `${drivePath} is not there`);
  const mkdir = (drivePath: string, writer: { sessionId: string } | null) => mount('POST', '/mkdir', { path: drivePath, parents: false, writer });
  /** rename(2) through the mount: the source by id, onto `to`, replacing what is there unless the door refuses. */
  const rename = async (from: string, to: string, writer: { sessionId: string } | null) =>
    mount('POST', '/rename', { id: (await live(from)).id, to, noReplace: false, writer });
  const unlink = async (drivePath: string, writer: { sessionId: string } | null) =>
    mount('POST', '/delete', { id: (await live(drivePath)).id, writer });

  // ── the owner's routes ─────────────────────────────────────────────────────────────────────
  const base = `/api/drive/chats/${pub(chat)}`;
  const groupsOfTurn = async (turnId: string) =>
    ok(await api('GET', `${base}/groups`, ownerToken), 'the groups').json.groups
      .filter((g: { turnId: string }) => toUuid(g.turnId) === turnId);
  const kinds = (group: { items: Array<{ kind: string }> }) => group.items.map((i) => i.kind);

  // A small drive, written through the mount by no session while nothing on the runner is live: nobody's.
  for (const [p, text] of [
    ['/Scans/a.pdf', 'receipt a'], ['/Scans/b.pdf', 'receipt b'], ['/Scans/c.pdf', 'receipt c'],
    ['/Scans/lease.pdf', 'the signed lease, 14 pages'], ['/Home/lease.pdf', 'a 2-page draft'],
    ['/Scans/d.pdf', 'receipt d'], ['/Home/d.pdf', 'another d'], ['/Scans/e.pdf', 'receipt e'],
  ] as const) {
    const folder = p.slice(0, p.lastIndexOf('/'));
    if ((await stat(folder)).status === 404) ok(await mkdir(folder, null), `setup ${folder}`);
    ok(await mountWrite(p, text, null), `setup ${p}`);
  }
  assert.equal(await db.driveChatChangeGroup.count({ where: { sessionId: chat } }), 0, 'nothing of the setup is the chat\'s');
  const ids: Record<string, string> = {};
  for (const p of ['/Scans/a.pdf', '/Scans/b.pdf', '/Scans/c.pdf', '/Home/lease.pdf', '/Scans/lease.pdf']) ids[p] = (await live(p)).id;

  await t.test('(1) an attributed mkdir, move, rename and unlink are one group of the turn, and one Undo reverses it', async () => {
    const turn = await nextTurn(chat);
    ok(await mkdir('/Sorted', fromChat), 'mkdir $F/Sorted');
    ok(await rename('/Scans/a.pdf', '/Sorted/a.pdf', fromChat), 'mv $F/Scans/a.pdf $F/Sorted/');
    ok(await rename('/Scans/b.pdf', '/Scans/b renamed.pdf', fromChat), 'mv $F/Scans/b.pdf "$F/Scans/b renamed.pdf"');
    ok(await unlink('/Scans/c.pdf', fromChat), 'rm $F/Scans/c.pdf');

    const groups = await groupsOfTurn(turn);
    assert.equal(groups.length, 1, 'one group');
    const [group] = groups;
    assert.deepEqual([group.status, group.held, group.total], ['DONE', false, 4]);
    assert.deepEqual(kinds(group), ['NEW_FOLDER', 'MOVE', 'RENAME', 'TRASH'], 'every change, in order');
    assert.deepEqual(group.counts, { NEW_FOLDER: 1, MOVE: 1, RENAME: 1, TRASH: 1 });
    assert.equal(group.items[1].entryId, ids['/Scans/a.pdf']);
    const sorted = await live('/Sorted/a.pdf');
    assert.equal(toUuid(sorted.lastWriter.sessionId), chat, 'written as the chat');

    const undone = ok(await api('POST', `${base}/groups/${group.id}/undo`, ownerToken), 'Undo').json;
    assert.equal(undone.status, 'UNDONE');
    assert.equal(undone.skipped, 0, JSON.stringify(undone.items.filter((i: { state: string }) => i.state !== 'UNDONE')));
    assert.equal((await live('/Scans/a.pdf')).id, ids['/Scans/a.pdf'], 'the move back, same id');
    assert.equal((await live('/Scans/b.pdf')).id, ids['/Scans/b.pdf'], 'the rename back');
    assert.equal((await live('/Scans/c.pdf')).id, ids['/Scans/c.pdf'], 'out of Trash');
    await gone('/Sorted');
    await gone('/Scans/b renamed.pdf');
    t.diagnostic(`(1) one group of ${group.total} changes (${kinds(group).join(', ')}), Undo: ${undone.items.length} undone, ${undone.skipped} skipped`);
  });

  await t.test('(2) an attributed rename onto a live file is refused, both named, and the question filed', async () => {
    const turn = await nextTurn(chat);
    const refusal = refused(await rename('/Scans/lease.pdf', '/Home/lease.pdf', fromChat), 409, 'DRIVE_CHAT_NO_OVERWRITE',
      'mv $F/Scans/lease.pdf $F/Home/lease.pdf');
    assert.match(refusal.json.message, /^Not moved: \/Home\/lease\.pdf is already there, and a Drive chat never replaces a file\. Moving: \/Scans\/lease\.pdf \(26 bytes, /);
    assert.match(refusal.json.message, /Already there: \/Home\/lease\.pdf \(14 bytes, /);
    assert.match(refusal.json.message, /keep both .* or replace the one there .*do not retry this move\.$/);
    // Nothing changed, nothing recorded.
    assert.equal((await live('/Home/lease.pdf')).id, ids['/Home/lease.pdf']);
    assert.equal((await live('/Home/lease.pdf')).sizeBytes, 14);
    assert.equal((await live('/Scans/lease.pdf')).id, ids['/Scans/lease.pdf']);
    assert.deepEqual(await groupsOfTurn(turn), []);
    const asked = ok(await api('GET', `${base}/questions`, ownerToken), 'the questions').json.questions;
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0].id, asked[0].status, toUuid(asked[0].turnId)], [refusal.json.questionId, 'OPEN', turn]);
    assert.deepEqual([asked[0].moving.path, asked[0].existing.path], ['/Scans/lease.pdf', '/Home/lease.pdf']);
    t.diagnostic(`(2) refused 409 DRIVE_CHAT_NO_OVERWRITE; ${asked.length} OPEN question, ${asked[0].moving.path} onto ${asked[0].existing.path}`);
  });

  await t.test('(3) past 200 attributed mount changes the 201st is held for Apply, and a new file refused', async () => {
    const turn = await nextTurn(chat);
    ok(await mkdir('/Many', fromChat), 'mkdir $F/Many');
    for (let i = 1; i <= 199; i += 1) ok(await mkdir(`/Many/f${i}`, fromChat), `mkdir $F/Many/f${i}`);
    const held = refused(await mkdir('/Many/f200', fromChat), 409, 'DRIVE_CHAT_HELD', 'the 201st change');
    assert.match(held.json.message, /^Held for the owner, not done: this turn has already made 200 changes in their Drive, so from the 201st on each change waits on one card in this chat until the owner presses Apply \(1 waiting now\)\. Nothing was changed\./);
    await gone('/Many/f200');
    refused(await rename('/Scans/e.pdf', '/Many/e.pdf', fromChat), 409, 'DRIVE_CHAT_HELD', 'the 202nd, a move');
    await live('/Scans/e.pdf');
    const file = refused(await mountWrite('/Many/new.md', 'new', fromChat), 409, 'DRIVE_CHAT_TURN_FULL', 'a new file');
    assert.match(file.json.message, /^Not written: this turn has already made 200 changes in the owner's Drive/);
    await gone('/Many/new.md');

    const [done, pending] = await groupsOfTurn(turn);
    assert.deepEqual([done.status, done.held, done.total], ['DONE', false, 200], 'two hundred made');
    assert.deepEqual([pending.status, pending.held, pending.total], ['PENDING', true, 2]);
    assert.deepEqual(pending.heldItems.map((h: { kind: string; toPath: string | null; state: string }) => [h.kind, h.toPath, h.state]),
      [['NEW_FOLDER', '/Many/f200', 'PENDING'], ['MOVE', '/Many/e.pdf', 'PENDING']]);
    const applied = ok(await api('POST', `${base}/groups/${pending.id}/apply`, ownerToken), 'Apply').json;
    assert.equal(applied.status, 'DONE');
    await live('/Many/f200');
    await live('/Many/e.pdf');
    t.diagnostic(`(3) ${done.total} made; change 201 held (${pending.total} held, PENDING), a new file DRIVE_CHAT_TURN_FULL; Apply made them`);
  });

  await t.test('(4) an unattributed mount write is the chat\'s while it is the runner\'s only live session, and only then', async () => {
    const turn = await nextTurn(chat);
    // The chat is the only live session: the plain one is parked.
    ok(await mkdir('/Inferred', null), 'mkdir from pid 0');
    ok(await rename('/Scans/d.pdf', '/Inferred/d.pdf', null), 'mv from pid 0');
    const [group] = await groupsOfTurn(turn);
    assert.deepEqual(kinds(group), ['NEW_FOLDER', 'MOVE'], 'grouped into the chat\'s turn');
    assert.equal(toUuid((await live('/Inferred').then((e) => e)).lastWriter.sessionId), chat);
    const refusal = refused(await rename('/Inferred/d.pdf', '/Home/d.pdf', null), 409, 'DRIVE_CHAT_NO_OVERWRITE', 'mv onto a live file from pid 0');
    assert.match(refusal.json.message, /^Not moved: \/Home\/d\.pdf is already there/);
    assert.equal((await live('/Home/d.pdf')).sizeBytes, Buffer.byteLength('another d'));
    // Undo takes back what pid 0 made as the chat's.
    const undone = ok(await api('POST', `${base}/groups/${group.id}/undo`, ownerToken), 'Undo').json;
    assert.equal(undone.skipped, 0);
    await live('/Scans/d.pdf');
    await gone('/Inferred');

    // The runner credential (reply links, file_upload of a drive path) is never counted as the chat's.
    ok(await asRunner('POST', '/mkdir', { path: '/ByTheRunner', parents: false }), 'the runner\'s own mkdir');
    assert.equal((await live('/ByTheRunner')).lastWriter.sessionId, null);
    // Another session live on the runner (a background job still running): a write naming no session is nobody's.
    await sql.query(`UPDATE "session" SET running_bg_shells = ARRAY['bgj_still_running'] WHERE id = $1`, [plain]);
    ok(await mkdir('/Shared', null), 'mkdir from pid 0 with two sessions live');
    assert.equal((await live('/Shared')).lastWriter.sessionId, null);
    ok(await rename('/Scans/d.pdf', '/Home/d.pdf', null), 'rename(2) replaces, as for any writer');
    await sql.query(`UPDATE "session" SET running_bg_shells = '{}' WHERE id = $1`, [plain]);
    // The chat's turn over: nobody's again.
    await sql.query(`UPDATE "conversation_turn" SET status = 'ANSWERED' WHERE session_id = $1 AND status = 'IN_FLIGHT'`, [chat]);
    await sql.query(`UPDATE "session" SET turn_state = NULL WHERE id = $1`, [chat]);
    ok(await mkdir('/AfterTheTurn', null), 'mkdir from pid 0 with nothing live');
    assert.equal((await live('/AfterTheTurn')).lastWriter.sessionId, null);
    const groups = await groupsOfTurn(turn);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].total, 2, 'nothing after the controls joined the chat\'s group');
    t.diagnostic('(4) pid 0, chat the only live session: grouped (NEW_FOLDER, MOVE) and refused onto a live file; '
      + 'runner credential, a second live session, and no live session: not the chat\'s');
  });
});
