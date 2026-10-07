process.env.PROVIDER_SECRET_KEY = 'google-sign-in-config-spec';
// With a trailing slash, as an operator may write it; the redirect URI drops it.
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test/';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminSignInController } from './admin-sign-in.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService } from './google-login.service';
import { GoogleOAuthClient } from './google-oauth.client';
import { JwtAuthGuard } from './jwt-auth.guard';
import { googleRedirectUri, SignInProvidersService } from './sign-in-providers.service';

/**
 * Google sign-in's configuration and its default, off (docs/google-sign-in-design.md §4.1, §6,
 * §7.1): `GET /auth/methods`, `GET /auth/google/start` while Google sign-in is off, and the admin
 * area's `GET` / `PUT /admin/sign-in/google`.
 *
 * Over real HTTP, through the controllers, JwtAuthGuard, AdminRoleGuard and the global validation
 * pipe the app runs, against an in-memory `sign_in_provider`. The same doors against PostgreSQL
 * and the production apiserver are `google-sign-in-config.pg.spec.ts`'s.
 */

const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();
const SECRET = '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c';
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const REDIRECT_URI = 'https://orbit.example.test/api/auth/google/callback';
const OFF = { password: true, google: false, googleSignup: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
/** The `sign_in_provider` table: at most the one `google` row. */
let stored: Row | null = null;
/** Every upsert the service asked for. */
const upserts: Row[] = [];

const prisma = {
  signInProvider: {
    findUnique: async ({ where }: { where: { provider: string } }) =>
      (stored && where.provider === stored.provider ? { ...stored } : null),
    upsert: async (args: { where: { provider: string }; create: Row; update: Row }) => {
      upserts.push(args);
      stored = stored ? { ...stored, ...args.update, updatedAt: new Date() } : { ...args.create, updatedAt: new Date() };
      return { ...stored };
    },
  },
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({ role: where.id === ADMIN_ID ? 'ADMIN' : 'MEMBER' }),
  },
};

/** The row as the last write left it. (A function, so a case that started from `stored = null` reads it.) */
function storedRow(): Row {
  assert.ok(stored, 'no sign_in_provider row');
  return stored;
}

/** A complete row, as an administrator's save leaves it; `over` changes what one case is about. */
function row(over: Row = {}): Row {
  return {
    provider: 'google',
    enabled: true,
    clientId: CLIENT_ID,
    clientSecretEnc: encryptSecret(SECRET),
    signupPolicy: 'EXISTING_ACCOUNTS',
    updatedById: ADMIN_ID,
    updatedAt: new Date(),
    ...over,
  };
}

/** The ciphertext a *different* `PROVIDER_SECRET_KEY` wrote: what rotating that key leaves behind. */
function encryptWithKey(key: string, plaintext: string): string {
  const before = process.env.PROVIDER_SECRET_KEY;
  process.env.PROVIDER_SECRET_KEY = key;
  try {
    return encryptSecret(plaintext);
  } finally {
    process.env.PROVIDER_SECRET_KEY = before;
  }
}

