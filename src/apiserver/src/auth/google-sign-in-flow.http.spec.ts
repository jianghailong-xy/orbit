process.env.PROVIDER_SECRET_KEY = 'google-sign-in-flow-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';

import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { FakeGoogle, type FakeGoogleAccount, type FakeTokenAnswer } from '../test-support/fake-google';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController, googleFailureRedirect, googleSuccessRedirect } from './google-auth.controller';
import {
  GOOGLE_EXCHANGE_RATE_LIMIT,
  GOOGLE_FLOW_TTL_MS,
  GOOGLE_PENDING_FLOW_CAP,
  GOOGLE_START_RATE_LIMIT,
  GOOGLE_TICKET_TTL_MS,
  GoogleLoginService,
} from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

/**
 * Signing in with Google (docs/google-sign-in-design.md §4): GET /auth/google/start, the callback
 * Google sends the browser to, and POST /auth/google/exchange — every check §4 names, each refused as
 * the design says, and the answer a linked Google account gets, the same as POST /auth/login's.
 *
 * Over real HTTP, through the controllers, the global pipe, interceptors and filters main.ts installs,
 * and the real AuthService, SignInProvidersService and GoogleLoginService, against in-memory tables
 * and the in-process fake Google (test-support/fake-google.ts): nothing reaches the network. What
 * needs PostgreSQL — the migration, the one-statement exchange under real concurrency, the sweep and
 * the cap on real rows, the cascade — is google-sign-in-flow.pg.spec.ts's.
 */

