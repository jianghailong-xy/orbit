/**
 * A failed sync handed to an agent (drive/drive-sync-fix.ts, `POST /api/drive/syncs/:id/fix`; board drive-web 01 frame 6),
 * held against the production apiserver over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-sync-fix.pg.spec.ts
 *
 *   1. refusals that write nothing: another account's sync (404), a session header (403), a sync still running, one
 *      with nothing failed, an unknown mode;
 *   2. the sync's own session can take a turn: the failures go to it as a NEXT_TURN message naming the sync and listing
 *      each failed path with its reason; the sync records the session and when, reads `fix.working` while the turn
 *      waits, and a second press is refused;
 *   3. the session stops: with nothing pending the row is no longer working (back with the owner); with a question
 *      pending, `fix.question` is its words; a later clean sync of the same source and destination handles it, and a
 *      handled sync is refused;
 *   4. the session has ended: a Drive chat on the same workspace, its first message the same failure list saying so;
 *   5. no session ran the sync: a Drive chat on a workspace of the machine that ran it; `mode: 'retry'` asks for the
 *      failed files to be synced again and nothing more.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
const pub = (id: string) => uuidToBase62(id);

const FAILED = [
  { path: '0412/scan.tiff', error: 'file changed while reading' },
  { path: '0977/cover.png', error: 'permission denied' },
];

test('a failed sync handed to an agent: its own session when it can take a turn, else a new Drive chat', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const account = async (name: string) => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@drive-sync-fix.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');

  server = await startApiserver(url, `drive-sync-fix-${RUN}`, { DEEPSEEK_API_KEY: '' });
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, route, bearer, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const ownerToken = await signIn(owner);
  const strangerToken = await signIn(stranger);

  const register = async (bearer: string, name: string) => {
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `sync fix ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name });
    assert.equal(registered.status, 201, registered.text);
    const machine = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
    const beat = await api('POST', '/api/runner/heartbeat', machine.token, { status: 'ONLINE', engines: ENGINES },
      { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(beat.status < 300, true, beat.text);
    return machine;
  };
  const laptop = await register(ownerToken, `laptop-${RUN}`);
  const desktop = await register(ownerToken, `desktop-${RUN}`);
  const workspace = async (runnerId: string, name: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, enable_worktree) VALUES ($1, $2, $3, $4, $5, false)`,
      [id, name, owner.id, runnerId, `/srv/${name}`],
    );
    return id;
  };
  const wsLaptop = await workspace(laptop.runnerId, 'books');
  const wsDesktop = await workspace(desktop.runnerId, 'desktop');

  /** A session of the owner's, as `POST /api/sessions` makes one. */
  const session = async (workspaceId: string, title: string) => {
    const reply = await api('POST', '/api/sessions', ownerToken, { workspaceId: pub(workspaceId), prompt: `Sync ${title} into Drive.` });
    assert.ok(reply.status < 300, reply.text);
    const id = toUuid(reply.json.id as string);
    await sql.query(`UPDATE "session" SET "title" = $2 WHERE "id" = $1::uuid`, [id, title]);
    return id;
  };
  /** A sync the runner opens and ends as given. */
  const sync = async (machine: { token: string }, sourceName: string, destPath: string, end: Record<string, unknown> | null, sessionId?: string) => {
    const opened = await api('POST', '/api/runner/documents/syncs', machine.token, { sourceName, destPath, ...(sessionId ? { sessionId } : {}) });
    assert.ok(opened.status < 300, opened.text);
    const id = toUuid(opened.json.id as string);
    if (end) {
      const ended = await api('PATCH', `/api/runner/documents/syncs/${pub(id)}`, machine.token, end);
      assert.ok(ended.status < 300, ended.text);
    }
    return id;
  };
  const failing = { status: 'DONE', filesDone: 9, failed: FAILED, failedCount: 4 };
  const fix = (id: string, body: unknown = {}, bearer = ownerToken, headers?: Record<string, string>) =>
    api('POST', `/api/drive/syncs/${pub(id)}/fix`, bearer, body, headers);
  const row = async (id: string) => (await sql.query(`SELECT * FROM "drive_sync" WHERE "id" = $1::uuid`, [id])).rows[0];
  const view = async (id: string) => {
    const reply = await api('GET', `/api/drive/syncs/${pub(id)}`, ownerToken);
    assert.equal(reply.status, 200, reply.text);
    return reply.json;
  };
  const turnsOf = async (sessionId: string) =>
    (await sql.query(`SELECT * FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`, [sessionId])).rows;
  const code = (reply: Reply) => (reply.json as { code?: string } | null)?.code;

  const ranIt = await session(wsLaptop, '同步书格到 Orbit');
  const books = await sync(laptop, 'books-stage', '/Books', failing, ranIt);

  await t.test('1. refusals write nothing', async () => {
    const theirs = await fix(books, {}, strangerToken);
    assert.equal(theirs.status, 404, `another account's sync is not found: ${theirs.text}`);
    const acting = await fix(books, {}, ownerToken, { 'x-orbit-session-id': pub(ranIt) });
    assert.equal(acting.status, 403, `a session does not hand failures off: ${acting.text}`);
    assert.equal(code(acting), 'DRIVE_SYNC_FIX_OWNER_CHANNEL_ONLY');
    const badMode = await fix(books, { mode: 'later' });
    assert.equal(badMode.status, 400, badMode.text);

    const clean = await sync(laptop, 'clean', '/Clean', { status: 'DONE', filesDone: 3 }, ranIt);
    const unfailed = await fix(clean);
    assert.equal(unfailed.status, 409, unfailed.text);
    assert.equal(code(unfailed), 'DRIVE_SYNC_NOT_FAILED');
    const running = await sync(laptop, 'live', '/Live', null, ranIt);
    const busy = await fix(running);
    assert.equal(busy.status, 409, busy.text);
    assert.equal(code(busy), 'DRIVE_SYNC_RUNNING');

    for (const id of [books, clean, running]) {
      const r = await row(id);
      assert.deepEqual([r.fix_session_id, r.fix_requested_at], [null, null], 'nothing recorded');
    }
    assert.equal((await turnsOf(ranIt)).length, 0, 'no turn was sent (the opening prompt is filed with the first turn)');
    const before = await view(books);
    assert.deepEqual([before.session.id, before.session.title, before.session.open], [pub(ranIt), '同步书格到 Orbit', true], 'the session that ran it can take a turn');
    assert.equal(before.fix, null);
  });

  await t.test("2. its own session: a turn naming the sync and listing the failures; the row reads working", async () => {
    const answer = await fix(books);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.via, 'SESSION');
    assert.equal(answer.json.sessionId, pub(ranIt));
    const turns = await turnsOf(ranIt);
    assert.equal(turns.length, 2, 'the opening prompt, then the hand-off');
    const sent = turns[1];
    assert.equal(sent.kind, 'message');
    assert.equal(sent.send_intent, 'NEXT_TURN');
    assert.match(sent.content, /^Sync books-stage → \/Books · 4 failed/u);
    assert.match(sent.content, /4 files failed in this sync\. Find out why and fix them, then sync those files again:/u);
    assert.match(sent.content, /- 0412\/scan\.tiff: file changed while reading/u);
    assert.match(sent.content, /- 0977\/cover\.png: permission denied/u);
    assert.match(sent.content, /and 2 more not listed here/u);

    const r = await row(books);
    assert.equal(r.fix_session_id, ranIt);
    assert.ok(r.fix_requested_at instanceof Date);
    assert.equal(answer.json.sync.fixSessionId, pub(ranIt));
    assert.deepEqual(answer.json.sync.fix, { title: '同步书格到 Orbit', working: true, question: null }, 'working while its turn waits');
    assert.equal(answer.json.sync.handledAt, null);

    const again = await fix(books);
    assert.equal(again.status, 409, again.text);
    assert.equal(code(again), 'DRIVE_SYNC_FIX_WORKING');
    assert.equal((await turnsOf(ranIt)).length, 2, 'a second press sends nothing');
  });

  await t.test('3. the session stops: back with the owner, with its question if it asked one; a clean sync handles it', async () => {
    // The session's turns are over and it waits on nobody.
    await sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED' WHERE "session_id" = $1::uuid`, [ranIt]);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1::uuid`, [ranIt]);
    assert.deepEqual((await view(books)).fix, { title: '同步书格到 Orbit', working: false, question: null }, 'stopped: back to Needs you');

    await prisma.approval.create({
      data: {
        sessionId: ranIt, toolName: 'AskUserQuestion', status: 'PENDING',
        input: { questions: [{ question: '0977/cover.png is owned by root. Allow sudo?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      },
    });
    assert.deepEqual((await view(books)).fix, {
      title: '同步书格到 Orbit', working: false, question: '0977/cover.png is owned by root. Allow sudo?',
    }, 'the agent asked: its words');

    await sync(laptop, 'books-stage', '/Books', { status: 'DONE', filesDone: 4 }, ranIt);
    assert.ok((await view(books)).handledAt, 'a clean sync of the same source into the same place handles it');
    const handled = await fix(books);
    assert.equal(handled.status, 409, handled.text);
    assert.equal(code(handled), 'DRIVE_SYNC_HANDLED');
  });

  await t.test('4. the session has ended: a Drive chat on the same workspace with the failures', async () => {
    const ended = await session(wsLaptop, 'Export lab evidence');
    const exports = await sync(laptop, 'exports', '/Lab evidence', { status: 'DONE', failed: [FAILED[1]], failedCount: 1 }, ended);
    const end = await api('POST', `/api/sessions/${pub(ended)}/end`, ownerToken);
    assert.ok(end.status < 300, end.text);
    assert.equal((await view(exports)).session.open, false, 'the button reads Fix in a new chat');

    const answer = await fix(exports);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.via, 'NEW_CHAT');
    const chat = toUuid(answer.json.sessionId);
    assert.notEqual(chat, ended);
    const made = (await sql.query(`SELECT * FROM "session" WHERE "id" = $1::uuid`, [chat])).rows[0];
    assert.deepEqual([made.owner_id, made.opened_by, made.workspace_id], [owner.id, 'DRIVE_CHAT', wsLaptop], 'a Drive chat on the same workspace');
    const first = (await turnsOf(chat))[0];
    assert.match(first.content, /^Sync exports → \/Lab evidence · 1 failed/u);
    assert.match(first.content, /The session that ran this sync \(“Export lab evidence”\) has ended/u);
    assert.match(first.content, /- 0977\/cover\.png: permission denied/u);
    assert.equal((await turnsOf(ended)).filter((turn) => /Lab evidence/u.test(turn.content ?? '')).length, 0, 'nothing sent to the ended one');
    const r = await row(exports);
    assert.equal(r.fix_session_id, chat);
    assert.equal(answer.json.sync.fix.working, true);
  });

  await t.test("5. no session ran it: a Drive chat on that machine's workspace; retry asks for a plain resync", async () => {
    const orphan = await sync(desktop, 'scans', '/Scans', { status: 'FAILED', error: 'Disk gone', failed: [FAILED[0]], failedCount: 1 });
    assert.equal((await view(orphan)).session, null);
    const answer = await fix(orphan, { mode: 'retry' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.via, 'NEW_CHAT');
    const chat = toUuid(answer.json.sessionId);
    const made = (await sql.query(`SELECT "workspace_id" FROM "session" WHERE "id" = $1::uuid`, [chat])).rows[0];
    assert.equal(made.workspace_id, wsDesktop, 'the workspace of the machine that ran it');
    const first = (await turnsOf(chat))[0];
    assert.match(first.content, /No session ran this sync/u);
    assert.match(first.content, /1 file failed in this sync\. Sync those files again; nothing else needs changing:/u);
    assert.match(first.content, /The sync also stopped before it finished: Disk gone\./u);
  });

  // The web activity view's fixture (src/web/src/components/drive/__captured__/syncs.json): the owner's list as this
  // server sends it, with a failure for each of the view's states. Written only when DRIVE_SYNC_FIX_CAPTURE names a file.
  await t.test('6. the list as the activity view reads it, each hand-off state in it', async () => {
    const working = await session(wsLaptop, 'Sync the anime');
    const anime = await sync(laptop, 'anime-stage', '/Video', { status: 'DONE', failed: [{ path: 'ep3.mkv', error: 'file changed while reading' }], failedCount: 3 }, working);
    const asking = await session(wsLaptop, 'Sync the covers');
    const covers = await sync(laptop, 'covers-stage', '/Covers', { status: 'DONE', failed: [FAILED[1]], failedCount: 1 }, asking);
    for (const id of [anime, covers]) assert.equal((await fix(id)).status, 200);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1::uuid`, [asking]);
    await prisma.approval.create({
      data: { sessionId: asking, toolName: 'AskUserQuestion', status: 'PENDING', input: { questions: [{ question: '0977/cover.png is owned by root. Allow sudo?' }] } },
    });
    const own = await session(wsLaptop, 'Sync the books');
    await sync(laptop, 'books-stage', '/Books', failing, own);
    const gone = await session(wsLaptop, 'Sync the photos');
    await sync(laptop, 'photos-stage', '/Photos', { status: 'DONE', failed: [FAILED[1]], failedCount: 2 }, gone);
    assert.ok((await api('POST', `/api/sessions/${pub(gone)}/end`, ownerToken)).status < 300);
    const list = await api('GET', '/api/drive/syncs', ownerToken);
    assert.equal(list.status, 200, list.text);
    const byName = (name: string) => (list.json.syncs as Array<Record<string, any>>).filter((s) => s.sourceName === name)[0]!;
    assert.deepEqual([byName('books-stage').session.open, byName('books-stage').fix], [true, null], 'Have the agent fix it');
    assert.deepEqual([byName('photos-stage').session.open, byName('photos-stage').fix], [false, null], 'Fix in a new chat');
    assert.deepEqual([byName('exports').session.open, byName('exports').fix.working], [false, true], 'its session ended; a chat is on it');
    assert.equal(byName('anime-stage').fix.working, true, 'Agents working on it');
    assert.deepEqual(byName('covers-stage').fix, { title: 'Sync the covers', working: false, question: '0977/cover.png is owned by root. Allow sudo?' });
    const capture = process.env.DRIVE_SYNC_FIX_CAPTURE;
    if (capture) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(capture, `${JSON.stringify(list.json, null, 2)}\n`);
    }
  });
});
