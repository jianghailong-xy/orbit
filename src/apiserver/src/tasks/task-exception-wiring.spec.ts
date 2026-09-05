import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import type { WakeFact } from '../projects/coordinator-wake';
import type {
  CoordinatorWakeService,
  WakeAuthorizer,
} from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * The gate an exception fact may not be delivered without, asserted as wiring rather than prose.
 *
 * `CompletionInputRouter.route`'s fourth parameter has a default that allows every committed input.
 * Nothing about a type, a module graph or `tsc` can tell a call site that passed an authorizer from
 * one that let the default stand in — they compile identically — which is the same shape the plug
 * that was never plugged in had. So the claim is made here over the OBJECT the router hands the
 * wake ledger, and again in `task-exception-delivery.pg.spec.ts` over what the ledger row says
 * afterwards.
 */

const ROUTER_SOURCE = path.resolve(
  __dirname, '../../src/projects/completion-input-router.service.ts',
);

/** A fake ledger: it records the authorizer each delivery was given, and refuses every claim. */
function recordingWakes(): { wakes: CoordinatorWakeService; given: (WakeAuthorizer | undefined)[] } {
  const given: (WakeAuthorizer | undefined)[] = [];
  const wakes = {
    claim: async (_fact: WakeFact, authorize: WakeAuthorizer) => {
      given.push(authorize);
      return { outcome: 'ALREADY_AWAKE' as const, idempotencyKey: 'recorded' };
    },
  } as unknown as CoordinatorWakeService;
  return { wakes, given };
}

const FACT: WakeFact = {
  event: 'ATTEMPT_ENDED_UNSETTLED',
  projectId: '10000000-0000-4000-8000-000000000001',
  subjectType: 'TASK',
  subjectId: '10000000-0000-4000-8000-000000000002',
  subjectVersion: '10000000-0000-4000-8000-000000000003',
};

function routerOver(
  wakes: CoordinatorWakeService,
  exceptions: TaskExceptionInputProducer,
): CompletionInputRouter {
  return new CompletionInputRouter(
    wakes,
    { afterCommit: () => { throw new Error('not this door'); } } as unknown as ProjectTasksSettledProducer,
    exceptions,
    { factsFor: () => { throw new Error('not this door'); } } as unknown as CriterionReadyProducer,
  );
}

test('the exception door hands the ledger its producer\'s authorizer, not the router\'s default',
  async () => {
    const { wakes, given } = recordingWakes();
    const authorize: WakeAuthorizer = async () => ({ allowed: false, refusalCode: 'MINE' });
    const exceptions = {
      factsFor: async () => [FACT],
      authorize,
    } as unknown as TaskExceptionInputProducer;

    const delivered = await routerOver(wakes, exceptions).routeTaskExceptions([FACT.subjectId]);

    assert.deepEqual(delivered, [{
      taskId: FACT.subjectId,
      event: 'ATTEMPT_ENDED_UNSETTLED',
      outcome: 'ALREADY_AWAKE',
    }]);
    assert.equal(given.length, 1, 'the exception door delivered nothing to the ledger');
    assert.equal(
      given[0], authorize,
      'the exception delivery let route()\'s always-allow default stand in for an authorizer',
    );
  });

/**
 * The other half: the door that DOES eat the default still does, and what it eats really allows
 * everything. Without this the assertion above would hold over a router with no default at all.
 */
test('the evidence door still takes the default, and the default allows every committed input',
  async () => {
    const { wakes, given } = recordingWakes();
    const exceptions = {
      factsFor: () => { throw new Error('not this door'); },
    } as unknown as TaskExceptionInputProducer;

    await routerOver(wakes, exceptions).route(FACT, 'JUDGMENT_REQUEST_DERIVER');

    assert.equal(given.length, 1);
    const taken = given[0]!;
    assert.deepEqual(
      await taken(FACT, { wakeId: 'w', idempotencyKey: 'k' }),
      { allowed: true },
      'the default is no longer the always-allow one this whole gate is about',
    );
  });

/** A fact this producer derives nothing for costs the ledger nothing. */
test('an exception delivery with no derived fact claims nothing', async () => {
  const { wakes, given } = recordingWakes();
  const exceptions = {
    factsFor: async () => [],
    authorize: async () => ({ allowed: true as const }),
  } as unknown as TaskExceptionInputProducer;

  assert.deepEqual(await routerOver(wakes, exceptions).routeTaskExceptions([FACT.subjectId]), []);
  assert.equal(given.length, 0);
});

/**
 * The default is still a named constant with one reader.
 *
 * A census over the source rather than over behaviour, because the failure it guards is a future
 * edit that quietly gives `routeTaskExceptions` the default back — which no assertion above could
 * see if the two doors were merged into one that always defaults.
 */
test('route()\'s default authorizer is read by exactly one call site', () => {
  const source = readFileSync(ROUTER_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ');
  const uses = source.match(/ALLOW_COMMITTED_INPUT/g) ?? [];
  assert.equal(
    uses.length, 2,
    'ALLOW_COMMITTED_INPUT is declared once and defaulted once — a third use is a second door '
      + 'that authorizes nothing',
  );
});

/**
 * Stand-ins for what the real application root supplies through its @Global modules. Nothing below
 * calls a method on any of them: the claim is about what Nest can CONSTRUCT.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: QueueService, useValue: {} },
    { provide: RealtimeService, useValue: { publishForUser: () => undefined } },
    { provide: JwtService, useValue: {} },
  ],
  exports: [PrismaService, QueueService, RealtimeService, JwtService],
})
class GlobalDoubles {}

@Module({ imports: [GlobalDoubles, CoordinatorJudgmentModule] })
class WiringHarness {}

test('the judgment module can construct the exception producer the router delivers through',
  async (t) => {
    const context = await NestFactory.createApplicationContext(WiringHarness, {
      logger: false,
      abortOnError: false,
    });
    t.after(() => context.close());

    const producer = context.get(TaskExceptionInputProducer);
    assert.ok(
      producer instanceof TaskExceptionInputProducer,
      'the exception producer is not a provider of the module that owns its convergence service',
    );
    // One instance, not one per injection site: the router below resolves the same object, which
    // is what makes "both task doors deliver through one producer" true rather than intended.
    assert.equal(context.get(TaskExceptionInputProducer), producer);

    const router = context.get(CompletionInputRouter);
    assert.ok(router instanceof CompletionInputRouter);
    assert.equal(typeof router.routeTaskExceptions, 'function');
  });