const CLIENT_ID = '1234-flow.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-google-sign-in-flow-spec';
const CALLBACK = 'https://orbit.example.test/api/auth/google/callback';
const JWT_SECRET = `google-sign-in-flow-${randomUUID()}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** The tables these doors touch, in memory: what each case starts from and what it looks at after. */
interface Tables {
  provider: Row | null;
  flows: Map<string, Row>;
  identities: Row[];
  users: Row[];
  refreshTokens: Row[];
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

/** PrismaService over `db`, as far as the sign-in doors use it. */
function memoryPrisma(db: Tables) {
  return {
    signInProvider: {
      findUnique: async () => (db.provider ? { ...db.provider } : null),
    },
    oAuthLoginFlow: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: randomUUID(),
          status: 'PENDING',
          claims: null,
          ticketHash: null,
          ticketExpiresAt: null,
          linkUserId: null,
          createdAt: new Date(),
          ...data,
        };
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
    // The exchange's one statement. Find and delete run in one turn of the event loop, so two
    // exchanges are as exclusive here as the DELETE makes them in PostgreSQL.
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      if (/^\s*SELECT/.test(text)) {
        // §5.2's accounts with the email in any letter case, whose spec is google-account-resolution.http.spec.ts.
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
      }
      assert.equal(
        text.replace(/\s+/g, ' ').trim(),
        'DELETE FROM "oauth_login_flow" WHERE "ticket_hash" = ? AND "status" = \'AUTHENTICATED\' '
          + 'RETURNING "intent", "client_challenge" AS "clientChallenge", "ticket_expires_at" AS "ticketExpiresAt", "claims"',
      );
      const flow = [...db.flows.values()].find((row) => row.ticketHash === values[0] && row.status === 'AUTHENTICATED');
      if (!flow) return [];
      db.flows.delete(flow.id);
      return [{ intent: flow.intent, clientChallenge: flow.clientChallenge, ticketExpiresAt: flow.ticketExpiresAt, claims: structuredClone(flow.claims) }];
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
    },
    user: {
      findUnique: async ({ where }: { where: Row }) => {
        const user = db.users.find((row) => (where.email !== undefined ? row.email === where.email : row.id === where.id));
        return user ? { ...user } : null;
      },
      count: async () => db.users.length,
      create: async ({ data }: { data: Row }) => {
        const user = { id: randomUUID(), role: 'MEMBER', createdAt: new Date(), ...data };
        db.users.push(user);
        return { ...user };
      },
    },
    refreshToken: {
      create: async ({ data }: { data: Row }) => {
        db.refreshTokens.push({ ...data });
        return { ...data };
      },
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

/** A unique address per browser, so the per-address budgets only meet where a case means them to. */
let addresses = 0;
const nextAddress = () => `198.51.100.${(addresses += 1) % 250}`;

async function boot(t: { after: (fn: () => Promise<void>) => void }, setup: { google?: FakeGoogle; provider?: Row | null } = {}) {
  const google = setup.google ?? new FakeGoogle(CLIENT_ID, CLIENT_SECRET);
  const db: Tables = {
    provider: setup.provider === undefined ? googleRow() : setup.provider,
    flows: new Map(),
    identities: [],
    users: [],
    refreshTokens: [],
  };
  @Module({
    controllers: [AuthController, GoogleAuthController],
    providers: [
      AuthService,
      SignInProvidersService,
      GoogleLoginService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      // Only the password change reaches it, and no case here changes a password.
      { provide: PatService, useValue: {} },
      { provide: JwtService, useValue: new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } }) },
      { provide: PrismaService, useValue: memoryPrisma(db) },
    ],
  })
  class GoogleFlowModule {}

  const app = await NestFactory.create(GoogleFlowModule, { logger: false, abortOnError: false });
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
    options: { body?: unknown; cookie?: string | null; address?: string } = {},
  ): Promise<Answer> => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        'x-real-ip': options.address ?? '192.0.2.1',
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
    const answer = {
      status: response.status,
      text,
      json,
      location: response.headers.get('location'),
      setCookie: response.headers.get('set-cookie'),
    };
    answers.push(answer);
    return answer;
  };

  /**
   * One browser: what /start sets in it and what the callback clears, as a browser keeps a cookie.
   * `cookie` is the binding cookie's value while it has one.
   */
  const browser = (address = nextAddress()) => {
    const self = {
      address,
      cookie: null as string | null,
      async get(route: string): Promise<Answer> {
        const answer = await call('GET', route, { cookie: self.cookie === null ? null : `orbit_oauth_flow=${self.cookie}`, address });
        const set = answer.setCookie;
        if (set?.startsWith('orbit_oauth_flow=')) {
          self.cookie = /Max-Age=0(;|$)/.test(set) ? null : set.slice('orbit_oauth_flow='.length).split(';')[0];
        }
        return answer;
      },
    };
    return self;
  };

  /**
   * A sign-in up to Google's answer: a PKCE pair, /start from a fresh browser, and Google's page — the
   * account signing in, or declining. Answers the browser, the verifier, the authorization address,
   * and the callback address Google sends the browser to.
   */
  const startAtGoogle = async (
    options: { client?: 'web' | 'native'; clientState?: string; account?: FakeGoogleAccount; claims?: Row; deny?: boolean } = {},
  ) => {
    const visitor = browser();
    const verifier = generateToken(32);
    const query = new URLSearchParams({ client: options.client ?? 'web', code_challenge: s256(verifier) });
    if (options.clientState !== undefined) query.set('client_state', options.clientState);
    const started = await visitor.get(`/api/auth/google/start?${query}`);
    assert.equal(started.status, 302, started.text);
    const authorization = started.location!;
    const callback = options.deny
      ? google.deny(authorization)
      : google.authorize(authorization, options.account ?? ADA, options.claims);
    return { visitor, verifier, authorization, callback, state: new URL(authorization).searchParams.get('state')! };
  };

  const exchange = (ticket: string, codeVerifier: string, address = '192.0.2.1') =>
    call('POST', '/api/auth/google/exchange', { body: { ticket, codeVerifier }, address });

  return { db, google, call, answers, browser, startAtGoogle, exchange };
}

const ADA: FakeGoogleAccount = { sub: '110169484474386276334', email: 'ada@gmail.com', name: 'Ada Lovelace' };

/** A user with a password, and — unless `linked` is false — Ada's Google account linked to it. */
function seedAda(db: Tables, linked = true) {
  const user = { id: randomUUID(), email: 'ada@example.com', name: 'Ada', passwordHash: hashPassword('pw-ada-123'), role: 'MEMBER', createdAt: new Date() };
  db.users.push(user);
  if (linked) {
    db.identities.push({
      id: randomUUID(),
      userId: user.id,
      provider: 'google',
      subject: ADA.sub,
      email: 'ada.old@gmail.com',
      hostedDomain: 'old.example.com',
      createdAt: new Date(),
      lastSignInAt: null,
    });
  }
  return user;
}

/** The binding cookie's exact attributes (§4.1). */
const BINDING_SET = /^orbit_oauth_flow=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Lax; Path=\/api\/auth\/google; Max-Age=600; Secure$/;
const BINDING_CLEARED = 'orbit_oauth_flow=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0; Secure';

/** The claims of a JWT, unverified: what the token carries is the shape under test, not its signature. */
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

test('/start: a flow per sign-in, bound to the browser by a cookie the flow keeps only the hash of; Google is asked for openid email profile, the account chooser, state, nonce and its own PKCE', async (t) => {
  const { db, browser } = await boot(t);
  const verifier = generateToken(32);
  const visitor = browser();
  const before = Date.now();
  const started = await visitor.get(`/api/auth/google/start?client=web&code_challenge=${s256(verifier)}`);
  assert.equal(started.status, 302, started.text);

  const google = new URL(started.location!);
  assert.equal(`${google.origin}${google.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(google.searchParams);
  assert.deepEqual(Object.keys(params).sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
  assert.equal(params.response_type, 'code');
  assert.equal(params.client_id, CLIENT_ID);
  assert.equal(params.redirect_uri, CALLBACK);
  assert.equal(params.scope, 'openid email profile');
  assert.equal(params.prompt, 'select_account');
  assert.equal(params.code_challenge_method, 'S256');
  assert.match(params.state, /^[A-Za-z0-9_-]{43}$/, '256 bits');
  assert.match(params.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(params.code_challenge, s256(verifier), "Google's PKCE pair is not the client's");

  const cookie = BINDING_SET.exec(started.setCookie ?? '');
  assert.ok(cookie, `the binding cookie as §4.1 sets it: ${started.setCookie}`);

  assert.equal(db.flows.size, 1);
  const [flow] = db.flows.values();
  assert.equal(flow.provider, 'google');
  assert.equal(flow.intent, 'LOGIN');
  assert.equal(flow.client, 'WEB');
  assert.equal(flow.status, 'PENDING');
  assert.equal(flow.stateHash, sha256(params.state));
  assert.equal(flow.bindingHash, sha256(cookie[1]));
  assert.equal(flow.nonce, params.nonce);
  assert.equal(s256(flow.providerCodeVerifier), params.code_challenge, "the verifier of Google's challenge stays here");
  assert.equal(flow.clientChallenge, s256(verifier));
  assert.equal(flow.clientState, null);
  assert.equal(flow.linkUserId, null);
  assert.equal(flow.claims, null);
  assert.equal(flow.ticketHash, null);
  const ttl = flow.expiresAt.getTime() - before;
  assert.ok(ttl >= GOOGLE_FLOW_TTL_MS && ttl < GOOGLE_FLOW_TTL_MS + 5_000, `ten minutes, not ${ttl} ms`);
  assert.equal(GOOGLE_FLOW_TTL_MS, 10 * 60_000);
  const stored = JSON.stringify(flow);
  assert.ok(!stored.includes(params.state) && !stored.includes(cookie[1]), 'neither the state nor the cookie is stored as it is');

  // Native: the state the app hands over is kept to hand back; the Web has no use for one.
  const native = await browser().get(`/api/auth/google/start?client=native&code_challenge=${s256(verifier)}&client_state=app%20state%2B1`);
  assert.equal(native.status, 302, native.text);
  const web = await browser().get(`/api/auth/google/start?client=web&code_challenge=${s256(verifier)}&client_state=ignored`);
  assert.equal(web.status, 302, web.text);
  const [, nativeFlow, webFlow] = db.flows.values();
  assert.equal(nativeFlow.client, 'NATIVE');
  assert.equal(nativeFlow.clientState, 'app state+1');
  assert.equal(webFlow.client, 'WEB');
  assert.equal(webFlow.clientState, null);
});

test('/start over http: the binding cookie is not Secure when PUBLIC_ORIGIN is not https', async (t) => {
  const saved = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = 'http://localhost:2086';
  t.after(() => { process.env.PUBLIC_ORIGIN = saved; });
  const { browser } = await boot(t);
  const started = await browser().get(`/api/auth/google/start?client=web&code_challenge=${s256(generateToken(32))}`);
  assert.equal(started.status, 302, started.text);
  assert.match(started.setCookie!, /^orbit_oauth_flow=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/api\/auth\/google; Max-Age=600$/);
  assert.equal(new URL(started.location!).searchParams.get('redirect_uri'), 'http://localhost:2086/api/auth/google/callback');
});

test('/start refuses a request it cannot start a flow for — 400, nothing written, no cookie — and takes no return address from it', async (t) => {
  const { db, browser } = await boot(t);
  const challenge = s256(generateToken(32));
  for (const query of [
    'client=web',
    `client=web&code_challenge=${challenge.slice(1)}`,
    `client=web&code_challenge=${challenge}A`,
    `client=web&code_challenge=${challenge.slice(1)}%2B`,
    `client=web&code_challenge=${challenge}&code_challenge=${challenge}`,
    `client=native&code_challenge=${challenge}&client_state=${'s'.repeat(513)}`,
  ]) {
    const refused = await browser().get(`/api/auth/google/start?${query}`);
    assert.equal(refused.status, 400, `${query.slice(0, 80)}: ${refused.status} ${refused.text}`);
    assert.equal(refused.location, null);
    assert.equal(refused.setCookie, null);
  }
  assert.equal(db.flows.size, 0);

  // A request that names somewhere to return to is started as any other: Google is told the one
  // callback this deployment has, and the flow keeps nothing of what was named.
  const named = await browser().get(
    `/api/auth/google/start?client=web&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`
      + `&next=${encodeURIComponent('https://evil.example/')}&return_to=%2F%2Fevil.example`,
  );
  assert.equal(named.status, 302, named.text);
  assert.equal(new URL(named.location!).searchParams.getAll('redirect_uri').join(), CALLBACK);
  assert.ok(!JSON.stringify([...db.flows.values()]).includes('evil'));
});

test('/start sweeps the flows past their end and keeps the rest; past the cap of flows in flight it is refused 503', async (t) => {
  const { db, browser } = await boot(t);
  const challenge = s256(generateToken(32));
  const flow = (over: Row) => {
    const row: Row = {
      id: randomUUID(), provider: 'google', intent: 'LOGIN', client: 'WEB', stateHash: randomUUID(), bindingHash: 'b', nonce: 'n',
      providerCodeVerifier: 'v', clientChallenge: challenge, clientState: null, linkUserId: null, status: 'PENDING', claims: null,
      ticketHash: null, ticketExpiresAt: null, createdAt: new Date(), ...over,
    };
    db.flows.set(row.id, row);
    return row;
  };
  const past = new Date(Date.now() - 1_000);
  const soon = new Date(Date.now() + 60_000);
  const expiredPending = flow({ expiresAt: past });
  const expiredTicket = flow({ status: 'AUTHENTICATED', claims: { sub: 's' }, ticketHash: 't1', ticketExpiresAt: past, expiresAt: past });
  const liveTicket = flow({ status: 'AUTHENTICATED', claims: { sub: 's' }, ticketHash: 't2', ticketExpiresAt: soon, expiresAt: soon });
  const livePending = flow({ expiresAt: soon });

  const started = await browser().get(`/api/auth/google/start?client=web&code_challenge=${challenge}`);
  assert.equal(started.status, 302, started.text);
  assert.ok(!db.flows.has(expiredPending.id) && !db.flows.has(expiredTicket.id), 'the rows past their end are swept');
  assert.ok(db.flows.has(liveTicket.id) && db.flows.has(livePending.id), 'the rest are kept');
  assert.equal(db.flows.size, 3);

  // The cap counts the flows waiting on Google, and refuses the start that would pass it.
  for (let i = db.flows.size - 1; i < GOOGLE_PENDING_FLOW_CAP; i += 1) flow({ expiresAt: soon });
  const pending = () => [...db.flows.values()].filter((row) => row.status === 'PENDING').length;
  assert.equal(pending(), GOOGLE_PENDING_FLOW_CAP);
  const busy = await browser().get(`/api/auth/google/start?client=native&code_challenge=${challenge}&client_state=s`);
  assert.equal(busy.status, 503, busy.text);
  assert.equal(busy.json?.code, 'GOOGLE_SIGN_IN_BUSY');
  assert.equal(busy.setCookie, null);
  assert.equal(pending(), GOOGLE_PENDING_FLOW_CAP, 'nothing was written past the cap');

  // Flows that end make room: one past its end is swept by the next start, which then fits.
  livePending.expiresAt = past;
  const roomy = await browser().get(`/api/auth/google/start?client=web&code_challenge=${challenge}`);
  assert.equal(roomy.status, 302, roomy.text);
  assert.ok(!db.flows.has(livePending.id));
  assert.equal(pending(), GOOGLE_PENDING_FLOW_CAP);
});

test('/start and /exchange are budgeted per address: past the budget 429, and another address is not affected', async (t) => {
  const { db, call, exchange } = await boot(t);
  const challenge = s256(generateToken(32));
  const start = (address: string) => call('GET', `/api/auth/google/start?client=web&code_challenge=${challenge}`, { address });
  for (let i = 0; i < GOOGLE_START_RATE_LIMIT.max; i += 1) assert.equal((await start('203.0.113.10')).status, 302);
  const limited = await start('203.0.113.10');
  assert.equal(limited.status, 429, limited.text);
  assert.equal(limited.setCookie, null);
  assert.equal(db.flows.size, GOOGLE_START_RATE_LIMIT.max, 'a refused start writes nothing');
  assert.equal((await start('203.0.113.11')).status, 302, 'another address');

  for (let i = 0; i < GOOGLE_EXCHANGE_RATE_LIMIT.max; i += 1) {
    assert.equal((await exchange(generateToken(32), generateToken(32), '203.0.113.10')).status, 400);
  }
  const tooMany = await exchange(generateToken(32), generateToken(32), '203.0.113.10');
  assert.equal(tooMany.status, 429, tooMany.text);
  assert.equal((await exchange(generateToken(32), generateToken(32), '203.0.113.11')).status, 400, 'another address');
});

test('Web, end to end: the callback sends /login a ticket, and its exchange answers exactly what POST /auth/login answers', async (t) => {
  const { db, google, call, answers, startAtGoogle, exchange } = await boot(t);
  const ada = seedAda(db);
  const { visitor, verifier, callback } = await startAtGoogle({ account: { ...ADA, hd: 'example.com' } });

  const before = Date.now();
  const back = await visitor.get(callback);
  assert.equal(back.status, 302, back.text);
  assert.equal(back.setCookie, BINDING_CLEARED, 'the callback clears the binding cookie');
  assert.equal(visitor.cookie, null);
  const target = /^\/login\?google_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location!);
  assert.ok(target, `a relative /login with the ticket: ${back.location}`);
  const ticket = target[1];

  // Google was asked once, with the verifier of the challenge /start sent it.
  assert.equal(google.tokenRequests.length, 1);
  const [flow] = db.flows.values();
  assert.equal(google.tokenRequests[0].get('code_verifier'), flow.providerCodeVerifier);
  assert.equal(google.tokenRequests[0].get('redirect_uri'), CALLBACK);
  assert.equal(flow.status, 'AUTHENTICATED');
  assert.deepEqual(flow.claims, { sub: ADA.sub, email: ADA.email, emailVerified: true, hd: 'example.com', name: 'Ada Lovelace' });
  assert.equal(flow.ticketHash, sha256(ticket), 'the ticket is kept as its hash');
  const ticketTtl = flow.ticketExpiresAt.getTime() - before;
  assert.ok(ticketTtl >= GOOGLE_TICKET_TTL_MS - 1_000 && ticketTtl <= GOOGLE_TICKET_TTL_MS + 5_000, `two minutes, not ${ticketTtl} ms`);
  assert.equal(flow.expiresAt.getTime(), flow.ticketExpiresAt.getTime(), 'the row now ends with its ticket');
  assert.ok(!JSON.stringify(flow).includes(ticket));

  const session = await exchange(ticket, verifier);
  assert.equal(session.status, 201, session.text);
  assert.equal(db.flows.size, 0, 'the exchange took the flow out');

  const login = await call('POST', '/api/auth/login', { body: { email: ada.email, password: 'pw-ada-123' } });
  assert.equal(login.status, 201, login.text);
  const shapeOf = (json: Row) => ({
    keys: Object.keys(json).sort(),
    user: json.user,
    claims: Object.keys(claimsOf(json.accessToken)).sort(),
    sub: claimsOf(json.accessToken).sub,
    email: claimsOf(json.accessToken).email,
    refresh: /^[A-Za-z0-9_-]{43}$/.test(json.refreshToken),
  });
  assert.deepEqual(shapeOf(session.json), shapeOf(login.json), 'the same answer as POST /auth/login');
  assert.deepEqual(Object.keys(session.json.user).sort(), ['email', 'id', 'name', 'publicId']);
  assert.equal(toUuid(session.json.user.id), ada.id);
  assert.equal(session.json.user.publicId, uuidToBase62(ada.id));
  assert.equal(session.json.user.email, ada.email);
  assert.equal(session.json.user.name, ada.name);
  assert.equal(claimsOf(session.json.accessToken).sub, ada.id);
  assert.equal(db.refreshTokens.at(-2)?.tokenHash, sha256(session.json.refreshToken), 'its refresh token is stored as a refresh token is');

  // The identity says what Google said this time; the account's own email is not Google's to change.
  const [identity] = db.identities;
  assert.equal(identity.email, ADA.email);
  assert.equal(identity.hostedDomain, 'example.com');
  assert.ok(identity.lastSignInAt instanceof Date && identity.lastSignInAt.getTime() >= before);
  assert.equal(db.users[0].email, 'ada@example.com');

  // No Google token is kept or answered anywhere.
  assert.equal(google.accessTokens.length, 1);
  for (const token of google.accessTokens) {
    assert.ok(!answers.some((answer) => answer.text.includes(token) || (answer.location ?? '').includes(token)));
    assert.ok(!JSON.stringify([db.identities, db.users, db.refreshTokens]).includes(token));
  }
});

