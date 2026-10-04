import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastLandingCheck } from './project-integration-line';

test('landing checks require actual complete check results to pass', () => {
  for (const checks of [undefined, null, [], {}, [null], [{}], [{ exitCode: 0 }]]) {
    assert.equal(lastLandingCheck(checks), 'UNKNOWN');
  }
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: 0, timedOut: false }]), 'PASSING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 2, exitCode: 2, timedOut: false }]), 'PASSING');
});

test('a failed or timed out check is failing, even if another result is missing', () => {
  assert.equal(lastLandingCheck([
    { expectedExitCode: 0, exitCode: 0, timedOut: false },
    { expectedExitCode: 0, exitCode: 1, timedOut: false },
  ]), 'FAILING');
  assert.equal(lastLandingCheck([{}, { expectedExitCode: 0, exitCode: null, timedOut: true }]), 'FAILING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: null, timedOut: false }]), 'UNKNOWN');
});
