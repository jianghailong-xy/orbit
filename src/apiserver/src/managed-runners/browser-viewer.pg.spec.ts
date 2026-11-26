/**
 * The managed runner browser's viewer route (managed-runners/browser-viewer.ts; docs/runner-browser-design.md §4, §6):
 * `GET /api/runners/:id/browser/vnc`, a WebSocket, on the production apiserver — `build/main.js`, the whole AppModule,
 * run as child processes — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with the runner
 * link configured and RUNNER_LINK_NATS_URL naming a NATS server this spec runs (test-support/nats-router.ts). The spec
 * plays the link gateway on that NATS as src/link-gateway/streams.go does: it answers each StreamOpen on rnr.<runnerId>,
 * reads vnc.<streamId>.down and writes vnc.<streamId>.up, in the generated protobuf code's frames. It never limits the
 * streams itself, so a third stream refused here is refused by the apiserver's own count.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/browser-viewer.pg.spec.ts
 *
 * Account A owns a managed runner R and a self-managed runner S, and a session on R that account G is a guest of.
 * Account B is a stranger.
 *
 *   1. With the browser switch off, the route is absent: A's upgrade on R is 404, as any path the apiserver lacks, and
 *      no stream is asked for.
 *   2. With it on (two apiservers, X and Y): no login, a personal access token and a forged one are 401; B on R, G (the
 *      session's guest, not the runner's owner) on R, A on S and A on a runner that does not exist are 404. No stream
 *      is asked for.
 *   3. A on R opens: the WebSocket carries the runner's bytes to A and A's to the runner, both in order, and credits
 *      back what it took; a 100 KiB burst arrives whole.
 *   3b. Paste (§5): a paste from a viewer not in control is refused without reaching the runner; in control it reaches
 *      the runner once as a StreamPaste with the exact text, non-ASCII included, and the runner's answer comes back;
 *      over 64 KiB is refused, as is a second paste while one is waiting; after Done (control off) it is refused again.
 *      The text never appears in the apiserver's output. Another account never has a stream to paste on (2.).
 *   4. A second stream of R opens on the other apiserver; a third is 429 on both, and the runner is never asked: the
 *      count is the apiserver's, across processes.
 *   5. Closing either side closes the other: A leaving sends the runner StreamClose NORMAL and frees the slot for a new
 *      stream; the runner's StreamClose closes A's WebSocket, 1000 for NORMAL and 1011 otherwise.
 *   6. The runner refusing (its browser could not start) is 503 with its reason, and no gateway at all is 503; neither
 *      keeps a slot.
 *   7. An apiserver that dies lets its slots go with its database connection: the other opens two streams at once.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { connect as natsConnect, type NatsConnection } from '@nats-io/transport-node';
import { RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { NatsRouter } from '../test-support/nats-router';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
// build/managed-runners → src/shared/dist: the frames as the proto generates them, which the gateway also speaks.
const pb = require(path.resolve(__dirname, '../../../shared/dist/runner-link/v1/runner_link_pb.js')) as any;
const protobuf = require('@bufbuild/protobuf') as any;
const WebSocket = require('ws') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RFB_VERSION = Buffer.from('RFB 003.008\n');

/** What a WebSocket to the route came to. */
type Outcome =
  | { kind: 'open'; ws: any; received: Buffer[]; texts: any[]; closed: Promise<{ code: number; reason: string }> }
  | { kind: 'refused'; status: number; body: string }
  | { kind: 'error'; error: Error };

function viewer(server: Apiserver, runner: string, token?: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const query = token === undefined ? '' : `?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/runners/${runner}/browser/vnc${query}`);
    const received: Buffer[] = [];
    const texts: any[] = [];
    let closed: (value: { code: number; reason: string }) => void = () => undefined;
    const closing = new Promise<{ code: number; reason: string }>((r) => (closed = r));
    ws.on('message', (data: Buffer, isBinary: boolean) =>
      isBinary ? received.push(Buffer.from(data)) : texts.push(JSON.parse(Buffer.from(data).toString('utf8'))),
    );
    ws.on('close', (code: number, reason: Buffer) => closed({ code, reason: reason.toString('utf8') }));
    ws.on('open', () => resolve({ kind: 'open', ws, received, texts, closed: closing }));
    ws.on('unexpected-response', (_req: unknown, res: any) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      res.on('end', () => resolve({ kind: 'refused', status: res.statusCode, body }));
    });
    ws.on('error', (error: Error) => resolve({ kind: 'error', error }));
  });
}

