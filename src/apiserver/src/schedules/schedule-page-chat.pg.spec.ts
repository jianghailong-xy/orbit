/**
 * The Scheduled page's chat, server side (schedules/schedule-page-chat.ts; migrations 1740–1741;
 * docs/scheduled-chat-design.md §4.1, §4.3, §7, §10 step 1; board docs/mocks/scheduled-chat/), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-page-chat.pg.spec.ts
 *
 *   1. the opening: `GET /api/schedules/chat` answers no session and Orbit's opening — on an empty account the empty
 *      wording; then the counts of the schedules that have not ended (active, paused, held, failing), the soonest next
 *      run with its workspace, the static examples and the envelope sentence — and writes nothing: no session, no turn,
 *      so no engine can start;
 *   2. open: `POST /api/schedules/chat {text, workspaceId}` opens an ordinary MANUAL session of that workspace whose
 *      prompt is the person's words, marked by `schedule_chat_at` (no new run source); GET then names it;
 *   3. re-open: a second POST for that workspace says the words in the open chat and answers `created: false`; another
 *      workspace gets a chat of its own; a completed chat is not reused;
 *   4. the marker column is written once: a later UPDATE of `schedule_chat_at` is refused by 1740's guard;
 *   5. the list tag: the chat's detail and its row in its workspace's session list read `chatOrigin: SCHEDULE_CHAT`
 *      ("From Scheduled"); an ordinary session of the same workspace reads null;
 *   6. owner channel only: either door with an acting session is refused SCHEDULE_CHAT_FROM_SESSION; another account's
 *      workspace and empty words are refused; none of them makes anything.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { SCHEDULE_PAGE_CHAT_COPY, sessionOriginTag, toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { schedulePageChatOpeningOf } from './schedule-page-chat';
import { SchedulesService } from './schedules.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];
const CAPABILITIES = 'source-pin/v1';
const pub = (id: string) => uuidToBase62(id);
const T = SCHEDULE_PAGE_CHAT_COPY;

test('the Scheduled page chat: an opening that writes nothing, a marked MANUAL session, re-open, From Scheduled in the list', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
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
    const email = `${name}-${RUN}@schedule-page-chat.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [id, email, name, hashPassword(password)]);
    return { id, email, password };
  };
  const owner = await account('owner');
  const stranger = await account('stranger');

  server = await startApiserver(url, `schedule-page-chat-${randomUUID()}`, { DEEPSEEK_API_KEY: '' });
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
    const minted = await api('POST', '/api/runners/enrollment-tokens', bearer, { label: `page chat ${RUN}` });
    assert.equal(minted.status, 201, minted.text);
    const registered = await api('POST', '/api/runner/register', undefined, { enrollmentToken: minted.json.token, name, hostname: name });
    assert.equal(registered.status, 201, registered.text);
    const machine = { runnerId: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
    const beat = await api('POST', '/api/runner/heartbeat', machine.token, { status: 'ONLINE', engines: ENGINES },
      { 'x-orbit-runner-capabilities': CAPABILITIES });
    assert.equal(beat.status < 300, true, beat.text);
    return machine;
  };
  const ws01 = await register(ownerToken, `orbit-ws01-${RUN}`);
  const theirs = await register(strangerToken, `theirs-${RUN}`);
  const workspace = async (ownerId: string, runnerId: string, name: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "workspace" (id, name, owner_id, runner_id, work_dir, enable_worktree) VALUES ($1, $2, $3, $4, $5, false)`,
      [id, name, ownerId, runnerId, `/srv/${name}`],
    );
    return id;
  };
  const wsA = await workspace(owner.id, ws01.runnerId, 'orbit-ws01');
  const wsB = await workspace(owner.id, ws01.runnerId, 'orbit-ws04');
  const wsStranger = await workspace(stranger.id, theirs.runnerId, 'theirs');

  const chat = '/api/schedules/chat';
  const read = (bearer = ownerToken, headers?: Record<string, string>) => api('GET', chat, bearer, undefined, headers);
  const open = (body: Record<string, unknown>, bearer = ownerToken, headers?: Record<string, string>) =>
    api('POST', chat, bearer, body, headers);
  const writes = async (ownerId: string) => (await sql.query(
    `SELECT (SELECT count(*)::int FROM "session" WHERE "owner_id" = $1::uuid) AS sessions,
            (SELECT count(*)::int FROM "conversation_turn" t JOIN "session" s ON s."id" = t."session_id"
              WHERE s."owner_id" = $1::uuid) AS turns`, [ownerId])).rows[0] as { sessions: number; turns: number };
  const sessionRow = async (id: string) => (await sql.query(`SELECT * FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0];
  const turnsOf = async (sessionId: string) =>
    (await sql.query(`SELECT "content" FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`, [sessionId])).rows
      .map((r) => r.content as string);

  let chatA = '';

  await t.test('1. the opening on an empty account: no session, the empty wording, nothing written', async () => {
    const before = await writes(owner.id);
    const reply = await read();
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.sessionId, null);
    assert.deepEqual(reply.json.opening, {
      counts: { total: 0, active: 0, paused: 0, held: 0, failing: 0 },
      next: null,
      summary: 'You have no scheduled tasks yet.',
      nextText: null,
      examplesLead: "Say what should happen and when, and I'll set it up. For example:",
      examples: [
        "Every weekday at 09:00, check a changelog and tell me what's new",
        'Every hour until 18:00, watch the deploy and tell me if it fails',
      ],
      closing: 'Nothing runs until you say something.',
    });
    assert.deepEqual(await writes(owner.id), before, 'GET writes no session and no turn, so no engine starts');
  });

  await t.test('1. the opening counts the schedules that have not ended and names the soonest next run', async () => {
    const schedules = new SchedulesService(prisma as unknown as PrismaService);
    const make = async (title: string, workspaceId: string) => {
      const made = await schedules.create({ kind: 'OWNER', ownerId: owner.id }, {
        workspaceId, intent: 'check it', title, prompt: 'Check the latest stable release.',
        rule: { kind: 'DAILY', time: '06:00' }, timezone: 'Asia/Shanghai', accessLevel: 'CHECK_ONLY',
      });
      assert.equal(made.outcome, 'CREATED');
      if (made.outcome !== 'CREATED') throw new Error('not created');
      return made.schedule.id;
    };
    const bump = await make('Engine version bump', wsA);
    const docs = await make('Docs link check', wsB);
    const paused = await make('Paused one', wsA);
    const held = await make('Held one', wsA);
    const ended = await make('Ended one', wsA);
    await make('Paused two', wsB).then((id) => sql.query(`UPDATE "schedule" SET "state" = 'PAUSED', "next_due_at" = NULL WHERE "id" = $1::uuid`, [id]));
    await sql.query(`UPDATE "schedule" SET "state" = 'PAUSED', "next_due_at" = NULL WHERE "id" = $1::uuid`, [paused]);
    await sql.query(`UPDATE "schedule" SET "state" = 'HELD', "held_reason" = 'spec', "next_due_at" = NULL WHERE "id" = $1::uuid`, [held]);
    await sql.query(`UPDATE "schedule" SET "state" = 'ENDED', "ended_reason" = 'DELETED', "ended_at" = now(), "next_due_at" = NULL WHERE "id" = $1::uuid`, [ended]);
    // Tomorrow 06:00 in Shanghai is the soonest; the failing one runs later.
    await sql.query(`UPDATE "schedule" SET "next_due_at" = '2026-11-28T22:00:00Z' WHERE "id" = $1::uuid`, [bump]);
    await sql.query(`UPDATE "schedule" SET "next_due_at" = '2026-11-30T22:00:00Z', "consecutive_failures" = 2 WHERE "id" = $1::uuid`, [docs]);

    const now = new Date('2026-11-28T04:00:00Z');
    const opening = await schedulePageChatOpeningOf(prisma as never, owner.id, now);
    assert.deepEqual(opening.counts, { total: 5, active: 2, paused: 2, held: 1, failing: 1 }, 'the ENDED one is not counted');
    assert.equal(opening.summary, 'You have 5 scheduled tasks: 2 active, 2 paused, 1 held, 1 failing.');
    assert.deepEqual([opening.next?.scheduleId, opening.next?.workspaceName, opening.next?.at], [bump, 'orbit-ws01', '2026-11-28T22:00:00.000Z']);
    assert.equal(opening.nextText, 'Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.');
    assert.equal(opening.examplesLead, 'Ask about them, or tell me what to change. For example:');
    assert.deepEqual(opening.examples, [...T.examples]);
    assert.equal(opening.closing,
      'Moving a time, rewording what a task checks or how it reports applies at once, and you can undo it. More runs, '
      + 'longer runs, more access or another workspace need your Allow.');

    const before = await writes(owner.id);
    const reply = await read();
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.sessionId, null);
    assert.deepEqual(reply.json.opening.counts, opening.counts);
    assert.equal(toUuid(reply.json.opening.next.scheduleId), bump);
    assert.match(reply.json.opening.nextText, /^Next: Engine version bump, .* at 06:00 on orbit-ws01\.$/u);
    assert.deepEqual(await writes(owner.id), before, 'still nothing written: the opening is drawn, not stored');
    assert.equal((await read(strangerToken)).json.opening.counts.total, 0, "another account's schedules are not counted");
  });

  await t.test('2. open: an ordinary MANUAL session of the workspace, marked by schedule_chat_at, the words its prompt', async () => {
    const words = 'Pause everything on orbit-ws04 until Monday';
    const reply = await open({ workspaceId: pub(wsA), text: `  ${words}  ` });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.created, true);
    chatA = toUuid(reply.json.sessionId);
    const row = await sessionRow(chatA);
    assert.deepEqual(
      [row.workspace_id, row.run_source, row.prompt, row.opened_by, row.change_schedule_id, row.wiki_chat_space_id],
      [wsA, 'MANUAL', words, 'PERSON', null, null],
      'an ordinary session the person opened, of the named workspace',
    );
    assert.ok(row.schedule_chat_at instanceof Date, 'marked as the page chat in its own INSERT');
    const enumValues = (await sql.query(`SELECT unnest(enum_range(NULL::"session_run_source"))::text AS v`)).rows.map((r) => r.v);
    assert.equal(enumValues.some((v: string) => /CHAT/u.test(v)), false, `no run source for it: ${enumValues.join(', ')}`);
    assert.equal(toUuid((await read()).json.sessionId), chatA, 'GET names the open chat');
  });

  await t.test('3. re-open: the words go to the open chat; another workspace gets its own; a completed one is not reused', async () => {
    const again = await open({ workspaceId: pub(wsA), text: 'Why did the last run take so long?' });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([toUuid(again.json.sessionId), again.json.created], [chatA, false]);
    assert.ok((await turnsOf(chatA)).includes('Why did the last run take so long?'), 'said in the open chat');
    assert.equal(Number((await sql.query(
      `SELECT count(*)::int AS n FROM "session" WHERE "owner_id" = $1::uuid AND "schedule_chat_at" IS NOT NULL`, [owner.id])).rows[0].n), 1);

    const other = await open({ workspaceId: pub(wsB), text: 'What runs tomorrow?' });
    assert.equal(other.status, 200, other.text);
    assert.equal(other.json.created, true);
    const chatB = toUuid(other.json.sessionId);
    assert.notEqual(chatB, chatA);
    assert.equal((await sessionRow(chatB)).workspace_id, wsB);
    assert.equal(toUuid((await read()).json.sessionId), chatB, 'GET names the newest open chat');

    await sql.query(`UPDATE "session" SET "completed_at" = now() WHERE "id" = $1::uuid`, [chatB]);
    assert.equal(toUuid((await read()).json.sessionId), chatA, 'a completed chat is not the open one');
    const fresh = await open({ workspaceId: pub(wsB), text: 'Start over' });
    assert.equal(fresh.json.created, true, 'a completed chat is not reused');
    assert.notEqual(toUuid(fresh.json.sessionId), chatB);
  });

  await t.test('4. the marker column is written once: 1740 refuses a later change of it', async () => {
    await assert.rejects(
      sql.query(`UPDATE "session" SET "schedule_chat_at" = NULL WHERE "id" = $1::uuid`, [chatA]),
      /SCHEDULE_CHAT_IMMUTABLE/u,
    );
    const plain = await api('POST', '/api/sessions', ownerToken, { workspaceId: pub(wsA), prompt: 'an ordinary one' });
    assert.equal(plain.status, 201, plain.text);
    await assert.rejects(
      sql.query(`UPDATE "session" SET "schedule_chat_at" = now() WHERE "id" = $1::uuid`, [toUuid(plain.json.id)]),
      /SCHEDULE_CHAT_IMMUTABLE/u,
      'nor is an ordinary session made one later',
    );
  });

  await t.test('5. the list tag: the detail and the workspace list row read SCHEDULE_CHAT, From Scheduled', async () => {
    const detail = await api('GET', `/api/sessions/${pub(chatA)}`, ownerToken);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.chatOrigin, 'SCHEDULE_CHAT');
    assert.equal(sessionOriginTag(detail.json.chatOrigin), 'From Scheduled');
    assert.equal(detail.json.runSource, 'MANUAL');

    const list = await api('GET', `/api/sessions?workspaceId=${pub(wsA)}`, ownerToken);
    assert.equal(list.status, 200, list.text);
    const listed = Array.isArray(list.json) ? list.json : list.json.items ?? list.json.sessions;
    const row = listed.find((r: { id: string }) => r.id === pub(chatA));
    assert.ok(row, `the chat is listed in its workspace: ${list.text.slice(0, 300)}`);
    assert.equal(row.chatOrigin, 'SCHEDULE_CHAT');
    assert.equal(sessionOriginTag(row.chatOrigin), 'From Scheduled', 'the row tag reads From Scheduled');
    const ordinary = listed.find((r: { id: string; chatOrigin: string | null }) => r.id !== pub(chatA) && r.chatOrigin === null);
    assert.ok(ordinary, 'an ordinary session of the workspace carries no origin');
  });

  await t.test('6. owner channel only, the owner\'s workspaces only, words required: each refused, nothing made', async () => {
    const before = await writes(owner.id);
    const strangerBefore = await writes(stranger.id);
    const acting = { 'x-orbit-session-id': pub(chatA) };
    const refusals: Array<[string, Reply, number, string?]> = [
      ['GET with an acting session', await read(ownerToken, acting), 403, 'SCHEDULE_CHAT_FROM_SESSION'],
      ['POST with an acting session', await open({ workspaceId: pub(wsA), text: 'pause it' }, ownerToken, acting), 403, 'SCHEDULE_CHAT_FROM_SESSION'],
      ["another account's workspace", await open({ workspaceId: pub(wsStranger), text: 'pause it' }), 403],
      ['empty words', await open({ workspaceId: pub(wsA), text: '   ' }), 400],
      ['no workspace', await open({ text: 'pause it' }), 400],
    ];
    for (const [what, reply, status, code] of refusals) {
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      if (code) assert.equal(reply.json.code, code, what);
    }
    assert.deepEqual(await writes(owner.id), before, 'no session and no turn for the owner');
    assert.deepEqual(await writes(stranger.id), strangerBefore, 'nor in the other account');
  });
});
