/**
 * THE SECRETS PAGE'S ROUTES: NO VALUE OUT, AND ONLY THE OWNER, SIGNED IN, ON THEIR OWN ROWS.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/account-secrets-security.pg.spec.ts
 *
 * Held against the production apiserver (`build/main.js`, the whole AppModule) over a real PostgreSQL, for each of
 *
 *   GET /account-secrets, POST /account-secrets, DELETE /account-secrets/:id(?revokeCopies=true),
 *   GET /account-secrets/grants(?removed=30d), POST /account-secrets/grants/:id/revoke
 *
 * THE CASES
 * =========
 *   (a) no value out: random canary values, submitted on a card, added and replaced through these doors, never appear
 *       in any response body these doors give (successes and errors alike) raw, base64 or base64url at any alignment,
 *       hex, as a SHA-256 (hex or base64), or as any 10-character piece of the value;
 *   (b) a request carrying an acting-session header (x-orbit-session-id), with the owner's own login, is refused 403
 *       SECRET_OWNER_CHANNEL_ONLY and writes nothing;
 *   (c) a personal access token holding every scope is refused 403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED and writes
 *       nothing;
 *   (d) another account: its saved-secret and grant ids are answered with the same 404 as an id that does not exist,
 *       never 403, and write nothing; its lists name none of the first account's rows, and its Add does not touch them.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** A canary no ordinary text contains: 40 random letters and digits. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const canary = (): string => [...randomBytes(40)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

/** Every form of `value` a response must not carry. */
function forms(value: string): string[] {
  const out = new Set<string>();
  // Any 10-character piece: the value, a prefix, a suffix, a masked middle.
  for (let i = 0; i + 10 <= value.length; i++) out.add(value.slice(i, i + 10));
  // Base64 and base64url of the value wherever it sits in a larger blob: at one of three alignments an 18-byte run of
  // it encodes to these 24 characters.
  for (let k = 0; k < 3; k++) {
    const chunk = Buffer.from(value.slice(k, k + 18), 'utf8');
    out.add(chunk.toString('base64'));
    out.add(chunk.toString('base64url'));
  }
  out.add(Buffer.from(value, 'utf8').toString('hex'));
  out.add(createHash('sha256').update(value).digest('hex'));
  out.add(createHash('sha256').update(value).digest('base64'));
  return [...out];
}

