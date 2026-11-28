/**
 * The owner's Update Now of a busy Orbit Cloud runner on real Docker (docs/managed-runner-update-now-design.md, "Busy
 * runner"). Not a unit or pg spec — no roster runs it: it needs a Docker daemon, two managed runner images built from
 * deploy/managed-runner/image (the one the runner starts on, and the one an upgrade moves it to), a disposable
 * PostgreSQL and a dedicated internal network, which scripts/managed-runner/docker-backend-it.py sets up around it:
 *
 *   python3 scripts/managed-runner/docker-backend-it.py --work /mnt/data/tmp/<task>/it --evidence /mnt/data/tmp/<task>/ev \
 *     --spec managed-runner-update-now.it.js --image <old image> --next-image <new image> --stop-grace-seconds 240
 *
 * The whole AppModule runs in this process with ORBIT_MANAGED_RUNNERS_ENABLED=true and a Docker profile naming the image
 * the channel serves — the old one, and after the upgrade the next one, as an upgrade rewrites both — with the runner
 * link on: the daemon's calls come
 * through the link gateway (src/link-gateway, the binary --link-gateway names), a child process listening on the
 * network's gateway address, to the apiserver's internal listener, as main.ts opens it. The restricted channel
 * (deploy/managed-runner/docker-channel/channel.py) is a child process this test starts, stops and starts again on the
 * next image. Every container runs a real image, whose real runner heartbeats, claims, runs Claude Code and stops on
 * Docker's SIGTERM as it would anywhere: the runner image is not changed for any of this.
 *
 * The model is a fake Anthropic Messages endpoint this test serves on the network's gateway address, the only address
 * the containers reach, and the owner's own key points Claude Code at it. Asked for the session's first message, it
 * answers with a long Bash command, so that the turn is in flight when the update comes; asked anything else, it
 * answers with text. Every request it gets is recorded (model-requests.jsonl), with the last user text it carried.
 *
 *   (1) READY on the old image, with a turn in flight: Claude Code running the command the model asked for;
 *   (2) the upgrade: the apiserver stopped, the channel started again on the next image, the apiserver started again;
 *       the container and its turn keep running, and the owner's status offers the update;
 *   (3) Update Now without `interruptTurns`: 409 MANAGED_RUNNER_BUSY naming the running turn, nothing recorded;
 *   (4) with `interruptTurns: true`: 202, and an activity row naming the session. The manager asks the channel to stop
 *       the container (Docker's SIGTERM, then the stop grace); no other container exists until Docker reports it
 *       exited; then the next generation is made from the next image, on the same volume and runner;
 *   (5) the interrupted turn continues on the next generation: its runner reclaims the session, the control plane hands
 *       the turn back as a continuation and the model is asked to carry on, with the note an update's continuation
 *       opens with. What the runner reported of the cut, what the model was sent and how the turn ended are recorded.
 * Throughout: never two containers on one volume (sampled), never a Docker socket in this process.
 *
 * With --earlier-channel (the channel.py of an image before a944a7f362, e.g. 95884b154f's, with --image built at that
 * commit), the runner starts as one made before the /home/orbit layout: that channel mounts the volume at
 * /var/lib/orbit, the image keeps home in its `home` folder, and the workspace is stored under /var/lib/orbit/home until
 * the upgrade applies migration 0980 to it, as the release that brought the layout did. (1) also leaves sign-ins in the
 * engines' homes and records the turn's Claude Code transcript; after (4) the next generation, made by today's channel
 * from the next image, must have moved that home to the volume root (deploy/managed-runner/image/entrypoint.py,
 * move_earlier_home) with the sign-ins, the workspace's files at its stored path and the transcript where `--resume`
 * reads it, and (5) must continue the turn on that same transcript, its first prompt still in the conversation.
 *
 * With --middle-image as well (an image of the /home/orbit layout without that move, e.g. built at 5c0ea49508), the
 * runner is restarted once on it before the upgrade, as a runner of that kind was by a sleep and wake or a crash
 * restart before the move landed: (1m) Update Now moves it to the middle image, which mounts the volume at /home/orbit
 * and starts on an empty, signed-out home at the root beside the earlier one, and the turn carries on there (the model
 * asks for the long command again, so it is still in flight). After (4) the next generation must have set that unused
 * home aside in a dated .orbit-empty-home-<ts> folder, not deleted it, and moved the earlier home to the root as above.
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { RUNNER_UPDATE_RESUME_NOTE, toUuid } from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { outsideThePoolGateway } from '../providers/pool-gateway.controller';
import { listenForRunnerLinkCalls } from '../runner-api/runner-link-call';
import { DockerBackend } from './docker-backend';
import { DockerChannelClient } from './docker-channel-client';
import type { DockerRunnerProfile } from './managed-runner-profile';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } from './managed-runner.service';
import { wordOf } from '../test-support/session-word';

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
  nextImage?: string;
  /** An image of today's layout without the earlier home's move, which the runner is restarted on once (--middle-image). */
  middleImage?: string;
  linkGateway?: string;
  /** The channel the runner first starts under, when it is to be one made before the /home/orbit layout. */
  earlierChannel?: string;
  network: string;
  gateway: string;
  testLabel: { key: string; value: string };
}

const CONFIG = process.env.ORBIT_D2_IT;
const PG_URL = process.env.COORDINATOR_PG_URL;
const run = promisify(execFile);
const MiB = 2 ** 20;
/** The model the owner's key names, and what the first message says so the fake model knows it. */
const MODEL = 'orbit-update-now-it-model';
const MARK = 'UPDATE-NOW-IT';
/**
 * The command the fake model asks for: far longer than the runner's stop gives a turn (100 s on Linux). Not a `sleep`:
 * Claude Code refuses a standalone one.
 */
