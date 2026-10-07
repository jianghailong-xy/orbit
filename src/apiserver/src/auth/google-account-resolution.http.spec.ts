process.env.PROVIDER_SECRET_KEY = 'google-account-resolution-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { Prisma } from '@prisma/client';

import { generateToken, hashPassword, sha256, verifyPassword } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { RESOLUTION_CASES, tagged } from '../test-support/google-account-resolution-cases';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { AdminController } from '../users/admin.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService, googleIsAuthoritative, IDENTITY_LINKED_ACTIVITY } from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PatService } from './pat.service';
import { SIGNUP_POLICIES, SignInProvidersService, type SignupPolicy } from './sign-in-providers.service';

/**
 * Which Orbit account a Google sign-in signs in as (docs/google-sign-in-design.md §5.2), and the doors
 * an account without a password changes (§5.1, §5.4):
 *
 *   - the table of §5.2 — every row of both its tables but ACCOUNT_DISABLED, which X1 adds — under
 *     each sign-up policy (test-support/google-account-resolution-cases.ts), through POST
 *     /auth/google/exchange: who is signed in, what is linked, opened and recorded in Activity, and
 *     that a refusal writes nothing;
 *   - which emails Google is authoritative for;
 *   - two first sign-ins of one Google account at once: the one whose write meets the other's unique
 *     key reads once more, and only once;
 *   - an account without a password at the password login and the password change;
 *   - POST /admin/users with `passwordless`.
 *
 * Over real HTTP, through the controllers, the global pipe, interceptors and filters main.ts installs,
 * and the real AuthService, SignInProvidersService and GoogleLoginService, against in-memory tables.
 * A case starts from a ticket the callback has issued — the flow AUTHENTICATED with the claims it
 * writes, which google-sign-in-flow.http.spec.ts pins — so Google is not reached at all. The same
 * table runs on PostgreSQL, through the fake Google, in google-account-resolution.pg.spec.ts, with the
 * race of first sign-ins forced in the database.
 */

const CLIENT_ID = '1234-resolution.apps.googleusercontent.com';
const jwt = new JwtService({ secret: `google-account-resolution-${randomUUID()}`, signOptions: { expiresIn: '7d' } });
/** A password hash for the accounts a case starts with: scrypt once, not per account. */
const SEEDED_PASSWORD = 'pw-seeded-123';
const SEEDED_HASH = hashPassword(SEEDED_PASSWORD);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Tables {
  provider: Row | null;
  flows: Row[];
  users: Row[];
  identities: Row[];
  activities: Row[];
  refreshTokens: Row[];
}

function tables(policy: SignupPolicy): Tables {
  return {
    provider: {
      provider: 'google',
      enabled: true,
      clientId: CLIENT_ID,
      clientSecretEnc: encryptSecret('GOCSPX-google-account-resolution'),
      signupPolicy: policy,
      updatedById: null,
      updatedAt: new Date(),
    },
    flows: [],
    users: [],
    identities: [],
    activities: [],
    refreshTokens: [],
  };
}

function seedUser(db: Tables, email: string, passwordHash: string | null = SEEDED_HASH, role = 'MEMBER'): Row {
  const user = { id: randomUUID(), email, name: email.split('@')[0], passwordHash, role, createdAt: new Date() };
  db.users.push(user);
  return user;
}

function seedIdentity(db: Tables, userId: string, subject: string, email: string): Row {
  const identity = { id: randomUUID(), userId, provider: 'google', subject, email, hostedDomain: null, createdAt: new Date(), lastSignInAt: null };
  db.identities.push(identity);
  return identity;
}

