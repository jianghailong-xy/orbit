import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerOs, withRunnerOs } from './runner-platform';

test('the OS a runner names replaces the one it named before, beside its other declarations', () => {
  const declared = ['session-worktree-ops-v1', 'provider:antigravity'];
  assert.deepEqual(withRunnerOs(declared, 'linux'), ['session-worktree-ops-v1', 'provider:antigravity', 'os:linux']);
  assert.deepEqual(withRunnerOs([...declared, 'os:linux'], ' Darwin '), [...declared, 'os:darwin']);
  // Absent — an older runner — or not an OS name: no claim about the machine survives.
  for (const header of [undefined, '', 'mac os', 'darwin; rm -rf', 'x'.repeat(33), ['']]) {
    assert.deepEqual(withRunnerOs([...declared, 'os:linux'], header as string | undefined), declared, JSON.stringify(header));
  }
  // Only the header declares it: an `os:` the capability list itself carried is not one.
  assert.deepEqual(withRunnerOs(['os:linux'], undefined), []);
});

test('the OS reads back as the runner named it, or not at all', () => {
  assert.equal(runnerOs(['session-worktree-ops-v1', 'os:darwin']), 'darwin');
  assert.equal(runnerOs(['session-worktree-ops-v1']), null);
  assert.equal(runnerOs(undefined), null);
});
