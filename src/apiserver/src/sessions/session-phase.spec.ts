import assert from 'node:assert/strict';
import test from 'node:test';

import { SESSION_PHASES, SESSION_TURN_OUTCOMES, SESSION_WAITING_ON } from '@orbit/shared';

import { ACCOUNT_PAUSED_ERROR_LIKE, HOLD_NOTICE_ERRORS, isHoldNotice } from '../queue/hold-notice';
import { CLAUDE_REGION_ERROR_PREFIX } from '../runners/runner-region';
import { STORED_STATUSES } from './session-state-legacy-fields.fixture';
import {
  deriveSessionPhase,
  deriveSessionWaitingOn,
  NO_HOLD,
  sessionPhaseFields,
  sessionWakes,
  type SessionHoldFacts,
  type SessionPhaseRow,
} from './session-phase';

/**
 * Plan step 5.1 (docs/session-three-state-plan.md §8): `phase` and `waitingOn` are decided by one function each
 * (sessions/session-phase.ts). This enumerates every combination of what they read, the way the legacy projector's
 * table does (session-state-legacy-fields.fixture.ts): the seven stored statuses × the three facts of work outside a
 * turn (the engine's own turn, a sub-agent, a background job) × the three wake facts (a RESUME_SESSION watch, a
 * PENDING scheduled wake-up, an armed retry) × an answer owed or not × five holds (none, a hold notice, a leftover
 * error that is no notice, the runner unavailable, the dispatch pause) — 4,480 rows. Each is held to the rule as
 * stated here, independently of the module, and to the invariants the design states.
 */

const RELEASED = new Set<string>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const OPEN = new Set<string>(['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']);
const AT = new Date('2026-11-22T00:00:00.000Z');

const HOLDS = {
  none: { error: null, hold: NO_HOLD },
  notice: { error: 'Account paused until 2026-11-23T00:00:00.000Z', hold: NO_HOLD },
  leftover: { error: 'claude exited with code 1', hold: NO_HOLD },
  runnerUnavailable: { error: null, hold: { dispatchPaused: false, runnerUnavailable: true } },
  dispatchPaused: { error: null, hold: { dispatchPaused: true, runnerUnavailable: false } },
} as const satisfies Record<string, { error: string | null; hold: SessionHoldFacts }>;

interface Case {
  key: string;
  row: SessionPhaseRow;
  hold: SessionHoldFacts;
  owed: number;
  facts: { engine: boolean; subagent: boolean; job: boolean; watch: boolean; wakeup: boolean; retry: boolean };
  holdKind: keyof typeof HOLDS;
}

function combinations(): Case[] {
  const cases: Case[] = [];
  for (const status of STORED_STATUSES) {
    for (let mask = 0; mask < 64; mask += 1) {
      const facts = {
        engine: (mask & 1) !== 0, subagent: (mask & 2) !== 0, job: (mask & 4) !== 0,
        watch: (mask & 8) !== 0, wakeup: (mask & 16) !== 0, retry: (mask & 32) !== 0,
      };
      for (const owed of [0, 1]) {
        for (const [holdKind, { error, hold }] of Object.entries(HOLDS) as Array<[keyof typeof HOLDS, typeof HOLDS[keyof typeof HOLDS]]>) {
          cases.push({
            key: `${status}|${Object.entries(facts).filter(([, on]) => on).map(([name]) => name).join('+') || '-'}|owed ${owed}|${holdKind}`,
            row: {
              status: status as SessionPhaseRow['status'],
              finishedAt: RELEASED.has(status) ? AT : null,
              engineTurnActive: facts.engine,
              runningSubagents: facts.subagent ? ['toolu_sub'] : [],
              runningBgJobs: facts.job ? ['bgj_job'] : [],
              hasResumeWatch: facts.watch,
              hasPendingWakeup: facts.wakeup,
              retryAt: facts.retry ? AT : null,
              error,
              lastTurnOutcome: null,
            },
            hold,
            owed,
            facts,
            holdKind,
          });
        }
      }
    }
  }
  return cases;
}

/** The rule as the design and the coordinator's ruling of 2026-11-22 state it, with the owner's of 2026-11-26: a
 *  session an armed retry will re-send is PENDING, held or released, unless it executes, and waits on that wake. */
function expected(c: Case): { phase: string; waitingOn: string | null } {
  const status = c.row.status!;
  const executing = status === 'RUNNING' || (OPEN.has(status) && (c.facts.engine || c.facts.subagent || c.facts.job));
  const queued = status === 'PENDING';
  const retrying = !executing && !queued && c.facts.retry;
  const phase = executing ? 'RUNNING' : queued || retrying ? 'PENDING' : 'IDLE';
  let waitingOn: string | null = null;
  if (c.owed > 0) waitingOn = 'PERSON';
  else if (retrying) waitingOn = 'WAKE';
  else if (phase === 'PENDING') waitingOn = c.holdKind === 'notice' || c.holdKind === 'runnerUnavailable' || c.holdKind === 'dispatchPaused' ? 'HOLD' : null;
  // A released row comes back only by an armed retry here (PENDING, above): its outcome is null, so it is no failure
  // release, and only a failure release in Open is revived by a wake-up; a watch never revives a released session.
  else if (phase === 'IDLE' && RELEASED.has(status)) waitingOn = null;
  else if (phase === 'IDLE') waitingOn = c.facts.watch || c.facts.wakeup ? 'WAKE' : null;
  return { phase, waitingOn };
}