@Module({
  controllers: [AuthController, GoogleAuthController, AdminSignInController],
  providers: [
    SignInProvidersService,
    GoogleLoginService,
    // No case here gets as far as Google; one that did would fail rather than reach the network.
    { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(async () => assert.fail('a Google endpoint was called')) },
    JwtAuthGuard,
    AdminRoleGuard,
    Reflector,
    // The password doors are not on trial here; their regression runs against PostgreSQL.
    { provide: AuthService, useValue: {} },
    {
      provide: JwtService,
      useValue: {
        verifyAsync: async (token: string) => {
          if (token === 'admin') return { sub: ADMIN_ID, email: 'admin@example.test' };
          if (token === 'member') return { sub: MEMBER_ID, email: 'member@example.test' };
          throw new Error('invalid token');
        },
      },
    },
    { provide: PrismaService, useValue: prisma },
  ],
})
class SignInModule {}

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  location: string | null;
  setCookie: string | null;
}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await NestFactory.create(SignInModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  /** Every answer this server gave, so a case can say what none of them contains. */
  const answers: Answer[] = [];
  const call = async (method: string, route: string, options: { bearer?: string; body?: unknown } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
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
  return { call, answers };
}

/** `/start` refuses as §4.1 says while Google sign-in is off: back to the client, GOOGLE_NOT_CONFIGURED. */
async function assertStartRefuses(call: Awaited<ReturnType<typeof boot>>['call'], state: string) {
  const web = await call('GET', '/api/auth/google/start?client=web&code_challenge=' + 'a'.repeat(43));
  assert.equal(web.status, 302, `${state}: web /start answered ${web.status}: ${web.text}`);
  assert.equal(web.location, '/login?google_error=GOOGLE_NOT_CONFIGURED', state);
  assert.equal(web.setCookie, null, `${state}: a refused /start binds no flow to the browser`);

  const native = await call('GET', '/api/auth/google/start?client=native&code_challenge=' + 'a'.repeat(43) + '&client_state=s%20t%2B8');
  assert.equal(native.status, 302, `${state}: native /start answered ${native.status}: ${native.text}`);
  // The state comes back as the app sent it, percent-encoded rather than as `+` for a space.
  assert.equal(native.location, 'orbit://auth/google?error=GOOGLE_NOT_CONFIGURED&state=s%20t%2B8', state);

  const stateless = await call('GET', '/api/auth/google/start?client=native');
  assert.equal(stateless.status, 302, state);
  assert.equal(stateless.location, 'orbit://auth/google?error=GOOGLE_NOT_CONFIGURED', state);

  // No client, or one that is neither: there is nowhere to send the browser back to.
  for (const query of ['', '?client=ios', '?client=web&client=native']) {
    const refused = await call('GET', `/api/auth/google/start${query}`);
    assert.equal(refused.status, 400, `${state}: /start${query} answered ${refused.status}: ${refused.text}`);
    assert.equal(refused.location, null);
  }
}

test('not configured: /auth/methods offers the password alone and /auth/google/start refuses back to the client', async (t) => {
  stored = null;
  upserts.length = 0;
  const { call } = await boot(t);

  const methods = await call('GET', '/api/auth/methods');
  assert.equal(methods.status, 200, methods.text);
  assert.deepEqual(methods.json, OFF);
  await assertStartRefuses(call, 'not configured');
  assert.equal(upserts.length, 0, 'reading the methods or refusing a start writes nothing');
  assert.equal(stored, null);
});

test('switched off, or on without a client ID or a secret: the same answers as not configured', async (t) => {
  upserts.length = 0;
  const { call } = await boot(t);

  const off: Array<[string, Row]> = [
    ['switched off', row({ enabled: false })],
    ['switched off, sign-up OPEN', row({ enabled: false, signupPolicy: 'OPEN' })],
    ['on, no client ID', row({ clientId: '', signupPolicy: 'OPEN' })],
    ['on, no secret', row({ clientSecretEnc: '', signupPolicy: 'OPEN' })],
  ];
  for (const [state, value] of off) {
    stored = value;
    const methods = await call('GET', '/api/auth/methods');
    assert.equal(methods.status, 200, `${state}: ${methods.text}`);
    assert.deepEqual(methods.json, OFF, state);
    await assertStartRefuses(call, state);
  }
  assert.equal(upserts.length, 0);
});

test('on: /auth/methods offers Google, and sign-up only under OPEN; /start no longer answers GOOGLE_NOT_CONFIGURED', async (t) => {
  const { call } = await boot(t);

  stored = row();
  assert.deepEqual((await call('GET', '/api/auth/methods')).json, { password: true, google: true, googleSignup: false });
  stored = row({ signupPolicy: 'OPEN' });
  assert.deepEqual((await call('GET', '/api/auth/methods')).json, { password: true, google: true, googleSignup: true });

  // On, /start goes on to the flow (google-sign-in-flow.http.spec.ts): one without a challenge is
  // refused for the challenge, not sent back GOOGLE_NOT_CONFIGURED.
  const start = await call('GET', '/api/auth/google/start?client=web');
  assert.equal(start.status, 400, start.text);
  assert.match(start.text, /code_challenge/);
  assert.equal(start.location, null);
});

test('admin: GET and PUT /admin/sign-in/google save and read back the setting, keep the secret encrypted, and never answer it', async (t) => {
  stored = null;
  upserts.length = 0;
  const { call, answers } = await boot(t);

  // Nothing saved yet: the defaults, with the address to register in the Google console.
  const empty = await call('GET', '/api/admin/sign-in/google', { bearer: 'admin' });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json, {
    enabled: false,
    clientId: '',
    hasSecret: false,
    secretUnreadable: false,
    signupPolicy: 'EXISTING_ACCOUNTS',
    redirectUri: REDIRECT_URI,
  });

  // Saved switched off first, with surrounding whitespace a paste brings along.
  const saved = await call('PUT', '/api/admin/sign-in/google', {
    bearer: 'admin',
    body: { enabled: false, clientId: ` ${CLIENT_ID}\n`, clientSecret: ` ${SECRET} `, signupPolicy: 'OPEN' },
  });
  assert.equal(saved.status, 200, saved.text);
  const savedView = {
    enabled: false,
    clientId: CLIENT_ID,
    hasSecret: true,
    secretUnreadable: false,
    signupPolicy: 'OPEN',
    redirectUri: REDIRECT_URI,
  };
  assert.deepEqual(saved.json, savedView);
  assert.equal(storedRow().updatedById, ADMIN_ID);
  assert.notEqual(storedRow().clientSecretEnc, SECRET);
  assert.match(storedRow().clientSecretEnc, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, 'iv:tag:ct');
  assert.equal(decryptSecret(storedRow().clientSecretEnc), SECRET, 'what is stored decrypts to the secret, trimmed');
  const ciphertext = storedRow().clientSecretEnc;

  assert.deepEqual((await call('GET', '/api/admin/sign-in/google', { bearer: 'admin' })).json, savedView);
  assert.deepEqual((await call('GET', '/api/auth/methods')).json, OFF, 'saved, but switched off');

  // Switched on without a secret in the body: the saved one stays, byte for byte.
  const on = await call('PUT', '/api/admin/sign-in/google', {
    bearer: 'admin',
    body: { enabled: true, clientId: CLIENT_ID, signupPolicy: 'EXISTING_ACCOUNTS' },
  });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.json, { ...savedView, enabled: true, signupPolicy: 'EXISTING_ACCOUNTS' });
  assert.equal(storedRow().clientSecretEnc, ciphertext);
  assert.ok(!('clientSecretEnc' in upserts.at(-1)!.update), 'a save without a secret does not write the column');
  assert.deepEqual((await call('GET', '/api/auth/methods')).json, { password: true, google: true, googleSignup: false });

  // A new secret replaces it.
  const rotated = await call('PUT', '/api/admin/sign-in/google', {
    bearer: 'admin',
    body: { enabled: true, clientId: CLIENT_ID, clientSecret: `${SECRET}-2`, signupPolicy: 'EXISTING_ACCOUNTS' },
  });
  assert.equal(rotated.status, 200, rotated.text);
  assert.notEqual(storedRow().clientSecretEnc, ciphertext);
  assert.equal(decryptSecret(storedRow().clientSecretEnc), `${SECRET}-2`);

  // Neither the secret nor what is stored for it is in any answer this server gave.
  for (const answer of answers) {
    for (const secret of [SECRET, `${SECRET}-2`, ciphertext, storedRow().clientSecretEnc]) {
      assert.ok(!answer.text.includes(secret), `an answer carried the secret: ${answer.text}`);
    }
    assert.ok(!/clientSecret/.test(answer.text), `an answer named the secret: ${answer.text}`);
  }
});

