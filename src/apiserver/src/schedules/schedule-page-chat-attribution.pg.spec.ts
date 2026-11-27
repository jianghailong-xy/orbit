/**
 * Attribution of a change made from the Scheduled page's chat (docs/scheduled-chat-design.md §4.4), against a real
 * database:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-page-chat-attribution.pg.spec.ts
 *
 *   * a session with `schedule_chat_at` speaks for the person for ANY of the owner's schedules: an in-envelope change
 *     applies as `USER`, linked to the chat, with `askedText` the person's words of the turn that made the call — the
 *     turn IN_FLIGHT, not a second message queued behind it or a steer sent while it runs;
 *   * a turn of nobody's words in flight (a wake) speaks with the person's last message before it;
 *   * it is still judged as a session (scheduled-tasks-design §4): a widening returns PENDING with a card asked by
 *     `USER` in that turn's words, and nothing is applied;
 *   * an ordinary session of the same account is still a SESSION with no words.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SchedulesService, type ScheduleActor } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

let db: PrismaClient;
let pg: Client;
let service: SchedulesService;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  service = new SchedulesService(db as unknown as PrismaService, () => new Date('2026-11-27T08:00:00Z'));
});

after(async () => {
  if (skip) return;
  await db.$disconnect();
  await pg.end();
});

async function world(label: string) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-page-chat-attribution.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true } });
  const owner: ScheduleActor = { kind: 'OWNER', ownerId };
  const create = async (title: string) => {
    const result = await service.create(owner, {
      workspaceId,
      intent: 'Check the latest stable Codex release every day at 10:00',
      title,
      prompt: 'Check the latest stable Codex release against the pinned version.',
      rule: { kind: 'DAILY', time: '10:00' },
      timezone: 'Asia/Shanghai',
      accessLevel: 'CHECK_ONLY',
    });
    assert.equal(result.outcome, 'CREATED');
    if (result.outcome !== 'CREATED') throw new Error('not created');
    return result.schedule;
  };
  return { ownerId, workspaceId, owner, create };
}

type Turn = { content: string; status: 'ANSWERED' | 'IN_FLIGHT' | 'PENDING'; wake?: boolean; steer?: boolean };

/** A session of `w`'s workspace with `turns` in order; a page chat unless `pageChat` is false. */
async function session(
  w: { ownerId: string; workspaceId: string },
  turns: Turn[],
  pageChat = true,
): Promise<ScheduleActor & { sessionId: string }> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'Scheduled', prompt: turns[0]?.content ?? '',
      provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      permissionMode: PermissionMode.DEFAULT, runSource: SessionRunSource.MANUAL,
      ...(pageChat ? { scheduleChatAt: new Date() } : {}),
    },
  });
  let seq = 0;
  let inFlight: string | null = null;
  for (const t of turns) {
    seq += 1;
    const row: { id: string } = await db.conversationTurn.create({
      data: {
        sessionId: id,
        seq,
        clientTurnId: t.wake ? `bg-wake:${randomUUID()}` : `t-${seq}`,
        kind: t.steer ? 'steer' : 'message',
        ...(t.steer && inFlight ? { sendIntent: 'CURRENT_WORK', targetTurnId: inFlight } : {}),
        content: t.content,
        status: t.status,
        byPerson: !t.wake,
      },
    });
    if (t.status === 'IN_FLIGHT' && !t.steer) inFlight = row.id;
  }
  return { kind: 'SESSION', ownerId: w.ownerId, sessionId: id };
}

test('§4.4 an in-envelope change from the page chat is the person\'s, in the words of the turn that made it, for any schedule', { skip }, async () => {
  const w = await world('words');
  const a = await w.create('Codex stable check');
  const b = await w.create('Docs link check');
  const chat = await session(w, [
    { content: 'What runs tomorrow?', status: 'ANSWERED' },
    { content: 'Move both checks to 09:00', status: 'IN_FLIGHT' },
    { content: 'and only on weekdays', status: 'IN_FLIGHT', steer: true },
    { content: 'Also pause the docs check', status: 'PENDING' },
  ]);

  for (const s of [a, b]) {
    const applied = await service.update(chat, s.id, { rule: { kind: 'DAILY', time: '09:00' } });
    assert.equal(applied.outcome, 'APPLIED');
    const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id, revision: 2 } });
    assert.equal(revision.changedBy, 'USER', 'the page chat speaks for the person for any of the owner\'s schedules');
    assert.equal(revision.sessionId, chat.sessionId, 'the history links the conversation');
    assert.equal(revision.askedText, 'Move both checks to 09:00', 'the delivering turn\'s words, not the steer or the queued message');
  }
});

test('§4.4 a wake turn in flight speaks with the person\'s last words before it, not a message queued after', { skip }, async () => {
  const w = await world('wake');
  const s = await w.create('Codex stable check');
  const chat = await session(w, [
    { content: 'Make it weekly on Monday once the job is done', status: 'ANSWERED' },
    { content: 'job done', status: 'IN_FLIGHT', wake: true },
    { content: 'Actually, leave it daily', status: 'PENDING' },
  ]);

  const applied = await service.update(chat, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(applied.outcome, 'APPLIED');
  const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id, revision: 2 } });
  assert.equal(revision.changedBy, 'USER');
  assert.equal(revision.askedText, 'Make it weekly on Monday once the job is done');
});

test('§4 the page chat is still judged as a session: a widening returns PENDING with a card, and nothing is applied', { skip }, async () => {
  const w = await world('widen');
  const s = await w.create('Codex stable check');
  const chat = await session(w, [
    { content: 'Give it an hour each run', status: 'IN_FLIGHT' },
    { content: 'and run it twice a day', status: 'PENDING' },
  ]);

  const asked = await service.update(chat, s.id, { runLimitMinutes: 60 });
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  assert.equal(asked.request.kind, 'UPDATE');
  assert.equal(asked.request.state, 'PENDING');
  assert.equal(asked.request.askedBy, 'USER');
  assert.equal(asked.request.askedBySessionId, chat.sessionId);
  assert.equal(asked.request.askedText, 'Give it an hour each run');

  const after = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(after.revision, 1, 'nothing applied');
  assert.equal(after.runLimitMinutes, 30);
  assert.equal(after.envelopeRunLimitMinutes, 30);
  assert.equal(await db.scheduleRevision.count({ where: { scheduleId: s.id, revision: { gt: 1 } } }), 0);
});

test('an ordinary session of the same account is still a SESSION, with no words', { skip }, async () => {
  const w = await world('ordinary');
  const s = await w.create('Codex stable check');
  const plain = await session(w, [{ content: 'Move it to 09:00', status: 'IN_FLIGHT' }], false);

  const applied = await service.update(plain, s.id, { rule: { kind: 'DAILY', time: '09:00' } });
  assert.equal(applied.outcome, 'APPLIED');
  const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id, revision: 2 } });
  assert.equal(revision.changedBy, 'SESSION');
  assert.equal(revision.askedText, null);
});
