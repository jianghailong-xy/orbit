import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { releaseFinishedTheWork, releaseWasFailure, type SessionReleaseFacts } from './session-release';
import { CAUSE_READING, RELEASE_SHAPES, releaseFactsOfShape, type ReleaseShape } from './session-release-shapes.fixture';

/**
 * Removal steps R3 and R4 (docs/session-three-state-design.md §12.2, decision D9): the two release questions of
 * common/session-release.ts, asked of every release row shape (common/session-release-shapes.fixture.ts), against the
 * reading they replace, the release cause (`CAUSE_READING`: a failure is a failure cause, the work finished exactly when
 * the cause is task_done or landing_settled), and production's reading today (deploy 1 reads the status).
 *
 *   released by a failure  finished_at set, no end reason, and last_turn_outcome FAILED or (the bridge) status FAILED
 *   the work finished      finished_at set, and end_reason task_done or a LANDING container with no end reason
 *
 * The work finished answers as the cause did on every shape. Released by a failure answers as the cause did on every
 * shape but the ones named in the fixture, each by why:
 *   END_ASKED      W7, and W4 after an end was asked: an end somebody asked for is a stop, not a failure (intended).
 *   LEGACY_FAILED  FAILED rows 1262 gave a clean-end cause with no end reason (production: 71 engine_exited, and at
 *                  most 1 cancelled): read as failed, as their status and 1202's turn outcome say and as deploy 1 reads
 *                  them today; only the project branch's cause reading, never deployed, said not.
 *   RESIDUAL       A2, the coordinator's residual shape: a failed turn's copy kept through a release that is no
 *                  failure, with no turn for option A to cut off (production: 0 rows).
 * Separately, the question is asked without the status bridge (removal step R7's reading) of every shape that carries a
 * turn outcome, and answers the same, but for W7 with no reason recorded, which R7 turns into a stop as W7's rule says.
 * The shapes that carry none (W5, the deploy-1 hand-over rows) are read through the bridge until R6 backfills them; W5
 * changes once the bridge goes, and no reader sees it: an import is in Trash, with no task and no retry.
 *
 * B4 of §12.2 (1405's rewrite of B1) is not a shape: 1405 was removed before it was deployed (removal step R1).
 *
 * Set ORBIT_RELEASE_SHAPES_TABLE to a file path to write the table as markdown.
 */

/**
 * The row as removal step R7's reading sees it. The bridge is the failure question's one read of `status` (the guard
 * allow-list's FAILURE_STATUS_BRIDGE section counts it), so a status word other than FAILED leaves only the turn
 * outcome to answer; the spec below holds that the question reads the status nowhere else.
 */
function withoutBridge(facts: SessionReleaseFacts): SessionReleaseFacts {
  return { ...facts, status: facts.status === 'FAILED' ? 'CANCELLED' : facts.status };
}

interface Answers {
  shape: ReleaseShape;
  todayFailed: boolean;
  statusFailed: boolean;
  failed: boolean;
  failedWithoutBridge: boolean;
  todayFinished: boolean;
  finished: boolean;
}

function answersOf(shape: ReleaseShape): Answers {
  const facts = releaseFactsOfShape(shape, new Date('2026-11-21T12:00:00.000Z'));
  return {
    shape,
    todayFailed: shape.released && CAUSE_READING.failed(shape.releaseCause),
    statusFailed: shape.released && shape.status === 'FAILED',
    failed: releaseWasFailure(facts),
    failedWithoutBridge: releaseWasFailure(withoutBridge(facts)),
    todayFinished: shape.released && CAUSE_READING.finished(shape.releaseCause),
    finished: releaseFinishedTheWork(facts),
  };
}

const ANSWERS = RELEASE_SHAPES.map(answersOf);

test('the table names every row shape of design §12.2, and the shapes the rulings of 2026-11-21 added', () => {
  const names = RELEASE_SHAPES.map((shape) => shape.name);
  assert.equal(new Set(names).size, names.length, 'each shape once');
  for (const name of ['W1', 'W1 swallowed', 'W1a', 'W1b', 'W1c', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7 running', 'W7 idle',
    'W8', 'N1', 'N2', 'N3', 'N4', 'N5', 'B1 completed', 'B1 engine', 'B2', 'B3', 'R1',
    // The coordinator's: option A's shape, the residual one, W4 after an end; the hand-over rows the bridge carries.
    'A1', 'A2', 'W4 after an end', 'H2', 'H6', 'H4']) {
    assert.ok(names.includes(name), `the table has ${name}`);
  }
});

