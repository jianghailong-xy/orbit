/**
 * AN APPROVAL CARD TOO BIG FOR ITS NOTIFICATION, ON THE APISERVER THE PERSON WATCHES FROM.
 *
 * `build/main.js` twice — the whole AppModule, as the container starts it — over one database that
 * `scripts/run-pg-spec.sh` migrates from empty. With several apiservers a runner's ask (POST
 * /runner/sessions/:id/approvals) reaches one of them, the asker, while the person's streams are on another, the holder
 * (docs/self-hosting.md, "Several apiservers"). The asker publishes the card at seq 0, because a card is never stored in
 * run_event, and announces it to the others over NOTIFY. A card whose tool input is about 20 KB does not fit a
 * notification (MAX_NOTIFY_BYTES, 7000): it is announced by its approval's id instead, and the holder builds it again from
 * the approval row (realtime.service.ts, onNotify). Announced by its seq, as any other oversized event is, it was read
 * back from run_event at seq 0, found nothing, and was dropped.
 *
 *   1. A small card rides its notification whole: on the holder the session's stream receives it, and the owner's
 *      control stream an approval.requested naming it.
 *   2. A card with about 20 KB of tool input reaches the holder too: the session's stream receives it with its input
 *      whole, the same event the asker's own stream received, and the control stream an approval.requested naming it.
 *      The notification carried no input, and what the session sent next reached the holder's stream after the card.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/realtime/approval-relay.pg.spec.ts
 *
 * Not destructive: every row belongs to an account this run creates. The unit twin is realtime-read-back.spec.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
/** PostgreSQL refuses a NOTIFY payload of 8000 bytes or more. */
const NOTIFY_LIMIT_BYTES = 8000;

/** A long shell command, as an agent writes a fixture with one: about 20 KB, and in every line this run's marker. */
const BIG_COMMAND = [
  `cat > fixtures/orders-${RUN}.csv <<'EOF'`,
  ...Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')},order-${RUN},${'9'.repeat(30)}`),
  'EOF',
].join('\n');

/** An SSE stream's frames as they arrive, the server's keepalives left out. */
interface Stream {
  frames: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): void;
}

