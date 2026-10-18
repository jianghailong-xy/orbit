/**
 * A new account's first session while its managed runner waits for capacity (docs/managed-runner-design.md,
 * "Implementation record: capacity, wake and sleep"), the same on both run backends: the whole AppModule in
 * this process with ORBIT_MANAGED_RUNNERS_ENABLED=true, once on Kubernetes — the in-memory namespace of
 * test-support/fake-kube-client.ts with the single-Pod admission guard installed — and once on Docker — the
 * restricted channel of test-support/fake-docker-channel.ts — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, in a scrubbed environment. The test plays the runner over the
 * real routes (heartbeat, claim) with the credential and instance identity the manager handed its instance,
 * and the host by reporting a stopped instance. The application's own reconcile loop does everything else.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-first-session.pg.spec.ts
 *
 * On each backend, a pool with room for one runner, which another account's READY runner holds. A new
 * account signs up, and its runner waits for capacity, never having reported its engines. Without a model key
 * of its own there is nothing a first session could start on: the owner's status names none
 * (`firstSessionProvider` null), so no client offers one, and the create refuses it MODEL_UNAVAILABLE. It adds
 * a key. Then:
 *   - the status names that key as what a first session starts on, before READY, so the clients offer the
 *     first session (task T07);
 *   - its default workspace starts on that key (the derived default before the runner was ever ready);
 *   - a first session on Claude Code's own sign-in is still refused MODEL_UNAVAILABLE: nobody could have
 *     signed it in on a runner that has never come up;
 *   - its first session with nothing named, and then one naming the key, are queued — 201 PENDING, on the
 *     key — where T06 saw 409 MODEL_UNAVAILABLE; the owner's status says what they wait for;
 *   - the other runner goes to sleep, and the new one is admitted, provisioned and started, reports Claude
 *     Code installed and signed out, is READY on the key, and claims the two sessions that waited, in order;
 *     the status still names the key, now as what READY recorded.
 *
 * Destructive only to its own disposable database.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  MANAGED_RUNNER_CAPACITY_UNAVAILABLE,
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  MANAGED_RUNNER_SLEEP_CAPABILITY,
  MODEL_UNAVAILABLE,
  managedRunnerDisplay,
  toUuid,
} from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { call, type Apiserver } from '../auth/pat-test-apiserver';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { outsideThePoolGateway } from '../providers/pool-gateway.controller';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { FakeKubeCluster } from '../test-support/fake-kube-client';
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { Pod, Secret } from './kube-client';
import { GENERATION_ANNOTATION, bootstrapCredentialOf, managedPodName, managedSecretName } from './managed-runner-resources';
import {
  MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY,
  MANAGED_RUNNER_KUBE_CLIENT_FACTORY,
  MANAGED_RUNNER_RUNTIME,
  type ManagedRunnerRuntime,
} from './managed-runner-runtime';

declare global {
  interface BigInt { toJSON(): string; }
}
// main.ts installs this before it creates the app; session rows carry BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 1 };
// Polls every second; never sleeps a runner on its own (the case asks); the pool has room for one runner.
const LIFECYCLE = { pollIntervalSeconds: 1, backoffBaseSeconds: 1, backoffMaxSeconds: 2, idleSeconds: 604_800, capacityRetrySeconds: 5 };

/** One backend as the runner and its host see it. */
interface Host {
  /** The instance of the runner's current generation, once the manager has made it. */
  instance(runnerId: string): { generation: string; uid: string } | null;
  /** The runner credential the manager handed that generation. */
  credential(runnerId: string): string;
  /** The runner exited after its sleep was confirmed, and the host reports it stopped. */
  stopped(runnerId: string): void;
}