test('native, end to end: the callback opens orbit://auth/google with the ticket and the state the app started with', async (t) => {
  const { db, startAtGoogle, exchange } = await boot(t);
  seedAda(db);
  const withState = await startAtGoogle({ client: 'native', clientState: 'app state/1+2' });
  const back = await withState.visitor.get(withState.callback);
  const target = /^orbit:\/\/auth\/google\?ticket=([A-Za-z0-9_-]{43})&state=app%20state%2F1%2B2$/.exec(back.location ?? '');
  assert.ok(target, `the app's one address, with its state: ${back.location}`);
  assert.equal(back.setCookie, BINDING_CLEARED);
  assert.equal((await exchange(target[1], withState.verifier)).status, 201);

  const stateless = await startAtGoogle({ client: 'native' });
  const plain = await stateless.visitor.get(stateless.callback);
  assert.match(plain.location ?? '', /^orbit:\/\/auth\/google\?ticket=[A-Za-z0-9_-]{43}$/);

  const declined = await startAtGoogle({ client: 'native', clientState: 's-1', deny: true });
  const cancelled = await declined.visitor.get(declined.callback);
  assert.equal(cancelled.location, 'orbit://auth/google?error=GOOGLE_CANCELLED&state=s-1');
});

test('the callback refuses as §4.2 says — state, cookie, Google\'s error, the code exchange, the claims — ending the flow and clearing the cookie each time', async (t) => {
  const { db, google, browser, startAtGoogle } = await boot(t);
  seedAda(db);

  /**
   * A callback that must be refused with `code`: to /login, the cookie cleared, no ticket issued — and,
   * for the flow whose state it presented, that flow ended.
   */
  const refused = async (
    what: string,
    answer: { status: number; location: string | null; setCookie: string | null },
    code: string,
    state?: string,
  ) => {
    assert.equal(answer.status, 302, what);
    assert.equal(answer.location, `/login?google_error=${code}`, what);
    assert.equal(answer.setCookie, BINDING_CLEARED, `${what}: the cookie is cleared`);
    assert.ok(![...db.flows.values()].some((flow) => flow.status === 'AUTHENTICATED'), `${what}: no ticket was issued`);
    if (state !== undefined) {
      assert.ok(![...db.flows.values()].some((flow) => flow.stateHash === sha256(state)), `${what}: the flow was ended`);
    }
  };

  // (1) The state: unknown, missing, or more than one — back to the Web login, nothing to end.
  await refused('an unknown state', await browser().get(`/api/auth/google/callback?state=${generateToken(32)}&code=c`), 'GOOGLE_FLOW_EXPIRED');
  await refused('no state', await browser().get('/api/auth/google/callback?code=c'), 'GOOGLE_FLOW_EXPIRED');
  const twice = await startAtGoogle();
  await refused('two states', await twice.visitor.get(`${twice.callback}&state=${twice.state}`), 'GOOGLE_FLOW_EXPIRED');
  assert.equal([...db.flows.values()].filter((flow) => flow.stateHash === sha256(twice.state)).length, 1, 'a state it could not read ends nothing');

  // (1) A flow past its ten minutes is expired, and ended.
  const late = await startAtGoogle();
  const lateFlow = [...db.flows.values()].find((flow) => flow.stateHash === sha256(late.state))!;
  lateFlow.expiresAt = new Date(Date.now() - 1);
  await refused('a flow past its ten minutes', await late.visitor.get(late.callback), 'GOOGLE_FLOW_EXPIRED', late.state);

  // (2) The browser that started the flow finishes it: without the cookie, or with another flow's,
  // the flow is refused and ended — the right cookie cannot finish it afterwards.
  const tokenRequests = google.tokenRequests.length;
  const victim = await startAtGoogle();
  const elsewhere = browser();
  await refused('no binding cookie', await elsewhere.get(victim.callback), 'GOOGLE_FLOW_EXPIRED', victim.state);
  await refused('the right cookie, after', await victim.visitor.get(victim.callback), 'GOOGLE_FLOW_EXPIRED');
  const crossed = await startAtGoogle();
  const other = await startAtGoogle();
  other.visitor.cookie = crossed.visitor.cookie;
  await refused("another flow's cookie", await other.visitor.get(other.callback), 'GOOGLE_FLOW_EXPIRED', other.state);
  assert.ok([...db.flows.values()].some((flow) => flow.stateHash === sha256(crossed.state)), 'the flow the cookie belongs to is not touched');
  assert.equal(google.tokenRequests.length, tokenRequests, 'no code was traded for a flow this browser did not start');

  // (3) Google's own error.
  const declined = await startAtGoogle({ deny: true });
  await refused('access_denied', await declined.visitor.get(declined.callback), 'GOOGLE_CANCELLED', declined.state);
  assert.equal(google.tokenRequests.length, tokenRequests);

  // (4) The code exchange.
  const exchanged = async (answer: FakeTokenAnswer) => {
    const flow = await startAtGoogle();
    google.tokenAnswer = answer;
    try {
      await refused(`token endpoint ${answer}`, await flow.visitor.get(flow.callback), 'GOOGLE_EXCHANGE_FAILED', flow.state);
    } finally {
      google.tokenAnswer = 'ok';
    }
  };
  for (const answer of ['refused', 'unreachable', 'not-json', 'no-id-token', 'not-a-jwt'] as const) await exchanged(answer);
  const codeless = await startAtGoogle();
  await refused('no code', await codeless.visitor.get(codeless.callback.replace(/&code=[^&]+/, '')), 'GOOGLE_EXCHANGE_FAILED', codeless.state);

  // (5) The claims of the ID token.
  const now = Math.floor(Date.now() / 1000);
  const claimCases: Array<[string, Row, string]> = [
    ['another nonce', { nonce: 'not-the-flows' }, 'GOOGLE_EXCHANGE_FAILED'],
    ['another audience', { aud: 'another.apps.googleusercontent.com' }, 'GOOGLE_EXCHANGE_FAILED'],
    ['audiences without this azp', { aud: [CLIENT_ID, 'other'], azp: 'other' }, 'GOOGLE_EXCHANGE_FAILED'],
    ['another issuer', { iss: 'https://accounts.example.com' }, 'GOOGLE_EXCHANGE_FAILED'],
    ['expired past the skew', { exp: now - 120 }, 'GOOGLE_EXCHANGE_FAILED'],
    ['an empty sub', { sub: '' }, 'GOOGLE_EXCHANGE_FAILED'],
    ['email_verified false', { email_verified: false }, 'GOOGLE_EMAIL_UNVERIFIED'],
    ['email_verified "true"', { email_verified: 'true' }, 'GOOGLE_EMAIL_UNVERIFIED'],
  ];
  for (const [what, claims, code] of claimCases) {
    const flow = await startAtGoogle({ claims });
    await refused(what, await flow.visitor.get(flow.callback), code, flow.state);
  }
  // Within the skew it passes: the control for the expiry case.
  const skewed = await startAtGoogle({ claims: { exp: now - 30 } });
  assert.match((await skewed.visitor.get(skewed.callback)).location ?? '', /^\/login\?google_ticket=/);

  // What is left: the one that passed, with its ticket, and the two flows no callback could reach.
  assert.deepEqual([...db.flows.values()].map((flow) => flow.status).sort(), ['AUTHENTICATED', 'PENDING', 'PENDING']);
});

