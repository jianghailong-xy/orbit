import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';

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

@Module({ imports: [GlobalDoubles, CoordinatorJudgmentModule] })
class WiringHarness {}

// §12.15 P-M1: the end of a session that never ran re-derives the project's facts through a router that
// SessionsService may not import (a file cycle) and finds by ModuleRef at the call. A lookup that fails
// is only logged, so this is the one place that shows it resolves in the real module graph.
test('SessionsService finds the one CompletionInputRouter of the real module graph and reaches routeSettledWork', async (t) => {
  const context = await NestFactory.createApplicationContext(WiringHarness, { logger: false, abortOnError: false });
  t.after(() => context.close());

  const router = context.get(CompletionInputRouter);
  const reached: unknown[] = [];
  router.routeSettledWork = async (projectIds) => { reached.push(projectIds); };

  const sessions = context.get(SessionsService, { strict: false });
  const warnings: string[] = [];
  (sessions as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m) => { warnings.push(m); };

  await sessions.routeSettledFacts('project-1');

  assert.deepEqual(warnings, [], 'the lookup failed and was only logged');
  assert.deepEqual(reached, [['project-1']], 'the router the module graph holds was not the one reached');
});
