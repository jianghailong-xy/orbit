import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CoordinatorJudgmentModule } from './coordinator-judgment.module';
import { COORDINATOR_WAKE_EVENTS, type TaskSettlement } from './coordinator-wake';
import type { CriterionLanding } from './project-criterion-landing';
import { type CriterionCoverage, criterionCoverage, wakeDisposition } from './wake-disposition';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The rule that decides whether an authorized wake is worth a judgment session.
 *
 * Its siblings need a database and assert what the ledger says after a real task really failed, or
 * really finished off the default branch. These claims need none: both folds are pure functions of
 * rows handed to them, and a service provided in no module is one the application cannot boot with.
 */

const T = (taskId: string, status: string) => ({ taskId, status });

/** The two answers the merge receipts can give. `CriterionLanding` has no third member. */
const LANDINGS: readonly CriterionLanding[] = ['LANDED', 'UNKNOWN'];

/** Every status a task can be in, so the table below can claim to be exhaustive. */
const STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED'] as const;

/** How one row of `BASELINE` is written: the serving statuses, `*` on the one that just ended. */
function spell(serving: readonly TaskSettlement[], ended?: string): string {
  return `[${serving.map((task) => (task.taskId === ended ? '*' : '') + task.status).join(',')}]`;
}

/**
 * The whole input space `criterionCoverage` can be handed, at up to two serving tasks.
 *
 * Two is the whole space and not a sample. The fold reads its input through `length === 0`, one
 * `some` and one `every`, and none of those three can tell a third member from a second: whatever
 * a set of three answers, some set of two answers the same way for the same reason. The second
 * member is what makes "one task ended and another is still expected to deliver" expressible at
 * all, and past that the arity stops mattering.
 *
 * Only `a` is ever named as the ended task. The two members are interchangeable to `some` and
 * `every`, so naming `b` instead would re-ask the rows where the pair is written the other way
 * round — the space is already closed under that swap.
 */
function everyInput(): Array<{ serving: TaskSettlement[]; ended?: string }> {
  const inputs: Array<{ serving: TaskSettlement[]; ended?: string }> = [{ serving: [] }];
  for (const first of STATUSES) {
    for (const ended of [undefined, 'a']) inputs.push({ serving: [T('a', first)], ended });
    for (const second of STATUSES) {
      for (const ended of [undefined, 'a']) {
        inputs.push({ serving: [T('a', first), T('b', second)], ended });
      }
    }
  }
  return inputs;
}

/**
 * That whole space, and the answer `59f674e2` gave for each — the commit this project began at and
 * the last one before the landing dimension was added to the rule below.
 *
 * Written out as a literal, and generated from nothing: a table derived by running the fold would
 * agree with the fold by construction, which is the one thing a baseline may not do. What it pins
 * is the promise this task was given — that `STRANDED` comes out of exactly the inputs it used to
 * come out of — and it pins the other two answers with it, because a rule that quietly turned an
 * `IN_FLIGHT` into a `BACKED` would have moved the same boundary from the other side.
 */
