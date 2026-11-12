/**
 * Session guests, the guards (docs/session-guests-design.md §5–§6, task G1b), held against the production apiserver —
 * `build/main.js`, the whole AppModule behind JwtAuthGuard — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. One named case per refusal:
 *
 *   uninvited 404, removed 404, left 404, trashed 404   every guest route answers as a session that does not exist;
 *   kind refused, attachmentIds refused, intent refused  the turn body is a whitelist;
 *   override field <f> refused                           model, permissionMode, effort, provider, fastMode, engine,
 *                                                        account: none reaches a resume;
 *   51st message 429, two concurrent requests at 49      50 messages per guest per session per UTC day;
 *   queued turns withdrawn on remove / on leave          the guest's undelivered turns go with the invitation;
 *   PAT 403 on invite, PAT 403 on remove                 the owner channel.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-guards.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import {
  GUEST_DAILY_CAP_REACHED, GUEST_DAILY_TURNS, GUEST_SESSION_NOT_SHARED, guestFieldRefused,
} from './session-guests.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('session guests: guest door refusals, the daily cap and withdraw-on-remove', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
  });

  const person = async (label: string) => {
    const id = randomUUID();
    const email = `guards-${label}-${RUN}-${id}@session-guests.invalid`;
    const name = `${label[0]!.toUpperCase()}${label.slice(1)} ${RUN}`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, email, name };
  };
  const owner = await person('owner');
  const guest = await person('alice');
  const stranger = await person('stranger');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'guards-runner', tokenHash: `guards-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: `guards ${RUN}`, enabled: true } });

  /** A session of the owner's that has run a turn: waiting for its next message, or ended. */
  const session = async (title: string, status: RunStatus = RunStatus.AWAITING_INPUT) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, model: 'claude-opus-4-1', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER, status, numTurns: 1, engineTurnActive: false,
        runtimeSessionId: randomUUID(), startedAt: new Date(),
        ...(status === RunStatus.CANCELLED ? { finishedAt: new Date(), endReason: 'USER_ENDED' } : {}),
      },
    });
    return id;
  };

  const jwtSecret = `session-guests-guards-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const loginOf = (p: { id: string; email: string }) => jwt.signAsync({ sub: p.id, email: p.email });
  const [ownerLogin, guestLogin, strangerLogin] = await Promise.all([loginOf(owner), loginOf(guest), loginOf(stranger)]);
  const pats = new PatService(db as unknown as PrismaService);
  const ownerPat = (await pats.issue(owner.id, { name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };
  const invite = async (sessionId: string) =>
    ok(await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: guest.email }), 'inviting');
  const message = (content = 'hello') => ({ clientTurnId: randomUUID(), content });
  const guestTurns = (sessionId: string) =>
    db.conversationTurn.count({ where: { sessionId, externalSenderSource: 'ORBIT_GUEST', externalSenderId: guest.id } });

  /** Every guest route, knocked on as `bearer`: each must answer what a session that does not exist answers. */
  const doors = (sessionId: string) => [
    ['GET', `/guest-sessions/${sessionId}`, undefined],
    ['GET', `/guest-sessions/${sessionId}/events?after=0`, undefined],
    ['GET', `/guest-sessions/${sessionId}/events?before=10`, undefined],
    ['GET', `/guest-sessions/${sessionId}/events/1`, undefined],
    ['POST', `/guest-sessions/${sessionId}/turns`, message('are you there?')],
    ['DELETE', `/guest-sessions/${sessionId}/turns/${randomUUID()}`, undefined],
    ['POST', `/guest-sessions/${sessionId}/turns/${randomUUID()}/steer`, undefined],
    ['POST', `/guest-sessions/${sessionId}/leave`, undefined],
  ] as const;
  const assertAsIfAbsent = async (sessionId: string, bearer: string) => {
    const before = await db.conversationTurn.count({ where: { sessionId } });
    for (const [method, path, body] of doors(sessionId)) {
      const reply = await api(method, path, bearer, body);
      const absent = await api(method, path.replace(sessionId, randomUUID()), bearer, body);
      assert.equal(absent.status, 404, `${method} ${path} on no session: ${absent.text}`);
      assert.equal(reply.status, 404, `${method} ${path} answered ${reply.status}: ${reply.text}`);
      assert.equal(reply.json.message, GUEST_SESSION_NOT_SHARED, `${method} ${path}`);
      assert.deepEqual(reply.json, absent.json, `${method} ${path} answers exactly as a session that does not exist`);
    }
    assert.equal(await db.conversationTurn.count({ where: { sessionId } }), before, 'no door wrote a turn');
    const shared = ok(await api('GET', '/guest-sessions', bearer), 'Shared with me');
    assert.ok(!shared.text.includes(sessionId), 'the session is not in Shared with me');
  };

  // ── Same 404 for each: never invited, removed, left, Trash ─────────────────────────────────

  await t.test('uninvited 404: an account nobody invited meets a session that does not exist', async () => {
    const sessionId = await session('uninvited');
    await invite(sessionId); // someone is a guest of it; the stranger is not
    await assertAsIfAbsent(sessionId, strangerLogin);
  });

  await t.test('removed 404: a guest the owner removed meets a session that does not exist', async () => {
    const sessionId = await session('removed');
    await invite(sessionId);
    ok(await api('GET', `/guest-sessions/${sessionId}`, guestLogin), 'the guest page while invited');
    ok(await api('DELETE', `/sessions/${sessionId}/guests/${guest.id}`, ownerLogin), 'removing');
    await assertAsIfAbsent(sessionId, guestLogin);
  });

  await t.test('left 404: a guest who left meets a session that does not exist', async () => {
    const sessionId = await session('left');
    await invite(sessionId);
    ok(await api('POST', `/guest-sessions/${sessionId}/leave`, guestLogin), 'leaving');
    const row = await db.sessionGuest.findFirstOrThrow({ where: { sessionId, userId: guest.id } });
    assert.equal(row.removedReason, 'LEFT');
    await assertAsIfAbsent(sessionId, guestLogin);
  });

  await t.test('trashed 404: a live guest of a session in the Trash meets a session that does not exist', async () => {
    const sessionId = await session('trashed');
    await invite(sessionId);
    ok(await api('DELETE', `/sessions/${sessionId}`, ownerLogin), 'moving the session to the Trash');
    assert.ok((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).deletedAt, 'in the Trash');
    assert.equal(await db.sessionGuest.count({ where: { sessionId, removedAt: null } }), 1, 'the invitation itself is still live');
    await assertAsIfAbsent(sessionId, guestLogin);
  });

  // ── The turn body is a whitelist ───────────────────────────────────────────────────────────

  /** A refused body: 400 naming the field, and nothing written. Sent to an ended session, so a resume is what it would reach. */
  const refused = async (sessionId: string, extra: Record<string, unknown>, field: string) => {
    const before = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const reply = await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, { ...message('try this'), ...extra });
    assert.equal(reply.status, 400, `${JSON.stringify(extra)} answered ${reply.status}: ${reply.text}`);
    assert.equal(reply.json.message, guestFieldRefused(field));
    assert.equal(await guestTurns(sessionId), 0, 'no turn was written');
    const after = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.deepEqual(
      [after.status, after.permissionMode, after.model, after.provider, after.effort, after.fastMode],
      [before.status, before.permissionMode, before.model, before.provider, before.effort, before.fastMode],
      'the session is as it was',
    );
  };
  const ended = await session('body whitelist', RunStatus.CANCELLED);
  await invite(ended);
  const live = await session('body whitelist, live');
  await invite(live);

  await t.test('kind refused: a guest cannot send a shell turn', async () => {
    await refused(ended, { kind: 'shell', content: 'id' }, 'kind');
    await refused(live, { kind: 'shell', content: 'id' }, 'kind');
    await refused(live, { kind: 'message' }, 'kind');
  });

  await t.test('attachmentIds refused: a guest message is text only', async () => {
    await refused(ended, { attachmentIds: [randomUUID()] }, 'attachmentIds');
    await refused(live, { attachmentIds: [] }, 'attachmentIds');
  });

  await t.test('intent refused unless it is plain routing', async () => {
    await refused(live, { intent: 'CURRENT_WORK' }, 'intent');
    await refused(live, { intent: 'SHELL' }, 'intent');
    // Plain routing is taken: a message for the next turn.
    const sent = ok(await api('POST', `/guest-sessions/${live}/turns`, guestLogin, { ...message('queued'), intent: 'NEXT_TURN' }), 'NEXT_TURN');
    assert.equal(sent.json.kind, 'message');
  });

  const overrides: Record<string, unknown> = {
    model: 'claude-haiku-4-5', permissionMode: 'bypassPermissions', effort: 'max', provider: 'codex', fastMode: true,
    engine: 'codex', account: 'automatic',
  };
  for (const [field, value] of Object.entries(overrides)) {
    await t.test(`override field ${field} refused`, async () => {
      await refused(ended, { [field]: value }, field);
    });
  }

  // ── The daily cap ──────────────────────────────────────────────────────────────────────────

  const sendMany = async (sessionId: string, n: number) => {
    for (let i = 0; i < n; i++) ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message(`message ${i + 1}`)), `message ${i + 1}`);
  };
  const counter = (sessionId: string) =>
    db.sessionGuest.findFirstOrThrow({ where: { sessionId, userId: guest.id, removedAt: null }, select: { turnsOnDay: true, turnDay: true } });

  await t.test('51st message 429: 50 messages a guest may send to a session in a UTC day', async () => {
    assert.equal(GUEST_DAILY_TURNS, 50);
    const sessionId = await session('the cap');
    await invite(sessionId);
    await sendMany(sessionId, 50);
    assert.equal((await counter(sessionId)).turnsOnDay, 50);
    const fiftyFirst = await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message('the 51st'));
    assert.equal(fiftyFirst.status, 429, fiftyFirst.text);
    assert.equal(fiftyFirst.json.message, 'You’ve sent 50 messages to this session today, the most a guest can. Try again after midnight UTC.');
    assert.equal(fiftyFirst.json.message, GUEST_DAILY_CAP_REACHED);
    assert.equal(await guestTurns(sessionId), 50, 'the 51st wrote no turn');
    // Withdrawing one does not give it back: it was sent.
    const queued = await db.conversationTurn.findFirstOrThrow({
      where: { sessionId, externalSenderId: guest.id, status: 'PENDING' }, orderBy: { seq: 'desc' },
    });
    ok(await api('DELETE', `/guest-sessions/${sessionId}/turns/${queued.id}`, guestLogin), 'withdrawing one');
    assert.equal((await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message('after a withdrawal'))).status, 429);
    // A new UTC day starts the count again.
    await db.sessionGuest.updateMany({ where: { sessionId, userId: guest.id, removedAt: null }, data: { turnDay: new Date(Date.UTC(2000, 0, 1)) } });
    ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message('the next day')), 'the next day');
    assert.equal((await counter(sessionId)).turnsOnDay, 1);
  });

  await t.test('two concurrent requests at 49: only one of them passes', async () => {
    const sessionId = await session('the cap, raced');
    await invite(sessionId);
    await sendMany(sessionId, 49);
    const replies = await Promise.all([1, 2].map(() => api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message('the race'))));
    const statuses = replies.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s >= 200 && s < 300).length, 1, `exactly one passes: ${statuses.join(', ')} ${replies.map((r) => r.text).join(' | ')}`);
    assert.equal(statuses.filter((s) => s === 429).length, 1, `the other is the cap: ${statuses.join(', ')}`);
    assert.equal(await guestTurns(sessionId), 50, 'fifty turns, not fifty-one');
    assert.equal((await counter(sessionId)).turnsOnDay, 50);
  });

  // ── Withdraw on remove and on leave ─────────────────────────────────────────────────────────

  /** A session with two of the guest's messages queued, one of the guest's already delivered, and one of the owner's. */
  const queuedSession = async (title: string, withOwnerTurn: boolean) => {
    const sessionId = await session(title);
    await invite(sessionId);
    const delivered = toUuid(ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, message('delivered')), 'a delivered one').json.turnId);
    await db.conversationTurn.update({ where: { id: delivered }, data: { status: 'ANSWERED' } });
    await sendMany(sessionId, 2);
    const ownerTurn = withOwnerTurn
      ? toUuid(ok(await api('POST', `/sessions/${sessionId}/turns`, ownerLogin, message('the owner’s own')), 'the owner turn').json.turnId as string)
      : null;
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).status, RunStatus.PENDING);
    return { sessionId, ownerTurn };
  };
  const pendingOfGuest = (sessionId: string) =>
    db.conversationTurn.count({ where: { sessionId, externalSenderId: guest.id, status: 'PENDING' } });

  await t.test('queued turns withdrawn on remove', async () => {
    const { sessionId, ownerTurn } = await queuedSession('withdrawn on remove', true);
    assert.equal(await pendingOfGuest(sessionId), 2);
    ok(await api('DELETE', `/sessions/${sessionId}/guests/${guest.id}`, ownerLogin), 'removing');
    assert.equal(await pendingOfGuest(sessionId), 0, "the guest's queued turns are withdrawn");
    assert.equal(await guestTurns(sessionId), 1, 'the one already delivered stays');
    assert.ok(await db.conversationTurn.findUnique({ where: { id: ownerTurn! } }), "the owner's queued turn stays");
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).status, RunStatus.PENDING, 'still waiting for the owner’s');
  });

  await t.test('queued turns withdrawn on leave, and the session waits again', async () => {
    const { sessionId } = await queuedSession('withdrawn on leave', false);
    ok(await api('POST', `/guest-sessions/${sessionId}/leave`, guestLogin), 'leaving');
    assert.equal(await pendingOfGuest(sessionId), 0, "the guest's queued turns are withdrawn");
    assert.equal(await guestTurns(sessionId), 1, 'the one already delivered stays');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).status, RunStatus.AWAITING_INPUT, 'nothing left to run');
  });

  // ── The owner channel ──────────────────────────────────────────────────────────────────────

  await t.test('PAT 403 on invite', async () => {
    const sessionId = await session('PAT invite');
    const reply = await api('POST', `/sessions/${sessionId}/guests`, ownerPat, { email: guest.email });
    assert.equal(reply.status, 403, reply.text);
    assert.equal(await db.sessionGuest.count({ where: { sessionId } }), 0, 'nobody was invited');
  });

  await t.test('PAT 403 on remove', async () => {
    const sessionId = await session('PAT remove');
    await invite(sessionId);
    const reply = await api('DELETE', `/sessions/${sessionId}/guests/${guest.id}`, ownerPat);
    assert.equal(reply.status, 403, reply.text);
    assert.equal(await db.sessionGuest.count({ where: { sessionId, removedAt: null } }), 1, 'the guest is still invited');
  });
});
