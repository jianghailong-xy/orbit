import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { COORDINATOR_LEAD_KINDS } from '@orbit/shared';

import { BLOCKER_DECISION, BLOCKER_REASONS, blockerRoute } from './blocker-disposition';
import { COORDINATOR_ACTIONS, COORDINATOR_AUTHORITY } from './coordinator-authority';
import {
  OPEN_ITEM_KINDS,
  deliveryReviewDetailLine,
  deliveryReviewKey,
  openItemActions,
  openItemFacts,
  openItemMessage,
  ownerItemKind,
} from './project-open-item';

/**
 * Who answers which question about a finished delivery, as rules — the layer under
 * `automatic-coordinator-routing.pg.spec.ts`, which drives the same rules through real rows.
 *
 * Task 34YBYkUc5zDszvHuhYEyh: a mechanical path warning in an Automatic project went to the account
 * owner as a CRITICAL blocker while the coordinator could only relay it back. These assert the table
 * that now decides it, and the words the coordinator is handed.
 */

test('a reading about the ruler is the owner’s blocker; a reading about the landing is the '
  + 'coordinator’s review', () => {
  // An argued exemption is a task's reason for keeping its own completion criterion: how that task
  // is judged, not the project's ruler (`blocker-disposition.ts`, BLOCKER_DECISION).
  assert.deepEqual(BLOCKER_REASONS.map((reason) => [reason, blockerRoute(reason)]), [
    ['CRITERION_EXEMPTION_ARGUED', 'EXCEPTION_ITEM'],
    ['ACCEPTANCE_STANDARD_MOVED', 'OWNER_BLOCKER'],
    ['OUTSIDE_DECLARED_SCOPE', 'EXCEPTION_ITEM'],
    ['MERGE_REFUSED_BY_GIT', 'EXCEPTION_ITEM'],
  ]);
});

test('the route is the tier of the act each reading asks for, and the owner keeps exactly the two '
  + 'acts about the ruler', () => {
  for (const reason of BLOCKER_REASONS) {
    const action = BLOCKER_DECISION[reason];
    assert.ok(COORDINATOR_ACTIONS.includes(action), `${reason} asks for an act nobody graded`);
    assert.equal(
      blockerRoute(reason) === 'OWNER_BLOCKER',
      COORDINATOR_AUTHORITY[action] === 'HUMAN_ONLY',
      `${reason} goes somewhere its tier does not say`,
    );
  }
  assert.deepEqual(
    COORDINATOR_ACTIONS.filter((action) => COORDINATOR_AUTHORITY[action] === 'HUMAN_ONLY').sort(),
    ['CONFIRM_ACCEPTANCE_CRITERIA', 'EDIT_ACCEPTANCE_CRITERIA'],
    'owner review grew or shrank: only the ruler is the owner’s alone',
  );
  assert.equal(COORDINATOR_AUTHORITY.DECIDE_TASK_LANDING, 'COORDINATOR_BOUNDED');
});

test('a delivery review is a kind the coordinator carries, with the doors any carried item has, '
  + 'and nothing the owner is asked while the coordinator has it', () => {
  assert.ok((OPEN_ITEM_KINDS as readonly string[]).includes('DELIVERY_REVIEW'));
  assert.ok((COORDINATOR_LEAD_KINDS as readonly string[]).includes('DELIVERY_REVIEW'),
    'the project list could not name what the coordinator is holding');
  assert.deepEqual(
    openItemActions({
      kind: 'DELIVERY_REVIEW', assignee: 'COORDINATOR', taskId: 't', promotionId: null,
      fuseEpisodeId: null, askable: true,
    }),
    ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  );
  assert.equal(deliveryReviewKey('OUTSIDE_DECLARED_SCOPE', 'task-1'), 'DR:OUTSIDE_DECLARED_SCOPE:task-1');
  assert.equal(
    ownerItemKind({ kind: 'DELIVERY_REVIEW', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }),
    null,
  );
  // Once it escalated it is the owner's, like every other exception that reached them.
  assert.equal(
    ownerItemKind({ kind: 'DELIVERY_REVIEW', assignee: 'OWNER', assigneeReason: 'ESCALATED' }),
    'ESCALATED',
  );
});

