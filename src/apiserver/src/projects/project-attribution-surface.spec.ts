import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTRIBUTION_ABSENT_REASONS,
  acceptanceStaleReason,
  admitReopen,
  reopenImpact,
  taskAttribution,
  type TaskAttributionFacts,
} from './project-attribution-surface';

/**
 * Unit L7, the pure half.
 *
 * What is tested here is what a client would otherwise have to decide for itself: whether an old
 * PASS still counts, whether a fact is absent or unknown, and what reopening a settled project
 * costs. Each of those is one derivation with several clients downstream, so the tests are about
 * the derivation being SINGLE and TOTAL rather than about any one screen.
 */

const PROJECT = {
  projectId: '00000000-0000-7000-8000-0000000000aa',
  title: 'Coordinator control loop',
  status: 'OPEN' as const,
  acceptanceEpoch: '3',
};

function facts(over: Partial<TaskAttributionFacts> = {}): TaskAttributionFacts {
  return {
    taskId: '00000000-0000-7000-8000-000000000011',
    owning: PROJECT,
    discovery: { project: null, triggerEvent: null, task: null, session: null },
    acceptance: [],
    crossing: null,
    blocker: null,
    ...over,
  };
}

function link(over: Partial<TaskAttributionFacts['acceptance'][number]> = {}) {
  return {
    runId: '00000000-0000-7000-8000-0000000000f1',
    attempt: '2',
    ordinal: 1,
    criterionKey: 'abcd',
    text: 'the loop never silently idles',
    verdict: 'PASS' as const,
    epoch: '3',
    runSuperseded: false,
    ...over,
  };
}

test('L7-A1: every absent fact is null beside a reason from the closed set', () => {
  const view = taskAttribution(facts({ owning: null }));
  assert.equal(view.owning, null);
  assert.equal(view.owningAbsentReason, 'FILED_UNDER_NO_PROJECT');
  assert.equal(view.discovery.absentReason, 'NO_DISCOVERY_RECORDED');
  assert.equal(view.acceptanceAbsentReason, 'NOT_CITED_BY_ACCEPTANCE');
  assert.equal(view.crossingAbsentReason, 'NO_CROSSING_DECLARED');
  assert.equal(view.blockerAbsentReason, 'NOTHING_BLOCKING_ATTRIBUTION');
  for (const reason of [
    view.owningAbsentReason,
    view.discovery.absentReason,
    view.acceptanceAbsentReason,
    view.crossingAbsentReason,
    view.blockerAbsentReason,
  ]) {
    assert.ok(
      ATTRIBUTION_ABSENT_REASONS.includes(reason!),
      `${reason} must be a member of the frozen set a client branches on`,
    );
  }
});

test('L7-A2: a fact that IS present carries no absent reason', () => {
  const view = taskAttribution(facts({
    discovery: {
      project: { ...PROJECT, projectId: '00000000-0000-7000-8000-0000000000bb', title: 'Other' },
      triggerEvent: 'session.transcript',
      task: { taskId: '00000000-0000-7000-8000-000000000012', title: 'the task that noticed it' },
      session: { sessionId: '00000000-0000-7000-8000-000000000013', title: null },
    },
    acceptance: [link()],
  }));
  assert.equal(view.owningAbsentReason, null);
  assert.equal(view.discovery.absentReason, null);
  assert.equal(view.discovery.recorded, true);
  assert.equal(view.acceptanceAbsentReason, null);
});

test('L7-A3: a trigger event alone counts as a discovery source', () => {
  // The four columns are independent: a coordinator that noticed work in its own transcript
  // records the event and no source row. Reporting that as "nothing recorded" would erase the one
  // fact there is.
  const view = taskAttribution(facts({
    discovery: { project: null, triggerEvent: 'user.manual_trigger', task: null, session: null },
  }));
  assert.equal(view.discovery.recorded, true);
  assert.equal(view.discovery.absentReason, null);
});

test('L7-A4: SC7 travels with the payload — discovery is labelled evidence, always', () => {
  assert.equal(taskAttribution(facts()).discovery.authority, 'EVIDENCE_ONLY');
  assert.equal(
    taskAttribution(facts({
      discovery: { project: PROJECT, triggerEvent: null, task: null, session: null },
    })).discovery.authority,
    'EVIDENCE_ONLY',
  );
});

test('L7-A5: a PASS from an earlier epoch is readable and is NOT current', () => {
  const view = taskAttribution(facts({ acceptance: [link({ epoch: '2' })] }));
  assert.equal(view.acceptance.length, 1);
  assert.equal(view.acceptance[0].verdict, 'PASS', 'the old conclusion stays readable');
  assert.equal(view.acceptance[0].current, false);
  assert.equal(view.acceptance[0].staleReason, 'EPOCH_ADVANCED');
});

test('L7-A6: superseded inside the same epoch is a DIFFERENT answer from a reopen', () => {
  const reopened = taskAttribution(facts({ acceptance: [link({ epoch: '2' })] })).acceptance[0];
  const rerun = taskAttribution(facts({ acceptance: [link({ runSuperseded: true })] })).acceptance[0];
  assert.equal(reopened.staleReason, 'EPOCH_ADVANCED');
  assert.equal(rerun.staleReason, 'RUN_SUPERSEDED');
  assert.notEqual(
    reopened.staleReason,
    rerun.staleReason,
    'a reader has to be able to tell "reopened" from "run again"',
  );
});

