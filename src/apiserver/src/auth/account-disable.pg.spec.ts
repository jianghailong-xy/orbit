/**
 * Disabling an account (docs/google-sign-in-design.md §5.5), held against the production apiserver —
 * `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/account-disable.pg.spec.ts
 *
 *   (1) 0396: `user.disabled_at`, a timestamp, NULL, with no default and nothing indexing it;
 *   (2) PATCH /api/admin/users/:id/disabled refuses the administrator's own account, the last
 *       administrator not disabled, an account that does not exist, and a member;
 *   (3) disabling through it revokes every refresh token the account holds, records the
 *       administrator's Activity row and shows in the list. From the next request on, this server
 *       refuses every door: the password login, the Google exchange (§5.2 rows 1 and 3) and the
 *       refresh 403 ACCOUNT_DISABLED, the access token 401, the personal access token, the runner
 *       credential (both runner guards) and the service token 403 ACCOUNT_DISABLED — and a refused
 *       token writes nothing, not even the record of its refusal;
 *   (4) enabling it again: the refresh tokens the disable revoked are unknown, not a replay that ends
 *       the sessions signed in since; the password signs in; the personal access token, the runner
 *       credential and the service token work as before;
 *   (5) a disable another server writes (here, straight into the table): the runner credential and
 *       the service token are refused at once, the access token and the personal access token within
 *       30 seconds — and after the enable, the personal access token works again within 30 seconds.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DISABLED_ACCOUNTS_WITHIN_MS } from './disabled-accounts';
import { s256 } from './google-oauth.client';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `account-disable-${RUN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Account {
  id: string;
  email: string;
  password: string;
}

const disabledBody = (reply: Reply) => {
  assert.equal(reply.status, 403, reply.text);
  assert.equal(reply.json?.code, 'ACCOUNT_DISABLED', reply.text);
  assert.equal(reply.json?.message, 'This Orbit account is disabled. Ask an administrator to enable it again.');
};

test('disabling an account: every credential is refused, nothing is deleted, and enabling it lets it back in', {
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

  await t.test('(1) 0396 added user.disabled_at: a timestamp, NULL, no default, and nothing indexes or constrains it', async () => {
    assert.deepEqual(
      await rows(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0396_user_disabled_at'`),
      [{ done: true }],
    );
    assert.deepEqual(
      await rows(`SELECT udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'user' AND column_name = 'disabled_at'`),
      [{ udt_name: 'timestamp', is_nullable: 'YES', column_default: null }],
    );
    assert.deepEqual(
      await rows(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'user' AND indexdef LIKE '%disabled_at%'`),
      [],
    );
    assert.deepEqual(
      await rows(`SELECT conname FROM pg_constraint WHERE conrelid = '"user"'::regclass AND pg_get_constraintdef(oid) LIKE '%disabled_at%'`),
      [],
    );
  });

  const jwtSecret = `account-disable-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, { PROVIDER_SECRET_KEY });
  const api = (method: string, route: string, bearer?: string, body?: unknown) => call(server!, method, route, bearer, body);

  /** An account with a password, made the way an administrator's Add user leaves one. */
  const account = async (name: string, role: 'ADMIN' | 'MEMBER', email = `${name}-${RUN}@account-disable.invalid`): Promise<Account> => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, `Disable ${name}`, hashPassword(password), role]);
    return { id, email, password };
  };
  const signIn = (who: Account) => api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
  const session = async (who: Account) => {
    const reply = await signIn(who);
    assert.equal(reply.status, 201, reply.text);
    return reply.json as { accessToken: string; refreshToken: string };
  };

  const admin = await account('admin', 'ADMIN');
  const second = await account('second-admin', 'ADMIN');
  const member = await account('member', 'MEMBER');
  // Signs in with Google only by its email: a Gmail address, which §5.2 row 3 would link.
  const gmail = await account('gmail', 'MEMBER', `disable.gmail.${RUN}@gmail.com`);
  const adminToken = (await session(admin)).accessToken;
  const secondToken = (await session(second)).accessToken;

  // The member's credentials, every kind there is: two sessions (one rotated once, so a consumed token
  // is on record too), a personal access token, a runner and a service token minted by that runner.
  const first = await session(member);
  const rotated = await api('POST', '/api/auth/refresh', undefined, { refreshToken: first.refreshToken });
  assert.equal(rotated.status, 201, rotated.text);
  const phone = await session(member);
  const laptop = rotated.json as { accessToken: string; refreshToken: string };
  const issued = await api('POST', '/api/access-tokens', phone.accessToken, { name: `disable ${RUN}`, scopes: ['tasks:read', 'tasks:write'], expiresInDays: 30 });
  assert.equal(issued.status, 201, issued.text);
  const pat: string = issued.json.token;
  const runnerToken = generateToken(32);
  const runnerId = randomUUID();
  await sql.query(`INSERT INTO runner (id, owner_id, name, token_hash) VALUES ($1, $2, $3, $4)`, [runnerId, member.id, `disable-${RUN}`, sha256(runnerToken)]);
  const minted = await api('POST', '/api/runner/service-tokens', runnerToken, { scopes: ['session:list'], ttlSeconds: 3600 });
  assert.equal(minted.status, 201, minted.text);
  const serviceToken: string = minted.json.token;
  const serviceTokenId = toUuid(minted.json.id);

  // Google, on, so the exchange is answered rather than refused GOOGLE_NOT_CONFIGURED. The member's
  // Google account is linked (§5.2 row 1); the Gmail account's is not, and its email finds it (row 3).
  const configured = await api('PUT', '/api/admin/sign-in/google', adminToken, {
    enabled: true,
    clientId: `1234-${RUN}.apps.googleusercontent.com`,
    clientSecret: `GOCSPX-${RUN}-disable`,
    signupPolicy: 'EXISTING_ACCOUNTS',
  });
  assert.equal(configured.status, 200, configured.text);
  const memberSub = `member-sub-${RUN}`;
  await sql.query(
    `INSERT INTO user_identity (id, user_id, provider, subject, email, last_sign_in_at) VALUES ($1, $2, 'google', $3, $4, '2026-01-02T03:04:05Z')`,
    [randomUUID(), member.id, memberSub, `member.${RUN}@gmail.com`],
  );
  /**
   * POST /auth/google/exchange of a ticket the callback issued for this Google account — the flow
   * AUTHENTICATED with the claims it writes (google-sign-in-flow.pg.spec.ts pins that half), so Google
   * itself is not reached.
   */
  const exchange = async (claims: { sub: string; email: string }) => {
    const ticket = generateToken(32);
    const verifier = generateToken(32);
    await sql.query(
      `INSERT INTO oauth_login_flow (id, provider, intent, client, state_hash, binding_hash, nonce, provider_code_verifier,
         client_challenge, status, claims, ticket_hash, ticket_expires_at, expires_at)
       VALUES ($1, 'google', 'LOGIN', 'WEB', $2, $3, $4, $5, $6, 'AUTHENTICATED', $7, $8, now() + interval '2 minutes', now() + interval '2 minutes')`,
      [randomUUID(), sha256(generateToken(32)), sha256(generateToken(32)), generateToken(32), generateToken(32), s256(verifier),
        JSON.stringify({ ...claims, emailVerified: true, hd: null, name: null }), sha256(ticket)],
    );
    return api('POST', '/api/auth/google/exchange', undefined, { ticket, codeVerifier: verifier });
  };

  /** Every door the member's credentials use, as each answers now. */
  const doors = async () => ({
    accessToken: await api('GET', '/api/users/me', phone.accessToken),
    pat: await api('GET', '/api/pat/self', pat),
    runner: await api('GET', '/api/runner/service-tokens', runnerToken),
    runnerAtSessions: await api('GET', '/api/runner/sessions', runnerToken),
    serviceToken: await api('GET', '/api/runner/sessions', serviceToken),
  });
  const open = (answers: Record<string, Reply>) => {
    for (const [door, reply] of Object.entries(answers)) assert.equal(reply.status, 200, `${door}: ${reply.text}`);
  };
  open(await doors());
  const disable = (bearer: string, who: { id: string }, disabled: boolean) =>
    api('PATCH', `/api/admin/users/${who.id}/disabled`, bearer, { disabled });
  /** The Activity rows there are now, to read what is recorded after. */
  const activityIds = async (): Promise<string[]> => (await rows('SELECT id FROM activity')).map((row) => row.id);
  /** What was recorded since `before` (activityIds), oldest first: the ids are uuid v7. */
  const activitySince = async (before: string[]) => rows(
    `SELECT actor_id, type, payload, credential_kind, credential_id FROM activity WHERE NOT (id = ANY($1::uuid[])) ORDER BY id`,
    [before],
  );
  /**
   * When the account was disabled, as epoch milliseconds, null while it is enabled. Read as a number in
   * SQL: node-postgres would read the TIMESTAMP column as the host's local time.
   */
  const disabledMs = async (who: { id: string }): Promise<number | null> => {
    const [row] = await rows('SELECT (extract(epoch FROM disabled_at) * 1000)::float8 AS ms FROM "user" WHERE id = $1', [who.id]);
    return row.ms;
  };

  await t.test('(2) refused: the administrator\'s own account, the last administrator not disabled, nobody, and a member asking', async () => {
    const before = await activityIds();
    const own = await disable(adminToken, admin, true);
    assert.equal(own.status, 400, own.text);
    assert.equal(own.json?.message, 'you cannot disable your own account');

    const nobody = await disable(adminToken, { id: randomUUID() }, true);
    assert.equal(nobody.status, 404, nobody.text);

    const asMember = await disable(phone.accessToken, second, true);
    assert.equal(asMember.status, 403, asMember.text);

    // The last administrator not disabled. Only an administrator whose own disable has not reached
    // this server yet can ask it — one disabled on another server, within its 30 seconds — so this
    // one is disabled straight in the table. In the unlikely case that this server reads the disabled
    // accounts between that write and the request, the request is a 401 instead: ask again.
    let last: Reply | undefined;
    for (let attempt = 0; attempt < 3 && last?.status !== 400; attempt += 1) {
      await sql.query('UPDATE "user" SET disabled_at = now() WHERE id = $1', [admin.id]);
      last = await disable(adminToken, second, true);
      // The second administrator enables the first again, which also reads the disabled accounts again.
      const enabled = await disable(secondToken, admin, false);
      assert.equal(enabled.status, 200, enabled.text);
      assert.equal(enabled.json.disabledAt, null);
    }
    assert.ok(last);
    assert.equal(last.status, 400, last.text);
    assert.equal(last.json?.message, 'cannot disable the last admin');
    assert.equal(await disabledMs(second), null, 'the last administrator is not disabled');

    // Nothing refused is recorded: only the second administrator enabling the first, once a try.
    const recorded = await activitySince(before);
    assert.ok(recorded.length >= 1);
    assert.deepEqual(recorded, recorded.map(() => ({
      actor_id: second.id,
      type: 'user.enabled',
      payload: { userId: admin.id, email: admin.email },
      credential_kind: 'LOGIN',
      credential_id: null,
    })));
    open(await doors());
    assert.equal((await api('GET', '/api/users/me', adminToken)).status, 200, 'the first administrator is let back in');
  });

  await t.test('(3) disabling: refresh tokens revoked, recorded, listed — and every door refused from the next request on', async () => {
    const live = await rows('SELECT id FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id', [member.id]);
    assert.equal(live.length, 2, 'the phone and the laptop are signed in');
    const consumed = await rows('SELECT id, revoked_at FROM refresh_token WHERE user_id = $1 AND revoked_at IS NOT NULL', [member.id]);
    assert.equal(consumed.length, 1, 'the token the laptop rotated');
    const before = await activityIds();

    const reply = await disable(adminToken, member, true);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(Object.keys(reply.json).sort(), ['createdAt', 'disabledAt', 'email', 'id', 'name', 'publicId', 'role']);
    const disabledAt = await disabledMs(member);
    assert.equal(typeof disabledAt, 'number', 'disabled_at is written');
    assert.equal(new Date(reply.json.disabledAt).getTime(), disabledAt);

    // Every refresh token revoked, by the disable; the one consumed before keeps when it was consumed.
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL', [member.id]), [{ n: 0 }]);
    assert.deepEqual(
      await rows(
        `SELECT t.id, abs(extract(epoch FROM t.revoked_at) - extract(epoch FROM u.disabled_at)) < 1 AS "byTheDisable"
           FROM refresh_token t JOIN "user" u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[]) ORDER BY t.id`,
        [live.map((token) => token.id)],
      ),
      live.map((token) => ({ id: token.id, byTheDisable: true })),
    );
    assert.deepEqual(await rows('SELECT id, revoked_at FROM refresh_token WHERE id = $1', [consumed[0].id]), consumed);
    assert.deepEqual(await activitySince(before), [{
      actor_id: admin.id,
      type: 'user.disabled',
      payload: { userId: member.id, email: member.email },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);
    const listed = await api('GET', '/api/admin/users', adminToken);
    assert.equal(listed.status, 200, listed.text);
    const rowOf = (who: Account) => listed.json.find((user: Row) => toUuid(user.id) === who.id);
    assert.equal(new Date(rowOf(member).disabledAt).getTime(), disabledAt);
    assert.equal(rowOf(admin).disabledAt, null);

    // Asked again: answered as it is, and nothing written.
    const again = await disable(adminToken, member, true);
    assert.equal(again.status, 200, again.text);
    assert.equal(new Date(again.json.disabledAt).getTime(), disabledAt, 'when it was disabled stays');
    assert.equal((await activitySince(before)).length, 1);

    // This server: at once, every credential the account holds.
    const refused = await doors();
    assert.equal(refused.accessToken.status, 401, `an access token is a 401, so the client refreshes: ${refused.accessToken.text}`);
    assert.equal(refused.accessToken.json?.code, undefined);
    disabledBody(refused.pat);
    disabledBody(refused.runner);
    disabledBody(refused.runnerAtSessions);
    disabledBody(refused.serviceToken);
  });

  await t.test('(3) the password login, the Google exchange and the refresh: 403 ACCOUNT_DISABLED, and nothing written', async () => {
    const tokensBefore = await rows('SELECT * FROM refresh_token ORDER BY id');
    const identitiesBefore = await rows('SELECT * FROM user_identity ORDER BY id');
    const activityBefore = await rows('SELECT id FROM activity ORDER BY id');

    disabledBody(await signIn(member));
    // A wrong password is answered as ever: that an account is disabled is told only past its password.
    const wrong = await api('POST', '/api/auth/login', undefined, { email: member.email, password: 'not-the-password' });
    assert.equal(wrong.status, 401, wrong.text);
    assert.equal(wrong.json?.code, undefined);

    // §5.2 row 1, the linked Google account: refused before its identity is touched.
    disabledBody(await exchange({ sub: memberSub, email: `member.${RUN}@gmail.com` }));

    // The refresh: each token the disable revoked, and the one consumed before it — the reason, not a
    // replay that would end what is left.
    for (const refreshToken of [phone.refreshToken, laptop.refreshToken, first.refreshToken]) {
      disabledBody(await api('POST', '/api/auth/refresh', undefined, { refreshToken }));
    }

    // §5.2 row 3: the Gmail account, disabled too, would be linked by its authoritative email — it is not.
    assert.equal((await disable(adminToken, gmail, true)).status, 200);
    const gmailActivity = await rows(`SELECT id FROM activity WHERE type = 'user.disabled' AND payload->>'userId' = $1`, [gmail.id]);
    assert.equal(gmailActivity.length, 1);
    disabledBody(await exchange({ sub: `gmail-sub-${RUN}`, email: gmail.email }));
    disabledBody(await signIn(gmail));

    assert.deepEqual(await rows('SELECT * FROM refresh_token ORDER BY id'), tokensBefore, 'no token issued, rotated or revoked');
    assert.deepEqual(await rows('SELECT * FROM user_identity ORDER BY id'), identitiesBefore, 'no Google account linked, and no identity touched');
    assert.deepEqual(
      (await rows('SELECT id FROM activity ORDER BY id')).filter((row) => !activityBefore.some((old) => old.id === row.id)),
      gmailActivity,
      'nothing recorded but the Gmail account\'s disable',
    );
  });

  await t.test('(3) a disabled account\'s tokens write nothing: no task, no record of the refused write, no last use', async () => {
    // Last used an hour ago, so a use now would be recorded: a token's use is written at most once a minute.
    await sql.query(`UPDATE personal_access_token SET last_used_at = now() - interval '1 hour' WHERE owner_id = $1`, [member.id]);
    const [patRow] = await rows('SELECT last_used_at FROM personal_access_token WHERE owner_id = $1', [member.id]);
    const [serviceRow] = await rows('SELECT last_used_at FROM service_token WHERE id = $1', [serviceTokenId]);
    const activityBefore = await rows('SELECT id FROM activity ORDER BY id');
    disabledBody(await api('POST', '/api/tasks', pat, { title: `written while disabled ${RUN}`, completionCriterion: 'OWNER_CONFIRMED' }));
    disabledBody(await api('GET', '/api/runner/sessions', serviceToken));
    assert.deepEqual(await rows('SELECT id FROM task WHERE owner_id = $1', [member.id]), []);
    assert.deepEqual(await rows('SELECT id FROM activity ORDER BY id'), activityBefore, 'not even the record of a refused write');
    assert.deepEqual(await rows('SELECT last_used_at FROM personal_access_token WHERE owner_id = $1', [member.id]), [patRow]);
    assert.deepEqual(await rows('SELECT last_used_at FROM service_token WHERE id = $1', [serviceTokenId]), [serviceRow]);
    assert.deepEqual(await rows('SELECT revoked_at FROM personal_access_token WHERE owner_id = $1', [member.id]), [{ revoked_at: null }],
      'the personal access token is kept, only refused');
  });

  await t.test('(4) enabling: the revoked refresh tokens are unknown, the password signs in, and every token works as before', async () => {
    const before = await activityIds();
    const reply = await disable(adminToken, member, false);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.disabledAt, null);
    assert.equal(await disabledMs(member), null);
    assert.deepEqual(await activitySince(before), [{
      actor_id: admin.id,
      type: 'user.enabled',
      payload: { userId: member.id, email: member.email },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM refresh_token WHERE user_id = $1', [member.id]), [{ n: 0 }],
      'the refresh tokens the disable revoked are deleted');

    // The access token signed before the disable works again: it was refused, never revoked.
    open(await doors());

    // Signs in again, on the phone. The laptop still holds the token the disable revoked: it is told the
    // token is unknown — and does not end the phone's new session as a replayed token would.
    const again = await signIn(member);
    assert.equal(again.status, 201, again.text);
    const stale = await api('POST', '/api/auth/refresh', undefined, { refreshToken: laptop.refreshToken });
    assert.equal(stale.status, 401, stale.text);
    assert.equal(stale.json?.message, 'invalid refresh token');
    const fresh = await api('POST', '/api/auth/refresh', undefined, { refreshToken: again.json.refreshToken });
    assert.equal(fresh.status, 201, `the phone's new session goes on: ${fresh.text}`);

    // Google too: the linked account signs in again.
    const google = await exchange({ sub: memberSub, email: `member.${RUN}@gmail.com` });
    assert.equal(google.status, 201, google.text);
    assert.equal(toUuid(google.json.user.id), member.id);
  });

  await t.test('(5) a disable another server writes: runner and service token at once, access token and PAT within 30 seconds', async () => {
    const tokens = await session(member);
    open(await doors());
    const written = Date.now();
    await sql.query('UPDATE "user" SET disabled_at = now() WHERE id = $1', [member.id]);

    // Read with the runner in the one query each already makes: at once.
    disabledBody(await api('GET', '/api/runner/service-tokens', runnerToken));
    disabledBody(await api('GET', '/api/runner/sessions', serviceToken));
    // So is the refresh, the password login, which read the account.
    disabledBody(await api('POST', '/api/auth/refresh', undefined, { refreshToken: tokens.refreshToken }));
    disabledBody(await signIn(member));

    // The access token and the personal access token: once this server reads the disabled accounts again,
    // within the 30 seconds §5.5 promises — no grace on top.
    const deadline = written + DISABLED_ACCOUNTS_WITHIN_MS;
    let access = await api('GET', '/api/users/me', tokens.accessToken);
    let byPat = await api('GET', '/api/pat/self', pat);
    while ((access.status !== 401 || byPat.status !== 403) && Date.now() < deadline) {
      await sleep(250);
      access = await api('GET', '/api/users/me', tokens.accessToken);
      byPat = await api('GET', '/api/pat/self', pat);
    }
    const tookMs = Date.now() - written;
    assert.equal(access.status, 401, `the access token is refused within ${DISABLED_ACCOUNTS_WITHIN_MS} ms (${tookMs} ms): ${access.text}`);
    disabledBody(byPat);
    assert.ok(tookMs <= DISABLED_ACCOUNTS_WITHIN_MS, `refused within ${DISABLED_ACCOUNTS_WITHIN_MS} ms, not ${tookMs} ms`);
    t.diagnostic(`access token and personal access token refused ${tookMs} ms after the disable was written`);

    // Enabled the same way: the personal access token works again, as before, within the same 30 seconds.
    const enabledAt = Date.now();
    await sql.query('UPDATE "user" SET disabled_at = NULL WHERE id = $1', [member.id]);
    assert.equal((await api('GET', '/api/runner/service-tokens', runnerToken)).status, 200, 'the runner at once');
    let back = await api('GET', '/api/pat/self', pat);
    while (back.status !== 200 && Date.now() < enabledAt + DISABLED_ACCOUNTS_WITHIN_MS) {
      await sleep(250);
      back = await api('GET', '/api/pat/self', pat);
    }
    const backMs = Date.now() - enabledAt;
    assert.equal(back.status, 200, `the personal access token works again within ${DISABLED_ACCOUNTS_WITHIN_MS} ms (${backMs} ms): ${back.text}`);
    assert.ok(backMs <= DISABLED_ACCOUNTS_WITHIN_MS, `working again within ${DISABLED_ACCOUNTS_WITHIN_MS} ms, not ${backMs} ms`);
    t.diagnostic(`personal access token working again ${backMs} ms after the enable was written`);
    open(await doors());
  });
});
