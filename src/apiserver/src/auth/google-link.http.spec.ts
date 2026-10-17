process.env.PROVIDER_SECRET_KEY = 'google-link-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Prisma } from '@prisma/client';

import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { FakeGoogle, type FakeGoogleAccount } from '../test-support/fake-google';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { AdminController } from '../users/admin.controller';
import { UsersController } from '../users/users.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService, IDENTITY_LINKED_ACTIVITY, IDENTITY_UNLINKED_ACTIVITY } from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PAT_PREFIX, PAT_SCOPES, PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

/**
 * Linking Google to the account signed in, and unlinking it (docs/google-sign-in-design.md §5.3), and
 * what `me` and the admin list say of how an account signs in (§6):
 *
 *   - POST /auth/google/link opens a LINK flow for the account signed in, bound to the browser by the
 *     cookie /start sets, and the callback sends that browser back to the profile page with a ticket
 *     (§4.2's table);
 *   - POST /auth/google/link/confirm links only for the account that opened the flow and only with
 *     its verifier, spending the ticket at its first presentation; a Google account linked to another
 *     account is refused GOOGLE_ALREADY_LINKED; every link is recorded (SETTINGS);
 *   - DELETE /auth/google/link unlinks, and refuses an account without a password
 *     (GOOGLE_UNLINK_WOULD_LOCK_OUT); DELETE /admin/users/:id/identities/google unlinks anyone's (ADMIN);
 *   - a login only: an access token is refused on every one of them;
 *   - `signInMethods` on GET /users/me and on each row of GET /admin/users: `password`, and the Google
 *     account's `email` — nothing more of either.
 *
 * Over real HTTP, through the controllers, the global pipe, interceptors and filters main.ts installs,
 * the real JwtAuthGuard and AdminRoleGuard, and the real AuthService, SignInProvidersService and
 * GoogleLoginService, against in-memory tables and the in-process fake Google: nothing reaches the
 * network. The same doors on PostgreSQL, with two links of one Google account racing in the database,
 * are google-link.pg.spec.ts's.
 */

const CLIENT_ID = '1234-link.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-google-link-spec';
const CALLBACK = 'https://orbit.example.test/api/auth/google/callback';
const jwt = new JwtService({ secret: `google-link-${randomUUID()}`, signOptions: { expiresIn: '7d' } });
const SEEDED_HASH = hashPassword('pw-seeded-123');
/** The personal access token every case presents where a login is needed, to see it refused. */
const PAT = `${PAT_PREFIX}${generateToken(24)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Tables {
  provider: Row | null;
  flows: Map<string, Row>;
  users: Row[];
  identities: Row[];
  activities: Row[];
}

function googleRow(over: Row = {}): Row {
  return {
    provider: 'google',
    enabled: true,
    clientId: CLIENT_ID,
    clientSecretEnc: encryptSecret(CLIENT_SECRET),
    signupPolicy: 'EXISTING_ACCOUNTS',
    updatedById: null,
    updatedAt: new Date(),
    ...over,
  };
}

function seedUser(db: Tables, email: string, options: { passwordHash?: string | null; role?: string } = {}): Row {
  const user = {
    id: randomUUID(),
    email,
    name: email.split('@')[0],
    passwordHash: options.passwordHash === undefined ? SEEDED_HASH : options.passwordHash,
    role: options.role ?? 'MEMBER',
    preferences: {},
    createdAt: new Date(Date.now() - 86_400_000 + db.users.length * 1000),
  };
  db.users.push(user);
  return user;
}

function seedIdentity(db: Tables, userId: string, account: FakeGoogleAccount, over: Row = {}): Row {
  const identity = {
    id: randomUUID(),
    userId,
    provider: 'google',
    subject: account.sub,
    email: account.email,
    hostedDomain: account.hd ?? null,
    createdAt: new Date(),
    lastSignInAt: null,
    ...over,
  };
  db.identities.push(identity);
  return identity;
}

/** A where-clause as these services write them: equality, or `lt` / `gt` on a date. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('lt' in condition) return row[key] < condition.lt;
      if ('gt' in condition) return row[key] > condition.gt;
      throw new Error(`a filter this double does not know: ${key} ${JSON.stringify(condition)}`);
    }
    return row[key] === condition;
  });
}

/** Only the fields a select names, as Prisma answers: what a controller does not select, it never holds. */
function pick(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const picked: Row = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted !== true) throw new Error(`a nested select this double does not know: ${key}`);
    picked[key] = row[key];
  }
  return picked;
}

/** A unique key refusing an INSERT, as Prisma reports PostgreSQL's 23505. */
const uniqueViolation = (target: string) =>
  new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${target})`, {
    code: 'P2002',
    clientVersion: 'spec',
    meta: { target },
  });

