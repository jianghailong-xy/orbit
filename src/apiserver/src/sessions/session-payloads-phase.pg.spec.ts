import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SESSION_BACKGROUND_FIELD_NAMES, SESSION_PHASE_FIELD_NAMES } from '@orbit/shared';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { buildWorld, connect, FIXTURE_CASES, PAYLOAD_KINDS, readPayloads, SEARCH_HIT } from './session-payloads.fixture';

/**
 * Plan step 5.1 of docs/session-three-state-plan.md: every session payload kind carries `phase`, `released`,
 * `lastTurnOutcome` and `waitingOn`, and since plan phase 5 `endReason` and `workFinished`, decided once
 * (sessions/session-phase.ts), against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-payloads-phase.pg.spec.ts
 *
 * The fixture (session-payloads.fixture.ts) holds the seven stored statuses, a background job running, a turn
 * waiting on an approval, a watch armed, a queued turn on a paused account and a settled landing container. Each is read through the list row,
 * the detail, `session.created`/`session.updated`, `session.ended`, the link preview, the guest's Shared with me row
 * and the shared header, and each kind must carry the six fields with the values below — the same values on every
 * kind. contracts/session-state.contract.json states the same table as its vectors; this holds the two equal.
 *
 * Task 353YrK2AEGTm6mfl8GrW9 adds the search hit (`GET /sessions/search`) to the kinds, and the Background mark's two
 * inputs, `activity` and `runningBgCount`, to every kind, each with the values BACKGROUND gives — the list row's.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = JSON.parse(readFileSync(path.join(REPO, 'contracts/session-state.contract.json'), 'utf8')) as {
  payloads: Record<string, unknown>;
  vectors: Array<{ id: string; expect: Record<string, unknown> }>;
};

type Expected = {
  phase: string; released: boolean; lastTurnOutcome: string | null; waitingOn: string | null;
  endReason: string | null; workFinished: boolean;
};
const EXPECTED: Record<string, Expected> = {
  PENDING: { phase: 'PENDING', released: false, lastTurnOutcome: null, waitingOn: null, endReason: null, workFinished: false },
  RUNNING: { phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: null, endReason: null, workFinished: false },
  AWAITING_INPUT: { phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: null, workFinished: false },
  INTERRUPTED: { phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null, endReason: null, workFinished: false },
  // A task run that ended DONE.
  SUCCEEDED: { phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: 'task_done', workFinished: true },
  // A failure release: no end reason, the last turn failed.
  FAILED: { phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null, endReason: null, workFinished: false },
  // A requested end (End).
  CANCELLED: { phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: 'ended', workFinished: false },
  'job running': { phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: null, workFinished: false },
  'waiting on an approval': { phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: 'PERSON', endReason: null, workFinished: false },
  'watch armed': { phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'WAKE', endReason: null, workFinished: false },
  'paused account': { phase: 'PENDING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'HOLD', endReason: null, workFinished: false },
  // A settled landing container: finished work with no end reason.
  'settled landing': { phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: null, workFinished: true },
};

/** The Background mark's inputs per case: `sessionActivitySql` and the jobs and shells still running. */
const BACKGROUND: Record<string, { activity: string | null; runningBgCount: number }> = {
  PENDING: { activity: 'TURN', runningBgCount: 0 },
  RUNNING: { activity: 'TURN', runningBgCount: 0 },
  AWAITING_INPUT: { activity: null, runningBgCount: 0 },
  INTERRUPTED: { activity: null, runningBgCount: 0 },
  SUCCEEDED: { activity: null, runningBgCount: 0 },
  FAILED: { activity: null, runningBgCount: 0 },
  CANCELLED: { activity: null, runningBgCount: 0 },
  'job running': { activity: 'BACKGROUND_JOB', runningBgCount: 1 },
  'waiting on an approval': { activity: 'TURN', runningBgCount: 0 },
  'watch armed': { activity: 'WAITING', runningBgCount: 0 },
  'paused account': { activity: 'TURN', runningBgCount: 0 },
  'settled landing': { activity: null, runningBgCount: 0 },
};

/** Every kind the phase fields are read on: the legacy golden's, then the search hit. */
const KINDS = [...PAYLOAD_KINDS, SEARCH_HIT] as const;

test('the fixture, the expectations and the contract name the same cases and payload kinds', () => {
  assert.deepEqual(FIXTURE_CASES.map((c) => c.label), Object.keys(EXPECTED));
  assert.deepEqual(FIXTURE_CASES.map((c) => c.label), Object.keys(BACKGROUND));
  assert.deepEqual(Object.keys(CONTRACT.payloads), [...KINDS]);
  assert.deepEqual(CONTRACT.vectors.map((v) => v.id), Object.keys(EXPECTED));
  for (const vector of CONTRACT.vectors) assert.deepEqual(vector.expect, EXPECTED[vector.id], vector.id);
});

test('every payload kind carries the six fields and the background inputs, alike, for every case', { skip }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const stack = connect(URL!);
  try {
    const world = await buildWorld(stack.db, randomUUID().slice(0, 8));
    const payloads = await readPayloads(stack, world);
    const differences: string[] = [];
    const names = [...SESSION_PHASE_FIELD_NAMES, ...SESSION_BACKGROUND_FIELD_NAMES];
    for (const c of FIXTURE_CASES) {
      for (const kind of KINDS) {
        const payload = payloads.get(c.label)![kind];
        // Search answers CONVERSATION rows only: the landing container is never a hit, and every other case is one.
        if (kind === SEARCH_HIT && payload === null) {
          if (c.label !== 'settled landing') differences.push(`${c.label} / ${kind}: no hit`);
          continue;
        }
        const got = Object.fromEntries(names.map((field) => [field, payload![field]]));
        const want = { ...EXPECTED[c.label], ...BACKGROUND[c.label] };
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          differences.push(`${c.label} / ${kind}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    assert.deepEqual(differences, [], `\n${differences.join('\n')}\n`);
  } finally {
    await stack.db.$disconnect();
  }
});
