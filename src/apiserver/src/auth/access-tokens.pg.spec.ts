/**
 * Personal access tokens managed signed in to Orbit, and a token reading itself
 * (docs/personal-access-token-design.md §6.5, §9, §11), held against the production apiserver —
 * `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. What it is held to:
 *
 *   (1) POST /access-tokens with a login issues a token: the answer carries it — the only answer of
 *       this run that ever does — and the row keeps its sha256; it is created WEB and lives 90 days
 *       when no lifetime is chosen, 30 or 365 when chosen, and never expires when null is; a lifetime
 *       other than those, a scope that does not exist, a blank name and another user's workspace are
 *       refused before anything is written;
 *   (2) GET /access-tokens lists the caller's own tokens, newest first, without the token: where each
 *       stands, and when and from where it was last used;
 *   (3) DELETE /access-tokens/:id revokes at once (USER): the token is 401 on its next request, a
 *       second DELETE answers the same, and another user's token is not found;
 *   (4) a token issued never to expire works, and lists with no expiry;
 *   (5) an administrator lists another user's tokens — never the token — and revokes one (ADMIN),
 *       which is 401 at once; a member is refused both, and an unknown user or another user's
 *       token is not found;
 *   (6) POST /auth/change-password revokes no token unless asked; with revokeAccessTokens it revokes
 *       every live one (PASSWORD_CHANGED, while one already past its expiry is settled EXPIRED), each
 *       401 at once, and says how many; a wrong current password revokes nothing;
 *   (7) GET /pat/self answers any token — one holding a single unrelated scope, one confined to a
 *       workspace — with its user and what it holds; a login is 400 NOT_A_PERSONAL_ACCESS_TOKEN, and
 *       a revoked or unknown token 401; being a read, it leaves no request-level audit row (§6.4);
 *   (8) a token holding every scope is refused each /access-tokens route and each of an
 *       administrator's token routes — 403 PAT_FORBIDDEN, reason TOKEN_MANAGEMENT or ADMIN — and the
 *       token table and both users are, byte for byte, what they were; the only rows the refusals
 *       leave are the request audit's record of them, one pat.request.denied for each write and none
 *       for a read; the same requests with a login do their work.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/access-tokens.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { AdminController } from '../users/admin.controller';
import { AccessTokensController } from './access-tokens.controller';
import { PAT_FORBIDDEN_REASONS, type PatForbiddenReason } from './pat-scope.decorator';
import { PAT_PREFIX, PAT_SCOPES } from './pat.service';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;
const INVALID_TOKEN = { message: 'invalid token', error: 'Unauthorized', statusCode: 401 };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What a route closed to every token answers one with. */
const REFUSED = (reason: PatForbiddenReason) => ({
  code: 'PAT_FORBIDDEN',
  reason,
  requiredAction: 'OPEN_ORBIT',
  message: PAT_FORBIDDEN_REASONS[reason],
});

/** `METHOD /path` of every route `controller` answers whose path names access tokens. */
function tokenRoutesOf(controller: Function): string[] {
  const join = (...parts: string[]) => '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) return [];
    const route = `${RequestMethod[method]} ${join(prefix, String(Reflect.getMetadata(PATH_METADATA, handler) ?? ''))}`;
    return route.includes('access-tokens') ? [route] : [];
  });
}