function opened(outcome: Outcome, what: string): Extract<Outcome, { kind: 'open' }> {
  assert.equal(outcome.kind, 'open', `${what}: ${JSON.stringify(outcome.kind === 'refused' ? outcome : (outcome as any).error?.message)}`);
  return outcome as Extract<Outcome, { kind: 'open' }>;
}

function refused(outcome: Outcome, status: number, what: string): string {
  assert.equal(outcome.kind, 'refused', `${what}: it opened`);
  const r = outcome as Extract<Outcome, { kind: 'refused' }>;
  assert.equal(r.status, status, `${what}: ${r.body}`);
  return r.body;
}

async function until(ms: number, what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms`);
    await sleep(25);
  }
}

/** One stream as the spec's gateway holds it: what came down, decoded. */
interface GatewayStream {
  id: string;
  down: any[];
  up(body: { case: string; value: object }): void;
}

/**
 * The link gateway's side of the streams of one runner, as streams.go has it, without its limit: every StreamOpen on
 * rnr.<runnerId> is answered as `answer` says, and an opened stream's .down is read and its .up written.
 */
class GatewayStandIn {
  readonly opens: string[] = [];
  readonly streams = new Map<string, GatewayStream>();
  answer: { opened: true } | { code: string; message: string } = { opened: true };
  private stopSub?: () => void;

  constructor(
    private readonly nc: NatsConnection,
    private readonly runnerId: string,
  ) {}

  async start(): Promise<void> {
    const sub = this.nc.subscribe(`rnr.${this.runnerId}`, {
      callback: (_error, msg) => {
        const frame = JSON.parse(msg.string()) as { streamOpen?: { streamId: string; kind: string } };
        if (!frame.streamOpen) return;
        const id = frame.streamOpen.streamId;
        assert.equal(frame.streamOpen.kind, 'STREAM_KIND_VNC');
        this.opens.push(id);
        if (!('opened' in this.answer)) {
          msg.respond(JSON.stringify({ streamClose: { streamId: id, code: this.answer.code, message: this.answer.message } }));
          return;
        }
        const stream: GatewayStream = {
          id,
          down: [],
          up: (body) => this.nc.publish(`vnc.${id}.up`, protobuf.toBinary(pb.FrameSchema, protobuf.create(pb.FrameSchema, { body }))),
        };
        this.streams.set(id, stream);
        // Read before answering, as the gateway subscribes before it relays the open (streams.go, openStream).
        this.nc.subscribe(`vnc.${id}.down`, {
          callback: (_e, m) => {
            stream.down.push(protobuf.fromBinary(pb.FrameSchema, m.data).body);
          },
        });
        msg.respond(JSON.stringify({ streamOpened: { streamId: id } }));
        // x11vnc speaks first: its protocol version.
        stream.up({ case: 'streamData', value: { streamId: id, data: RFB_VERSION } });
      },
    });
    this.stopSub = () => sub.unsubscribe();
    await this.nc.flush();
  }

  stop(): void {
    this.stopSub?.();
  }

  /** The stream opened last. */
  last(): GatewayStream {
    return this.streams.get(this.opens[this.opens.length - 1])!;
  }
}

test('the viewer route: owner only, two streams per runner across apiservers, both sides closing each other', {
  skip: !URL_, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const nats = new NatsRouter();
  const natsPort = await nats.listen();
  const servers: Apiserver[] = [];
  const sockets: any[] = [];
  let gwConn: NatsConnection | undefined;
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const server of servers) await server.stop();
    await gwConn?.close().catch(() => undefined);
    await nats.stop().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const keep = (o: Outcome) => {
    if (o.kind === 'open') sockets.push(o.ws);
    return o;
  };

  // ── the accounts, A's two runners, A's session with G as its guest ─────────────────────────────────────────
  const account = async (name: string) => {
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-viewer.invalid`, password: `pw-${name}-${RUN}` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(user.password)]);
    return user;
  };
  const a = await account('owner');
  const b = await account('stranger');
  const g = await account('guest');
  const runner = async (name: string) => {
    const id = randomUUID();
    await prisma.runner.create({
      data: { id, ownerId: a.id, name: `machine ${name}`, tokenHash: sha256(`browser-viewer-${name}-${randomUUID()}`), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return id;
  };
  const managed = await runner('managed');
  const selfManaged = await runner('self-managed');
  // The account's managed runner, asleep as its manager left it, so that no manager acts on it while the spec runs.
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: managed, clusterKey: 'browser-viewer-spec', namespace: 'orbit', pvcName: `mr-data-${managed}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING',
    },
  });
  const session = await prisma.session.create({
    data: {
      ownerId: a.id, creatorId: a.id, assignedRunnerId: managed, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
      title: 'a session on the managed runner', prompt: 'browse', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
    },
    select: { id: true },
  });
  await prisma.sessionGuest.create({ data: { sessionId: session.id, ownerId: a.id, userId: g.id } });

  // ── the gateway's side, on the spec's NATS ─────────────────────────────────────────────────────────────────
  gwConn = await natsConnect({ servers: `nats://127.0.0.1:${natsPort}`, name: 'gateway stand-in' });
  const gateway = new GatewayStandIn(gwConn, managed);
  await gateway.start();

  const JWT_SECRET = `browser-viewer-${randomUUID()}`;
  const signingKey = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
  const linkEnv = {
    ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
    ORBIT_MANAGED_RUNNERS_PROFILE: '',
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.browser-viewer.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: `gateway-${randomUUID()}`,
    RUNNER_LINK_NATS_URL: `nats://127.0.0.1:${natsPort}`,
  };
  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, { ...linkEnv, ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser });
    servers.push(server);
    await until(30_000, 'the apiserver connecting to NATS', () => /connected to NATS at /.test(server.output()));
    return server;
  };
  const login = async (server: Apiserver, user: { email: string; password: string }) => {
    const reply = await call(server, 'POST', '/api/auth/login', undefined, { email: user.email, password: user.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };

  await t.test('1. with the browser switch off, the route is absent and nothing is asked of the runner', async () => {
    const off = await boot('');
    const token = await login(off, a);
    const body = refused(keep(await viewer(off, managed, token)), 404, 'the owner, switch off');
    // Nest's answer for a path it does not have, not the viewer's refusal.
    assert.match(body, /Cannot GET \/api\/runners\/[^/]+\/browser\/vnc/);
    assert.equal(gateway.opens.length, 0);
    await off.stop();
  });

  const x = await boot('true');
  const y = await boot('true');
  const tokenA = await login(x, a);
  const tokenB = await login(x, b);
  const tokenG = await login(x, g);

  await t.test('2. only the runner\'s owner, and only on the managed runner: everyone else is refused before the runner is asked', async () => {
    refused(keep(await viewer(x, managed)), 401, 'no login');
    refused(keep(await viewer(x, managed, `orbit_pat_${randomUUID()}`)), 401, 'a personal access token');
    refused(keep(await viewer(x, managed, `${tokenA.slice(0, -4)}AAAA`)), 401, 'a forged login');
    const stranger = refused(keep(await viewer(x, managed, tokenB)), 404, 'another account on the managed runner');
    assert.match(stranger, /No managed runner of yours has this id/);
    refused(keep(await viewer(y, managed, tokenG)), 404, 'the guest of a session on the runner');
    refused(keep(await viewer(x, selfManaged, tokenA)), 404, 'the owner on a self-managed runner');
    refused(keep(await viewer(x, randomUUID(), tokenA)), 404, 'a runner that does not exist');
    assert.equal(gateway.opens.length, 0, 'no stream was asked for');
  });

  let first!: Extract<Outcome, { kind: 'open' }>;
  let second!: Extract<Outcome, { kind: 'open' }>;

  await t.test('3. the owner\'s stream carries the runner\'s bytes and the owner\'s, in order, and credits what it took', async () => {
    first = opened(keep(await viewer(x, managed, tokenA)), 'the owner on X');
    assert.equal(gateway.opens.length, 1);
    const g1 = gateway.last();
    await until(10_000, 'the runner\'s version reaching the viewer', () => first.received.length > 0);
    assert.deepEqual(first.received[0], RFB_VERSION);
    // The viewer's answer reaches the runner, as StreamData.
    first.ws.send(RFB_VERSION);
    await until(10_000, 'the viewer\'s version reaching the runner', () => g1.down.some((f) => f.case === 'streamData'));
    const data = g1.down.find((f) => f.case === 'streamData');
    assert.deepEqual(Buffer.from(data.value.data), RFB_VERSION);
    // A burst bigger than a frame, sent as the gateway sends it (32 KiB at most per StreamData), arrives whole and in order.
    const burst = Buffer.from(Array.from({ length: 100 << 10 }, (_, i) => (i * 7) % 256));
    for (let at = 0; at < burst.length; at += 32 << 10) {
      g1.up({ case: 'streamData', value: { streamId: g1.id, data: burst.subarray(at, at + (32 << 10)) } });
    }
    await until(10_000, 'the burst reaching the viewer', () => Buffer.concat(first.received).length >= RFB_VERSION.length + burst.length);
    assert.deepEqual(Buffer.concat(first.received), Buffer.concat([RFB_VERSION, burst]));
    // Every byte the viewer took is credited back to the runner.
    const credited = () => g1.down.filter((f) => f.case === 'streamCredit').reduce((n, f) => n + f.value.bytes, 0);
    await until(10_000, 'the credits', () => credited() === RFB_VERSION.length + burst.length);
  });

  await t.test('3b. a paste reaches the runner only from a viewer in control, exactly, capped, one at a time, unlogged', async () => {
    const g1 = gateway.last();
    const pastes = () => g1.down.filter((f) => f.case === 'streamPaste');
    const answered = async (id: number) => {
      await until(10_000, `the answer to paste ${id}`, () => first.texts.some((m) => m.id === id));
      return first.texts.find((m) => m.id === id);
    };
    const SECRET = '密码 Pässwörd 🔑';
    // View only (the viewer has not said it is in control): refused, and nothing goes to the runner.
    first.ws.send(JSON.stringify({ type: 'paste', id: 1, text: SECRET }));
    assert.deepEqual(await answered(1), { type: 'pasted', id: 1, error: 'Take control to paste' });

    // In control: one StreamPaste with the exact text, and the runner's answer comes back.
    first.ws.send(JSON.stringify({ type: 'control', on: true }));
    first.ws.send(JSON.stringify({ type: 'paste', id: 2, text: SECRET }));
    await until(10_000, 'the paste reaching the runner', () => pastes().length === 1);
    const sent = pastes()[0].value;
    assert.equal(sent.text, SECRET);
    assert.equal(sent.streamId, g1.id);
    // A second paste while the first waits for its answer is refused, not queued.
    first.ws.send(JSON.stringify({ type: 'paste', id: 3, text: 'again' }));
    assert.deepEqual(await answered(3), { type: 'pasted', id: 3, error: 'Wait for the last paste to finish' });
    g1.up({ case: 'streamPasted', value: { streamId: g1.id, pasteId: sent.pasteId } });
    assert.deepEqual(await answered(2), { type: 'pasted', id: 2 });
    // The runner's refusal reaches the viewer as it said it.
    first.ws.send(JSON.stringify({ type: 'paste', id: 4, text: 'x' }));
    await until(10_000, 'the second paste reaching the runner', () => pastes().length === 2);
    g1.up({ case: 'streamPasted', value: { streamId: g1.id, pasteId: pastes()[1].value.pasteId, error: 'Click a text field in the browser first' } });
    assert.deepEqual(await answered(4), { type: 'pasted', id: 4, error: 'Click a text field in the browser first' });

    // Over 64 KiB of UTF-8 (a CJK character is 3 bytes): refused before the runner.
    first.ws.send(JSON.stringify({ type: 'paste', id: 5, text: '密'.repeat(((64 << 10) / 3 | 0) + 1) }));
    assert.deepEqual(await answered(5), { type: 'pasted', id: 5, error: 'The text is too long to paste (more than 64 KB)' });

    // Done: control off, and a paste is refused again.
    first.ws.send(JSON.stringify({ type: 'control', on: false }));
    first.ws.send(JSON.stringify({ type: 'paste', id: 6, text: SECRET }));
    assert.deepEqual(await answered(6), { type: 'pasted', id: 6, error: 'Take control to paste' });
    await sleep(200);
    assert.equal(pastes().length, 2, 'only the two pastes made in control reached the runner');
    // The text is never logged.
    assert.ok(!x.output().includes('Pässwörd') && !x.output().includes('密码'), 'the paste appears in the apiserver output');
  });

  await t.test('4. a second stream opens on the other apiserver; a third is refused on both, without asking the runner', async () => {
    second = opened(keep(await viewer(y, managed, tokenA)), 'the owner on Y');
    assert.equal(gateway.opens.length, 2);
    const onX = refused(keep(await viewer(x, managed, tokenA)), 429, 'a third stream on X');
    assert.match(onX, /This runner already has 2 open browser streams/);
    refused(keep(await viewer(y, managed, tokenA)), 429, 'a third stream on Y');
    assert.equal(gateway.opens.length, 2, 'the runner was asked for two streams, no more');
  });

  await t.test('5. closing either side closes the other, and a closed stream frees its slot', async () => {
    const g1 = gateway.streams.get(gateway.opens[0])!;
    first.ws.close();
    await until(10_000, 'the runner told the viewer left', () => g1.down.some((f) => f.case === 'streamClose'));
    const close = g1.down.find((f) => f.case === 'streamClose');
    assert.equal(close.value.code, pb.StreamCloseCode.NORMAL);
    // Its slot is free: a new stream opens, on the other apiserver.
    const third = opened(keep(await viewer(y, managed, tokenA)), 'a stream after one closed');
    assert.equal(gateway.opens.length, 3);

    // The runner ends the second normally: 1000. It ends the third for a broken rule: 1011, with the reason.
    const g2 = gateway.streams.get(gateway.opens[1])!;
    g2.up({ case: 'streamClose', value: { streamId: g2.id, code: pb.StreamCloseCode.NORMAL, message: 'the browser\'s VNC server closed the connection' } });
    assert.equal((await second.closed).code, 1000);
    const g3 = gateway.last();
    g3.up({ case: 'streamClose', value: { streamId: g3.id, code: pb.StreamCloseCode.FLOW_VIOLATION, message: 'the viewer sent past the stream\'s window' } });
    const closed3 = await third.closed;
    assert.equal(closed3.code, 1011);
    assert.equal(closed3.reason, 'the viewer sent past the stream\'s window');
    // Neither was told back what it said itself.
    await sleep(300);
    assert.ok(!g2.down.some((f) => f.case === 'streamClose'));
    assert.ok(!g3.down.some((f) => f.case === 'streamClose'));
  });

  await t.test('6. a runner that refuses, or no gateway at all, is 503 and keeps no slot', async () => {
    gateway.answer = { code: 'STREAM_CLOSE_CODE_UNAVAILABLE', message: 'The browser could not start: chromium: not found' };
    const body = refused(keep(await viewer(x, managed, tokenA)), 503, 'the runner\'s browser could not start');
    assert.match(body, /The runner's browser is not available: The browser could not start: chromium: not found/);
    gateway.answer = { code: 'STREAM_CLOSE_CODE_TOO_MANY_STREAMS', message: 'the runner already has 2 open streams' };
    refused(keep(await viewer(x, managed, tokenA)), 429, 'the gateway\'s own limit');
    gateway.stop();
    await gwConn!.flush();
    refused(keep(await viewer(y, managed, tokenA)), 503, 'no gateway holds the runner');
    gateway.answer = { opened: true };
    await gateway.start();
    // Nothing above kept a slot: two streams open at once.
    opened(keep(await viewer(x, managed, tokenA)), 'the first of two after the refusals');
    opened(keep(await viewer(y, managed, tokenA)), 'the second of two after the refusals');
    refused(keep(await viewer(y, managed, tokenA)), 429, 'and a third, still');
  });

  await t.test('7. an apiserver that dies lets its slots go: the other opens two streams', async () => {
    // Close Y's, then hold both slots on X.
    for (const ws of sockets) ws.close();
    await until(10_000, 'the streams ending', () => sockets.every((ws) => ws.readyState === WebSocket.CLOSED));
    opened(keep(await viewer(x, managed, tokenA)), 'X\'s first');
    opened(keep(await viewer(x, managed, tokenA)), 'X\'s second');
    refused(keep(await viewer(y, managed, tokenA)), 429, 'Y, while X holds both');
    x.child.kill('SIGKILL');
    await new Promise<void>((resolve) => (x.child.exitCode !== null || x.child.signalCode !== null ? resolve() : x.child.once('exit', () => resolve())));
    let outcome: Outcome | undefined;
    await until(20_000, 'a stream opening on Y once X is gone', async () => {
      outcome = keep(await viewer(y, managed, tokenA));
      return outcome.kind === 'open';
    });
    opened(keep(await viewer(y, managed, tokenA)), 'Y\'s second');
    for (const ws of sockets) ws.terminate();
  });
});
