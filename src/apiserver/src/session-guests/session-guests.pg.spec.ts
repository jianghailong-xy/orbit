/**
 * Session guests, the server core (docs/session-guests-design.md §3–§7, task G1), held against the production
 * apiserver — `build/main.js`, the whole AppModule behind JwtAuthGuard — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   (1) the owner invites an account by email; the guest posts a turn through `POST /guest-sessions/:id/turns`; the
 *       conversation_turn row has external sender ORBIT_GUEST with the guest's name, the session row's
 *       last_user_from_external_* names the guest, one `session.guest.turn` activity row is written, and the guest's
 *       `GET /guest-sessions` lists the session;
 *   (2) a guest turn to an ended session resumes it, and its permission mode, model and provider stay as they were.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests.pg.spec.ts
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
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { GUEST_NO_ACCOUNT, GUEST_SESSION_NOT_SHARED, GUEST_TURN_ACTIVITY } from './session-guests.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('session guests: invite by email, a guest turn as ORBIT_GUEST, Shared with me, and resume of an ended session', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
  });

  // The owner, with a runner online and a workspace; the guest; and a third account nobody invited.
  const person = async (label: string) => {
    const id = randomUUID();
    const email = `guests-${label}-${RUN}-${id}@session-guests.invalid`;
    await db.user.create({ data: { id, email, name: `${label[0]!.toUpperCase()}${label.slice(1)} ${RUN}`, passwordHash: 'x' } });
    return { id, email, name: `${label[0]!.toUpperCase()}${label.slice(1)} ${RUN}` };
  };
  const owner = await person('owner');
  const guest = await person('alice');
  const stranger = await person('stranger');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'guests-runner', tokenHash: `guests-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: `guests ${RUN}`, enabled: true } });

  /** A session of the owner's that has run a turn: waiting for its next message, or ended. */
  const session = async (title: string, status: RunStatus) => {
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

  const jwtSecret = `session-guests-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const loginOf = (p: { id: string; email: string }) => jwt.signAsync({ sub: p.id, email: p.email });
  const [ownerLogin, guestLogin, strangerLogin] = await Promise.all([loginOf(owner), loginOf(guest), loginOf(stranger)]);
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };
  const turnRow = (sessionId: string, clientTurnId: string) => db.conversationTurn.findUniqueOrThrow({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
    select: { id: true, kind: true, content: true, externalSenderSource: true, externalSenderId: true, externalSenderName: true },
  });

  await t.test('(1) the owner invites by email; the guest turn is ORBIT_GUEST with the guest name, on the turn and the row; Shared with me lists it', async () => {
    const sessionId = await session('a live conversation', RunStatus.AWAITING_INPUT);

    // An email no account uses is refused, and nothing is written.
    const unknown = await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: `nobody-${RUN}@session-guests.invalid` });
    assert.equal(unknown.status, 404, unknown.text);
    assert.equal(unknown.json.message, GUEST_NO_ACCOUNT);
    // Nor can the owner invite themselves.
    const self = await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: owner.email });
    assert.equal(self.status, 400, self.text);
    assert.equal(await db.sessionGuest.count({ where: { sessionId } }), 0, 'a refused invitation writes nothing');

    // Before the invitation the guest door is the one 404.
    const before = await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, { clientTurnId: randomUUID(), content: 'hi' });
    assert.equal(before.status, 404, before.text);
    assert.equal(before.json.message, GUEST_SESSION_NOT_SHARED);

    // The email is matched as the account signs in with it, whatever its case.
    const invited = ok(await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: guest.email.toUpperCase() }), 'inviting');
    assert.deepEqual(invited.json.guests.map((g: { name: string }) => g.name), [guest.name]);
    assert.equal(invited.json.guests[0].opened, false);
    // Inviting again changes nothing.
    ok(await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: guest.email }), 'inviting again');
    assert.equal(await db.sessionGuest.count({ where: { sessionId, removedAt: null } }), 1);

    // Shared with me, and the guest page.
    const shared = ok(await api('GET', '/guest-sessions', guestLogin), 'Shared with me');
    assert.deepEqual(shared.json.sessions.map((s: { id: string }) => toUuid(s.id)), [sessionId]);
    assert.equal(shared.json.sessions[0].title, 'a live conversation');
    assert.equal(shared.json.sessions[0].ownerName, owner.name);
    const page = ok(await api('GET', `/guest-sessions/${sessionId}`, guestLogin), 'the guest page');
    assert.equal(page.json.title, 'a live conversation');
    assert.equal(page.json.ownerName, owner.name);
    assert.ok(Array.isArray(page.json.events));
    assert.equal(page.json.waitingOnOwner, false, 'nothing waits on the owner yet');
    ok(await api('GET', `/guest-sessions/${sessionId}/events?after=0`, guestLogin), 'the guest page following');

    // A card pending for the owner: the guest page is told the agent waits on them, and nothing of what it asks.
    const card = await db.approval.create({
      data: { sessionId, toolName: 'Bash', input: { command: `secret-${RUN}` }, status: 'PENDING' },
      select: { id: true },
    });
    const waiting = ok(await api('GET', `/guest-sessions/${sessionId}/events?after=0`, guestLogin), 'following while it waits');
    assert.equal(waiting.json.waitingOnOwner, true);
    assert.ok(!waiting.text.includes(`secret-${RUN}`), 'what the card asks stays the owner’s');
    assert.equal(ok(await api('GET', `/guest-sessions/${sessionId}`, guestLogin), 'the guest page while it waits').json.waitingOnOwner, true);
    await db.approval.update({ where: { id: card.id }, data: { status: 'ALLOWED' } });
    assert.equal(ok(await api('GET', `/guest-sessions/${sessionId}/events?after=0`, guestLogin), 'following after the answer').json.waitingOnOwner, false);

    // The owner's list marks the session as having guests (the two-person icon).
    const listRow = async () => {
      const list = ok(await api('GET', `/sessions?workspaceId=${workspaceId}`, ownerLogin), "the owner's list");
      const rows: { id: string; hasGuests: boolean }[] = Array.isArray(list.json) ? list.json : list.json.items;
      return rows.find((r) => toUuid(r.id) === sessionId);
    };
    assert.equal((await listRow())?.hasGuests, true);

    // The stranger sees none of it.
    const strangerList = ok(await api('GET', '/guest-sessions', strangerLogin), "the stranger's Shared with me");
    assert.deepEqual(strangerList.json.sessions, []);
    const strangerPage = await api('GET', `/guest-sessions/${sessionId}`, strangerLogin);
    assert.equal(strangerPage.status, 404, strangerPage.text);
    assert.equal(strangerPage.json.message, GUEST_SESSION_NOT_SHARED);

    // The guest's message.
    const clientTurnId = randomUUID();
    const sent = ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, { clientTurnId, content: 'could you also check the tests?' }), 'the guest turn');
    assert.equal(sent.json.revived, false);
    assert.ok(!sent.text.includes(guest.id), "the answer never carries the guest's user id");

    const turn = await turnRow(sessionId, clientTurnId);
    assert.equal(turn.kind, 'message');
    assert.equal(turn.content, 'could you also check the tests?');
    assert.equal(turn.externalSenderSource, 'ORBIT_GUEST');
    assert.equal(turn.externalSenderName, guest.name);
    assert.equal(turn.externalSenderId, guest.id);

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, lastUserText: true, lastUserFromExternalSource: true, lastUserFromExternalName: true },
    });
    assert.equal(row.status, RunStatus.PENDING, 'the turn is queued as the owner’s would be');
    assert.equal(row.lastUserText, 'could you also check the tests?');
    assert.equal(row.lastUserFromExternalSource, 'ORBIT_GUEST');
    assert.equal(row.lastUserFromExternalName, guest.name);

    const activity = await db.activity.findMany({ where: { type: GUEST_TURN_ACTIVITY, actorId: owner.id } });
    assert.equal(activity.length, 1, 'one activity row per guest turn');
    assert.equal(activity[0]!.credentialKind, 'GUEST');
    assert.deepEqual(activity[0]!.payload, { sessionId, turnId: turn.id, guestUserId: guest.id });

    // A retry of the same key is the same turn, and writes nothing more.
    ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, { clientTurnId, content: 'could you also check the tests?' }), 'the retry');
    assert.equal(await db.activity.count({ where: { type: GUEST_TURN_ACTIVITY, actorId: owner.id } }), 1);

    // The owner's People list now counts it, and knows the guest opened the session.
    const people = ok(await api('GET', `/sessions/${sessionId}/guests`, ownerLogin), 'the People list');
    assert.equal(people.json.guests[0].messagesToday, 1);
    assert.equal(people.json.guests[0].opened, true);

    // Removed, the guest's door is the same 404 and Shared with me is empty.
    ok(await api('DELETE', `/sessions/${sessionId}/guests/${guest.id}`, ownerLogin), 'removing');
    const after = await api('GET', `/guest-sessions/${sessionId}`, guestLogin);
    assert.equal(after.status, 404, after.text);
    assert.equal(after.json.message, GUEST_SESSION_NOT_SHARED);
    assert.deepEqual(ok(await api('GET', '/guest-sessions', guestLogin), 'Shared with me after removal').json.sessions, []);
    assert.equal((await listRow())?.hasGuests, false, 'no guest left: no two-person icon');
  });

  await t.test('(2) a guest turn to an ended session resumes it, with its own permission mode, model and provider', async () => {
    const sessionId = await session('an ended conversation', RunStatus.CANCELLED);
    ok(await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: guest.email }), 'inviting');
    const before = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: { permissionMode: true, model: true, provider: true, providerBuiltin: true },
    });

    const clientTurnId = randomUUID();
    const sent = ok(await api('POST', `/guest-sessions/${sessionId}/turns`, guestLogin, { clientTurnId, content: 'one more thing' }), 'the guest turn');
    assert.equal(sent.json.revived, true, 'the ended session was revived, not refused');

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true, endReason: true, permissionMode: true, model: true, provider: true, providerBuiltin: true,
        lastUserFromExternalSource: true, lastUserFromExternalName: true,
      },
    });
    assert.equal(row.status, RunStatus.PENDING, 'resumed: waiting for its runner to pick the turn up');
    assert.equal(row.endReason, null);
    assert.deepEqual(
      { permissionMode: row.permissionMode, model: row.model, provider: row.provider, providerBuiltin: row.providerBuiltin },
      before,
      'the resume kept the session’s own mode, model and provider',
    );
    assert.equal(row.permissionMode, 'acceptEdits');
    assert.equal(row.model, 'claude-opus-4-1');
    assert.equal(row.lastUserFromExternalSource, 'ORBIT_GUEST');
    assert.equal(row.lastUserFromExternalName, guest.name);

    const turn = await turnRow(sessionId, clientTurnId);
    assert.equal(turn.externalSenderSource, 'ORBIT_GUEST');
    assert.equal(turn.externalSenderName, guest.name);
    assert.equal(await db.activity.count({ where: { type: GUEST_TURN_ACTIVITY, actorId: owner.id, payload: { path: ['sessionId'], equals: sessionId } } }), 1);
  });
});
