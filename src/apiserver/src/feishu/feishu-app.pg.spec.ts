/**
 * Each account's own Feishu (Lark) app (docs/feishu-bot-design.md §4.1, §10; migration 0489), against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`), and
 * the fake open platform it is pointed at (feishu/test-support/fake-open-platform.ts). What it is held to:
 *
 *   (1) 0489 made the two tables it describes — columns, which are NOT NULL, defaults, keys, CHECKs, foreign
 *       keys, no trigger — runs again unchanged, and writes no row;
 *   (2) credentials Feishu will not trade for a tenant_access_token are refused 400 with Feishu's code and
 *       message, and leave no feishu_app row: a wrong secret, an App ID Feishu does not know, the right pair on
 *       the other platform (Lark's side is asked for a LARK app), an open platform that cannot be asked; and a
 *       request Orbit can refuse by itself asks Feishu nothing;
 *   (3) good credentials are saved after one token trade: the App Secret encrypted, decrypting to what was sent;
 *       messageDetail TITLES_ONLY, approvals in Feishu and the app's switch on; and PUT and GET answer the app
 *       field by field without the secret, what is stored for it, or the token;
 *   (4) the same App ID saved by a second account is refused 409 `This Feishu app is already connected to another
 *       Orbit account.`, and the first account's row is untouched; with a wrong secret it is the 400 of (2);
 *   (5) the same app saved again keeps its row, the owner's identity included, and takes the new secret; another
 *       app replaces the row, clears what belonged to the old one, keeps the account's choices, and frees the old
 *       App ID for another account;
 *   (6) PATCH switches the app and sets its messageDetail (TITLES_ONLY or FULL, nothing else); DELETE removes it, twice alike; an access token holding every scope reaches none
 *       of the four routes (ACCOUNT); a secret the PROVIDER_SECRET_KEY in force cannot decrypt reads
 *       `secretUnreadable: true`;
 *   (7) the administrators' switch: on with no row; only an ADMIN reads or switches it, or removes an account's
 *       app; switched off, a PUT is refused 403 before Feishu is asked, and the apps already saved stay;
 *   (8) nothing the apiserver answered in this run, nor its log, nor any stored row, carries an App Secret sent
 *       to it or a tenant_access_token the open platform handed out.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-app.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import {
  FEISHU_APP_TAKEN,
  FEISHU_APP_TAKEN_MESSAGE,
  FEISHU_NOT_ALLOWED,
  FEISHU_NOT_ALLOWED_MESSAGE,
} from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FAKE_INVALID_PARAM, FAKE_SECRET_INVALID, FakeOpenPlatform } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
// The apiserver child and this process encrypt and decrypt with the same key.
process.env.PROVIDER_SECRET_KEY = `feishu-app-${randomUUID()}`;
const RUN = randomUUID().slice(0, 8);
const MIGRATION = readFileSync(path.resolve(__dirname, '../../prisma/migrations/0489_feishu_app/migration.sql'), 'utf8');
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';

/** Three apps the open platform knows: two on Feishu, one on Lark. */
const APP_X = { platform: 'FEISHU' as const, appId: `cli_x_${RUN}`, appSecret: `secret-x-${RUN}-${randomUUID()}` };
const APP_Y = { platform: 'FEISHU' as const, appId: `cli_y_${RUN}`, appSecret: `secret-y-${RUN}-${randomUUID()}` };
const APP_L = { platform: 'LARK' as const, appId: `cli_l_${RUN}`, appSecret: `secret-l-${RUN}-${randomUUID()}` };
/** A secret that was sent and is not an app's: it may not come back either. */
const WRONG = `wrong-secret-${RUN}-${randomUUID()}`;
/** App X's secret after Feishu rotated it (5). */
const X_ROTATED = `${APP_X.appSecret}-rotated`;
/** Every App Secret sent to the apiserver in this run. */
const SECRETS = [APP_X.appSecret, X_ROTATED, APP_Y.appSecret, APP_L.appSecret, WRONG];

