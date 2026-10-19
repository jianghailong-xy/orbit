import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { PatService } from '../auth/pat.service';
import { SignInProvidersService } from '../auth/sign-in-providers.service';
import { hashPassword, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import { MANAGED_RUNNERS_ENABLED_ENV, ManagedRunnerGateModule } from './managed-runner-gate';
import { MANAGED_RUNNERS_PROFILE_ENV } from './managed-runner-profile';
import { MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { MANAGED_RUNNER_SIGN_IN } from './managed-runner-sign-in';
import { ManagedRunnerModule } from './managed-runner.module';
import { ManagedRunnerService } from './managed-runner.service';

// The sign-in step of managed runners (docs/managed-runner-design.md, "Default disabled gate"):
//   - it is called from AuthService.completeLogin alone — password login, first-user bootstrap and a
//     Google ticket — after the tokens, and never from refresh, logout, a password change or the
//     capability read;
//   - with ORBIT_MANAGED_RUNNERS_ENABLED absent or false, login and bootstrap make exactly the
//     database calls they made before it existed, and answer the same, with no Kubernetes client,
//     no managed timer and no managed read or write;
//   - on, it never throws and writes nothing it was not asked to.
// The enabled flow over a real PostgreSQL is managed-runner-sign-in.pg.spec.ts.

const OWNER = '0199a1b2-0000-7000-8000-0000000000c5';
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };

/** AuthService over an in-memory account store, recording each database call and the sign-in step in order. */
function authWorld(options: { hook?: boolean } = {}) {
  const calls: string[] = [];
  const users = new Map<string, { id: string; email: string; name: string; passwordHash: string | null; role?: string }>();
  const tokens = new Map<string, { id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }>();
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        calls.push('user.findUnique');
        return [...users.values()].find((u) => u.id === where.id || u.email === where.email) ?? null;
      },
      count: async () => {
        calls.push('user.count');
        return users.size;
      },
      create: async ({ data }: { data: { email: string; name: string; passwordHash: string; role: string } }) => {
        calls.push('user.create');
        const user = { id: OWNER, ...data };
        users.set(user.id, user);
        return user;
      },
      update: async ({ where, data }: { where: { id: string }; data: { passwordHash: string } }) => {
        calls.push('user.update');
        Object.assign(users.get(where.id)!, data);
      },
    },
    refreshToken: {
      create: async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        calls.push('refreshToken.create');
        tokens.set(data.tokenHash, { id: `rt-${tokens.size}`, revokedAt: null, ...data });
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        calls.push('refreshToken.findUnique');
        return tokens.get(where.tokenHash) ?? null;
      },
      updateMany: async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
        calls.push('refreshToken.updateMany');
        const row = [...tokens.values()].find((t) => (t.id === where.id || t.tokenHash === where.tokenHash) && !t.revokedAt);
        if (row) row.revokedAt = new Date();
        return { count: row ? 1 : 0 };
      },
    },
  };
  const signedIn: string[] = [];
  const hook = {
    signedIn: async (user: { id: string }) => {
      calls.push('managedRunners.signedIn');
      signedIn.push(user.id);
    },
  };
  const pats = { revokeAll: async () => (calls.push('pats.revokeAll'), 0) };
  const auth = new AuthService(prisma as never, new JwtService({ secret: 'sign-in-spec' }), pats as never, options.hook === false ? undefined : hook);
  const addUser = (email: string, password: string) => {
    const user = { id: `${OWNER.slice(0, -2)}${String(users.size).padStart(2, '0')}`, email, name: email.split('@')[0], passwordHash: hashPassword(password) };
    users.set(user.id, user);
    return user;
  };
  return { auth, calls, signedIn, addUser, tokens };
}

test('password login, first-user bootstrap and a Google ticket each take the sign-in step once, after the tokens', async () => {
  const w = authWorld();
  const first = await w.auth.bootstrap('first@example.invalid', 'First', 'correct horse battery staple');
  assert.ok(first.accessToken && first.refreshToken);
  assert.deepEqual(w.calls, ['user.count', 'user.create', 'refreshToken.create', 'managedRunners.signedIn']);

  w.calls.length = 0;
  const member = w.addUser('member@example.invalid', 'another long password');
  const login = await w.auth.login('member@example.invalid', 'another long password');
  assert.deepEqual(Object.keys(login).sort(), ['accessToken', 'refreshToken', 'user']);
  assert.deepEqual(login.user, { id: member.id, email: member.email, name: member.name });
  assert.deepEqual(w.calls, ['user.findUnique', 'refreshToken.create', 'managedRunners.signedIn']);

  // GoogleLoginService.exchange ends in completeLogin, with the account §5.2 found or opened.
  w.calls.length = 0;
  await w.auth.completeLogin({ id: member.id, email: member.email, name: member.name });
  assert.deepEqual(w.calls, ['refreshToken.create', 'managedRunners.signedIn']);
  assert.deepEqual(w.signedIn, [OWNER, member.id, member.id]);

  // A refused login is not a sign-in.
  w.calls.length = 0;
  await assert.rejects(w.auth.login('member@example.invalid', 'wrong'), (e: { status?: number }) => e.status === 401);
  assert.deepEqual(w.calls, ['user.findUnique']);
});