test('work that reached main without the owner\'s confirmation is the fifth owner item, by its own name '
  + '(§10.7, owner 2026-10-28)', () => {
  // The owner's from birth (DEFAULT), like a merge approval: not an escalation, and not nothing.
  assert.equal(
    ownerItemKind({ kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'OWNER', assigneeReason: 'DEFAULT' }),
    'LANDED_WITHOUT_CONFIRMATION',
  );
  assert.equal(
    ownerItemKind({ kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }),
    null,
    'an item with the coordinator is not the owner\'s, whatever its kind',
  );
});

const reviewPayload = {
  reason: 'OUTSIDE_DECLARED_SCOPE',
  paths: ['src/runner-go/worktree.go', 'src/shared/src/project-done.ts'],
  declaredPaths: ['src/apiserver/src/projects/project-owner-done.pg.spec.ts'],
  criterionKey: 'crit-3',
};

test('a delivery review asks the coordinator to decide, names every door, and says it is not the '
  + 'owner’s question', () => {
  const itemId = randomUUID();
  const message = openItemMessage({
    id: itemId,
    kind: 'DELIVERY_REVIEW',
    title: 'Changed files it didn’t declare: ③',
    projectId: randomUUID(),
    taskId: randomUUID(),
    payload: reviewPayload,
  });
  for (const want of [
    'mechanical scope warning', 'src/runner-go/worktree.go', 'src/shared/src/project-done.ts',
    'src/apiserver/src/projects/project-owner-done.pg.spec.ts', 'Accept the scope', 'open_item_resolve',
    'Send it back', 'task_reopen', 'Supersede it', 'supersedesTaskId', 'Rerun the landing', 'integration_retry',
    'once you take it up it stays yours', 'do not put it to the account owner as one', 'Automatic',
  ]) {
    assert.ok(message.includes(want), `the review message does not say ${JSON.stringify(want)}`);
  }
  // Revision 13 (§4.6): a review the coordinator took up is not handed to the owner on a clock.
  assert.ok(!message.includes('exceptionEscalationSeconds'), 'the review still threatens the escalation clock');
  assert.ok(!message.includes('merge into main'), 'a review is not an order to merge');
  // The rerun door is offered for what it accepts: a conflict is never rerun.
  assert.match(message, /a conflict cannot be rerun/);

  const refused = openItemMessage({
    id: itemId,
    kind: 'DELIVERY_REVIEW',
    title: 'Git refused to merge it: ③',
    projectId: randomUUID(),
    taskId: randomUUID(),
    payload: { reason: 'MERGE_REFUSED_BY_GIT', paths: ['src/a.ts'], declaredPaths: [] },
  });
  for (const want of ['git refused the merge', 'src/a.ts', 'merge_receipt', 'task_reopen', 'supersedesTaskId',
    'Do not rerun it as it stands']) {
    assert.ok(refused.includes(want), `the refused-merge message does not say ${JSON.stringify(want)}`);
  }
  assert.ok(!refused.includes('Rerun the landing:'), 'a refused merge was offered a rerun the door refuses');

  const many = openItemMessage({
    id: itemId,
    kind: 'DELIVERY_REVIEW',
    title: 'Changed files it didn’t declare: big',
    projectId: randomUUID(),
    taskId: randomUUID(),
    payload: { ...reviewPayload, paths: Array.from({ length: 45 }, (_, i) => `src/file-${i}.ts`) },
  });
  assert.ok(many.includes('and 5 more'), 'a long path list is not cut at a size a turn can carry');
});

