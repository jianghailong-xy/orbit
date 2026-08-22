import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';
import { SessionAttemptService } from './session-attempt.service';

// `[K3]`'s read face (attempt budget §1 BD3/BD4 + the Base62 rule).
//
// Two things have to be true of it that the pg spec cannot show, because that one reads columns:
// the payload answers the question the endpoint exists for — how much of the try in flight is left,
// per dimension — and every id a caller could hand back reaches them in Base62.
//
// The second is the easy one to get half right. `PublicIdInterceptor` twins fields it recognises,
// but `attemptKey` is a STRING with a task's UUID buried in the middle of it, which the interceptor
// cannot see into — the same shape `publicConvergenceKey` exists for in `[K2]`.

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const ATTEMPT = '019fcdad-acd0-73f1-b83e-34c901525105';
const SESSION = '019fcdae-c039-76c2-bb7b-1a7c550f8e26';
const AT = new Date('2026-08-22T10:00:00.000Z');

const ATTEMPT_ROW = {
  id: ATTEMPT,
  task_id: TASK,
  owner_id: OWNER,
  session_id: SESSION,
  scope_revision: 2,
  scope_hash: 'b'.repeat(64),
  attempt_generation: 3n,
  attempt_key: `pc:v1:${TASK}:attempt:2:dispatch-7`,
  hypothesis: 'bisect the regression instead',
  hypothesis_digest: 'c'.repeat(64),
  budget: { ...DEFAULT_ATTEMPT_BUDGET },
  spend: null,
  coordinator_steers: 1,
  status: 'OPEN',
  outcome: null,
  classification: null,
  exhausted_dimension: null,
  checkpoint_sha: null,
  checkpoint_kind: null,
  checkpoint_evidence_digest: null,
  no_checkpoint_reason: null,
  inherited_known_good_sha: 'a'.repeat(40),
  wind_down_requested_at: null,
  closed_at: null,
  created_at: new Date('2026-08-22T09:30:00.000Z'),
};

const SPEND_ROW = {
  numTurns: 21,
  costUsd: 3.25,
  contextTokens: 120_000,
  contextWindow: 200_000,
  startedAt: new Date('2026-08-22T09:30:00.000Z'),
  toolCalls: 300n,
};

/** A prisma whose `$queryRaw` calls answer in the order `describe` makes them. */
function attemptService(rows: unknown[][] = [[ATTEMPT_ROW], [SPEND_ROW]]) {
  let call = 0;
  const prisma = { $queryRaw: async () => rows[call++] ?? [] };
  return new SessionAttemptService(prisma as never, {} as never);
}

function through<T>(body: T): Promise<T> {
  class Controller {}
  return lastValueFrom(
    new PublicIdInterceptor().intercept(
      { getClass: () => Controller } as never,
      { handle: () => of(body) } as never,
    ),
  ) as Promise<T>;
}

test('the payload says how much of the running attempt is left, dimension by dimension', async () => {
  const described = await attemptService().describe(OWNER, TASK, AT);
  assert.ok(described.current);
  assert.equal(described.current.status, 'OPEN');
  assert.equal(described.current.hypothesis, 'bisect the regression instead');
  // BigInt columns cross the wire as decimal strings, as every other one here does.
  assert.equal(described.current.attemptGeneration, '3');

  const by = new Map(described.current.budgetReport.readings.map((r) => [r.dimension, r]));
  assert.equal(by.size, 6, 'a dimension went missing from the read face');
  assert.equal(by.get('TURNS')?.remaining, 39);
  assert.equal(by.get('COST')?.spent, 3_250_000);
  assert.equal(by.get('TOOL_CALLS')?.remaining, 900);
  assert.equal(by.get('WALL_CLOCK')?.remaining, 3_600_000 - 1_800_000);
  // 120k of a 200k window is 60%, and the limit is 80: still WITHIN, with 20 points to spend.
  assert.equal(by.get('CONTEXT')?.spent, 60);
  assert.equal(by.get('CONTEXT')?.remaining, 20);
  assert.equal(by.get('COORDINATOR_STEERS')?.remaining, 2);
  assert.equal(described.current.budgetReport.exhausted, null);
  // The frozen budget is served beside the readings: a caller asking why an attempt stopped needs
  // the limit that applied to IT, not the project's current policy.
  assert.equal(described.current.budget.maxTurns, 60);
});

test('an unreported context window reads UNMEASURED rather than as a spend of zero (BD3)', async () => {
  const described = await attemptService([
    [ATTEMPT_ROW],
    [{ ...SPEND_ROW, contextTokens: null, contextWindow: null }],
  ]).describe(OWNER, TASK, AT);
  const context = described.current?.budgetReport.readings
    .find((r) => r.dimension === 'CONTEXT');
  assert.equal(context?.state, 'UNMEASURED');
  assert.equal(context?.remaining, null);
  // And the other five still bound it, so `UNMEASURED` never means "unbounded".
  assert.equal(described.current?.budgetReport.readings.filter((r) => r.state === 'WITHIN').length, 5);
});

test('a closed attempt reports the spend it was measured at, not one that kept running', async () => {
  const closed = {
    ...ATTEMPT_ROW,
    status: 'CLOSED',
    outcome: 'INTERRUPTED',
    exhausted_dimension: 'WALL_CLOCK',
    no_checkpoint_reason: 'the runner went offline mid-turn',
    wind_down_requested_at: new Date('2026-08-22T10:30:00.000Z'),
    closed_at: new Date('2026-08-22T10:31:00.000Z'),
    spend: {
      turns: 21,
      wallClockMs: 3_600_000,
      toolCalls: 300,
      costMicros: 3_250_000,
      contextTokens: 120_000,
      contextWindow: 200_000,
      coordinatorSteers: 1,
    },
  };
  // One query only: with nothing open there is no session left to measure.
  const described = await attemptService([[closed]]).describe(OWNER, TASK, AT);
  assert.equal(described.current, null);
  assert.equal(described.attempts.length, 1);
  assert.equal(described.attempts[0].outcome, 'INTERRUPTED');
  assert.equal(described.attempts[0].exhaustedDimension, 'WALL_CLOCK');
  assert.match(described.attempts[0].noCheckpointReason ?? '', /runner went offline/);
  assert.equal(described.attempts[0].budgetReport?.exhausted, 'WALL_CLOCK');
});

test('a task with no attempt reads as none rather than as an error', async () => {
  // Every task filed before `[K3]` is one of these, and "nothing has been attempted" has to be
  // distinguishable from "this server does not report attempts".
  const described = await attemptService([[]]).describe(OWNER, TASK, AT);
  assert.equal(described.current, null);
  assert.deepEqual(described.attempts, []);
  assert.equal(described.taskId, uuidToBase62(TASK));
});

test('every id leaves in Base62, including the one buried inside the attempt key', async () => {
  const payload = (await through(
    await attemptService().describe(OWNER, TASK, AT),
  )) as unknown as Record<string, unknown>;
  const current = payload.current as Record<string, unknown>;
  assert.equal(payload.taskId, uuidToBase62(TASK));
  assert.equal(current.id, uuidToBase62(ATTEMPT));
  assert.equal(current.sessionId, uuidToBase62(SESSION));
  assert.equal(current.attemptKey, `pc:v1:${uuidToBase62(TASK)}:attempt:2:dispatch-7`);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
});
