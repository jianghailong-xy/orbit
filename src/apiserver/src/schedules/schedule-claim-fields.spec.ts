/**
 * The claim's schedule fields (docs/scheduled-tasks-design.md §6.2): `scheduledCheckOnly` is set for a CHECK_ONLY run's
 * session only, and both places that build a session's agent config for a runner (the claim and the reclaim) carry it
 * from the session's own schedule, beside the run's disallowed tools.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { scheduleRunAgentFields } from './schedule-access';

test('scheduleRunAgentFields: only a CHECK_ONLY run is flagged; OPEN_PR, no schedule and an unknown level are not', () => {
  assert.deepEqual(scheduleRunAgentFields('CHECK_ONLY'), { scheduledCheckOnly: true });
  assert.deepEqual(scheduleRunAgentFields('OPEN_PR'), {});
  assert.deepEqual(scheduleRunAgentFields(null), {});
  assert.deepEqual(scheduleRunAgentFields(undefined), {});
});

test('the claim and the reclaim both spread scheduleRunAgentFields from the session\'s schedule into its agent config', () => {
  // build/<dir>/x.spec.js at run time, src/<dir>/x.spec.ts in the tree: both sit two levels under the package.
  const root = join(__dirname, '..', '..', 'src');
  for (const [file, row] of [
    ['queue/queue.service.ts', 'session'],
    ['runner-api/runner-api.controller.ts', 's'],
  ] as const) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(
      source.includes(`...scheduleRunAgentFields(runAccessLevel(${row}.scheduleRun))`),
      `${file} must carry scheduledCheckOnly for a CHECK_ONLY run's session`,
    );
    assert.ok(
      source.includes('scheduleRun: { select: { accessLevel: true, schedule: { select: { accessLevel: true } } } }'),
      `${file} must read the level the session's run started with`,
    );
  }
});