test('an argued exemption is the coordinator’s review: it quotes the reason, offers the doors that '
  + 'judge it, and leaves a change to the ruler with the owner', () => {
  const argument = '判据 2 要求先复现修复前的 500，再证明修复后的行为——一条命令的退出码判定不了。';
  const payload = {
    reason: 'CRITERION_EXEMPTION_ARGUED', paths: [], declaredPaths: [], criterionKey: 'crit-2', argument,
  };
  const message = openItemMessage({
    id: randomUUID(),
    kind: 'DELIVERY_REVIEW',
    title: 'Kept the judgment method Orbit questioned: T2',
    projectId: randomUUID(),
    taskId: randomUUID(),
    payload,
  });
  for (const want of [
    argument, 'Orbit questioned it', 'does not judge whether it holds', 'Accept the reason', 'open_item_resolve',
    'Send it back', 'task_reopen', 'Supersede it', 'supersedesTaskId', 'the evidence it was judged on',
    'or its work lands', 'do not put it to the account owner as one',
    'that would be changing the acceptance criteria',
  ]) {
    assert.ok(message.includes(want), `the exemption review does not say ${JSON.stringify(want)}`);
  }
  assert.ok(!message.includes('Rerun the landing'), 'an argued exemption was offered a landing rerun');
  assert.ok(!message.includes('ask_owner'), 'the review named an owner door its cell does not have');
  assert.ok(!message.includes('a delivery that claims a criterion does not apply'),
    'the review still calls an argued exemption the owner’s blocker');

  const task = { id: 'task-2', title: 'T2' };
  assert.deepEqual(openItemFacts('DELIVERY_REVIEW', payload, task)?.review, {
    reason: 'CRITERION_EXEMPTION_ARGUED',
    declaredPaths: [],
    argument,
  });
  assert.equal(deliveryReviewDetailLine(payload), `Its reason: ${argument}`);
  assert.equal(deliveryReviewDetailLine({ ...payload, argument: `${'x'.repeat(200)}\n\ny` }),
    `Its reason: ${'x'.repeat(160)}…`);
  // Nothing to quote is nothing to draw, not an empty quotation.
  assert.equal(deliveryReviewDetailLine({ ...payload, argument: undefined }), '');
});

test('a classified landing failure reaches its coordinator as its own decision, with the rerun '
  + 'door and the class it failed of — never as a question for the owner', () => {
  const message = openItemMessage({
    id: randomUUID(),
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: ③',
    projectId: randomUUID(),
    taskId: randomUUID(),
    payload: {
      jobKind: 'LAND_TASK',
      check: {
        name: 'MERGE_CHECK', command: 'go test ./...', exitCode: 1, expectedExitCode: 0,
        outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel',
      },
      branchUnchanged: true,
      failureClass: 'CHECK_FAILED',
      generation: 1,
    },
  });
  for (const want of ['Failure class: CHECK_FAILED', 'integration_retry', 'task_reopen', 'fixesOpenItemId',
    'Whether such a landing goes ahead is yours to judge, not a question for the account owner']) {
    assert.ok(message.includes(want), `the failed-landing message does not say ${JSON.stringify(want)}`);
  }
  assert.ok(!message.includes('supersedesTaskId'), 'a DONE landing must not suggest a successor field');
  // The landing is never the owner's question. What ask_owner is offered for (revision 13) is a
  // trade-off only the owner can make while the coordinator handles it — and then the item stays
  // the coordinator's; it is handed over only for what the owner has to do in person.
  assert.equal(message.split('ask_owner').length - 1, 1, 'ask_owner is offered once, for one thing');
  assert.match(message, /a trade-off only the account owner can decide \(skipping or changing the merge check, for example\), ask with ask_owner/);
  assert.match(message, /the item stays with you/);
  assert.match(message, /Only what the account owner must handle in person \(their device, account or keys\) is handed to them, with open_item_hand_over/);
  assert.ok(!message.includes('If you cannot judge or handle it'), 'a failed landing is still handed over by default');
});

test('a delivery review reads back as the rows its card draws and one line under its title', () => {
  const task = { id: 'task-1', title: '③' };
  const facts = openItemFacts('DELIVERY_REVIEW', reviewPayload, task);
  assert.deepEqual(facts?.files, reviewPayload.paths);
  assert.deepEqual(facts?.review, {
    reason: 'OUTSIDE_DECLARED_SCOPE',
    declaredPaths: reviewPayload.declaredPaths,
  });
  assert.equal(facts?.failure, null);
  assert.equal(
    deliveryReviewDetailLine(reviewPayload),
    '2 files outside its declaration · src/runner-go/worktree.go · +1',
  );
  assert.equal(
    deliveryReviewDetailLine({ reason: 'MERGE_REFUSED_BY_GIT', paths: ['src/a.ts'] }),
    'Git refused 1 file · src/a.ts',
  );
  // A payload this build cannot read leaves nothing to draw rather than a wrong row.
  assert.equal(deliveryReviewDetailLine({ reason: 'SOMETHING_ELSE', paths: ['x'] }), '');
  assert.equal(openItemFacts('DELIVERY_REVIEW', { reason: 'SOMETHING_ELSE' }, task)?.review, null);
  // And the integration kinds are untouched by it: no review on a failed landing.
  const landing = openItemFacts('INTEGRATION_CONFLICT', { files: ['a.ts'] }, task);
  assert.deepEqual(landing?.files, ['a.ts']);
  assert.equal(landing?.review, null);
});