/** PrismaService over `db`, as far as these doors use it. `beforeInsert` runs just before an identity is inserted. */
function memoryPrisma(db: Tables, beforeInsert?: () => void) {
  /** A user as a select reads it: its own columns, its Google identities, and no photo. */
  const project = (user: Row, select: Row | undefined): Row => {
    if (!select) return { ...user };
    const answer: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (key === 'identities') {
        answer.identities = db.identities
          .filter((identity) => identity.userId === user.id && matches(identity, wanted.where ?? {}))
          .map((identity) => pick(identity, wanted.select));
      } else if (key === 'avatar') {
        answer.avatar = null;
      } else if (wanted === true) {
        answer[key] = user[key];
      } else {
        throw new Error(`a select this double does not know: ${key}`);
      }
    }
    return answer;
  };
  const identityBy = (where: Row) => {
    if (where.provider_subject) {
      const { provider, subject } = where.provider_subject;
      return db.identities.find((row) => row.provider === provider && row.subject === subject);
    }
    if (where.userId_provider) {
      const { userId, provider } = where.userId_provider;
      return db.identities.find((row) => row.userId === userId && row.provider === provider);
    }
    throw new Error(`an identity lookup this double does not know: ${JSON.stringify(where)}`);
  };
  const delegates = (inserted?: Array<[keyof Tables, Row]>) => ({
    signInProvider: {
      findUnique: async () => (db.provider ? { ...db.provider } : null),
    },
    oAuthLoginFlow: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), status: 'PENDING', claims: null, ticketHash: null, ticketExpiresAt: null, createdAt: new Date(), ...data };
        db.flows.set(row.id, row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: Row }) => {
        const row = [...db.flows.values()].find((flow) => matches(flow, where));
        return row ? { ...row } : null;
      },
      count: async ({ where }: { where: Row }) => [...db.flows.values()].filter((flow) => matches(flow, where)).length,
      deleteMany: async ({ where }: { where: Row }) => {
        let count = 0;
        for (const [id, flow] of db.flows) {
          if (matches(flow, where)) {
            db.flows.delete(id);
            count += 1;
          }
        }
        return { count };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const flow of db.flows.values()) {
          if (matches(flow, where)) {
            Object.assign(flow, structuredClone(data));
            count += 1;
          }
        }
        return { count };
      },
    },
    user: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const user = db.users.find((row) => row.id === where.id);
        return user ? project(user, select) : null;
      },
      findMany: async ({ select, orderBy }: { select?: Row; orderBy?: Row }) => {
        assert.deepEqual(orderBy, { createdAt: 'asc' });
        return [...db.users].sort((a, b) => a.createdAt - b.createdAt).map((user) => project(user, select));
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const user = db.users.find((row) => row.id === where.id);
        assert.ok(user, 'an update of a user that does not exist');
        Object.assign(user, data);
        return project(user, select);
      },
    },
    userIdentity: {
      findUnique: async ({ where, select, include }: { where: Row; select?: Row; include?: Row }) => {
        const identity = identityBy(where);
        if (!identity) return null;
        if (include?.user) return { ...identity, user: { ...db.users.find((user) => user.id === identity.userId) } };
        return pick(identity, select);
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const identity = db.identities.find((row) => row.id === where.id);
        assert.ok(identity, 'an update of an identity that does not exist');
        Object.assign(identity, data);
        return { ...identity };
      },
      create: async ({ data }: { data: Row }) => {
        beforeInsert?.();
        if (db.identities.some((row) => row.provider === data.provider && row.subject === data.subject)) throw uniqueViolation('provider, subject');
        if (db.identities.some((row) => row.userId === data.userId && row.provider === data.provider)) throw uniqueViolation('user_id, provider');
        assert.ok(db.users.some((user) => user.id === data.userId), 'an identity of a user that does not exist');
        const identity = { id: randomUUID(), hostedDomain: null, createdAt: new Date(), lastSignInAt: null, ...data };
        db.identities.push(identity);
        inserted?.push(['identities', identity]);
        return { ...identity };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.identities.length;
        db.identities = db.identities.filter((row) => !matches(row, where));
        return { count: before - db.identities.length };
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
  });
  return {
    ...delegates(),
    // The exchange's and the confirmation's one statement (§4.3 step 1). Find and delete run in one
    // turn of the event loop, so two presentations are as exclusive here as the DELETE makes them.
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      assert.equal(
        text.replace(/\s+/g, ' ').trim(),
        'DELETE FROM "oauth_login_flow" WHERE "ticket_hash" = ? AND "status" = \'AUTHENTICATED\' '
          + 'RETURNING "intent", "client_challenge" AS "clientChallenge", "ticket_expires_at" AS "ticketExpiresAt", "claims", '
          + '"link_user_id" AS "linkUserId"',
      );
      const flow = [...db.flows.values()].find((row) => row.ticketHash === values[0] && row.status === 'AUTHENTICATED');
      if (!flow) return [];
      db.flows.delete(flow.id);
      return [{
        intent: flow.intent,
        clientChallenge: flow.clientChallenge,
        ticketExpiresAt: flow.ticketExpiresAt,
        claims: structuredClone(flow.claims),
        linkUserId: flow.linkUserId,
      }];
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
  location: string | null;
  setCookie: string | null;
}