test('the callback: a state is used once — a replay after a ticket leaves the ticket alone, and a replay after a refusal finds nothing', async (t) => {
  const { db, google, startAtGoogle, exchange } = await boot(t);
  seedAda(db);
  const first = await startAtGoogle({ client: 'native', clientState: 'one' });
  const callbackWithCookie = first.visitor.cookie;
  const done = await first.visitor.get(first.callback);
  const ticket = /ticket=([^&]+)/.exec(done.location!)![1];

  // The same callback again — the back button, or someone who holds the address and the cookie.
  first.visitor.cookie = callbackWithCookie;
  const replay = await first.visitor.get(first.callback);
  assert.equal(replay.location, 'orbit://auth/google?error=GOOGLE_FLOW_EXPIRED&state=one');
  assert.equal(replay.setCookie, BINDING_CLEARED);
  assert.equal((await exchange(ticket, first.verifier)).status, 201, 'the replay did not take the ticket from the app');

  // A refused callback ends its flow, so its replay is a flow nobody knows: the Web login.
  const declined = await startAtGoogle({ client: 'native', clientState: 'two', deny: true });
  const cookie = declined.visitor.cookie;
  assert.equal((await declined.visitor.get(declined.callback)).location, 'orbit://auth/google?error=GOOGLE_CANCELLED&state=two');
  declined.visitor.cookie = cookie;
  assert.equal((await declined.visitor.get(declined.callback)).location, '/login?google_error=GOOGLE_FLOW_EXPIRED');

  // Two callbacks with one state at once — even from a Google that traded the code twice — get one
  // ticket between them: the flow becomes AUTHENTICATED once.
  google.codesTradeOnce = false;
  const raced = await startAtGoogle();
  google.holdTokenRequests(2);
  const binding = raced.visitor.cookie;
  const answers = await Promise.all([0, 1].map(() => {
    raced.visitor.cookie = binding;
    return raced.visitor.get(raced.callback);
  }));
  assert.equal(google.tokenRequests.filter((form) => form.get('code') === new URLSearchParams(raced.callback.split('?')[1]).get('code')).length, 2);
  assert.deepEqual(
    answers.map((answer) => (/google_ticket=/.test(answer.location ?? '') ? 'ticket' : answer.location)).sort(),
    ['/login?google_error=GOOGLE_FLOW_EXPIRED', 'ticket'],
  );
  const won = /google_ticket=([^&]+)/.exec(answers.find((answer) => /google_ticket=/.test(answer.location ?? ''))!.location!)![1];
  assert.equal((await exchange(won, raced.verifier)).status, 201);
});