const BASELINE: Readonly<Record<string, CriterionCoverage>> = {
  '[]': 'STRANDED',
  '[OPEN]': 'IN_FLIGHT',
  '[*OPEN]': 'STRANDED',
  '[IN_PROGRESS]': 'IN_FLIGHT',
  '[*IN_PROGRESS]': 'STRANDED',
  '[DONE]': 'BACKED',
  '[*DONE]': 'BACKED',
  '[FAILED]': 'STRANDED',
  '[*FAILED]': 'STRANDED',
  '[CANCELLED]': 'STRANDED',
  '[*CANCELLED]': 'STRANDED',
  '[OPEN,OPEN]': 'IN_FLIGHT',
  '[*OPEN,OPEN]': 'IN_FLIGHT',
  '[OPEN,IN_PROGRESS]': 'IN_FLIGHT',
  '[*OPEN,IN_PROGRESS]': 'IN_FLIGHT',
  '[OPEN,DONE]': 'IN_FLIGHT',
  '[*OPEN,DONE]': 'STRANDED',
  '[OPEN,FAILED]': 'IN_FLIGHT',
  '[*OPEN,FAILED]': 'STRANDED',
  '[OPEN,CANCELLED]': 'IN_FLIGHT',
  '[*OPEN,CANCELLED]': 'STRANDED',
  '[IN_PROGRESS,OPEN]': 'IN_FLIGHT',
  '[*IN_PROGRESS,OPEN]': 'IN_FLIGHT',
  '[IN_PROGRESS,IN_PROGRESS]': 'IN_FLIGHT',
  '[*IN_PROGRESS,IN_PROGRESS]': 'IN_FLIGHT',
  '[IN_PROGRESS,DONE]': 'IN_FLIGHT',
  '[*IN_PROGRESS,DONE]': 'STRANDED',
  '[IN_PROGRESS,FAILED]': 'IN_FLIGHT',
  '[*IN_PROGRESS,FAILED]': 'STRANDED',
  '[IN_PROGRESS,CANCELLED]': 'IN_FLIGHT',
  '[*IN_PROGRESS,CANCELLED]': 'STRANDED',
  '[DONE,OPEN]': 'IN_FLIGHT',
  '[*DONE,OPEN]': 'IN_FLIGHT',
  '[DONE,IN_PROGRESS]': 'IN_FLIGHT',
  '[*DONE,IN_PROGRESS]': 'IN_FLIGHT',
  '[DONE,DONE]': 'BACKED',
  '[*DONE,DONE]': 'BACKED',
  '[DONE,FAILED]': 'STRANDED',
  '[*DONE,FAILED]': 'STRANDED',
  '[DONE,CANCELLED]': 'STRANDED',
  '[*DONE,CANCELLED]': 'STRANDED',
  '[FAILED,OPEN]': 'IN_FLIGHT',
  '[*FAILED,OPEN]': 'IN_FLIGHT',
  '[FAILED,IN_PROGRESS]': 'IN_FLIGHT',
  '[*FAILED,IN_PROGRESS]': 'IN_FLIGHT',
  '[FAILED,DONE]': 'STRANDED',
  '[*FAILED,DONE]': 'STRANDED',
  '[FAILED,FAILED]': 'STRANDED',
  '[*FAILED,FAILED]': 'STRANDED',
  '[FAILED,CANCELLED]': 'STRANDED',
  '[*FAILED,CANCELLED]': 'STRANDED',
  '[CANCELLED,OPEN]': 'IN_FLIGHT',
  '[*CANCELLED,OPEN]': 'IN_FLIGHT',
  '[CANCELLED,IN_PROGRESS]': 'IN_FLIGHT',
  '[*CANCELLED,IN_PROGRESS]': 'IN_FLIGHT',
  '[CANCELLED,DONE]': 'STRANDED',
  '[*CANCELLED,DONE]': 'STRANDED',
  '[CANCELLED,FAILED]': 'STRANDED',
  '[*CANCELLED,FAILED]': 'STRANDED',
  '[CANCELLED,CANCELLED]': 'STRANDED',
  '[*CANCELLED,CANCELLED]': 'STRANDED',
};

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

test('every input that was STRANDED is STRANDED still, and still opens a judgment', () => {
  const inputs = everyInput();
  assert.equal(
    inputs.length, Object.keys(BASELINE).length,
    'the generated space and the written-down baseline are no longer the same set of inputs',
  );

  const stranded: string[] = [];
  for (const input of inputs) {
    const key = spell(input.serving, input.ended);
    const before = BASELINE[key];
    assert.ok(before !== undefined, `the baseline has no row for ${key}`);
    const now = criterionCoverage(input.serving, input.ended);
    assert.equal(now, before, `${key} folded to ${before} at 59f674e2 and folds to ${now} today`);
    if (now !== 'STRANDED') continue;
    stranded.push(key);

    // And its disposition is the one it had, for every fact that could bear on it and whatever the
    // merge receipts say. The second dimension is asked AFTER this clause and can only widen what
    // opens a session, and this is what holds it to that: a stranded criterion is answered because
    // nothing is going to deliver it, not because of what arrived or where any branch is.
    for (const event of COORDINATOR_WAKE_EVENTS) {
      for (const landing of LANDINGS) {
        assert.equal(
          wakeDisposition(event, [{ coverage: now, landing }]), 'OPEN_JUDGMENT',
          `${key} stopped opening a judgment for ${event} with landing ${landing}`,
        );
      }
    }
  }

  // The count is a positive control on the loop above: a `criterionCoverage` that had stopped
  // answering STRANDED at all would satisfy every assertion inside it by never entering it.
  assert.equal(stranded.length, 29, 'the baseline has 29 stranded inputs');
  // And the four shapes this rule is most easily broken on, named. Each is a row of the table, so
  // one that stopped folding to STRANDED fails above and one that was never in the space fails
  // here.
  assert.deepEqual(
    ['[]', '[*OPEN]', '[*FAILED]', '[DONE,FAILED]', '[DONE,CANCELLED]']
      .filter((key) => stranded.includes(key)),
    ['[]', '[*OPEN]', '[*FAILED]', '[DONE,FAILED]', '[DONE,CANCELLED]'],
    'a criterion nobody serves, a criterion whose only serving task is the one that just ended, '
      + 'and finished work with a failed or cancelled sibling',
  );
});