/** What every answer's app is made of, the id twin the response pipeline adds (common/public-id-body.ts) included. */
const APP_KEYS = [
  'appId', 'approvalsInFeishu', 'botName', 'connectedReplicas', 'createdAt', 'defaultWorkspaceId', 'defaultWorkspacePublicId', 'enabled',
  'hasSecret', 'lastConnectedAt', 'lastError', 'lastEventAt', 'messageDetail', 'ownerName', 'ownerOpenId', 'platform',
  'secretUnreadable', 'updatedAt',
];

/** The ciphertext some other `PROVIDER_SECRET_KEY` wrote: what a rotation leaves in the row. */
function encryptWithOtherKey(plaintext: string): string {
  const inForce = process.env.PROVIDER_SECRET_KEY;
  process.env.PROVIDER_SECRET_KEY = `${inForce}-the-key-before-the-rotation`;
  try {
    return encryptSecret(plaintext);
  } finally {
    process.env.PROVIDER_SECRET_KEY = inForce;
  }
}

/** Every string anywhere in a JSON value, keys included. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out);
    }
  }
  return out;
}

test('Feishu apps: saved only once Feishu trades the credentials, one account per App ID, the App Secret never answered', {
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

  for (const app of [APP_X, APP_Y, APP_L]) fake.addApp(app);
  const fakeUrl = await fake.start();
  const jwtSecret = `feishu-app-${randomUUID()}`;

  /** Every answer the apiserver gave in this run, for (8). */
  const answers: Reply[] = [];
  const ask = async (method: string, route: string, bearer?: string, body?: unknown) => {
    const reply = await call(server!, method, route, bearer, body);
    answers.push(reply);
    return reply;
  };
  /** Every value `app_secret_enc` held in this run, for (8). */
  const stored = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appRows = async (): Promise<any[]> => {
    const rows = (await sql.query('SELECT * FROM feishu_app ORDER BY created_at, id')).rows;
    for (const row of rows) stored.add(row.app_secret_enc);
    return rows;
  };
  const tokenTrades = () => fake.requestsTo(TOKEN_PATH).length;

  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  async function account(name: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const id = randomUUID();
    const email = `feishu-${name}-${RUN}@feishu-app.invalid`;
    await db.user.create({ data: { id, email, name: `Feishu ${name}`, passwordHash: hashPassword(`password-${RUN}`), role } });
    return { id, email, bearer: await jwt.signAsync({ sub: id, email }) };
  }

  await t.test('(1) 0489 made the tables it describes, writes no row, and runs again', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0489_feishu_app'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = async (table: string) =>
      (await sql.query(
        `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )).rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}${c.column_default ? ` = ${c.column_default}` : ''}`);
    assert.deepEqual(await columns('feishu_app'), [
      'id uuid NOT NULL',
      'owner_id uuid NOT NULL',
      'platform text NOT NULL',
      'app_id text NOT NULL',
      'app_secret_enc text NOT NULL',
      'enabled bool NOT NULL = true',
      "message_detail text NOT NULL = 'TITLES_ONLY'::text",
      'approvals_in_feishu bool NOT NULL = true',
      'default_workspace_id uuid NULL',
      'owner_open_id text NULL',
      'owner_name text NULL',
      'bot_name text NULL',
      'last_connected_at timestamptz NULL',
      'last_event_at timestamptz NULL',
      'last_error text NULL',
      'created_at timestamptz NOT NULL = CURRENT_TIMESTAMP',
      'updated_at timestamptz NOT NULL = CURRENT_TIMESTAMP',
    ]);
    assert.deepEqual(await columns('feishu_deployment_setting'), [
      'id int2 NOT NULL = 1',
      'allowed bool NOT NULL',
      'updated_at timestamptz NOT NULL = CURRENT_TIMESTAMP',
      'updated_by_id uuid NULL',
    ]);
    const constraints = async (table: string) =>
      (await sql.query(`SELECT conname, contype FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [table])).rows
        .map((c) => `${c.conname} ${c.contype}`);
    assert.deepEqual(await constraints('feishu_app'), [
      'feishu_app_app_id_chk c',
      'feishu_app_app_secret_enc_chk c',
      'feishu_app_default_workspace_id_fkey f',
      'feishu_app_message_detail_chk c',
      'feishu_app_owner_id_fkey f',
      'feishu_app_pkey p',
      'feishu_app_platform_chk c',
    ]);
    assert.deepEqual(await constraints('feishu_deployment_setting'), ['feishu_deployment_setting_one_row_chk c', 'feishu_deployment_setting_pkey p']);
    const actions = await sql.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'feishu_app'::regclass AND contype = 'f' ORDER BY conname`,
    );
    assert.deepEqual(actions.rows, [
      { conname: 'feishu_app_default_workspace_id_fkey', confdeltype: 'n' },
      { conname: 'feishu_app_owner_id_fkey', confdeltype: 'c' },
    ], 'a deleted workspace clears the choice; a deleted account takes its app');
    const unique = await sql.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'feishu_app' AND indexdef LIKE 'CREATE UNIQUE INDEX%' ORDER BY indexname`,
    );
    assert.deepEqual(unique.rows.map((r) => r.indexname), ['feishu_app_app_id_key', 'feishu_app_owner_id_key', 'feishu_app_pkey']);
    const triggers = await sql.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('feishu_app'::regclass, 'feishu_deployment_setting'::regclass) AND NOT tgisinternal`,
    );
    assert.deepEqual(triggers.rows, []);
    // The closed sets and the one row.
    const refusal = (statement: string) => sql.query(statement).then(() => 'accepted', (e: { code?: string; constraint?: string }) => `${e.code} ${e.constraint}`);
    const someone = randomUUID();
    await db.user.create({ data: { id: someone, email: `check-${RUN}@feishu-app.invalid`, name: 'check', passwordHash: 'x' } });
    assert.equal(
      await refusal(`INSERT INTO feishu_app (id, owner_id, platform, app_id, app_secret_enc) VALUES (gen_random_uuid(), '${someone}', 'WECHAT', 'cli_check', 'x')`),
      '23514 feishu_app_platform_chk',
    );
    assert.equal(
      await refusal(`INSERT INTO feishu_app (id, owner_id, platform, app_id, app_secret_enc, message_detail) VALUES (gen_random_uuid(), '${someone}', 'FEISHU', 'cli_check', 'x', 'SOME')`),
      '23514 feishu_app_message_detail_chk',
    );
    assert.equal(await refusal(`INSERT INTO feishu_deployment_setting (id, allowed) VALUES (2, true)`), '23514 feishu_deployment_setting_one_row_chk');
    await sql.query(`DELETE FROM "user" WHERE id = $1`, [someone]);
    // Again, unchanged, and still no row.
    await sql.query(MIGRATION);
    assert.deepEqual(await constraints('feishu_deployment_setting'), ['feishu_deployment_setting_one_row_chk c', 'feishu_deployment_setting_pkey p']);
    assert.deepEqual(await appRows(), []);
    assert.deepEqual((await sql.query('SELECT * FROM feishu_deployment_setting')).rows, []);
  });

  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY: process.env.PROVIDER_SECRET_KEY,
    [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl,
    NODE_ENV: 'test',
  });
  const admin = await account('admin', 'ADMIN');
  const a = await account('a');
  const b = await account('b');
  const c = await account('c');

  /** An answer's app, as every route answers it: never the secret. */
  const assertApp = (reply: Reply, expected: Record<string, unknown>, what: string) => {
    assert.equal(reply.status, 200, `${what} answered ${reply.status}: ${reply.text}`);
    assert.deepEqual(Object.keys(reply.json).sort(), ['allowed', 'app'], what);
    assert.deepEqual(Object.keys(reply.json.app).sort(), APP_KEYS, what);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(reply.json.app[key], value, `${what}: ${key}`);
  };

  await t.test('(2) credentials Feishu will not trade: 400 with its code and message, and no feishu_app row', async () => {
    const read = await ask('GET', '/api/integrations/feishu', a.bearer);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json, { allowed: true, app: null });

    const refused = async (body: unknown, what: string) => {
      const trades = tokenTrades();
      const reply = await ask('PUT', '/api/integrations/feishu', a.bearer, body);
      assert.equal(reply.status, 400, `${what} answered ${reply.status}: ${reply.text}`);
      assert.deepEqual(await appRows(), [], `${what}: nothing saved`);
      return { reply, asked: tokenTrades() - trades };
    };

    const wrong = await refused({ ...APP_X, appSecret: WRONG }, 'a wrong secret');
    assert.equal(wrong.asked, 1);
    assert.equal(wrong.reply.json.code, 'FEISHU_CREDENTIALS_REJECTED');
    assert.equal(wrong.reply.json.feishuCode, FAKE_SECRET_INVALID.code);
    assert.equal(wrong.reply.json.feishuMsg, FAKE_SECRET_INVALID.msg);
    assert.equal(
      wrong.reply.json.message,
      `Feishu did not accept this App ID and App Secret: ${FAKE_SECRET_INVALID.msg} (code ${FAKE_SECRET_INVALID.code}). Nothing was saved.`,
    );
    const sent = fake.requestsTo(TOKEN_PATH).at(-1)!;
    assert.equal(sent.platform, 'FEISHU', 'a FEISHU app is checked on open.feishu.cn');
    assert.deepEqual(sent.body, { app_id: APP_X.appId, app_secret: WRONG });

    const unknown = await refused({ platform: 'FEISHU', appId: `cli_nobody_${RUN}`, appSecret: APP_X.appSecret }, 'an App ID Feishu does not know');
    assert.equal(unknown.reply.json.feishuCode, FAKE_INVALID_PARAM.code);
    assert.equal(unknown.reply.json.feishuMsg, FAKE_INVALID_PARAM.msg);

    const otherPlatform = await refused({ ...APP_L, platform: 'FEISHU' }, "a Lark app's pair on Feishu");
    assert.equal(otherPlatform.reply.json.feishuCode, FAKE_INVALID_PARAM.code);
    assert.equal(fake.requestsTo(TOKEN_PATH).at(-1)!.platform, 'FEISHU');
    const xOnLark = await refused({ ...APP_X, platform: 'LARK' }, "a Feishu app's pair on Lark");
    assert.equal(xOnLark.asked, 1);
    assert.equal(fake.requestsTo(TOKEN_PATH).at(-1)!.platform, 'LARK', 'a LARK app is checked on open.larksuite.com');

    fake.mode = 'unreachable';
    try {
      const down = await refused(APP_X, 'an open platform that drops the connection');
      assert.equal(down.reply.json.code, 'FEISHU_UNREACHABLE');
      assert.equal(down.reply.json.feishuCode, null);
      assert.equal(down.reply.json.feishuMsg, null);
      assert.match(down.reply.json.message, /^Orbit could not check these credentials with open\.feishu\.cn \(.+\)\. Nothing was saved; try again\.$/);
    } finally {
      fake.mode = 'ok';
    }

    // What Orbit refuses by itself asks Feishu nothing.
    for (const [body, what] of [
      [{ platform: 'WECHAT', appId: APP_X.appId, appSecret: APP_X.appSecret }, 'a platform there is not'],
      [{ platform: 'FEISHU', appId: APP_X.appId }, 'no secret'],
      [{ platform: 'FEISHU', appId: '   ', appSecret: APP_X.appSecret }, 'a blank App ID'],
      [{ platform: 'FEISHU', appId: APP_X.appId, appSecret: 'x'.repeat(257) }, 'a secret longer than any'],
    ] as const) {
      const { asked } = await refused(body, what);
      assert.equal(asked, 0, `${what}: Feishu was asked`);
    }
  });

  await t.test('(3) good credentials: one token trade, the secret stored encrypted, the defaults, and no secret in PUT or GET', async () => {
    const trades = tokenTrades();
    const first = await ask('PUT', '/api/integrations/feishu', a.bearer, { ...APP_X, appId: ` ${APP_X.appId} `, appSecret: `${APP_X.appSecret}\n` });
    const expected = {
      platform: 'FEISHU',
      appId: APP_X.appId,
      hasSecret: true,
      secretUnreadable: false,
      enabled: true,
      messageDetail: 'TITLES_ONLY',
      approvalsInFeishu: true,
      defaultWorkspaceId: null,
      ownerOpenId: null,
      ownerName: null,
      botName: null,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
    };
    assertApp(first, expected, 'the save');
    assert.equal(first.json.allowed, true);
    assert.equal(tokenTrades() - trades, 1, 'one token trade, with the trimmed pair');
    assert.deepEqual(fake.requestsTo(TOKEN_PATH).at(-1)!.body, { app_id: APP_X.appId, app_secret: APP_X.appSecret });

    const rows = await appRows();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.owner_id, a.id);
    assert.equal(row.platform, 'FEISHU');
    assert.equal(row.app_id, APP_X.appId);
    assert.notEqual(row.app_secret_enc, APP_X.appSecret);
    assert.ok(!row.app_secret_enc.includes(APP_X.appSecret));
    assert.equal(decryptSecret(row.app_secret_enc), APP_X.appSecret, 'what is stored decrypts to what was sent');
    assert.equal(row.message_detail, 'TITLES_ONLY');
    assert.equal(row.approvals_in_feishu, true);
    assert.equal(row.enabled, true);

    const read = await ask('GET', '/api/integrations/feishu', a.bearer);
    assertApp(read, expected, 'the read');
    assert.deepEqual(read.json, first.json, 'GET answers what the save answered');

    // Field by field: no key names the secret, and no value is it, contains it, or is what is stored for it or a token.
    for (const [reply, what] of [[first, 'PUT'], [read, 'GET']] as const) {
      for (const text of stringsOf(reply.json)) {
        assert.ok(!/^(appSecret|appSecretEnc|app_secret|app_secret_enc|secret)$/i.test(text), `${what} names ${text}`);
        for (const secret of [APP_X.appSecret, row.app_secret_enc, ...fake.tenantAccessTokens]) {
          assert.ok(!text.includes(secret), `${what} carries a secret, what is stored for it or a token`);
        }
      }
    }
  });

  await t.test('(4) the same App ID from another account: 409 and the first account\'s row untouched; a wrong secret is the 400 of (2)', async () => {
    const before = await appRows();
    const taken = await ask('PUT', '/api/integrations/feishu', b.bearer, APP_X);
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.json.code, FEISHU_APP_TAKEN);
    assert.equal(taken.json.message, FEISHU_APP_TAKEN_MESSAGE);
    assert.equal(taken.json.message, 'This Feishu app is already connected to another Orbit account.');
    assert.deepEqual(await appRows(), before, 'nothing changed');
    const own = await ask('GET', '/api/integrations/feishu', b.bearer);
    assert.deepEqual(own.json, { allowed: true, app: null });

    const guessing = await ask('PUT', '/api/integrations/feishu', b.bearer, { ...APP_X, appSecret: WRONG });
    assert.equal(guessing.status, 400, guessing.text);
    assert.equal(guessing.json.code, 'FEISHU_CREDENTIALS_REJECTED', 'without the secret, nothing says the app is connected');
    assert.deepEqual(await appRows(), before);
  });

  await t.test('(5) the same app again keeps its row and takes the new secret; another app replaces it, keeps the choices and frees the old App ID', async () => {
    const [row] = await appRows();
    await sql.query(
      `UPDATE feishu_app SET owner_open_id = 'ou_owner', owner_name = 'The Owner', bot_name = 'Orbit Bot', last_error = '99991663 the token expired' WHERE id = $1`,
      [row.id],
    );
    fake.addApp({ ...APP_X, appSecret: X_ROTATED });
    const again = await ask('PUT', '/api/integrations/feishu', a.bearer, { ...APP_X, appSecret: X_ROTATED });
    assertApp(again, { appId: APP_X.appId, ownerOpenId: 'ou_owner', ownerName: 'The Owner', botName: 'Orbit Bot', lastError: null }, 'the same app again');
    const [kept] = await appRows();
    assert.equal(kept.id, row.id, 'the same row');
    assert.equal(decryptSecret(kept.app_secret_enc), X_ROTATED);
    APP_X.appSecret = X_ROTATED;

    // The account's choices, before it replaces the app.
    const off = await ask('PATCH', '/api/integrations/feishu', a.bearer, { enabled: false });
    assertApp(off, { enabled: false }, 'switched off');
    const full = await ask('PATCH', '/api/integrations/feishu', a.bearer, { messageDetail: 'FULL' });
    assertApp(full, { enabled: false, messageDetail: 'FULL' }, 'details on');
    assert.equal((await appRows()).find((r) => r.id === row.id)?.message_detail, 'FULL');
    await sql.query(`UPDATE feishu_app SET approvals_in_feishu = false WHERE id = $1`, [row.id]);

    const replaced = await ask('PUT', '/api/integrations/feishu', a.bearer, APP_Y);
    assertApp(replaced, {
      platform: 'FEISHU', appId: APP_Y.appId, ownerOpenId: null, ownerName: null, botName: null, lastError: null,
      enabled: false, messageDetail: 'FULL', approvalsInFeishu: false,
    }, 'another app');
    const rows = await appRows();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, row.id, 'another app is another row');
    assert.equal(decryptSecret(rows[0].app_secret_enc), APP_Y.appSecret);

    const freed = await ask('PUT', '/api/integrations/feishu', b.bearer, APP_X);
    assertApp(freed, { appId: APP_X.appId, enabled: true, messageDetail: 'TITLES_ONLY', approvalsInFeishu: true }, "the old App ID, now B's");
    assert.deepEqual((await appRows()).map((r) => [r.owner_id, r.app_id]).sort(), [[a.id, APP_Y.appId], [b.id, APP_X.appId]].sort());

    // A's app back on, for what follows.
    assertApp(await ask('PATCH', '/api/integrations/feishu', a.bearer, { enabled: true }), { enabled: true }, 'switched on');
  });

  await t.test('(6) PATCH, DELETE, an access token, and a secret the key in force cannot decrypt', async () => {
    const none = await ask('PATCH', '/api/integrations/feishu', c.bearer, { enabled: false });
    assert.equal(none.status, 404, none.text);
    const nothing = await ask('PATCH', '/api/integrations/feishu', c.bearer, {});
    assert.equal(nothing.status, 404, nothing.text);
    const notBoolean = await ask('PATCH', '/api/integrations/feishu', a.bearer, { enabled: 'yes' });
    assert.equal(notBoolean.status, 400, notBoolean.text);
    const notADetail = await ask('PATCH', '/api/integrations/feishu', a.bearer, { messageDetail: 'SOME' });
    assert.equal(notADetail.status, 400, notADetail.text);
    const noDetailApp = await ask('PATCH', '/api/integrations/feishu', c.bearer, { messageDetail: 'FULL' });
    assert.equal(noDetailApp.status, 404, noDetailApp.text);

    // An access token holding every scope reaches none of the four, and writes nothing.
    const pats = new PatService(db as unknown as PrismaService);
    const token = (await pats.issue(a.id, { name: `every scope ${RUN}`, scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;
    const before = await appRows();
    for (const [method, body] of [['GET'], ['PUT', APP_Y], ['PATCH', { enabled: false }], ['DELETE']] as const) {
      const reply = await ask(method, '/api/integrations/feishu', token, body);
      assert.equal(reply.status, 403, `${method}: ${reply.text}`);
      assert.equal(reply.json.code, 'PAT_FORBIDDEN', method);
      assert.equal(reply.json.reason, 'ACCOUNT', method);
    }
    assert.deepEqual(await appRows(), before);

    // A rotated PROVIDER_SECRET_KEY: saved, but unreadable.
    const unreadable = encryptWithOtherKey(APP_Y.appSecret);
    stored.add(unreadable);
    await sql.query(`UPDATE feishu_app SET app_secret_enc = $1 WHERE owner_id = $2`, [unreadable, a.id]);
    assertApp(await ask('GET', '/api/integrations/feishu', a.bearer), { hasSecret: true, secretUnreadable: true }, 'after a rotation');
    // Entering it again is the fix.
    assertApp(await ask('PUT', '/api/integrations/feishu', a.bearer, APP_Y), { hasSecret: true, secretUnreadable: false }, 'entered again');

    const removed = await ask('DELETE', '/api/integrations/feishu', a.bearer);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { allowed: true, app: null });
    assert.deepEqual((await appRows()).map((r) => r.owner_id), [b.id]);
    const again = await ask('DELETE', '/api/integrations/feishu', a.bearer);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json, { allowed: true, app: null });
  });

  await t.test("(7) the administrators' switch and removal: an ADMIN's alone; off, a save is refused before Feishu is asked and the apps stay", async () => {
    for (const [method, route, body] of [
      ['GET', '/api/admin/integrations/feishu'],
      ['PUT', '/api/admin/integrations/feishu', { allowed: false }],
      ['DELETE', `/api/admin/users/${b.id}/feishu`],
    ] as const) {
      const reply = await ask(method, route, a.bearer, body);
      assert.equal(reply.status, 403, `a member's ${method} ${route}: ${reply.text}`);
    }
    assert.deepEqual((await sql.query('SELECT * FROM feishu_deployment_setting')).rows, []);
    assert.equal((await appRows()).length, 1);

    const read = await ask('GET', '/api/admin/integrations/feishu', admin.bearer);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json, { allowed: true, connectedApps: 1, enabledApps: 1 }, 'on with no row');

    const off = await ask('PUT', '/api/admin/integrations/feishu', admin.bearer, { allowed: false });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json, { allowed: false, connectedApps: 1, enabledApps: 1 });
    const [setting] = (await sql.query('SELECT * FROM feishu_deployment_setting')).rows;
    assert.equal(setting.id, 1);
    assert.equal(setting.allowed, false);
    assert.equal(setting.updated_by_id, admin.id);

    const trades = tokenTrades();
    const refused = await ask('PUT', '/api/integrations/feishu', c.bearer, APP_L);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.code, FEISHU_NOT_ALLOWED);
    assert.equal(refused.json.message, FEISHU_NOT_ALLOWED_MESSAGE);
    assert.equal(tokenTrades(), trades, 'Feishu was not asked');
    assert.deepEqual((await appRows()).map((r) => r.owner_id), [b.id], 'nothing saved, and the app already saved stays');
    const theirs = await ask('GET', '/api/integrations/feishu', b.bearer);
    assert.equal(theirs.json.allowed, false);
    assert.equal(theirs.json.app.appId, APP_X.appId);

    const on = await ask('PUT', '/api/admin/integrations/feishu', admin.bearer, { allowed: true });
    assert.deepEqual(on.json, { allowed: true, connectedApps: 1, enabledApps: 1 });
    assertApp(await ask('PUT', '/api/integrations/feishu', c.bearer, APP_L), { platform: 'LARK', appId: APP_L.appId }, 'a Lark app, once allowed again');
    assert.equal(fake.requestsTo(TOKEN_PATH).at(-1)!.platform, 'LARK');
    const counted = await ask('GET', '/api/admin/integrations/feishu', admin.bearer);
    assert.deepEqual(counted.json, { allowed: true, connectedApps: 2, enabledApps: 2 });

    const removed = await ask('DELETE', `/api/admin/users/${b.id}/feishu`, admin.bearer);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { removed: true });
    assert.deepEqual((await appRows()).map((r) => r.owner_id), [c.id]);
    const twice = await ask('DELETE', `/api/admin/users/${b.id}/feishu`, admin.bearer);
    assert.deepEqual(twice.json, { removed: false });
    const nobody = await ask('DELETE', `/api/admin/users/${randomUUID()}/feishu`, admin.bearer);
    assert.equal(nobody.status, 404, nobody.text);
  });

  await t.test('(8) nothing answered, logged or stored in this run carries an App Secret or a tenant_access_token', async () => {
    assert.ok(answers.length > 40, `only ${answers.length} answers were recorded`);
    assert.ok(fake.tenantAccessTokens.length >= 6, `only ${fake.tenantAccessTokens.length} tokens were handed out`);
    const forbidden = [...SECRETS, ...stored, ...fake.tenantAccessTokens];
    const leaks = answers.filter((reply) => forbidden.some((secret) => reply.text.includes(secret)));
    assert.deepEqual(leaks.map((reply) => reply.text), []);
    const log = server!.output();
    for (const secret of [...SECRETS, ...fake.tenantAccessTokens]) assert.ok(!log.includes(secret), 'the apiserver logged a secret or a token');
    for (const secret of stored) assert.ok(!log.includes(secret), 'the apiserver logged what is stored for a secret');
    const rows = (await sql.query('SELECT row_to_json(f)::text AS row FROM feishu_app f')).rows.map((r) => r.row as string);
    for (const row of rows) {
      for (const secret of [...SECRETS, ...fake.tenantAccessTokens]) assert.ok(!row.includes(secret), 'a row keeps a secret or a token in the clear');
    }
  });
});