test('a new account queues its first session while its managed runner waits for capacity, on both backends', {
  skip: !PG_URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-first-session-'));
  const savedEnv = process.env;
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    process.env = savedEnv;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  // Neither real client may be built, nor the real Kubernetes transport used: only the fakes exist here.
  const realClient: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kubeHttp = require('./kube-http-client') as { kubeClientFromProfile: unknown; httpsTransport: { request: unknown; stream: unknown } };
  kubeHttp.kubeClientFromProfile = () => {
    realClient.push('kubeClientFromProfile');
    throw new Error('tripwire: the real Kubernetes client was constructed');
  };
  kubeHttp.httpsTransport.request = () => {
    realClient.push('request');
    throw new Error('tripwire: a real Kubernetes request');
  };
  kubeHttp.httpsTransport.stream = () => {
    realClient.push('watch');
    throw new Error('tripwire: a real Kubernetes watch');
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerChannel = require('./docker-channel-client') as { dockerChannelFromProfile: unknown };
  dockerChannel.dockerChannelFromProfile = () => {
    realClient.push('dockerChannelFromProfile');
    throw new Error('tripwire: the real Docker channel client was constructed');
  };

  /** The whole application, as main.ts builds it, on `profile`, with the fake backends in place of the real ones. */
  async function boot(label: string, profile: object, fakes: { kube?: () => unknown; docker?: () => unknown }): Promise<Apiserver & { jwt: JwtService }> {
    const dir = path.join(scratch, label);
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const profilePath = path.join(dir, 'profile.json');
    writeFileSync(profilePath, JSON.stringify(profile));
    const JWT_SECRET = randomBytes(32).toString('hex');
    process.env = {
      PATH: savedEnv.PATH,
      NO_COLOR: '1',
      TMPDIR: dir,
      HOME: home,
      ORBIT_HOME: path.join(home, '.orbit'),
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      DATABASE_URL: url,
      JWT_SECRET,
      // The owner's model key is stored encrypted, as it is in production.
      PROVIDER_SECRET_KEY: randomBytes(32).toString('hex'),
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
      ORBIT_MANAGED_RUNNERS_PROFILE: profilePath,
    };
    const { AppModule } = await import('../app.module.js');
    const unused = (what: string) => () => {
      realClient.push(what);
      throw new Error(`tripwire: the ${what} of the other backend was asked for`);
    };
    @Global()
    @Module({
      providers: [
        { provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: fakes.kube ?? unused('Kubernetes client') },
        { provide: MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY, useValue: fakes.docker ?? unused('Docker channel') },
      ],
      exports: [MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_DOCKER_CHANNEL_FACTORY],
    })
    class FakeEnvironment {}
    @Module({ imports: [FakeEnvironment, AppModule] })
    class Harness {}
    // main.ts, step for step.
    app = await NestFactory.create(Harness, { bodyParser: false, logger: ['error'], abortOnError: false });
    app.use(outsideThePoolGateway(json({ limit: '10mb' })));
    app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
    app.use(publicIdHeaders);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
    const adapter = app.get(HttpAdapterHost).httpAdapter;
    app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
    await app.listen(0, '127.0.0.1');
    const runtime = app.get<ManagedRunnerRuntime | null>(MANAGED_RUNNER_RUNTIME);
    assert.equal(runtime?.available, true, `${label}: the managed runtime is up`);
    const port = Number(new globalThis.URL((await app.getUrl()).replace('[::1]', '127.0.0.1')).port);
    return { port, jwt: new JwtService({ secret: JWT_SECRET }) } as Apiserver & { jwt: JwtService };
  }

  async function shutdown(): Promise<void> {
    await app?.close();
    app = undefined;
    process.env = savedEnv;
  }

  async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }
  const mappingOf = async (ownerId: string): Promise<ManagedRunner | null> => db.managedRunner.findUnique({ where: { ownerId } });

  /** The case, on one backend's application and host. */
  async function firstSessionWaits(server: Apiserver & { jwt: JwtService }, host: Host, backend: string): Promise<void> {
    const bearer = (userId: string) => server.jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });
    const headers = (runnerId: string): Record<string, string> => {
      const instance = host.instance(runnerId)!;
      return {
        'x-orbit-runner-capabilities': `${MANAGED_RUNNER_INSTANCE_CAPABILITY},${MANAGED_RUNNER_SLEEP_CAPABILITY},session-terminal-handoff-v1`,
        [MANAGED_RUNNER_GENERATION_HEADER]: instance.generation,
        [MANAGED_RUNNER_POD_UID_HEADER]: instance.uid,
      };
    };
    const heartbeat = async (runnerId: string, engines: unknown[], workload: Record<string, unknown> = IDLE) => {
      const beat = await call(server, 'POST', '/api/runner/heartbeat', host.credential(runnerId),
        { engines, version: '0.1.0', managedWorkload: workload }, headers(runnerId));
      assert.ok(beat.status === 200 || beat.status === 201, `heartbeat: ${beat.text}`);
      return beat.json as { managedSleep?: { requestedAt: string; confirmed?: boolean } };
    };
    const claim = async (runnerId: string) => {
      const claimed = await call(server, 'GET', '/api/runner/sessions/claim', host.credential(runnerId), undefined, headers(runnerId));
      assert.equal(claimed.status, 200, claimed.text);
      return claimed.json as { sessionId: string; provider: string; agent: { env: Record<string, string> } };
    };
    /** Its instance of generation 1 started, heartbeating with `engines`, until READY. */
    const upAndReady = async (ownerId: string, engines: unknown[]): Promise<ManagedRunner> => {
      const starting = await until(`${backend}: the instance of ${ownerId}`, async () => {
        const m = await mappingOf(ownerId);
        return m?.podUid && m.managementState === 'STARTING' && host.instance(m.runnerId)?.uid === m.podUid ? m : null;
      });
      await heartbeat(starting.runnerId, engines);
      return until(`${backend}: READY`, async () => {
        const m = await mappingOf(ownerId);
        return m?.managementState === 'READY' ? m : null;
      });
    };
    const account = async (label: string) => {
      const user = await db.user.create({ data: { email: `${label}-${randomUUID().slice(0, 8)}@example.invalid`, name: label } });
      return { id: user.id, token: await bearer(user.id) };
    };
    const ensure = async (o: { id: string; token: string }) => {
      const ensured = await call(server, 'POST', '/api/managed-runner/ensure', o.token, { idempotencyKey: `ensure-${o.id}` });
      assert.equal(ensured.status, 202, ensured.text);
    };

    // The pool's one runner: another account's, READY on Claude Code's own sign-in.
    const holder = await account(`holder-${backend}`);
    await ensure(holder);
    const held = await upAndReady(holder.id, [{ engine: 'claude', installed: true, auth: 'yes' }]);

    // The new account signs up, with no model key of its own yet: its runner waits for capacity, nothing reported.
    const fresh = await account(`fresh-${backend}`);
    await ensure(fresh);
    const waiting = await until(`${backend}: WAITING_CAPACITY`, async () => {
      const m = await mappingOf(fresh.id);
      return m?.managementState === 'WAITING_CAPACITY' ? m : null;
    });
    assert.equal((waiting.lastError as { code: string }).code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: waiting.runnerId } })).engines, null, 'it has never reported its engines');

    // The default workspace, as it is listed before anything ran in it (its default is checked below).
    type Listed = { id: string; lastProvider: string; lastEngine: string; providerBuiltin: boolean };
    const listed = async () => ((await call(server, 'GET', '/api/workspaces', fresh.token)).json as Listed[])
      .find((w) => toUuid(w.id) === waiting.defaultWorkspaceId)!;
    const keyless = await listed();

    // With no key there is nothing a first session could start on: the status names none, no client
    // offers one, and the create refuses the session a client would send with nothing named.
    const unnamed = (await call(server, 'GET', '/api/managed-runner', fresh.token)).json;
    assert.deepEqual([unnamed.managementState, unnamed.initialProvider, unnamed.firstSessionProvider], ['WAITING_CAPACITY', null, null]);
    assert.deepEqual([managedRunnerDisplay(unnamed)!.acceptsWork, managedRunnerDisplay(unnamed)!.startsNewSession], [true, false]);
    assert.deepEqual([keyless.lastProvider, keyless.providerBuiltin], ['claude', true], 'the floor, which this runner cannot run');
    const keylessFirst = await call(server, 'POST', '/api/sessions', fresh.token, { workspaceId: keyless.id, prompt: 'hello', title: 'no key yet' });
    assert.equal(keylessFirst.status, 409, keylessFirst.text);
    assert.equal(keylessFirst.json.code, MODEL_UNAVAILABLE);

    // It adds a model key of its own.
    const key = await call(server, 'POST', '/api/providers/mine', fresh.token,
      { label: 'own key', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: `sk-pg-first-session-${backend}-not-a-key` });
    assert.equal(key.status, 201, key.text);
    const slug = key.json.slug as string;
    // Before READY, the status now names the key a first session waits for the runner on, so a client
    // offers that session.
    const named0 = (await call(server, 'GET', '/api/managed-runner', fresh.token)).json;
    assert.deepEqual([named0.managementState, named0.initialProvider, named0.firstSessionProvider], ['WAITING_CAPACITY', null, slug]);
    assert.deepEqual([managedRunnerDisplay(named0)!.kind, managedRunnerDisplay(named0)!.startsNewSession], ['waitingCapacity', true]);
    const workspace = await listed();

    // Claude Code's own sign-in: refused, as nothing could have signed it in yet.
    const signIn = await call(server, 'POST', '/api/sessions', fresh.token, { workspaceId: workspace.id, prompt: 'hello', title: 'on a sign-in', provider: 'claude' });
    assert.equal(signIn.status, 409, signIn.text);
    assert.equal(signIn.json.code, MODEL_UNAVAILABLE);

    // The first session, nothing named: queued on the key. Then one naming the key.
    const first = await call(server, 'POST', '/api/sessions', fresh.token, { workspaceId: workspace.id, prompt: 'the first message', title: 'first, nothing named' });
    assert.equal(first.status, 201, `T06 saw 409 MODEL_UNAVAILABLE here: ${first.text}`);
    assert.deepEqual([first.json.status, first.json.provider, first.json.engine], ['PENDING', slug, 'claude']);
    const named = await call(server, 'POST', '/api/sessions', fresh.token, { workspaceId: workspace.id, prompt: 'the second message', title: 'naming the key', provider: slug });
    assert.equal(named.status, 201, named.text);
    assert.deepEqual([named.json.status, named.json.provider, named.json.engine], ['PENDING', slug, 'claude']);
    // Before anything ran there, the workspace's default was already that key: what the first session took.
    assert.deepEqual([workspace.lastProvider, workspace.lastEngine, workspace.providerBuiltin], [slug, 'claude', false]);

    // What the owner reads meanwhile: waiting for capacity, work accepted, and why; the first session's key.
    const status = (await call(server, 'GET', '/api/managed-runner', fresh.token)).json;
    assert.equal(status.managementState, 'WAITING_CAPACITY');
    assert.equal(status.reason.code, MANAGED_RUNNER_CAPACITY_UNAVAILABLE);
    assert.match(status.reason.message, /^The managed environment has no room for this runner right now \(.+\)\. It starts by itself when room frees up/);
    assert.equal(status.firstSessionProvider, slug);
    const display = managedRunnerDisplay(status)!;
    assert.deepEqual([display.kind, display.acceptsWork, display.startsNewSession], ['waitingCapacity', true, true]);
    assert.equal(display.detail, status.reason.message);

    // The holder goes to sleep through the owner's request and the whole handshake.
    const asked = await call(server, 'POST', '/api/managed-runner/sleep', holder.token, { idempotencyKey: `sleep-${randomUUID()}`, revision: held.revision });
    assert.equal(asked.status, 202, asked.text);
    await until(`${backend}: the holder DRAINING`, async () => (await mappingOf(holder.id))?.managementState === 'DRAINING');
    const request = await heartbeat(held.runnerId, [{ engine: 'claude', installed: true, auth: 'yes' }]);
    assert.ok(request.managedSleep?.requestedAt, `the drained instance is asked: ${JSON.stringify(request)}`);
    const accepted = await heartbeat(held.runnerId, [{ engine: 'claude', installed: true, auth: 'yes' }], { ...IDLE, sleepReady: request.managedSleep!.requestedAt });
    assert.equal(accepted.managedSleep?.confirmed, true);
    host.stopped(held.runnerId);
    await until(`${backend}: the holder SLEEPING`, async () => (await mappingOf(holder.id))?.managementState === 'SLEEPING');

    // The new runner is admitted and started; it reports Claude Code installed, not signed in, and is READY on the key.
    const ready = await upAndReady(fresh.id, [{ engine: 'claude', installed: true, auth: 'no' }]);
    assert.equal(ready.initialProvider, slug);
    const readyStatus = (await call(server, 'GET', '/api/managed-runner', fresh.token)).json;
    assert.deepEqual([readyStatus.managementState, readyStatus.initialProvider, readyStatus.firstSessionProvider], ['READY', slug, slug]);
    // It claims the sessions that waited, in the order they were queued, each on the key.
    for (const queued of [first, named]) {
      const claimed = await claim(ready.runnerId);
      assert.equal(toUuid(claimed.sessionId), toUuid(queued.json.id), `${backend}: the queued session is claimed`);
      assert.equal(claimed.provider, 'claude');
      assert.equal(claimed.agent.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    }
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: toUuid(first.json.id) } })).status, 'RUNNING');
  }

  await t.test('Kubernetes: the first session is queued while the runner waits for capacity, and runs once it is READY', async () => {
    const profile = testManagedRunnerProfile({ clusterKey: `first-k8s-${randomUUID().slice(0, 8)}`, lifecycle: LIFECYCLE, capacity: { maxActiveUsers: 1 } });
    const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), prisma, profile);
    const server = await boot('kubernetes', profile, { kube: () => cluster.client() });
    try {
      await firstSessionWaits(server, {
        instance: (runnerId) => {
          const pod = cluster.object<Pod>('pods', managedPodName(runnerId));
          return pod ? { generation: pod.metadata.annotations![GENERATION_ANNOTATION], uid: pod.metadata.uid! } : null;
        },
        credential: (runnerId) => bootstrapCredentialOf(cluster.object<Secret>('secrets', managedSecretName(runnerId))!)!,
        stopped: (runnerId) => cluster.stopPod(managedPodName(runnerId)),
      }, 'kubernetes');
    } finally {
      await shutdown();
    }
  });

  await t.test('Docker: the first session is queued while the runner waits for capacity, and runs once it is READY', async () => {
    const profile = testDockerRunnerProfile({ clusterKey: `first-docker-${randomUUID().slice(0, 8)}`, lifecycle: LIFECYCLE, capacity: { maxActiveUsers: 1 } });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    const server = await boot('docker', profile, { docker: () => channel });
    try {
      await firstSessionWaits(server, {
        instance: (runnerId) => {
          const container = channel.containers.get(`mr-${runnerId}`);
          return container ? { generation: String(container.generation), uid: container.uid } : null;
        },
        credential: (runnerId) => channel.credentials.get(runnerId)!.token!,
        stopped: (runnerId) => channel.exit(runnerId, 0),
      }, 'docker');
    } finally {
      await shutdown();
    }
  });

  await t.test('neither real client was built', () => {
    assert.deepEqual(realClient, []);
  });
});