test('the callback after Google sign-in was switched off, or with a secret that no longer decrypts, sends the client back without a ticket', async (t) => {
  const { db, startAtGoogle } = await boot(t);
  const off = await startAtGoogle();
  db.provider = googleRow({ enabled: false });
  assert.equal((await off.visitor.get(off.callback)).location, '/login?google_error=GOOGLE_NOT_CONFIGURED');

  db.provider = googleRow();
  const rotated = await startAtGoogle();
  db.provider = googleRow({ clientSecretEnc: 'iv:tag:ct' });
  assert.equal((await rotated.visitor.get(rotated.callback)).location, '/login?google_error=GOOGLE_EXCHANGE_FAILED');
  assert.equal(db.flows.size, 0);
});

test('the exchange: a ticket is spent at its first presentation; expired, another verifier, or not a LOGIN — GOOGLE_FLOW_MISMATCH; of concurrent exchanges one succeeds', async (t) => {
  const { db, startAtGoogle, exchange, call } = await boot(t);
  const ada = seedAda(db);
  const ticketFor = async () => {
    const flow = await startAtGoogle();
    const back = await flow.visitor.get(flow.callback);
    return { ticket: /google_ticket=([^&]+)/.exec(back.location!)![1], verifier: flow.verifier };
  };
  const mismatch = (answer: Answer, what: string) => {
    assert.equal(answer.status, 400, `${what}: ${answer.text}`);
    assert.equal(answer.json?.code, 'GOOGLE_FLOW_MISMATCH', what);
    assert.ok(!('accessToken' in (answer.json ?? {})), what);
  };

  // Another verifier spends the ticket: the right one cannot use it afterwards.
  const wrong = await ticketFor();
  mismatch(await exchange(wrong.ticket, generateToken(32)), 'another verifier');
  mismatch(await exchange(wrong.ticket, wrong.verifier), 'the right verifier after a wrong one');
  // So does a verifier that is not one.
  const short = await ticketFor();
  mismatch(await exchange(short.ticket, 'short'), 'a verifier too short to be one');
  mismatch(await exchange(short.ticket, short.verifier), 'the right verifier after a malformed one');

  // A used ticket is spent.
  const used = await ticketFor();
  assert.equal((await exchange(used.ticket, used.verifier)).status, 201);
  mismatch(await exchange(used.ticket, used.verifier), 'a ticket used once');

  // Past its two minutes.
  const late = await ticketFor();
  const lateFlow = [...db.flows.values()].find((flow) => flow.ticketHash === sha256(late.ticket))!;
  lateFlow.ticketExpiresAt = new Date(Date.now() - 1);
  mismatch(await exchange(late.ticket, late.verifier), 'an expired ticket');
  assert.equal(db.flows.size, 0, 'it was spent all the same');

  // A LINK flow's ticket is not a sign-in (§4.3 step 2): profile linking confirms it, not this door.
  const linkVerifier = generateToken(32);
  const linkTicket = generateToken(32);
  db.flows.set('link', {
    id: 'link', provider: 'google', intent: 'LINK', client: 'WEB', stateHash: 'x', bindingHash: 'y', nonce: 'n',
    providerCodeVerifier: 'v', clientChallenge: s256(linkVerifier), clientState: null, linkUserId: ada.id,
    status: 'AUTHENTICATED', claims: { sub: ADA.sub, email: ADA.email, emailVerified: true, hd: null, name: null },
    ticketHash: sha256(linkTicket), ticketExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  });
  mismatch(await exchange(linkTicket, linkVerifier), 'a LINK ticket');
  assert.equal(db.flows.size, 0);

  // A ticket nobody issued.
  mismatch(await exchange(generateToken(32), generateToken(32)), 'an unknown ticket');

  // Concurrent presentations of one ticket: one session.
  const raced = await ticketFor();
  const answers = await Promise.all(Array.from({ length: 8 }, () => exchange(raced.ticket, raced.verifier)));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 400, 400, 400, 400, 400, 400, 400]);

  // A body without both is refused before anything is spent.
  const kept = await ticketFor();
  for (const body of [{ ticket: kept.ticket }, { codeVerifier: kept.verifier }, { ticket: 1, codeVerifier: kept.verifier }]) {
    assert.equal((await call('POST', '/api/auth/google/exchange', { body })).status, 400);
  }
  assert.equal((await exchange(kept.ticket, kept.verifier)).status, 201);
});

