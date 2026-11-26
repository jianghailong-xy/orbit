/**
 * `GET /sessions/:id/guests/suggestions` (board docs/mocks/share-links/14-guest-suggestions), held against the
 * production apiserver over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty: the people the owner
 * invited before, to any of their sessions, newest invitation first — without whoever can already reply in this
 * session, with someone removed or who left, never another owner's guests, never a disabled account — and 404 on
 * someone else's session.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-suggestions.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('session guests: suggestions are the owner’s own past invitations, newest first, minus this session’s guests', {
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

  const person = async (label: string, disabled = false) => {
    const id = randomUUID();
    const email = `suggest-${label}-${RUN}@session-guests.invalid`;
    const name = `${label} ${RUN}`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x', ...(disabled ? { disabledAt: new Date() } : {}) } });
    return { id, email, name };
  };
  const owner = await person('owner');
  const other = await person('other-owner');
  const [alice, bob, cara, dan, erin] = await Promise.all([
    person('alice'), person('bob'), person('cara'), person('dan', true), person('erin'),
  ]);

  const runnerOf = async (ownerId: string) => {
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'suggest-runner', tokenHash: `suggest-${runnerId}`,
        status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `suggest ${RUN}`, enabled: true } });
    return { runnerId, workspaceId };
  };
  const session = async (ownerId: string, where: { runnerId: string; workspaceId: string }) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: where.workspaceId, assignedRunnerId: where.runnerId,
        title: 'suggest', prompt: 'suggest', provider: 'claude', providerBuiltin: true, model: 'claude-opus-4-1',
        permissionMode: 'auto', dispatchOrigin: SessionDispatchOrigin.USER, turnState: null, numTurns: 1,
        engineTurnActive: false, runtimeSessionId: randomUUID(), startedAt: new Date(),
      },
    });
    return id;
  };
  const mine = await runnerOf(owner.id);
  const theirs = await runnerOf(other.id);
  const first = await session(owner.id, mine);
  const second = await session(owner.id, mine);
  const foreign = await session(other.id, theirs);

  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9));
  const invited = (sessionId: string, ownerId: string, userId: string, day: number, removed?: 'REMOVED' | 'LEFT') =>
    db.sessionGuest.create({
      data: {
        id: randomUUID(), sessionId, ownerId, userId, addedAt: at(day),
        ...(removed ? { removedAt: at(day + 1), removedReason: removed } : {}),
      },
    });
  await invited(first, owner.id, cara.id, 1, 'LEFT'); // left: still suggested
  await invited(first, owner.id, alice.id, 2, 'REMOVED'); // removed from the first …
  await invited(second, owner.id, alice.id, 5); // … and live in the second, the newer invitation
  await invited(first, owner.id, bob.id, 3); // live in the first
  await invited(first, owner.id, dan.id, 4); // disabled since: never suggested
  await invited(foreign, other.id, erin.id, 6); // another owner's guest: never suggested to this one

  const jwtSecret = `suggest-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const ownerLogin = await jwt.signAsync({ sub: owner.id, email: owner.email });
  server = await startApiserver(url, jwtSecret);
  const suggestions = async (sessionId: string) => {
    const reply = await call(server!, 'GET', `/api/sessions/${sessionId}/guests/suggestions`, ownerLogin);
    assert.equal(reply.status, 200, reply.text);
    return (reply.json.people as { name: string; email: string; lastInvitedAt: string }[]);
  };

  assert.deepEqual(await suggestions(first), [
    { name: alice.name, email: alice.email, lastInvitedAt: at(5).toISOString() },
    { name: cara.name, email: cara.email, lastInvitedAt: at(1).toISOString() },
  ], 'Bob can already reply in the first; Alice, removed there, is suggested by her newest invitation');
  assert.deepEqual((await suggestions(second)).map((p) => p.email), [bob.email, cara.email], 'Alice is live in the second');

  const refused = await call(server, 'GET', `/api/sessions/${foreign}/guests/suggestions`, ownerLogin);
  assert.equal(refused.status, 404, 'someone else’s session is not found');
});