/** A unique key refusing an INSERT, as Prisma reports PostgreSQL's 23505. */
const uniqueViolation = (target: string) =>
  new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${target})`, {
    code: 'P2002',
    clientVersion: 'spec',
    meta: { target },
  });

/** What a case may do just before a row is inserted: what another request committed meanwhile. */
type BeforeInsert = (model: 'user' | 'userIdentity') => void;

/**
 * PrismaService over `db`, as far as these doors use it. The unique keys refuse as PostgreSQL's do —
 * the user's email as written, the identity's (provider, subject) and (user_id, provider) — and an
 * interactive transaction takes back the rows it inserted when its closure throws.
 */
function memoryPrisma(db: Tables, beforeInsert?: BeforeInsert) {
  const delegates = (inserted?: Array<[keyof Tables, Row]>) => ({
    signInProvider: {
      findUnique: async () => (db.provider ? { ...db.provider } : null),
    },
    user: {
      findUnique: async ({ where }: { where: Row }) => {
        const user = db.users.find((row) => (where.email !== undefined ? row.email === where.email : row.id === where.id));
        return user ? { ...user } : null;
      },
      count: async () => db.users.length,
      create: async ({ data }: { data: Row }) => {
        beforeInsert?.('user');
        if (db.users.some((row) => row.email === data.email)) throw uniqueViolation('email');
        const user = { id: randomUUID(), role: 'MEMBER', passwordHash: null, createdAt: new Date(), ...data };
        db.users.push(user);
        inserted?.push(['users', user]);
        return { ...user };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const user = db.users.find((row) => (where.email !== undefined ? row.email === where.email : row.id === where.id));
        assert.ok(user, 'an update of a user that does not exist');
        Object.assign(user, data);
        return { ...user };
      },
    },
    userIdentity: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const { provider, subject } = where.provider_subject;
        const identity = db.identities.find((row) => row.provider === provider && row.subject === subject);
        if (!identity) return null;
        return { ...identity, ...(include?.user ? { user: { ...db.users.find((user) => user.id === identity.userId) } } : {}) };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const identity = db.identities.find((row) => row.id === where.id);
        assert.ok(identity, 'an update of an identity that does not exist');
        Object.assign(identity, data);
        return { ...identity };
      },
      create: async ({ data }: { data: Row }) => {
        beforeInsert?.('userIdentity');
        if (db.identities.some((row) => row.provider === data.provider && row.subject === data.subject)) throw uniqueViolation('provider, subject');
        if (db.identities.some((row) => row.userId === data.userId && row.provider === data.provider)) throw uniqueViolation('user_id, provider');
        assert.ok(db.users.some((user) => user.id === data.userId), 'an identity of a user that does not exist');
        const identity = { id: randomUUID(), hostedDomain: null, createdAt: new Date(), lastSignInAt: null, ...data };
        db.identities.push(identity);
        inserted?.push(['identities', identity]);
        return { ...identity };
      },
    },
    activity: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), credentialId: null, createdAt: new Date(), ...structuredClone(data) };
        db.activities.push(row);
        inserted?.push(['activities', row]);
        return { ...row };
      },
    },
    refreshToken: {
      create: async ({ data }: { data: Row }) => {
        db.refreshTokens.push({ ...data });
        return { ...data };
      },
    },
  });
  return {
    ...delegates(),
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      const statement = text.replace(/\s+/g, ' ').trim();
      if (statement.startsWith('DELETE')) {
        // The exchange's one statement (§4.3 step 1).
        assert.equal(
          statement,
          'DELETE FROM "oauth_login_flow" WHERE "ticket_hash" = ? AND "status" = \'AUTHENTICATED\' '
            + 'RETURNING "intent", "client_challenge" AS "clientChallenge", "ticket_expires_at" AS "ticketExpiresAt", "claims"',
        );
        const index = db.flows.findIndex((flow) => flow.ticketHash === values[0] && flow.status === 'AUTHENTICATED');
        if (index < 0) return [];
        const [flow] = db.flows.splice(index, 1);
        return [{ intent: flow.intent, clientChallenge: flow.clientChallenge, ticketExpiresAt: flow.ticketExpiresAt, claims: structuredClone(flow.claims) }];
      }
      // §5.2 cases 3 and 4: the accounts with the email in any letter case.
      assert.equal(
        statement,
        'SELECT u."id", u."email", u."name", EXISTS (SELECT 1 FROM "user_identity" i WHERE i."user_id" = u."id" AND i."provider" = ?) AS "linked" '
          + 'FROM "user" u WHERE lower(u."email") = lower(?) LIMIT 2',
      );
      const [provider, email] = values as string[];
      return db.users
        .filter((user) => user.email.toLowerCase() === email.toLowerCase())
        .slice(0, 2)
        .map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          linked: db.identities.some((identity) => identity.userId === user.id && identity.provider === provider),
        }));
    },
    $transaction: async (closure: (tx: unknown) => Promise<unknown>) => {
      const inserted: Array<[keyof Tables, Row]> = [];
      try {
        return await closure(delegates(inserted));
      } catch (error) {
        for (const [table, row] of inserted) {
          const rows = db[table] as Row[];
          rows.splice(rows.indexOf(row), 1);
        }
        throw error;
      }
    },
  };
}

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

let addresses = 0;

async function boot(t: { after: (fn: () => Promise<void>) => void }, db: Tables, beforeInsert?: BeforeInsert) {
  @Module({
    controllers: [AuthController, GoogleAuthController, AdminController],
    providers: [
      AuthService,
      SignInProvidersService,
      GoogleLoginService,
      // Every case starts from a ticket: nothing here may reach Google.
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(async () => assert.fail('a case reached Google')) },
      // Only access-token doors reach it, and no case uses one.
      { provide: PatService, useValue: {} },
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: memoryPrisma(db, beforeInsert) },
    ],
  })
  class GoogleAccountResolutionModule {}

  const app = await NestFactory.create(GoogleAccountResolutionModule, { logger: false, abortOnError: false });
  // As main.ts sets the app up, so the answers are the shapes clients get.
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const call = async (method: string, route: string, options: { body?: unknown; bearer?: string } = {}): Promise<Answer> => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        // One address per request: the exchange's per-address budget is google-sign-in-flow.http.spec.ts's.
        'x-real-ip': `198.51.100.${(addresses += 1) % 250}`,
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json };
  };

  /** The Google account `account` back from Google: its flow AUTHENTICATED, and the exchange of its ticket. */
  const signIn = (account: { sub: string; email: string; hd?: string; name?: string }) => {
    const ticket = generateToken(32);
    const verifier = generateToken(32);
    db.flows.push({
      id: randomUUID(),
      intent: 'LOGIN',
      status: 'AUTHENTICATED',
      clientChallenge: s256(verifier),
      ticketHash: sha256(ticket),
      ticketExpiresAt: new Date(Date.now() + 60_000),
      claims: { sub: account.sub, email: account.email, emailVerified: true, hd: account.hd ?? null, name: account.name ?? null },
    });
    return call('POST', '/api/auth/google/exchange', { body: { ticket, codeVerifier: verifier } });
  };

  return { call, signIn };
}

/** An Activity row as the assertions read it. */
const recorded = (row: Row) => ({
  actorId: row.actorId,
  type: row.type,
  payload: row.payload,
  credentialKind: row.credentialKind,
  credentialId: row.credentialId,
});

test('§5.2, table-driven: every row of both tables but ACCOUNT_DISABLED, under EXISTING_ACCOUNTS and under OPEN', async (t) => {
  for (const policy of SIGNUP_POLICIES) {
    for (const [index, entry] of RESOLUTION_CASES.entries()) {
      await t.test(`${policy} · row ${entry.row}: ${entry.what}`, async (t) => {
        const tag = `c${index}-${policy.toLowerCase()}`;
        const db = tables(policy);
        const me = {
          sub: `me-${tag}`,
          email: tagged(entry.signingIn.email, tag),
          hd: entry.signingIn.hd,
          name: entry.signingIn.name,
        };
        const accounts = entry.accounts.map((account) => seedUser(db, tagged(account.email, tag)));
        entry.accounts.forEach((account, i) => {
          if (account.linkedTo === 'ME') seedIdentity(db, accounts[i].id, me.sub, `old.${tag}@gmail.com`);
          if (account.linkedTo === 'OTHER') seedIdentity(db, accounts[i].id, `other-${tag}`, me.email);
        });
        const before = structuredClone({ users: db.users, identities: db.identities });
        const { signIn } = await boot(t, db);

        const answer = await signIn(me);
        const outcome = entry.expect[policy];
        assert.equal(db.flows.length, 0, 'the ticket was spent');

        if ('refused' in outcome) {
          assert.equal(answer.status, 403, answer.text);
          assert.equal(answer.json?.code, outcome.refused);
          assert.equal(typeof answer.json?.message, 'string');
          assert.ok(!('accessToken' in (answer.json ?? {})), 'no session');
          assert.deepEqual(db.users, before.users, 'no account opened or changed');
          assert.deepEqual(db.identities, before.identities, 'no Google account linked, and no identity touched');
          assert.deepEqual(db.activities, [], 'nothing recorded');
          assert.deepEqual(db.refreshTokens, [], 'no refresh token issued');
          return;
        }

        assert.equal(answer.status, 201, answer.text);
        assert.deepEqual(Object.keys(answer.json).sort(), ['accessToken', 'refreshToken', 'user'], 'the answer POST /auth/login gives');
        const signedIn = toUuid(answer.json.user.id);
        assert.equal(db.refreshTokens.length, 1);
        assert.equal(db.refreshTokens[0].userId, signedIn);
        const identity = db.identities.find((row) => row.subject === me.sub);
        assert.ok(identity, 'the Google account is linked');
        assert.equal(identity.userId, signedIn, 'to the account it signed in as');
        assert.equal(identity.email, me.email, 'with the email Google gave this time');
        assert.equal(identity.hostedDomain, me.hd ?? null);
        assert.ok(identity.lastSignInAt instanceof Date);

        if ('signsInAs' in outcome) {
          const account = accounts[outcome.signsInAs];
          assert.equal(signedIn, account.id);
          assert.equal(answer.json.user.email, account.email, "the account's own email, not Google's");
          assert.deepEqual(db.users, before.users, 'no account opened, and the account is as it was');
          if (outcome.links) {
            assert.equal(db.identities.length, before.identities.length + 1, 'one identity, linked now');
            assert.deepEqual(db.activities.map(recorded), [{
              actorId: account.id,
              type: IDENTITY_LINKED_ACTIVITY,
              payload: { provider: 'google', email: me.email, method: 'AUTO' },
              credentialKind: 'LOGIN',
              credentialId: null,
            }]);
          } else {
            assert.equal(db.identities.length, before.identities.length, 'the identity it had');
            assert.deepEqual(db.activities, [], 'signing in with a linked account links nothing');
          }
          return;
        }

        assert.equal(db.users.length, before.users.length + 1, 'one account opened');
        const opened = db.users.find((user) => user.id === signedIn);
        assert.ok(opened, 'it signed in as the account opened');
        assert.deepEqual(
          { email: opened.email, name: opened.name, role: opened.role, passwordHash: opened.passwordHash },
          { email: me.email, name: tagged(outcome.opens.name, tag), role: 'MEMBER', passwordHash: null },
          'a MEMBER without a password, named as Google names the person',
        );
        assert.deepEqual(answer.json.user.name, opened.name);
        assert.equal(db.identities.length, before.identities.length + 1);
        assert.deepEqual(db.activities.map(recorded), [{
          actorId: opened.id,
          type: IDENTITY_LINKED_ACTIVITY,
          payload: { provider: 'google', email: me.email, method: 'SIGNUP' },
          credentialKind: 'LOGIN',
          credentialId: null,
        }]);
      });
    }
  }
});

test('the authoritative email (§5.2): verified, and a Gmail address or a Workspace account — nothing that only looks like one', () => {
  const cases: Array<[string, { email: string; emailVerified: boolean; hd: string | null }, boolean]> = [
    ['gmail.com', { email: 'ada@gmail.com', emailVerified: true, hd: null }, true],
    ['googlemail.com', { email: 'ada@googlemail.com', emailVerified: true, hd: null }, true],
    ['Gmail in capitals', { email: 'Ada@GMAIL.COM', emailVerified: true, hd: null }, true],
    ['a Workspace account', { email: 'ada@corp.example', emailVerified: true, hd: 'corp.example' }, true],
    ['a Workspace account on another of its domains', { email: 'ada@corp-alias.example', emailVerified: true, hd: 'corp.example' }, true],
    ['another address, no hd', { email: 'ada@corp.example', emailVerified: true, hd: null }, false],
    ['an empty hd', { email: 'ada@corp.example', emailVerified: true, hd: '' }, false],
    ['gmail.com followed by another domain', { email: 'ada@gmail.com.evil.example', emailVerified: true, hd: null }, false],
    ['a domain ending in gmail.com', { email: 'ada@notgmail.com', emailVerified: true, hd: null }, false],
    ['a subdomain of gmail.com', { email: 'ada@mail.gmail.com', emailVerified: true, hd: null }, false],
    ['gmail.com in the local part', { email: 'gmail.com@corp.example', emailVerified: true, hd: null }, false],
    ['no @', { email: 'gmail.com', emailVerified: true, hd: null }, false],
    ['a Gmail address not verified', { email: 'ada@gmail.com', emailVerified: false, hd: null }, false],
    ['a Workspace account not verified', { email: 'ada@corp.example', emailVerified: false, hd: 'corp.example' }, false],
  ];
  for (const [what, identity, authoritative] of cases) assert.equal(googleIsAuthoritative(identity), authoritative, what);
});

test("§5.2's last line: a first sign-in whose write meets the unique key of one that finished first reads once more, and signs in as that account", async (t) => {
  await t.test('OPEN: the other sign-in of the same Google account opened the account first', async (t) => {
    const db = tables('OPEN');
    seedUser(db, 'admin@example.com');
    const me = { sub: 'me-race-signup', email: 'race@gmail.com', name: 'Racer' };
    let winner: Row | undefined;
    const { signIn } = await boot(t, db, (model) => {
      if (model !== 'user' || winner) return;
      // The other exchange commits its account, identity and record between this one's reads and its write.
      winner = seedUser(db, me.email, null);
      seedIdentity(db, winner.id, me.sub, me.email);
      db.activities.push({ actorId: winner.id, type: IDENTITY_LINKED_ACTIVITY, payload: { provider: 'google', email: me.email, method: 'SIGNUP' }, credentialKind: 'LOGIN', credentialId: null });
    });
    const answer = await signIn(me);
    assert.equal(answer.status, 201, answer.text);
    assert.ok(winner);
    assert.equal(toUuid(answer.json.user.id), winner.id, 'signed in as the account the other one opened');
    assert.equal(db.users.filter((user) => user.email === me.email).length, 1, 'one account');
    assert.equal(db.identities.filter((identity) => identity.subject === me.sub).length, 1, 'one identity');
    assert.equal(db.activities.length, 1, 'one record: this one rolled back with the account it did not open');
  });

  await t.test('an authoritative email: the other sign-in of the same Google account linked the account first', async (t) => {
    const db = tables('EXISTING_ACCOUNTS');
    const account = seedUser(db, 'linker@gmail.com');
    const me = { sub: 'me-race-link', email: 'linker@gmail.com' };
    let linkedFirst = false;
    const { signIn } = await boot(t, db, (model) => {
      if (model !== 'userIdentity' || linkedFirst) return;
      linkedFirst = true;
      seedIdentity(db, account.id, me.sub, me.email);
      db.activities.push({ actorId: account.id, type: IDENTITY_LINKED_ACTIVITY, payload: { provider: 'google', email: me.email, method: 'AUTO' }, credentialKind: 'LOGIN', credentialId: null });
    });
    const answer = await signIn(me);
    assert.equal(answer.status, 201, answer.text);
    assert.equal(toUuid(answer.json.user.id), account.id);
    assert.equal(db.identities.length, 1, 'one identity');
    assert.equal(db.activities.length, 1, 'one record');
  });

  await t.test('a unique key that fails again is not read a third time: the exchange fails, and nothing is written', async (t) => {
    const db = tables('OPEN');
    seedUser(db, 'admin@example.com');
    let inserts = 0;
    const { signIn } = await boot(t, db, (model) => {
      inserts += 1;
      throw uniqueViolation(model === 'user' ? 'email' : 'provider, subject');
    });
    const answer = await signIn({ sub: 'me-always-taken', email: 'taken@gmail.com' });
    assert.equal(answer.status, 500, answer.text);
    assert.equal(inserts, 2, 'the first read, and one more');
    assert.equal(db.users.length, 1);
    assert.deepEqual(db.identities, []);
    assert.deepEqual(db.activities, []);
    assert.deepEqual(db.refreshTokens, []);
  });
});

test('an account without a password: the password login answers it exactly as a wrong password, and a password change is a 400 that says why', async (t) => {
  const db = tables('EXISTING_ACCOUNTS');
  const withPassword = seedUser(db, 'pw@example.com');
  const googleOnly = seedUser(db, 'google-only@example.com', null);
  const { call } = await boot(t, db);
  const login = (email: string, password: string) => call('POST', '/api/auth/login', { body: { email, password } });

  const wrong = await login(withPassword.email, 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json?.message, 'invalid credentials');
  for (const [what, answer] of [
    ['an account without a password', await login(googleOnly.email, 'any-password')],
    ['an account without a password, and an empty one', await login(googleOnly.email, '')],
    ['no account at all', await login('nobody@example.com', 'any-password')],
  ] as const) {
    assert.equal(answer.status, 401, what);
    assert.equal(answer.text, wrong.text, `${what}: the answer a wrong password gets, byte for byte`);
  }
  assert.deepEqual(db.refreshTokens, [], 'no session');
  assert.equal((await login(withPassword.email, SEEDED_PASSWORD)).status, 201, 'the control: the right password');

  const asGoogleOnly = await jwt.signAsync({ sub: googleOnly.id, email: googleOnly.email });
  const change = await call('POST', '/api/auth/change-password', {
    bearer: asGoogleOnly,
    body: { currentPassword: 'any-password', newPassword: 'a-new-password' },
  });
  assert.equal(change.status, 400, 'a 400 — a 401 would sign the Web out');
  assert.equal(change.json?.code, 'PASSWORD_NOT_SET');
  assert.match(change.json?.message, /signs in with Google and has no password/);
  assert.equal(db.users.find((user) => user.id === googleOnly.id)?.passwordHash, null, 'no password was set');

  const asWithPassword = await jwt.signAsync({ sub: withPassword.id, email: withPassword.email });
  const wrongCurrent = await call('POST', '/api/auth/change-password', {
    bearer: asWithPassword,
    body: { currentPassword: 'not-the-password', newPassword: 'a-new-password' },
  });
  assert.equal(wrongCurrent.status, 400, 'the control: a wrong current password is the 400 it was');
  assert.equal(wrongCurrent.json?.message, 'current password is incorrect');
});

test('POST /admin/users with passwordless: an account without a password and none generated; refused with force or a password, so an existing password is never erased', async (t) => {
  const db = tables('EXISTING_ACCOUNTS');
  const admin = seedUser(db, 'root@example.com', SEEDED_HASH, 'ADMIN');
  const kept = seedUser(db, 'kept@example.com', hashPassword('kept-password'));
  const keptHash = kept.passwordHash;
  const { call } = await boot(t, db);
  const bearer = await jwt.signAsync({ sub: admin.id, email: admin.email });
  const create = (body: Row) => call('POST', '/api/admin/users', { bearer, body });
  const login = (email: string, password: string) => call('POST', '/api/auth/login', { body: { email, password } });

  const created = await create({ email: 'google-only@example.com', name: 'Google Only', passwordless: true });
  assert.equal(created.status, 201, created.text);
  assert.ok(!('generatedPassword' in created.json), 'no password is generated');
  assert.equal(created.json.reset, false);
  const row = db.users.find((user) => user.email === 'google-only@example.com');
  assert.ok(row);
  assert.deepEqual({ name: row.name, role: row.role, passwordHash: row.passwordHash }, { name: 'Google Only', role: 'MEMBER', passwordHash: null });
  assert.equal((await login(row.email, 'any-password')).status, 401, 'no password signs it in');

  for (const [what, body] of [
    ['with force, on an account that exists', { email: kept.email, passwordless: true, force: true }],
    ['with force, on an address no account has', { email: 'fresh@example.com', passwordless: true, force: true }],
    ['with a password', { email: 'fresh@example.com', passwordless: true, password: 'a-password' }],
  ] as const) {
    const refused = await create(body);
    assert.equal(refused.status, 400, `${what}: ${refused.text}`);
    assert.match(refused.json?.message, /passwordless/, what);
  }
  const conflict = await create({ email: kept.email, passwordless: true });
  assert.equal(conflict.status, 409, 'an address an account has, without force: the conflict it always was');
  assert.equal(db.users.find((user) => user.id === kept.id)?.passwordHash, keptHash, 'the existing password is untouched');
  assert.ok(!db.users.some((user) => user.email === 'fresh@example.com'), 'nothing was created');
  assert.equal((await login(kept.email, 'kept-password')).status, 201, 'and still signs in');

  // The controls: without passwordless a password is generated, as before; and the administrator's
  // reset gives an account without a password one (§5.4).
  const generated = await create({ email: 'with-password@example.com' });
  assert.equal(generated.status, 201, generated.text);
  assert.equal(typeof generated.json.generatedPassword, 'string');
  const reset = await create({ email: row.email, force: true });
  assert.equal(reset.status, 201, reset.text);
  assert.equal(reset.json.reset, true);
  assert.ok(verifyPassword(reset.json.generatedPassword, db.users.find((user) => user.id === row.id)?.passwordHash));
  assert.equal((await login(row.email, reset.json.generatedPassword)).status, 201);
});