test('the exchange of a Google account no Orbit account is linked to or has the email of, under EXISTING_ACCOUNTS: 403 GOOGLE_ACCOUNT_NOT_FOUND, and the ticket is spent', async (t) => {
  const { db, startAtGoogle, exchange } = await boot(t);
  seedAda(db, false);
  const flow = await startAtGoogle();
  const ticket = /google_ticket=([^&]+)/.exec((await flow.visitor.get(flow.callback)).location!)![1];
  const refused = await exchange(ticket, flow.verifier);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json?.code, 'GOOGLE_ACCOUNT_NOT_FOUND');
  assert.equal(db.flows.size, 0);
  assert.equal(db.refreshTokens.length, 0, 'no session was issued');
  assert.equal((await exchange(ticket, flow.verifier)).json?.code, 'GOOGLE_FLOW_MISMATCH');
});

test('the exchange while Google sign-in is off is refused 403 GOOGLE_NOT_CONFIGURED, and the ticket is left as it was', async (t) => {
  const { db, startAtGoogle, exchange } = await boot(t);
  seedAda(db);
  const flow = await startAtGoogle();
  const ticket = /google_ticket=([^&]+)/.exec((await flow.visitor.get(flow.callback)).location!)![1];
  db.provider = googleRow({ enabled: false });
  const refused = await exchange(ticket, flow.verifier);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json?.code, 'GOOGLE_NOT_CONFIGURED');
  assert.equal(db.flows.size, 1);
  db.provider = googleRow();
  assert.equal((await exchange(ticket, flow.verifier)).status, 201);
});

