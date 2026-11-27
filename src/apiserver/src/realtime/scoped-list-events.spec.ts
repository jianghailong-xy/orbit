import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlEvent, ControlEventType, RunEventType, SCHEDULE_CARDS_CHANGED_MAX_SESSIONS } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SchedulesService } from '../schedules/schedules.service';
import { RealtimeService } from './realtime.service';
import { declaresScheduleCards } from './open-list-hints';

/**
 * The two payloads a web tab scopes its "Tasks created here" and schedule-card reads by (task 351uKarlHnsbndjGV4n7i):
 *
 * - `task.changed` names the sessions that created its rows (`creatorSessionIds`), so a session's page reads its
 *   created tasks again for a change to one of them and not for every task any session touches. Additive: the field
 *   is absent where the creators are not known for every row, and every older reader ignores it.
 * - `schedule_cards.changed` names the sessions whose schedule cards moved, and only a stream that declared
 *   `hints=schedule_cards` is sent it: a shipped client re-reads everything on a type it does not know.
 */

const OWNER = '00000000-0000-4000-8000-000000000001';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const T1 = '00000000-0000-4000-8000-0000000000b1';
const T2 = '00000000-0000-4000-8000-0000000000b2';
const T3 = '00000000-0000-4000-8000-0000000000b3';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const P1 = '00000000-0000-4000-8000-0000000000c1';

/** The task rows the creator read answers from, each with its creator session (and T1 and T2 in project P1); and how
 *  often it was asked. */
function service(tasks: Record<string, string | null>, reads = { n: 0 }): RealtimeService {
  const prisma = {
    $executeRawUnsafe: async () => 0,
    task: {
      findMany: async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) => {
        reads.n += 1;
        assert.equal(where.ownerId, OWNER, 'only the owner\'s rows are read');
        return where.id.in.filter((id) => id in tasks)
          .map((id) => ({ creatorSessionId: tasks[id], projectId: id === T3 ? null : P1 }));
      },
    },
  } as unknown as PrismaService;
  return new RealtimeService(prisma, { scheduleBadgeSync: () => undefined } as unknown as PushService);
}

async function heard(svc: RealtimeService, options: Parameters<RealtimeService['streamForUser']>[1], act: () => void): Promise<ControlEvent[]> {
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser(OWNER, options).subscribe((e) => got.push(e));
  act();
  await delay(30);
  sub.unsubscribe();
  return got;
}

test('a bounded task.changed names the sessions that created its rows and their projects, read once for every stream', async () => {
  const reads = { n: 0 };
  const svc = service({ [T1]: S1, [T2]: S1, [T3]: null }, reads);
  const got: ControlEvent[] = [];
  const subs = [svc.streamForUser(OWNER), svc.streamForUser(OWNER)].map((s) => s.subscribe((e) => got.push(e)));
  svc.publishForUser(OWNER, RunEventType.TASK_CHANGED, { taskIds: [T1, T2, T3], resync: false });
  await delay(30);
  for (const sub of subs) sub.unsubscribe();

  assert.equal(got.length, 2);
  for (const ev of got) {
    assert.equal(ev.type, ControlEventType.TASK_CHANGED);
    assert.equal(ev.sessionId, '');
    assert.deepEqual(ev.data, { taskId: T1, taskIds: [T1, T2, T3], resync: false, creatorSessionIds: [S1], rowProjectIds: [P1] });
  }
  assert.notEqual(got[0].data, got[1].data, 'each stream is sent its own copy');
  assert.equal(reads.n, 1, 'one read per event, not per stream');
});

test('task.changed says nothing of creators for a resync, or when a row it names is not found', async () => {
  const svc = service({ [T1]: S1 });
  const got = await heard(svc, {}, () => {
    svc.publishForUser(OWNER, RunEventType.TASK_CHANGED, { taskIds: [], resync: true });
    svc.publishForUser(OWNER, RunEventType.TASK_CHANGED, { taskIds: [T1, T2], resync: false });
  });
  assert.deepEqual(got.map((ev) => ev.data), [
    { taskIds: [], resync: true },
    { taskId: T1, taskIds: [T1, T2], resync: false },
  ]);
});

test('a session-keyed task.changed is bounded only when it names its rows, and then names their creators', async () => {
  const reads = { n: 0 };
  const svc = service({ [T1]: S2 }, reads);
  (svc as unknown as { resolveOwner: () => Promise<unknown> }).resolveOwner = async () => ({ ownerId: OWNER, workspaceId: null });
  const got = await heard(svc, {}, () => {
    // The compatibility helper's scalar id is a resync (taskChangedData), and stays one.
    svc.publishTaskChanged(S1, T1);
    svc.publish(S1, { seq: 0, type: RunEventType.TASK_CHANGED, ts: new Date().toISOString(), payload: { taskIds: [T1], resync: false } });
  });
  assert.deepEqual(got.map((ev) => ev.data), [
    { taskId: T1, taskIds: [], resync: true },
    { taskId: T1, taskIds: [T1], resync: false, creatorSessionIds: [S2], rowProjectIds: [P1] },
  ]);
  assert.equal(reads.n, 1);
});

