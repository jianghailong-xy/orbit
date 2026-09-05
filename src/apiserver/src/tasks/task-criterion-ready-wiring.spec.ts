import assert from 'node:assert/strict';
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
 * Who constructs the criterion-readiness producer, and what the router hands the ledger for it.
 *
 * Its sibling `task-criterion-ready-delivery.pg.spec.ts` needs a database and asserts what the
 * ledger row says afterwards. These two claims need none, and neither can be made there: a
 * producer provided in the wrong module is a producer the application cannot boot with, and a
 * fourth argument that was omitted compiles exactly like one that was passed.
 */

const FACT: WakeFact = {
  event: 'CRITERION_READY',
  projectId: '10000000-0000-4000-8000-000000000001',
  subjectType: 'CRITERION',
  subjectId: '10000000-0000-4000-8000-000000000001:2VfLq',
  subjectVersion: 'a'.repeat(64),
};

/** A fake ledger: it records the authorizer each delivery was given, and claims nothing. */
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

function routerOver(
  wakes: CoordinatorWakeService,
  criteria: CriterionReadyProducer,
): CompletionInputRouter {
  return new CompletionInputRouter(
    wakes,
    { afterCommit: () => { throw new Error('not this door'); } } as unknown as ProjectTasksSettledProducer,
    { factsFor: () => { throw new Error('not this door'); } } as unknown as TaskExceptionInputProducer,
    criteria,
  );
}

test('the criterion door hands the ledger its producer\'s authorizer, not the router\'s default',
  async () => {
    const { wakes, given } = recordingWakes();
    const authorize: WakeAuthorizer = async () => ({ allowed: false, refusalCode: 'MINE' });
    const criteria = {
      factsFor: async () => [FACT],
      authorize,
    } as unknown as CriterionReadyProducer;

    const delivered = await routerOver(wakes, criteria).routeReadyCriteria([FACT.projectId]);

    assert.deepEqual(delivered, [{
      criterionSubjectId: FACT.subjectId,
      outcome: 'ALREADY_AWAKE',
    }]);
    assert.equal(given.length, 1, 'the criterion door delivered nothing to the ledger');
    assert.equal(
      given[0], authorize,
      'the criterion delivery let route()\'s always-allow default stand in for an authorizer',
    );
  });

/** A project this producer derives no ready criterion for costs the ledger nothing. */
test('a criterion delivery with no derived fact claims nothing', async () => {
  const { wakes, given } = recordingWakes();
  const criteria = {
    factsFor: async () => [],
    authorize: async () => ({ allowed: true as const }),
  } as unknown as CriterionReadyProducer;

  assert.deepEqual(await routerOver(wakes, criteria).routeReadyCriteria([FACT.projectId]), []);
  assert.equal(given.length, 0);
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

test('the judgment module can construct the criterion producer the router delivers through',
  async (t) => {
    const context = await NestFactory.createApplicationContext(WiringHarness, {
      logger: false,
      abortOnError: false,
    });
    t.after(() => context.close());

    const producer = context.get(CriterionReadyProducer);
    assert.ok(
      producer instanceof CriterionReadyProducer,
      'the criterion producer is not a provider of the module that owns its convergence service',
    );
    // One instance, not one per injection site: the router below resolves the same object, which
    // is what makes "every task door delivers through one producer" true rather than intended.
    assert.equal(context.get(CriterionReadyProducer), producer);

    const router = context.get(CompletionInputRouter);
    assert.ok(router instanceof CompletionInputRouter);
    assert.equal(typeof router.routeReadyCriteria, 'function');
  });
