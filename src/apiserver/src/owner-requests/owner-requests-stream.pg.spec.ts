import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import { ControlEventType, type ControlEvent } from '@orbit/shared';
import { EventsController } from '../events/events.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';
import { closeUnknownItems, fileUnknownItem } from '../conditions/condition-attention';
import { fileStillWaitingItem } from '../conditions/condition-still-waiting';
import { closeScheduleItems, fileScheduleItem } from '../schedules/schedule-attention';

/**
 * docs/realtime-control-plane-stream.md §4.9, against a real PostgreSQL: filing, answering,
 * withdrawing and expiring an owner request each reach a stream that declared
 * `hints=owner_requests` as `owner_requests.changed`; a session event unrelated to requests does
 * not carry it; and a stream that did not declare it is sent none.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const STEPS = { kind: 'MANUAL_STEP' as const, title: 'Sign in on the workstation', why: 'a device login', steps: [{ text: 'run it' }] };

test('an owner request change reaches a stream that declared owner_requests, and only that one', { skip, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const prisma = db as unknown as PrismaService;
  const realtime = new RealtimeService(prisma, { scheduleBadgeSync: () => undefined } as unknown as PushService);
  t.after(() => realtime.onModuleDestroy());
  const service = new OwnerRequestsService(prisma, new OwnerSecretsService(prisma), undefined, undefined, realtime);

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `orst-${ownerId}@owner-requests-stream.invalid`, name: 'orst', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'orst-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'orst-workspace', enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'orst', prompt: 'orst',
      provider: 'claude', providerBuiltin: true, turnState: 'IN_FLIGHT', startedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });

  const events = new EventsController(realtime);
  const open = (hints?: string) => {
    const received: ControlEvent[] = [];
    const subscription = events.events({ userId: ownerId } as never, hints).subscribe((m: MessageEvent) => {
      const event = m.data as ControlEvent | { type: 'ping' };
      if (event.type !== 'ping') received.push(event as ControlEvent);
    });
    t.after(() => subscription.unsubscribe());
    return received;
  };
  const declared = open('owner_requests');
  const bundled = open('list_changed,owner_requests');
  const undeclared = open();
  const count = (stream: ControlEvent[]) => stream.filter((e) => e.type === ControlEventType.OWNER_REQUESTS_CHANGED).length;
  const settle = () => sleep(1_600);

  // The first hint is the baseline a client's connect read is answered against.
  await settle();
  assert.equal(count(declared), 1, 'a new stream is told the current version once');

  // An event unrelated to requests carries no signal.
  realtime.publishSessionUpdated(sessionId);
  await settle();
  assert.equal(count(declared), 1);
  let seen = 1;
  const moved = async (what: string) => {
    await settle();
    assert.equal(count(declared), ++seen, what);
  };

  const first = await service.file(ownerId, sessionId, STEPS);
  await moved('filing');
  await service.complete(ownerId, first.id, {});
  await moved('answering');
  const second = await service.file(ownerId, sessionId, { ...STEPS, title: 'Another' });
  await moved('filing again');
  await service.withdraw(ownerId, sessionId, second.id, 'no longer needed');
  await moved('withdrawing');
  const third = await service.file(ownerId, sessionId, { ...STEPS, title: 'A third' });
  await moved('filing a third');
  await db.ownerRequest.update({ where: { id: third.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await moved('a deadline set');
  await service.expireDue(new Date());
  await moved('expiring');

  // The writers that are not OwnerRequestsService: schedules and conditions file and close in their own transactions.
  const scheduleId = randomUUID();
  const scheduleItem = { kind: 'SCHEDULE_FAILED' as const, ownerId, askedBySessionId: sessionId, scheduleId, key: `k-${scheduleId}`, title: 't', why: 'w' };
  await db.$transaction((tx) => fileScheduleItem(tx, scheduleItem));
  await moved('a schedule item filed');
  await db.$transaction((tx) => closeScheduleItems(tx, { scheduleId, kinds: ['SCHEDULE_FAILED'] }, { state: 'WITHDRAWN', note: 'n', now: new Date() }));
  await moved('a schedule item closed');
  const conditionId = randomUUID();
  const conditionItem = { ownerId, askedBySessionId: sessionId, conditionId, workspaceId, key: `c-${conditionId}`, title: 't', why: 'w' };
  await db.$transaction((tx) => fileUnknownItem(tx, conditionItem));
  await moved('a condition item filed');
  await db.$transaction((tx) => closeUnknownItems(tx, conditionId, new Date()));
  await moved('a condition item closed');
  await db.$transaction((tx) => fileStillWaitingItem(tx, { ...conditionItem, key: `s-${conditionId}` }));
  await moved('a still-waiting question filed');

  // Nothing moved: nothing more is sent, and every declared stream agrees.
  await settle();
  assert.equal(count(declared), seen);
  assert.equal(count(bundled), seen, 'a stream naming several hints still gets it');
  assert.equal(typeof (declared[0].data as { version?: unknown }).version, 'string');
  // A stream that did not declare it receives nothing new: the asking session's session.updated only.
  assert.equal(count(undeclared), 0);
});
