import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { releaseFinishedTheWork, releaseWasFailure, type SessionReleaseFacts } from './session-release';
import { backfilled, RELEASE_SHAPES, releaseFactsOfShape, type ReleaseShape } from './session-release-shapes.fixture';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * Removal steps R3, R4 and R7 (docs/session-three-state-design.md §12.2, decision D9): the two release questions of
 * common/session-release.ts, asked of every release row shape (common/session-release-shapes.fixture.ts), against the
 * readings production had before them (deploy 1 read the status; deploy 2 read the turn outcome or, the status bridge,
 * the status FAILED).
 *
 *   released by a failure  finished_at set, no end reason, and last_turn_outcome FAILED
 *   the work finished      finished_at set, and end_reason task_done or a LANDING container with no end reason
 *
 * Released by a failure answers as follows for the shapes named in the fixture, each by why:
 *   END_ASKED      W7, and W4 after an end was asked: an end somebody asked for is a stop, not a failure (intended).
 *   LEGACY_FAILED  FAILED rows 1262 gave a clean-end cause with no end reason (production: 71 engine_exited, and at
 *                  most 1 cancelled): read as failed, as their status and 1202's turn outcome say and as deploy 1 reads
 *                  them today; only the project branch's cause reading, never deployed, said not.
 *   RESIDUAL       A2, the coordinator's residual shape: a failed turn's copy kept through a release that is no
 *                  failure, with no turn for option A to cut off (production: 0 rows). Read as a failure as stored;
 *                  migration 1441 gives it CANCELLED, a stop, by the coordinator's ruling.
 * Removal step R7 dropped the status bridge, after migration 1441 (R6) wrote the turn outcome of every stored row the
 * bridge was answering for. So every shape, as 1441 leaves it, answers as deploy 2 read it with the bridge, but for A2
 * (now a stop, as ruled) and W5 (in Trash, which 1441 does not write: a stop, and no reader of the failure question
 * reaches a trashed import). A row a writer leaves after deploy 3 needs no backfill: it answers as deploy 2 read it,
 * but for W7 with no reason recorded, which no writer leaves.
 *
 * B4 of §12.2 (1405's rewrite of B1) is not a shape: 1405 was removed before it was deployed (removal step R1).
 *
 * Set ORBIT_RELEASE_SHAPES_TABLE to a file path to write the table as markdown.
 */

/** Deploy 2's reading of "released by a failure": the turn outcome, or the status bridge `status = 'FAILED'` (the
 *  shape's stored word). */
function deploy2Failed(facts: SessionReleaseFacts, stored: string): boolean {
  return releaseWasFailure(facts) || (facts.finishedAt != null && facts.endReason == null && stored === 'FAILED');
}

interface Answers {
  shape: ReleaseShape;
  statusFailed: boolean;
  /** Deploy 2's answer for the row as stored. */
  deploy2: boolean;
  /** This build's answer for the row as stored, before 1441. */
  failed: boolean;
  /** This build's answer for the row as 1441 leaves it. */
  failedBackfilled: boolean;
  finished: boolean;
}

const AT = new Date('2026-11-21T12:00:00.000Z');

function answersOf(shape: ReleaseShape): Answers {
  const facts = releaseFactsOfShape(shape, AT);
  return {
    shape,
    statusFailed: shape.released && shape.status === 'FAILED',
    deploy2: deploy2Failed(facts, shape.status),
    failed: releaseWasFailure(facts),
    failedBackfilled: releaseWasFailure(releaseFactsOfShape(backfilled(shape), AT)),
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

test('released by a failure: the shapes named by why answer as named, and a held session answers no', () => {
  for (const a of ANSWERS) {
    const { name, failureChange } = a.shape;
    switch (failureChange) {
      case 'END_ASKED':
        // W7: an end that was asked for and not honoured (or a source refused after one) is a stop, not a failure.
        assert.equal(a.failed, false, `${name}: an end was asked, so a stop`);
        break;
      case 'LEGACY_FAILED':
        assert.equal(a.failed, true, `${name}: failed, as the status and the turn outcome say`);
        assert.equal(a.failed, a.statusFailed, `${name}: production's reading today`);
        break;
      case 'RESIDUAL':
        assert.equal(a.failed, true, `${name}: as stored, the kept copy reads as a failure`);
        assert.equal(a.failedBackfilled, false, `${name}: 1441 gives it CANCELLED, a stop, as ruled`);
        break;
    }
    if (!a.shape.released) assert.equal(a.failed, false, `${name}: held`);
  }
});

test('the work finished: task_done, or a LANDING container released with no end reason', () => {
  for (const a of ANSWERS) {
    const { shape } = a;
    assert.equal(a.finished, shape.released && (shape.endReason === 'task_done' || (shape.sessionKind === 'LANDING' && shape.endReason === null)), shape.name);
  }
});

test('as 1441 leaves every stored row, each shape answers as deploy 2 read it with the bridge, but for A2 and W5', () => {
  const differ = ANSWERS.filter((a) => a.failedBackfilled !== a.deploy2).map((a) => a.shape.name);
  assert.deepEqual(differ, ['W5', 'A2'], 'the two named differences, and no other');
  const w5 = ANSWERS.find((a) => a.shape.name === 'W5')!;
  assert.equal(w5.shape.trashed, true, 'W5 is in Trash, which 1441 does not write');
  assert.equal(w5.failedBackfilled, false, 'W5: no turn, so a stop once the bridge is gone');
  for (const a of ANSWERS) {
    if (!a.shape.carriesTurnOutcome && !a.shape.trashed) {
      // The deploy-1 hand-over rows: the bridge answered for them in deploy 2, the backfilled turn outcome now.
      assert.equal(a.failed, false, `${a.shape.name}: as stored, nothing but the status said failed`);
      assert.equal(a.failedBackfilled, true, `${a.shape.name}: 1441 wrote the FAILED the bridge read`);
    }
  }
});

test('a row a writer leaves after deploy 3 answers as deploy 2 read it, but for W7 with no reason, which no writer leaves', () => {
  for (const a of ANSWERS.filter((candidate) => candidate.shape.carriesTurnOutcome)) {
    if (a.shape.afterDeploy3 === 'END_ASKED') {
      assert.equal(a.deploy2, true, `${a.shape.name}: the bridge read FAILED`);
      assert.equal(a.failed, false, `${a.shape.name}: the turn says CANCELLED, so a stop (W7's rule)`);
    } else {
      assert.equal(a.failed, a.deploy2, `${a.shape.name}: the turn outcome answers alone`);
    }
  }
});

test('the failure question reads no status word, and neither does the work question', () => {
  for (const shape of RELEASE_SHAPES) {
    const facts = releaseFactsOfShape(shape);
    const answers = (['SUCCEEDED', 'CANCELLED', 'FAILED'] as const).map((status) => {
      const row: SessionReleaseFacts = { ...facts, turnState: turnStateOfWord(status) };
      return { failed: releaseWasFailure(row), finished: releaseFinishedTheWork(row) };
    });
    assert.equal(new Set(answers.map((a) => a.failed)).size, 1, `${shape.name}: the failure question reads no status`);
    assert.equal(new Set(answers.map((a) => a.finished)).size, 1, `${shape.name}: the work question reads no status`);
  }
});

test('the new runner protocol: each shape answers both questions as the old protocol\'s shape for the same event', () => {
  const answersOfName = (name: string) => ANSWERS.find((a) => a.shape.name === name)!;
  const newShapes = ANSWERS.filter((a) => a.shape.name.startsWith('P'));
  assert.deepEqual(newShapes.map((a) => a.shape.name), ['P1 hold', 'P2 released after a failed turn',
    'P3 released by the backstop', 'P4 cut-off turn failed', 'P5 end asked in the hold', 'P6 end asked, cut-off ignored',
    'P7 stopped', 'P8 revived, then stopped']);
  for (const a of newShapes) {
    const { name, oldProtocol } = a.shape;
    if (!oldProtocol) {
      // The hold is no release: held, so neither question answers yes; its release (P2, P3, P5) is compared below.
      assert.equal(a.shape.released, false, `${name}: held`);
      assert.equal(a.failed, false, `${name}: no release, no failure yet`);
      assert.equal(a.finished, false, `${name}: no release, the work not finished`);
      continue;
    }
    const old = answersOfName(oldProtocol);
    assert.equal(a.failed, old.failed, `${name}: released by a failure, as ${oldProtocol}`);
    assert.equal(a.failedBackfilled, old.failedBackfilled, `${name}: and as 1441 leaves it, as ${oldProtocol}`);
    assert.equal(a.finished, old.finished, `${name}: the work finished, as ${oldProtocol}`);
  }
  // The four failures read as failures, the stops as stops.
  for (const name of ['P2 released after a failed turn', 'P3 released by the backstop', 'P4 cut-off turn failed', 'P5 end asked in the hold']) {
    assert.equal(answersOfName(name).failed, true, name);
  }
  for (const name of ['P6 end asked, cut-off ignored', 'P7 stopped', 'P8 revived, then stopped']) {
    assert.equal(answersOfName(name).failed, false, name);
  }
});

test('the table, printed', () => {
  const yes = (value: boolean) => (value ? 'yes' : '-');
  const lines = [
    '| shape | what | status | end_reason | last_turn_outcome | kind | failed: status (deploy 1) | failed: deploy 2 (bridge) | failed: now, as stored | failed: now, after 1441 | finished: now | why it differs | production |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const a of ANSWERS) {
    const s = a.shape;
    const why = [s.failureChange, s.afterDeploy3 ? `${s.afterDeploy3} if written after deploy 3` : null,
      !s.carriesTurnOutcome ? (s.trashed ? 'in Trash, not backfilled' : 'backfilled by 1441') : null]
      .filter(Boolean).join('; ');
    lines.push(`| ${s.name} | ${s.what} | ${s.status} | ${s.endReason ?? '-'} | `
      + `${s.lastTurnOutcome ?? '-'} | ${s.sessionKind} | ${yes(a.statusFailed)} | ${yes(a.deploy2)} | ${yes(a.failed)} | `
      + `${yes(a.failedBackfilled)} | ${yes(a.finished)} | ${why || '-'} | ${s.production ?? '-'} |`);
  }
  for (const line of lines) console.log(`# ${line}`);
  const out = process.env.ORBIT_RELEASE_SHAPES_TABLE;
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${lines.join('\n')}\n`);
  }
  assert.equal(lines.length, RELEASE_SHAPES.length + 2);
});
