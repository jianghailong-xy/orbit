/**
 * The owner's identity (docs/feishu-bot-design.md §5; task F1-1; migration 0494), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`), and the fake open platform
 * its long connection reaches (feishu/test-support/fake-open-platform.ts). Every Feishu message below is pushed down
 * that connection as Feishu would push it, and goes through the inbox and the router. What it is held to:
 *
 *   (1) 0494 made feishu_connect_code as it says — keys, indexes, the foreign key — and wrote no row;
 *   (2) POST /api/integrations/feishu/connect-codes answers an 8-character code, valid for 10 minutes, and the applink of
 *       the bot's chat; only its SHA-256 is stored; a second code replaces the first; no app is 404; an access token
 *       holding every scope reaches none of the three new routes (ACCOUNT);
 *   (3) the test message while nobody is the owner is 409 FEISHU_NO_OWNER, and nothing is sent;
 *   (4) an expired code, a code sent in a group, another account's code and a used code leave owner_open_id as it was,
 *       each answered with its English reply; the group's code stops working;
 *   (5) a live code sent in a direct message makes the sender the owner — owner_open_id is the sender's open_id, the
 *       name read from the contact API — deletes the code row, and is answered `You're connected as the owner of this
 *       Orbit bot.`; the same event processed twice binds once; a name Feishu does not give is left empty;
 *   (6) the test message reaches the fake open platform, addressed to the owner's open_id;
 *   (7) `disconnect` from someone else changes nothing; from the owner it clears the identity, and DELETE
 *       /api/integrations/feishu/owner does the same; the app stays connected either way;
 *   (8) no log, stored row or answer other than the generating route's carries a code.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-owner.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { FEISHU_NO_OWNER, FEISHU_NO_OWNER_MESSAGE } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FEISHU_OWNER_REPLIES } from './feishu-owner.service';
import { FEISHU_TEST_TIME_SCALE_ENV } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-owner-${randomUUID()}`;
const SCALE = '50';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const RUN = randomBytes(4).toString('hex');

/** A's app (the one bound throughout) and B's (whose code is tried on A's app). */
const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit owner bot' };
const Y = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}` };
/** People in X's tenant. Alice and Carol become the owner; Mallory tries to. Carol's name Feishu will not give. */
const ALICE = 'ou_alice';
const MALLORY = 'ou_mallory';
const CAROL = 'ou_carol';

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('Feishu owner identity: only a one-time code from Settings, sent in a direct message, makes its sender the owner', {
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
  fake.addApp(X);
  fake.addApp(Y);
  fake.userNames.set(ALICE, 'Alice Example');
  fake.userNames.set(MALLORY, 'Mallory Example');
  const fakeUrl = await fake.start();
  const jwtSecret = `feishu-owner-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });

  async function account(name: string) {
    const id = randomUUID();
    const email = `feishu-owner-${name}-${RUN}@feishu-owner.invalid`;
    await db.user.create({ data: { id, email, name: `Feishu ${name}`, passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
    return { id, bearer: await jwt.signAsync({ sub: id, email }) };
  }
  const a = await account('a');
  const b = await account('b');
  const c = await account('c');
  // Y is off: its account generates a code, and nothing needs its connection.
  await db.feishuApp.create({ data: { ownerId: a.id, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret) } });
  await db.feishuApp.create({ data: { ownerId: b.id, platform: Y.platform, appId: Y.appId, appSecretEnc: encryptSecret(Y.appSecret), enabled: false } });

  server = await startApiserver(url, jwtSecret, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
  });

  /** Every code answered in this run, for (8); and every answer other than those, likewise. */
  const codes: string[] = [];
  const otherAnswers: string[] = [];
  const ask = async (method: string, route: string, bearer: string, body?: unknown) => {
    const reply = await call(server!, method, route, bearer, body);
    if (!route.endsWith('/connect-codes')) otherAnswers.push(reply.text);
    return reply;
  };
  const newCode = async (who = a) => {
    const reply = await call(server!, 'POST', '/api/integrations/feishu/connect-codes', who.bearer);
    assert.equal(reply.status, 201, reply.text);
    codes.push(reply.json.code);
    return reply.json as { code: string; expiresAt: string; applink: string };
  };
  const app = () => db.feishuApp.findUniqueOrThrow({ where: { appId: X.appId } });
  const codeRows = async (ownerId: string) =>
    (await sql.query(`SELECT * FROM feishu_connect_code WHERE owner_id = $1`, [ownerId])).rows;
  const sha = (code: string) => createHash('sha256').update(code).digest('hex');

  let seq = 0;
  /** Push a text message down X's connection; resolve once the inbox processed it, with the bot's reply's text, if any. */
  async function say(openId: string, text: string, chatType: 'p2p' | 'group' = 'p2p', eventId = `ev-owner-${RUN}-${++seq}`) {
    const messageId = `om_${eventId}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId,
          chat_id: chatType === 'p2p' ? `oc_p2p_${openId}` : 'oc_group',
          chat_type: chatType,
          message_type: 'text',
          content: JSON.stringify({ text: chatType === 'group' ? `@_user_1 ${text}` : text }),
        },
      },
    };
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, eventId])).rowCount);
    return { eventId, replies: () => repliesTo(messageId) };
  }
  const repliesTo = (messageId: string) =>
    fake.messages
      .filter((m: FakeRequest) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`)
      .map((m) => (JSON.parse((m.body as { content: string }).content) as { text: string }).text);

  await t.test('(1) 0494 made feishu_connect_code, keyed as it says, and wrote no row', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0494_feishu_connect_code'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const indexes = (await sql.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'feishu_connect_code' ORDER BY indexname`)).rows.map((r) => r.indexname);
    assert.deepEqual(indexes, [
      'feishu_connect_code_code_hash_key',
      'feishu_connect_code_expires_at_idx',
      'feishu_connect_code_owner_id_idx',
      'feishu_connect_code_pkey',
    ]);
    const fks = (await sql.query(`SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid = 'feishu_connect_code'::regclass`)).rows;
    assert.deepEqual(fks, [{ conname: 'feishu_connect_code_owner_id_fkey', confdeltype: 'c' }]);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM feishu_connect_code`)).rows[0].n, 0);
  });

  await t.test('(2) a code: 8 characters, 10 minutes, the bot chat applink; only its hash stored; a new one replaces it', async () => {
    const before = Date.now();
    const first = await newCode();
    assert.match(first.code, /^[A-HJ-NP-Z2-9]{8}$/);
    const ttl = Date.parse(first.expiresAt) - before;
    assert.ok(ttl > 9.9 * 60_000 && ttl <= 10 * 60_000 + 5_000, `valid for ${ttl}ms`);
    assert.equal(first.applink, `https://applink.feishu.cn/client/bot/open?appId=${X.appId}`);
    let rows = await codeRows(a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code_hash, sha(first.code));
    assert.ok(!JSON.stringify(rows).includes(first.code), 'the code itself is not stored');

    const second = await newCode();
    assert.notEqual(second.code, first.code);
    rows = await codeRows(a.id);
    assert.deepEqual(rows.map((r) => r.code_hash), [sha(second.code)], 'the earlier code is gone');

    const none = await ask('POST', '/api/integrations/feishu/connect-codes', c.bearer);
    assert.equal(none.status, 404, none.text);

    const pats = new PatService(db as unknown as PrismaService);
    const token = (await pats.issue(a.id, { name: `every scope ${RUN}`, scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;
    for (const [method, route] of [['POST', '/connect-codes'], ['DELETE', '/owner'], ['POST', '/test']] as const) {
      const reply = await ask(method, `/api/integrations/feishu${route}`, token);
      assert.equal(reply.status, 403, `${method} ${route}: ${reply.text}`);
      assert.equal(reply.json.code, 'PAT_FORBIDDEN');
      assert.equal(reply.json.reason, 'ACCOUNT');
    }
    assert.deepEqual((await codeRows(a.id)).map((r) => r.code_hash), [sha(second.code)], 'the access token wrote nothing');
  });

  await t.test('(3) the test message with nobody the owner is 409, and nothing is sent', async () => {
    const sent = fake.messages.length;
    const reply = await ask('POST', '/api/integrations/feishu/test', a.bearer);
    assert.equal(reply.status, 409, reply.text);
    assert.equal(reply.json.code, FEISHU_NO_OWNER);
    assert.equal(reply.json.message, FEISHU_NO_OWNER_MESSAGE);
    assert.equal(fake.messages.length, sent);
  });

  await t.test('(4) an expired code, a code in a group, another account\'s code, and a used code change no owner', async () => {
    // Expired: its row is past expires_at.
    const expired = await newCode();
    await sql.query(`UPDATE feishu_connect_code SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [sha(expired.code)]);
    const e = await say(ALICE, expired.code);
    assert.equal((await app()).ownerOpenId, null);
    assert.deepEqual(e.replies(), [FEISHU_OWNER_REPLIES.expired]);
    assert.equal((await codeRows(a.id)).length, 0, 'the expired row is gone');

    // In a group: not accepted, and the code stops working, since the group saw it.
    const grouped = await newCode();
    const g = await say(ALICE, grouped.code, 'group');
    assert.equal((await app()).ownerOpenId, null);
    assert.deepEqual(g.replies(), [FEISHU_OWNER_REPLIES.group]);
    assert.equal((await codeRows(a.id)).length, 0, 'the code a group saw is gone');
    const late = await say(ALICE, grouped.code);
    assert.equal((await app()).ownerOpenId, null);
    assert.deepEqual(late.replies(), [FEISHU_OWNER_REPLIES.invalid]);

    // Another account's live code, on this account's app.
    const theirs = await newCode(b);
    const o = await say(MALLORY, theirs.code);
    assert.equal((await app()).ownerOpenId, null);
    assert.deepEqual(o.replies(), [FEISHU_OWNER_REPLIES.invalid]);
    assert.equal((await codeRows(b.id)).length, 1, "B's code stands");
    assert.equal((await db.feishuApp.findUniqueOrThrow({ where: { appId: Y.appId } })).ownerOpenId, null);
  });

  let bound: { eventId: string } | undefined;
  let aliceCode = '';
  await t.test('(5) a live code in a direct message makes its sender the owner, once, and deletes the code', async () => {
    aliceCode = (await newCode()).code;
    // Typed loosely: lower case, with a hyphen.
    const typed = `${aliceCode.slice(0, 4).toLowerCase()}-${aliceCode.slice(4)}`;
    const ok = await say(ALICE, typed);
    bound = ok;
    const row = await app();
    assert.equal(row.ownerOpenId, ALICE);
    assert.equal(row.ownerName, 'Alice Example');
    assert.equal((await codeRows(a.id)).length, 0, 'the code row is deleted');
    assert.deepEqual(ok.replies(), ["You're connected as the owner of this Orbit bot."]);
    const read = await ask('GET', '/api/integrations/feishu', a.bearer);
    assert.equal(read.json.app.ownerOpenId, ALICE);
    assert.equal(read.json.app.ownerName, 'Alice Example');

    // Used: someone else sending the same code later binds nobody.
    const used = await say(MALLORY, aliceCode);
    assert.equal((await app()).ownerOpenId, ALICE);
    assert.deepEqual(used.replies(), [FEISHU_OWNER_REPLIES.invalid]);

    // The same event processed twice (the inbox's lease ran out mid-way): one binding, answered alike.
    const updatedAt = (await app()).updatedAt;
    await sql.query(
      `UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`,
      [X.appId, ok.eventId],
    );
    await until('processed again', async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts = 2`, [X.appId, ok.eventId])).rowCount);
    const again = await app();
    assert.equal(again.ownerOpenId, ALICE);
    assert.equal(again.ownerName, 'Alice Example');
    assert.equal(again.updatedAt.getTime(), updatedAt.getTime(), 'the second processing wrote nothing to the app');
    assert.deepEqual(ok.replies(), [FEISHU_OWNER_REPLIES.connected, FEISHU_OWNER_REPLIES.connected]);
  });

  await t.test('(6) the test message reaches the open platform, addressed to the owner', async () => {
    const sent = fake.messages.length;
    const reply = await ask('POST', '/api/integrations/feishu/test', a.bearer);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json, { sent: true });
    const [message] = fake.messages.slice(sent);
    assert.equal(message.method, 'POST');
    assert.equal(message.path, '/open-apis/im/v1/messages');
    assert.equal(message.query.get('receive_id_type'), 'open_id');
    const body = message.body as { receive_id: string; msg_type: string; content: string };
    assert.equal(body.receive_id, ALICE);
    assert.equal(body.msg_type, 'text');
    assert.deepEqual(JSON.parse(body.content), { text: FEISHU_OWNER_REPLIES.test });
    assert.equal(fake.messages.length, sent + 1);
  });

  await t.test('(7) disconnect: from someone else nothing; from the owner, or DELETE owner, the identity is cleared', async () => {
    const stranger = await say(MALLORY, 'disconnect');
    assert.equal((await app()).ownerOpenId, ALICE);
    assert.deepEqual(stranger.replies(), [], 'not the owner: this branch does not act on it');

    const own = await say(ALICE, ' Disconnect ');
    let row = await app();
    assert.equal(row.ownerOpenId, null);
    assert.equal(row.ownerName, null);
    assert.deepEqual(own.replies(), [FEISHU_OWNER_REPLIES.disconnected]);
    assert.equal(row.enabled, true);
    assert.equal(fake.openConnections(X.appId).length, 1, 'the app stays connected');
    assert.equal((await ask('POST', '/api/integrations/feishu/test', a.bearer)).status, 409, 'and no test message goes anywhere');

    // Carol, whose name Feishu does not give: bound, the name left empty. Then DELETE owner clears her.
    const code = (await newCode()).code;
    await say(CAROL, code);
    row = await app();
    assert.equal(row.ownerOpenId, CAROL);
    assert.equal(row.ownerName, null);
    const cleared = await ask('DELETE', '/api/integrations/feishu/owner', a.bearer);
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.app.ownerOpenId, null);
    assert.equal(cleared.json.app.ownerName, null);
    row = await app();
    assert.equal(row.ownerOpenId, null);
    assert.equal(row.enabled, true);
    assert.equal(fake.openConnections(X.appId).length, 1, 'the app stays connected');
    assert.equal((await ask('POST', '/api/integrations/feishu/test', a.bearer)).status, 409);
    assert.equal((await ask('DELETE', '/api/integrations/feishu/owner', c.bearer)).status, 404, 'no app: 404');
    assert.ok(bound);
  });

  await t.test('(8) no log, stored row or other answer carries a code', async () => {
    assert.ok(codes.length >= 6);
    const logs = server!.output();
    const stored = JSON.stringify([
      ...(await sql.query(`SELECT * FROM feishu_connect_code`)).rows,
      ...(await sql.query(`SELECT owner_open_id, owner_name, last_error FROM feishu_app`)).rows,
    ]);
    const answers = otherAnswers.join('\n');
    for (const code of codes) {
      assert.ok(!logs.includes(code), 'a code is in the apiserver log');
      assert.ok(!stored.includes(code), 'a code is stored');
      assert.ok(!answers.includes(code), 'a code is in another answer');
    }
  });
});