test('refresh, logout and a password change never take the sign-in step', async () => {
  const w = authWorld();
  const member = w.addUser('member@example.invalid', 'another long password');
  const { refreshToken } = await w.auth.login(member.email, 'another long password');
  w.signedIn.length = 0;
  w.calls.length = 0;

  const rotated = await w.auth.refresh(refreshToken);
  assert.ok(rotated.accessToken);
  await w.auth.logout(rotated.refreshToken);
  await w.auth.changePassword(member.id, 'another long password', 'a different long password', true);
  assert.deepEqual(w.signedIn, [], 'no sign-in step');
  assert.ok(!w.calls.includes('managedRunners.signedIn'), w.calls.join(', '));
  assert.ok(w.tokens.get(sha256(refreshToken))?.revokedAt, 'the refresh did consume the presented token');
});

test('the capability read never takes the sign-in step', () => {
  const w = authWorld();
  const controller = new AuthController(w.auth, {} as SignInProvidersService, { enabled: true, problem: null });
  assert.deepEqual(controller.capabilities(), { managedRunners: { enabled: true, contractVersion: 1 } });
  assert.deepEqual(w.calls, []);
});

test('a module graph without managed runners signs in exactly as before', async () => {
  const w = authWorld({ hook: false });
  const member = w.addUser('member@example.invalid', 'another long password');
  await w.auth.login(member.email, 'another long password');
  assert.deepEqual(w.calls, ['user.findUnique', 'refreshToken.create']);
});

/** Every .ts under src that is not a spec, a declaration or test support: what the server runs. */
function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')));

test('the sign-in step has one caller in the server: AuthService.completeLogin', () => {
  // build/managed-runners → the package's own src.
  const src = path.resolve(__dirname, '../../src');
  const callers: string[] = [];
  const injectors: string[] = [];
  for (const file of productionSources(src)) {
    const rel = path.relative(src, file).split(path.sep).join('/');
    withoutComments(readFileSync(file, 'utf8')).forEach((line, index) => {
      if (/\.signedIn\s*\(/.test(line)) callers.push(`${rel}:${index + 1}`);
      if (/MANAGED_RUNNER_SIGN_IN\b/.test(line) && !rel.startsWith('managed-runners/')) injectors.push(rel);
    });
  }
  assert.equal(callers.length, 1, `exactly one call of the sign-in step: ${callers.join(', ')}`);
  assert.match(callers[0], /^auth\/auth\.service\.ts:\d+$/);
  assert.deepEqual([...new Set(injectors)], ['auth/auth.service.ts'], 'and only AuthService injects it');

  const service = readFileSync(path.join(src, 'auth/auth.service.ts'), 'utf8');
  const completeLogin = /async completeLogin\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(service)?.[1] ?? '';
  const line = Number(callers[0].split(':')[1]);
  const start = service.slice(0, service.indexOf('async completeLogin(')).split('\n').length;
  const end = start + completeLogin.split('\n').length;
  assert.ok(line > start && line <= end, `the call is inside completeLogin (lines ${start}–${end}), at ${line}`);
  assert.ok(completeLogin.indexOf('tokenFor(') < completeLogin.indexOf('signedIn('), 'after the tokens are issued');
  const method = (source: string, name: string) => new RegExp(`async ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`).exec(source)?.[1] ?? '';
  for (const name of ['refresh', 'logout', 'changePassword', 'tokenFor', 'issueRefreshToken']) {
    const body = method(service, name);
    assert.ok(body.length > 0, `${name} was found`);
    assert.doesNotMatch(body, /signedIn|completeLogin/, `${name} does not reach the sign-in step`);
  }
  // And every way of signing in leaves by it: the password, the first-user bootstrap, a Google ticket.
  assert.match(method(service, 'login'), /return this\.completeLogin\(user\)/);
  assert.match(method(service, 'bootstrap'), /return this\.completeLogin\(user\)/);
  const google = readFileSync(path.join(src, 'auth/google-login.service.ts'), 'utf8');
  assert.match(method(google, 'exchange'), /return this\.auth\.completeLogin\(user\)/);
});

const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/**
 * A PrismaService double for login and bootstrap: the account store the auth flows read and write,
 * every call recorded; any other write — a managed mapping, runner or workspace — refused.
 */
function authPrisma(calls: string[], password: string) {
  const existing = { id: OWNER, email: 'existing@example.invalid', name: 'existing', passwordHash: hashPassword(password), role: 'MEMBER' };
  let userCount = 0;
  const handlers: Record<string, (args: any) => unknown> = {
    'user.findUnique': ({ where }) => (where.email === existing.email || where.id === existing.id ? existing : null),
    'user.count': () => userCount,
    'user.create': ({ data }) => ((userCount += 1), { id: '0199a1b2-0000-7000-8000-0000000000c6', ...data }),
    'refreshToken.create': ({ data }) => ({ id: 'rt', revokedAt: null, ...data }),
  };
  const model = (name: string) =>
    new Proxy({}, {
      get: (_target, method: string) => async (args: unknown) => {
        const key = `${name}.${method}`;
        calls.push(key);
        if (handlers[key]) return handlers[key](args);
        if (WRITE_METHODS.has(method)) throw new Error(`tripwire: ${key} wrote`);
        return method === 'findMany' ? [] : method === 'count' ? 0 : null;
      },
    });
  return new Proxy({}, {
    get: (_target, property: string) => {
      if (property === 'then') return undefined;
      if (property.startsWith('$')) {
        return async () => {
          calls.push(property);
          throw new Error(`tripwire: ${property}`);
        };
      }
      return model(property);
    },
  });
}

function post(base: string, route: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(`${base}${route}`, {
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Timers created from managed runner code (spec files excluded). */
function spyOnTimers(created: string[]): () => void {
  const original = { setTimeout: global.setTimeout, setInterval: global.setInterval };
  const fromManagedRunners = () =>
    (new Error().stack ?? '').split('\n').slice(2).find((line) => /managed-runners[\\/][^\\/]+\.js/.test(line) && !/\.spec\.js/.test(line));
  global.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const frame = fromManagedRunners();
    if (frame) created.push(`setTimeout ${frame.trim()}`);
    return original.setTimeout(...args);
  }) as typeof setTimeout;
  global.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const frame = fromManagedRunners();
    if (frame) created.push(`setInterval ${frame.trim()}`);
    return original.setInterval(...args);
  }) as typeof setInterval;
  return () => Object.assign(global, original);
}

