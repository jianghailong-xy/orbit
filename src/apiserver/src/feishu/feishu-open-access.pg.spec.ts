/**
 * Who can use the Feishu bot (docs/feishu-bot-design.md §14; task O1), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty and the production apiserver (`build/main.js`). The app is switched off,
 * so no long connection is made and nothing but the requests below writes. Every table carries the write trap of the
 * tenant isolation census (auth/tenant-isolation-fixtures.ts), so "writes nothing" is read off the database itself.
 *
 *   (1) a feishu_app made with only what a save writes, or by a bare INSERT as an app saved before migration 1140 reads,
 *       is Only you (OWNER_ONLY) with no workspace, Auto, and the limits 1 / 10 / 3 / 50 — over GET as well;
 *   (2) a personal access token is refused the access save 403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED, and nothing is
 *       written;
 *   (3) the save's checks, each writing nothing: another account's workspace (404), a mode that is not one (400), a
 *       permission mode that is not one (400), a limit of 0 or not whole (400), and opening with no workspace (400
 *       FEISHU_OPEN_WORKSPACE_REQUIRED);
 *   (4) a login saves: the row holds what was sent and GET reads it back; a field left out keeps what was saved;
 *   (5) reserveOpenSlot (§14.4): each of the four limits refuses with its limit and its sentence and writes no chain;
 *       the same request reserved twice holds one slot; the owner's chains and a connected group's topics never count;
 *       an app that is not open answers NOT_OPEN;
 *   (6) the Groups list answers a group using the app's settings with its source, who used it first and when, and the
 *       sessions started from it today; it is switched off on its own (and only switched), connecting it makes it
 *       CONNECT, and the bot removed from it switches it off as BOT_REMOVED;
 *   (7) replacing the app with another one keeps the settings of others' sessions and starts as Only you.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-open-access.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { type PrismaClient, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FeishuChatRouteService, hashChatTicket } from './feishu-chat-route.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FEISHU_OPEN_REPLIES, openSlotStarted, reserveOpenSlot, type FeishuOpenRequest, type FeishuOpenSlot } from './feishu-open-limits';
import type { FeishuOutbound } from './feishu-outbound';
import { FakeOpenPlatform } from './test-support/fake-open-platform';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-open-access-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');
const DEFAULTS = { mode: 'OWNER_ONLY', workspaceId: null, permissionMode: 'auto', maxRunningPerPerson: 1, sessionsPerDayPerPerson: 10, maxRunningTotal: 3, sessionsPerDayTotal: 50 };

type Row = Record<string, unknown>;
const pick = (row: Row, keys: string[]): Row => Object.fromEntries(keys.map((k) => [k, row[k]]));

test('Feishu: who can use the bot is saved only through the owner channel, and the open bot counts its sessions', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const Y = { platform: 'FEISHU' as const, appId: `cli_y_${RUN}`, appSecret: `secret-${randomUUID()}`, botName: 'Another bot' };
  fake.addApp(Y);
  const fakeUrl = await fake.start();

  const person = async (name: string) => {
    const id = randomUUID();
    const email = `feishu-open-${name}-${RUN}@feishu-open-access.invalid`;
    await db.user.create({ data: { id, email, name, passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: id, name: `${name} runner`, tokenHash: `feishu-open-${runnerId}` } });
    await db.workspace.create({ data: { id: workspaceId, ownerId: id, runnerId, name: `${name} ${RUN}`, enabled: true } });
    return { id, email, runnerId, workspaceId };
  };
  const owner = await person('owner');
  const other = await person('other');
  const appId = `cli_open_${RUN}`;
  // Only what FeishuAppService.save writes for a new app; switched off, so no replica connects it.
  await db.feishuApp.create({
    data: { ownerId: owner.id, platform: 'FEISHU', appId, appSecretEnc: encryptSecret(`secret-${RUN}`), enabled: false, ownerOpenId: 'ou_owner', botName: 'Orbitd' },
  });

  const token = (await new PatService(db as unknown as PrismaService).issue(owner.id, {
    name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
  })).token;
  const jwtSecret = `feishu-open-access-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: owner.id, email: owner.email });
  server = await startApiserver(url, jwtSecret, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> => call(server!, method, `/api${path}`, bearer, body);

  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const writesSince = async (since: bigint): Promise<string[]> =>
    (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows.map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  const appRow = async (): Promise<Row> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a WHERE app_id = $1`, [appId])).rows[0].r;
  /** The access settings as answered, by the fields §14.1 names (the codec adds its own public-id siblings). */
  const accessOf = (reply: Reply) => {
    const access = pick(reply.json.app.access, Object.keys(DEFAULTS));
    if (access.workspaceId) access.workspaceId = toUuid(access.workspaceId as string);
    return access;
  };

  await t.test('(1) a new app, and one saved before 1140, is Only you with the default settings', async () => {
    const row = await db.feishuApp.findUniqueOrThrow({ where: { appId } });
    assert.deepEqual(
      [row.accessMode, row.openWorkspaceId, row.openPermissionMode, row.openMaxRunningPerPerson, row.openSessionsPerDayPerPerson,
        row.openMaxRunningTotal, row.openSessionsPerDayTotal],
      ['OWNER_ONLY', null, 'auto', 1, 10, 3, 50],
    );
    const read = await api('GET', '/integrations/feishu', login);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(accessOf(read), DEFAULTS);
    // A row as the columns' defaults give it to an app saved before the migration: no access column named.
    const bare = (await sql.query(
      `INSERT INTO feishu_app (id, owner_id, platform, app_id, app_secret_enc, enabled) VALUES ($1, $2, 'FEISHU', $3, 'x:y:z', false)
       RETURNING access_mode, open_workspace_id, open_permission_mode, open_max_running_per_person, open_sessions_per_day_per_person,
                 open_max_running_total, open_sessions_per_day_total`,
      [randomUUID(), other.id, `cli_bare_${RUN}`],
    )).rows[0];
    assert.deepEqual(bare, {
      access_mode: 'OWNER_ONLY', open_workspace_id: null, open_permission_mode: 'auto', open_max_running_per_person: 1,
      open_sessions_per_day_per_person: 10, open_max_running_total: 3, open_sessions_per_day_total: 50,
    });
    await sql.query(`DELETE FROM feishu_app WHERE app_id = $1`, [`cli_bare_${RUN}`]);
  });

  const opening = { mode: 'AVAILABILITY_SCOPE', workspaceId: owner.workspaceId, permissionMode: 'auto', maxRunningPerPerson: 2, sessionsPerDayPerPerson: 8, maxRunningTotal: 4, sessionsPerDayTotal: 30 };

  await t.test('(2) a personal access token is refused the save, and nothing is written', async () => {
    const before = await appRow();
    const since = await mark();
    const reply = await api('PUT', '/integrations/feishu/access', token, opening);
    assert.equal(reply.status, 403, reply.text);
    assert.equal(reply.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    assert.equal(reply.json.requiredAction, 'OPEN_ORBIT');
    // The refusal's own record, written after the answer: the token's last use and the `pat.request.denied` audit row.
    // Nothing else, and nothing of the app.
    const deadline = Date.now() + 10_000;
    let writes = await writesSince(since);
    while (!writes.some((w) => w.startsWith('INSERT activity') && w.includes('"pat.request.denied"')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writes = await writesSince(since);
    }
    const ownRecord = (w: string) => w.startsWith('UPDATE personal_access_token ')
      || (w.startsWith('INSERT activity ') && w.includes('"pat.request.denied"') && w.includes('"/integrations/feishu/access"'));
    assert.ok(writes.some(ownRecord), 'the refusal was audited');
    assert.deepEqual(writes.filter((w) => !ownRecord(w)), []);
    assert.deepEqual(await appRow(), before);
  });

  await t.test('(3) each check of the save refuses and writes nothing', async () => {
    const before = await appRow();
    const cases: Array<[string, unknown, number, string?]> = [
      ["another account's workspace", { ...opening, workspaceId: other.workspaceId }, 404],
      ['a workspace that does not exist', { ...opening, workspaceId: randomUUID() }, 404],
      ['a mode that is not one', { ...opening, mode: 'EVERYONE' }, 400],
      ['no mode', { workspaceId: owner.workspaceId }, 400],
      ['a permission mode that is not one', { ...opening, permissionMode: 'yolo' }, 400],
      ['a limit of 0', { ...opening, maxRunningPerPerson: 0 }, 400],
      ['a negative limit', { ...opening, sessionsPerDayTotal: -3 }, 400],
      ['a limit that is not whole', { ...opening, maxRunningTotal: 1.5 }, 400],
      ['a limit that is not a number', { ...opening, sessionsPerDayPerPerson: '10' }, 400],
      ['opening with no workspace', { mode: 'AVAILABILITY_SCOPE' }, 400, 'FEISHU_OPEN_WORKSPACE_REQUIRED'],
      ['opening with the workspace cleared', { mode: 'AVAILABILITY_SCOPE', workspaceId: null }, 400, 'FEISHU_OPEN_WORKSPACE_REQUIRED'],
    ];
    for (const [what, body, status, code] of cases) {
      const since = await mark();
      const reply = await api('PUT', '/integrations/feishu/access', login, body);
      assert.equal(reply.status, status, `${what}: ${reply.text}`);
      if (code) assert.equal(reply.json.code, code, what);
      assert.deepEqual(await writesSince(since), [], what);
    }
    assert.deepEqual(await appRow(), before);
  });

  await t.test('(4) a login saves, GET reads it back, and a field left out keeps what was saved', async () => {
    const saved = await api('PUT', '/integrations/feishu/access', login, opening);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(accessOf(saved), opening);
    assert.deepEqual(accessOf(await api('GET', '/integrations/feishu', login)), opening);
    const closed = await api('PUT', '/integrations/feishu/access', login, { mode: 'OWNER_ONLY' });
    assert.equal(closed.status, 200, closed.text);
    assert.deepEqual(accessOf(closed), { ...opening, mode: 'OWNER_ONLY' });
    // Opening again needs no workspace in the body: the saved one is live.
    const reopened = await api('PUT', '/integrations/feishu/access', login, { mode: 'AVAILABILITY_SCOPE' });
    assert.equal(reopened.status, 200, reopened.text);
    assert.deepEqual(accessOf(reopened), opening);
  });

  // ── (5) the limits ───────────────────────────────────────────────────────────────────────────
  let n = 0;
  const request = (openId: string, chatId = `oc_p2p_${openId}_${RUN}`): FeishuOpenRequest => {
    n += 1;
    return { appId, ownerId: owner.id, chatId, rootMessageId: `om_${n}_${RUN}`, sessionId: randomUUID(), openId };
  };
  const reserve = (req: FeishuOpenRequest): Promise<FeishuOpenSlot> => db.$transaction((tx) => reserveOpenSlot(tx, req));
  const session = async (id: string, status: RunStatus) => {
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId: owner.workspaceId, assignedRunnerId: owner.runnerId, title: `open ${id.slice(0, 8)}`,
        prompt: 'the work', provider: 'claude', turnState: turnStateOfWord(status), dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
        ...(status === RunStatus.SUCCEEDED || status === RunStatus.FAILED
          ? { finishedAt: new Date()}
          : status === RunStatus.CANCELLED ? { finishedAt: new Date()} : {}),
      },
    });
  };
  /** A request that passes, and its session made in `status`. */
  const started = async (openId: string, status: RunStatus, chatId?: string) => {
    const req = request(openId, chatId);
    assert.deepEqual(await reserve(req), { ok: true }, `${openId}'s request passes`);
    await session(req.sessionId, status);
    assert.equal(await db.$transaction((tx) => openSlotStarted(tx, req)), true);
    return req;
  };
  const threads = () => db.feishuThread.count({ where: { appId } });
  const limits = (l: { perRun: number; perDay: number; allRun: number; allDay: number }) =>
    db.feishuApp.update({
      where: { appId },
      data: { openMaxRunningPerPerson: l.perRun, openSessionsPerDayPerPerson: l.perDay, openMaxRunningTotal: l.allRun, openSessionsPerDayTotal: l.allDay },
    });
  /** A refused request writes no chain, and nothing at all. */
  const refusedAs = async (openId: string, expected: FeishuOpenSlot, chatId?: string) => {
    const before = await threads();
    const since = await mark();
    assert.deepEqual(await reserve(request(openId, chatId)), expected);
    assert.equal(await threads(), before);
    // The app row's lock is a SELECT … FOR UPDATE: no write.
    assert.deepEqual(await writesSince(since), []);
  };

  await t.test('(5a) one person at a time: a session running, or one still being made, holds their slot', async () => {
    await limits({ perRun: 1, perDay: 10, allRun: 3, allDay: 50 });
    const first = request('ou_bob');
    assert.deepEqual(await reserve(first), { ok: true });
    // Not made yet: the reservation holds the slot.
    await refusedAs('ou_bob', { ok: false, limit: 'PERSON_RUNNING', max: 1, words: FEISHU_OPEN_REPLIES.personRunning(1) });
    // The same request handled again passes as it is, and holds one slot.
    const before = await threads();
    assert.deepEqual(await reserve(first), { ok: true });
    assert.equal(await threads(), before);
    await session(first.sessionId, RunStatus.RUNNING);
    assert.equal(await db.$transaction((tx) => openSlotStarted(tx, first)), true);
    assert.equal(await db.$transaction((tx) => openSlotStarted(tx, first)), false, 'stamped once');
    // Running, in a group this time: direct messages and groups count together.
    await refusedAs('ou_bob', { ok: false, limit: 'PERSON_RUNNING', max: 1, words: FEISHU_OPEN_REPLIES.personRunning(1) }, `oc_group_${RUN}`);
    assert.equal(
      FEISHU_OPEN_REPLIES.personRunning(1),
      'You already have a session running. Wait for it to finish, then send this again.',
    );
    // Waiting for its next message, it holds none.
    await db.session.update({ where: { id: first.sessionId }, data: { turnState: null } });
    await started('ou_bob', RunStatus.PENDING);
    await limits({ perRun: 2, perDay: 10, allRun: 3, allDay: 50 });
    await started('ou_bob', RunStatus.RUNNING);
    await refusedAs('ou_bob', { ok: false, limit: 'PERSON_RUNNING', max: 2, words: FEISHU_OPEN_REPLIES.personRunning(2) });
    assert.equal(FEISHU_OPEN_REPLIES.personRunning(2), 'You already have 2 sessions running. Wait for one to finish, then send this again.');
    await db.session.updateMany({ where: { ownerId: owner.id }, data: { turnState: null } });
  });

  await t.test('(5b) one person a day: sessions started since midnight UTC, running or not', async () => {
    await limits({ perRun: 5, perDay: 2, allRun: 10, allDay: 50 });
    await started('ou_carol', RunStatus.AWAITING_INPUT);
    // A chain from yesterday does not count today.
    const yesterday = await started('ou_carol', RunStatus.SUCCEEDED);
    await db.feishuThread.updateMany({ where: { appId, rootMessageId: yesterday.rootMessageId }, data: { createdAt: new Date(Date.now() - 36 * 3600_000) } });
    await started('ou_carol', RunStatus.SUCCEEDED);
    await refusedAs('ou_carol', { ok: false, limit: 'PERSON_DAILY', max: 2, words: FEISHU_OPEN_REPLIES.personDaily(2) });
    assert.equal(FEISHU_OPEN_REPLIES.personDaily(2), "You've started 2 sessions today, the most this bot allows one person. Try again after midnight UTC.");
    // Someone else is not held by Carol's day.
    await started('ou_dave', RunStatus.AWAITING_INPUT);
  });

  await t.test('(5c) everyone at a time, and the owner and connected groups never count', async () => {
    await limits({ perRun: 1, perDay: 10, allRun: 2, allDay: 50 });
    // The owner's own chain and a connected group's topic, both with running sessions: not open-access chains.
    for (const chat of [`oc_owner_p2p_${RUN}`, `oc_connected_${RUN}`]) {
      const id = randomUUID();
      await session(id, RunStatus.RUNNING);
      await db.feishuThread.create({ data: { ownerId: owner.id, appId, chatId: chat, rootMessageId: `om_not_open_${chat}`, sessionId: id } });
    }
    await started('ou_erin', RunStatus.RUNNING);
    await started('ou_frank', RunStatus.RUNNING, `oc_group_${RUN}`);
    await refusedAs('ou_grace', { ok: false, limit: 'TOTAL_RUNNING', max: 2, words: FEISHU_OPEN_REPLIES.totalRunning(2) });
    assert.equal(FEISHU_OPEN_REPLIES.totalRunning(2), 'This bot is already running 2 sessions, the most it allows at a time. Try again when one finishes.');
    await db.session.updateMany({ where: { ownerId: owner.id }, data: { turnState: null, finishedAt: null} });
  });

  await t.test('(5d) everyone a day', async () => {
    const today = await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feishu_thread WHERE app_id = $1 AND open_access_open_id IS NOT NULL
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [appId]);
    const max = today.rows[0].n;
    await limits({ perRun: 5, perDay: 10, allRun: 10, allDay: max });
    await refusedAs('ou_heidi', { ok: false, limit: 'TOTAL_DAILY', max, words: FEISHU_OPEN_REPLIES.totalDaily(max) });
    assert.equal(FEISHU_OPEN_REPLIES.totalDaily(50), 'This bot has started 50 sessions today, the most it allows in a day. Try again after midnight UTC.');
    await limits({ perRun: 5, perDay: 10, allRun: 10, allDay: max + 1 });
    await started('ou_heidi', RunStatus.AWAITING_INPUT);
  });

  await t.test('(5e) an app that is not open holds no slot', async () => {
    await db.feishuApp.update({ where: { appId }, data: { accessMode: 'OWNER_ONLY' } });
    await refusedAs('ou_ivan', { ok: false, limit: 'NOT_OPEN' });
    await db.feishuApp.update({ where: { appId }, data: { accessMode: 'AVAILABILITY_SCOPE' } });
    await db.workspace.update({ where: { id: owner.workspaceId }, data: { deletedAt: new Date() } });
    await refusedAs('ou_ivan', { ok: false, limit: 'NOT_OPEN' });
    await db.workspace.update({ where: { id: owner.workspaceId }, data: { deletedAt: null } });
  });

  // ── (6) the Groups list ──────────────────────────────────────────────────────────────────────
  await t.test('(6) a group using the app\'s settings is listed with who used it first and today\'s sessions, and is switched on its own', async () => {
    await limits({ perRun: 5, perDay: 10, allRun: 10, allDay: 1000 });
    const implicitChat = `oc_implicit_${RUN}`;
    const firstUsedAt = new Date(Date.now() - 3600_000);
    const implicit = await db.feishuChatRoute.create({
      data: {
        ownerId: owner.id, appId, chatId: implicitChat, chatName: 'Orbit test', source: 'OPEN_ACCESS', enabled: true,
        firstUsedByOpenId: 'ou_li_wei', firstUsedByName: 'Li Wei', firstUsedAt,
      },
    });
    const connected = await db.feishuChatRoute.create({
      data: { ownerId: owner.id, appId, chatId: `oc_connected_${RUN}`, chatName: 'Platform team', workspaceId: owner.workspaceId, permissionMode: 'default', enabled: true, confirmedAt: new Date() },
    });
    // Two sessions today, one still being made (not counted), and one yesterday (not counted).
    await started('ou_li_wei', RunStatus.AWAITING_INPUT, implicitChat);
    await started('ou_zhao_min', RunStatus.AWAITING_INPUT, implicitChat);
    assert.deepEqual(await reserve(request('ou_kim', implicitChat)), { ok: true });
    const old = await started('ou_li_wei', RunStatus.SUCCEEDED, implicitChat);
    await db.feishuThread.updateMany({ where: { appId, rootMessageId: old.rootMessageId }, data: { createdAt: new Date(Date.now() - 36 * 3600_000) } });
    // A connect still waiting is not listed, as before.
    await db.feishuChatRoute.create({
      data: { ownerId: owner.id, appId, chatId: `oc_waiting_${RUN}`, ticketHash: hashChatTicket(`t-${RUN}`), ticketOpenId: 'ou_owner', ticketEventId: `ev-${RUN}`, ticketExpiresAt: new Date(Date.now() + 600_000) },
    });

    const listed = await api('GET', '/integrations/feishu/chats', login);
    assert.equal(listed.status, 200, listed.text);
    const routes = listed.json.routes as Array<Record<string, unknown>>;
    assert.deepEqual(routes.map((r) => r.chatId), [`oc_connected_${RUN}`, implicitChat]);
    const row = routes.find((r) => r.chatId === implicitChat)!;
    assert.equal(toUuid(row.id as string), implicit.id);
    const expected = {
      chatId: implicitChat, chatName: 'Orbit test', source: 'OPEN_ACCESS', firstUsedByOpenId: 'ou_li_wei', firstUsedByName: 'Li Wei',
      firstUsedAt: firstUsedAt.toISOString(), sessionsToday: 2, workspaceId: '', permissionMode: '', allowedOpenIds: [],
      maxConcurrentSessions: 2, sessionsPerDay: 20, enabled: true, disabledReason: null,
    };
    assert.deepEqual(pick(row, Object.keys(expected)), expected);
    const own = routes.find((r) => r.chatId === `oc_connected_${RUN}`)!;
    // (5c) gave the connected group one topic today.
    assert.deepEqual([own.source, own.firstUsedByOpenId, own.firstUsedAt, own.sessionsToday], ['CONNECT', null, null, 1]);
    assert.equal(toUuid(own.id as string), connected.id);

    // Only switched: anything else is refused and writes nothing.
    const since = await mark();
    const changed = await api('PATCH', `/integrations/feishu/chats/${implicit.id}`, login, { maxConcurrentSessions: 3 });
    assert.equal(changed.status, 400, changed.text);
    assert.deepEqual(await writesSince(since), []);
    const tokenOff = await api('PATCH', `/integrations/feishu/chats/${implicit.id}`, token, { enabled: false });
    assert.equal(tokenOff.status, 403, tokenOff.text);
    assert.equal(tokenOff.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    const off = await api('PATCH', `/integrations/feishu/chats/${implicit.id}`, login, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.json.enabled, off.json.disabledReason, off.json.source, off.json.sessionsToday], [false, 'OWNER', 'OPEN_ACCESS', 2]);
    const on = await api('PATCH', `/integrations/feishu/chats/${implicit.id}`, login, { enabled: true });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual([on.json.enabled, on.json.disabledReason], [true, null]);

    // The bot removed from the group switches it off as BOT_REMOVED, and processing that again writes nothing.
    const routesService = new FeishuChatRouteService(db as unknown as PrismaService, {} as FeishuOutbound);
    await routesService.botRemoved(appId, implicitChat);
    const removed = await db.feishuChatRoute.findUniqueOrThrow({ where: { id: implicit.id } });
    assert.deepEqual([removed.enabled, removed.disabledReason], [false, 'BOT_REMOVED']);
    const again = await mark();
    await routesService.botRemoved(appId, implicitChat);
    assert.deepEqual(await writesSince(again), []);
    const back = await api('PATCH', `/integrations/feishu/chats/${implicit.id}`, login, { enabled: true });
    assert.equal(back.status, 409, back.text);

    // A connect confirmed in the group gives it its own settings.
    await db.feishuChatRoute.update({
      where: { id: implicit.id },
      data: { ticketHash: hashChatTicket(`implicit-${RUN}`), ticketOpenId: 'ou_owner', ticketEventId: `ev-implicit-${RUN}`, ticketExpiresAt: new Date(Date.now() + 600_000) },
    });
    const confirmed = await api('POST', '/integrations/feishu/chats/confirm', login, {
      ticket: `implicit-${RUN}`, workspaceId: owner.workspaceId, permissionMode: 'auto', allowedOpenIds: [], maxConcurrentSessions: 2, sessionsPerDay: 20,
    });
    assert.equal(confirmed.status, 201, confirmed.text);
    assert.deepEqual([confirmed.json.source, confirmed.json.enabled, confirmed.json.firstUsedByName], ['CONNECT', true, 'Li Wei']);

    // The database keeps an unconfirmed connect off, and lets only an implicit route run unconfirmed.
    await assert.rejects(
      sql.query(`UPDATE feishu_chat_route SET enabled = true WHERE app_id = $1 AND chat_id = $2`, [appId, `oc_waiting_${RUN}`]),
      /feishu_chat_route_enabled_chk/,
    );
  });

  await t.test('(7) another app starts as Only you and keeps the settings of others\' sessions', async () => {
    const before = accessOf(await api('GET', '/integrations/feishu', login));
    assert.equal(before.mode, 'AVAILABILITY_SCOPE');
    const replaced = await api('PUT', '/integrations/feishu', login, { platform: Y.platform, appId: Y.appId, appSecret: Y.appSecret });
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(replaced.json.app.appId, Y.appId);
    assert.deepEqual(accessOf(replaced), { ...before, mode: 'OWNER_ONLY' });
  });
});