test('admin: a secret the PROVIDER_SECRET_KEY in force cannot decrypt is reported, still never answered', async (t) => {
  // The row a rotation leaves behind (§7.1): ciphertext written under the key that has since gone.
  stored = row({ clientSecretEnc: encryptWithKey('the-PROVIDER_SECRET_KEY-before-the-rotation', SECRET) });
  const { call, answers } = await boot(t);

  const view = await call('GET', '/api/admin/sign-in/google', { bearer: 'admin' });
  assert.equal(view.status, 200, `an unreadable secret is answered, not raised: ${view.text}`);
  assert.deepEqual(view.json, {
    enabled: true,
    clientId: CLIENT_ID,
    hasSecret: true,
    secretUnreadable: true,
    signupPolicy: 'EXISTING_ACCOUNTS',
    redirectUri: REDIRECT_URI,
  }, 'the saved setting is reported as it stands, and the secret as unreadable');

  // What the login page offers is not this flag's business: /auth/methods still holds the setting, and
  // the failure a person meets is the Google sign-in one (§4.3). Here it only has to stay an ordinary
  // answer — no fifth field, nothing about the secret.
  const methods = await call('GET', '/api/auth/methods');
  assert.equal(methods.status, 200, methods.text);
  assert.deepEqual(methods.json, { password: true, google: true, googleSignup: false });

  // A rotation is not a leak: no answer carries the secret, the ciphertext, or a name for either.
  for (const answer of answers) {
    assert.ok(!answer.text.includes(SECRET), `an answer carried the secret: ${answer.text}`);
    assert.ok(!answer.text.includes(storedRow().clientSecretEnc), `an answer carried the ciphertext: ${answer.text}`);
    assert.ok(!/clientSecret/.test(answer.text), `an answer named the secret: ${answer.text}`);
  }

  // Entering a secret again is what clears it: the save answers readable from then on.
  const saved = await call('PUT', '/api/admin/sign-in/google', {
    bearer: 'admin',
    body: { enabled: true, clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'EXISTING_ACCOUNTS' },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json, {
    enabled: true,
    clientId: CLIENT_ID,
    hasSecret: true,
    secretUnreadable: false,
    signupPolicy: 'EXISTING_ACCOUNTS',
    redirectUri: REDIRECT_URI,
  });
  assert.deepEqual((await call('GET', '/api/admin/sign-in/google', { bearer: 'admin' })).json, saved.json);
});

test('admin: a body the setting cannot hold is refused before anything is written', async (t) => {
  stored = null;
  upserts.length = 0;
  const { call } = await boot(t);

  const good = { enabled: true, clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'EXISTING_ACCOUNTS' };
  const bad: Array<[string, Row]> = [
    ['no enabled', { ...good, enabled: undefined }],
    ['enabled as a string', { ...good, enabled: 'true' }],
    ['no clientId', { ...good, clientId: undefined }],
    ['an empty secret', { ...good, clientSecret: '' }],
    ['a secret of spaces', { ...good, clientSecret: '   ' }],
    ['a secret that is not a string', { ...good, clientSecret: 42 }],
    ['no signupPolicy', { ...good, signupPolicy: undefined }],
    ['an unknown signupPolicy', { ...good, signupPolicy: 'open' }],
  ];
  for (const [what, body] of bad) {
    const refused = await call('PUT', '/api/admin/sign-in/google', { bearer: 'admin', body });
    assert.equal(refused.status, 400, `${what}: answered ${refused.status}: ${refused.text}`);
  }
  assert.equal(upserts.length, 0);
  assert.equal(stored, null);
});

test('admin: only a signed-in ADMIN reaches the setting', async (t) => {
  stored = row();
  upserts.length = 0;
  const { call } = await boot(t);

  const body = { enabled: false, clientId: '', signupPolicy: 'OPEN' };
  for (const [who, bearer, status] of [['nobody', undefined, 401], ['a MEMBER', 'member', 403]] as const) {
    const read = await call('GET', '/api/admin/sign-in/google', { bearer });
    assert.equal(read.status, status, `GET by ${who}: ${read.text}`);
    const write = await call('PUT', '/api/admin/sign-in/google', { bearer, body });
    assert.equal(write.status, status, `PUT by ${who}: ${write.text}`);
  }
  assert.equal(upserts.length, 0);
  assert.equal(storedRow().enabled, true, 'nothing was written');
});

test('the redirect URI is PUBLIC_ORIGIN, read as the shared pool reads it, and the callback path', () => {
  const saved = process.env.PUBLIC_ORIGIN;
  try {
    process.env.PUBLIC_ORIGIN = '  https://orbit.example.test//  ';
    assert.equal(googleRedirectUri(), REDIRECT_URI);
    delete process.env.PUBLIC_ORIGIN;
    assert.equal(googleRedirectUri(), 'http://localhost:2086/api/auth/google/callback');
    process.env.PUBLIC_ORIGIN = '   ';
    assert.equal(googleRedirectUri(), 'http://localhost:2086/api/auth/google/callback');
  } finally {
    process.env.PUBLIC_ORIGIN = saved;
  }
});

test('googleClient() hands the Google routes the decrypted client while on, and nothing while off', async () => {
  const service = new SignInProvidersService(prisma as unknown as PrismaService);
  stored = null;
  assert.equal(await service.googleClient(), null);
  await service.updateGoogle(ADMIN_ID, { enabled: true, clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'OPEN' });
  assert.deepEqual(await service.googleClient(), { clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'OPEN' });
  await service.updateGoogle(ADMIN_ID, { enabled: false, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
  assert.equal(await service.googleClient(), null);
});