function openStream(server: Apiserver, route: string, bearer: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const frames: Stream['frames'] = [];
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: route, method: 'GET', agent: false,
        headers: { authorization: `Bearer ${bearer}`, accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${route} answered ${res.statusCode}`));
          return;
        }
        let pending = '';
        res.setEncoding('utf8');
        res.on('error', () => undefined);
        res.on('data', (chunk: string) => {
          pending += chunk;
          for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
            const data = pending.slice(0, end).split('\n').filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim()).join('\n');
            pending = pending.slice(end + 2);
            if (!data) continue;
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type !== 'ping') frames.push(frame);
          }
        });
        resolve({ frames, close: () => req.destroy() });
      },
    );
    req.on('error', (error) => reject(error));
    req.end();
  });
}

/** Poll `check` until it answers something, or the deadline passes and it answers null. */
async function until<T>(check: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await check();
    if (hit !== null) return hit;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

/** Whether an id on the wire is this row's, spelt either way (a UUID, or its public id). */
const names = (wire: unknown, id: string): boolean => wire === id || wire === uuidToBase62(id);

test('an approval card too big for its notification reaches the streams on the other apiserver', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'approval-relay-'));
  const servers: Apiserver[] = [];
  const streams: Stream[] = [];
  // What PostgreSQL delivers on the channel the apiservers announce events on, as every apiserver hears it.
  const listener = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await listener.connect();
  const notices: string[] = [];
  listener.on('notification', (msg) => notices.push(msg.payload ?? ''));
  await listener.query('LISTEN orbit_event');
  t.after(async () => {
    for (const stream of streams) stream.close();
    for (const server of servers) await server.stop();
    await listener.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  // ── the owner, their machine, and a session on it running a turn ───────────────────────────────────────────────────
  const ownerId = randomUUID();
  const owner = { email: `owner-${RUN}@approval-relay.invalid`, password: `pw-${RUN}` };
  await prisma.user.create({
    data: { id: ownerId, email: owner.email, name: 'The owner', passwordHash: hashPassword(owner.password) },
  });
  const runnerId = randomUUID();
  const runnerToken = `approval-relay-${randomUUID()}`;
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: `machine ${RUN}`, tokenHash: sha256(runnerToken), maxConcurrent: 8,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: ['session-worktree-ops-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `checkout ${RUN}`, enabled: true, workDir: dir },
  });
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'Seed the fixtures',
      prompt: 'seed the order fixtures', provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), runtimeSessionId: randomUUID(),
    },
  });
  await prisma.conversationTurn.create({
    data: {
      sessionId, seq: 1, clientTurnId: `turn-${randomUUID()}`, kind: 'message', content: 'seed the order fixtures',
      status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
  });

  // ── the two apiservers ───────────────────────────────────────────────────────────────────────────────────────────────
  const jwtSecret = `approval-relay-${randomUUID()}`;
  const asker = await startApiserver(url, jwtSecret);
  servers.push(asker);
  const holder = await startApiserver(url, jwtSecret);
  servers.push(holder);
  const signedIn = await call(holder, 'POST', '/api/auth/login', undefined, owner);
  assert.equal(signedIn.status, 201, `the owner signs in: ${signedIn.text}`);
  const token = signedIn.json.accessToken as string;

  /** The runner's events at these seqs, stored through the asker. */
  const store = async (seqs: number[]) => {
    const events = seqs.map((seq) => ({
      seq, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), payload: { text: `reply #${seq} (${RUN})` },
    }));
    const reply = await call(asker, 'POST', `/api/runner/sessions/${sessionId}/events`, runnerToken, { events });
    assert.equal(reply.status, 202, `the batch at ${seqs.join(',')}: ${reply.text}`);
  };
  /** The runner's ask, as the orbit MCP permission tool files it, through the asker: the approval's id. */
  const ask = async (input: Record<string, unknown>): Promise<string> => {
    const toolUseId = `toolu_${randomUUID()}`;
    const reply = await call(asker, 'POST', `/api/runner/sessions/${sessionId}/approvals`, runnerToken, {
      toolName: 'Bash', input, toolUseId,
    });
    assert.equal(reply.status, 201, `the card is filed: ${reply.text}`);
    const row = await prisma.approval.findUniqueOrThrow({ where: { sessionId_toolUseId: { sessionId, toolUseId } } });
    assert.equal(row.status, 'PENDING');
    return row.id;
  };
  const watch = async (server: Apiserver, route: string) => {
    const stream = await openStream(server, route, token);
    streams.push(stream);
    return stream;
  };
  const cardOn = (stream: Stream, approvalId: string) =>
    stream.frames.find((f) => f.type === RunEventType.APPROVAL_REQUEST && names(f.payload?.id, approvalId)) ?? null;
  const requestedOn = (stream: Stream, approvalId: string) =>
    stream.frames.find((f) => f.type === 'approval.requested' && names(f.data?.approvalId, approvalId)) ?? null;

  // A stream subscribes to the live events before it replays the stored ones, so once it has replayed seq 1 nothing
  // published after can pass it by. The control stream subscribes before its headers are written.
  await store([1]);
  const holderStream = await watch(holder, `/api/sessions/${sessionId}/events`);
  const askerStream = await watch(asker, `/api/sessions/${sessionId}/events`);
  const control = await watch(holder, '/api/events');
  for (const stream of [holderStream, askerStream]) {
    assert.ok(await until(() => (stream.frames.some((f) => f.seq === 1) ? true : null), 20_000), 'the stream replays seq 1');
  }

  await t.test('(1) a small card rides its notification whole to the holder\'s streams', async () => {
    const input = { command: 'ls -la fixtures', description: 'List the fixtures' };
    const approvalId = await ask(input);
    const card = await until(() => cardOn(holderStream, approvalId), 20_000);
    assert.ok(card, `the holder's stream receives the card: ${JSON.stringify(holderStream.frames)}`);
    assert.deepEqual(card.payload.input, input);
    const requested = await until(() => requestedOn(control, approvalId), 20_000);
    assert.ok(requested, `the holder's control stream: ${JSON.stringify(control.frames)}`);
    assert.ok(names(requested.sessionId, sessionId));
  });

  await t.test('(2) a card with about 20 KB of tool input reaches the holder\'s streams too, in its place', async (st) => {
    const input = { command: BIG_COMMAND, description: 'Write the order fixtures' };
    assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') > 19_000, 'about 20 KB of input');
    const heardBefore = notices.length;
    const approvalId = await ask(input);
    await store([2]); // what the session sends next

    const own = await until(() => cardOn(askerStream, approvalId), 20_000);
    assert.ok(own, 'the asker\'s own stream receives the card, as with one apiserver');
    const card = await until(() => cardOn(holderStream, approvalId), 20_000);
    st.diagnostic(`the holder's stream: ${JSON.stringify(holderStream.frames.map((f) => `${f.seq}:${f.type}`))}`);
    assert.ok(card, 'the holder\'s stream receives the card');
    assert.equal(card.payload.input.command, BIG_COMMAND, 'with its input whole');
    assert.deepEqual(card, own, 'the same event the asker\'s stream received');

    const requested = await until(() => requestedOn(control, approvalId), 20_000);
    assert.ok(requested, `the holder's control stream: ${JSON.stringify(control.frames)}`);
    assert.ok(names(requested.sessionId, sessionId));
    assert.equal(typeof requested.data.pendingApprovals, 'number');

    assert.ok(await until(() => (holderStream.frames.some((f) => f.seq === 2) ? true : null), 20_000), 'seq 2 arrives');
    const at = (f: Record<string, unknown>) => holderStream.frames.indexOf(f);
    assert.ok(at(card) < at(holderStream.frames.find((f) => f.seq === 2)!), 'after the card');

    const told = notices.slice(heardBefore).filter((n) => n.includes(sessionId));
    st.diagnostic(`what the apiservers announced of the session meanwhile: ${JSON.stringify(told)}`);
    for (const notice of told) {
      assert.ok(Buffer.byteLength(notice, 'utf8') < NOTIFY_LIMIT_BYTES, 'every notification fits');
      assert.equal(notice.includes(`order-${RUN}`), false, 'and none carried the input');
    }
  });
});
