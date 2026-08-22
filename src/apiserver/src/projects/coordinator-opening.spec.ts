import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { buildCoordinatorOpening, buildCoordinatorTurnMessage } from './coordinator-opening';
import {
  PROJECT_POLICY_MATRIX,
  ProjectAutomationPolicyValue,
  projectPolicyCell,
} from './project-authorization.service';

/**
 * §9.2's policy, in the two places the coordinator actually reads it (`PC-CX-65`).
 *
 * The defect these tests exist against was not a typo: the opening told every project's coordinator
 * "我没让你改的……由我来决定", which is `MANUAL`'s sentence. A `GUARDED_AUTO` project's control loop
 * dispatches, retries and opens blockers on its own, so its coordinator was being told to wait for a
 * person who was not coming — §10.1 AC3's silent idling, produced by the prompt.
 */

const PROJECT = '00000000-0000-7000-8000-000000003001';
const POLICIES: ProjectAutomationPolicyValue[] = ['MANUAL', 'GUARDED_AUTO', 'AUTO'];

function opening(policy: ProjectAutomationPolicyValue): string {
  return buildCoordinatorOpening('coordinate', PROJECT, policy);
}

function turn(policy?: ProjectAutomationPolicyValue): string {
  return buildCoordinatorTurnMessage({
    reasonCode: 'TASK_FAILURE',
    reasonDigest: 'd'.repeat(64),
    turnFacts: ['task#1'],
    suppressed: [],
    decisionId: 'decision',
    actionId: 'action',
    automationPolicy: policy,
  });
}

test('the opening names the project and the policy it is being opened under', () => {
  for (const policy of POLICIES) {
    const text = opening(policy);
    assert.ok(text.includes(uuidToBase62(PROJECT)), `${policy} opening lost the project id`);
    assert.ok(text.includes(`当前自动化策略是 ${policy}`), `${policy} opening does not state its policy`);
    assert.ok(
      text.includes('以你 project_get 读到的 automationPolicy 为准'),
      `${policy} opening presents the policy as permanent`,
    );
  }
});

test('MANUAL says the loop starts nothing; the other two say it does not need a button', () => {
  assert.match(opening('MANUAL'), /控制环不会自己派发任何任务，也不会自己重试失败的任务/);
  assert.match(opening('GUARDED_AUTO'), /这两件事你不用替它按/);
  assert.match(opening('AUTO'), /派发、重试、验收、provider 兜底控制环都会自己做完/);

  // The sentence the defect was: MANUAL's stance, handed to a project whose loop is running.
  for (const policy of ['GUARDED_AUTO', 'AUTO'] as const) {
    assert.doesNotMatch(
      opening(policy),
      /我没让你改的/,
      `${policy} is still being told to wait for a person`,
    );
  }
});

test('every §9.2 row is accounted for, in the bucket the matrix puts it in', () => {
  // Derived, not restated: the paragraph is assembled by asking `projectPolicyCell` per row, so
  // this test compares the two answers rather than pinning prose. A row added to §9.2 with no
  // sentence would throw here (its text would be `undefined` in the output).
  for (const policy of POLICIES) {
    const text = opening(policy);
    const allowed = text.match(/它自己就会做，不用问人：(.+)。/)?.[1] ?? '';
    const approval = text.match(/它要先拿到人的批准才做：(.+)。/)?.[1] ?? '';
    const refused = text.match(/这些情况它会直接拒绝，等条件变了再自己重来：(.+)。/)?.[1] ?? '';
    const humanOnly = text.match(/永远只能由人来做：(.+)。/)?.[1] ?? '';
    assert.ok(!text.includes('undefined'), `${policy} has a §9.2 row with no sentence`);

    const counts = { ALLOW: 0, REQUIRE_APPROVAL: 0, DENY: 0 };
    for (const row of PROJECT_POLICY_MATRIX) counts[projectPolicyCell(policy, row.id)] += 1;
    const bucketed = [allowed, approval, refused, humanOnly]
      .filter((bucket) => bucket.length > 0)
      .map((bucket) => bucket.split('；').length);
    assert.equal(
      bucketed.reduce((sum, n) => sum + n, 0),
      PROJECT_POLICY_MATRIX.length,
      `${policy} does not account for all ${PROJECT_POLICY_MATRIX.length} §9.2 rows`,
    );
    assert.equal(allowed === '' ? 0 : allowed.split('；').length, counts.ALLOW, `${policy} ALLOW`);
    assert.equal(
      approval === '' ? 0 : approval.split('；').length,
      counts.REQUIRE_APPROVAL,
      `${policy} REQUIRE_APPROVAL`,
    );
    // DENY splits in two: PROHIBITED rows are "only a person may", the rest are "not right now".
    assert.equal(
      (refused === '' ? 0 : refused.split('；').length)
        + (humanOnly === '' ? 0 : humanOnly.split('；').length),
      counts.DENY,
      `${policy} DENY`,
    );
  }
});

test('MANUAL retries nothing by itself, and the paragraph says so out of the matrix', () => {
  // §9.5's ladder is `DISPATCH_RETRY`, which is REQUIRE_APPROVAL under MANUAL and ALLOW under the
  // other two. That is the one row a failure-handling coordinator most needs to know about.
  assert.equal(projectPolicyCell('MANUAL', 'DISPATCH_RETRY'), 'REQUIRE_APPROVAL');
  assert.match(opening('MANUAL'), /它要先拿到人的批准才做：[^\n]*失败的任务在退避到期后重试/);
  for (const policy of ['GUARDED_AUTO', 'AUTO'] as const) {
    assert.match(opening(policy), /它自己就会做，不用问人：[^\n]*失败的任务在退避到期后重试/);
  }
});

test('a turn carries the policy it was delivered under, and defaults to the strictest', () => {
  assert.match(turn('AUTO'), /这个项目设成 AUTO/);
  assert.match(turn('GUARDED_AUTO'), /这个项目设成 GUARDED_AUTO/);
  assert.match(turn('MANUAL'), /这个项目设成 MANUAL/);
  // An absent policy — an old caller, a fixture — must under-promise rather than over-promise.
  assert.match(turn(), /这个项目设成 MANUAL/);
});

test('a turn still carries its reason, its ids and its snapshot warning', () => {
  const text = turn('GUARDED_AUTO');
  assert.match(text, /reasonCode: TASK_FAILURE/);
  assert.match(text, /自动重试要么已经用完，要么这次失败没有归因/);
  assert.match(text, /- decision: decision/);
  assert.match(text, /- action: action/);
  assert.match(text, /它是快照，不是现在/);
});
