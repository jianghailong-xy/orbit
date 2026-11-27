/**
 * SESSION_QUIESCENT (predicateVersion 4, docs/session-three-state-plan.md step 1.3): the condition
 * `session_await` and `session_create(wait)` wait for by default. Nothing is executing for the session and
 * nothing is armed to wake it, so a child that ended its turn to wait for its own background job or subagent
 * is not reported finished.
 *
 * What this holds the leaf to, over the facts the evaluator hands it:
 * - the default conditions, read out of contracts/watch.contract.json, stay unsatisfied while a child at
 *   AWAITING_INPUT has a job in `runningBgJobs` or a running subagent, and hold once that work ends;
 * - every case of the table the coordinator asked for (held idle with nothing armed; with a job, a subagent,
 *   an engine turn; with a watch, a wake-up, a retry; FAILED with and without a retry; ended by a person with
 *   a stale watch; a LANDING container);
 * - SESSION_TURN_SETTLED answers every row exactly as the base commit's leaf did, which is restated below,
 *   so a watch stored with it is decided as before.
 *
 * watch-evaluator.pg.spec.ts (its SESSION_QUIESCENT section) drives the same cases through the evaluator
 * against PostgreSQL rows.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  leafHolds,
  observationOf,
  parseWatchPredicate,
  predicateHolds,
  type WatchPredicate,
  type WatchTargetFact,
} from './watch-predicate';
import { turnStateOfWord } from '../sessions/session-turn-state';

type SessionFact = Extract<WatchTargetFact, { kind: 'SESSION' }>;

const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as {
  agentSurface: {
    awaitPresets: { session_await: { default: string; until: Record<string, unknown> } };
    sessionCreateWait: { watch: { predicate: unknown; predicateVersion: number } };
  };
};

const NOW = Date.parse('2026-11-19T12:00:00.000Z');

function session(over: Partial<SessionFact> = {}): SessionFact {
  // The release column a row of that status carries (session_release_fact_chk): set exactly when released.
  const released = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(over.status ?? '');
  return {
    kind: 'SESSION',
    sessionKind: 'CONVERSATION',
    status: 'AWAITING_INPUT',
    turnState: turnStateOfWord(over.status ?? 'AWAITING_INPUT'),
    finishedAt: released ? new Date(NOW) : null,
    endReason: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    pendingApproval: false,
    jobs: [],
    engineTurnActive: false,
    runningSubagents: [],
    retryAt: null,
    hasResumeWatch: false,
    hasPendingWakeup: false,
    ...over,
  };
}

const JOB = { id: 'bgj_0a1b2c3d4e5f', lastOutputAt: NOW - 5_000 };

function parsed(predicate: unknown, version: number): WatchPredicate {
  const term = parseWatchPredicate(predicate, version);
  assert.ok(term, `${JSON.stringify(predicate)} is not a version-${version} term`);
  return term;
}

const sessionAwait = CONTRACT.agentSurface.awaitPresets.session_await;
const DEFAULTS: Array<[string, WatchPredicate]> = [
  ['session_await default', parsed(sessionAwait.until[sessionAwait.default], 4)],
  [
    'session_create(wait)',
    parsed(CONTRACT.agentSurface.sessionCreateWait.watch.predicate, CONTRACT.agentSurface.sessionCreateWait.watch.predicateVersion),
  ],
];

const quiescent = (fact: SessionFact) => leafHolds({ leaf: 'SESSION_QUIESCENT' }, fact, NOW);
const turnSettled = (fact: SessionFact) => leafHolds({ leaf: 'SESSION_TURN_SETTLED' }, fact, NOW);

test('the default waits are unsatisfied for a child at AWAITING_INPUT with a job running, and satisfied once it ends', () => {
  const working = session({ jobs: [JOB] });
  const done = session({ jobs: [] });
  // The old leaf is what returned too early: it holds for the working child.
  assert.equal(turnSettled(working), true);
  for (const [name, predicate] of DEFAULTS) {
    assert.equal(predicateHolds(predicate, [working], NOW), false, `${name} returned while the child's job runs`);
    assert.equal(predicateHolds(predicate, [done], NOW), true, `${name} did not return once the job ended`);
  }
});

test('the default waits are unsatisfied for a child at AWAITING_INPUT with a subagent running, and satisfied once it ends', () => {
  const working = session({ runningSubagents: ['toolu_01'] });
  const done = session({ runningSubagents: [] });
  assert.equal(turnSettled(working), true);
  for (const [name, predicate] of DEFAULTS) {
    assert.equal(predicateHolds(predicate, [working], NOW), false, `${name} returned while the child's subagent runs`);
    assert.equal(predicateHolds(predicate, [done], NOW), true, `${name} did not return once the subagent ended`);
  }
});

test('the default session_await still returns at once for a child waiting on an approval', () => {
  const asking = session({ status: 'RUNNING', pendingApproval: true });
  assert.equal(predicateHolds(DEFAULTS[0][1], [asking], NOW), true);
});

test('SESSION_QUIESCENT answers each case of the table', () => {
  const cases: Array<[string, SessionFact, boolean]> = [
    ['held idle, nothing armed', session(), true],
    ['held idle with a background job', session({ jobs: [JOB] }), false],
    ['held idle with a subagent', session({ runningSubagents: ['toolu_01'] }), false],
    ['held idle with an engine turn', session({ engineTurnActive: true }), false],
    ['held idle with a watch it observes', session({ hasResumeWatch: true }), false],
    ['held idle with a pending wake-up', session({ hasPendingWakeup: true }), false],
    ['held idle with a retry armed', session({ retryAt: new Date(NOW + 600_000) }), false],
    ['FAILED with a retry armed', session({ status: 'FAILED', retryAt: new Date(NOW + 600_000) }), false],
    ['FAILED with nothing armed', session({ status: 'FAILED' }), true],
    [
      'ended by a person with a stale watch and wake-up',
      session({ status: 'CANCELLED', endReason: 'ended', hasResumeWatch: true, hasPendingWakeup: true }),
      true,
    ],
    ['INTERRUPTED with an end reason and a stale watch', session({ status: 'INTERRUPTED', endReason: 'ended', hasResumeWatch: true }), true],
    ['SUCCEEDED with a stale wake-up', session({ status: 'SUCCEEDED', hasPendingWakeup: true }), true],
    ['moved to Completed with a stale retry', session({ status: 'FAILED', completedAt: new Date(NOW), retryAt: new Date(NOW) }), true],
    ['a bare INTERRUPTED (a stopped turn) waiting on its own watch', session({ status: 'INTERRUPTED', hasResumeWatch: true }), false],
    ['a turn queued', session({ status: 'PENDING' }), false],
    ['a turn running', session({ status: 'RUNNING' }), false],
    ['a LANDING container whose subject is open', session({ sessionKind: 'LANDING', status: 'AWAITING_INPUT' }), false],
    ['a LANDING container that ended', session({ sessionKind: 'LANDING', status: 'SUCCEEDED', completedAt: new Date(NOW) }), true],
  ];
  for (const [name, fact, expected] of cases) assert.equal(quiescent(fact), expected, name);
});

test('a snapshot of a SESSION_QUIESCENT watch records what it decided from, and one without it records nothing new', () => {
  const fact = session({ jobs: [JOB], hasPendingWakeup: true });
  const asked = observationOf(fact, [{ leaf: 'SESSION_QUIESCENT' }]) as { executing?: boolean; wakeArmed?: boolean };
  assert.deepEqual({ executing: asked.executing, wakeArmed: asked.wakeArmed }, { executing: true, wakeArmed: false });
  const settledOnly = observationOf(fact, [{ leaf: 'SESSION_TURN_SETTLED' }]);
  assert.equal('executing' in settledOnly, false);
  assert.equal('wakeArmed' in settledOnly, false);
});

/** SESSION_TURN_SETTLED as the base commit (e9fd6faa69) decided it, restated so a change to it goes red here. */
function baseTurnSettled(fact: SessionFact): boolean {
  if (fact.sessionKind === 'LANDING') return fact.completedAt !== null;
  return !['PENDING', 'RUNNING'].includes(fact.status);
}