test('released by a failure answers as the release cause did, but for the shapes named by why', () => {
  for (const a of ANSWERS) {
    const { name, failureChange } = a.shape;
    switch (failureChange) {
      case undefined:
        assert.equal(a.failed, a.todayFailed, `${name}: as the cause read it`);
        break;
      case 'END_ASKED':
        // W7: an end that was asked for and not honoured (or a source refused after one) is no longer a failure.
        assert.equal(a.todayFailed, true, `${name}: the cause read a failure`);
        assert.equal(a.failed, false, `${name}: an end was asked, so a stop`);
        break;
      case 'LEGACY_FAILED':
        assert.equal(a.todayFailed, false, `${name}: the cause read no failure`);
        assert.equal(a.failed, true, `${name}: failed, as the status and the turn outcome say`);
        assert.equal(a.failed, a.statusFailed, `${name}: production's reading today`);
        break;
      case 'RESIDUAL':
        assert.equal(a.todayFailed, false, `${name}: the cause read no failure`);
        assert.equal(a.failed, true, `${name}: the kept copy reads as a failure (a gap, named in the evidence)`);
        break;
    }
    // A held session was released by nothing.
    if (!a.shape.released) assert.equal(a.failed, false, `${name}: held`);
  }
});

test('the work finished answers as the release cause did on every shape', () => {
  for (const a of ANSWERS) assert.equal(a.finished, a.todayFinished, `${a.shape.name}: as the cause read it`);
});

test('without the bridge, every shape that carries a turn outcome answers the same; the others are the bridge\'s', () => {
  for (const a of ANSWERS) {
    const { name, carriesTurnOutcome, withoutBridge: change } = a.shape;
    if (change === 'END_ASKED') {
      // W7 with no reason recorded: a failure while the status bridge reads FAILED, a stop once R7 drops it.
      assert.equal(a.failed, true, `${name}: with the bridge, as the cause read it`);
      assert.equal(a.failedWithoutBridge, false, `${name}: without it, the turn says CANCELLED`);
    } else if (carriesTurnOutcome) {
      assert.equal(a.failedWithoutBridge, a.failed, `${name}: the turn outcome answers alone`);
    } else {
      // W5 and the deploy-1 hand-over rows: FAILED with no turn outcome. The bridge reads them as the cause did.
      assert.equal(a.failed, true, `${name}: the bridge reads the status`);
      assert.equal(a.failed, a.todayFailed, `${name}: as the cause read it`);
      assert.equal(a.failedWithoutBridge, false, `${name}: no turn outcome to read without the bridge`);
    }
  }
});

test('the bridge is the failure question\'s only read of the status, and the work question reads none', () => {
  for (const shape of RELEASE_SHAPES) {
    const facts = releaseFactsOfShape(shape);
    const answers = (['SUCCEEDED', 'CANCELLED', 'FAILED'] as const).map((status) => {
      const row: SessionReleaseFacts = { ...facts, status };
      return { status, failed: releaseWasFailure(row), finished: releaseFinishedTheWork(row) };
    });
    assert.equal(answers[0].failed, answers[1].failed, `${shape.name}: SUCCEEDED and CANCELLED read alike`);
    assert.equal(answers[2].failed, answers[0].failed || (shape.released && shape.endReason === null),
      `${shape.name}: FAILED adds exactly "released with no end reason"`);
    assert.equal(new Set(answers.map((a) => a.finished)).size, 1, `${shape.name}: the work question reads no status`);
  }
});

test('the table, printed', () => {
  const yes = (value: boolean) => (value ? 'yes' : '-');
  const lines = [
    '| shape | what | status | release_cause | end_reason | last_turn_outcome | kind | failed: cause (before) | failed: status (production) | failed: now | failed: without bridge (R7) | finished: cause (before) | finished: now | why it differs | production |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const a of ANSWERS) {
    const s = a.shape;
    const why = [s.failureChange, s.withoutBridge ? `${s.withoutBridge} without bridge` : null,
      !s.carriesTurnOutcome ? 'bridge carries it' : null].filter(Boolean).join('; ');
    lines.push(`| ${s.name} | ${s.what} | ${s.status} | ${s.releaseCause ?? '-'} | ${s.endReason ?? '-'} | `
      + `${s.lastTurnOutcome ?? '-'} | ${s.sessionKind} | ${yes(a.todayFailed)} | ${yes(a.statusFailed)} | ${yes(a.failed)} | `
      + `${s.carriesTurnOutcome || s.withoutBridge ? yes(a.failedWithoutBridge) : `(${yes(a.failedWithoutBridge)})`} | `
      + `${yes(a.todayFinished)} | ${yes(a.finished)} | ${why || '-'} | ${s.production ?? '-'} |`);
  }
  for (const line of lines) console.log(`# ${line}`);
  const out = process.env.ORBIT_RELEASE_SHAPES_TABLE;
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${lines.join('\n')}\n`);
  }
  assert.equal(lines.length, RELEASE_SHAPES.length + 2);
});