/** A unique address per browser, so the per-address budget of starts only meets where a case means it to. */
let addresses = 0;

async function boot(t: { after: (fn: () => Promise<void>) => void }, setup: { beforeInsert?: () => void } = {}) {
  const google = new FakeGoogle(CLIENT_ID, CLIENT_SECRET);
  const db: Tables = { provider: googleRow(), flows: new Map(), users: [], identities: [], activities: [] };
  /** Whose personal access token PAT is. */
  const patOwner = { id: '' };
  @Module({
    controllers: [GoogleAuthController, UsersController, AdminController],
    providers: [
      AuthService,
      SignInProvidersService,
      GoogleLoginService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      // PAT, granted every scope, verifies as patOwner's: what JwtAuthGuard then makes of it is the subject.
      {
        provide: PatService,
        useValue: {
          verify: async (token: string) =>
            token === PAT ? { tokenId: randomUUID(), userId: patOwner.id, email: 'pat@example.com', scopes: [...PAT_SCOPES], workspaceIds: [] } : null,
        },
      },
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: memoryPrisma(db, setup.beforeInsert) },
    ],
  })
  class GoogleLinkModule {}

  const app = await NestFactory.create(GoogleLinkModule, { logger: false, abortOnError: false });
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

  /** Every answer this server gave, so a case can say what none of them carries. */
  const answers: Answer[] = [];
  const call = async (
    method: string,
    route: string,
    options: { body?: unknown; bearer?: string; cookie?: string | null; address?: string } = {},
  ): Promise<Answer> => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        'x-real-ip': options.address ?? `198.51.100.${(addresses += 1) % 250}`,
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
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
    const answer = { status: response.status, text, json, location: response.headers.get('location'), setCookie: response.headers.get('set-cookie') };
    answers.push(answer);
    return answer;
  };

  /** One browser, keeping the binding cookie as a browser would: set by the link, cleared by the callback. */
  const browser = () => {
    const address = `203.0.113.${(addresses += 1) % 250}`;
    const self = {
      cookie: null as string | null,
      async send(method: string, route: string, options: { body?: unknown; bearer?: string } = {}): Promise<Answer> {
        const answer = await call(method, route, { ...options, address, cookie: self.cookie === null ? null : `orbit_oauth_flow=${self.cookie}` });
        const set = answer.setCookie;
        if (set?.startsWith('orbit_oauth_flow=')) {
          self.cookie = /Max-Age=0(;|$)/.test(set) ? null : set.slice('orbit_oauth_flow='.length).split(';')[0];
        }
        return answer;
      },
    };
    return self;
  };

  const bearerOf = (user: Row) => jwt.signAsync({ sub: user.id, email: user.email });

  /** The profile page's Connect Google, from a fresh browser: a PKCE pair and POST /auth/google/link. */
  const startLink = async (user: Row) => {
    const visitor = browser();
    const verifier = generateToken(32);
    const answer = await visitor.send('POST', '/api/auth/google/link', { bearer: await bearerOf(user), body: { codeChallenge: s256(verifier) } });
    return { visitor, verifier, answer };
  };

  /** Connect Google up to the ticket: the link, `account` at Google's page, the callback in the same browser. */
  const linkAtGoogle = async (user: Row, account: FakeGoogleAccount) => {
    const { visitor, verifier, answer } = await startLink(user);
    assert.equal(answer.status, 201, answer.text);
    const back = await visitor.send('GET', google.authorize(answer.json.authorizationUrl, account));
    const ticket = /^\/settings\/profile\?google_link_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')?.[1];
    assert.ok(ticket, `the callback sends the profile page a ticket: ${back.status} ${back.location}`);
    return { ticket, verifier };
  };

  const confirm = async (user: Row, ticket: string, codeVerifier: string) =>
    call('POST', '/api/auth/google/link/confirm', { bearer: await bearerOf(user), body: { ticket, codeVerifier } });

  return { db, google, call, answers, browser, bearerOf, startLink, linkAtGoogle, confirm, patOwner };
}

const ADA_GOOGLE: FakeGoogleAccount = { sub: '110169484474386276334', email: 'ada@gmail.com', name: 'Ada Lovelace' };
const OTHER_GOOGLE: FakeGoogleAccount = { sub: '207733146810946417735', email: 'ada.lovelace@corp.example', hd: 'corp.example' };
const GINA_GOOGLE: FakeGoogleAccount = { sub: '118894422006613370021', email: 'gina@gmail.com' };