const LONG_COMMAND = 'timeout 580 tail -f /dev/null';
/** What the fake model answers a continuation with, so the transcript shows the turn going on. */
const CONTINUED = 'Carried on after the update: the long command was cut by the restart, and nothing else was left to do.';

/** One request the fake model got. */
interface ModelRequest {
  at: string;
  path: string;
  model: string | null;
  stream: boolean;
  tools: boolean;
  lastUserText: string;
  /** Whether the conversation sent still holds the session's first prompt. */
  firstPrompt: boolean;
  answered: 'tool_use' | 'continuation' | 'text' | 'count_tokens' | 'other';
}

test('Update Now of a busy Orbit Cloud runner, on real Docker', { skip: !CONFIG || !PG_URL, concurrency: 1, timeout: 3_600_000 }, async (t) => {
  const cfg = JSON.parse(readFileSync(CONFIG!, 'utf8')) as ItConfig;
  assert.ok(cfg.nextImage, 'the image an upgrade moves the runner to (--next-image)');
  assert.ok(cfg.linkGateway && existsSync(cfg.linkGateway), 'the runner link gateway binary (--link-gateway)');
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
  async function inspect(name: string): Promise<{ Id: string; Image: string; State: { Status: string; ExitCode: number; FinishedAt: string; StartedAt: string }; Mounts: Array<{ Name?: string; Destination: string }> } | null> {
    try {
      return JSON.parse(await docker('inspect', '-f', '{{json .}}', name));
    } catch {
      return null;
    }
  }
  /** A container's log, both streams: the entrypoint writes what it did to stderr, which `docker logs` passes on as its own. */
  async function containerLogs(name: string): Promise<string> {
    const { stdout, stderr } = await run('docker', ['logs', name], { maxBuffer: 32 * MiB }).catch((error: Error) => ({ stdout: error.message, stderr: '' }));
    return `${stdout}${stderr}`;
  }
  async function shell(name: string, script: string): Promise<string> {
    const { stdout } = await run('docker', ['exec', '-u', '10001:10001', name, 'sh', '-c', script], { maxBuffer: 8 * MiB });
    return stdout.trim();
  }

  // Docker's own record of every container and volume this instance made: the lifecycle evidence.
  const events = spawn('docker', ['events', '--filter', `label=${instanceLabel}`, '--filter', 'type=container', '--filter', 'type=volume', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const eventLog = createWriteStream(evidence('docker-events.jsonl'), { flags: 'a' });
  events.stdout.pipe(eventLog);

  // Never two containers on one volume: sampled all along.
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

  async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 120_000, every = 250): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
      await sleep(every);
    }
  }

  // ── the fake model, on the gateway address ─────────────────────────────────────────────────
  const modelRequests: ModelRequest[] = [];
  /** Whether a continuation is answered with the long command again, keeping the turn in flight (the middle image). */
  let continueWithCommand = false;
  const modelLog = createWriteStream(evidence('model-requests.jsonl'), { flags: 'a' });
  type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((block: { type?: string; text?: string }) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
  };
  const model = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const pathname = (req.url ?? '').split('?')[0];
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      const messages: Array<{ role?: string; content?: unknown }> = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserText = textOf(lastUser?.content);
      const tools = Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool?.name === 'Bash');
      const askedForCommand = messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: { type?: string }) => b?.type === 'tool_use'));
      const record = (answered: ModelRequest['answered']) => {
        const firstPrompt = messages.some((m) => m.role === 'user' && textOf(m.content).includes(MARK));
        const entry: ModelRequest = { at: new Date().toISOString(), path: pathname, model: typeof body.model === 'string' ? body.model : null, stream: body.stream === true, tools, lastUserText: lastUserText.slice(0, 4000), firstPrompt, answered };
        modelRequests.push(entry);
        modelLog.write(`${JSON.stringify(entry)}\n`);
      };
      if (req.method === 'POST' && pathname.endsWith('/v1/messages/count_tokens')) {
        record('count_tokens');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 128 }));
        return;
      }
      if (req.method !== 'POST' || !pathname.endsWith('/v1/messages')) {
        record('other');
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not here' } }));
        return;
      }
      let blocks: Block[];
      let stop: 'end_turn' | 'tool_use' = 'end_turn';
      if (tools && lastUserText.includes('[Orbit]') && continueWithCommand) {
        record('continuation');
        blocks = [{ type: 'tool_use', id: `toolu_${randomBytes(8).toString('hex')}`, name: 'Bash', input: { command: LONG_COMMAND, description: 'Run the long command again', timeout: 590_000 } }];
        stop = 'tool_use';
      } else if (tools && lastUserText.includes('[Orbit]')) {
        record('continuation');
        blocks = [{ type: 'text', text: CONTINUED }];
      } else if (tools && lastUserText.includes(MARK) && !askedForCommand) {
        record('tool_use');
        blocks = [{ type: 'tool_use', id: `toolu_${randomBytes(8).toString('hex')}`, name: 'Bash', input: { command: LONG_COMMAND, description: 'Run the long command', timeout: 590_000 } }];
        stop = 'tool_use';
      } else {
        record('text');
        blocks = [{ type: 'text', text: 'Done.' }];
      }
      const id = `msg_${randomBytes(8).toString('hex')}`;
      const usage = { input_tokens: 128, output_tokens: 16, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const name = typeof body.model === 'string' ? body.model : MODEL;
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, type: 'message', role: 'assistant', model: name, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: name, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      blocks.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        } else {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 16 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, cfg.gateway, () => resolve());
  });
  const modelUrl = `http://${cfg.gateway}:${(model.address() as net.AddressInfo).port}`;

  // ── the channel: started, stopped and started again on the next image by this test ─────────
  const token = readFileSync(cfg.channel.tokenFile, 'utf8').trim();
  const channelClient = new DockerChannelClient({ socketPath: cfg.channel.socket }, token, 30_000);
  const channelLog = createWriteStream(evidence('channel.log'), { flags: 'a' });
  const nextConfig = path.join(cfg.runDir, 'channel-next.json');
  writeFileSync(nextConfig, JSON.stringify({ ...JSON.parse(readFileSync(cfg.channel.config, 'utf8')), image: cfg.nextImage }, null, 2));
  const middleConfig = path.join(cfg.runDir, 'channel-middle.json');
  if (cfg.middleImage) writeFileSync(middleConfig, JSON.stringify({ ...JSON.parse(readFileSync(cfg.channel.config, 'utf8')), image: cfg.middleImage }, null, 2));
  let channel: ChildProcess | undefined;
  async function startChannel(config: string, script = cfg.channel.script): Promise<void> {
    channel = spawn(cfg.python, ['-I', script, 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
    channel.stdout!.pipe(channelLog, { end: false });
    channel.stderr!.pipe(channelLog, { end: false });
    await until('the channel answering', async () => existsSync(cfg.channel.socket) && (await channelClient.call('GET', '/v1/resources').then((a) => a.status === 200, () => false)), 60_000);
  }
  /** As an upgrade's restart stops it: SIGTERM, and whatever it was doing is asked again by the next one. */
  async function stopChannel(): Promise<void> {
    const child = channel!;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(15_000).then(() => child.kill('SIGKILL'))]);
      await exited;
    }
    channel = undefined;
  }

  // ── the apiserver: this process, the switch on, a Docker profile adopting the channel's image ──
  const freePort = (host: string) => new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port: free } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const port = await freePort(cfg.gateway);
  const linkPort = await freePort(cfg.gateway);
  const linkInternalPort = await freePort('127.0.0.1');
  const linkMetricsPort = await freePort('127.0.0.1');
  const linkGatewayToken = randomBytes(24).toString('hex');
  const linkSigning = generateKeyPairSync('ed25519');
  const pem = (key: { export(options: { type: 'pkcs8' | 'spki'; format: 'pem' }): string | Buffer }, type: 'pkcs8' | 'spki') =>
    Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
  const profile: DockerRunnerProfile = {
    schemaVersion: 1,
    valueKind: 'actual',
    backend: 'docker',
    environmentId: 'orbit-update-now-it',
    clusterKey: `unit-${cfg.runId}`,
    resourceProfileId: 'update-now-it-v1',
    docker: { instanceId: cfg.instanceId, channel: { socketPath: cfg.channel.socket }, tokenFile: cfg.channel.tokenFile },
    storage: { capacity: '1Gi' },
    runner: { image: cfg.image, serverUrl: `http://${cfg.gateway}:${port}`, maxConcurrent: 2, tmpSizeLimit: '256Mi', resources: { cpu: '1', memory: '1536Mi', pids: 1024 } },
    capacity: { compute: { cpu: '2', memory: '3Gi' }, storage: { usable: '4Gi', headroom: '1Gi' } },
    lifecycle: {
      maxAttempts: 8, backoffBaseSeconds: 1, backoffMaxSeconds: 4, startupDeadlineSeconds: 900, requestTimeoutSeconds: 60,
      leaseSeconds: 30, pollIntervalSeconds: 1, heartbeatFreshSeconds: 90, idleSeconds: 3600, capacityRetrySeconds: 5, drainSeconds: 300,
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
    // The owner's model key is stored encrypted.
    PROVIDER_SECRET_KEY: randomBytes(32).toString('hex'),
    ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
    ORBIT_MANAGED_RUNNERS_PROFILE: profilePath,
    // The runner link (runner-api/runner-link-token.ts): the gateway the runners are told of, and its secrets.
    RUNNER_LINK_SIGNING_KEY: pem(linkSigning.privateKey, 'pkcs8'),
    RUNNER_LINK_URL: `ws://${cfg.gateway}:${linkPort}`,
    RUNNER_LINK_GATEWAY_TOKEN: linkGatewayToken,
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
  let linkServer: http.Server | null = null;
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
    // The link gateway's door to the same routes, as main.ts opens it.
    linkServer = await listenForRunnerLinkCalls(app, { port: String(linkInternalPort), host: '127.0.0.1' });
    assert.ok(linkServer, 'runner link calls are served');
    const built = app.get<ManagedRunnerRuntime | null>(MANAGED_RUNNER_RUNTIME);
    assert.ok(built?.available, 'the managed runtime is up');
    assert.ok(built.manager.backend instanceof DockerBackend, 'on DockerBackend');
  }
  /** The apiserver stops as a process would: the runners' open requests (long polls) are cut, not waited for. */
  async function stopApp(): Promise<void> {
    if (!app) return;
    const server = app.getHttpServer() as http.Server;
    const link = linkServer;
    linkServer = null;
    const closing = Promise.all([app.close(), link ? new Promise((resolve) => link.close(resolve)) : null]);
    const sweep = setInterval(() => {
      server.closeAllConnections();
      link?.closeAllConnections();
    }, 200);
    try {
      await Promise.race([closing, sleep(90_000).then(() => assert.fail('the apiserver did not stop within 90 s'))]);
    } finally {
      clearInterval(sweep);
    }
    app = undefined;
  }

  // ── the runner link gateway: one process for the whole test, as a deployment keeps it across an apiserver restart ──
  const gatewayLog = createWriteStream(evidence('link-gateway.log'), { flags: 'a' });
  const linkGateway = spawn(cfg.linkGateway!, [], {
    env: {
      PATH: savedEnv.PATH,
      LINK_LISTEN_ADDR: `${cfg.gateway}:${linkPort}`,
      LINK_METRICS_ADDR: `127.0.0.1:${linkMetricsPort}`,
      LINK_TLS_MODE: 'off',
      LINK_API_URL: `http://${cfg.gateway}:${port}`,
      LINK_GATEWAY_TOKEN: linkGatewayToken,
      LINK_PUBLIC_KEYS: pem(linkSigning.publicKey, 'spki'),
      LINK_INTERNAL_API_URLS: `http://127.0.0.1:${linkInternalPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  linkGateway.stdout!.pipe(gatewayLog, { end: false });
  linkGateway.stderr!.pipe(gatewayLog, { end: false });

  t.after(async () => {
    sampling = false;
    linkGateway.kill('SIGTERM');
    await sampler.catch(() => undefined);
    events.kill('SIGTERM');
    await stopApp().catch(() => undefined);
    if (channel) await stopChannel().catch(() => undefined);
    await new Promise((resolve) => model.close(resolve));
    modelLog.end();
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

  const user = await db.user.create({ data: { email: `alice-${randomUUID().slice(0, 8)}@example.invalid`, name: 'alice' } });
  const alice = { userId: user.id, token: await jwt.signAsync({ sub: user.id, email: user.email }) };
  const mappingOf = async (): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId: alice.userId } }))!;
  const containerOf = (m: ManagedRunner) => `mr-${m.runnerId}`;
  const statusOf = async () => (await api('GET', '/api/managed-runner', alice.token)).json;

  await startChannel(cfg.channel.config, cfg.earlierChannel ?? cfg.channel.script);
  await startApp();
  await until('the link gateway healthy', async () => {
    if (linkGateway.exitCode !== null) assert.fail(`the link gateway exited ${linkGateway.exitCode}`);
    return (await fetch(`http://127.0.0.1:${linkMetricsPort}/healthz`).catch(() => ({ ok: false }))).ok;
  }, 60_000);
  note('setup', { instanceId: cfg.instanceId, image: cfg.image, nextImage: cfg.nextImage, network: cfg.network, server: `http://${cfg.gateway}:${port}`, link: `ws://${cfg.gateway}:${linkPort}`, model: modelUrl });

  let first!: ManagedRunner;
  let sessionId!: string;
  let turnId!: string;
  // A runner made before the /home/orbit layout: its home, and what (1) leaves in it.
  const earlier = cfg.earlierChannel ? '/var/lib/orbit/home' : null;
  assert.ok(!cfg.middleImage || earlier, 'the middle image follows an earlier one (--earlier-channel)');
  /** The generation (2) upgrades around, and the image it runs: the first one, or the middle one's. */
  let current!: ManagedRunner;
  let currentImage = cfg.image;
  /** Where in modelRequests the update (4) starts: the continuation (5) looks for is the one after it. */
  let continuationsFrom = 0;
  const SIGN_INS = {
    '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-update-now-it-not-a-token', refreshToken: 'sk-ant-ort01-update-now-it-not-a-token', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'max' } }),
    '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'update-now-it-not-a-token', access_token: 'update-now-it-not-a-token', refresh_token: 'update-now-it-not-a-token', account_id: 'update-now-it' }, last_refresh: '2026-11-16T00:00:00Z' }),
  };
  let transcript: { file: string; bytes: number; sha256: string; lines: number } | null = null;
  /** Claude Code's folder for a working directory's conversations, as it names it (and `--resume` reads it). */
  const claudeSlug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');
  /** The newest transcript in one such folder: its path, size, line count and the digest of its first `bytes` bytes. */
  async function transcriptIn(name: string, folder: string, bytes?: number) {
    const out = await shell(name, `f=$(ls -t ${folder}/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] || exit 0; `
      + `n=${bytes ?? '$(wc -c < "$f")'}; echo "$f"; wc -c < "$f"; head -c "$n" "$f" | sha256sum | cut -d' ' -f1; wc -l < "$f"`);
    if (!out) return null;
    const [file, size, sha256, lines] = out.split('\n');
    return { file, bytes: Number(size), sha256, lines: Number(lines) };
  }

  await t.test('(1) READY on the old image, with a turn in flight: Claude Code running the command the model asked for', async () => {
    const key = await api('POST', '/api/providers/mine', alice.token, {
      label: 'fake model', runtime: 'claude', baseUrl: modelUrl, apiKey: 'sk-orbit-update-now-it-not-a-key',
      models: [{ value: MODEL, label: 'Fake model' }], defaultModel: MODEL,
    });
    assert.equal(key.status, 201, key.text);
    const ensured = await api('POST', '/api/managed-runner/ensure', alice.token, { idempotencyKey: 'ensure-alice' });
    assert.equal(ensured.status, 202, ensured.text);
    first = await until('alice READY', async () => {
      const m = await mappingOf();
      return m?.managementState === 'READY' ? m : null;
    }, 900_000, 1_000);
    watched.set(first.runnerId, first.pvcName);
    current = first;
    const container = await inspect(containerOf(first));
    assert.equal(container?.Image, cfg.image, 'made from the old image');
    const runner = await db.runner.findUniqueOrThrow({ where: { id: first.runnerId } });
    note('(1) READY on the old image', { generation: first.generation, podUid: first.podUid, image: container?.Image, runnerVersion: runner.version, initialProvider: first.initialProvider });

    // The project lives on the data volume, where the next generation finds it. On a runner made before the
    // /home/orbit layout it is under that image's home, and so is the path the server stores for it.
    const workDir = `${earlier ?? '/home/orbit'}/update-now-it`;
    await shell(containerOf(first), `mkdir -p ${workDir} && echo "a project" > ${workDir}/README.md`);
    if (earlier) {
      const layout = await shell(containerOf(first), 'echo "$HOME"; ls -A /var/lib/orbit');
      assert.deepEqual(layout.split('\n'), [earlier, 'home'], 'the earlier layout: the volume at /var/lib/orbit, home in its `home` folder');
      // Sign-ins, where the engines keep them under that home.
      for (const [file, content] of Object.entries(SIGN_INS)) {
        await shell(containerOf(first), `umask 077 && printf '%s' '${content}' > ${earlier}/${file}`);
      }
    }
    const workspace = await db.workspace.create({ data: { ownerId: alice.userId, runnerId: first.runnerId, targetRunnerId: first.runnerId, name: 'Update Now project', workDir } });
    const created = await api('POST', '/api/sessions', alice.token, {
      workspaceId: workspace.id, title: 'A long command', prompt: `${MARK}: run the long command and tell me when it is done.`,
      provider: key.json.slug, engine: 'claude', model: MODEL, permissionMode: 'bypassPermissions',
    });
    assert.equal(created.status, 201, created.text);
    sessionId = toUuid(created.json.id);
    // The model asked for the command, the runner reported the tool call, and the turn is running.
    const toolUse = await until('the model asked for the long command and the runner reported it', async () => {
      const event = await db.runEvent.findFirst({ where: { sessionId, type: 'tool_use' }, orderBy: { seq: 'asc' } });
      return event && modelRequests.some((r) => r.answered === 'tool_use') ? event : null;
    }, 600_000, 1_000);
    turnId = toolUse.turnId!;
    await sleep(5_000);
    const running = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(wordOf(running), 'RUNNING', 'the turn is in flight');
    const processes = await shell(containerOf(first), `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^${LONG_COMMAND}' || true`);
    if (earlier) {
      transcript = await until('the turn\'s Claude Code transcript', () => transcriptIn(containerOf(first), `${earlier}/.claude/projects/${claudeSlug(workDir)}`), 120_000, 1_000);
      const volume = await shell(containerOf(first), `cd /var/lib/orbit && find . -maxdepth 3 -not -path './home/.orbit/*/*' | sort | head -80`);
      note('(1) the earlier layout', { home: earlier, workDir, transcript, signIns: Object.keys(SIGN_INS), volume: volume.split('\n') });
    }
    note('(1) turn in flight', { sessionId, turnId, status: wordOf(running), toolUse: toolUse.payload, longCommandProcesses: processes });
  });

  if (cfg.middleImage) {
    await t.test('(1m) restarted once on an image of today\'s layout without the move: an empty home at the root beside the earlier one, the turn carried on there', async () => {
      await stopApp();
      await stopChannel();
      writeFileSync(profilePath, JSON.stringify({ ...profile, runner: { ...profile.runner, image: cfg.middleImage } }, null, 2));
      await startChannel(middleConfig);
      // The release that brought the /home/orbit layout rewrote the stored paths of managed runners' workspaces.
      const before = await db.workspace.findMany({ where: { runnerId: first.runnerId }, select: { workDir: true } });
      await sql.query(readFileSync(path.resolve('prisma/migrations/0980_managed_runner_home_orbit/migration.sql'), 'utf8'));
      const after = await db.workspace.findMany({ where: { runnerId: first.runnerId }, select: { workDir: true } });
      assert.deepEqual(after.map((w) => w.workDir), ['/home/orbit/update-now-it'], 'migration 0980 names the folder under /home/orbit');
      note('(1m) migration 0980 applied', { before: before.map((w) => w.workDir), after: after.map((w) => w.workDir) });
      await startApp();
      await until('the status offering the middle image', async () => (await statusOf())?.update?.phase === 'available', 300_000, 1_000);
      continueWithCommand = true;
      const from = modelRequests.length;
      const accepted = await api('POST', '/api/managed-runner/update-now', alice.token, { interruptTurns: true });
      assert.equal(accepted.status, 202, accepted.text);
      const middle = await until('the generation on the middle image READY', async () => {
        const m = await mappingOf();
        return m.managementState === 'READY' && m.generation > first.generation ? m : null;
      }, 900_000, 1_000);
      const name = containerOf(middle);
      const container = await inspect(name);
      assert.equal(container?.Image, cfg.middleImage, 'made from the middle image');
      assert.equal(middle.runnerId, first.runnerId, 'the same runner');
      // The turn carried on in the empty home, and asked for the long command again: still in flight.
      await until('the turn carried on on the middle image', async () => modelRequests.slice(from).some((r) => r.answered === 'continuation'), 600_000, 1_000);
      await until('the long command running again', async () => {
        const out = await shell(name, `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^${LONG_COMMAND}' || true`);
        return Number(out) > 0;
      }, 300_000, 1_000);
      const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
      assert.equal(wordOf(session), 'RUNNING', 'the turn is in flight on the middle image');
      continueWithCommand = false;
      const root = (await shell(name, 'echo "$HOME"; ls -A /home/orbit | sort | tr "\\n" " "')).split('\n');
      const signedIn = await shell(name, `for f in ${Object.keys(SIGN_INS).join(' ')}; do [ -e /home/orbit/$f ] && echo $f; done; true`);
      const listing = await shell(name, 'cd /home/orbit && find . -maxdepth 4 -not -path "./home/*" | sort | head -200');
      const logs = await containerLogs(name);
      note('(1m) on the middle image', { generation: middle.generation, podUid: middle.podUid, image: container?.Image, root, signedIn, rootHome: listing.split('\n'), entrypoint: logs.split('\n').filter((line) => line.includes('orbit-container')) });
      assert.equal(root[0], '/home/orbit');
      assert.ok(/(^| )home( |$)/.test(root[1]), `the earlier home is still in its \`home\` folder: ${root[1]}`);
      assert.equal(signedIn, '', 'the root home is signed out');
      current = middle;
      currentImage = cfg.middleImage!;
    });
  }

  await t.test('(2) the upgrade: the apiserver and the channel restarted on the next image; the container and its turn keep running', async () => {
    await stopApp();
    await stopChannel();
    writeFileSync(profilePath, JSON.stringify({ ...profile, runner: { ...profile.runner, image: cfg.nextImage } }, null, 2));
    await startChannel(nextConfig);
    if (earlier && !cfg.middleImage) {
      // The release that brought the /home/orbit layout rewrote the stored paths of managed runners' workspaces.
      const before = await db.workspace.findMany({ where: { runnerId: first.runnerId }, select: { workDir: true } });
      await sql.query(readFileSync(path.resolve('prisma/migrations/0980_managed_runner_home_orbit/migration.sql'), 'utf8'));
      const after = await db.workspace.findMany({ where: { runnerId: first.runnerId }, select: { workDir: true } });
      assert.deepEqual(after.map((w) => w.workDir), ['/home/orbit/update-now-it'], 'migration 0980 names the folder under /home/orbit');
      note('(2) migration 0980 applied', { before: before.map((w) => w.workDir), after: after.map((w) => w.workDir) });
    }
    await startApp();
    const update = await until('the status offering the update', async () => {
      const status = await statusOf();
      return status?.update?.phase === 'available' ? status.update : null;
    }, 300_000, 1_000);
    const m = await mappingOf();
    const container = await inspect(containerOf(m));
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.deepEqual({ generation: m.generation, podUid: m.podUid, image: container?.Image, session: wordOf(session) }, { generation: current.generation, podUid: current.podUid, image: currentImage, session: 'RUNNING' });
    note('(2) upgraded around the running container', { update, currentImageSha: m.currentImageSha, imageOutdatedSince: m.imageOutdatedSince, session: wordOf(session) });
  });

  await t.test('(3) Update Now without interruptTurns: refused 409 MANAGED_RUNNER_BUSY, naming the running turn', async () => {
    const asked = (await mappingOf()).updateRequestedAt;
    const refused = await api('POST', '/api/managed-runner/update-now', alice.token, {});
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, 'MANAGED_RUNNER_BUSY');
    assert.deepEqual(refused.json.turns.map((turn: { sessionId: string }) => toUuid(turn.sessionId)), [sessionId]);
    const m = await mappingOf();
    // Nothing asked: still none, or the middle image's Update Now, already done.
    assert.deepEqual({ asked: m.updateRequestedAt, state: m.managementState }, { asked: cfg.middleImage ? asked : null, state: 'READY' });
    assert.equal(await db.activity.count({ where: { actorId: alice.userId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY } }), cfg.middleImage ? 1 : 0, 'nothing recorded beyond the middle image\'s Update Now');
    note('(3) refused while busy', { status: refused.status, code: refused.json.code, turns: refused.json.turns, backgroundJobs: refused.json.backgroundJobs });
  });

  let next!: ManagedRunner;
  await t.test('(4) with interruptTurns: recorded, stopped through the channel, and made again from the next image only after Docker reports the exit', async () => {
    const before = await mappingOf();
    const askedAt = new Date();
    continuationsFrom = modelRequests.length;
    const accepted = await api('POST', '/api/managed-runner/update-now', alice.token, { interruptTurns: true });
    assert.equal(accepted.status, 202, accepted.text);
    assert.equal(accepted.json.update?.phase, 'updating');
    const activity = await db.activity.findFirst({ where: { actorId: alice.userId, type: MANAGED_RUNNER_UPDATE_NOW_ACTIVITY, createdAt: { gte: askedAt } } });
    assert.ok(activity, 'the request is recorded');
    assert.deepEqual((activity.payload as { sessionIds: string[] }).sessionIds, [sessionId], 'naming the session whose turn it interrupts');
    note('(4) Update Now taken', { status: accepted.status, update: accepted.json.update, activity: activity.payload });

    // Until Docker reports the old container stopped, it is the only container of the runner, and the mapping stays
    // READY on its generation.
    const oldName = containerOf(before);
    const oldId = (await inspect(oldName))!.Id;
    let samples = 0;
    const exited = await until('Docker reporting the old container exited', async () => {
      const state = await inspect(oldName);
      const m = await mappingOf();
      if (state && state.Id === oldId && state.State.Status === 'running') {
        assert.equal((await containersOf(m.runnerId)).length, 1, 'one container while the old one stops');
        assert.deepEqual({ generation: m.generation, podUid: m.podUid }, { generation: before.generation, podUid: before.podUid }, 'nothing advanced before the stop report');
        samples += 1;
        return null;
      }
      return state && state.Id === oldId ? state : { Id: oldId, Image: currentImage, State: { Status: 'removed', ExitCode: -1, FinishedAt: '', StartedAt: '' }, Mounts: [] };
    }, 600_000, 500);
    note('(4) old container stopped', { exit: exited.State, sampledWhileStopping: samples, stopTookSeconds: Math.round((Date.now() - askedAt.getTime()) / 1000) });

    next = await until('the next generation READY', async () => {
      const m = await mappingOf();
      return m.managementState === 'READY' && m.generation > before.generation ? m : null;
    }, 900_000, 1_000);
    const container = await inspect(containerOf(next));
    assert.equal(container?.Image, cfg.nextImage, 'the next container is made from the next image');
    assert.deepEqual(
      { generation: next.generation, runnerId: next.runnerId, pvcUid: next.pvcUid, attempt: next.attempt, volume: container?.Mounts.find((mount) => mount.Destination === '/home/orbit')?.Name },
      { generation: before.generation + 1, runnerId: before.runnerId, pvcUid: before.pvcUid, attempt: 0, volume: before.pvcName },
      'the next generation, on the same volume and runner',
    );
    assert.ok(next.updateCompletedAt && next.updateCompletedAt >= next.updateRequestedAt!, 'the update ended with the next generation READY');
    const proof = next.fencingReceipt as { kind: string; predecessor: { podUid: string } };
    assert.deepEqual([proof.kind, proof.predecessor.podUid], ['OBSERVED_STOP', before.podUid], 'Docker\'s report of the exit is the stop proof');
    // Docker's own record: the old container died before the new one was created.
    const lifecycle = (await dockerJson<{ timeNano: number; Action: string; Actor: { ID: string; Attributes: Record<string, string> } }>(
      'events', '--since', String(Math.floor(started / 1000)), '--until', String(Math.floor(Date.now() / 1000) + 1),
      '--filter', `label=orbit.managed-runner.runner=${before.runnerId}`, '--filter', 'type=container', '--format', '{{json .}}',
    )).filter((e) => ['create', 'kill', 'die', 'destroy', 'start'].includes(e.Action)).map((e) => ({ action: e.Action, id: e.Actor.ID.slice(0, 12), signal: e.Actor.Attributes.signal, exitCode: e.Actor.Attributes.exitCode, at: new Date(e.timeNano / 1e6).toISOString() }));
    const died = lifecycle.findIndex((e) => e.action === 'die' && oldId.startsWith(e.id));
    const created = lifecycle.findIndex((e) => e.action === 'create' && !oldId.startsWith(e.id));
    assert.ok(died >= 0 && created > died, `the old container died before the next one was created: ${JSON.stringify(lifecycle)}`);
    const runner = await db.runner.findUniqueOrThrow({ where: { id: next.runnerId } });
    note('(4) next generation READY', { generation: next.generation, podUid: next.podUid, image: container?.Image, runnerVersion: runner.version, lifecycle, maxContainersAtOnce: maxAtOnce.get(before.runnerId) });
  });

  if (earlier) {
    await t.test('(4b) the next generation moved the earlier home to the volume root: sign-ins, the workspace\'s files at its stored path, the transcript where --resume reads it', async () => {
      const name = containerOf(next);
      const root = (await shell(name, 'echo "$HOME"; ls -A /home/orbit | sort | tr "\\n" " "; echo; readlink /var/lib/orbit/home')).split('\n');
      const workspace = await db.workspace.findFirstOrThrow({ where: { runnerId: next.runnerId }, select: { workDir: true } });
      const readme = await shell(name, `cat ${workspace.workDir}/README.md`);
      const signIns = Object.fromEntries(await Promise.all(Object.keys(SIGN_INS).map(async (file) => [file, await shell(name, `cat /home/orbit/${file}`)] as const)));
      const config = JSON.parse(await shell(name, 'cat /home/orbit/.orbit/config.json')) as { runnerId: string; workDir: string; runnerToken?: string };
      const moved = await transcriptIn(name, `/home/orbit/.claude/projects/${claudeSlug(workspace.workDir!)}`, transcript!.bytes);
      const logs = await containerLogs(name);
      note('(4b) the earlier home moved', { root, workDir: workspace.workDir, readme, config: { runnerId: config.runnerId, workDir: config.workDir }, transcriptBefore: transcript, transcriptAfter: moved, warnings: logs.split('\n').filter((line) => line.includes('orbit-container')) });
      assert.equal(root[0], '/home/orbit');
      assert.ok(!/(^| )(home|\.orbit-earlier-home)( |$)/.test(root[1]), `no earlier home left at the root: ${root[1]}`);
      assert.equal(root[2], '/home/orbit', 'the earlier home\'s path is a link to today\'s');
      assert.equal(readme, 'a project', 'the workspace\'s files at its stored path');
      assert.deepEqual(signIns, SIGN_INS, 'the engines\' sign-ins');
      assert.deepEqual({ runnerId: config.runnerId, workDir: config.workDir }, { runnerId: next.runnerId, workDir: '/home/orbit' }, 'the runner\'s own config, moved and rewritten');
      assert.ok(moved, 'the transcript is in the folder Claude Code reads for the workspace');
      assert.equal(moved!.sha256, transcript!.sha256, 'the same transcript, byte for byte, as far as the old generation wrote it');
      assert.ok(!logs.includes('leaves the first as it is'), 'no second home to choose between');
      if (cfg.middleImage) {
        // The empty home the middle image ran in, set aside and kept: its own config, for the same runner.
        const aside = root[1].split(' ').filter((entry) => entry.startsWith('.orbit-empty-home-'));
        assert.equal(aside.length, 1, `one folder the empty home is set aside in: ${root[1]}`);
        assert.match(aside[0], /^\.orbit-empty-home-\d{8}T\d{6}Z$/);
        const asideConfig = JSON.parse(await shell(name, `cat /home/orbit/${aside[0]}/.orbit/config.json`)) as { runnerId: string; workDir: string };
        const asideListing = await shell(name, `cd /home/orbit/${aside[0]} && find . -maxdepth 3 | sort | head -120`);
        const identity = JSON.parse(await shell(name, 'cat /home/orbit/.orbit/container-identity.json')) as { runnerId: string };
        const instance = JSON.parse(await shell(name, 'cat /home/orbit/.orbit/managed-instance.json')) as { runnerId: string; generation: number; podUid: string };
        const signedOut = await shell(name, `for f in ${Object.keys(SIGN_INS).join(' ')}; do [ -e /home/orbit/${aside[0]}/$f ] && echo $f; done; true`);
        note('(4b) the empty home set aside', { aside: aside[0], config: asideConfig, listing: asideListing.split('\n'), signInsInIt: signedOut, identity, instance, setAside: logs.split('\n').filter((line) => line.includes('set aside in')) });
        assert.equal(asideConfig.runnerId, next.runnerId, 'the empty home\'s own config, kept');
        assert.equal(asideConfig.workDir, '/home/orbit/orbit-repos');
        assert.equal(signedOut, '', 'the home set aside held no sign-in');
        assert.ok(logs.includes('set aside in /home/orbit/.orbit-empty-home-'), 'the start says where it set the home aside');
        assert.deepEqual([identity.runnerId, instance.runnerId, instance.generation, instance.podUid], [next.runnerId, next.runnerId, next.generation, next.podUid], 'the runner\'s identity, from the earlier home');
        const runner = await db.runner.findUniqueOrThrow({ where: { id: next.runnerId } });
        assert.ok(runner.lastHeartbeatAt && runner.lastHeartbeatAt.getTime() > Date.now() - 120_000, 'the runner heartbeats as itself');
      }
    });
  }

  await t.test('(5) the interrupted turn continues on the next generation, as the update\'s continuation', async () => {
    const continuation = await until('the model asked to carry on', async () => modelRequests.slice(continuationsFrom).find((r) => r.answered === 'continuation'), 600_000, 1_000);
    const cut = await db.runEvent.findMany({ where: { sessionId, turnId, type: 'interrupt' }, orderBy: { seq: 'asc' } });
    note('(5) continuation sent to the model', { at: continuation.at, lastUserText: continuation.lastUserText.slice(0, 1500), cut: cut.map((e) => e.payload) });
    const answered = await until('the continued turn answered', async () => {
      const event = await db.runEvent.findFirst({ where: { sessionId, type: 'assistant', seq: { gt: cut.at(-1)?.seq ?? 0 } }, orderBy: { seq: 'desc' } });
      return event && JSON.stringify(event.payload).includes('Carried on after the update') ? event : null;
    }, 600_000, 1_000);
    const settled = await until('the session settled after its turn', async () => {
      const s = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
      return wordOf(s) !== 'RUNNING' && wordOf(s) !== 'PENDING' ? s : null;
    }, 300_000, 1_000);
    const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    note('(5) the turn continued and ended', { session: wordOf(settled), assignedRunnerId: settled.assignedRunnerId, turn: { deliveryStatus: turn.deliveryStatus, outcome: turn.outcome }, answer: answered.payload });
    assert.equal(settled.assignedRunnerId, next.runnerId, 'on the same runner');
    assert.ok(cut.length > 0, 'the runner marked the cut');
    assert.ok(continuation.lastUserText.includes(RUNNER_UPDATE_RESUME_NOTE), `the continuation opens with the update's note: ${continuation.lastUserText.slice(0, 400)}`);
    if (earlier) {
      // The turn went on in the conversation the old generation held: Claude Code resumed its transcript, which the
      // continuation was appended to, and the model was sent the session's first prompt with it.
      const workspace = await db.workspace.findFirstOrThrow({ where: { runnerId: next.runnerId }, select: { workDir: true } });
      const after = await transcriptIn(containerOf(next), `/home/orbit/.claude/projects/${claudeSlug(workspace.workDir!)}`, transcript!.bytes);
      note('(5) the conversation continued', { transcriptBefore: transcript, transcriptAfter: after, continuationCarriedFirstPrompt: continuation.firstPrompt });
      assert.ok(continuation.firstPrompt, 'the continuation carries the conversation, from its first prompt');
      assert.equal(after?.file.split('/').pop(), transcript!.file.split('/').pop(), 'the same conversation file');
      assert.equal(after?.sha256, transcript!.sha256, 'which still begins with what the old generation wrote');
      assert.ok(after!.bytes > transcript!.bytes, 'and the continued turn was appended to it');
    }
  });

  await t.test('Docker and the database agree, and this process never opened the Docker socket', async () => {
    const m = await mappingOf();
    const containers = await containersOf(m.runnerId);
    assert.equal(containers.length, 1, 'one container for the runner');
    assert.equal(maxAtOnce.get(m.runnerId) ?? 0, 1, 'never two containers on its volume');
    assert.deepEqual(socketTouches, []);
    note('final', { generation: m.generation, state: m.managementState, containers, maxContainersAtOnce: Object.fromEntries(maxAtOnce), modelRequests: modelRequests.length });
  });
});
