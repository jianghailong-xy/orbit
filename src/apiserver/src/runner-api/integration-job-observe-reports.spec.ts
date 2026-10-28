import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  INTEGRATION_JOB_PHASES,
  INTEGRATION_JOB_STATES,
  REPORTABLE_JOB_PHASES,
  REPORTABLE_JOB_STATES,
  isTerminalJobState,
} from '../projects/project-integration-job';
import {
  IntegrationJobRefused,
  applyIntegrationJobResult,
  receiveIntegrationJobProgress,
} from './integration-job-relay';

/**
 * 0453 put OBSERVED and OBSERVE in the job closed sets (contract §10.4), and nothing hands a runner an
 * OBSERVE_LANDING job yet (§10.6). So the runner doors answer a report naming either exactly as they
 * did before the sets grew: 400 INVALID_RESULT, before anything is read.
 */

/** Never reached: both refusals come before the first query. */
const NO_DATABASE = {} as never;
const CLAIM = { claimGeneration: '1', leaseOwner: 'runner-process' };

const refusedAs = (message: string) => (error: unknown): boolean => {
  assert.ok(error instanceof IntegrationJobRefused, String(error));
  assert.equal(error.refusal, 'INVALID_RESULT');
  assert.equal(error.message, message);
  return true;
};

test('§10.4: OBSERVED is a final state, and OBSERVED and OBSERVE are the only values a runner may not report', () => {
  assert.equal(isTerminalJobState('OBSERVED'), true, 'J4: an OBSERVED job is final');
  assert.deepEqual(INTEGRATION_JOB_STATES.filter((state) => !REPORTABLE_JOB_STATES.includes(state)), ['OBSERVED']);
  assert.deepEqual(INTEGRATION_JOB_PHASES.filter((phase) => !REPORTABLE_JOB_PHASES.includes(phase)), ['OBSERVE']);
});

test('§10.6: a result naming OBSERVED is refused as it was before 0453', async () => {
  await assert.rejects(
    applyIntegrationJobResult(NO_DATABASE, { jobId: randomUUID(), body: { ...CLAIM, state: 'OBSERVED' } }),
    refusedAs('OBSERVED is not a result'),
  );
});

test('§10.6: a progress report naming OBSERVE is refused as it was before 0453', async () => {
  await assert.rejects(
    receiveIntegrationJobProgress(NO_DATABASE, randomUUID(), randomUUID(), { ...CLAIM, phase: 'OBSERVE' }),
    refusedAs('unknown phase OBSERVE'),
  );
});