/** The binding cookie's exact attributes (§4.1), as /start sets it. */
const BINDING_SET = /^orbit_oauth_flow=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Lax; Path=\/api\/auth\/google; Max-Age=600; Secure$/;
const BINDING_CLEARED = 'orbit_oauth_flow=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0; Secure';

/** An Activity row as the assertions read it. */
const recorded = (row: Row) => ({
  actorId: row.actorId,
  type: row.type,
  payload: row.payload,
  credentialKind: row.credentialKind,
  credentialId: row.credentialId,
});

const refusedWith = (answer: Answer, status: number, code: string, what: string) => {
  assert.equal(answer.status, status, `${what}: ${answer.text}`);
  assert.equal(answer.json?.code, code, what);
  assert.equal(typeof answer.json?.message, 'string', what);
};

test('Connect Google: POST /auth/google/link opens a LINK flow bound to this browser, the callback brings it back to the profile page, and the confirmation links the Google account and records it', async (t) => {
  const { db, google, answers, call, bearerOf, startLink, confirm } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');

  const { visitor, verifier, answer } = await startLink(ada);
  assert.equal(answer.status, 201, answer.text);
  assert.deepEqual(Object.keys(answer.json), ['authorizationUrl'], 'only where to send the browser');
  const cookie = BINDING_SET.exec(answer.setCookie ?? '')?.[1];
  assert.ok(cookie, `the binding cookie, as /start sets it: ${answer.setCookie}`);
  const [flow, ...more] = [...db.flows.values()];
  assert.equal(more.length, 0);
  assert.deepEqual(
    { intent: flow.intent, client: flow.client, linkUserId: flow.linkUserId, status: flow.status, clientState: flow.clientState },
    { intent: 'LINK', client: 'WEB', linkUserId: ada.id, status: 'PENDING', clientState: null },
    'a LINK flow, from the Web, naming the account signed in',
  );
  assert.equal(flow.clientChallenge, s256(verifier), "the profile page's challenge, for the confirmation");
  assert.equal(flow.bindingHash, sha256(cookie), 'the cookie, kept as its hash');
  const authorization = new URL(answer.json.authorizationUrl);
  assert.equal(`${authorization.origin}${authorization.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorization.searchParams.get('redirect_uri'), CALLBACK, 'the one callback; nothing the request names');
  assert.equal(authorization.searchParams.get('prompt'), 'select_account');
  assert.notEqual(authorization.searchParams.get('code_challenge'), s256(verifier), "Google's side of PKCE is not the page's");
  assert.equal(flow.stateHash, sha256(authorization.searchParams.get('state')!));

  // Google, and back: §4.2's LINK row.
  const back = await visitor.send('GET', google.authorize(answer.json.authorizationUrl, ADA_GOOGLE));
  assert.equal(back.status, 302);
  const ticket = /^\/settings\/profile\?google_link_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')?.[1];
  assert.ok(ticket, `to the profile page, with the ticket: ${back.location}`);
  assert.equal(back.setCookie, BINDING_CLEARED, 'the callback clears the cookie');
  assert.deepEqual(db.identities, [], 'the callback links nothing');
  assert.deepEqual(db.activities, []);

  const linked = await confirm(ada, ticket, verifier);
  assert.equal(linked.status, 201, linked.text);
  assert.deepEqual(linked.json, { signInMethods: { password: true, google: { email: ADA_GOOGLE.email } } });
  assert.equal(db.flows.size, 0, 'the ticket was spent');
  assert.deepEqual(
    db.identities.map(({ userId, provider, subject, email, hostedDomain }) => ({ userId, provider, subject, email, hostedDomain })),
    [{ userId: ada.id, provider: 'google', subject: ADA_GOOGLE.sub, email: ADA_GOOGLE.email, hostedDomain: null }],
    'linked by Google\'s sub, to the account that started it',
  );
  assert.deepEqual(db.activities.map(recorded), [{
    actorId: ada.id,
    type: IDENTITY_LINKED_ACTIVITY,
    payload: { provider: 'google', email: ADA_GOOGLE.email, method: 'SETTINGS' },
    credentialKind: 'LOGIN',
    credentialId: null,
  }]);
  const me = await call('GET', '/api/users/me', { bearer: await bearerOf(ada) });
  assert.deepEqual(me.json.signInMethods, { password: true, google: { email: ADA_GOOGLE.email } });

  // A second presentation finds nothing; and no answer ever carried what Google handed the server.
  refusedWith(await confirm(ada, ticket, verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'the ticket a second time');
  for (const accessToken of google.accessTokens) {
    assert.ok(!answers.some((a) => a.text.includes(accessToken) || (a.location ?? '').includes(accessToken)), "Google's access token is answered nowhere");
  }
});

test('the confirmation links only for the account that opened the flow: another account, with the ticket and the verifier, links nothing and spends the ticket', async (t) => {
  const { db, linkAtGoogle, confirm } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');
  const bob = seedUser(db, 'bob@example.com');

  const { ticket, verifier } = await linkAtGoogle(ada, ADA_GOOGLE);
  refusedWith(await confirm(bob, ticket, verifier), 400, 'GOOGLE_FLOW_MISMATCH', "Bob's session presenting Ada's ticket");
  assert.equal(db.identities.length, 0, 'nothing linked to Bob, nor to Ada');
  assert.deepEqual(db.activities, [], 'nothing recorded');
  assert.equal(db.flows.size, 0, 'spent by that presentation');
  refusedWith(await confirm(ada, ticket, verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'Ada, after Bob presented it');
  assert.equal(db.identities.length, 0);

  // The control: Ada's own.
  const own = await linkAtGoogle(ada, ADA_GOOGLE);
  assert.equal((await confirm(ada, own.ticket, own.verifier)).status, 201);
  assert.deepEqual(db.identities.map((identity) => identity.userId), [ada.id]);
});

test('the confirmation needs the verifier: without one it is refused before the ticket is read; an empty or another one spends the ticket and links nothing', async (t) => {
  const { db, call, bearerOf, linkAtGoogle, confirm } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');
  const bearer = await bearerOf(ada);

  const kept = await linkAtGoogle(ada, ADA_GOOGLE);
  for (const body of [{ ticket: kept.ticket }, { ticket: kept.ticket, codeVerifier: null }, { ticket: kept.ticket, codeVerifier: 7 }, { codeVerifier: kept.verifier }]) {
    const refused = await call('POST', '/api/auth/google/link/confirm', { bearer, body });
    assert.equal(refused.status, 400, `${JSON.stringify(Object.keys(body))}: ${refused.text}`);
  }
  assert.equal(db.flows.size, 1, 'a body without a verifier is refused before anything is spent');
  refusedWith(await confirm(ada, kept.ticket, ''), 400, 'GOOGLE_FLOW_MISMATCH', 'an empty verifier');
  refusedWith(await confirm(ada, kept.ticket, kept.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'the right verifier after an empty one');

  const wrong = await linkAtGoogle(ada, ADA_GOOGLE);
  refusedWith(await confirm(ada, wrong.ticket, generateToken(32)), 400, 'GOOGLE_FLOW_MISMATCH', 'another verifier');
  refusedWith(await confirm(ada, wrong.ticket, wrong.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'the right verifier after another');
  assert.deepEqual(db.identities, [], 'nothing linked');
  assert.deepEqual(db.activities, []);
  assert.equal(db.flows.size, 0);
});

test("the confirmation takes a LINK ticket in its two minutes only: a sign-in's ticket, an expired one or one nobody issued links nothing", async (t) => {
  const { db, google, browser, linkAtGoogle, confirm, call } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');
  seedIdentity(db, seedUser(db, 'signs-in@example.com').id, OTHER_GOOGLE);

  // A sign-in's ticket (§4.2's LOGIN row) presented as a link: spent, and still nothing linked to Ada.
  const visitor = browser();
  const loginVerifier = generateToken(32);
  const started = await visitor.send('GET', `/api/auth/google/start?client=web&code_challenge=${s256(loginVerifier)}`);
  const back = await visitor.send('GET', google.authorize(started.location!, OTHER_GOOGLE));
  const loginTicket = /^\/login\?google_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')![1];
  refusedWith(await confirm(ada, loginTicket, loginVerifier), 400, 'GOOGLE_FLOW_MISMATCH', "a sign-in's ticket");
  refusedWith(
    await call('POST', '/api/auth/google/exchange', { body: { ticket: loginTicket, codeVerifier: loginVerifier } }),
    400, 'GOOGLE_FLOW_MISMATCH', 'and the sign-in cannot use it afterwards',
  );

  const late = await linkAtGoogle(ada, ADA_GOOGLE);
  [...db.flows.values()].find((flow) => flow.ticketHash === sha256(late.ticket))!.ticketExpiresAt = new Date(Date.now() - 1);
  refusedWith(await confirm(ada, late.ticket, late.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'past its two minutes');
  refusedWith(await confirm(ada, generateToken(32), generateToken(32)), 400, 'GOOGLE_FLOW_MISMATCH', 'a ticket nobody issued');
  assert.equal(db.identities.filter((identity) => identity.userId === ada.id).length, 0);
  assert.deepEqual(db.activities, []);
  assert.equal(db.flows.size, 0);
});

test('a Google account linked to another Orbit account is refused GOOGLE_ALREADY_LINKED, and nothing is written', async (t) => {
  const { db, linkAtGoogle, confirm } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');
  const bob = seedUser(db, 'bob@example.com');
  seedIdentity(db, bob.id, ADA_GOOGLE);
  const before = structuredClone(db.identities);

  const { ticket, verifier } = await linkAtGoogle(ada, ADA_GOOGLE);
  const refused = await confirm(ada, ticket, verifier);
  refusedWith(refused, 409, 'GOOGLE_ALREADY_LINKED', "Ada confirming the Google account Bob's account is linked to");
  assert.deepEqual(db.identities, before, "Bob's link is untouched, and Ada has none");
  assert.deepEqual(db.activities, []);
  assert.equal(db.flows.size, 0, 'the ticket is spent all the same');
});

test('one Google account per Orbit account: a linked account cannot open a link (GOOGLE_LINK_EXISTS); a link of another Google account confirmed meanwhile is refused; a second confirmation of the same link links nothing more', async (t) => {
  const { db, startLink, linkAtGoogle, confirm } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');

  // Two links opened while Ada has none, one of each Google account, and one more of the first.
  const first = await linkAtGoogle(ada, ADA_GOOGLE);
  const again = await linkAtGoogle(ada, ADA_GOOGLE);
  const other = await linkAtGoogle(ada, OTHER_GOOGLE);
  assert.equal((await confirm(ada, first.ticket, first.verifier)).status, 201);
  const twice = await confirm(ada, again.ticket, again.verifier);
  assert.equal(twice.status, 201, `the same link confirmed again is what Ada has: ${twice.text}`);
  assert.deepEqual(twice.json, { signInMethods: { password: true, google: { email: ADA_GOOGLE.email } } });
  refusedWith(await confirm(ada, other.ticket, other.verifier), 409, 'GOOGLE_LINK_EXISTS', 'another Google account, after the first was linked');
  assert.deepEqual(db.identities.map((identity) => [identity.userId, identity.subject]), [[ada.id, ADA_GOOGLE.sub]]);
  assert.equal(db.activities.length, 1, 'one link, recorded once');

  // Now linked, Ada cannot open another: refused before any flow or cookie.
  const refused = await startLink(ada);
  refusedWith(refused.answer, 409, 'GOOGLE_LINK_EXISTS', 'a link opened by a linked account');
  assert.equal(refused.answer.setCookie, null);
  assert.equal(db.flows.size, 0);
});

test('two confirmations of one Google account for two accounts at once: the one whose insert meets the other\'s unique key reads once more and is refused GOOGLE_ALREADY_LINKED', async (t) => {
  let race: (() => void) | undefined;
  const { db, linkAtGoogle, confirm } = await boot(t, { beforeInsert: () => race?.() });
  const ada = seedUser(db, 'ada@example.com');
  const bob = seedUser(db, 'bob@example.com');
  const ticket = await linkAtGoogle(ada, ADA_GOOGLE);
  // Bob's link of the same Google account commits between Ada's reads and her insert.
  race = () => {
    race = undefined;
    seedIdentity(db, bob.id, ADA_GOOGLE);
  };
  refusedWith(await confirm(ada, ticket.ticket, ticket.verifier), 409, 'GOOGLE_ALREADY_LINKED', 'the second of two links');
  assert.deepEqual(db.identities.map((identity) => identity.userId), [bob.id]);
  assert.deepEqual(db.activities, [], "Ada's link rolled back with its record");
});

test('DELETE /auth/google/link: an account with a password unlinks, and it is recorded; one without a password is refused GOOGLE_UNLINK_WOULD_LOCK_OUT and keeps its link', async (t) => {
  const { db, call, bearerOf } = await boot(t);
  const ada = seedUser(db, 'ada@example.com');
  const gina = seedUser(db, 'gina@gmail.com', { passwordHash: null });
  seedIdentity(db, ada.id, ADA_GOOGLE);
  const ginaIdentity = seedIdentity(db, gina.id, GINA_GOOGLE);

  const refused = await call('DELETE', '/api/auth/google/link', { bearer: await bearerOf(gina) });
  refusedWith(refused, 400, 'GOOGLE_UNLINK_WOULD_LOCK_OUT', 'an account Google is the only way into');
  assert.deepEqual(db.identities.filter((identity) => identity.userId === gina.id), [ginaIdentity], 'Gina keeps her link');
  assert.deepEqual(db.activities, []);

  const unlinked = await call('DELETE', '/api/auth/google/link', { bearer: await bearerOf(ada) });
  assert.equal(unlinked.status, 200, unlinked.text);
  assert.deepEqual(unlinked.json, { signInMethods: { password: true, google: null } });
  assert.deepEqual(db.identities.map((identity) => identity.userId), [gina.id], "Ada's link is gone, and only hers");
  assert.deepEqual(db.activities.map(recorded), [{
    actorId: ada.id,
    type: IDENTITY_UNLINKED_ACTIVITY,
    payload: { provider: 'google', email: ADA_GOOGLE.email, method: 'SETTINGS' },
    credentialKind: 'LOGIN',
    credentialId: null,
  }]);

  // Nothing linked any more: answered as it is, and nothing more recorded.
  const again = await call('DELETE', '/api/auth/google/link', { bearer: await bearerOf(ada) });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json, { signInMethods: { password: true, google: null } });
  assert.equal(db.activities.length, 1);
});

test("DELETE /admin/users/:id/identities/google: an administrator unlinks anyone's Google account, one without a password too, recorded as theirs and naming the account; a member is refused, and an unknown account is 404", async (t) => {
  const { db, call, bearerOf } = await boot(t);
  const root = seedUser(db, 'root@example.com', { role: 'ADMIN' });
  const ada = seedUser(db, 'ada@example.com');
  const gina = seedUser(db, 'gina@gmail.com', { passwordHash: null });
  seedIdentity(db, ada.id, ADA_GOOGLE);
  seedIdentity(db, gina.id, GINA_GOOGLE);
  const unlink = async (as: Row, id: string) => call('DELETE', `/api/admin/users/${id}/identities/google`, { bearer: await bearerOf(as) });

  const member = await unlink(ada, uuidToBase62(gina.id));
  assert.equal(member.status, 403, member.text);
  assert.equal(db.identities.length, 2, 'a member unlinks nobody');

  const unlinked = await unlink(root, uuidToBase62(gina.id));
  assert.equal(unlinked.status, 200, unlinked.text);
  assert.deepEqual(unlinked.json, { signInMethods: { password: false, google: null } }, 'Gina, now with no way in until a password reset');
  assert.deepEqual(db.identities.map((identity) => identity.userId), [ada.id]);
  assert.deepEqual(db.activities.map(recorded), [{
    actorId: root.id,
    type: IDENTITY_UNLINKED_ACTIVITY,
    payload: { provider: 'google', email: 'gina@gmail.com', method: 'ADMIN', userId: gina.id },
    credentialKind: 'LOGIN',
    credentialId: null,
  }]);

  const nothing = await unlink(root, uuidToBase62(gina.id));
  assert.equal(nothing.status, 200, 'nothing linked: answered as it is');
  assert.equal(db.activities.length, 1, 'and nothing more recorded');
  assert.equal((await unlink(root, uuidToBase62(randomUUID()))).status, 404, 'an account that does not exist');
  assert.equal((await unlink(root, ada.id)).status, 200, 'the uuid spelling of an id too');
  assert.deepEqual(db.identities, []);
});

test('a login only: without a bearer every one of these doors is 401, and a personal access token is refused 403 PAT_FORBIDDEN on all of them, writing nothing', async (t) => {
  const { db, call, linkAtGoogle, patOwner } = await boot(t);
  const root = seedUser(db, 'root@example.com', { role: 'ADMIN' });
  const ada = seedUser(db, 'ada@example.com');
  seedIdentity(db, ada.id, OTHER_GOOGLE);
  const pending = await linkAtGoogle(root, ADA_GOOGLE);
  const doors: Array<{ method: string; route: string; body?: unknown; reason: string }> = [
    { method: 'POST', route: '/api/auth/google/link', body: { codeChallenge: s256(generateToken(32)) }, reason: 'AUTH' },
    { method: 'POST', route: '/api/auth/google/link/confirm', body: { ticket: pending.ticket, codeVerifier: pending.verifier }, reason: 'AUTH' },
    { method: 'DELETE', route: '/api/auth/google/link', reason: 'AUTH' },
    { method: 'DELETE', route: `/api/admin/users/${uuidToBase62(ada.id)}/identities/google`, reason: 'ADMIN' },
  ];
  const before = structuredClone({ flows: [...db.flows.values()], identities: db.identities, activities: db.activities });
  for (const owner of [root, ada]) {
    patOwner.id = owner.id;
    for (const door of doors) {
      const anonymous = await call(door.method, door.route, { body: door.body });
      assert.equal(anonymous.status, 401, `${door.method} ${door.route} without a bearer: ${anonymous.text}`);
      const token = await call(door.method, door.route, { body: door.body, bearer: PAT });
      assert.equal(token.status, 403, `${door.method} ${door.route} with ${owner.email}'s token: ${token.text}`);
      assert.deepEqual([token.json?.code, token.json?.reason], ['PAT_FORBIDDEN', door.reason], `${door.method} ${door.route}`);
    }
  }
  assert.deepEqual(
    structuredClone({ flows: [...db.flows.values()], identities: db.identities, activities: db.activities }),
    before,
    'no flow opened, the ticket not spent, nothing linked, unlinked or recorded',
  );
});

