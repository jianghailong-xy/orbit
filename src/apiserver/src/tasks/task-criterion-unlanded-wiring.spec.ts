import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Who constructs the criterion-landing producer, what the router hands the ledger for it, and
 * whether the landing fold is read by anything that is not itself.
 *
 * Its sibling `task-criterion-unlanded-delivery.pg.spec.ts` needs a database and asserts what the
 * ledger row says afterwards. These three claims need none, and none of them can be made there: a
 * producer provided in the wrong module is a producer the application cannot boot with, a sixth
 * argument that was omitted compiles exactly like one that was passed, and "how many callers does
 * this derivation have" is a question about the tree rather than about a run.
 */

const FACT: WakeFact = {
  event: 'CRITERION_UNLANDED',
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
  unlanded: CriterionUnlandedProducer,
): CompletionInputRouter {
  return new CompletionInputRouter(
    wakes,
    { afterCommit: () => { throw new Error('not this door'); } } as unknown as ProjectTasksSettledProducer,
    { factsFor: () => { throw new Error('not this door'); } } as unknown as TaskExceptionInputProducer,
    { factsFor: () => { throw new Error('not this door'); } } as unknown as CriterionReadyProducer,
    // The terminal chooser, answering RECORD_ONLY for everything: what this file asks is
    // which authorizer the door hands the LEDGER, and a fact routed to a judgment session
    // never reaches the ledger double at all.
    { openIfDecisive: async () => null } as unknown as WakeDispositionService,
    unlanded,
  );
}

test('the landing door hands the ledger its producer\'s authorizer, not the router\'s default',
  async () => {
    const { wakes, given } = recordingWakes();
    const authorize: WakeAuthorizer = async () => ({ allowed: false, refusalCode: 'MINE' });
    const unlanded = {
      factsFor: async () => [FACT],
      authorize,
    } as unknown as CriterionUnlandedProducer;

    const delivered = await routerOver(wakes, unlanded).routeUnlandedCriteria([FACT.projectId]);

    assert.deepEqual(delivered, [{
      criterionSubjectId: FACT.subjectId,
      outcome: 'ALREADY_AWAKE',
    }]);
    assert.equal(given.length, 1, 'the landing door delivered nothing to the ledger');
    assert.equal(
      given[0], authorize,
      'the landing delivery let route()\'s always-allow default stand in for an authorizer',
    );
  });

/** A project this producer derives no unlanded criterion for costs the ledger nothing. */
test('a landing delivery with no derived fact claims nothing', async () => {
  const { wakes, given } = recordingWakes();
  const unlanded = {
    factsFor: async () => [],
    authorize: async () => ({ allowed: true as const }),
  } as unknown as CriterionUnlandedProducer;

  assert.deepEqual(await routerOver(wakes, unlanded).routeUnlandedCriteria([FACT.projectId]), []);
  assert.equal(given.length, 0);
});

/** Every production source of the API server: the tests are not what this census is counting. */
const API_SRC = path.resolve(__dirname, '../../src');

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...productionSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

/** Comments stripped, so a name that appears only in prose is not counted as a caller. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ');
}

/**
 * The point of this whole unit, as a number.
 *
 * "Did the work land?" was computed on every project read and consumed by exactly one caller: the
 * function that reads the rows for it. That is what `projects.service.ts` meant by served and not
 * acted on — the answer existed, was correct, was shown to people, and was an input to nothing, so
 * the four hours a finished result once spent outside `main` were nobody's business to notice.
 *
 * Call SITES rather than importers, and over stripped source rather than over the import list,
 * because an import that nothing calls is exactly the state this census exists to catch. The count
 * is asserted to be MORE THAN the fold's own reader, and the fold's own reader is asserted to still
 * be there — a scanner that found nothing at all would otherwise satisfy any bound stated only as
 * a floor.
 */
test('the landing derivation has a caller that is not the function that reads its rows', () => {
  const sites = productionSources(API_SRC)
    .flatMap((file) => {
      const hits = code(file).match(/(?<![A-Za-z0-9_$])criterionLanding\s*\(/g) ?? [];
      return hits.map(() => path.relative(API_SRC, file));
    })
    .sort();

  assert.ok(
    sites.includes('projects/project-criterion-landing.ts'),
    'the census found no call site at all, including the fold\'s own reader — it is scanning '
      + 'the wrong tree and any bound below would pass over an empty set',
  );
  assert.ok(
    sites.length > 1,
    `the landing fold is still served and not acted on: ${sites.length} production call site(s), `
      + `${sites.join(', ')}`,
  );
  const consumers = [...new Set(sites)]
    .filter((file) => file !== 'projects/project-criterion-landing.ts');
  assert.ok(
    consumers.length > 0,
    'every call to the landing fold is inside the module that defines it',
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

test('the judgment module can construct the landing producer the router delivers through',
  async (t) => {
    const context = await NestFactory.createApplicationContext(WiringHarness, {
      logger: false,
      abortOnError: false,
    });
    t.after(() => context.close());

    const producer = context.get(CriterionUnlandedProducer);
    assert.ok(
      producer instanceof CriterionUnlandedProducer,
      'the landing producer is not a provider of the module that owns its convergence service',
    );
    // One instance, not one per injection site: the router below resolves the same object, which
    // is what makes "every task door delivers through one producer" true rather than intended.
    assert.equal(context.get(CriterionUnlandedProducer), producer);

    const router = context.get(CompletionInputRouter);
    assert.ok(router instanceof CompletionInputRouter);
    assert.equal(typeof router.routeUnlandedCriteria, 'function');
  });
