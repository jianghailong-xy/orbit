import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ATTEMPT_BUDGET_DIMENSIONS,
  AttemptBudgetDimension,
  AttemptSpend,
  ZERO_ATTEMPT_SPEND,
} from './attempt-budget';
import { meterAttempt } from './attempt-budget-meter';
import { AttemptBudgetMeterService } from './attempt-budget-meter.service';
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';
import { PrismaService } from '../prisma/prisma.service';
import { wakeIdempotencyKey } from './coordinator-wake';

/**
 * Unit T5's decision, without a database in the way.
 *
 * The pg spec beside this one proves the same six dimensions over a real session; this file holds
 * what is true of the DECISION regardless of where the numbers came from — that every dimension
 * produces the fact, that two crossed at once report the earlier one, and that the last dimension
 * in the order asks nobody to stop.
 */

/** The `src` tree, from the compiled `build/projects` this runs out of. Same hop `coordinator-wake.spec.ts` makes. */
const SOURCE_DIR = path.resolve(__dirname, '../..', 'src/projects');

const ATTEMPT = {
  projectId: '5ba9dd44-2d33-4a4a-9d4f-2f7c8b1f0a11',
  taskId: '2f38b3ca-7e4a-4a2f-9f7d-1c7b4e2a55d3',
  sessionId: '0199a4d5-6c9b-7b1e-9a10-4d2f8c3b6e07',
};

const BUDGET = DEFAULT_ATTEMPT_BUDGET;

/**
 * One spend per dimension, each over exactly ITS line and comfortably under the other five.
 *
 * Keyed by dimension so the table can be checked for completeness against
 * `ATTEMPT_BUDGET_DIMENSIONS` below — a seventh dimension added to the contract with no entry here
 * fails that assertion rather than quietly going untested.
 */
const OVER: Readonly<Record<AttemptBudgetDimension, AttemptSpend>> = {
  CONTEXT: { ...ZERO_ATTEMPT_SPEND, contextTokens: 160_000, contextWindow: 200_000 },
  WALL_CLOCK: { ...ZERO_ATTEMPT_SPEND, wallClockMs: BUDGET.maxWallClockMs as number },
  TURNS: { ...ZERO_ATTEMPT_SPEND, turns: BUDGET.maxTurns as number },
  TOOL_CALLS: { ...ZERO_ATTEMPT_SPEND, toolCalls: BUDGET.maxToolCalls as number },
  COST: { ...ZERO_ATTEMPT_SPEND, costMicros: BUDGET.maxCostMicros as number },
  COORDINATOR_STEERS: {
    ...ZERO_ATTEMPT_SPEND,
    coordinatorSteers: BUDGET.maxCoordinatorSteers as number,
  },
};

test('every dimension in the contract has a spend that crosses only it', () => {
  assert.deepEqual(Object.keys(OVER).sort(), [...ATTEMPT_BUDGET_DIMENSIONS].sort());
});

/**
 * AC1, one assertion per dimension. `COORDINATOR_STEERS` is in here with the other five: it bounds
 * the coordinator rather than the worker, but running out of it is still a fact the coordinator has
 * to be told, because the legal next step is a fresh generation and not another "keep going".
 */
for (const dimension of ATTEMPT_BUDGET_DIMENSIONS) {
  test(`a spent ${dimension} produces ATTEMPT_BUDGET_SPENT naming that dimension`, () => {
    const { report, fact } = meterAttempt(ATTEMPT, BUDGET, OVER[dimension]);
    assert.equal(report.exhausted, dimension);
    assert.ok(fact, 'a spent dimension owes a fact');
    assert.equal(fact.event, 'ATTEMPT_BUDGET_SPENT');
    assert.equal(fact.projectId, ATTEMPT.projectId);
    assert.equal(fact.subjectType, 'TASK');
    assert.equal(fact.subjectId, ATTEMPT.taskId);
    assert.equal(fact.detail?.dimension, dimension);
  });
}

test('an attempt inside every line owes no fact', () => {
  const { report, fact } = meterAttempt(ATTEMPT, BUDGET, {
    ...ZERO_ATTEMPT_SPEND,
    turns: 1,
    contextTokens: 1_000,
    contextWindow: 200_000,
  });
  assert.equal(report.exhausted, null);
  assert.equal(fact, null);
});

/**
 * AC2. The array order IS the evaluation order, so the test walks every ADJACENT pair rather than
 * asserting one hand-picked collision: for each pair it crosses both lines at once and requires the
 * earlier dimension to be the one reported. Written against `ATTEMPT_BUDGET_DIMENSIONS` itself so
 * that reordering the contract moves this test with it instead of leaving it asserting the old order.
 */
test('two lines crossed at once report the one that comes first in ATTEMPT_BUDGET_DIMENSIONS', () => {
  for (let i = 0; i < ATTEMPT_BUDGET_DIMENSIONS.length - 1; i += 1) {
    const earlier = ATTEMPT_BUDGET_DIMENSIONS[i];
    const later = ATTEMPT_BUDGET_DIMENSIONS[i + 1];
    const both = merge(OVER[earlier], OVER[later]);
    const { report, fact } = meterAttempt(ATTEMPT, BUDGET, both);
    assert.equal(report.exhausted, earlier, `${earlier} must outrank ${later}`);
    assert.equal(fact?.detail?.dimension, earlier);
  }
});

test('CONTEXT outranks every other dimension, even all five at once', () => {
  const everything = ATTEMPT_BUDGET_DIMENSIONS
    .map((dimension) => OVER[dimension])
    .reduce(merge);
  assert.equal(meterAttempt(ATTEMPT, BUDGET, everything).report.exhausted, 'CONTEXT');
});

