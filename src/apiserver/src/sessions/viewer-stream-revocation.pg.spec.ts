/**
 * A viewer stream ends when the viewer's access does (docs/session-viewer-stream-design.md §5, D4 = A), held against
 * two production apiservers — `build/main.js`, the whole AppModule, twice — over one real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. Every stream is held open on apiserver A and every write is made on
 * apiserver B, so the `viewer.revoked` signal reaches the stream only over the NOTIFY bridge, as it would on another
 * replica. One case per way access ends:
 *
 *   (1) the owner removes the guest           — the guest's stream;
 *   (2) the guest leaves                      — the guest's stream;
 *   (3) the owner turns the session link off  — the session link's stream;
 *   (4) the session link expires              — the session link's stream (the owner sets an expiry a moment away;
 *                                               the stream's recheck comes due at it, no write at the time);
 *   (5) the task link stops including the session (Conversations off) — the task link's conversation stream;
 *   (6) the session goes to the Trash         — the guest's, the session link's and the task link's streams;
 *   (7) the session is deleted for good       — the guest's stream (see the case for how it is open at the time);
 *
 * each asserting a `{type:'gone'}` frame as the stream's last, and the end of the stream, within 1 s of the commit:
 * measured from the moment the write was SENT, which is no later than its commit, so the bound holds a fortiori. Then
 *
 *   (8) with no signal at all — the invitation ended by a bare UPDATE, no service in the way — the recheck at the next
 *       ping (KEEPALIVE_MS) ends the stream all the same.
 *
 * And a link that still opens the session but stops including tool output ends a stream projecting it with NO gone
 * frame — only the end, so the client reconnects from its sinceSeq and gets the redacted projection:
 *
 *   (9)  the owner turns the session link's Tool output off on apiserver B — ended within 1 s;
 *   (10) the same by a bare UPDATE, no signal — ended at the next ping;
 *
 * each then reconnecting from sinceSeq and holding the new stream to the link's paged read: no tool_output or
 * background_output, and tool_use/tool_result payloads equal to the read's redacted ones.
 *
 * Each measured time is printed as a TAP diagnostic.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/viewer-stream-revocation.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import { CreatorType, type PrismaClient, RunnerStatus, SessionDispatchOrigin, TaskCompletionCriterion } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { openStream, type HeldStream } from '../test-support/sse-client';
import { KEEPALIVE_MS } from './session-stream';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RUNNER_TOKEN = `viewer-revocation-runner-${randomUUID()}`;
/** The criterion's bound: the gone frame and the end of the stream within 1 s of the commit. */
const WITHIN_MS = 1_000;
/** What only tool output carries: in a stored tool call, and in the live tool_output / background_output. */
const TOOL_SECRET = `tool-output-${RUN}`;

