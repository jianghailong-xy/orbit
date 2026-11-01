import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeModule } from './realtime.module';
import { ReaperService } from './reaper.service';

/**
 * The reaper tells an owner when a reap drops a one-shot wakeup with its FAILED session
 * (runner-api/wake-turn-withdraw.ts, docs/long-running-loop-contract.md §4) through the PushService it is
 * given, and that parameter is `@Optional()`, for the specs that build the reaper by hand about something
 * else. So nothing a type or a compile can see says production gives it one: a RealtimeModule that stopped
 * importing PushModule would boot a reaper that drops those wakeups in silence, and every spec that hands the
 * reaper a double would still pass. This builds the production module the way the application does and asks
 * the reaper it constructed which PushService it holds.
 */

/**
 * A database double that answers everything with nothing. Some providers of the module touch the database
 * as the context starts (RunnerPresenceService reports this process); none of what this file asks needs a
 * row back.
 */
const nothing: unknown = new Proxy(function nothing() {}, {
  get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : nothing),
  apply: async () => null,
});

/** Stand-ins for what the real application root supplies through its @Global modules. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: nothing },
    { provide: QueueService, useValue: {} },
    { provide: JwtService, useValue: {} },
    // The push sender reads its APNs and FCM credentials out of this on construction.
    { provide: ConfigService, useValue: { get: () => undefined } },
  ],
  exports: [PrismaService, QueueService, JwtService, ConfigService],
})
class GlobalDoubles {}

@Module({ imports: [GlobalDoubles, RealtimeModule] })
class WiringHarness {}

test('the reaper RealtimeModule builds holds the one PushService of the application', async (t) => {
  // RealtimeService's listener and ControlPlaneLeader connect to DATABASE_URL as the module starts: a port
  // nothing listens on, so they fail at once and stand down when the context closes.
  const databaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://wiring@127.0.0.1:9/nothing';
  const context = await NestFactory.createApplicationContext(WiringHarness, { logger: false, abortOnError: false });
  t.after(async () => {
    await context.close();
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
  });

  const push = context.get(PushService);
  assert.ok(push instanceof PushService, 'the module graph has no real PushService');
  const reaper = context.get(ReaperService);
  assert.ok(reaper instanceof ReaperService);
  assert.equal(
    (reaper as unknown as { push?: PushService }).push,
    push,
    'the reaper RealtimeModule builds was given no PushService, or another one than the application\'s',
  );
});
