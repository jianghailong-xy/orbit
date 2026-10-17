/**
 * Admin → Users' Last active (`lastActiveOf` in users/admin.controller.ts), held against the production
 * apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/users/admin-users-last-active.pg.spec.ts
 *
 * Each row of GET /api/admin/users carries `lastActive`: the latest of the account's apps (`client_version`)
 * and its access tokens' uses, with what it was — or null when it has used neither. An administrator viewing
 * Orbit as the account leaves it as it was.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

interface Account {
  id: string;
  email: string;
  password: string;
}

test('Admin → Users says when each account last used Orbit, and through what', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  server = await startApiserver(url, `last-active-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);

  const account = async (name: string, role: 'ADMIN' | 'MEMBER'): Promise<Account> => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@last-active.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, name, hashPassword(password), role]);
    return { id, email, password };
  };
  const signIn = async (who: Account) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  /** One of `who`'s access tokens, used once through the API, its last use then set to `at`. */
  const tokenUsedAt = async (who: Account, at: string | null) => {
    const issued = await api('POST', '/api/access-tokens', await signIn(who), { name: `last-active ${RUN}`, scopes: ['tasks:read'], expiresInDays: 30 });
    assert.equal(issued.status, 201, issued.text);
    await sql.query(`UPDATE personal_access_token SET last_used_at = $2 WHERE owner_id = $1`, [who.id, at]);
  };
  const appSeenAt = (who: Account, kind: string, at: string) =>
    sql.query(`INSERT INTO client_version (user_id, kind, version, last_seen_at) VALUES ($1, $2, '1.0.0', $3)`, [who.id, kind, at]);

  const admin = await account('admin', 'ADMIN');
  const phone = await account('phone', 'MEMBER');
  const scripts = await account('scripts', 'MEMBER');
  const quiet = await account('quiet', 'MEMBER');
  const adminToken = await signIn(admin);

  // The phone's iOS app is the latest of its three: the web, an access token and the app.
  await appSeenAt(phone, 'web', '2026-10-01T10:00:00.000Z');
  await appSeenAt(phone, 'ios', '2026-10-03T09:00:00.000Z');
  await tokenUsedAt(phone, '2026-10-02T08:00:00.000Z');
  // An access token used after the web was.
  await appSeenAt(scripts, 'web', '2026-10-01T10:00:00.000Z');
  await tokenUsedAt(scripts, '2026-10-05T07:30:00.000Z');
  // An access token issued and never used.
  await tokenUsedAt(quiet, null);

  // An administrator viewing Orbit as the quiet account, through the web app, is not its activity.
  const look = await api('POST', `/api/admin/users/${quiet.id}/impersonate`, adminToken, { reason: `last active ${RUN}` });
  assert.equal(look.status, 201, look.text);
  assert.equal((await api('GET', '/api/users/me', look.json.accessToken, undefined, { 'x-orbit-client': `web/9.9.9-${RUN}` })).status, 200);
  await sleep(500);

  const list = await api('GET', '/api/admin/users', adminToken);
  assert.equal(list.status, 200, list.text);
  const lastActive = (who: Account) => list.json.find((row: { id: string }) => toUuid(row.id) === who.id)?.lastActive;
  assert.deepEqual(lastActive(phone), { at: '2026-10-03T09:00:00.000Z', via: 'ios' });
  assert.deepEqual(lastActive(scripts), { at: '2026-10-05T07:30:00.000Z', via: 'token' });
  assert.equal(lastActive(quiet), null);
});