test('viewer streams end with a gone frame within 1 s when access ends, and at the next ping when the signal is lost', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let a: Apiserver | undefined;
  let b: Apiserver | undefined;
  const held: HeldStream[] = [];
  t.after(async () => {
    held.forEach((stream) => stream.close());
    await Promise.all([a?.stop(), b?.stop()]);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const pub = uuidToBase62;

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const guestId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `owner.${RUN}@viewer.invalid`, name: `Owner ${RUN}`, passwordHash: 'x' } });
  await db.user.create({ data: { id: guestId, email: `guest.${RUN}@viewer.invalid`, name: `Guest ${RUN}`, passwordHash: 'x' } });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner ${RUN}`, tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `viewers ${RUN}`, enabled: true, model: 'm', workDir: '/tmp/x' } });

  const jwtSecret = `viewer-revocation-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const ownerLogin = await jwt.signAsync({ sub: ownerId, email: `owner.${RUN}@viewer.invalid` });
  const guestLogin = await jwt.signAsync({ sub: guestId, email: `guest.${RUN}@viewer.invalid` });
  [a, b] = await Promise.all([startApiserver(url, jwtSecret), startApiserver(url, jwtSecret)]);
  const onB = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> => call(b!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    return reply;
  };

  /** A fresh session with a stored exchange, the guest invited to it, a session link and a task link to it. */
  async function world(name: string) {
    const sessionId = randomUUID();
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, title: `${name} ${RUN}`, creatorType: CreatorType.USER, creatorId: ownerId,
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
      },
    });
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, taskId, title: `${name} ${RUN}`, prompt: name,
        provider: 'claude', providerBuiltin: true, model: 'm', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER, turnState: null, numTurns: 1, engineTurnActive: false,
        startedAt: new Date(),
      },
    });
    // A tool call, whose input and result a link shows only with Tool output on, then the reply.
    await sql.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload) VALUES (gen_random_uuid(), $1::uuid, 1, 'user', $2::jsonb),
         (gen_random_uuid(), $1::uuid, 2, 'tool_use', $4::jsonb),
         (gen_random_uuid(), $1::uuid, 3, 'tool_result', $5::jsonb),
         (gen_random_uuid(), $1::uuid, 4, 'assistant', $3::jsonb)`,
      [
        sessionId, JSON.stringify({ text: name }), JSON.stringify({ text: `About ${name}.` }),
        JSON.stringify({ id: 'toolu_1', name: 'Bash', input: { command: `echo ${TOOL_SECRET}` } }),
        JSON.stringify({ toolUseId: 'toolu_1', content: TOOL_SECRET, isError: false }),
      ],
    );
    await db.sessionGuest.create({ data: { sessionId, ownerId, userId: guestId } });
    const shareToken = randomBytes(24).toString('base64url');
    const taskToken = randomBytes(24).toString('base64url');
    await sql.query(`INSERT INTO share_link (id, owner_id, token, session_id) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid)`, [ownerId, shareToken, sessionId]);
    await sql.query(
      `INSERT INTO share_link (id, owner_id, token, task_id, include) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::jsonb)`,
      [ownerId, taskToken, taskId, JSON.stringify({ conversations: true })],
    );
    const s = pub(sessionId);
    const base = `http://127.0.0.1:${a!.port}/api`;
    return {
      sessionId,
      s,
      taskId,
      shareToken,
      doors: {
        guest: `${base}/guest-sessions/${s}/stream?access_token=${guestLogin}`,
        sessionLink: `${base}/shared/${shareToken}/stream`,
        taskLink: `${base}/shared/${taskToken}/sessions/${s}/stream`,
      },
    };
  }

  /** Open a stream on apiserver A and wait until it is live: its replay and its opening head are in. */
  async function open(streamUrl: string, what: string): Promise<HeldStream> {
    const stream = await openStream(streamUrl);
    held.push(stream);
    assert.equal(stream.status, 200, `${what} opened ${stream.status}: ${stream.body().slice(0, 300)}`);
    await stream.until((f) => f.type === 'head', `${what}: the opening head`);
    await stream.until((f) => f.type === 'assistant', `${what}: the replayed reply`);
    return stream;
  }

  /**
   * Wait for the stream's gone frame and its end, and say how long after `from` (ms since the epoch) each came. The
   * gone frame must be the last frame the stream sent.
   */
  async function goneAndEnded(stream: HeldStream, what: string, from: number, ms: number): Promise<{ gone: number; ended: number }> {
    await stream.until((f) => f.type === 'gone', `${what}: the gone frame`, ms);
    const gone = Date.now() - from;
    await Promise.race([
      stream.ended,
      new Promise((_, fail) => setTimeout(() => fail(new Error(`${what}: the stream did not end`)), ms)),
    ]);
    const ended = Date.now() - from;
    assert.deepEqual(stream.frames.at(-1), { type: 'gone' }, `${what}: the last frame is {type:'gone'}`);
    return { gone, ended };
  }

  /** Make `write` (on apiserver B) and hold every stream to the 1 s bound from the moment it was sent. */
  async function within(c: TestContext, streams: Array<[string, HeldStream]>, write: () => Promise<unknown>): Promise<void> {
    const sent = Date.now();
    const watched = streams.map(([what, stream]) => goneAndEnded(stream, what, sent, 5_000).then((times) => ({ what, ...times })));
    await write();
    const answered = Date.now() - sent;
    for (const { what, gone, ended } of await Promise.all(watched)) {
      c.diagnostic(`${what}: write answered after ${answered} ms; gone frame ${gone} ms, stream ended ${ended} ms after the write was sent`);
      assert.ok(gone <= WITHIN_MS, `${what}: the gone frame came ${gone} ms after the write was sent`);
      assert.ok(ended <= WITHIN_MS, `${what}: the stream ended ${ended} ms after the write was sent`);
    }
  }

  await t.test('(1) the owner removes the guest: the guest\'s stream ends', async (c) => {
    const w = await world('guest removed');
    const guest = await open(w.doors.guest, 'guest');
    // A link's stream of the same session is not the guest's, and stays open.
    const link = await open(w.doors.sessionLink, 'session link');
    await within(c, [['guest', guest]], async () => ok(await onB('DELETE', `/sessions/${w.s}/guests/${pub(guestId)}`, ownerLogin), 'removing the guest'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(link.frames.some((f) => f.type === 'gone'), false, 'the session link\'s stream is untouched by the guest\'s removal');
  });

  await t.test('(2) the guest leaves: the guest\'s stream ends', async (c) => {
    const w = await world('guest left');
    const guest = await open(w.doors.guest, 'guest');
    await within(c, [['guest', guest]], async () => ok(await onB('POST', `/guest-sessions/${w.s}/leave`, guestLogin), 'leaving'));
  });

  await t.test('(3) the owner turns the session link off: its stream ends', async (c) => {
    const w = await world('link revoked');
    const link = await open(w.doors.sessionLink, 'session link');
    const guest = await open(w.doors.guest, 'guest');
    await within(c, [['session link', link]], async () => ok(await onB('DELETE', `/sessions/${w.s}/share`, ownerLogin), 'turning the link off'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(guest.frames.some((f) => f.type === 'gone'), false, 'the guest\'s stream is untouched by the link\'s end');
  });

  await t.test('(4) the session link expires: its stream ends at the expiry, with no write at the time', async (c) => {
    const w = await world('link expired');
    const link = await open(w.doors.sessionLink, 'session link');
    const expiresAt = new Date(Date.now() + 2_500);
    ok(await onB('PUT', `/sessions/${w.s}/share`, ownerLogin, { expiresAt: expiresAt.toISOString() }), 'setting the expiry');
    // Still open after the change: it changed when the link ends, not whether it is open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(link.frames.some((f) => f.type === 'gone'), false, 'the stream is still open before the expiry');
    const times = await goneAndEnded(link, 'session link', expiresAt.getTime(), 10_000);
    c.diagnostic(`session link: gone frame ${times.gone} ms, stream ended ${times.ended} ms after the expiry`);
    assert.ok(times.gone >= 0, `the gone frame came ${-times.gone} ms before the expiry`);
    assert.ok(times.gone <= WITHIN_MS, `the gone frame came ${times.gone} ms after the expiry`);
    assert.ok(times.ended <= WITHIN_MS, `the stream ended ${times.ended} ms after the expiry`);
  });

  await t.test('(5) the task link stops including the session: its conversation stream ends', async (c) => {
    const w = await world('link no longer includes');
    const conversation = await open(w.doors.taskLink, 'task link conversation');
    await within(c, [['task link conversation', conversation]], async () =>
      ok(await onB('PUT', `/tasks/${pub(w.taskId)}/share`, ownerLogin, { include: { conversations: false } }), 'turning Conversations off'));
  });

  await t.test('(6) the session goes to the Trash: every viewer\'s stream ends', async (c) => {
    const w = await world('session trashed');
    const streams: Array<[string, HeldStream]> = [
      ['guest', await open(w.doors.guest, 'guest')],
      ['session link', await open(w.doors.sessionLink, 'session link')],
      ['task link conversation', await open(w.doors.taskLink, 'task link conversation')],
    ];
    await within(c, streams, async () => ok(await onB('DELETE', `/sessions/${w.s}`, ownerLogin), 'moving the session to the Trash'));
  });

  await t.test('(7) the session is deleted for good: the guest\'s stream ends', async (c) => {
    const w = await world('session deleted');
    const guest = await open(w.doors.guest, 'guest');
    // Delete-for-good takes only a session already in the Trash, whose streams the Trash has ended. To hold the
    // delete's own signal to the bound, the session is put in the Trash by a bare UPDATE — no signal — and deleted at
    // once, long before the stream's next ping (KEEPALIVE_MS) could notice the Trash by itself.
    await sql.query(`UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1::uuid`, [w.sessionId]);
    await within(c, [['guest', guest]], async () => ok(await onB('DELETE', `/sessions/${w.s}/purge`, ownerLogin), 'deleting the session'));
    assert.equal(await db.session.count({ where: { id: w.sessionId } }), 0, 'the session is gone');
  });

  await t.test('(8) no signal at all: the recheck at the next ping ends the stream', async (c) => {
    const w = await world('signal lost');
    const opened = Date.now();
    const guest = await open(w.doors.guest, 'guest');
    // The invitation ended behind every service's back: nothing publishes viewer.revoked.
    await sql.query(`UPDATE "session_guest" SET "removed_at" = now(), "removed_reason" = 'REMOVED' WHERE "session_id" = $1::uuid`, [w.sessionId]);
    const written = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(guest.frames.some((f) => f.type === 'gone'), false, 'nothing ended the stream before its ping: there was no signal');
    const times = await goneAndEnded(guest, 'guest', written, KEEPALIVE_MS + 5_000);
    const sinceOpen = times.gone + (written - opened);
    c.diagnostic(`guest: gone frame ${times.gone} ms, stream ended ${times.ended} ms after the bare write; ${sinceOpen} ms after the stream opened (ping every ${KEEPALIVE_MS} ms)`);
    assert.equal(guest.frames.some((f) => f.type === 'ping'), false, 'the stream ended at its first ping instead of sending it');
    assert.ok(sinceOpen <= KEEPALIVE_MS + WITHIN_MS, `the stream ended ${sinceOpen} ms after it opened, past its first ping`);
  });

  /** Publish a live-only event for `sessionId` as another apiserver would (RealtimeService.publish → NOTIFY). */
  const live = (sessionId: string, type: string, payload: unknown) => sql.query(`SELECT pg_notify('orbit_event', $1)`, [
    JSON.stringify({ i: `viewer-revocation-${RUN}`, r: sessionId, e: { seq: 0, ts: new Date().toISOString(), type, payload } }),
  ]);

  /**
   * The session link's stream, open with Tool output on, has sent a live tool_output and the stored tool call whole;
   * `turnOff` turns the link's Tool output off and answers when; the stream must then end with no gone frame, as soon
   * as `bound` says, and a stream reopened from sinceSeq carries exactly what the link's paged read does.
   */
  async function narrowed(
    c: TestContext,
    name: string,
    turnOff: (w: Awaited<ReturnType<typeof world>>) => Promise<number>,
    bound: (times: { ended: number; sinceOpen: number; frames: HeldStream['frames'] }) => void,
  ) {
    const w = await world(name);
    const opened = Date.now();
    const link = await open(w.doors.sessionLink, 'session link');
    await live(w.sessionId, 'tool_output', { toolUseId: 'toolu_1', output: TOOL_SECRET });
    await link.until((f) => f.type === 'tool_output', 'session link: the live tool_output (Tool output on)');
    const toolUse = link.frames.find((f) => f.type === 'tool_use');
    assert.ok(JSON.stringify(toolUse?.payload).includes(TOOL_SECRET), 'with Tool output on the stream sends the tool input');

    const written = await turnOff(w);
    await Promise.race([
      link.ended,
      new Promise((_, fail) => setTimeout(() => fail(new Error('session link: the stream did not end')), KEEPALIVE_MS + 5_000)),
    ]);
    const ended = Date.now() - written;
    const sinceOpen = Date.now() - opened;
    c.diagnostic(`session link: stream ended ${ended} ms after the write, ${sinceOpen} ms after it opened (ping every ${KEEPALIVE_MS} ms); frames before the end: ${link.frames.map((f) => f.type).join(',')}`);
    assert.equal(link.frames.some((f) => f.type === 'gone'), false, 'the stream ended with no gone frame: the link still opens the session');
    bound({ ended, sinceOpen, frames: link.frames });

    // The client reconnects from the last seq it had — before the tool call, here, to replay it under the new
    // projection — while the session goes on emitting tool output.
    const sinceSeq = 1;
    const again = await openStream(`${w.doors.sessionLink}?sinceSeq=${sinceSeq}`);
    held.push(again);
    assert.equal(again.status, 200, `the reconnect opened ${again.status}`);
    await again.until((f) => f.type === 'head', 'reconnect: the opening head');
    await again.until((f) => f.type === 'assistant', 'reconnect: the replayed reply');
    await live(w.sessionId, 'tool_output', { toolUseId: 'toolu_1', output: TOOL_SECRET });
    await live(w.sessionId, 'background_output', { shellId: 'bg_1', output: TOOL_SECRET });
    await live(w.sessionId, 'text_delta', { text: 'after' });
    await again.until((f) => f.type === 'text_delta', 'reconnect: the delta sent after the tool output');
    const types = again.frames.map((f) => f.type as string);
    assert.equal(types.includes('tool_output'), false, `reconnect: no tool_output (${types.join(',')})`);
    assert.equal(types.includes('background_output'), false, `reconnect: no background_output (${types.join(',')})`);
    assert.equal(again.texts.some((text) => text.includes(TOOL_SECRET)), false, 'reconnect: nothing only tool output carries');

    const page = ok(await call(b!, 'GET', `/api/shared/${w.shareToken}/events?after=${sinceSeq}&limit=50`), 'the paged read');
    const read = (page.json.events as Array<{ seq: number; type: string; payload: unknown }>).filter((e) => e.type === 'tool_use' || e.type === 'tool_result');
    const streamed = again.frames.filter((f) => f.type === 'tool_use' || f.type === 'tool_result');
    assert.equal(read.length, 2, 'the read shows the tool call');
    assert.deepEqual(
      streamed.map((f) => ({ seq: f.seq, type: f.type, payload: f.payload })),
      read.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload })),
      'reconnect: the tool_use/tool_result payloads are the paged read\'s',
    );
    assert.equal(JSON.stringify(read).includes(TOOL_SECRET), false, 'the read itself is redacted');
    c.diagnostic(`reconnect: frames ${types.join(',')}; tool payloads ${JSON.stringify(streamed.map((f) => f.payload))}`);
  }

  await t.test('(9) the session link stops including tool output: its stream ends with no gone frame, within 1 s', async (c) => {
    await narrowed(c, 'tool output off', async (w) => {
      const sent = Date.now();
      ok(await onB('PUT', `/sessions/${w.s}/share`, ownerLogin, { include: { toolOutput: false } }), 'turning Tool output off');
      return sent;
    }, ({ ended }) => assert.ok(ended <= WITHIN_MS, `the stream ended ${ended} ms after the write was sent`));
  });

  await t.test('(10) tool output turned off with no signal: the stream ends at the next ping, with no gone frame', async (c) => {
    await narrowed(c, 'tool output off unsignalled', async (w) => {
      // Behind every service's back: nothing publishes viewer.revoked.
      await sql.query(`UPDATE "share_link" SET "include" = '{"toolOutput": false}'::jsonb WHERE "session_id" = $1::uuid`, [w.sessionId]);
      return Date.now();
    }, ({ ended, sinceOpen, frames }) => {
      assert.ok(ended >= 1_500, `the stream ended ${ended} ms after the bare write: before its ping, with no signal`);
      assert.equal(frames.some((f) => f.type === 'ping'), false, 'the stream ended at its first ping instead of sending it');
      assert.ok(sinceOpen <= KEEPALIVE_MS + WITHIN_MS, `the stream ended ${sinceOpen} ms after it opened, past its first ping`);
    });
  });
});