test('a stored SESSION_TURN_SETTLED watch gives the base commit\'s verdict for every row, whatever runs beside the turn', () => {
  const statuses = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
  const extras: Array<Partial<SessionFact>> = [
    {},
    { jobs: [JOB] },
    { runningSubagents: ['toolu_01'] },
    { engineTurnActive: true },
    { hasResumeWatch: true },
    { hasPendingWakeup: true },
    { retryAt: new Date(NOW) },
    { pendingApproval: true },
  ];
  // The term as a version-1 watch stored it, decided under every grammar that serves it.
  const stored = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' };
  const terms = [1, 2, 3, 4].map((version) => parsed(stored, version));
  let rows = 0;
  for (const sessionKind of ['CONVERSATION', 'LANDING']) {
    for (const status of statuses) {
      for (const endReason of [null, 'ended']) {
        for (const completedAt of [null, new Date(NOW)]) {
          for (const extra of extras) {
            const fact = session({ sessionKind, status, endReason, completedAt, ...extra });
            for (const term of terms) {
              assert.equal(predicateHolds(term, [fact], NOW), baseTurnSettled(fact), JSON.stringify({ sessionKind, status, endReason, completedAt, extra }));
            }
            rows += 1;
          }
        }
      }
    }
  }
  assert.equal(rows, 2 * 7 * 2 * 2 * 8);
});

test('SESSION_QUIESCENT exists only from version 4: a stored term of an earlier grammar never meets it', () => {
  const term = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_QUIESCENT' };
  for (const version of [1, 2, 3]) assert.equal(parseWatchPredicate(term, version), null, `version ${version}`);
  assert.ok(parseWatchPredicate(term, 4));
});
