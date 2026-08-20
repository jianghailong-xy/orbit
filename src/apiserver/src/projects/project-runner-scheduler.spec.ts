import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleProjectRunner } from './project-runner-scheduler';

const candidate = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'workspace-a',
  runnerId: 'runner-a',
  available: true,
  capabilitiesReported: true,
  capabilities: ['shell', 'gpu'],
  position: 1,
  ...overrides,
});

for (const row of [
  { name: 'matches a reported requirement', required: ['GPU'], candidates: [candidate()], runner: 'runner-a' },
  { name: 'old runners remain compatible for empty requirements', required: [], candidates: [candidate({ capabilitiesReported: false, capabilities: [] })], runner: 'runner-a' },
  { name: 'old runners cannot prove a requirement', required: ['gpu'], candidates: [candidate({ capabilitiesReported: false })], runner: null },
  { name: 'offline runners do not match', required: [], candidates: [candidate({ available: false })], runner: null },
  { name: 'missing capabilities fail closed', required: ['arm64'], candidates: [candidate()], runner: null },
]) {
  test(`runner scheduler ${row.name}`, () => {
    const resolution = scheduleProjectRunner({ capabilities: row.required, candidates: row.candidates });
    assert.equal(resolution.selectedRunnerId, row.runner);
    assert.equal(resolution.failure?.code ?? null, row.runner ? null : 'NO_MATCHING_RUNNER');
  });
}

test('runner scheduler is deterministic and considers every candidate', () => {
  const resolution = scheduleProjectRunner({
    capabilities: [],
    candidates: [
      candidate({ workspaceId: 'workspace-b', runnerId: 'runner-b', position: null }),
      candidate({ workspaceId: 'workspace-a', runnerId: 'runner-a', position: 2 }),
    ],
  });
  assert.equal(resolution.selectedRunnerId, 'runner-a');
  assert.deepEqual(resolution.candidatesConsidered.map((item) => item.runnerId), ['runner-a', 'runner-b']);
});
