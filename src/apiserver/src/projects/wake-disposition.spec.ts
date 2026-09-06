import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CoordinatorJudgmentModule } from './coordinator-judgment.module';
import { criterionCoverage, wakeDisposition } from './wake-disposition';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The rule that decides whether an authorized wake is worth a judgment session.
 *
 * Its sibling `task-wake-disposition.pg.spec.ts` needs a database and asserts what the ledger says
 * after a real task really failed. These claims need none: the fold is a pure function of one
 * criterion's serving work, and a service provided in no module is one the application cannot boot
 * with.
 */

const T = (taskId: string, status: string) => ({ taskId, status });

test('coverage is about the criterion, and the ended task is not work anybody is waiting on', () => {
  // The project goal's two readings, side by side. Same event, same failed task, and the ONLY
  // difference is whether anything else is still expected to deliver the criterion it served.
  assert.equal(
    criterionCoverage([T('ended', 'FAILED'), T('sibling', 'OPEN')], 'ended'),
    'IN_FLIGHT',
    'a criterion whose other work is still outstanding has not changed',
  );
  assert.equal(
    criterionCoverage([T('ended', 'FAILED')], 'ended'),
    'STRANDED',
    'the only work serving a criterion failing leaves nothing to deliver it',
  );

  // The exclusion is what makes the second answer possible at all: an attempt that ended is not
  // pending work, whatever the task's own status column says.
  assert.equal(criterionCoverage([T('ended', 'OPEN')], 'ended'), 'STRANDED');
  assert.equal(
    criterionCoverage([T('ended', 'OPEN')]),
    'IN_FLIGHT',
    'and with nothing named as ended, the same row IS work somebody is waiting on',
  );

  // A criterion nobody serves is not vacuously backed — `[].every` would say it was.
  assert.equal(criterionCoverage([]), 'STRANDED');

  // Finished work backs the claim. A cancelled or failed member means it does not.
  assert.equal(criterionCoverage([T('a', 'DONE'), T('b', 'DONE')]), 'BACKED');
  assert.equal(criterionCoverage([T('a', 'DONE'), T('b', 'CANCELLED')]), 'STRANDED');
  assert.equal(
    criterionCoverage([T('a', 'DONE'), T('b', 'IN_PROGRESS')]),
    'IN_FLIGHT',
    'work in progress outranks work that finished: the criterion is not settled either way yet',
  );
});

test('only a stranded criterion is worth waking somebody for', () => {
  assert.equal(wakeDisposition(['STRANDED']), 'OPEN_JUDGMENT');
  assert.equal(wakeDisposition(['IN_FLIGHT', 'STRANDED']), 'OPEN_JUDGMENT');

  assert.equal(wakeDisposition(['IN_FLIGHT']), 'RECORD_ONLY');
  // §2: a backed claim is nobody's next step. Whether it HOLDS is not a question Orbit answers,
  // and the coordinator's moves — redispatch, succeed, split, cancel, escalate — do not apply to
  // work that is finished.
  assert.equal(wakeDisposition(['BACKED']), 'RECORD_ONLY');
  assert.equal(wakeDisposition(['BACKED', 'IN_FLIGHT']), 'RECORD_ONLY');
  // §3: a fact that bears on no criterion moves no criterion's coverage.
  assert.equal(wakeDisposition([]), 'RECORD_ONLY');
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

test('the judgment module constructs the one terminal chooser the router asks', async (t) => {
  const context = await NestFactory.createApplicationContext(WiringHarness, {
    logger: false,
    abortOnError: false,
  });
  t.after(() => context.close());

  const disposition = context.get(WakeDispositionService);
  assert.ok(
    disposition instanceof WakeDispositionService,
    'the terminal chooser is not a provider of the module that owns the judgment service it opens '
      + 'sessions through',
  );
  // One instance, not one per injection site, for the reason every other provider here is one:
  // "the coordinator gets at most one session per wake" is a claim about a shared ledger.
  assert.equal(context.get(WakeDispositionService), disposition);
});