for (const said of [undefined, 'false']) {
  test(`off with ${MANAGED_RUNNERS_ENABLED_ENV}=${JSON.stringify(said)}: login and bootstrap make the calls they made before, and nothing managed`, async () => {
    const saved = { ...process.env };
    if (said === undefined) delete process.env[MANAGED_RUNNERS_ENABLED_ENV];
    else process.env[MANAGED_RUNNERS_ENABLED_ENV] = said;
    // A profile path that would be read if anything looked for one: nothing may.
    process.env[MANAGED_RUNNERS_PROFILE_ENV] = '/nonexistent/managed-runner-sign-in-spec/profile.json';
    const PASSWORD = 'correct horse battery staple';
    const calls: string[] = [];
    const kube: string[] = [];
    const timers: string[] = [];
    const restoreTimers = spyOnTimers(timers);

    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: authPrisma(calls, PASSWORD) },
        { provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: tripwireKubeClientFactory(kube) },
        { provide: JwtService, useValue: new JwtService({ secret: 'sign-in-spec' }) },
        { provide: PatService, useValue: {} },
      ],
      exports: [PrismaService, MANAGED_RUNNER_KUBE_CLIENT_FACTORY, JwtService, PatService],
    })
    class Doubles {}

    // The real AuthService and AuthController, with the real switch and the real managed module.
    @Module({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), Doubles, ManagedRunnerGateModule, ManagedRunnerModule],
      controllers: [AuthController],
      providers: [AuthService, { provide: SignInProvidersService, useValue: {} }],
    })
    class Harness {}

    let app: INestApplication | undefined;
    try {
      app = await NestFactory.create(Harness, { logger: false, abortOnError: false });
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      assert.equal(app.get(MANAGED_RUNNER_RUNTIME), null, 'no runtime: no profile read, no manager, no loop');
      assert.ok(app.get(MANAGED_RUNNER_SIGN_IN) instanceof ManagedRunnerService, 'the sign-in step is wired, and off');

      // A new account: the deployment's first user.
      const boot = await post(base, '/api/auth/bootstrap', { email: 'first@example.invalid', name: 'First', password: PASSWORD });
      assert.equal(boot.status, 201, JSON.stringify(boot.json));
      assert.deepEqual(Object.keys(boot.json).sort(), ['accessToken', 'refreshToken', 'user']);
      assert.deepEqual(boot.json.user, { id: '0199a1b2-0000-7000-8000-0000000000c6', email: 'first@example.invalid', name: 'First' });
      assert.deepEqual(calls, ['user.count', 'user.create', 'refreshToken.create'], 'bootstrap: exactly the calls it made before');

      // An existing account.
      calls.length = 0;
      const login = await post(base, '/api/auth/login', { email: 'existing@example.invalid', password: PASSWORD });
      assert.equal(login.status, 201, JSON.stringify(login.json));
      assert.deepEqual(Object.keys(login.json).sort(), ['accessToken', 'refreshToken', 'user']);
      assert.deepEqual(login.json.user, { id: OWNER, email: 'existing@example.invalid', name: 'existing' });
      assert.deepEqual(calls, ['user.findUnique', 'refreshToken.create'], 'login: exactly the calls it made before');
    } finally {
      await app?.close();
      restoreTimers();
      process.env = saved;
    }
    assert.deepEqual(kube, [], 'neither the Kubernetes client constructor nor any client method was reached');
    assert.deepEqual(timers, [], 'no timer was started by managed runner code');
    assert.ok(!calls.some((c) => /^(managedRunner|runner|workspace)\./.test(c)), calls.join(', '));
  });
}