test('§4.2\'s table of where the callback sends the browser — relative paths for the Web, one fixed address for the apps — and nothing a request names', async (t) => {
  // The table itself.
  assert.equal(googleSuccessRedirect('web', 'T'), '/login?google_ticket=T');
  assert.equal(googleFailureRedirect('web', 'CODE'), '/login?google_error=CODE');
  assert.equal(googleSuccessRedirect('web', 'T', undefined, 'LINK'), '/settings/profile?google_link_ticket=T');
  assert.equal(googleFailureRedirect('web', 'CODE', undefined, 'LINK'), '/settings/profile?google_error=CODE');
  assert.equal(googleSuccessRedirect('native', 'T', 's'), 'orbit://auth/google?ticket=T&state=s');
  assert.equal(googleFailureRedirect('native', 'CODE', 's'), 'orbit://auth/google?error=CODE&state=s');
  assert.equal(googleSuccessRedirect('web', 'T', 'ignored'), '/login?google_ticket=T', "the Web's targets take no state");

  // Through the callback: a LINK flow (as the profile page's link will start one, §5.3) comes back to
  // the profile page, success or failure.
  const { db, google, browser, startAtGoogle } = await boot(t);
  const ada = seedAda(db);
  const linkFlow = async () => {
    const started = await startAtGoogle();
    const flow = [...db.flows.values()].find((row) => row.stateHash === sha256(started.state))!;
    flow.intent = 'LINK';
    flow.linkUserId = ada.id;
    return started;
  };
  const linked = await linkFlow();
  assert.match((await linked.visitor.get(linked.callback)).location ?? '', /^\/settings\/profile\?google_link_ticket=[A-Za-z0-9_-]{43}$/);
  const linkDenied = await linkFlow();
  const denied = google.deny(linkDenied.authorization);
  assert.equal((await linkDenied.visitor.get(denied)).location, '/settings/profile?google_error=GOOGLE_CANCELLED');

  // A callback that names somewhere to go is answered exactly as one that does not.
  const named = await startAtGoogle();
  const extra = `&redirect_uri=${encodeURIComponent('https://evil.example/')}&next=${encodeURIComponent('//evil.example')}`
    + `&return_to=${encodeURIComponent('https://evil.example/')}&continue=${encodeURIComponent('javascript:alert(1)')}`;
  const answer = await named.visitor.get(`${named.callback}${extra}`);
  assert.match(answer.location ?? '', /^\/login\?google_ticket=[A-Za-z0-9_-]{43}$/);
  const refused = await browser().get(`/api/auth/google/callback?state=nope${extra}`);
  assert.equal(refused.location, '/login?google_error=GOOGLE_FLOW_EXPIRED');
});

test('the password login and the first-run bootstrap leave by AuthService.completeLogin, as the Google exchange does', async (t) => {
  const { db, call, startAtGoogle, exchange } = await boot(t);
  const exits: string[] = [];
  const original = AuthService.prototype.completeLogin;
  AuthService.prototype.completeLogin = function (this: AuthService, user) {
    exits.push(user.email);
    return original.call(this, user);
  };
  t.after(() => { AuthService.prototype.completeLogin = original; });

  const first = await call('POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', name: 'Root', password: 'pw-root-123' } });
  assert.equal(first.status, 201, first.text);
  const login = await call('POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'pw-root-123' } });
  assert.equal(login.status, 201, login.text);
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'nope' } });
  assert.equal(wrong.status, 401);
  seedAda(db);
  const flow = await startAtGoogle();
  const ticket = /google_ticket=([^&]+)/.exec((await flow.visitor.get(flow.callback)).location!)![1];
  assert.equal((await exchange(ticket, flow.verifier)).status, 201);
  assert.deepEqual(exits, ['root@example.com', 'root@example.com', 'ada@example.com'], 'one exit per sign-in, and none for a refused one');
});
