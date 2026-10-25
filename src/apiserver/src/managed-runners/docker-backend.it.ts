/**
 * The Docker backend on real Docker (docs/managed-runner-design.md, "Implementation record: Docker
 * backend"). Not a unit or pg spec — no roster runs it: it needs a Docker daemon, the managed runner
 * image built from deploy/managed-runner/image, a disposable PostgreSQL and a dedicated internal
 * network, which scripts/managed-runner/docker-backend-it.py sets up before it runs this file
 * (ORBIT_D2_IT names its configuration) and removes after.
 *
 * The whole AppModule runs in this process with ORBIT_MANAGED_RUNNERS_ENABLED=true and a Docker
 * profile, listening on the network's gateway address, which is all its containers can reach. The
 * restricted channel (deploy/managed-runner/docker-channel/channel.py) runs as a child process this
 * test starts, kills and starts again; it alone holds the Docker socket. Every container runs the
 * real image, whose real runner heartbeats, claims, accepts sleep and exits. The test plays the owner
 * through the real routes, and an operator with the docker CLI where an operator would act: signing
 * Codex in with a placeholder key (the network has no route to any model), killing a container to
 * stand for a crash, writing data into a volume through `docker exec`.
 *
 *   (0) the channel refuses what it must, on real Docker, and nothing changes;
 *   (1) provisioning; an abnormal exit (SIGKILL), and the restart that follows it on the same volume;
 *   (2) an idle runner sleeps by itself: compute stays reserved until Docker reports the container
 *       exited AND it is removed; a wake brings back the same files and SQLite database;
 *   (3)–(5) wake by a new message, by a runnable task and by scheduled work;
 *   (6) concurrent wakes, with a second manager racing the first: one container;
 *   (7) a "host restart": runner killed mid-write, channel killed, manager stopped; all back: it
 *       recovers by itself;
 *   (8) the manager restarted mid-wake, (9) the channel down during a wake;
 *   (10) capacity: the third runner waits, and starts once a slot is given back; its owner's first session,
 *        on her own model key, is queued while it waits and claimed by her runner once it is up;
 *   (11) a volume over its disk limit: its container is stopped, and the restart is refused on it.
 * Throughout: never two containers on one volume (sampled), never a Docker socket in this process.
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { outsideThePoolGateway } from '../providers/pool-gateway.controller';
import { ScheduledWakeupWorker } from '../runner-api/scheduled-wakeup.worker';
import { DockerBackend } from './docker-backend';
import { DockerChannelClient } from './docker-channel-client';
import { ManagedRunnerManager } from './managed-runner-manager';
import type { DockerRunnerProfile } from './managed-runner-profile';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';

declare global {
  interface BigInt { toJSON(): string; }
}
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

interface ItConfig {
  runId: string;
  runDir: string;
  evidenceDir: string;
  python: string;
  channel: { script: string; config: string; socket: string; tokenFile: string };
  instanceId: string;
  image: string;
  network: string;
  gateway: string;
  testLabel: { key: string; value: string };
}

const CONFIG = process.env.ORBIT_D2_IT;
const PG_URL = process.env.COORDINATOR_PG_URL;
const run = promisify(execFile);
const PLACEHOLDER_KEY = 'sk-orbit-d2-placeholder-not-a-key';
const MiB = 2 ** 20;

test('the Docker backend on real Docker', { skip: !CONFIG || !PG_URL, concurrency: 1, timeout: 5_400_000 }, async (t) => {
  const cfg = JSON.parse(readFileSync(CONFIG!, 'utf8')) as ItConfig;
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  mkdirSync(cfg.evidenceDir, { recursive: true });
  const evidence = (file: string) => path.join(cfg.evidenceDir, file);
  const started = Date.now();
  const note = (step: string, observed: Record<string, unknown>) => {
    const line = { at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), step, ...observed };
    appendFileSync(evidence('steps.jsonl'), `${JSON.stringify(line)}\n`);
    console.log(`# ${step} ${JSON.stringify(observed)}`);
  };

  // ── no Docker socket in this process, ever ─────────────────────────────────────────────────
  const socketTouches: string[] = [];
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { path?: unknown } | string | undefined;
    const target = typeof first === 'string' ? first : typeof first === 'object' && first ? first.path : undefined;
    if (typeof target === 'string' && /docker\.sock/.test(target)) {
      socketTouches.push(target);
      throw new Error(`tripwire: the apiserver process opened ${target}`);
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  assert.equal(process.env.DOCKER_HOST, undefined, 'no DOCKER_HOST in the apiserver');

  // ── docker CLI: the operator's eye, never the apiserver's ──────────────────────────────────
  async function docker(...args: string[]): Promise<string> {
    const { stdout } = await run('docker', args, { maxBuffer: 32 * MiB });
    return stdout.trim();
  }
  async function dockerJson<T>(...args: string[]): Promise<T[]> {
    const out = await docker(...args);
    return out ? out.split('\n').map((line) => JSON.parse(line) as T) : [];
  }
  const instanceLabel = `orbit.managed-runner.instance=${cfg.instanceId}`;
  async function containersOf(runnerId: string) {
    return dockerJson<{ Names: string; ID: string; State: string; Status: string }>('ps', '-a', '--filter', `label=orbit.managed-runner.runner=${runnerId}`, '--format', '{{json .}}');
  }
  async function holdersOf(volume: string): Promise<number> {
    const out = await docker('ps', '-a', '-q', '--filter', `volume=${volume}`);
    return out ? out.split('\n').length : 0;
  }
  async function stateOf(name: string): Promise<{ Status: string; ExitCode: number; FinishedAt: string; OOMKilled: boolean } | null> {
    try {
      return JSON.parse(await docker('inspect', '-f', '{{json .State}}', name));
    } catch {
      return null;
    }
  }
  async function shell(name: string, script: string, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', '-u', '10001:10001', name, 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`docker exec ${name} exited ${code}: ${err.trim()}`))));
      child.stdin.end(input ?? '');
    });
  }

  // Docker's own record of every container and volume this instance made: the lifecycle evidence.
  const events = spawn('docker', ['events', '--filter', `label=${instanceLabel}`, '--filter', 'type=container', '--filter', 'type=volume', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const eventLog = createWriteStream(evidence('docker-events.jsonl'), { flags: 'a' });
  events.stdout.pipe(eventLog);

  // Never two containers on one volume: sampled for every runner this test knows, all along.
  const watched = new Map<string, string>();
  const maxAtOnce = new Map<string, number>();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const [runnerId, volume] of watched) {
        const [own, holders] = await Promise.all([containersOf(runnerId).then((c) => c.length).catch(() => 0), holdersOf(volume).catch(() => 0)]);
        const seen = Math.max(own, holders);
        if (seen > (maxAtOnce.get(runnerId) ?? 0)) maxAtOnce.set(runnerId, seen);
      }
      await sleep(250);
    }
  })();

  // ── the channel: started, killed and started again by this test ────────────────────────────
  const token = readFileSync(cfg.channel.tokenFile, 'utf8').trim();
  const channelClient = new DockerChannelClient({ socketPath: cfg.channel.socket }, token, 30_000);
  const channelLog = createWriteStream(evidence('channel.log'), { flags: 'a' });
  let channel: ChildProcess | undefined;
  async function startChannel(): Promise<void> {
    channel = spawn(cfg.python, ['-I', cfg.channel.script, 'serve', '--config', cfg.channel.config], { stdio: ['ignore', 'pipe', 'pipe'] });
    channel.stdout!.pipe(channelLog, { end: false });
    channel.stderr!.pipe(channelLog, { end: false });
    await until('the channel answering', async () => existsSync(cfg.channel.socket) && (await channelClient.call('GET', '/v1/resources').then((a) => a.status === 200, () => false)), 60_000);
  }
  async function killChannel(): Promise<void> {
    const child = channel!;
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    channel = undefined;
  }

  async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 120_000, every = 250): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
      await sleep(every);
    }
  }

  // ── the apiserver: this process, the switch on, the Docker profile ─────────────────────────
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, cfg.gateway, () => {
      const { port: free } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const profile: DockerRunnerProfile = {
    schemaVersion: 1,
    valueKind: 'actual',
    backend: 'docker',
    environmentId: 'orbit-d2-it',
    clusterKey: `d2it-${cfg.runId}`,
    resourceProfileId: 'd2-it-v1',
    docker: { instanceId: cfg.instanceId, channel: { socketPath: cfg.channel.socket }, tokenFile: cfg.channel.tokenFile },
    storage: { capacity: '256Mi' },
    runner: { image: cfg.image, serverUrl: `http://${cfg.gateway}:${port}`, maxConcurrent: 1, tmpSizeLimit: '64Mi', resources: { cpu: '500m', memory: '512Mi', pids: 512 } },
    // Room for exactly two runners: the third waits (case 10).
    capacity: { compute: { cpu: '1', memory: '1Gi' }, storage: { usable: '4Gi', headroom: '1Gi' } },
    lifecycle: {
      maxAttempts: 8, backoffBaseSeconds: 1, backoffMaxSeconds: 4, startupDeadlineSeconds: 900, requestTimeoutSeconds: 60,
      leaseSeconds: 30, pollIntervalSeconds: 1, heartbeatFreshSeconds: 90, idleSeconds: 60, capacityRetrySeconds: 5, drainSeconds: 120,
    },
  };
  const home = path.join(cfg.runDir, 'apiserver-home');
  mkdirSync(home, { recursive: true });
  const profilePath = path.join(cfg.runDir, 'manager-profile.json');
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const JWT_SECRET = randomBytes(32).toString('hex');
  const jwt = new JwtService({ secret: JWT_SECRET });
  const savedEnv = process.env;
  process.env = {
    PATH: savedEnv.PATH,
    NO_COLOR: '1',
    TMPDIR: cfg.runDir,
    HOME: home,
    ORBIT_HOME: path.join(home, '.orbit'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    DATABASE_URL: url,
    JWT_SECRET,
    // An owner's model key is stored encrypted (case 10's first session).
    PROVIDER_SECRET_KEY: randomBytes(32).toString('hex'),
    ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
    ORBIT_MANAGED_RUNNERS_PROFILE: profilePath,
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kubeHttp = require('./kube-http-client') as { kubeClientFromProfile: unknown };
  kubeHttp.kubeClientFromProfile = () => {
    throw new Error('tripwire: a Kubernetes client on a Docker server');
  };
  const { AppModule } = await import('../app.module.js');
  @Global()
  @Module({})
  class Nothing {}
  @Module({ imports: [Nothing, AppModule] })
  class Harness {}

  let app: INestApplication | undefined;
  let runtime!: Extract<ManagedRunnerRuntime, { available: true }>;
  async function startApp(): Promise<void> {
    app = await NestFactory.create(Harness, { bodyParser: false, logger: ['error', 'warn'], abortOnError: false });
    app.use(outsideThePoolGateway(json({ limit: '10mb' })));
    app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
    app.use(publicIdHeaders);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
    const adapter = app.get(HttpAdapterHost).httpAdapter;
    app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
    await app.listen(port, cfg.gateway);
    const built = app.get<ManagedRunnerRuntime | null>(MANAGED_RUNNER_RUNTIME);
    assert.ok(built?.available, 'the managed runtime is up');
    assert.ok(built.manager.backend instanceof DockerBackend, 'on DockerBackend');
    runtime = built;
  }
  /** The manager stops as a process would: the runners' open requests (long polls) are cut, not waited for. */
  async function stopApp(): Promise<void> {
    if (!app) return;
    const server = app.getHttpServer() as http.Server;
    const closing = app.close();
    const sweep = setInterval(() => server.closeAllConnections(), 200);
    try {
      await Promise.race([closing, sleep(90_000).then(() => assert.fail('the apiserver did not stop within 90 s'))]);
    } finally {
      clearInterval(sweep);
    }
    app = undefined;
  }

  t.after(async () => {
    sampling = false;
    await sampler.catch(() => undefined);
    events.kill('SIGTERM');
    await stopApp().catch(() => undefined);
    if (channel) await killChannel().catch(() => undefined);
    process.env = savedEnv;
    net.Socket.prototype.connect = originalConnect;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  function api(method: string, route: string, bearer?: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        host: cfg.gateway, port, path: route, method, agent: false,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, json: parsed, text });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── the owner's side and the records ───────────────────────────────────────────────────────
  interface Owner { label: string; userId: string; token: string }
  async function owner(label: string): Promise<Owner> {
    const user = await db.user.create({ data: { email: `${label}-${randomUUID().slice(0, 8)}@example.invalid`, name: label } });
    return { label, userId: user.id, token: await jwt.signAsync({ sub: user.id, email: user.email }) };
  }
  const mappingOf = async (o: Owner): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId: o.userId } }))!;
  async function pool(): Promise<Record<string, number>> {
    const [row] = (await sql.query(
      `SELECT cpu_millis_reserved, memory_bytes_reserved, pods_reserved, active_users_reserved, durable_bytes_reserved
         FROM managed_runner_capacity WHERE cluster_key = $1 AND namespace = $2`,
      [profile.clusterKey, cfg.instanceId],
    )).rows;
    return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
  }
  async function stateIs(o: Owner, state: string, generation?: number, ms = 300_000): Promise<ManagedRunner> {
    return until(`${o.label} ${state}${generation ? ` (generation ${generation})` : ''}`, async () => {
      const m = await mappingOf(o);
      return m && m.managementState === state && (generation === undefined || m.generation === generation) ? m : null;
    }, ms, 500);
  }
  const containerOf = (m: ManagedRunner) => `mr-${m.runnerId}`;

  /** The owner's explicit sleep, asked again while the records still show work, then the whole stop. */
  async function putToSleep(o: Owner): Promise<ManagedRunner> {
    await until(`${o.label} accepting a sleep request`, async () => {
      const m = await mappingOf(o);
      if (m.managementState !== 'READY') return false;
      const asked = await api('POST', '/api/managed-runner/sleep', o.token, { idempotencyKey: `sleep-${randomUUID()}`, revision: m.revision });
      return asked.status === 202;
    }, 240_000, 2_000);
    return stateIs(o, 'SLEEPING', undefined, 300_000);
  }

  /** A parked Codex session of the runner's default workspace, as earlier work would have left it. */
  async function parkedSession(m: ManagedRunner): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session" (id, owner_id, creator_id, workspace_id, assigned_runner_id, title, prompt, provider, provider_builtin, engine,
                              status, num_turns, runtime_session_id, started_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, 'earlier work', 'the opening prompt', 'codex', true, 'codex', 'AWAITING_INPUT', 1, $5, now(), now())`,
      [id, m.ownerId, m.defaultWorkspaceId, m.runnerId, randomUUID()],
    );
    return id;
  }
  /** Claimed by the runner after `since`, then ended, so that nothing of it holds the runner awake. */
  async function claimedThenEnded(o: Owner, sessionId: string, since: Date): Promise<Record<string, unknown>> {
    const claimed = await until(`session ${sessionId} claimed`, async () => {
      const s = await db.session.findUnique({ where: { id: sessionId } });
      return s && s.runClaimedAt && s.runClaimedAt > since && s.status !== 'PENDING' ? s : null;
    }, 180_000, 500);
    const ended = await api('POST', `/api/sessions/${sessionId}/end`, o.token);
    assert.ok(ended.status < 300 || ended.status === 409, `end: ${ended.status} ${ended.text}`);
    await until(`session ${sessionId} settled`, async () => {
      const s = await db.session.findUnique({ where: { id: sessionId } });
      return s && !['PENDING', 'RUNNING'].includes(s.status);
    }, 180_000, 1_000);
    await sql.query(`UPDATE "session" SET retry_at = NULL WHERE id = $1`, [sessionId]);
    return { sessionId, runClaimedAt: claimed.runClaimedAt?.toISOString(), statusAfterClaim: claimed.status, assignedRunnerId: claimed.assignedRunnerId };
  }

  /** Codex signed in with a placeholder key, by an operator; the internal network reaches no model. */
  async function signInCodex(m: ManagedRunner): Promise<void> {
    await shell(containerOf(m), 'codex login --with-api-key >/dev/null 2>&1; codex login status >/dev/null 2>&1', PLACEHOLDER_KEY);
  }

  const DATA = '/var/lib/orbit/home/d2-data';
  async function seedData(m: ManagedRunner): Promise<void> {
    await shell(containerOf(m), [
      `mkdir -p ${DATA}`,
      `head -c 4194304 /dev/urandom > ${DATA}/blob-1`,
      `head -c 1048576 /dev/urandom > ${DATA}/blob-2`,
      `echo "seeded for ${m.runnerId}" > ${DATA}/note.txt`,
      `sqlite3 ${DATA}/state.db "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) INSERT INTO t(v) SELECT hex(randomblob(32)) FROM n; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null`,
    ].join(' && '));
  }
  /** Checksums of the files, and of the database's content, with SQLite's own integrity check. */
  async function dataState(m: ManagedRunner): Promise<{ files: string; integrity: string; rows: string; dump: string }> {
    const out = await shell(containerOf(m), [
      `cd ${DATA}`,
      'sha256sum blob-1 blob-2 note.txt | tr "\\n" ";"',
      'echo',
      'sqlite3 state.db "PRAGMA integrity_check;"',
      'sqlite3 state.db "SELECT count(*), sum(length(v)) FROM t;"',
      'sqlite3 state.db .dump | sha256sum',
    ].join(' && '));
    const [files, integrity, rows, dump] = out.split('\n');
    return { files, integrity, rows, dump: dump.split(' ')[0] };
  }

  await startChannel();
  await startApp();
  note('setup', { instanceId: cfg.instanceId, image: cfg.image, network: cfg.network, server: `http://${cfg.gateway}:${port}` });

  // ── (0) ─────────────────────────────────────────────────────────────────────────────────────
  await t.test('(0) the channel refuses what it must, on real Docker, and nothing changes', async () => {
    const before = { containers: await docker('ps', '-aq', '--filter', `label=${cfg.testLabel.key}=${cfg.testLabel.value}`), volumes: await docker('volume', 'ls', '-q', '--filter', `label=${cfg.testLabel.key}=${cfg.testLabel.value}`) };
    const runnerId = randomUUID();
    const ownerId = randomUUID();
    // A volume named like a managed one, without this instance's label (an operator's, say), and one of another instance.
    const foreign = `mr-data-${randomUUID()}`;
    const otherInstance = `mr-data-${randomUUID()}`;
    await docker('volume', 'create', '--label', `${cfg.testLabel.key}=${cfg.testLabel.value}`, foreign);
    await docker('volume', 'create', '--label', `${cfg.testLabel.key}=${cfg.testLabel.value}`, '--label', 'orbit.managed-runner.instance=someone-else', '--label', 'orbit.managed-runner.kind=data', otherInstance);
    const request = (change: Record<string, unknown> = {}) => ({
      name: `mr-${runnerId}`, image: cfg.image, ownerId, runnerId, generation: 1,
      volume: { name: `mr-data-${runnerId}`, uid: randomUUID() },
      resources: { cpuMillis: 500, memoryBytes: 512 * MiB, pids: 512, tmpBytes: 64 * MiB },
      runner: { serverUrl: `http://${cfg.gateway}:${port}`, maxConcurrent: 1 }, ...change,
    });
    const refusals: Array<{ what: string; status: number; code: string }> = [];
    const expect = async (what: string, method: string, route: string, body: unknown, status: number, code: string, bearer: string | null = token) => {
      const answer = bearer === token
        ? await channelClient.call<{ code: string }>(method, route, body)
        : await new DockerChannelClient({ socketPath: cfg.channel.socket }, bearer ?? '', 10_000).call<{ code: string }>(method, route, body);
      assert.deepEqual([answer.status, answer.body?.code], [status, code], `${what}: ${JSON.stringify(answer.body)}`);
      refusals.push({ what, status, code });
    };
    await expect('no token', 'GET', '/v1/resources', undefined, 401, 'UNAUTHENTICATED', null);
    await expect('a wrong token', 'GET', '/v1/resources', undefined, 401, 'UNAUTHENTICATED', `wrong-${token}`);
    for (const [what, change] of [
      ['privileged mode', { privileged: true }],
      ['an added capability', { capAdd: ['SYS_ADMIN'] }],
      ['a host directory bind', { binds: ['/:/host'] }],
      ['the Docker socket as a mount', { mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' }] }],
      ['the host network', { networkMode: 'host' }],
      ['the host PID namespace', { pidMode: 'host' }],
      ['the host IPC namespace', { ipcMode: 'host' }],
      ['a device', { devices: [{ PathOnHost: '/dev/kvm' }] }],
      ['a raw HostConfig', { HostConfig: { Privileged: true } }],
      ['an environment', { env: ['DOCKER_HOST=unix:///var/run/docker.sock'] }],
      ['a user', { user: '0:0' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(what, 'POST', '/v1/containers', request(change), 400, 'PARAMETER_REFUSED');
    }
    await expect('the Docker socket as the data volume', 'POST', '/v1/containers', request({ volume: { name: '/var/run/docker.sock', uid: randomUUID() } }), 400, 'NAME_REFUSED');
    await expect('a host path as the data volume', 'POST', '/v1/containers', request({ volume: { name: '/etc', uid: randomUUID() } }), 400, 'NAME_REFUSED');
    await expect('another image', 'POST', '/v1/containers', request({ image: 'alpine:3' }), 403, 'IMAGE_REFUSED');
    await expect('another runner\'s volume', 'POST', '/v1/containers', request({ volume: { name: `mr-data-${randomUUID()}`, uid: randomUUID() } }), 403, 'VOLUME_REFUSED');
    await expect('a second container for the volume', 'POST', '/v1/containers', request({ name: `mr-${runnerId}-debug` }), 409, 'SINGLE_CONTAINER_GUARD');
    await expect('limits above the ceiling', 'POST', '/v1/containers', request({ resources: { cpuMillis: 64_000, memoryBytes: 512 * MiB, pids: 512, tmpBytes: 64 * MiB } }), 403, 'LIMIT_REFUSED');
    await expect('a volume without this instance\'s label: read', 'GET', `/v1/volumes/${foreign}`, undefined, 404, 'NOT_FOUND');
    await expect('a volume without this instance\'s label: adopted', 'PUT', `/v1/volumes/${foreign}`, { ownerId, runnerId: foreign.slice('mr-data-'.length), limitBytes: MiB }, 409, 'NOT_MANAGED');
    await expect('a volume removal, off unless an operator turns it on', 'DELETE', `/v1/volumes/${foreign}?uid=${randomUUID()}`, undefined, 403, 'REMOVAL_REFUSED');
    await expect('another instance\'s volume: read', 'GET', `/v1/volumes/${otherInstance}`, undefined, 404, 'NOT_FOUND');
    await expect('a container on a volume without the label', 'POST', '/v1/containers', request({
      name: `mr-${foreign.slice('mr-data-'.length)}`, runnerId: foreign.slice('mr-data-'.length), volume: { name: foreign, uid: randomUUID() },
    }), 409, 'VOLUME_REFUSED');
    const listing = (await channelClient.call<{ volumes: Array<{ name: string }> }>('GET', '/v1/resources')).body!;
    assert.ok(!listing.volumes.some((v) => v.name === foreign || v.name === otherInstance), 'never listed');
    const after = { containers: await docker('ps', '-aq', '--filter', `label=${cfg.testLabel.key}=${cfg.testLabel.value}`), volumes: await docker('volume', 'ls', '-q', '--filter', `label=${cfg.testLabel.key}=${cfg.testLabel.value}`) };
    assert.equal(after.containers, before.containers, 'no container was made');
    assert.deepEqual(after.volumes.split('\n').filter((v) => v !== foreign && v !== otherInstance).sort(), before.volumes.split('\n').filter(Boolean).sort());
    await docker('volume', 'rm', foreign, otherInstance);
    note('(0) channel refusals', { refusals: refusals.length, codes: [...new Set(refusals.map((r) => r.code))] });
  });

  // ── (1) ─────────────────────────────────────────────────────────────────────────────────────
  const alice = await owner('alice');
  const bob = await owner('bob');
  let bobReady!: Promise<ManagedRunner>;
  await t.test('(1) provisioning; an abnormal exit and the owner\'s retry on the same volume', async () => {
    for (const o of [alice, bob]) {
      const ensured = await api('POST', '/api/managed-runner/ensure', o.token, { idempotencyKey: `ensure-${o.label}` });
      assert.equal(ensured.status, 202, ensured.text);
    }
    const a1 = await until('alice\'s first container recorded', async () => {
      const m = await mappingOf(alice);
      return m?.podUid && m.managementState === 'STARTING' ? m : null;
    }, 300_000, 500);
    watched.set(a1.runnerId, a1.pvcName);
    const b1 = await until('bob\'s first container recorded', async () => {
      const m = await mappingOf(bob);
      return m?.podUid && m.managementState === 'STARTING' ? m : null;
    }, 300_000, 500);
    watched.set(b1.runnerId, b1.pvcName);
    assert.equal(a1.backend, 'docker');
    assert.equal(a1.namespace, cfg.instanceId);

    // What Docker made: the template, with nothing to give the container Docker or the host.
    const inspected = JSON.parse(await docker('inspect', containerOf(a1)))[0];
    const host = inspected.HostConfig;
    assert.deepEqual(
      { privileged: host.Privileged, capAdd: host.CapAdd ?? [], capDrop: host.CapDrop, readOnly: host.ReadonlyRootfs, network: host.NetworkMode, pid: host.PidMode, ipc: host.IpcMode, user: inspected.Config.User },
      { privileged: false, capAdd: [], capDrop: ['ALL'], readOnly: true, network: cfg.network, pid: '', ipc: 'private', user: '10001:10001' },
    );
    assert.deepEqual({ cpu: host.NanoCpus, memory: host.Memory, swap: host.MemorySwap, pids: host.PidsLimit }, { cpu: 500_000_000, memory: 512 * MiB, swap: 512 * MiB, pids: 512 });
    assert.ok(host.SecurityOpt.includes('no-new-privileges:true'));
    assert.deepEqual(inspected.Mounts.map((m: { Type: string; Name?: string; Destination: string }) => `${m.Type}:${m.Destination}`).sort(),
      ['tmpfs:/tmp', 'volume:/run/orbit-bootstrap', 'volume:/var/lib/orbit']);
    const tmp = host.Mounts.find((m: { Type: string; Target: string }) => m.Type === 'tmpfs' && m.Target === '/tmp');
    assert.deepEqual(tmp?.TmpfsOptions, { SizeBytes: 64 * MiB, Mode: 0o1777, Options: [['exec']] }, '/tmp executable, sized, nosuid and nodev by Docker');
    assert.ok(!JSON.stringify(inspected).includes('docker.sock'), 'no Docker socket anywhere in it');
    const env: string[] = inspected.Config.Env;
    assert.ok(!env.some((e) => /GENERATION|POD_UID|TOKEN=/.test(e)), `no credential or generation in its environment: ${env.join(' ')}`);
    assert.equal(inspected.Config.Labels['orbit.managed-runner.uid'], a1.podUid, 'the recorded instance UID');
    const logs = (await run('sh', ['-c', `docker logs ${containerOf(a1)} 2>&1`], { maxBuffer: 32 * MiB })).stdout;
    const credential = (await channelClient.readCredential(a1.runnerId))!.token!;
    assert.ok(!logs.includes(credential) && !/generation \d/.test(logs), 'the log carries neither the credential nor the generation');
    note('(1) template', { container: containerOf(a1), mounts: inspected.Mounts.length, capDrop: host.CapDrop, nanoCpus: host.NanoCpus, memory: host.Memory, pids: host.PidsLimit });

    // The real runner reports in; Codex is signed in by an operator. Bob waits for his runner's next
    // engine probe (every five minutes); Alice's container is killed outright, standing for a crash.
    await until('alice\'s runner heartbeating', async () => (await db.runner.findUnique({ where: { id: a1.runnerId } }))?.lastHeartbeatAt, 180_000, 500);
    await signInCodex(a1);
    await until('bob\'s runner heartbeating', async () => (await db.runner.findUnique({ where: { id: b1.runnerId } }))?.lastHeartbeatAt, 180_000, 500);
    await signInCodex(b1);
    bobReady = stateIs(bob, 'READY', 1, 900_000);
    bobReady.catch(() => undefined);

    await docker('kill', '--signal', 'KILL', containerOf(a1));
    // Started again by itself, with no retry: Docker's report of the kill is the stop proof the next generation is made on.
    const a2 = await stateIs(alice, 'READY', 2, 300_000);
    const proof = a2.fencingReceipt as { kind: string; retiredAt?: string; observation: { containers: Array<{ exitCode?: number; finishedAt?: string }> } };
    assert.equal(proof.kind, 'OBSERVED_STOP');
    assert.ok(proof.retiredAt, 'retired by the restart');
    assert.equal(proof.observation.containers[0].exitCode, 137, 'Docker\'s report: killed');
    assert.ok(proof.observation.containers[0].finishedAt, 'and when');
    assert.equal(a2.attempt, 1, 'one attempt spent');
    assert.equal((await pool()).pods_reserved, 2, 'compute held through the restart, never taken twice');
    assert.deepEqual({ pvcUid: a2.pvcUid, runnerId: a2.runnerId, workspace: a2.defaultWorkspaceId }, { pvcUid: a1.pvcUid, runnerId: a1.runnerId, workspace: a1.defaultWorkspaceId });
    assert.notEqual(a2.podUid, a1.podUid);
    assert.equal(a2.initialProvider, 'codex');
    note('(1) crash and restart', { exitCode: 137, finishedAt: proof.observation.containers[0].finishedAt, generation: a2.generation, pvcUid: a2.pvcUid });
  });

  // ── (2) ─────────────────────────────────────────────────────────────────────────────────────
  const pick = (row: Record<string, number>) => ({ cpu: row.cpu_millis_reserved, memory: row.memory_bytes_reserved, pods: row.pods_reserved, users: row.active_users_reserved });
  let reference!: Awaited<ReturnType<typeof dataState>>;
  let parked!: string;
  await t.test('(2) idle sleep: compute released only after Docker\'s exit report and the removal; the same data on waking', async () => {
    const a = await mappingOf(alice);
    await seedData(a);
    reference = await dataState(a);
    assert.equal(reference.integrity, 'ok');
    parked = await parkedSession(a);
    note('(2) seeded', reference);

    const drainStart = await stateIs(alice, 'DRAINING', undefined, 300_000);
    // Hold the manager still from here, so the moment between the exit and the removal can be seen.
    await runtime.worker.stop();
    const heldDraining = await pool();
    assert.equal(heldDraining.pods_reserved >= 1 && heldDraining.cpu_millis_reserved >= 500, true);
    const acceptedRow = await until('the instance\'s acceptance', async () => {
      const m = await mappingOf(alice);
      return m.stopAcknowledgedAt ? m : null;
    }, 180_000, 250);
    const exited = await until('Docker\'s exit report', async () => {
      const s = await stateOf(containerOf(acceptedRow));
      return s?.Status === 'exited' ? s : null;
    }, 300_000, 250);
    const heldExited = await pool();
    assert.equal((await mappingOf(alice)).managementState, 'DRAINING');
    assert.deepEqual(pick(heldExited), pick(heldDraining), 'exited, not removed: compute still held');
    note('(2) exited, not removed', { exitCode: exited.ExitCode, finishedAt: exited.FinishedAt, poolReserved: heldExited });
    runtime.worker.start();
    const asleep = await stateIs(alice, 'SLEEPING', 3, 120_000);
    assert.equal(await stateOf(containerOf(asleep)), null, 'removed');
    assert.equal(await holdersOf(asleep.pvcName), 0);
    const released = await pool();
    assert.equal(released.cpu_millis_reserved, heldExited.cpu_millis_reserved - 500, 'compute released only now');
    assert.equal(released.durable_bytes_reserved, heldExited.durable_bytes_reserved, 'storage kept');
    assert.equal(await docker('volume', 'inspect', '-f', '{{.Name}}', asleep.pvcName), asleep.pvcName, 'the volume stays');
    const proof = asleep.fencingReceipt as { kind: string; observation: { containers: Array<{ exitCode?: number; finishedAt?: string }> } };
    assert.deepEqual([proof.kind, proof.observation.containers[0].exitCode], ['OBSERVED_STOP', exited.ExitCode]);
    note('(2) asleep', { drainedAt: drainStart.stateEnteredAt, sleptAt: asleep.stateEnteredAt, exitCode: exited.ExitCode, poolReleased: released });
  });

  // ── (3)–(5) ─────────────────────────────────────────────────────────────────────────────────
  await t.test('(3) a new message wakes it on the same volume, with the same files and database, and the woken runner claims it', async () => {
    const asleep = await mappingOf(alice);
    const at = new Date();
    const sent = await api('POST', `/api/sessions/${parked}/turns`, alice.token, { clientTurnId: randomUUID(), content: 'are you there?' });
    assert.equal(sent.status, 201, sent.text);
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    assert.equal(awake.pvcUid, asleep.pvcUid);
    const after = await dataState(awake);
    assert.deepEqual(after, reference, 'checksums, integrity_check and rows as they were');
    const served = await claimedThenEnded(alice, parked, at);
    note('(3) woken by a message', { generation: awake.generation, wokeInSeconds: Math.round((awake.stateEnteredAt.getTime() - at.getTime()) / 1000), integrity: after.integrity, ...served });
    await putToSleep(alice);
  });

  await t.test('(4) a runnable task wakes it, and the woken runner claims the task\'s run', async () => {
    const asleep = await mappingOf(alice);
    const at = new Date();
    const created = await api('POST', '/api/tasks', alice.token, {
      title: 'build the thing', description: 'build it', assigneeId: asleep.defaultWorkspaceId,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    assert.equal(created.status, 201, created.text);
    const ran = await api('POST', `/api/tasks/${created.json.id}/execute`, alice.token, {});
    assert.ok(ran.status === 200 || ran.status === 201, ran.text);
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    const runSession = await until('the task\'s run', async () => db.session.findFirst({ where: { taskId: toUuid(created.json.id) } }), 60_000);
    const served = await claimedThenEnded(alice, runSession.id, at);
    note('(4) woken by a task', { generation: awake.generation, task: created.json.id, ...served });
    await putToSleep(alice);
  });

  await t.test('(5) scheduled work wakes it: a session\'s due wakeup, delivered by the scheduled-wakeup worker', async () => {
    const asleep = await mappingOf(alice);
    const scheduled = await parkedSession(asleep);
    const at = new Date();
    await sql.query(
      `INSERT INTO "session_scheduled_wakeup" ("id", "session_id", "state", "delay_seconds", "reason", "prompt", "due_at")
       VALUES (gen_random_uuid(), $1, 'PENDING', 60, 'check the build', 'check the build', now() - interval '1 second')`,
      [scheduled],
    );
    await app!.get(ScheduledWakeupWorker).drain();
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    const served = await claimedThenEnded(alice, scheduled, at);
    note('(5) woken by a scheduled wakeup', { generation: awake.generation, ...served });
    await putToSleep(alice);
  });

  // ── (6) ─────────────────────────────────────────────────────────────────────────────────────
  await t.test('(6) concurrent wakes, and a second manager racing the first: one new generation, one container', async () => {
    const asleep = await mappingOf(alice);
    const rival = new ManagedRunnerManager(db as unknown as PrismaService,
      new DockerBackend(new DockerChannelClient({ socketPath: cfg.channel.socket }, token, 60_000), profile), profile,
      { holder: `rival-${randomUUID()}`, log: { warn: () => undefined, error: () => undefined } });
    let racing = true;
    const rivalLoop = (async () => {
      while (racing) {
        await rival.reconcile(asleep.id).catch(() => undefined);
        await sleep(50);
      }
    })();
    const wakes = await Promise.all(Array.from({ length: 8 }, (_, i) => api('POST', '/api/managed-runner/wake', alice.token, { idempotencyKey: `wake-${i}-${randomUUID()}` })));
    assert.ok(wakes.every((w) => w.status === 202), wakes.map((w) => `${w.status}`).join(','));
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    racing = false;
    await rivalLoop;
    const all = await containersOf(asleep.runnerId);
    assert.equal(all.length, 1, 'one container');
    assert.equal(awake.generation, asleep.generation, 'one new generation: the one the sleep reserved');
    assert.equal(maxAtOnce.get(asleep.runnerId), 1, 'never two containers on the volume');
    note('(6) concurrent wakes', { wakes: wakes.length, generation: awake.generation, containers: all.length, maxAtOnce: maxAtOnce.get(asleep.runnerId) });
  });

  // ── (7) ─────────────────────────────────────────────────────────────────────────────────────
  await t.test('(7) a host restart: the runner killed mid-write, the channel killed, the manager stopped; all back, it recovers', async () => {
    const ready = await mappingOf(alice);
    // A writer in WAL mode, mid-flight when everything stops.
    await shell(containerOf(ready), `nohup sh -c 'i=0; while [ $i -lt 100000 ]; do sqlite3 ${DATA}/state.db "INSERT INTO t(v) VALUES (hex(randomblob(64)));"; i=$((i+1)); done' >/dev/null 2>&1 &`);
    await sleep(2_000);
    await stopApp();
    await killChannel();
    await docker('kill', '--signal', 'KILL', containerOf(ready));
    note('(7) everything stopped', { container: (await stateOf(containerOf(ready)))?.Status });
    await startChannel();
    await startApp();
    // Back by itself, with no retry: the next generation on the same volume, on Docker's report of the kill.
    const back = await stateIs(alice, 'READY', ready.generation + 1, 300_000);
    assert.equal((back.fencingReceipt as { observation: { containers: Array<{ exitCode?: number }> } }).observation.containers[0].exitCode, 137);
    const after = await dataState(back);
    assert.equal(after.files, reference.files, 'the files as they were');
    assert.equal(after.integrity, 'ok', 'SQLite recovered its WAL: integrity_check ok');
    assert.ok(Number(after.rows.split('|')[0]) >= 5000, `rows kept: ${after.rows}`);
    reference = after;
    note('(7) recovered', { generation: back.generation, integrity: after.integrity, rows: after.rows });
  });

  // ── (8) ─────────────────────────────────────────────────────────────────────────────────────
  await t.test('(8) the manager restarted mid-wake finishes it with one container', async () => {
    const asleep = await putToSleep(alice);
    const woke = await api('POST', '/api/managed-runner/wake', alice.token, { idempotencyKey: `wake-${randomUUID()}` });
    assert.equal(woke.status, 202, woke.text);
    const midway = await until('the wake under way', async () => {
      const m = await mappingOf(alice);
      return ['PROVISIONING', 'STARTING'].includes(m.managementState) ? m : null;
    }, 120_000, 50);
    await stopApp();
    note('(8) manager stopped mid-wake', { state: midway.managementState, podUid: midway.podUid });
    await startApp();
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    assert.equal((await containersOf(asleep.runnerId)).length, 1);
    assert.equal(maxAtOnce.get(asleep.runnerId), 1);
    assert.deepEqual(await dataState(awake), reference);
    note('(8) finished after the restart', { generation: awake.generation });
  });

  // ── (9) ─────────────────────────────────────────────────────────────────────────────────────
  await t.test('(9) the channel down during a wake: transient, and the wake completes once it is back', async () => {
    const asleep = await putToSleep(alice);
    await killChannel();
    const woke = await api('POST', '/api/managed-runner/wake', alice.token, { idempotencyKey: `wake-${randomUUID()}` });
    assert.equal(woke.status, 202, woke.text);
    const waiting = await until('a transient failure recorded', async () => {
      const m = await mappingOf(alice);
      return (m.lastError as { code?: string } | null)?.code === 'TRANSIENT' ? m : null;
    }, 120_000, 250);
    note('(9) channel down', { state: waiting.managementState, attempt: waiting.attempt });
    await startChannel();
    const awake = await stateIs(alice, 'READY', asleep.generation, 300_000);
    assert.equal((await containersOf(asleep.runnerId)).length, 1);
    note('(9) woken once the channel was back', { generation: awake.generation });
  });

  // ── (10) ────────────────────────────────────────────────────────────────────────────────────
  await t.test('(10) capacity: the third runner waits, and starts once a slot is given back', async () => {
    // Both slots taken, each runner freshly asked for (demand restarts its idle interval).
    await bobReady;
    for (const o of [alice, bob]) {
      const woke = await api('POST', '/api/managed-runner/wake', o.token, { idempotencyKey: `wake-${randomUUID()}` });
      assert.equal(woke.status, 202, woke.text);
    }
    const b = await stateIs(bob, 'READY', undefined, 300_000);
    await stateIs(alice, 'READY', undefined, 300_000);
    const carol = await owner('carol');
    const ensured = await api('POST', '/api/managed-runner/ensure', carol.token, { idempotencyKey: 'ensure-carol' });
    assert.equal(ensured.status, 202, ensured.text);
    const waiting = await stateIs(carol, 'WAITING_CAPACITY', undefined, 60_000);
    const reason = (await api('GET', '/api/managed-runner', carol.token)).json;
    assert.equal(reason.reason.code, 'MANAGED_RUNNER_CAPACITY_UNAVAILABLE');
    await sleep(8_000); // past a capacity retry: still waiting, nothing made
    assert.equal((await mappingOf(carol)).managementState, 'WAITING_CAPACITY');
    assert.equal(await docker('volume', 'ls', '-q', '--filter', `label=orbit.managed-runner.runner=${waiting.runnerId}`), '', 'no volume made for the one that waits');
    assert.equal((await containersOf(waiting.runnerId)).length, 0);
    assert.equal((await pool()).pods_reserved, 2);
    watched.set(waiting.runnerId, waiting.pvcName);
    note('(10) third runner waiting', { reason: reason.reason.code, poolReserved: await pool() });
    // Its first session while it waits, never having reported its engines (T06b): on carol's own model key it
    // is queued, not refused MODEL_UNAVAILABLE, and her runner takes it once it is up. Nothing named: the
    // default of a workspace whose runner was never ready is that key.
    const key = await api('POST', '/api/providers/mine', carol.token,
      { label: 'carol own key', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: PLACEHOLDER_KEY });
    assert.equal(key.status, 201, key.text);
    const [workspace] = (await api('GET', '/api/workspaces', carol.token)).json;
    assert.deepEqual([workspace.lastProvider, workspace.lastEngine, workspace.providerBuiltin], [key.json.slug, 'claude', false]);
    const queuedAt = new Date();
    const first = await api('POST', '/api/sessions', carol.token, { workspaceId: workspace.id, prompt: 'the first session, while it waits', title: 'first' });
    assert.equal(first.status, 201, `refused while waiting for capacity: ${first.text}`);
    assert.deepEqual([first.json.status, first.json.provider, first.json.engine], ['PENDING', key.json.slug, 'claude']);
    assert.equal((await mappingOf(carol)).managementState, 'WAITING_CAPACITY');
    note('(10) first session queued while waiting', { status: first.status, session: first.json.status, provider: first.json.provider, engine: first.json.engine });

    const bobAsleep = await putToSleep(bob);
    const c1 = await until('carol\'s container recorded', async () => {
      const m = await mappingOf(carol);
      return m?.podUid && m.managementState === 'STARTING' ? m : null;
    }, 180_000, 500);
    // Docker's own record: when carol's container was created, bob's was gone and at most one other was there.
    const lifecycle = (await dockerJson<{ timeNano: number; Action: string; Actor: { Attributes: Record<string, string> } }>('events', '--since', String(Math.floor(started / 1000)), '--until', String(Math.floor(Date.now() / 1000) + 1), '--filter', `label=${instanceLabel}`, '--filter', 'type=container', '--format', '{{json .}}'))
      .filter((e) => ['create', 'destroy'].includes(e.Action));
    const live = new Set<string>();
    let liveAtCarol: string[] | null = null;
    let bobGoneFirst = false;
    for (const e of lifecycle) {
      const runner = e.Actor.Attributes['orbit.managed-runner.runner'];
      if (e.Action === 'create' && runner === c1.runnerId && !liveAtCarol) {
        liveAtCarol = [...live];
        bobGoneFirst = !live.has(b.runnerId);
      }
      if (e.Action === 'create') live.add(runner);
      else live.delete(runner);
    }
    assert.ok(liveAtCarol, 'carol\'s container create is in Docker\'s events');
    assert.ok(bobGoneFirst, 'bob\'s container was removed before carol\'s was created');
    assert.ok(liveAtCarol.length <= 1, `at most one other container when carol's was created: ${liveAtCarol.join(', ')}`);
    await until('carol\'s runner heartbeating', async () => (await db.runner.findUnique({ where: { id: c1.runnerId } }))?.lastHeartbeatAt, 180_000, 500);
    await signInCodex(c1);
    const c = await stateIs(carol, 'READY', 1, 900_000);
    assert.ok((await pool()).pods_reserved <= 2);
    note('(10) third runner started after a release', { bobSleptAt: bobAsleep.stateEnteredAt, liveWhenCarolWasCreated: liveAtCarol.length, carolReadyAt: c.stateEnteredAt, poolReserved: await pool() });
    // The session that waited is claimed by her runner (the network reaches no model, so it is ended then).
    note('(10) first session claimed once READY', await claimedThenEnded(carol, toUuid(first.json.id), queuedAt));
  });

  // ── (11) ────────────────────────────────────────────────────────────────────────────────────
  await t.test('(11) a volume over its disk limit: its container is stopped, and no container is started on it', async () => {
    // Up, and freshly asked for, so its idle interval does not end before the channel's disk check.
    const woke = await api('POST', '/api/managed-runner/wake', alice.token, { idempotencyKey: `wake-${randomUUID()}` });
    assert.equal(woke.status, 202, woke.text);
    const ready = await stateIs(alice, 'READY', undefined, 300_000);
    await shell(containerOf(ready), `head -c ${300 * MiB} /dev/zero > ${DATA}/filler`);
    // The channel's disk check stops it; the restart that follows any stop is refused on a volume over its limit.
    const refused = await until('the over-limit refusal', async () => {
      const m = await mappingOf(alice);
      return m.managementState === 'FAILED' && (m.lastError as { code?: string } | null)?.code === 'VOLUME_OVER_LIMIT' ? m : null;
    }, 480_000, 500);
    assert.equal(refused.generation, ready.generation + 1, 'the stopped container retired, and none made for the next generation');
    assert.equal((await containersOf(ready.runnerId)).length, 0, 'no container on a volume over its limit');
    note('(11) disk limit', { stop: (refused.fencingReceipt as { observation: unknown }).observation, refusal: (refused.lastError as { message: string }).message });
  });

  // ── the end: the records and Docker agree, and nothing opened the Docker socket here ──────
  await t.test('the database and Docker agree, and this process never opened the Docker socket', async () => {
    const resources = (await channelClient.call<{ volumes: Array<{ name: string; kind: string }>; containers: Array<{ name: string; uid: string; generation: number }> }>('GET', '/v1/resources')).body!;
    const mappings = await db.managedRunner.findMany({ where: { namespace: cfg.instanceId }, orderBy: { createdAt: 'asc' } });
    const rows = mappings.map((m) => ({ runner: m.runnerId, state: m.managementState, generation: m.generation, pvcName: m.pvcName, podUid: m.podUid }));
    for (const m of mappings) {
      assert.ok(resources.volumes.some((v) => v.name === m.pvcName && v.kind === 'data'), `${m.pvcName} exists`);
      const container = resources.containers.find((c) => c.name === `mr-${m.runnerId}`);
      if (m.podUid) assert.equal(container?.uid, m.podUid, `${m.runnerId}: the recorded container is the one Docker has`);
      else assert.equal(container, undefined, `${m.runnerId}: no container recorded, none in Docker`);
    }
    writeFileSync(evidence('final-inventory.json'), JSON.stringify({ mappings: rows, channel: resources, maxContainersPerVolume: Object.fromEntries(maxAtOnce) }, null, 2));
    for (const [runnerId, max] of maxAtOnce) assert.ok(max <= 1, `${runnerId}: at most one container at once, saw ${max}`);
    assert.deepEqual(socketTouches, [], 'the apiserver process never opened the Docker socket');
    note('inventory', { mappings: rows.length, maxContainersPerVolume: Object.fromEntries(maxAtOnce) });
  });
});