test('L7-A7: the current epoch, not superseded, is current', () => {
  const view = taskAttribution(facts({ acceptance: [link()] }));
  assert.equal(view.acceptance[0].current, true);
  assert.equal(view.acceptance[0].staleReason, null);
});

test('L7-A8: a criterion citing a task that belongs to no project is not reported current', () => {
  // Fail closed, exactly as §4 R-d reads an unreadable project status as not OPEN: there is no
  // epoch to compare against, and "cannot tell" must not render as "yes".
  const view = taskAttribution(facts({ owning: null, acceptance: [link()] }));
  assert.equal(view.acceptance[0].current, false);
  assert.equal(view.acceptance[0].staleReason, 'EPOCH_ADVANCED');
});

test('L7-A9: acceptanceStaleReason prefers the epoch answer over the supersession one', () => {
  // Both are true after a reopen that also retired the run. The epoch is the one to report: it is
  // the fact about the PROJECT, and it is what the user has to act on.
  assert.equal(acceptanceStaleReason({ epoch: '2', runSuperseded: true }, '3'), 'EPOCH_ADVANCED');
});

test('L7-B1: reopening a settled project names both epochs before it is spent', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: '3', liveAcceptanceRuns: 2, legacyAccepted: false,
  });
  assert.equal(impact.settled, true);
  assert.equal(impact.fromEpoch, '3');
  assert.equal(impact.toEpoch, '4');
  assert.equal(impact.retiringRuns, 2);
  assert.equal(impact.acknowledgement, '3');
  assert.equal(impact.refusalCode, null);
  assert.match(impact.requiredAction, /epoch 3/);
  assert.match(impact.requiredAction, /epoch 4/);
});

test('L7-B2: CANCELLED is settled too — 0150 advances the epoch for both', () => {
  const impact = reopenImpact({
    status: 'CANCELLED', acceptanceEpoch: '0', liveAcceptanceRuns: 0, legacyAccepted: false,
  });
  assert.equal(impact.settled, true);
  assert.equal(impact.toEpoch, '1');
});

test('L7-B3: an OPEN project has nothing to reopen and no epoch to advance', () => {
  const impact = reopenImpact({
    status: 'OPEN', acceptanceEpoch: '7', liveAcceptanceRuns: 1, legacyAccepted: false,
  });
  assert.equal(impact.settled, false);
  assert.equal(impact.toEpoch, '7', 'a refused reopen must not advertise an epoch it would not reach');
  assert.equal(impact.retiringRuns, 0);
  assert.equal(impact.acknowledgement, null);
  assert.equal(impact.refusalCode, 'PROJECT_NOT_SETTLED');
});

test('L7-B4: the epoch is 64-bit arithmetic, not a double', () => {
  const impact = reopenImpact({
    status: 'DONE',
    acceptanceEpoch: '9007199254740993',
    liveAcceptanceRuns: 0,
    legacyAccepted: false,
  });
  assert.equal(impact.toEpoch, '9007199254740994');
});

test('L7-B5: an unreadable epoch is not reported as a number this code invented', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: 'unknown', liveAcceptanceRuns: 0, legacyAccepted: false,
  });
  assert.equal(impact.toEpoch, 'unknown?');
});

test('L7-C1: a reopen with no acknowledgement is refused, and says which epoch to confirm', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: '3', liveAcceptanceRuns: 1, legacyAccepted: false,
  });
  const answer = admitReopen(impact, undefined);
  assert.equal(answer.allowed, false);
  assert.equal(answer.code, 'REOPEN_ACKNOWLEDGEMENT_REQUIRED');
  assert.match(answer.message, /epoch 3/);
});

test('L7-C2: an acknowledgement of the wrong epoch is refused, not rounded up', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: '4', liveAcceptanceRuns: 0, legacyAccepted: false,
  });
  const answer = admitReopen(impact, '3');
  assert.equal(answer.allowed, false);
  assert.equal(answer.code, 'REOPEN_ACKNOWLEDGEMENT_STALE');
  assert.match(answer.message, /4/);
  assert.match(answer.message, /3/);
});

test('L7-C3: the acknowledgement the preview hands out is the one that is accepted', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: '4', liveAcceptanceRuns: 0, legacyAccepted: true,
  });
  const answer = admitReopen(impact, impact.acknowledgement);
  assert.equal(answer.allowed, true);
  assert.equal(answer.code, null);
});

test('L7-C4: an empty acknowledgement is absent, not a match against an empty epoch', () => {
  const impact = reopenImpact({
    status: 'DONE', acceptanceEpoch: '0', liveAcceptanceRuns: 0, legacyAccepted: false,
  });
  assert.equal(admitReopen(impact, '').code, 'REOPEN_ACKNOWLEDGEMENT_REQUIRED');
  assert.equal(admitReopen(impact, '0').allowed, true, 'epoch 0 is a real epoch');
});

test('L7-C5: an OPEN project refuses the reopen whatever is acknowledged', () => {
  const impact = reopenImpact({
    status: 'OPEN', acceptanceEpoch: '2', liveAcceptanceRuns: 0, legacyAccepted: false,
  });
  assert.equal(admitReopen(impact, '2').code, 'PROJECT_NOT_SETTLED');
  assert.equal(admitReopen(impact, null).code, 'PROJECT_NOT_SETTLED');
});
