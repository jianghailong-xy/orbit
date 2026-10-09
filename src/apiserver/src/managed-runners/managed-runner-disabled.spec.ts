import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { Global, Module, ValidationPipe, type INestApplication, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { SignInProvidersService } from '../auth/sign-in-providers.service';
import { PrismaService } from '../prisma/prisma.service';
import { tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { MANAGED_RUNNERS_ENABLED_ENV, ManagedRunnerGateModule } from './managed-runner-gate';
import { MANAGED_RUNNERS_PROFILE_ENV } from './managed-runner-profile';
import { MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_RUNTIME } from './managed-runner-runtime';
import { ManagedRunnerModule } from './managed-runner.module';

// "Default disabled" (docs/managed-runner-design.md, "Verification and implementation handoff"),
// run once per way of being off: the variable absent, `false`, ` FALSE `, and an unreadable `on`.
// The real gate, module, guards and controllers, with:
//   - a Kubernetes client constructor, and every method of the client it would return, that fail
//     the test if they are ever reached;
//   - a database double that records every call and throws on any write;
//   - a timer spy that records every timer created from managed runner code.
// The production server itself, over a real PostgreSQL and with no Kubernetes or Ceph credentials,
// is `managed-runner-boot.pg.spec.ts`.

const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/** A PrismaService double: reads answer empty, writes are recorded and refused. */
function recordingPrisma(calls: string[]) {
  const model = (name: string) =>
    new Proxy({}, {
      get: (_target, method: string) => async () => {
        calls.push(`${name}.${method}`);
        if (WRITE_METHODS.has(method)) throw new Error(`tripwire: ${name}.${method} wrote`);
        if (method === 'findMany') return [];
        if (method === 'count') return 0;
        return null;
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

interface Reply {
  status: number;
  json: any;
}

function send(base: string, method: string, path: string, bearer?: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const WRITES = ['ensure', 'retry', 'wake', 'sleep', 'delete'];
const OWNER = '0199a1b2-0000-7000-8000-00000000000a';

for (const said of [undefined, 'false', ' FALSE ', 'on']) {
  test(`off with ${MANAGED_RUNNERS_ENABLED_ENV}=${JSON.stringify(said)}: no client, no timer, no write; writes are 401 then 404 MANAGED_RUNNER_DISABLED`, async () => {
    const saved = { ...process.env };
    if (said === undefined) delete process.env[MANAGED_RUNNERS_ENABLED_ENV];
    else process.env[MANAGED_RUNNERS_ENABLED_ENV] = said;
    // A profile path that would be read if anything looked for one: nothing may.
    process.env[MANAGED_RUNNERS_PROFILE_ENV] = '/nonexistent/managed-runner-disabled-spec/profile.json';

    const kubeConstructed: string[] = [];
    // Every database call of the run, and a cursor for the calls of the request being checked.
    const dbCalls: string[] = [];
    let seen = 0;
    const callsSince = () => dbCalls.slice(seen);
    const timers: string[] = [];
    const warnings: string[] = [];
    const restoreTimers = spyOnTimers(timers);

    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: recordingPrisma(dbCalls) },
        { provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: tripwireKubeClientFactory(kubeConstructed) },
        // Every bearer is the one owner.
        { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER, email: 'owner@example.invalid' }) } },
      ],
      exports: [PrismaService, MANAGED_RUNNER_KUBE_CLIENT_FACTORY, JwtService],
    })
    class Doubles {}

    @Module({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), Doubles, ManagedRunnerGateModule, ManagedRunnerModule],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: SignInProvidersService, useValue: {} },
      ],
    })
    class Harness {}

    const logger: LoggerService = { log: () => undefined, error: () => undefined, warn: (m: unknown) => void warnings.push(String(m)) };
    let app: INestApplication | undefined;
    try {
      app = await NestFactory.create(Harness, { logger, abortOnError: false });
      app.setGlobalPrefix('api');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

      assert.equal(app.get(MANAGED_RUNNER_RUNTIME), null, 'no runtime: no profile read, no manager, no loop');
      assert.equal(
        warnings.filter((w) => w.includes(MANAGED_RUNNERS_ENABLED_ENV)).length,
        said === 'on' ? 1 : 0,
        'an unreadable value is warned about exactly once',
      );

      // The capability read: off, and nothing touched to say so.
      assert.equal((await send(base, 'GET', '/api/auth/capabilities')).status, 401);
      const capabilities = await send(base, 'GET', '/api/auth/capabilities', 'login');
      assert.equal(capabilities.status, 200);
      assert.deepEqual(capabilities.json, { managedRunners: { enabled: false, contractVersion: 1 } });
      assert.deepEqual(callsSince(), [], 'the capability read reads nothing');

      // The status read: enabled false, a read and nothing else.
      const status = await send(base, 'GET', '/api/managed-runner', 'login');
      assert.equal(status.status, 200);
      assert.equal(status.json.enabled, false);
      assert.equal(status.json.managementState, 'NOT_PROVISIONED');
      assert.equal(status.json.reason.code, 'MANAGED_RUNNER_DISABLED');
      assert.deepEqual(status.json.actions, { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false });
      assert.deepEqual(callsSince(), ['managedRunner.findUnique'], 'one read of the caller’s own mapping');
      seen = dbCalls.length;

      for (const action of WRITES) {
        const anonymous = await send(base, 'POST', `/api/managed-runner/${action}`, undefined, { idempotencyKey: 'k', revision: 1 });
        assert.equal(anonymous.status, 401, `${action}: authentication comes first`);
        const refused = await send(base, 'POST', `/api/managed-runner/${action}`, 'login', { idempotencyKey: 'k', revision: 1 });
        assert.equal(refused.status, 404, `${action}: refused as a server without the feature`);
        assert.equal(refused.json.code, 'MANAGED_RUNNER_DISABLED');
        // Refused before the body is validated: an unusable body gets the same answer.
        const malformed = await send(base, 'POST', `/api/managed-runner/${action}`, 'login', {});
        assert.equal(malformed.status, 404, `${action}: the switch is checked before the body is read`);
      }
      assert.deepEqual(callsSince(), [], 'no managed write — and no read either — before the refusal');
    } finally {
      await app?.close();
      restoreTimers();
      process.env = saved;
    }
    assert.deepEqual(kubeConstructed, [], 'neither the Kubernetes client constructor nor any client method was reached');
    assert.deepEqual(timers, [], 'no timer or watch was started by managed runner code');
    assert.deepEqual(dbCalls, ['managedRunner.findUnique'], 'over the whole run: one read, and nothing written');
  });
}
