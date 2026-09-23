/**
 * The acceptance service is built with the sessions service, so starting a project can tell its
 * coordinator (`project-started.ts`).
 *
 * `ProjectAcceptanceService` takes `SessionsService` as `@Optional()`, so the specs that build it
 * from a client alone keep working. The cost of that is here: a module that stopped importing
 * SessionsModule would build the service without it, and every start would tell nobody — no
 * error, no failed request, just the stall the telling exists to end. So the wiring is asserted on
 * what Nest actually constructs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { ProjectAcceptanceModule } from './project-acceptance.module';
import { ProjectAcceptanceService } from './project-acceptance.service';

/** What the application root supplies through its @Global modules. Nothing here is called: the
 *  claim is about what Nest can construct. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: QueueService, useValue: {} },
    { provide: RealtimeService, useValue: { publishForUser: () => undefined } },
    { provide: JwtService, useValue: {} },
    { provide: ConfigService, useValue: { get: () => undefined } },
  ],
  exports: [PrismaService, QueueService, RealtimeService, JwtService, ConfigService],
})
class GlobalDoubles {}

@Module({ imports: [GlobalDoubles, ProjectAcceptanceModule] })
class WiringHarness {}

test('the acceptance service is built with the one sessions service the application has', async (t) => {
  const context = await NestFactory.createApplicationContext(WiringHarness, {
    logger: false,
    abortOnError: false,
  });
  t.after(() => context.close());

  const acceptance = context.get(ProjectAcceptanceService);
  const sessions = (acceptance as unknown as { sessions?: unknown }).sessions;
  assert.ok(sessions instanceof SessionsService,
    'ProjectAcceptanceModule built the service without SessionsService: starting a project would '
      + 'tell its coordinator nothing');
  assert.equal(sessions, context.get(SessionsService), 'and it is the same instance, not a second one');
});
