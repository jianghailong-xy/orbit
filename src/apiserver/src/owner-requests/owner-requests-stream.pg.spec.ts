import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
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

/**
 * docs/realtime-control-plane-stream.md §4.9, against a real PostgreSQL: filing, answering,
 * withdrawing and expiring an owner request each reach a stream that declared
 * `hints=owner_requests` as `owner_requests.changed`; a session event unrelated to requests does
 * not carry it; and a stream that did not declare it is sent none.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const STEPS = { kind: 'MANUAL_STEP' as const, title: 'Sign in on the workstation', why: 'a device login', steps: [{ text: 'run it' }] };

test('an owner request change reaches a stream that declared owner_requests, and only that one', { skip }, async (t) => {
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
      provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, startedAt: new Date(),
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
  const settle = () => sleep(300);

  // An event unrelated to requests carries no signal.
  realtime.publishSessionUpdated(sessionId);
  await settle();
  assert.equal(count(declared), 0);

  const first = await service.file(ownerId, sessionId, STEPS);
  await settle();
  assert.equal(count(declared), 1, 'filing');

  await service.complete(ownerId, first.id, {});
  await settle();
  assert.equal(count(declared), 2, 'answering');

  const second = await service.file(ownerId, sessionId, { ...STEPS, title: 'Another' });
  await settle();
  assert.equal(count(declared), 3);
  await service.withdraw(ownerId, sessionId, second.id, 'no longer needed');
  await settle();
  assert.equal(count(declared), 4, 'withdrawing');

  const third = await service.file(ownerId, sessionId, { ...STEPS, title: 'A third' });
  await settle();
  assert.equal(count(declared), 5);
  await db.ownerRequest.update({ where: { id: third.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await service.expireDue(new Date());
  await settle();
  assert.equal(count(declared), 6, 'expiring');

  assert.deepEqual(declared.find((e) => e.type === ControlEventType.OWNER_REQUESTS_CHANGED)?.data, { id: 'owner_requests' });
  assert.equal(count(bundled), 6, 'a stream naming several hints still gets it');
  // A stream that did not declare it receives nothing new: the asking session's session.updated only.
  assert.equal(count(undeclared), 0);
  assert.ok(undeclared.some((e) => e.type === ControlEventType.SESSION_UPDATED));
});
