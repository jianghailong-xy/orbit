/**
 * A schedule's change conversation (docs/scheduled-tasks-design.md §8.2, owner 2026-11-19, board 03-change), against
 * a real database:
 *
 *   * a change it makes to its own schedule is the person's (`USER`), with the person's latest words as `askedText`
 *     — a wake turn is nobody's words; the same session changing another schedule is an ordinary SESSION;
 *   * it is still judged as a session (§4): a widening waits for the owner's Allow, and the revision the Allow writes
 *     keeps the words;
 *   * Change… reuses the schedule's open change conversation, never a completed one;
 *   * each message names the schedule as it is at delivery.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { appendScheduleChangeNote, openChangeConversation, scheduleChangeOpening } from './schedule-change-conversation';
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
  service = new SchedulesService(db as unknown as PrismaService, () => new Date('2026-11-19T08:00:00Z'));
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
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-change.invalid`, name: label, passwordHash: 'x' },
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
      intent: '每天北京时间 10 点检查 Codex 官方稳定版',
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

/** A change conversation of `scheduleId`, with the person's messages as its turns (and a wake turn last). */
async function changeConversation(
  w: { ownerId: string; workspaceId: string },
  scheduleId: string,
  words: string[],
  extra: { completedAt?: Date } = {},
): Promise<ScheduleActor & { sessionId: string }> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'Change', prompt: words[0] ?? '',
      provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      permissionMode: PermissionMode.DEFAULT, runSource: SessionRunSource.SCHEDULE_CHANGE, changeScheduleId: scheduleId,
      ...extra,
    },
  });
  let seq = 0;
  for (const content of words) {
    seq += 1;
    await db.conversationTurn.create({ data: { sessionId: id, seq, clientTurnId: `t-${seq}`, kind: 'message', content } });
  }
  await db.conversationTurn.create({
    data: { sessionId: id, seq: seq + 1, clientTurnId: `bg-wake:${randomUUID()}`, kind: 'message', content: 'job done' },
  });
  return { kind: 'SESSION', ownerId: w.ownerId, sessionId: id };
}

test('§8.2 a change from its own change conversation is the person\'s, in their latest words', { skip }, async () => {
  const w = await world('words');
  const s = await w.create('Codex stable check');
  const other = await w.create('Docs link check');
  const chat = await changeConversation(w, s.id, ['改成每周一次', '周一，时间不变']);

  const applied = await service.update(chat, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(applied.outcome, 'APPLIED');
  const mine = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id, revision: 2 } });
  assert.equal(mine.changedBy, 'USER');
  assert.equal(mine.sessionId, chat.sessionId);
  assert.equal(mine.askedText, '周一，时间不变', 'the latest of the person\'s messages, not the wake after it');

  // The same conversation changing another schedule is an ordinary session's change.
  await service.update(chat, other.id, { rule: { kind: 'DAILY', time: '11:00' } });
  const theirs = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: other.id, revision: 2 } });
  assert.equal(theirs.changedBy, 'SESSION');
  assert.equal(theirs.askedText, null);
});

test('§4 it is still judged as a session: a widening waits for Allow, and the revision Allow writes keeps the words', { skip }, async () => {
  const w = await world('widen');
  const s = await w.create('Codex stable check');
  const chat = await changeConversation(w, s.id, ['每次给它 1 小时']);

  const asked = await service.update(chat, s.id, { runLimitMinutes: 60 });
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  assert.equal(asked.request.askedBy, 'USER');
  assert.equal(asked.request.askedText, '每次给它 1 小时');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunLimitMinutes, 30);

  await service.decide(w.owner, asked.request.id, 'ALLOW');
  const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id, revision: 2 } });
  assert.equal(revision.changedBy, 'USER');
  assert.equal(revision.askedText, '每次给它 1 小时');
});

test('§8.2 Change… reuses the open change conversation, never a completed one', { skip }, async () => {
  const w = await world('reuse');
  const s = await w.create('Codex stable check');
  assert.equal(await openChangeConversation(db, w.ownerId, s.id), null);
  await changeConversation(w, s.id, ['old'], { completedAt: new Date() });
  assert.equal(await openChangeConversation(db, w.ownerId, s.id), null, 'a completed one is not reused');
  const open = await changeConversation(w, s.id, ['new']);
  assert.equal(await openChangeConversation(db, w.ownerId, s.id), open.sessionId);
  assert.equal(await openChangeConversation(db, randomUUID(), s.id), null, 'another account sees none');
});

test('§8.2 the opening and each message\'s note read the schedule as it is', { skip }, async () => {
  const w = await world('note');
  const s = await w.create('Codex stable check');
  const opening = await scheduleChangeOpening(db, await db.schedule.findUniqueOrThrow({ where: { id: s.id } }));
  assert.equal(opening.title, 'Codex stable check');
  assert.equal(opening.revision, 1);
  assert.equal(opening.when, 'Every day at 10:00 · Asia/Shanghai');
  assert.equal(opening.runsIn, 'note-ws');
  assert.equal(opening.costs, 'Up to 7 runs a week, 30 min each');

  const note = await appendScheduleChangeNote(db, { ownerId: w.ownerId, scheduleId: s.id }, 'make it 9');
  assert.ok(note!.startsWith('make it 9\n\n<orbit_schedule_change '), 'after the person\'s words');
  assert.ok(note!.includes(`schedule_id="${uuidToBase62(s.id)}"`));
  assert.equal(toUuid(uuidToBase62(s.id)), s.id);
  assert.ok(note!.includes('mcp__orbit__schedule_update'));
  assert.equal(await appendScheduleChangeNote(db, { ownerId: randomUUID(), scheduleId: s.id }, 'x'), 'x', 'not another account\'s');
});
