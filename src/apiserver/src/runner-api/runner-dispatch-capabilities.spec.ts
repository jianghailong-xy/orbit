import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRunnerCapabilities } from './runner-api.controller';

test('authenticated heartbeat capabilities are normalized as a declarative snapshot', () => {
  assert.deepEqual(
    parseRunnerCapabilities([' GPU, shell ', 'gpu,SESSION-WORKTREE-OPS-V1']),
    ['gpu', 'session-worktree-ops-v1', 'shell'],
  );
  assert.deepEqual(parseRunnerCapabilities(''), []);
  assert.equal(parseRunnerCapabilities(undefined), undefined);
});
