import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { ProjectPromotionService } from '../projects/project-promotion.service';
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

// The promotion service lives in ProjectsModule, which imports the router's module: a module that
// provides it apart from the router stands in for that one here.
@Module({ providers: [ProjectPromotionService], exports: [ProjectPromotionService] })
class PromotionsElsewhere {}

@Module({ imports: [GlobalDoubles, CoordinatorJudgmentModule, PromotionsElsewhere] })
class PromotionWiringHarness {}

// §12.15 P-M1, M-F1: the finish that decides a deferred landing asks for the promotion candidate again
// through the router, which finds the service by ModuleRef at the call (a value import closes a file
// ring through ProjectFuseService). The lookup's failure is only logged, so this shows it resolves.
test('CompletionInputRouter finds the one ProjectPromotionService of the module graph after settled work', async (t) => {
  const context = await NestFactory.createApplicationContext(PromotionWiringHarness, { logger: false, abortOnError: false });
  t.after(() => context.close());

  const promotions = context.get(ProjectPromotionService, { strict: false });
  const considered: string[] = [];
  promotions.considerCandidate = async (projectId) => { considered.push(projectId); return null; };

  const router = context.get(CompletionInputRouter, { strict: false });
  const warnings: string[] = [];
  (router as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m) => { warnings.push(m); };

  await router.considerPromotionAfterSettledWork(['project-1', null, 'project-1']);

  assert.deepEqual(warnings, [], 'the lookup failed and was only logged');
  assert.deepEqual(considered, ['project-1'], 'the service the module graph holds was not the one asked, once per project');
});
