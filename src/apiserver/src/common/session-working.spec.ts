import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';

import { BG_JOB_ACTIVITY_STALE_AFTER_MS } from '../sessions/background-job-activity';
import { ACTIVE_TURN_STATUSES } from './session-scheduling';
import {
  SESSION_HOLDS_SLOT_WHERE,
  bgJobsStalled,
  isSessionExecuting,
  movingBgJobs,
  sessionHoldsSlot,
  sessionHoldsSlotSql,
  sessionWillWake,
  type SessionWorkingRow,
} from './session-working';

/**
 * The three questions of common/session-working.ts as TypeScript predicates, fact by fact and in
 * combination, on every status. That the Prisma filter and the SQL fragment answer the same on the
 * same rows is session-working.pg.spec.ts, against PostgreSQL.
 */

const ALL_STATUSES = Object.values(RunStatus);
/** Statuses on which work outside a turn is read: the session has not ended. */
const NOT_ENDED = new Set<RunStatus>(['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']);

const EXECUTION_FACTS: Record<string, Partial<SessionWorkingRow>> = {
  'the engine running its own turn': { engineTurnActive: true },
  'a subagent in flight': { runningSubagents: ['toolu_sub'] },
  'a background job in flight': { runningBgJobs: ['bgj_1'] },
};
const WAKE_FACTS: Record<string, Partial<SessionWorkingRow>> = {
  'an ACTIVE RESUME_SESSION watch': { hasResumeWatch: true },
  'a PENDING scheduled wake-up': { hasPendingWakeup: true },
  'an armed retry': { retryAt: new Date() },
};

test('there are seven statuses, and the fixture covers each', () => {
  assert.equal(ALL_STATUSES.length, 7);
});

test('a bare row: executing only on a dispatched turn, never waking by itself', () => {
  for (const status of ALL_STATUSES) {
    const row = { status };
    assert.equal(isSessionExecuting(row), status === RunStatus.RUNNING, status);
    assert.equal(sessionWillWake(row), false, status);
    assert.equal(sessionHoldsSlot(row), status === RunStatus.RUNNING, status);
  }
});

test('each executing fact alone executes on a session that has not ended, and holds no slot', () => {
  for (const status of ALL_STATUSES) {
    for (const [name, fact] of Object.entries(EXECUTION_FACTS)) {
      const row = { status, ...fact };
      assert.equal(isSessionExecuting(row), NOT_ENDED.has(status), `${status}: ${name}`);
      assert.equal(sessionHoldsSlot(row), status === RunStatus.RUNNING, `${status}: ${name}`);
      assert.equal(sessionWillWake(row), false, `${status}: ${name}`);
    }
  }
});

test('each wake fact alone wakes a session that is not executing, on any status', () => {
  for (const status of ALL_STATUSES) {
    for (const [name, fact] of Object.entries(WAKE_FACTS)) {
      const row = { status, ...fact };
      assert.equal(isSessionExecuting(row), status === RunStatus.RUNNING, `${status}: ${name}`);
      assert.equal(sessionWillWake(row), status !== RunStatus.RUNNING, `${status}: ${name}`);
      assert.equal(sessionHoldsSlot(row), status === RunStatus.RUNNING, `${status}: ${name}`);
    }
  }
});

test('every combination of the six facts, on every status', () => {
  const facts = { ...EXECUTION_FACTS, ...WAKE_FACTS };
  const names = Object.keys(facts);
  for (const status of ALL_STATUSES) {
    for (let mask = 0; mask < 1 << names.length; mask += 1) {
      const on = names.filter((_, bit) => mask & (1 << bit));
      const row: SessionWorkingRow = Object.assign({ status }, ...on.map((name) => facts[name]));
      const outsideTurn = on.some((name) => name in EXECUTION_FACTS);
      const wake = on.some((name) => name in WAKE_FACTS);
      const executing = status === RunStatus.RUNNING || (NOT_ENDED.has(status) && outsideTurn);
      assert.equal(isSessionExecuting(row), executing, `${status}: ${on.join(', ')}`);
      assert.equal(sessionWillWake(row), !executing && wake, `${status}: ${on.join(', ')}`);
      assert.equal(sessionHoldsSlot(row), status === RunStatus.RUNNING, `${status}: ${on.join(', ')}`);
    }
  }
});

test('a background shell is no fact: a service left running never ends', () => {
  const row = { status: RunStatus.AWAITING_INPUT, runningBgShells: ['svc_dev_server'] } as SessionWorkingRow;
  assert.equal(isSessionExecuting(row), false);
  assert.equal(sessionWillWake(row), false);
});

test('empty and absent sets read as nothing running', () => {
  for (const row of [
    { status: RunStatus.AWAITING_INPUT, runningSubagents: [], runningBgJobs: [], engineTurnActive: false },
    { status: RunStatus.AWAITING_INPUT, runningSubagents: null, runningBgJobs: null, engineTurnActive: null },
  ]) {
    assert.equal(isSessionExecuting(row), false);
  }
});

test('holdsSlot is exactly ACTIVE_TURN_STATUSES and does not widen', () => {
  assert.deepEqual(ACTIVE_TURN_STATUSES, [RunStatus.RUNNING]);
  assert.deepEqual(SESSION_HOLDS_SLOT_WHERE, { status: RunStatus.RUNNING });
  assert.equal(sessionHoldsSlotSql('s'), `(s."status" = 'RUNNING'::"run_status")`);
});

test('a quiet background job is still executing; "stalled" is a flag beside it, not a verdict', () => {
  const now = 1_000_000_000_000;
  const quiet = now - BG_JOB_ACTIVITY_STALE_AFTER_MS - 60_000;
  const moving = now - 5_000;
  const row = (activity: Record<string, number>, jobs = Object.keys(activity)) => ({
    status: RunStatus.AWAITING_INPUT,
    runningBgJobs: jobs,
    runningBgJobActivity: activity,
  });
  // One job silent for eleven minutes: executing, and stalled.
  assert.equal(isSessionExecuting(row({ bgj_a: quiet })), true);
  assert.equal(bgJobsStalled(row({ bgj_a: quiet }), now), true);
  assert.deepEqual(movingBgJobs(row({ bgj_a: quiet }), now), []);
  // One quiet and one moving: not stalled, one moving.
  assert.equal(bgJobsStalled(row({ bgj_a: quiet, bgj_b: moving }), now), false);
  assert.deepEqual(movingBgJobs(row({ bgj_a: quiet, bgj_b: moving }), now), ['bgj_b']);
  // A job nobody reported progress on is not quiet (an older runner).
  assert.equal(bgJobsStalled(row({}, ['bgj_unreported']), now), false);
  // No job at all is not stalled.
  assert.equal(bgJobsStalled(row({}), now), false);
  assert.equal(bgJobsStalled({ runningBgJobs: null, runningBgJobActivity: null }, now), false);
});