test('the Secrets page routes return no value, and refuse acting sessions, tokens and other accounts', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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

  const jwtSecret = `account-secrets-security-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const account = async (label: string) => {
    const userId = randomUUID();
    const email = `account-secrets-${label}-${RUN}-${userId}@account-secrets.invalid`;
    await db.user.create({ data: { id: userId, email, name: label, passwordHash: hashPassword('a-password-of-its-own') } });
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: userId, name: `${label} runner`, tokenHash: `account-secrets-${runnerId}` } });
    await db.workspace.create({ data: { id: workspaceId, ownerId: userId, runnerId, name: `${label} ${RUN}`, enabled: true } });
    return { userId, runnerId, workspaceId, login: await jwt.signAsync({ sub: userId, email }) };
  };
  const a = await account('a');
  const b = await account('b');
  const token = (await new PatService(db as unknown as PrismaService)
    .issue(a.userId, { name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;

  server = await startApiserver(url, jwtSecret, { PROVIDER_SECRET_KEY: `account-secrets-security-${RUN}` });

  // ── (a) every body these doors give is kept and searched for every canary ────────────────────────────────────────
  const canaries: Record<string, string> = {};
  const bodies: Array<{ what: string; text: string }> = [];
  const noValueIn = (what: string, reply: Reply) => {
    bodies.push({ what, text: reply.text });
    for (const [name, value] of Object.entries(canaries)) {
      for (const form of forms(value)) {
        assert.ok(!reply.text.includes(form), `${what} (${reply.status}) carries the ${name} canary as "${form}": ${reply.text}`);
      }
    }
    return reply;
  };
  const api = async (what: string, method: string, path: string, bearer: string, body?: unknown, headers?: Record<string, string>) =>
    noValueIn(what, await call(server!, method, `/api${path}`, bearer, body, headers));
  const ok = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what}: ${reply.text}`);
    return reply;
  };

  // Rows to knock on, made through the owner's own doors.
  const sessionId = toUuid(ok(await api('a session', 'POST', '/sessions', a.login, { prompt: 'asks for keys', workspaceId: a.workspaceId }), 201, 'a session').json.id);
  await db.session.update({ where: { id: sessionId }, data: { assignedRunnerId: a.runnerId } });
  const secretRequest = async () => (await db.ownerRequest.create({
    data: {
      ownerId: a.userId, askedBySessionId: sessionId, kind: 'SECRET', title: 'API key', why: 'the session needs a key',
      secretSpec: { name: 'API key', runnerId: a.runnerId, envVar: 'ACCOUNT_SECRETS_KEY' },
    },
  })).id;
  const grantOf = async (requestId: string) => db.ownerRequestSecret.findUniqueOrThrow({ where: { requestId } });

  canaries.card = canary();
  canaries.added = canary();
  canaries.replaced = canary();
  canaries.refused = canary();

  // A card's value, saved as "card key": a grant waiting for delivery, and a saved secret.
  const cardRequest = await secretRequest();
  ok(await api('submitting a card', 'POST', `/owner-requests/${cardRequest}/secret`, a.login, { value: canaries.card, saveAs: 'card key' }), 200, 'submitting a card');
  const cardGrant = await grantOf(cardRequest);
  const cardKey = await db.accountSecret.findUniqueOrThrow({ where: { ownerId_label: { ownerId: a.userId, label: 'card key' } } });

  // Add, then Replace: "added key".
  const added = ok(await api('POST /account-secrets', 'POST', '/account-secrets', a.login, { label: 'added key', value: canaries.added }), 201, 'Add');
  const addedId = toUuid(added.json.id);
  assert.deepEqual(Object.keys(added.json).sort(), ['createdAt', 'id', 'label', 'lastUsedAt', 'publicId', 'updatedAt']);
  ok(await api('PUT /account-secrets/:id', 'PUT', `/account-secrets/${addedId}`, a.login, { value: canaries.replaced }), 204, 'Replace');

  // Use saved "added key" on a second card, delivered (ACTIVE): a live copy made from it.
  const usedRequest = await secretRequest();
  ok(await api('Use saved', 'POST', `/owner-requests/${usedRequest}/secret`, a.login, { savedSecretId: addedId }), 200, 'Use saved');
  await db.ownerRequestSecret.update({ where: { requestId: usedRequest }, data: { state: 'ACTIVE', deliveredAt: new Date() } });
  const usedGrant = await grantOf(usedRequest);
  assert.equal(usedGrant.savedSecretId, addedId);

  // A third card's value, its copy revoked by grant before delivery: a removed copy for ?removed=30d.
  canaries.revoked = canary();
  const revokedRequest = await secretRequest();
  ok(await api('submitting a card', 'POST', `/owner-requests/${revokedRequest}/secret`, a.login, { value: canaries.revoked }), 200, 'submitting a third card');
  const revokedGrant = await grantOf(revokedRequest);
  ok(await api('POST /account-secrets/grants/:id/revoke', 'POST', `/account-secrets/grants/${revokedGrant.id}/revoke`, a.login), 204, 'Revoke by grant');
  assert.notEqual((await grantOf(revokedRequest)).state, 'PENDING_DELIVERY');
  assert.equal((await grantOf(revokedRequest)).valueEnc, null, 'a revoked copy keeps no ciphertext');

  await t.test('(a) no response of the five routes carries a canary value or anything derived from it', async () => {
    // The lists, each naming what it holds, so a value would have had somewhere to be.
    const saved = ok(await api('GET /account-secrets', 'GET', '/account-secrets', a.login), 200, 'the saved list').json;
    const labels = saved.secrets.map((s: { label: string }) => s.label).sort();
    assert.deepEqual(labels, ['added key', 'card key']);
    const addedRow = saved.secrets.find((s: { label: string }) => s.label === 'added key');
    assert.equal(addedRow.liveCopies.count, 1);
    for (const row of saved.secrets) {
      assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'label', 'lastUsedAt', 'liveCopies', 'publicId', 'updatedAt']);
    }
    const live = ok(await api('GET /account-secrets/grants', 'GET', '/account-secrets/grants', a.login), 200, 'the copies list').json;
    assert.deepEqual(live.grants.map((g: { id: string }) => toUuid(g.id)).sort(), [cardGrant.id, usedGrant.id].sort());
    const all = ok(await api('GET /account-secrets/grants?removed=30d', 'GET', '/account-secrets/grants?removed=30d', a.login), 200, 'the copies list with removed').json;
    assert.deepEqual(all.grants.map((g: { id: string }) => toUuid(g.id)).sort(), [cardGrant.id, usedGrant.id, revokedGrant.id].sort());
    for (const grant of all.grants) {
      for (const key of Object.keys(grant)) assert.doesNotMatch(key, /value|length|hash|prefix|digest/i, `a copy row names ${key}`);
    }
    // The doors' errors, each sent a canary: a taken label, a value with a NUL, a label too long, a value too long.
    ok(await api('POST /account-secrets (taken label)', 'POST', '/account-secrets', a.login, { label: 'card key', value: canaries.refused }), 409, 'a taken label');
    ok(await api('POST /account-secrets (NUL)', 'POST', '/account-secrets', a.login, { label: 'with nul', value: `${canaries.refused}\u0000` }), 400, 'a NUL');
    ok(await api('POST /account-secrets (label too long)', 'POST', '/account-secrets', a.login, { label: 'x'.repeat(101), value: canaries.refused }), 400, 'a long label');
    ok(await api('POST /account-secrets (value too long)', 'POST', '/account-secrets', a.login, { label: 'too long', value: canaries.refused.repeat(500) }), 400, 'a long value');
    ok(await api('POST /account-secrets (label not a string)', 'POST', '/account-secrets', a.login, { label: canaries.refused, value: 7 }), 400, 'a value not a string');
    // A revoke of an ended copy, and of one that does not exist.
    ok(await api('POST /account-secrets/grants/:id/revoke (ended)', 'POST', `/account-secrets/grants/${revokedGrant.id}/revoke`, a.login), 409, 'an ended copy');
    ok(await api('POST /account-secrets/grants/:id/revoke (none)', 'POST', `/account-secrets/grants/${randomUUID()}/revoke`, a.login), 404, 'no copy');
    ok(await api('DELETE /account-secrets/:id (none)', 'DELETE', `/account-secrets/${randomUUID()}?revokeCopies=true`, a.login), 404, 'no saved secret');
    assert.equal(await db.accountSecret.count({ where: { ownerId: a.userId } }), 2, 'no refused Add wrote a row');
  });

  /** What the five doors could have changed: compared before and after a refused knock. */
  const state = async () => ({
    saved: await db.accountSecret.findMany({ where: { ownerId: a.userId }, orderBy: { id: 'asc' } }),
    grants: await db.ownerRequestSecret.findMany({ where: { ownerId: a.userId }, orderBy: { id: 'asc' } }),
  });
  /** The five routes, each as it would be knocked on to do its work on the first account's rows. */
  const doors = () => [
    { route: 'GET /account-secrets', method: 'GET', path: '/account-secrets' },
    { route: 'GET /account-secrets/grants', method: 'GET', path: '/account-secrets/grants?removed=30d' },
    { route: 'POST /account-secrets', method: 'POST', path: '/account-secrets', body: { label: 'knocked', value: canaries.refused } },
    { route: 'DELETE /account-secrets/:id', method: 'DELETE', path: `/account-secrets/${cardKey.id}?revokeCopies=true` },
    { route: 'POST /account-secrets/grants/:id/revoke', method: 'POST', path: `/account-secrets/grants/${usedGrant.id}/revoke` },
  ];

  await t.test('(b) a request on a session\'s behalf is refused by every route and writes nothing', async () => {
    const before = await state();
    for (const door of doors()) {
      const reply = await api(`${door.route} (acting session)`, door.method, door.path, a.login, door.body, { 'x-orbit-session-id': sessionId });
      assert.equal(reply.status, 403, `${door.route} with an acting session: ${reply.text}`);
      assert.equal(reply.json?.code, 'SECRET_OWNER_CHANNEL_ONLY', `${door.route} with an acting session: ${reply.text}`);
    }
    assert.deepEqual(await state(), before, 'a refused acting session wrote nothing');
  });

  await t.test('(c) a personal access token holding every scope is refused by every route and writes nothing', async () => {
    const before = await state();
    for (const door of doors()) {
      const reply = await api(`${door.route} (token)`, door.method, door.path, token, door.body);
      assert.equal(reply.status, 403, `${door.route} with a token: ${reply.text}`);
      assert.equal(reply.json?.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED', `${door.route} with a token: ${reply.text}`);
    }
    assert.deepEqual(await state(), before, 'a refused token wrote nothing');
  });

  await t.test('(d) another account gets the 404 of an id that does not exist, sees none of these rows, and writes nothing', async () => {
    const before = await state();
    const same404 = async (route: string, method: string, theirs: string, nobody: string) => {
      const mine = await api(`${route} (another account's id)`, method, theirs, b.login);
      const none = await api(`${route} (no such id)`, method, nobody, b.login);
      assert.equal(mine.status, 404, `${route} on another account's id: ${mine.text}`);
      assert.deepEqual(mine.json, none.json, `${route}: another account's id is answered as one that does not exist`);
    };
    await same404('DELETE /account-secrets/:id', 'DELETE', `/account-secrets/${cardKey.id}`, `/account-secrets/${randomUUID()}`);
    await same404('DELETE /account-secrets/:id', 'DELETE', `/account-secrets/${addedId}?revokeCopies=true`, `/account-secrets/${randomUUID()}?revokeCopies=true`);
    await same404('POST /account-secrets/grants/:id/revoke', 'POST', `/account-secrets/grants/${usedGrant.id}/revoke`, `/account-secrets/grants/${randomUUID()}/revoke`);
    await same404('POST /account-secrets/grants/:id/revoke', 'POST', `/account-secrets/grants/${cardGrant.id}/revoke`, `/account-secrets/grants/${randomUUID()}/revoke`);

    // The routes without an id answer for the caller's own rows only.
    const theirs = ok(await api('GET /account-secrets (another account)', 'GET', '/account-secrets', b.login), 200, 'their saved list').json;
    assert.deepEqual(theirs.secrets, []);
    const theirCopies = ok(await api('GET /account-secrets/grants (another account)', 'GET', '/account-secrets/grants?removed=30d', b.login), 200, 'their copies').json;
    assert.deepEqual(theirCopies.grants, []);
    // Their Add of the same label is theirs: no 409 from the first account's label, and nothing of the first account's moves.
    const theirAdd = ok(await api('POST /account-secrets (another account)', 'POST', '/account-secrets', b.login, { label: 'card key', value: canaries.refused }), 201, 'their Add');
    assert.equal((await db.accountSecret.findUniqueOrThrow({ where: { id: toUuid(theirAdd.json.id) } })).ownerId, b.userId);
    assert.deepEqual(await state(), before, 'another account wrote nothing of the first account\'s');
    const mineAgain = ok(await api('GET /account-secrets', 'GET', '/account-secrets', a.login), 200, 'the saved list').json;
    assert.ok(!mineAgain.secrets.some((s: { id: string }) => toUuid(s.id) === toUuid(theirAdd.json.id)));
  });

  await t.test('(a) Delete with revokeCopies, the owner\'s own: the copy made from it ends, and no body carried a canary', async () => {
    ok(await api('DELETE /account-secrets/:id', 'DELETE', `/account-secrets/${addedId}?revokeCopies=true`, a.login), 204, 'Delete with revokeCopies');
    assert.equal(await db.accountSecret.count({ where: { id: addedId } }), 0);
    assert.notEqual((await grantOf(usedRequest)).state, 'ACTIVE');
    ok(await api('DELETE /account-secrets/:id', 'DELETE', `/account-secrets/${cardKey.id}`, a.login), 204, 'Delete');
    assert.equal((await grantOf(cardRequest)).state, 'PENDING_DELIVERY', 'Delete without revokeCopies leaves the copy');
    const after = ok(await api('GET /account-secrets/grants?removed=30d', 'GET', '/account-secrets/grants?removed=30d', a.login), 200, 'the copies list').json;
    assert.equal(after.grants.length, 3);
    // Every body gathered, searched once more now that every canary is known.
    for (const { what, text } of bodies) {
      for (const [name, value] of Object.entries(canaries)) {
        for (const form of forms(value)) assert.ok(!text.includes(form), `${what} carries the ${name} canary as "${form}"`);
      }
    }
    assert.ok(bodies.length >= 40, `searched ${bodies.length} bodies`);
  });
});
