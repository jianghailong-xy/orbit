import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  INTEGRATION_JOB_PHASES,
  INTEGRATION_JOB_STATES,
  REPORTABLE_JOB_PHASES,
  REPORTABLE_JOB_STATES,
  isTerminalJobState,
  observationRefusal,
} from '../projects/project-integration-job';
import {
  IntegrationJobRefused,
  applyIntegrationJobResult,
} from './integration-job-relay';

/**
 * 0453 put OBSERVED and OBSERVE in the job closed sets (contract §10.4), and R29-5 hands a runner an
 * OBSERVE_LANDING (§10.6): the runner doors take both now, and which of them fits a job is the job's
 * kind — OBSERVED and OBSERVE are an observation's alone, and an observation ends only OBSERVED, ERROR
 * or CANCELLED. What an OBSERVED result says is read whole before anything is read from the database.
 */

/** Never reached: the refusals below come before the first query. */
const NO_DATABASE = {} as never;
const CLAIM = { claimGeneration: '1', leaseOwner: 'runner-process' };

const refusedAs = (message: string) => (error: unknown): boolean => {
  assert.ok(error instanceof IntegrationJobRefused, String(error));
  assert.equal(error.refusal, 'INVALID_RESULT');
  assert.equal(error.message, message);
  return true;
};

test('§10.4 §10.6: OBSERVED is a final state, and the runner doors take the whole closed sets', () => {
  assert.equal(isTerminalJobState('OBSERVED'), true, 'J4: an OBSERVED job is final');
  assert.deepEqual([...REPORTABLE_JOB_STATES], [...INTEGRATION_JOB_STATES]);
  assert.deepEqual([...REPORTABLE_JOB_PHASES], [...INTEGRATION_JOB_PHASES]);
});

test('§10.6: OBSERVED and OBSERVE fit an OBSERVE_LANDING alone, which ends OBSERVED, ERROR or CANCELLED', () => {
  assert.equal(observationRefusal('OBSERVE_LANDING', { state: 'OBSERVED', phase: 'OBSERVE' }), null);
  assert.equal(observationRefusal('OBSERVE_LANDING', { state: 'ERROR', phase: 'FETCH' }), null);
  assert.equal(observationRefusal('OBSERVE_LANDING', { state: 'CANCELLED' }), null);
  assert.equal(observationRefusal('OBSERVE_LANDING', { phase: 'OBSERVE' }), null);
  assert.equal(observationRefusal('LAND_TASK', { state: 'LANDED', phase: 'PUSH' }), null);

  assert.equal(observationRefusal('LAND_TASK', { state: 'OBSERVED' }), 'OBSERVED is not a result of a LAND_TASK job');
  assert.equal(observationRefusal('CHECK_PROMOTION', { phase: 'OBSERVE' }), 'a CHECK_PROMOTION job has no OBSERVE step');
  assert.equal(observationRefusal('OBSERVE_LANDING', { state: 'ALREADY_LANDED' }),
    'ALREADY_LANDED is not a result of an OBSERVE_LANDING job');
  assert.equal(observationRefusal('OBSERVE_LANDING', { phase: 'PUSH' }), 'an OBSERVE_LANDING job has no PUSH step');
});

test('§10.6 O-S3: an OBSERVED result whose observations cannot be read is refused before the database', async () => {
  const jobId = randomUUID();
  await assert.rejects(
    applyIntegrationJobResult(NO_DATABASE, { jobId, body: { ...CLAIM, state: 'OBSERVED' } }),
    refusedAs('an OBSERVED result carries observations: one per task its command named'),
  );
  const observation = {
    taskId: randomUUID(), deliveredSha: 'a'.repeat(40), baseSha: null,
    onUpstream: true, onIntegrationLine: null, empty: false, fullyApplied: null,
  };
  await assert.rejects(
    applyIntegrationJobResult(NO_DATABASE, {
      jobId, body: { ...CLAIM, state: 'OBSERVED', observations: [{ ...observation, deliveredSha: 'abc' }] },
    }),
    refusedAs('observation 0: deliveredSha is not a full commit sha'),
  );
  await assert.rejects(
    applyIntegrationJobResult(NO_DATABASE, {
      jobId, body: { ...CLAIM, state: 'OBSERVED', observations: [{ ...observation, onUpstream: 'yes' as never }] },
    }),
    refusedAs('observation 0: onUpstream and empty are booleans'),
  );
  await assert.rejects(
    applyIntegrationJobResult(NO_DATABASE, {
      jobId, body: { ...CLAIM, state: 'OBSERVED', upstreamSha: 'main', observations: [observation] },
    }),
    refusedAs('upstreamSha is not a full commit sha'),
  );
});
