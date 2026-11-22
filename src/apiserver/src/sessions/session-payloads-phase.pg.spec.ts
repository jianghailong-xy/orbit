import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SESSION_PHASE_FIELD_NAMES } from '@orbit/shared';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { buildWorld, connect, FIXTURE_CASES, PAYLOAD_KINDS, readPayloads } from './session-payloads.fixture';

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

test('the fixture, the expectations and the contract name the same cases and payload kinds', () => {
  assert.deepEqual(FIXTURE_CASES.map((c) => c.label), Object.keys(EXPECTED));
  assert.deepEqual(Object.keys(CONTRACT.payloads), [...PAYLOAD_KINDS]);
  assert.deepEqual(CONTRACT.vectors.map((v) => v.id), Object.keys(EXPECTED));
  for (const vector of CONTRACT.vectors) assert.deepEqual(vector.expect, EXPECTED[vector.id], vector.id);
});

test('every payload kind carries the six fields, alike, for every case', { skip }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const stack = connect(URL!);
  try {
    const world = await buildWorld(stack.db, randomUUID().slice(0, 8));
    const payloads = await readPayloads(stack, world);
    const differences: string[] = [];
    for (const c of FIXTURE_CASES) {
      for (const kind of PAYLOAD_KINDS) {
        const payload = payloads.get(c.label)![kind];
        const got = Object.fromEntries(SESSION_PHASE_FIELD_NAMES.map((field) => [field, payload[field]]));
        const want = EXPECTED[c.label];
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