test('while Google sign-in is off, the link doors refuse GOOGLE_NOT_CONFIGURED — a link ticket is left as it was — and an administrator can still unlink', async (t) => {
  const { db, call, bearerOf, linkAtGoogle, startLink, confirm } = await boot(t);
  const root = seedUser(db, 'root@example.com', { role: 'ADMIN' });
  const ada = seedUser(db, 'ada@example.com');
  const bob = seedUser(db, 'bob@example.com');
  seedIdentity(db, bob.id, OTHER_GOOGLE);
  const pending = await linkAtGoogle(ada, ADA_GOOGLE);

  for (const off of [googleRow({ enabled: false }), null, googleRow({ clientSecretEnc: '' })]) {
    db.provider = off;
    const what = off === null ? 'not configured' : off.enabled ? 'on without a secret' : 'switched off';
    const opened = await startLink(ada);
    refusedWith(opened.answer, 403, 'GOOGLE_NOT_CONFIGURED', `${what}: the link`);
    assert.equal(opened.answer.setCookie, null, `${what}: no cookie`);
    refusedWith(await confirm(ada, pending.ticket, pending.verifier), 403, 'GOOGLE_NOT_CONFIGURED', `${what}: the confirmation`);
    refusedWith(await call('DELETE', '/api/auth/google/link', { bearer: await bearerOf(bob) }), 403, 'GOOGLE_NOT_CONFIGURED', `${what}: the unlink`);
  }
  assert.equal(db.flows.size, 1, 'the ticket is left as it was');
  assert.deepEqual(db.identities.map((identity) => identity.userId), [bob.id]);

  const admin = await call('DELETE', `/api/admin/users/${uuidToBase62(bob.id)}/identities/google`, { bearer: await bearerOf(root) });
  assert.equal(admin.status, 200, admin.text);
  assert.deepEqual(db.identities, [], 'the administrator took the link away');

  db.provider = googleRow();
  assert.equal((await confirm(ada, pending.ticket, pending.verifier)).status, 201, 'switched back on: the ticket links');
});

