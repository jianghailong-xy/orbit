import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspacesWithChangedRepoHealth } from './runner-repo-health';

const entry = (extra: Record<string, unknown>) => ({ root: '/r', state: 'dirty', agentIds: ['w1', 'w2'], ...extra });

test('a change in counts names every workspace on that checkout', () => {
  assert.deepEqual(workspacesWithChangedRepoHealth([entry({ fileCount: 3 })], [entry({ fileCount: 1, ahead: 1 })]), ['w1', 'w2']);
});

test('key order and dropped garbage are not a change', () => {
  assert.deepEqual(
    workspacesWithChangedRepoHealth([entry({ fileCount: 3 })], [{ fileCount: 3, agentIds: ['w1', 'w2'], state: 'dirty', root: '/r', bogus: 1 }]),
    [],
  );
});

test('a checkout that went clean, appeared or disappeared is a change', () => {
  assert.deepEqual(workspacesWithChangedRepoHealth([entry({ agentIds: ['w1'] })], [entry({ agentIds: ['w1'], state: 'clean' })]), ['w1']);
  assert.deepEqual(workspacesWithChangedRepoHealth(null, [entry({ agentIds: ['w1'] })]), ['w1']);
  assert.deepEqual(workspacesWithChangedRepoHealth([entry({ agentIds: ['w1'] })], []), ['w1']);
});
