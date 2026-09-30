import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';

/**
 * Retry re-sends a message with the ids of the files it went out with.
 *
 * The incident: a message with a screenshot in it hit a 429, the run ended FAILED, and "Retry now"
 * posted the same words with the same attachment id. That id was already on the turn that failed,
 * and a send could only link a file no turn had yet — so every Retry of a message with a file in it
 * was refused ("one or more attachments are unknown, not yours, or already attached") and the words
 * came back into the composer without the picture.
 *
 * Driven through `SessionsService.resume` and `.createTurn`, which is what the Retry of a failed
 * and of a live session reach, against a real PostgreSQL: the copy is one INSERT ... SELECT, and
 * only a real server says whether it lands.
 *
 * Destructive: it seeds rows, so it runs only against the disposable servers
 * `scripts/run-pg-spec.sh` and `scripts/project-pg-matrix.sh` provision.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique, and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

interface Services {
  db: PrismaClient;
  sessions: SessionsService;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  return {
    db,
    sessions: new SessionsService(
      db as unknown as PrismaService,
      { notifySessionQueued: () => undefined } as unknown as QueueService,
      publishes,
    ),
  };
}

interface Fixture {
  ownerId: string;
  sessionId: string;
  /** The turn the message first went out on — the one the provider could not answer. */
  firstTurnId: string;
  /** The screenshot sent with it, linked to that turn. */
  screenshot: string;
}

async function fixture(db: PrismaClient, label: string, status: RunStatus): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@resend.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  // A run that actually ran — resume refuses one that never started — and ended on the failure.
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: label,
      prompt: 'what is wrong here?',
      provider: 'claude',
      providerBuiltin: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      numTurns: 1,
      engineTurnActive: false,
      runtimeSessionId: randomUUID(),
      startedAt: new Date(),
      status,
      ...(status === RunStatus.FAILED ? { finishedAt: new Date() } : {}),
    },
  });
  const first = await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: `initial-${sessionId}`,
      kind: 'message',
      content: 'what is wrong here?',
      status: 'ANSWERED',
    },
  });
  const screenshot = await db.attachment.create({
    data: {
      ownerId,
      sessionId,
      turnId: first.id,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      fileName: 'error.png',
      data: PNG,
    },
  });
  return { ownerId, sessionId, firstTurnId: first.id, screenshot: screenshot.id };
}

async function filesOf(db: PrismaClient, turnId: string) {
  return db.attachment.findMany({
    where: { turnId },
    select: { id: true, sessionId: true, mimeType: true, sizeBytes: true, fileName: true, data: true },
  });
}

test('Retry of a failed run carries its screenshot, as a copy on the new turn',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'resend-failed', RunStatus.FAILED);
      const retry = {
        clientTurnId: randomUUID(),
        content: 'what is wrong here?',
        attachmentIds: [f.screenshot],
      };

      const sent = await sessions.resume(f.ownerId, f.sessionId, retry) as { turnId: string };

      const [copy, ...more] = await filesOf(db, sent.turnId);
      assert.equal(more.length, 0, 'the new turn carries the one file its message was sent with');
      assert.notEqual(copy.id, f.screenshot, 'a copy, not the original moved');
      assert.deepEqual(
        { ...copy, id: undefined, data: Buffer.from(copy.data) },
        {
          id: undefined,
          sessionId: f.sessionId,
          mimeType: 'image/png',
          sizeBytes: PNG.length,
          fileName: 'error.png',
          data: PNG,
        },
      );
      assert.deepEqual(
        (await filesOf(db, f.firstTurnId)).map((file) => file.id),
        [f.screenshot],
        'the bubble the message was first sent in keeps its picture',
      );

      // The response was lost and the client posts the same send again — after the retry has
      // failed too, so the replay meets a terminal run as the first press did.
      await db.session.update({
        where: { id: f.sessionId },
        data: { status: RunStatus.FAILED, finishedAt: new Date() },
      });
      const replayed = await sessions.resume(f.ownerId, f.sessionId, retry) as { turnId: string };
      assert.equal(replayed.turnId, sent.turnId, 'the replay is answered with the turn it queued');
      assert.equal(
        await db.attachment.count({ where: { sessionId: f.sessionId } }),
        2,
        'and copies nothing again',
      );
    } finally {
      await db.$disconnect();
    }
  });

test('Retry of a live session carries its screenshot the same way',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const f = await fixture(db, 'resend-live', RunStatus.AWAITING_INPUT);
      const retry = {
        clientTurnId: randomUUID(),
        content: 'what is wrong here?',
        attachmentIds: [f.screenshot],
      };

      const sent = await sessions.createTurn(f.ownerId, f.sessionId, retry);
      const [copy] = await filesOf(db, sent.turnId);
      assert.ok(copy && copy.id !== f.screenshot, 'the new turn carries a copy of the screenshot');

      const replayed = await sessions.createTurn(f.ownerId, f.sessionId, retry);
      assert.equal(replayed.turnId, sent.turnId);
      assert.equal(await db.attachment.count({ where: { sessionId: f.sessionId } }), 2);
    } finally {
      await db.$disconnect();
    }
  });

test('a file of another session is still refused, and nothing is written',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const { db, sessions } = connect();
    try {
      const mine = await fixture(db, 'resend-mine', RunStatus.AWAITING_INPUT);
      const theirs = await fixture(db, 'resend-theirs', RunStatus.AWAITING_INPUT);

      await assert.rejects(
        sessions.createTurn(mine.ownerId, mine.sessionId, {
          clientTurnId: randomUUID(),
          content: 'look at this',
          attachmentIds: [theirs.screenshot],
        }),
        (error: unknown) => error instanceof BadRequestException
          && /attachments are unknown or not yours/.test(error.message),
      );
      assert.equal(await db.conversationTurn.count({ where: { sessionId: mine.sessionId } }), 1);
      assert.equal(await db.attachment.count({ where: { sessionId: mine.sessionId } }), 1);
    } finally {
      await db.$disconnect();
    }
  });