test('GET /users/me and GET /admin/users answer signInMethods with only §6\'s fields — password, and the linked Google account\'s email — and never the hash or the identity', async (t) => {
  const { db, call, bearerOf } = await boot(t);
  const root = seedUser(db, 'root@example.com', { role: 'ADMIN' });
  const ada = seedUser(db, 'ada@example.com');
  const gina = seedUser(db, 'gina@corp.example', { passwordHash: null });
  const nora = seedUser(db, 'nora@example.com', { passwordHash: null });
  seedIdentity(db, ada.id, ADA_GOOGLE, { lastSignInAt: new Date() });
  seedIdentity(db, gina.id, { sub: '305566778899001122334', email: 'gina@corp.example', hd: 'corp.example' }, { lastSignInAt: new Date() });
  const expected = new Map<string, unknown>([
    [root.id, { password: true, google: null }],
    [ada.id, { password: true, google: { email: ADA_GOOGLE.email } }],
    [gina.id, { password: false, google: { email: 'gina@corp.example' } }],
    [nora.id, { password: false, google: null }],
  ]);
  /** What no answer may carry: the hash, any identity's sub or Workspace domain, or the identity rows. */
  const secret = (text: string) => [SEEDED_HASH, ADA_GOOGLE.sub, '305566778899001122334', 'passwordHash', 'identities', 'subject', 'hostedDomain', 'lastSignInAt']
    .filter((needle) => text.includes(needle));

  for (const user of [root, ada, gina, nora]) {
    const me = await call('GET', '/api/users/me', { bearer: await bearerOf(user) });
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(
      Object.keys(me.json).sort(),
      ['avatarUpdatedAt', 'createdAt', 'email', 'id', 'name', 'preferences', 'publicId', 'role', 'signInMethods'],
      'me as it was, and signInMethods',
    );
    assert.deepEqual(me.json.signInMethods, expected.get(user.id), user.email);
    assert.deepEqual(secret(me.text), [], `${user.email}'s me`);
  }
  const renamed = await call('PATCH', '/api/users/me', { bearer: await bearerOf(ada), body: { name: 'Ada L.' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual(renamed.json.signInMethods, expected.get(ada.id), 'every answer in the shape of me carries it');

  const list = await call('GET', '/api/admin/users', { bearer: await bearerOf(root) });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.map((row: Row) => toUuid(row.id)), [root.id, ada.id, gina.id, nora.id], 'oldest first, as before');
  for (const row of list.json) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'email', 'id', 'name', 'publicId', 'role', 'signInMethods'], row.email);
    assert.deepEqual(row.signInMethods, expected.get(toUuid(row.id)), row.email);
    if (row.signInMethods.google) assert.deepEqual(Object.keys(row.signInMethods.google), ['email']);
  }
  assert.deepEqual(secret(list.text), [], 'the admin list');
  assert.equal((await call('GET', '/api/admin/users', { bearer: await bearerOf(ada) })).status, 403, 'a member does not list the accounts');
});
