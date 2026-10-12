import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion } from '@orbit/shared';

import { wikiPlanWaiting } from './wiki-plan-waiting';

/**
 * The spaces list's `planWaiting` (wiki-plan-waiting.ts) against the vectors the clients' own count is held
 * to: every case of `src/shared/src/wiki-docs.fixture.json` `plan.states` that says `pending`, read here as
 * web `lib/wikiPlan.test.ts` reads it for `wikiPlanPending` and OrbitKit `WikiPlanCopyParityTests` for
 * `WikiPlanLogic.pending` — the same state, whole, from its spec, and the same `runnerOnline`. One count,
 * three readers, one set of answers. The count over real rows, beside the plan read it must agree with, is
 * wiki-spaces-read.pg.spec.ts.
 */

interface StateCase {
  spec: { confirmed: 'v1' | null; draft: 'v2' | null; proposals: boolean; job: string | null; runnerOnline: boolean | null };
  pending?: number;
}

interface PlanFixture {
  versions: { v1: WikiPlanVersion; v2: WikiPlanVersion };
  proposals: WikiPlanProposal[];
  jobs: Record<string, WikiPlanJob>;
  states: Record<string, StateCase>;
}

// From build/wiki to the shared package's source, as fcm-transport.spec.ts reads its fixture.
const plan: PlanFixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/wiki-docs.fixture.json'), 'utf8')).plan;

/** A state, whole, from its spec in the fixture: its versions, proposals and job, each by name (`stateOf` in wikiPlan.test.ts). */
function stateOf(spec: StateCase['spec']): WikiPlanState {
  return {
    spaceId: 'sp1',
    confirmed: spec.confirmed ? plan.versions[spec.confirmed] : null,
    draft: spec.draft ? plan.versions[spec.draft] : null,
    proposals: spec.proposals ? plan.proposals : [],
    job: spec.job ? plan.jobs[spec.job] : null,
  };
}

const cases = Object.entries(plan.states).filter(([, state]) => typeof state.pending === 'number');

test('the fixture still has the plan cases the clients count from, each saying what waits', () => {
  assert.ok(cases.length >= 13, `only ${cases.length} cases say pending: the vectors were cut, and so was this check`);
  // Every kind of thing that waits is among them, and so is what only goes on.
  const expected = new Map(cases.map(([name, state]) => [name, state.pending]));
  assert.equal(expected.get('noneHeld'), 1, 'a draft held');
  assert.equal(expected.get('noneOffline'), 1, 'a draft made and not started, its runner offline');
  assert.equal(expected.get('writingHeld'), 1, 'the writing held');
  assert.equal(expected.get('draftFailed'), 1, 'a revision that failed');
  assert.equal(expected.get('draftReady'), 3, 'a draft to confirm and two proposals');
  assert.equal(expected.get('changes'), 2, 'two proposals');
  assert.equal(expected.get('writingStopped'), 0, 'a build that failed waits on nobody');
});

for (const [name, expected] of cases) {
  test(`planWaiting of «${name}» is the clients' pending: ${expected.pending}`, () => {
    assert.equal(wikiPlanWaiting(stateOf(expected.spec), expected.spec.runnerOnline), expected.pending);
  });
}

test('a runner the server cannot see is not offline: a job not started waits on nobody until one is known to be', () => {
  const state = stateOf(plan.states.noneOffline.spec);
  assert.equal(wikiPlanWaiting(state, false), 1);
  assert.equal(wikiPlanWaiting(state, null), 0);
  assert.equal(wikiPlanWaiting(state, true), 0);
});

test('a failed draft stops waiting once a version newer than its request is stored', () => {
  const failed = plan.jobs.failed;
  const base = stateOf(plan.states.draftFailed.spec);
  const later = { ...plan.versions.v2, createdAt: new Date(Date.parse(failed.requestedAt) + 1).toISOString() };
  assert.equal(wikiPlanWaiting(base, true), 1);
  // The newer version is a draft, which waits itself: the failure is answered, the draft is the one thing left.
  assert.equal(wikiPlanWaiting({ ...base, draft: later }, true), 1);
  assert.equal(wikiPlanWaiting({ ...base, confirmed: later }, true), 0);
});