test('an empty serving set is stranded, not vacuously backed', () => {
  // Its own case because `[].every` is vacuously TRUE: `criterionCoverage` would answer BACKED for
  // a criterion nobody has filed any work against if the length test above it were ever removed,
  // and every other row of the table would go on passing. A criterion nobody serves has not been
  // met — it has not been attempted — and under the rule below that reading is what sends it to a
  // judgment instead of recording it as a claim that holds.
  assert.equal(criterionCoverage([]), 'STRANDED');
  assert.equal(criterionCoverage([], 'nobody'), 'STRANDED');
  assert.notEqual(criterionCoverage([]), 'BACKED');
  for (const landing of LANDINGS) {
    assert.equal(
      wakeDisposition('CRITERION_READY', [{ coverage: criterionCoverage([]), landing }]),
      'OPEN_JUDGMENT',
    );
  }
});

test('a stranded criterion opens a judgment, and finished work off the branch goes to the standing coordinator',
  () => {
    assert.equal(wakeDisposition('CRITERION_READY', [{ coverage: 'STRANDED', landing: 'LANDED' }]),
      'OPEN_JUDGMENT');
    assert.equal(
      wakeDisposition('CRITERION_READY', [
        { coverage: 'IN_FLIGHT', landing: 'UNKNOWN' },
        { coverage: 'STRANDED', landing: 'UNKNOWN' },
      ]),
      'OPEN_JUDGMENT',
    );

    // §2: a backed claim owes nobody a judgment. Whether it HOLDS is not a question Orbit answers.
    // What §2.1 adds is the other half of that sentence: it can still owe a MERGE, and the fact
    // reporting where the work is is the one that gets asked. §2.2 is who gets asked — the merge
    // is owed once, so it goes to the conversation already coordinating this project rather than
    // to a session opened for it. The two decisive answers are DIFFERENT values, which is what
    // stops the caller having to ask the event a second time to find out which one it meant.
    assert.equal(
      wakeDisposition('CRITERION_UNLANDED', [{ coverage: 'BACKED', landing: 'UNKNOWN' }]),
      'DELIVER_TO_COORDINATOR',
    );
    assert.notEqual(
      wakeDisposition('CRITERION_UNLANDED', [{ coverage: 'BACKED', landing: 'UNKNOWN' }]),
      wakeDisposition('CRITERION_UNLANDED', [{ coverage: 'STRANDED', landing: 'UNKNOWN' }]),
      'work that is merely off the branch is answered the same way as work nothing will deliver',
    );
    assert.equal(
      wakeDisposition('CRITERION_UNLANDED', [{ coverage: 'BACKED', landing: 'LANDED' }]),
      'RECORD_ONLY',
      'a criterion whose finished work is on the default branch owes the merge nobody',
    );

    // §2.1: owed once. Every OTHER fact bearing on the very same backed-and-unlanded criterion is
    // recorded, so one criterion off the branch cannot become two sessions racing for one branch.
    for (const event of COORDINATOR_WAKE_EVENTS.filter((kind) => kind !== 'CRITERION_UNLANDED')) {
      assert.equal(
        wakeDisposition(event, [{ coverage: 'BACKED', landing: 'UNKNOWN' }]), 'RECORD_ONLY',
        `${event} also opened a session about a merge that is already being opened about`,
      );
    }

    for (const event of COORDINATOR_WAKE_EVENTS) {
      for (const landing of LANDINGS) {
        // Work still running changes nothing yet, wherever it is.
        assert.equal(wakeDisposition(event, [{ coverage: 'IN_FLIGHT', landing }]), 'RECORD_ONLY');
        // §3: a fact that bears on no criterion moves no criterion's coverage.
        assert.equal(wakeDisposition(event, []), 'RECORD_ONLY');
      }
    }

    // One criterion is enough, in either clause, whatever the others are doing.
    assert.equal(
      wakeDisposition('CRITERION_UNLANDED', [
        { coverage: 'BACKED', landing: 'LANDED' },
        { coverage: 'BACKED', landing: 'UNKNOWN' },
      ]),
      'DELIVER_TO_COORDINATOR',
    );
    // And STRANDED is asked first, so a project with both kinds of trouble opens the judgment its
    // stranded criterion needs rather than sending a merge instruction about the other one.
    assert.equal(
      wakeDisposition('CRITERION_UNLANDED', [
        { coverage: 'BACKED', landing: 'UNKNOWN' },
        { coverage: 'STRANDED', landing: 'UNKNOWN' },
      ]),
      'OPEN_JUDGMENT',
    );
    assert.equal(
      wakeDisposition('CRITERION_UNLANDED', [
        { coverage: 'BACKED', landing: 'LANDED' },
        { coverage: 'IN_FLIGHT', landing: 'LANDED' },
      ]),
      'RECORD_ONLY',
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