/** A PrismaService double that records every call and answers per `answer`. */
function recordingPrisma(calls: string[], answer: (call: string) => unknown = () => null) {
  return new Proxy({}, {
    get: (_target, model: string) =>
      model === 'then' ? undefined : new Proxy({}, {
        get: (_inner, method: string) => async () => {
          calls.push(`${model}.${method}`);
          return answer(`${model}.${method}`);
        },
      }),
  });
}

function enabledRuntime(kicks: { n: number }): ManagedRunnerRuntime {
  return {
    available: true,
    profile: testManagedRunnerProfile(),
    manager: {} as never,
    worker: { kick: () => void (kicks.n += 1) } as never,
  };
}

test('signedIn: off, and on without a usable environment, it reads nothing and writes nothing', async () => {
  const calls: string[] = [];
  const kicks = { n: 0 };
  const off = new ManagedRunnerService(recordingPrisma(calls) as never, { enabled: false, problem: null }, enabledRuntime(kicks));
  await off.signedIn({ id: OWNER });
  const unavailable = new ManagedRunnerService(recordingPrisma(calls) as never, { enabled: true, problem: null }, { available: false, problems: ['no profile'] });
  await unavailable.signedIn({ id: OWNER });
  assert.deepEqual(calls, []);
  assert.equal(kicks.n, 0);
});

test('signedIn: on, it never throws; an owner with a mapping, or one the server does not give one, gets nothing written', async () => {
  const ON = { enabled: true, problem: null } as const;
  const kicks = { n: 0 };

  // The database refuses: the sign-in still completes, and the failure is logged.
  const failing = new ManagedRunnerService(
    new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('connection reset'); } }) }) as never,
    ON,
    enabledRuntime(kicks),
  );
  (failing as unknown as { log: typeof quiet }).log = quiet;
  await assert.doesNotReject(failing.signedIn({ id: OWNER }));

  // A mapping exists, whatever its state: left alone, and the manager is not woken for it.
  const calls: string[] = [];
  const mapped = new ManagedRunnerService(recordingPrisma(calls, () => ({ id: 'mapping' })) as never, ON, enabledRuntime(kicks));
  await mapped.signedIn({ id: OWNER });
  assert.deepEqual(calls, ['managedRunner.findUnique']);

  // Not eligible: asked once, and nothing is written.
  calls.length = 0;
  const asked: string[] = [];
  const refused = new ManagedRunnerService(recordingPrisma(calls) as never, ON, enabledRuntime(kicks), {
    eligible: async (ownerId) => (asked.push(ownerId), false),
  });
  await refused.signedIn({ id: OWNER });
  assert.deepEqual(asked, [OWNER]);
  assert.deepEqual(calls, ['managedRunner.findUnique', 'user.findUnique'], 'the mapping, then whether the account is disabled: reads only');
  assert.equal(kicks.n, 0);

  // A disabled account: not eligible whatever the rule says, and the rule is not asked.
  calls.length = 0;
  asked.length = 0;
  const disabled = new ManagedRunnerService(
    recordingPrisma(calls, (call) => (call === 'user.findUnique' ? { disabledAt: new Date() } : null)) as never,
    ON,
    enabledRuntime(kicks),
    { eligible: async (ownerId) => (asked.push(ownerId), true) },
  );
  await disabled.signedIn({ id: OWNER });
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['managedRunner.findUnique', 'user.findUnique']);
  assert.equal(kicks.n, 0);
});
