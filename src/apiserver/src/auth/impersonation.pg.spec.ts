/**
 * An administrator viewing Orbit as another account, read-only (auth/impersonation.ts), held against
 * the production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/impersonation.pg.spec.ts
 *
 *   (1) POST /api/admin/users/:id/impersonate answers an administrator a token for a member, and the
 *       Activity row naming the member and the reason is in the table;
 *   (2) the token reads as the member on routes of every module the guard is instantiated in — the
 *       account, session tags, tasks, sessions, runners, link previews (a POST that reads) and the
 *       control-plane stream, which takes it as a query parameter — and the member's own tag is what
 *       it reads;
 *   (3) it writes nothing: a tag, the account's name and a personal access token are refused 403
 *       IMPERSONATION_READ_ONLY and nothing was written; administration and a stored key are refused
 *       even to read; the administrator's client is not recorded as one of the member's;
 *   (4) it stops working once the administrator is disabled.
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
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

interface Account {
  id: string;
  email: string;
  password: string;
}

const readOnly = (reply: Reply) => {
  assert.equal(reply.status, 403, reply.text);
  assert.equal(reply.json?.code, 'IMPERSONATION_READ_ONLY', reply.text);
};

test('viewing Orbit as a member: every module reads as the member, nothing is written, and it ends with the administrator', {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  server = await startApiserver(url, `impersonation-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);

  const account = async (name: string, role: 'ADMIN' | 'MEMBER'): Promise<Account> => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@impersonation.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, `Viewed ${name}`, hashPassword(password), role]);
    return { id, email, password };
  };
  const signIn = async (who: Account) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };

  const admin = await account('admin', 'ADMIN');
  const second = await account('second-admin', 'ADMIN');
  const member = await account('member', 'MEMBER');
  const adminToken = await signIn(admin);
  const memberToken = await signIn(member);
  const tag = await api('POST', '/api/session-tags', memberToken, { name: `own ${RUN}`, color: '#3366ff' });
  assert.equal(tag.status, 201, tag.text);

  let viewing = '';
  await t.test('(1) an administrator is answered a token for the member, and the reason is recorded', async () => {
    const reply = await api('POST', `/api/admin/users/${member.id}/impersonate`, adminToken, { reason: `support ${RUN}` });
    assert.equal(reply.status, 201, reply.text);
    assert.equal(toUuid(reply.json.user.id), member.id);
    assert.equal(reply.json.refreshToken, undefined);
    viewing = reply.json.accessToken;
    assert.deepEqual(
      await rows(`SELECT actor_id, payload->>'userId' AS user_id, payload->>'reason' AS reason, credential_kind, credential_id
        FROM activity WHERE type = 'user.impersonated' AND actor_id = $1`, [admin.id]),
      [{ actor_id: admin.id, user_id: member.id, reason: `support ${RUN}`, credential_kind: 'LOGIN', credential_id: null }],
    );
  });

  await t.test('(2) every module reads as the member', async () => {
    const me = await api('GET', '/api/users/me', viewing);
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.email, member.email);
    const tags = await api('GET', '/api/session-tags', viewing);
    assert.equal(tags.status, 200, tags.text);
    // An account starts with a set of tags of its own; the one the member made is among what is read.
    assert.ok(tags.json.some((row: { name: string }) => row.name === `own ${RUN}`), tags.text);
    for (const route of ['/api/tasks', '/api/sessions', '/api/runners', '/api/workspaces', '/api/projects']) {
      const reply = await api('GET', route, viewing);
      assert.equal(reply.status, 200, `${route}: ${reply.text.slice(0, 300)}`);
    }
    const previews = await api('POST', '/api/link-previews', viewing, { refs: [] });
    assert.equal(previews.status, 200, previews.text);
    const stream = await api('GET', `/api/events?access_token=${encodeURIComponent(viewing)}`);
    assert.equal(stream.status, 200, stream.text);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
  });

  await t.test('(3) nothing is written with it, and administration and a stored key are not read', async () => {
    readOnly(await api('POST', '/api/session-tags', viewing, { name: `viewer ${RUN}`, color: '#ff0000' }));
    readOnly(await api('PATCH', '/api/users/me', viewing, { name: 'Renamed by the viewer' }));
    readOnly(await api('POST', '/api/access-tokens', viewing, { name: `viewer ${RUN}`, scopes: ['tasks:read'], expiresInDays: 1 }));
    for (const [method, route] of [
      ['GET', '/api/admin/users'],
      ['POST', `/api/admin/users/${member.id}/impersonate`],
      ['GET', `/api/providers/mine/${randomUUID()}/key`],
    ]) {
      const reply = await api(method, route, viewing, method === 'POST' ? { reason: 'nested' } : undefined);
      assert.equal(reply.status, 403, `${method} ${route}: ${reply.text}`);
      assert.equal(reply.json?.code, 'IMPERSONATION_FORBIDDEN', reply.text);
    }
    assert.deepEqual(await rows(`SELECT name FROM session_tag WHERE owner_id = $1 AND name LIKE 'viewer%'`, [member.id]), []);
    assert.deepEqual(await rows(`SELECT name FROM "user" WHERE id = $1`, [member.id]), [{ name: 'Viewed member' }]);
    assert.deepEqual(await rows(`SELECT id FROM personal_access_token WHERE owner_id = $1`, [member.id]), []);
    assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM activity WHERE type = 'user.impersonated'`), [{ n: 1 }]);

    // The administrator's browser is not one of the member's clients; the member's own is.
    assert.equal((await api('GET', '/api/users/me', viewing, undefined, { 'x-orbit-client': `web/9.9.9-${RUN}` })).status, 200);
    assert.equal((await api('GET', '/api/users/me', memberToken, undefined, { 'x-orbit-client': `ios/1.0.0-${RUN}` })).status, 200);
    let recorded: Array<{ kind: string; version: string }> = [];
    for (let tries = 0; tries < 40 && recorded.length === 0; tries += 1) {
      await sleep(100);
      recorded = await rows(`SELECT kind, version FROM client_version WHERE user_id = $1 ORDER BY kind`, [member.id]);
    }
    await sleep(300);
    assert.deepEqual(await rows(`SELECT kind, version FROM client_version WHERE user_id = $1 ORDER BY kind`, [member.id]), [
      { kind: 'ios', version: `1.0.0-${RUN}` },
    ]);
  });

  await t.test('(4) it stops working once the administrator is disabled', async () => {
    const disabled = await api('PATCH', `/api/admin/users/${admin.id}/disabled`, await signIn(second), { disabled: true });
    assert.equal(disabled.status, 200, disabled.text);
    const me = await api('GET', '/api/users/me', viewing);
    assert.equal(me.status, 401, me.text);
  });
});