async function eventually<T>(what: string, check: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

test('access tokens: issued, listed and revoked signed in; an administrator\'s list and revoke; the password change\'s choice; the token reading itself; and every token route closed to a token', {
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

  // An administrator with a workspace, a member, and somebody else's workspace.
  async function user(name: string, role: 'ADMIN' | 'MEMBER', password: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@access-tokens.invalid`;
    await db.user.create({ data: { id, email, name, role, passwordHash: hashPassword(password) } });
    return { id, email };
  }
  async function workspaceOf(owner: { id: string }) {
    const runnerId = randomUUID();
    const id = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: owner.id, name: 'a runner', tokenHash: `access-tokens-${runnerId}` } });
    await db.workspace.create({ data: { id, ownerId: owner.id, runnerId, name: `orbit ${RUN}`, enabled: true } });
    return id;
  }
  const admin = await user('admin', 'ADMIN', 'admin-password-1');
  const member = await user('member', 'MEMBER', 'member-password-1');
  const stranger = await user('stranger', 'MEMBER', 'stranger-password-1');
  const workspaceId = await workspaceOf(admin);
  const theirWorkspaceId = await workspaceOf(stranger);

  const jwtSecret = `access-tokens-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const adminLogin = await jwt.signAsync({ sub: admin.id, email: admin.email });
  const memberLogin = await jwt.signAsync({ sub: member.id, email: member.email });
  server = await startApiserver(url, jwtSecret);

  /** Every answer this run is given, so (9) can say where a token ever appeared. */
  const answers: Array<{ request: string; text: string }> = [];
  const api = async (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> => {
    const reply = await call(server!, method, `/api${path}`, bearer, body);
    answers.push({ request: `${method} ${path}`, text: reply.text });
    return reply;
  };
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = async (publicId: string): Promise<any> =>
    (await sql.query('SELECT * FROM personal_access_token WHERE id = $1', [toUuid(publicId)])).rows[0];
  const rowsOf = async (owner: { id: string }) =>
    (await sql.query('SELECT count(*)::int AS n FROM personal_access_token WHERE owner_id = $1', [owner.id])).rows[0].n;
  /** Every request-level audit row (§6.4) of this run's users, in no particular order. */
  const auditRows = async (): Promise<Array<{ id: string; type: string; credential_id: string; payload: unknown }>> => (await sql.query(
    `SELECT id, type, credential_id, payload FROM activity
      WHERE actor_id = ANY($1::uuid[]) AND type IN ('pat.request', 'pat.request.denied')`,
    [[admin.id, member.id, stranger.id]],
  )).rows;
  /** Issue through the door the settings page uses. */
  const issue = async (bearer: string, body: Record<string, unknown>) =>
    expect(await api('POST', '/access-tokens', bearer, { scopes: ['tasks:read'], ...body }), 201, `issuing ${String(body.name)}`);
  const self = (bearer: string) => api('GET', '/pat/self', bearer);
  const nearly = (iso: string | null, days: number) =>
    iso !== null && Math.abs(new Date(iso).getTime() - (Date.now() + days * DAY_MS)) < 120_000;
  const issuedTokens: string[] = [];

  let laptop: { id: string; token: string };
  await t.test('(1) POST /access-tokens issues a token with a login: 90 days unless chosen, 30, 365 or never; refused input writes nothing', async () => {
    const issued = await issue(adminLogin, {
      name: 'laptop script',
      scopes: ['tasks:read', 'tasks:write'],
      workspaceIds: [uuidToBase62(workspaceId)],
    });
    laptop = issued;
    issuedTokens.push(issued.token);
    assert.match(issued.token, /^orbit_pat_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.name, 'laptop script');
    assert.deepEqual(issued.scopes, ['tasks:read', 'tasks:write']);
    assert.deepEqual(issued.workspaceIds.map(toUuid), [workspaceId]);
    assert.equal(issued.createdVia, 'WEB');
    assert.equal(issued.tokenHint, issued.token.slice(-4));
    assert.ok(nearly(issued.expiresAt, 90), `ninety days when no lifetime is chosen: ${issued.expiresAt}`);
    assert.ok(!('tokenHash' in issued));

    const stored = await row(issued.id);
    assert.equal(stored.owner_id, admin.id);
    assert.equal(stored.token_hash, sha256(issued.token));
    assert.equal(stored.created_via, 'WEB');
    assert.deepEqual(stored.workspace_ids, [workspaceId]);

    for (const days of [30, 90, 365]) {
      const chosen = await issue(adminLogin, { name: `${days} days`, expiresInDays: days });
      issuedTokens.push(chosen.token);
      assert.ok(nearly(chosen.expiresAt, days), `${days} days: ${chosen.expiresAt}`);
    }
    const forever = await issue(adminLogin, { name: 'never expires', expiresInDays: null });
    issuedTokens.push(forever.token);
    assert.equal(forever.expiresAt, null);
    assert.equal((await row(forever.id)).expires_at, null);

    const before = await rowsOf(admin);
    const refused: Array<[string, Record<string, unknown>, number]> = [
      ['a week', { expiresInDays: 7 }, 400],
      ['zero days', { expiresInDays: 0 }, 400],
      ['two years', { expiresInDays: 730 }, 400],
      ['ninety as text', { expiresInDays: '90' }, 400],
      ['a scope that does not exist', { scopes: ['tasks:read', 'admin:write'] }, 400],
      ['no scope', { scopes: [] }, 400],
      ['a blank name', { name: '   ' }, 400],
      ["another user's workspace", { workspaceIds: [uuidToBase62(workspaceId), uuidToBase62(theirWorkspaceId)] }, 404],
      ['a workspace id that is not one', { workspaceIds: ['not an id'] }, 400],
    ];
    for (const [what, body, status] of refused) {
      expect(await api('POST', '/access-tokens', adminLogin, { name: `refused: ${what}`, scopes: ['tasks:read'], ...body }), status, what);
    }
    assert.equal(await rowsOf(admin), before, 'nothing refused was written');
  });

  await t.test('(2) GET /access-tokens lists the caller\'s own tokens, newest first, without the token, with where each stands and its last use', async () => {
    expect(await self(laptop.token), 200, 'using the laptop token');
    await eventually('the use to be recorded', async () => ((await row(laptop.id)).last_used_at ? true : null));

    const listed = expect(await api('GET', '/access-tokens', adminLogin), 200, 'listing');
    assert.deepEqual(
      listed.tokens.map((token: { name: string }) => token.name),
      ['never expires', '365 days', '90 days', '30 days', 'laptop script'],
    );
    const item = listed.tokens.find((token: { id: string }) => token.id === laptop.id);
    assert.equal(item.state, 'ACTIVE');
    assert.equal(item.tokenHint, laptop.token.slice(-4));
    assert.deepEqual(item.scopes, ['tasks:read', 'tasks:write']);
    assert.deepEqual(item.workspaceIds.map(toUuid), [workspaceId]);
    assert.deepEqual(item.workspaces.map((w: { id: string; name: string }) => [toUuid(w.id), w.name]), [[workspaceId, `orbit ${RUN}`]]);
    assert.equal(item.createdVia, 'WEB');
    assert.ok(item.lastUsedAt, 'last used');
    assert.match(item.lastUsedIp, /127\.0\.0\.1$/);
    assert.equal(item.revokedAt, null);
    for (const token of listed.tokens) {
      assert.ok(!('token' in token) && !('tokenHash' in token), `${token.name}: no token, no hash`);
    }
    assert.equal(listed.tokens.find((token: { name: string }) => token.name === 'never expires').expiresAt, null);

    // The member has none of the administrator's.
    assert.deepEqual(expect(await api('GET', '/access-tokens', memberLogin), 200, "the member's list").tokens, []);
  });

  await t.test('(3) DELETE /access-tokens/:id revokes at once and again answers the same; another user\'s token is not found', async () => {
    const doomed = await issue(adminLogin, { name: 'to revoke' });
    issuedTokens.push(doomed.token);
    expect(await self(doomed.token), 200, 'before revoking');

    expect(await api('DELETE', `/access-tokens/${doomed.id}`, memberLogin), 404, "the member revoking the administrator's token");
    assert.equal((await row(doomed.id)).revoked_at, null);

    const revoked = expect(await api('DELETE', `/access-tokens/${doomed.id}`, adminLogin), 200, 'revoking');
    assert.equal(revoked.revokedReason, 'USER');
    assert.ok(revoked.revokedAt);
    const after = await self(doomed.token);
    assert.equal(after.status, 401, after.text);
    assert.deepEqual(after.json, INVALID_TOKEN);
    assert.deepEqual(expect(await api('DELETE', `/access-tokens/${doomed.id}`, adminLogin), 200, 'revoking again'), revoked);
    expect(await api('DELETE', `/access-tokens/${uuidToBase62(randomUUID())}`, adminLogin), 404, 'revoking nothing');

    const listed = expect(await api('GET', '/access-tokens', adminLogin), 200, 'listing').tokens;
    const item = listed.find((token: { id: string }) => token.id === doomed.id);
    assert.deepEqual([item.state, item.revokedReason], ['REVOKED', 'USER']);
  });

  await t.test('(4) a token issued never to expire works, ten years on as on the day', async () => {
    const forever = await issue(adminLogin, { name: 'forever', expiresInDays: null, scopes: ['wiki:read'] });
    issuedTokens.push(forever.token);
    expect(await self(forever.token), 200, 'the day it was issued');
    await sql.query(`UPDATE personal_access_token SET created_at = now() - interval '10 years' WHERE id = $1`, [toUuid(forever.id)]);
    const later = expect(await self(forever.token), 200, 'ten years on');
    assert.equal(later.token.expiresAt, null);
    const item = expect(await api('GET', '/access-tokens', adminLogin), 200, 'listing').tokens
      .find((token: { id: string }) => token.id === forever.id);
    assert.deepEqual([item.state, item.expiresAt], ['ACTIVE', null]);
  });

  let memberCi: { id: string; token: string };
  await t.test('(5) an administrator lists another user\'s tokens — never the token — and revokes one, recorded ADMIN', async () => {
    memberCi = await issue(memberLogin, { name: 'ci' });
    const memberLaptop = await issue(memberLogin, { name: 'laptop', expiresInDays: 30 });
    issuedTokens.push(memberCi.token, memberLaptop.token);

    const route = `/admin/users/${uuidToBase62(member.id)}/access-tokens`;
    const listed = expect(await api('GET', route, adminLogin), 200, "the administrator listing the member's tokens");
    assert.deepEqual(listed.tokens.map((token: { name: string }) => token.name), ['laptop', 'ci']);
    for (const token of listed.tokens) assert.ok(!('token' in token) && !('tokenHash' in token), token.name);

    // A member is no administrator; an unknown user and another user's token are not found.
    const asMember = await api('GET', `/admin/users/${uuidToBase62(admin.id)}/access-tokens`, memberLogin);
    assert.equal(asMember.status, 403, asMember.text);
    assert.equal(asMember.json?.message, 'admin only');
    assert.equal((await api('DELETE', `${route}/${memberLaptop.id}`, memberLogin)).status, 403);
    expect(await api('GET', `/admin/users/${uuidToBase62(randomUUID())}/access-tokens`, adminLogin), 404, 'an unknown user');
    expect(await api('DELETE', `${route}/${laptop.id}`, adminLogin), 404, "the administrator's own token under the member");
    assert.equal((await row(laptop.id)).revoked_at, null);

    const revoked = expect(await api('DELETE', `${route}/${memberLaptop.id}`, adminLogin), 200, 'the administrator revoking');
    assert.equal(revoked.revokedReason, 'ADMIN');
    assert.equal((await row(memberLaptop.id)).revoked_reason, 'ADMIN');
    assert.deepEqual((await self(memberLaptop.token)).json, INVALID_TOKEN);
    expect(await self(memberCi.token), 200, 'the token left alone');
    const theirs = expect(await api('GET', '/access-tokens', memberLogin), 200, "the member's own list").tokens;
    assert.deepEqual(
      theirs.map((token: { name: string; state: string; revokedReason: string | null }) => [token.name, token.state, token.revokedReason]),
      [['laptop', 'REVOKED', 'ADMIN'], ['ci', 'ACTIVE', null]],
    );
  });

  await t.test('(6) changing the password revokes no token unless asked; asked, it revokes every live one PASSWORD_CHANGED', async () => {
    const scheduled = await issue(memberLogin, { name: 'cron' });
    const lapsed = await issue(memberLogin, { name: 'lapsed', expiresInDays: 30 });
    issuedTokens.push(scheduled.token, lapsed.token);
    await sql.query(`UPDATE personal_access_token SET expires_at = now() - interval '1 second' WHERE id = $1`, [toUuid(lapsed.id)]);

    const plain = expect(await api('POST', '/auth/change-password', memberLogin, {
      currentPassword: 'member-password-1',
      newPassword: 'member-password-2',
    }), 201, 'changing the password');
    assert.deepEqual(plain, { success: true, revokedAccessTokens: 0 });
    for (const token of [memberCi, scheduled]) expect(await self(token.token), 200, 'a token after a plain password change');

    // A wrong current password is refused before anything is revoked.
    expect(await api('POST', '/auth/change-password', memberLogin, {
      currentPassword: 'not-the-password',
      newPassword: 'member-password-3',
      revokeAccessTokens: true,
    }), 400, 'a wrong current password');
    for (const token of [memberCi, scheduled]) assert.equal((await row(token.id)).revoked_at, null);

    const asked = expect(await api('POST', '/auth/change-password', memberLogin, {
      currentPassword: 'member-password-2',
      newPassword: 'member-password-3',
      revokeAccessTokens: true,
    }), 201, 'changing the password and revoking the tokens');
    assert.deepEqual(asked, { success: true, revokedAccessTokens: 2 });
    for (const token of [memberCi, scheduled]) {
      const stored = await row(token.id);
      assert.equal(stored.revoked_reason, 'PASSWORD_CHANGED');
      assert.ok(stored.revoked_at instanceof Date);
      assert.deepEqual((await self(token.token)).json, INVALID_TOKEN);
    }
    assert.equal((await row(lapsed.id)).revoked_reason, 'EXPIRED', 'past its expiry, it expired — the password change did not end it');
    // The administrator's revoke is not rewritten, and the administrator's own tokens are not touched.
    const listed = expect(await api('GET', '/access-tokens', memberLogin), 200, "the member's list").tokens;
    assert.deepEqual(
      listed.map((token: { name: string; state: string; revokedReason: string | null }) => [token.name, token.state, token.revokedReason]),
      [
        ['lapsed', 'EXPIRED', 'EXPIRED'],
        ['cron', 'REVOKED', 'PASSWORD_CHANGED'],
        ['laptop', 'REVOKED', 'ADMIN'],
        ['ci', 'REVOKED', 'PASSWORD_CHANGED'],
      ],
    );
    expect(await self(laptop.token), 200, "the administrator's token");
  });

  await t.test('(7) GET /pat/self answers any token with its user and what it holds; a login is 400, a revoked or unknown token 401', async () => {
    const narrow = await issue(adminLogin, { name: 'wiki reader', scopes: ['wiki:read'], expiresInDays: 30 });
    issuedTokens.push(narrow.token);
    const answer = expect(await self(narrow.token), 200, 'a token holding only wiki:read');
    assert.equal(toUuid(answer.userId), admin.id);
    assert.equal(answer.email, admin.email);
    assert.equal(answer.token.id, narrow.id);
    assert.equal(answer.token.name, 'wiki reader');
    assert.deepEqual(answer.token.scopes, ['wiki:read']);
    assert.deepEqual(answer.token.workspaceIds, []);
    assert.equal(answer.token.expiresAt, narrow.expiresAt);
    assert.ok(!('token' in answer.token) && !('tokenHash' in answer.token));

    // Confined to a workspace, it still reads itself: nothing it names is judged.
    const confined = expect(await self(laptop.token), 200, 'a token confined to a workspace');
    assert.deepEqual(confined.token.workspaceIds.map(toUuid), [workspaceId]);
    assert.deepEqual(confined.token.scopes, ['tasks:read', 'tasks:write']);

    const signedIn = await self(adminLogin);
    assert.equal(signedIn.status, 400, signedIn.text);
    assert.equal(signedIn.json.code, 'NOT_A_PERSONAL_ACCESS_TOKEN');
    assert.match(signedIn.json.message, /not with a personal access token/);
    for (const dead of [memberCi.token, PAT_PREFIX + randomBytes(32).toString('base64url')]) {
      const refused = await self(dead);
      assert.equal(refused.status, 401, refused.text);
      assert.deepEqual(refused.json, INVALID_TOKEN);
    }

    // Every token request so far was GET /pat/self. A read, it goes through the request audit as any
    // other read does and is not recorded: a row for any of them would have been written right after
    // its answer, so the next token write has to be the only row there is.
    await sleep(500);
    const write = await api('DELETE', `/access-tokens/${narrow.id}`, narrow.token);
    assert.equal(write.status, 403, write.text);
    const rows = await eventually('the write to be recorded', async () => {
      const recorded = await auditRows();
      return recorded.length > 0 ? recorded.map(({ id: _id, ...row }) => row) : null;
    });
    assert.deepEqual(rows, [{
      type: 'pat.request.denied',
      credential_id: toUuid(narrow.id),
      payload: {
        method: 'DELETE',
        route: '/access-tokens/:id',
        status: 403,
        params: { id: narrow.id },
        code: 'PAT_FORBIDDEN',
        reason: 'TOKEN_MANAGEMENT',
      },
    }]);
  });

  await t.test('(8) a token holding every scope is refused every token route, TOKEN_MANAGEMENT or ADMIN, and writes nothing; a login does the same work', async () => {
    const everything = await issue(adminLogin, { name: 'every scope', scopes: [...PAT_SCOPES] });
    const victim = await issue(adminLogin, { name: 'victim' });
    const theirs = await issue(memberLogin, { name: 'theirs' });
    issuedTokens.push(everything.token, victim.token, theirs.token);
    const memberRoute = `/admin/users/${uuidToBase62(member.id)}/access-tokens`;
    const doors: Array<{
      route: string; method: string; path: string; body?: unknown; params?: Record<string, string>; reason: PatForbiddenReason; login: number;
    }> = [
      { route: 'POST /access-tokens', method: 'POST', path: '/access-tokens', body: { name: 'minted by a token', scopes: ['tasks:read'] }, params: {}, reason: 'TOKEN_MANAGEMENT', login: 201 },
      { route: 'GET /access-tokens', method: 'GET', path: '/access-tokens', reason: 'TOKEN_MANAGEMENT', login: 200 },
      { route: 'DELETE /access-tokens/:id', method: 'DELETE', path: `/access-tokens/${victim.id}`, params: { id: victim.id }, reason: 'TOKEN_MANAGEMENT', login: 200 },
      { route: 'GET /admin/users/:id/access-tokens', method: 'GET', path: memberRoute, reason: 'ADMIN', login: 200 },
      {
        route: 'DELETE /admin/users/:id/access-tokens/:tokenId', method: 'DELETE', path: `${memberRoute}/${theirs.id}`,
        params: { id: uuidToBase62(member.id), tokenId: theirs.id }, reason: 'ADMIN', login: 200,
      },
    ];
    // Every route the app has for tokens is knocked on, and nothing else is.
    assert.deepEqual(
      [...tokenRoutesOf(AccessTokensController), ...tokenRoutesOf(AdminController)].sort(),
      doors.map((door) => door.route).sort(),
    );
    // A token revoking itself is a door of its own to try.
    doors.push({ route: 'DELETE /access-tokens/:id', method: 'DELETE', path: `/access-tokens/${everything.id}`, params: { id: everything.id }, reason: 'TOKEN_MANAGEMENT', login: 200 });

    // What the doors would write: every token row, and both users. The calling token's last use is
    // pinned to now, so the guard's once-a-minute record of it writes nothing while the doors refuse.
    await sql.query('UPDATE personal_access_token SET last_used_at = now() WHERE id = $1', [toUuid(everything.id)]);
    const snapshot = async () => JSON.stringify([
      (await sql.query('SELECT * FROM personal_access_token ORDER BY id')).rows,
      (await sql.query('SELECT * FROM "user" WHERE id = ANY($1::uuid[]) ORDER BY id', [[admin.id, member.id]])).rows,
    ]);
    // Earlier requests' own last-use records are not awaited by them: start from a table at rest.
    let before = await snapshot();
    for (let settled = false; !settled;) {
      await sleep(300);
      const again = await snapshot();
      settled = again === before;
      before = again;
    }
    const recordedBefore = new Set((await auditRows()).map((row) => row.id));
    for (const door of doors) {
      const answer = await api(door.method, door.path, everything.token, door.body);
      assert.equal(answer.status, 403, `${door.method} ${door.path}: ${answer.text}`);
      assert.deepEqual(answer.json, REFUSED(door.reason), `${door.method} ${door.path}`);
    }
    // The request audit (§6.4) records each refused write once its answer has gone out: that record
    // is the only row the refusals leave, one per write and none for a read.
    const writes = doors.filter((door) => door.method !== 'GET');
    const records = async () =>
      (await auditRows()).filter((row) => !recordedBefore.has(row.id)).map(({ id: _id, ...row }) => row);
    await eventually('every refused write to be recorded', async () => ((await records()).length >= writes.length ? true : null));
    await sleep(500);
    // jsonb keeps its keys in an order of its own: rows are put in order by their keys sorted.
    const sorted = (value: unknown): string => JSON.stringify(value, (_key, field) => (
      field && typeof field === 'object' && !Array.isArray(field) ? Object.fromEntries(Object.entries(field).sort()) : field
    ));
    const ordered = (rows: unknown[]) => [...rows].sort((a, b) => sorted(a).localeCompare(sorted(b)));
    assert.deepEqual(ordered(await records()), ordered(writes.map((door) => ({
      type: 'pat.request.denied',
      credential_id: toUuid(everything.id),
      payload: {
        method: door.method,
        route: door.route.slice(door.method.length + 1),
        status: 403,
        params: door.params,
        code: 'PAT_FORBIDDEN',
        reason: door.reason,
      },
    }))));
    assert.equal(await snapshot(), before, 'a refused token wrote nothing but the record of its refusal');

    // The same requests, signed in: each does its work.
    const tokensBefore = (await sql.query('SELECT count(*)::int AS n FROM personal_access_token')).rows[0].n;
    for (const door of doors) expect(await api(door.method, door.path, adminLogin, door.body), door.login, `${door.method} ${door.path} signed in`);
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM personal_access_token')).rows[0].n, tokensBefore + 1, 'the login issued one');
    assert.equal((await row(victim.id)).revoked_reason, 'USER');
    assert.equal((await row(everything.id)).revoked_reason, 'USER');
    assert.equal((await row(theirs.id)).revoked_reason, 'ADMIN');
    const minted = (await sql.query(`SELECT owner_id, created_via FROM personal_access_token WHERE name = 'minted by a token'`)).rows;
    assert.deepEqual(minted, [{ owner_id: admin.id, created_via: 'WEB' }]);
  });

  await t.test('(9) every token issued appears in exactly one answer of this run — the one that issued it', async () => {
    assert.ok(issuedTokens.length >= 15, `${issuedTokens.length} tokens`);
    for (const token of issuedTokens) {
      const secret = token.slice(PAT_PREFIX.length);
      const holding = answers.filter((answer) => answer.text.includes(secret)).map((answer) => answer.request);
      assert.deepEqual(holding, ['POST /access-tokens'], `…${token.slice(-4)}`);
    }
  });
});