/**
 * AC4, the negative one. A worker on its way out is writing the checkpoint TH2 asked it for, and a
 * coordinator whose steer allowance ran out has no business ending that. The fact is produced —
 * somebody has to know the allowance is gone — and `windDownRequired` stays false, which is what
 * `SessionAttemptService.evaluate` reads to decide whether to move the attempt to `WINDING_DOWN`.
 */
test('a spent COORDINATOR_STEERS asks nobody to wind down', () => {
  const { report, fact } = meterAttempt(ATTEMPT, BUDGET, OVER.COORDINATOR_STEERS);
  assert.equal(report.exhausted, 'COORDINATOR_STEERS');
  assert.ok(fact);
  assert.equal(report.windDownRequired, false);
});

test('the other five dimensions do ask for a wind-down', () => {
  for (const dimension of ATTEMPT_BUDGET_DIMENSIONS) {
    if (dimension === 'COORDINATOR_STEERS') continue;
    assert.equal(
      meterAttempt(ATTEMPT, BUDGET, OVER[dimension]).report.windDownRequired,
      true,
      `${dimension} bounds the worker and must ask it to finish`,
    );
  }
});

/**
 * A spent steer allowance on top of a worker already winding down for another reason still reports
 * the OTHER reason, because that one comes first — so the wind-down that is already under way keeps
 * the name it was started under and the steer exhaustion cannot re-label it.
 */
test('steers spent alongside a real wind-down do not take over the report', () => {
  const { report } = meterAttempt(ATTEMPT, BUDGET, merge(OVER.CONTEXT, OVER.COORDINATOR_STEERS));
  assert.equal(report.exhausted, 'CONTEXT');
  assert.equal(report.windDownRequired, true);
});

/**
 * The dimension rides in `detail`, not in the key — so one attempt that crosses two lines wakes the
 * coordinator once rather than once per line. This is what lets `meterAttempt` be called on every
 * turn with no memory of whether it already fired.
 */
test('two dimensions on one attempt derive the same wake key', () => {
  const first = meterAttempt(ATTEMPT, BUDGET, OVER.CONTEXT).fact;
  const second = meterAttempt(ATTEMPT, BUDGET, OVER.TURNS).fact;
  assert.ok(first && second);
  assert.notEqual(first.detail?.dimension, second.detail?.dimension);
  assert.equal(wakeIdempotencyKey(first), wakeIdempotencyKey(second));
});

/**
 * AC5, as a test rather than as a promise in a commit message.
 *
 * `attempt-budget.ts` is the normative source for the budget and it is replayed byte for byte, so
 * it may not read a clock, a database or a session — `now` and the spend arrive as arguments. Unit
 * T5 is the unit most tempted to break that, because it is the one holding all three.
 */
test('attempt-budget.ts still has no clock, no database and no session', () => {
  const source = readFileSync(path.join(SOURCE_DIR, 'attempt-budget.ts'), 'utf8');
  const code = source
    // Block and line comments say the words on purpose ("a decision that read `Date.now()`"), and
    // a comment cannot call anything. Only executable text is searched.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['Date.now', 'new Date', 'prisma', 'Prisma', 'PrismaService', '$queryRaw']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `attempt-budget.ts must stay pure; found ${forbidden}`,
    );
  }
  // `session` appears in this module as a TYPE (`sessionId` on an actor, `AttemptSeed`), which is
  // the identity of an attempt and not a read of one. What it may not do is import the service or
  // the client that would let it go and look one up.
  assert.equal(/^import .*(prisma|session-attempt|@prisma\/client)/m.test(code), false);
});

/** Two spends, taking the larger of each dimension: crossing one line does not un-cross another. */
function merge(left: AttemptSpend, right: AttemptSpend): AttemptSpend {
  return {
    turns: Math.max(left.turns, right.turns),
    wallClockMs: Math.max(left.wallClockMs, right.wallClockMs),
    toolCalls: Math.max(left.toolCalls, right.toolCalls),
    costMicros: Math.max(left.costMicros, right.costMicros),
    contextTokens: Math.max(left.contextTokens ?? 0, right.contextTokens ?? 0) || null,
    contextWindow: Math.max(left.contextWindow ?? 0, right.contextWindow ?? 0) || null,
    coordinatorSteers: Math.max(left.coordinatorSteers, right.coordinatorSteers),
  };
}

/**
 * The project's own red line, restated for the files this unit adds: a wake is derived from
 * committed rows, never from a clock. `meterQuietly` is called from the runner's turn-complete,
 * which is a fact somebody committed; a sweep here would be the removed control loop's shape.
 */
test('nothing T5 adds to the wake path is reachable from a timer', () => {
  for (const file of ['attempt-budget-meter.ts', 'attempt-budget-meter.service.ts']) {
    const source = readFileSync(path.join(SOURCE_DIR, file), 'utf8');
    for (const forbidden of ['setInterval', '@Interval', '@Cron', 'setTimeout']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} reaches for ${forbidden} — a budget is charged when the spend commits, not on a clock`,
      );
    }
  }
});

/**
 * A budget that could not be charged must not take the runner's turn down with it.
 *
 * The fact is re-derived from the same committed columns on the next turn, so a miss here is
 * recoverable — and failing the turn-complete that carries it would trade that for a turn the
 * runner has to retry whole. `meterQuietly` is what the hot path calls, and this is the reason it
 * exists rather than the caller writing `.catch(() => {})` and meaning something vaguer by it.
 */
test('meterQuietly swallows a failure the next turn will re-derive', async () => {
  const broken = {
    $queryRaw: async () => {
      throw new Error('the database is not answering');
    },
  } as unknown as PrismaService;
  const service = new AttemptBudgetMeterService(
    broken,
    {} as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(() => service.meter('a-session', new Date()));
  await service.meterQuietly('a-session', new Date());
});