test('schedule_cards.changed reaches only a stream that declared hints=schedule_cards', async () => {
  const svc = service({});
  const declared: ControlEvent[] = [];
  const undeclared: ControlEvent[] = [];
  const subs = [
    svc.streamForUser(OWNER, { scheduleCards: true }).subscribe((e) => declared.push(e)),
    svc.streamForUser(OWNER, { listChanged: true }).subscribe((e) => undeclared.push(e)),
    svc.streamForUser(OWNER).subscribe((e) => undeclared.push(e)),
    svc.streamForUser('00000000-0000-4000-8000-00000000ffff', { scheduleCards: true }).subscribe((e) => undeclared.push(e)),
  ];
  svc.publishScheduleCardsChanged(OWNER, [S1, null, S2, S1, '']);
  await delay(30);
  for (const sub of subs) sub.unsubscribe();

  assert.equal(undeclared.length, 0, 'a shipped client, and another owner, hear nothing');
  assert.equal(declared.length, 1);
  assert.equal(declared[0].type, ControlEventType.SCHEDULE_CARDS_CHANGED);
  assert.equal(declared[0].type, 'schedule_cards.changed');
  assert.equal(declared[0].sessionId, '');
  assert.deepEqual(declared[0].data, { cardSessionIds: [S1, S2], resync: false });
});

test('schedule_cards.changed past its bound is a resync, and one naming no session is not sent', async () => {
  const svc = service({});
  const many = Array.from({ length: SCHEDULE_CARDS_CHANGED_MAX_SESSIONS + 1 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const got = await heard(svc, { scheduleCards: true }, () => {
    svc.publishScheduleCardsChanged(OWNER, [null, undefined]);
    svc.publishScheduleCardsChanged(OWNER, many);
    svc.publishScheduleCardsChanged(OWNER, many.slice(0, SCHEDULE_CARDS_CHANGED_MAX_SESSIONS));
  });
  assert.deepEqual(got.map((ev) => (ev.data as { resync: boolean }).resync), [true, false]);
  assert.deepEqual((got[0].data as { cardSessionIds: string[] }).cardSessionIds, []);
  assert.equal((got[1].data as { cardSessionIds: string[] }).cardSessionIds.length, SCHEDULE_CARDS_CHANGED_MAX_SESSIONS);
});

test('the hints value declares schedule_cards beside the others', () => {
  assert.equal(declaresScheduleCards('list_changed,owner_requests,schedule_cards'), true);
  assert.equal(declaresScheduleCards(['list_changed', ' schedule_cards ']), true);
  assert.equal(declaresScheduleCards('list_changed,owner_requests'), false);
  assert.equal(declaresScheduleCards(undefined), false);
});

test('a schedule write announces the sessions whose cards or records name the schedule, and the ones it was given', async () => {
  const published: Array<{ ownerId: string; ids: ReadonlyArray<string | null | undefined> }> = [];
  const asked: unknown[] = [];
  const prisma = {
    scheduleChangeRequest: {
      findMany: async (args: unknown) => {
        asked.push(args);
        return [{ askedBySessionId: S1 }];
      },
    },
    scheduleRevision: {
      findMany: async (args: unknown) => {
        asked.push(args);
        return [{ sessionId: S2 }];
      },
    },
  } as unknown as PrismaService;
  const realtime = {
    markRunnerChanged: () => undefined,
    publishScheduleCardsChanged: (ownerId: string, ids: ReadonlyArray<string | null | undefined>) => published.push({ ownerId, ids }),
  };
  const schedules = new SchedulesService(prisma, undefined, undefined, realtime as never);
  const announce = (schedules as unknown as {
    announceCards: (ownerId: string, scheduleId: string | null, ids: Array<string | null>) => Promise<void>;
  }).announceCards.bind(schedules);

  await announce(OWNER, 'schedule-1', ['caller']);
  assert.deepEqual(published, [{ ownerId: OWNER, ids: ['caller', S1, S2] }]);
  assert.deepEqual(asked, [
    { where: { ownerId: OWNER, scheduleId: 'schedule-1', askedBySessionId: { not: null } }, select: { askedBySessionId: true }, distinct: ['askedBySessionId'] },
    { where: { scheduleId: 'schedule-1', sessionId: { not: null } }, select: { sessionId: true }, distinct: ['sessionId'] },
  ]);

  // A card that names no schedule yet (a create waiting on the owner): only the session that put it up, nothing read.
  await announce(OWNER, null, [S1]);
  assert.deepEqual(published[1], { ownerId: OWNER, ids: [S1] });
  assert.equal(asked.length, 2);

  // An older RealtimeService double without the method: nothing is announced, nothing fails.
  const quiet = new SchedulesService(prisma, undefined, undefined, { markRunnerChanged: () => undefined } as never);
  await (quiet as unknown as { announceCards: (o: string, s: string, i: string[]) => Promise<void> }).announceCards(OWNER, 'schedule-1', []);
  assert.equal(published.length, 2);
});

test('every schedule write announces the cards it moved, after its commit', () => {
  // The writes of SchedulesService that change a card, a change record or a schedule the cards draw. A write added
  // without its announcement leaves the cards to their safety read, a minute late.
  const source = readFileSync(join(__dirname, '../../src/schedules/schedules.service.ts'), 'utf8');
  for (const method of ['create', 'update', 'decide', 'pause', 'resume', 'end', 'remove', 'undo']) {
    const start = source.search(new RegExp(`\\n  async ${method}\\(`));
    assert.ok(start > 0, `${method} is a write of SchedulesService`);
    const next = source.indexOf('\n  async ', start + 1);
    const body = source.slice(start, next < 0 ? undefined : next);
    assert.match(body, /await this\.announceCards\(/, `${method} announces the schedule cards it moved`);
  }
});