test('the enumeration covers every status, fact, owed answer and hold', () => {
  const cases = combinations();
  assert.equal(cases.length, 7 * 64 * 2 * 5);
  assert.equal(new Set(cases.map((c) => c.key)).size, cases.length);
});

test('phase and waitingOn follow the stated rule on every combination', () => {
  const differences: string[] = [];
  for (const c of combinations()) {
    const want = expected(c);
    const got = { phase: deriveSessionPhase(c.row), waitingOn: deriveSessionWaitingOn(c.row, c.hold, c.owed) };
    if (got.phase !== want.phase || got.waitingOn !== want.waitingOn) {
      differences.push(`${c.key}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(differences, [], `\n${differences.slice(0, 40).join('\n')}\n`);
});

test('the invariants hold on every combination', () => {
  for (const c of combinations()) {
    const fields = sessionPhaseFields(c.row, c.hold, c.owed);
    assert.ok((SESSION_PHASES as readonly string[]).includes(fields.phase), c.key);
    assert.ok(fields.waitingOn === null || (SESSION_WAITING_ON as readonly string[]).includes(fields.waitingOn), c.key);
    // released is the release column; a released session is IDLE, or PENDING while an armed retry will re-send it
    // (design §4.2, amended 2026-11-26).
    assert.equal(fields.released, RELEASED.has(c.row.status!), c.key);
    if (fields.released) assert.equal(fields.phase, c.row.retryAt != null ? 'PENDING' : 'IDLE', c.key);
    // A RUNNING session waits on a person or on nothing; a hold is a queued turn's; a wake is an idle session's, or a
    // PENDING one's that an armed retry will re-send.
    if (fields.phase === 'RUNNING') assert.ok(fields.waitingOn === 'PERSON' || fields.waitingOn === null, c.key);
    if (fields.waitingOn === 'HOLD') assert.equal(fields.phase, 'PENDING', c.key);
    if (fields.waitingOn === 'WAKE') {
      assert.ok(fields.phase === 'IDLE' || (fields.phase === 'PENDING' && c.row.retryAt != null), c.key);
    }
  }
});

test('the shapes the ruling names answer as it says', () => {
  const base: SessionPhaseRow = { status: 'AWAITING_INPUT', finishedAt: null };
  // A parked conversation that asked for nothing waits on nobody.
  assert.equal(deriveSessionWaitingOn(base, NO_HOLD, 0), null);
  // A released session: nothing, unless a retry is armed.
  const failed: SessionPhaseRow = { status: 'FAILED', finishedAt: AT };
  assert.equal(deriveSessionWaitingOn(failed, NO_HOLD, 0), null);
  assert.equal(deriveSessionWaitingOn({ ...failed, retryAt: AT }, NO_HOLD, 0), 'WAKE');
  // Waiting for that retry is PENDING (the owner, 2026-11-26), held or released, and waits on its wake; a held one
  // that still runs a background job is RUNNING; a queued turn with a retry armed is a queued turn.
  assert.equal(deriveSessionPhase(failed), 'IDLE');
  assert.equal(deriveSessionPhase({ ...failed, retryAt: AT }), 'PENDING');
  assert.equal(deriveSessionPhase({ ...base, retryAt: AT }), 'PENDING');
  assert.equal(deriveSessionWaitingOn({ ...base, retryAt: AT }, NO_HOLD, 0), 'WAKE');
  assert.equal(deriveSessionPhase({ ...base, retryAt: AT, runningBgJobs: ['bgj_job'] }), 'RUNNING');
  const queuedTurn: SessionPhaseRow = { status: 'PENDING', finishedAt: null, retryAt: AT };
  assert.equal(deriveSessionPhase(queuedTurn), 'PENDING');
  assert.equal(deriveSessionWaitingOn(queuedTurn, NO_HOLD, 0), null);
  assert.equal(deriveSessionWaitingOn(queuedTurn, { dispatchPaused: true, runnerUnavailable: false }, 0), 'HOLD');
  // A wake-up revives a release by a failure (released, no end asked, the turn FAILED) while it is filed in Open; a
  // watch never revives a released session; an end that was asked for is not revived by either.
  const crashed: SessionPhaseRow = { ...failed, lastTurnOutcome: 'FAILED', endReason: null };
  assert.equal(deriveSessionWaitingOn({ ...crashed, hasPendingWakeup: true }, NO_HOLD, 0), 'WAKE');
  assert.equal(deriveSessionWaitingOn({ ...crashed, hasPendingWakeup: true, completedAt: AT }, NO_HOLD, 0), null);
  assert.equal(deriveSessionWaitingOn({ ...crashed, hasResumeWatch: true }, NO_HOLD, 0), null);
  const ended: SessionPhaseRow = { status: 'CANCELLED', finishedAt: AT, endReason: 'ended', lastTurnOutcome: 'ANSWERED' };
  assert.equal(deriveSessionWaitingOn({ ...ended, hasPendingWakeup: true, hasResumeWatch: true }, NO_HOLD, 0), null);
  assert.equal(sessionWakes({ ...crashed, hasPendingWakeup: true }), true);
  // Beside PERSON: a held idle session with an owner request open and a watch armed still wakes.
  assert.equal(deriveSessionWaitingOn({ ...base, hasResumeWatch: true }, NO_HOLD, 1), 'PERSON');
  assert.equal(sessionWakes({ ...base, hasResumeWatch: true }), true);
  // Waiting on a sub-agent or a background job is RUNNING, which owes nothing unless an answer is owed.
  assert.equal(deriveSessionPhase({ ...base, runningSubagents: ['toolu_sub'] }), 'RUNNING');
  assert.equal(deriveSessionWaitingOn({ ...base, runningBgJobs: ['bgj_job'] }, NO_HOLD, 0), null);
  assert.equal(deriveSessionWaitingOn({ ...base, runningBgJobs: ['bgj_job'] }, NO_HOLD, 1), 'PERSON');
  // An open session request it sent, or an ask_owner question, is no wake fact: the row reads null.
  assert.equal(deriveSessionWaitingOn(base, NO_HOLD, 0), null);
});

test('phase reads the turn state, and the stored word only for a held row without one (task T10)', () => {
  // Filled: the turn state decides, whatever the word beside it.
  assert.equal(deriveSessionPhase({ finishedAt: null, turnState: 'IN_FLIGHT' }), 'RUNNING');
  assert.equal(deriveSessionPhase({ finishedAt: null, turnState: 'QUEUED' }), 'PENDING');
  assert.equal(deriveSessionPhase({ finishedAt: null, turnState: 'ABANDONED' }), 'IDLE');
  assert.equal(deriveSessionPhase({ status: 'PENDING', finishedAt: null, turnState: 'IN_FLIGHT' }), 'RUNNING');
  // Not yet backfilled: the stored word.
  assert.equal(deriveSessionPhase({ status: 'PENDING', finishedAt: null, turnState: null }), 'PENDING');
  assert.equal(deriveSessionPhase({ status: 'RUNNING', finishedAt: null }), 'RUNNING');
  // Neither: parked. Released: IDLE whatever the rest says.
  assert.equal(deriveSessionPhase({ finishedAt: null, turnState: null }), 'IDLE');
  assert.equal(deriveSessionPhase({ status: 'RUNNING', finishedAt: AT, turnState: 'IN_FLIGHT' }), 'IDLE');
  // A queued turn held by the dispatch pause is HOLD, on the turn state alone.
  assert.equal(deriveSessionWaitingOn({ finishedAt: null, turnState: 'QUEUED' }, { ...NO_HOLD, dispatchPaused: true }, 0), 'HOLD');
});

test('lastTurnOutcome passes the column through, and nothing else', () => {
  const row: SessionPhaseRow = { status: 'AWAITING_INPUT', finishedAt: null };
  for (const outcome of SESSION_TURN_OUTCOMES) {
    assert.equal(sessionPhaseFields({ ...row, lastTurnOutcome: outcome }, NO_HOLD, 0).lastTurnOutcome, outcome);
  }
  assert.equal(sessionPhaseFields({ ...row, lastTurnOutcome: null }, NO_HOLD, 0).lastTurnOutcome, null);
  assert.equal(sessionPhaseFields({ ...row, lastTurnOutcome: 'SUCCEEDED' }, NO_HOLD, 0).lastTurnOutcome, null);
});

test('a hold notice is exactly a sentence the claim clears', () => {
  for (const sentence of HOLD_NOTICE_ERRORS) assert.equal(isHoldNotice(sentence), true, sentence);
  assert.equal(isHoldNotice(ACCOUNT_PAUSED_ERROR_LIKE.replace('%', '2026-11-23T00:00:00.000Z')), true);
  assert.equal(isHoldNotice('provider "orbit-key" cannot run on codex'), true);
  assert.equal(isHoldNotice(`${CLAUDE_REGION_ERROR_PREFIX}Claude is not offered in this region`), true);
  for (const leftover of [null, '', 'claude exited with code 1', 'Account paused', 'provider x cannot run on y']) {
    assert.equal(isHoldNotice(leftover), false, String(leftover));
  }
});
