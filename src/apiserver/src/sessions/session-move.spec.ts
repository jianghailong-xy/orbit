import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeTargetOf } from './session-move';

const session = (over: Partial<{ mergeTarget: string | null; mergeTargets: string[] }> = {}) => ({
  mergeTarget: null,
  mergeTargets: ['main', 'master'],
  ...over,
});

test('project code tasks default their merge target to the integration branch', () => {
  assert.equal(mergeTargetOf(session(), 'workspace-default', 'refs/heads/project/alpha'), 'project/alpha');
});

test('an explicit session merge target still overrides the project line', () => {
  assert.equal(
    mergeTargetOf(session({ mergeTarget: 'release' }), 'workspace-default', 'refs/heads/project/alpha'),
    'release',
  );
});

test('sessions without a project line retain workspace and runner fallbacks', () => {
  assert.equal(mergeTargetOf(session(), 'workspace-default'), 'workspace-default');
  assert.equal(mergeTargetOf(session({ mergeTargets: ['master'] }), null), 'master');
});
