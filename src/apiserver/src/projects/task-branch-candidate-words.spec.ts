import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPEN_ITEM_DOOR_TABLE, doorsForOpenItem } from './open-item-doors';
import { openItemActions, openItemMessage, openItemRequiredAction, primaryAction } from './project-open-item';

/**
 * What a failed candidate's item says, by the candidate's source (§10.5 O-L8).
 *
 * On a MAIN line a finished task's branch is the candidate, and its failure used to be told in words
 * written for a PROJECT_BRANCH candidate: that no task stands behind the item, and that a project
 * branch that does not exist should be repaired. The payload now says when the source is TASK_BRANCH,
 * and only then do the words change. `promotion-named-by-commit.pg.spec.ts` (8) drives the same four
 * classes through the relay and the doors, and pins what these words promise.
 *
 * Every "before" below is copied byte for byte from what `openItemMessage` and `openItemRequiredAction`
 * rendered on d5e899d33, the commit before the field. A payload without the field reads as it did on
 * that commit, so the second half of this file also passes against it, and the first half does not.
 */

const PROJECT = '01a0f5c8-0000-7000-8000-000000000001';
const CANDIDATE = '01a0f5c8-0000-7000-8000-000000000002';
const ITEM = '01a0f5c9-0000-7000-8000-00000000000b';
/** The same three ids as the text prints them. */
const PROJECT_SHOWN = '34YB9xs5JOkPXdY7GFHnt';
const CANDIDATE_SHOWN = '34YB9xs5JOkPXdY7GFHnu';
const ITEM_SHOWN = '34YBBcuXbYEixBTiOAv75';

const RED = { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false, outputTail: 'not ok 1\n' };
const SLOW = { name: 'TASK_ACCEPTANCE', command: 'go test ./...', expectedExitCode: 0, exitCode: null, timedOut: true };

const CLASSES = ['CONFLICT', 'CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR'] as const;
type FailureClass = (typeof CLASSES)[number];
const HOLDERS = ['COORDINATOR', 'OWNER'] as const;
const JOB_KINDS = ['CHECK_PROMOTION', 'LAND_PROMOTION'] as const;

/** Each failure class as the relay writes it, in the shape `failurePayload` gives it, with no source. */
const FAILURES: Record<FailureClass, { kind: string; opening: string; payload: Record<string, unknown> }> = {
  CONFLICT: {
    kind: 'INTEGRATION_CONFLICT',
    opening: 'Merge conflict',
    payload: {
      jobKind: 'CHECK_PROMOTION', phase: 'REBASE', targetRef: 'refs/heads/main', targetSha: '9'.repeat(40),
      files: ['src/orders.ts'], nothingLanded: true, failureClass: 'CONFLICT', generation: 1, landingSessionId: null, round: null,
    },
  },
  CHECK_FAILED: {
    kind: 'INTEGRATION_CHECK_FAILED',
    opening: 'Checks failed on the combined tree',
    payload: { jobKind: 'CHECK_PROMOTION', check: RED, branchUnchanged: true, failureClass: 'CHECK_FAILED', generation: 1, landingSessionId: null, round: null },
  },
  CHECK_TIMED_OUT: {
    kind: 'INTEGRATION_CHECK_FAILED',
    opening: 'Checks failed on the combined tree',
    payload: { jobKind: 'CHECK_PROMOTION', check: SLOW, branchUnchanged: true, failureClass: 'CHECK_TIMED_OUT', generation: 1, landingSessionId: null, round: null },
  },
  ERROR: {
    kind: 'INTEGRATION_ERROR',
    opening: 'Integration error',
    payload: {
      jobKind: 'LAND_PROMOTION', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' },
      failureClass: 'ERROR', generation: 1, landingSessionId: null, round: null,
    },
  },
};

const PROJECT_TITLE = 'merging the project branch into main';
const TASK_TITLE = 'merging “Backfill order stats” into main';

/** The failure of `failureClass`, under `title`, with the source field when `source` is given. */
function failure(failureClass: FailureClass, title: string, source: Record<string, unknown> = {}, jobKind?: string) {
  const { kind, opening, payload } = FAILURES[failureClass];
  return {
    id: ITEM, kind, title: `${opening}: ${title}`, projectId: PROJECT, taskId: null, promotionId: CANDIDATE,
    payload: { ...payload, ...(jobKind ? { jobKind } : {}), ...source },
  };
}

const TASK_BRANCH = { sourceKind: 'TASK_BRANCH' };

const nextStepOf = (row: ReturnType<typeof failure>, assignee: string, mainBranch: string | null = 'main') =>
  openItemRequiredAction({ ...row, assignee, state: 'OPEN', mainBranch });

/** The name of every door any cell of the matrix holds, so a name this text may not use is not a list kept by hand. */
const EVERY_DOOR_NAME = [...new Set(OPEN_ITEM_DOOR_TABLE.flatMap((cell) =>
  cell.doors.flatMap((door) => (door.mcp ? [door.mcp, door.name] : [door.name]))))];

const held = (row: ReturnType<typeof failure>, assignee: string) =>
  doorsForOpenItem({ ...row, assignee }).filter((door) => door.implemented);

// ── the task's branch ─────────────────────────────────────────────────────────────────────────────

/** The next step of a TASK_BRANCH candidate's failure, class by class, on a project whose main branch is develop. */
const NEXT_STEPS: Record<FailureClass, Record<(typeof HOLDERS)[number], string>> = {
  CONFLICT: {
    COORDINATOR: 'This task’s branch cannot reach develop until this conflict is repaired — file a task that puts its work on develop.',
    OWNER: 'This task’s branch cannot reach develop until this conflict is repaired — file a task that puts its work on develop, or ask the coordinator to do it.',
  },
  CHECK_FAILED: {
    COORDINATOR: 'This task’s branch cannot reach develop until this integration is repaired — re-run it or file a fix task.',
    OWNER: 'Nothing on this task’s branch reaches develop until this check passes — re-run it or ask the coordinator to fix it.',
  },
  CHECK_TIMED_OUT: {
    COORDINATOR: 'This task’s branch cannot reach develop until this check finishes — re-run it with a reason or file a fix task.',
    OWNER: 'Nothing on this task’s branch reaches develop until this check passes — re-run it or ask the coordinator to fix it.',
  },
  ERROR: {
    COORDINATOR: 'This task’s branch cannot reach develop until this integration is repaired — re-run it or file a fix task.',
    OWNER: 'This task’s branch cannot reach develop until this integration is repaired — re-run it or ask the coordinator to fix it.',
  },
};

test('a task branch’s failure says the next step about that branch, in every class, for either holder, on either job', () => {
  for (const failureClass of CLASSES) {
    for (const jobKind of JOB_KINDS) {
      const row = failure(failureClass, TASK_TITLE, TASK_BRANCH, jobKind);
      for (const holder of HOLDERS) {
        const what = `${failureClass} ${jobKind} ${holder}`;
        const sentence = nextStepOf(row, holder, 'develop');
        assert.equal(sentence, NEXT_STEPS[failureClass][holder], what);
        assert.doesNotMatch(sentence, /project branch/i, what);
        assert.doesNotMatch(sentence, /No task stands behind/, what);
        assert.equal(nextStepOf(row, holder, null), sentence.replaceAll('develop', 'main'), `${what}, no repository bound`);
        assert.equal(nextStepOf(row, holder, 'main'), sentence.replaceAll('develop', 'main'), `${what}, on main`);
      }
    }
  }
});

test('each next step names only what that row’s own cell holds', () => {
  for (const failureClass of CLASSES) {
    for (const jobKind of JOB_KINDS) {
      const row = failure(failureClass, TASK_TITLE, TASK_BRANCH, jobKind);
      for (const holder of HOLDERS) {
        const what = `${failureClass} ${jobKind} ${holder}`;
        const sentence = nextStepOf(row, holder);
        const doors = held(row, holder);
        const holds = (name: string) => doors.some((door) => door.name === name);
        // A rerun, the fix, and asking the coordinator: the three things these sentences can offer.
        if (/re-run/.test(sentence)) assert.ok(holds('integration_retry'), `${what}: it offers a rerun`);
        if (/file a/.test(sentence)) assert.ok(holds('task_create'), `${what}: it offers a task`);
        if (/ask the coordinator/.test(sentence)) assert.ok(holds('return-to-coordinator'), `${what}: it offers the coordinator`);
        assert.equal(/re-run/.test(sentence), failureClass !== 'CONFLICT', `${what}: a conflict's cell holds no rerun`);
        assert.equal(/ask the coordinator/.test(sentence), holder === 'OWNER', `${what}: only the owner's cell can ask the coordinator`);
      }
    }
  }
});

test('the coordinator’s text speaks of the task’s branch in every class, and every door it names is one this cell holds', () => {
  const found = new Set<string>();
  for (const failureClass of CLASSES) {
    for (const jobKind of JOB_KINDS) {
      const row = failure(failureClass, TASK_TITLE, TASK_BRANCH, jobKind);
      const what = `${failureClass} ${jobKind}`;
      const told = openItemMessage(row);
      assert.doesNotMatch(told, /project branch/i, what);
      assert.doesNotMatch(told, /No task stands behind/, what);
      assert.match(told, /A task stands behind this item, the one its title names/, what);
      assert.match(told, /this task’s branch/, what);
      assert.match(told, /its own check and its own card for the account owner/, what);
      assert.match(told, new RegExp(`fixesOpenItemId: ${ITEM_SHOWN}`), what);

      // The text is read by the coordinator, whatever the row's own holder (`openItemDoorMessageNames`).
      const doors = held(row, 'COORDINATOR');
      for (const name of EVERY_DOOR_NAME.filter((door) => told.includes(door))) {
        found.add(name);
        assert.ok(doors.some((door) => door.mcp === name), `${what} names ${name}, which its cell does not hold`);
      }
      assert.equal(told.includes('integration_retry'), failureClass !== 'CONFLICT', `${what}: a conflict's cell holds no rerun`);
    }
  }
  // CONTROL: the census saw real names, or it proved nothing.
  assert.deepEqual([...found].sort(),
    ['ask_owner', 'integration_retry', 'merge_receipt', 'open_item_hand_over', 'open_item_resolve', 'task_create']);
});

test('a conflict on a task’s branch is answered by a new task in ordinary commits, not by the project branch’s recipe', () => {
  const told = openItemMessage(failure('CONFLICT', TASK_TITLE, TASK_BRANCH));
  assert.ok(told.includes(
    'Rerunning the check as it stands would conflict again, and more commits on this task’s branch do not change this candidate: '
      + 'it is one commit of that branch, replayed onto the tip of the project’s main branch. '
      + 'What answers this conflict is a new task: file one with task_create that puts this task’s work on that tip, resolving the '
      + `conflict in ordinary commits, and attach it to this item with fixesOpenItemId: ${ITEM_SHOWN}. `
      + 'Do not resolve it in a merge commit: a task’s branch lands by a rebase, which drops merge commits and meets the same conflict again. '
      + 'When that task is DONE its branch becomes a candidate of its own, with its own check and its own card for the account owner. '
      + 'Its landing leaves this candidate and this item as they are and does not bring this item back to you: '
      + 'once this task’s work is on the project’s main branch, close this item with open_item_resolve. '
      + 'Closing the last item about this candidate ends the candidate too, and its card leaves the account owner’s page (M-T14).\n',
  ), told);
  // Everything that recipe said, which is false here.
  assert.doesNotMatch(told, /sync task/);
  assert.doesNotMatch(told, /merges the upstream tip into its source branch/);
  assert.doesNotMatch(told, /opens a new candidate/);
  assert.doesNotMatch(told, /closes this candidate and this item with it/);
  assert.doesNotMatch(told, /superseded by a new landing/);
  // And the doors this cell does not hold, which a reader of a task's item would reach for first.
  assert.doesNotMatch(told, /task_reopen|task_get|task_start/);
});

test('M-T13 for a task branch: work already on main as other commits is answered by the receipt, in every class', () => {
  for (const failureClass of CLASSES) {
    const told = openItemMessage(failure(failureClass, TASK_TITLE, TASK_BRANCH));
    assert.ok(told.includes(
      'If this task’s work is already on the project’s main branch as other commits — cherry-picked, rebased or squashed there by hand — '
        + 'there is nothing to resolve: record the commit there that carries it with merge_receipt (result: ALREADY_MERGED, '
        + 'sessionId: the task’s work session, sourceBranch: this task’s branch, sourceSha: that commit, targetBranch: the project’s main branch). '
        + 'The receipt ends this candidate, its card and this item, and the task reads as landed.',
    ), `${failureClass}: ${told}`);
  }
  // A project branch's candidate is not ended by one task's receipt, so its text never offers one.
  for (const failureClass of CLASSES) {
    assert.doesNotMatch(openItemMessage(failure(failureClass, PROJECT_TITLE)), /merge_receipt/, failureClass);
  }
});

test('a red on a task’s branch: a fix is its own candidate, and only the account owner confirms the merge', () => {
  for (const failureClass of ['CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR'] as const) {
    const told = openItemMessage(failure(failureClass, TASK_TITLE, TASK_BRANCH));
    assert.ok(told.includes(
      'First work out whose red it is. If it is a code problem on this task’s branch, file a fix task with task_create and attach it to '
        + `this item with fixesOpenItemId: ${ITEM_SHOWN}. A fix does not change this candidate: it runs on a branch of its own, so it has to `
        + 'carry this task’s work with it. When that task is DONE its branch becomes a candidate of its own, with its own check and its own '
        + 'card for the account owner. Its landing leaves this candidate and this item as they are and does not bring this item back to you: '
        + 'once this task’s work is on the project’s main branch, close this item with open_item_resolve. '
        + 'Closing the last item about this candidate ends the candidate too, and its card leaves the account owner’s page (M-T14).\n',
    ), told);
    assert.ok(told.includes(`rerun this candidate’s check once with integration_retry (projectId: ${PROJECT_SHOWN}, promotionId: ${CANDIDATE_SHOWN}, `
      + 'reason: why this time will be different). Once the check passes, the merge is still confirmed by the account owner on the card, '
      + 'whatever the Automatic setting says: this door only brings the candidate back to a state where it can be merged, and merges nothing '
      + 'for anybody.\n'), told);
    assert.doesNotMatch(told, /done automatically by the Automatic/, failureClass);
    assert.ok(told.includes('When this candidate is merged or declined, or a merge of this task’s branch onto the project’s main branch is '
      + 'recorded, the platform closes this item itself. '), told);
  }
});

test('the field moves no door: the same cell, the same presses, the same lead, in every class', () => {
  for (const failureClass of CLASSES) {
    for (const jobKind of JOB_KINDS) {
      for (const holder of HOLDERS) {
        const what = `${failureClass} ${jobKind} ${holder}`;
        const before = { ...failure(failureClass, PROJECT_TITLE, {}, jobKind), assignee: holder, fuseEpisodeId: null, askable: true, state: 'OPEN' };
        const now = { ...before, payload: { ...before.payload, ...TASK_BRANCH } };
        assert.deepEqual(doorsForOpenItem(now), doorsForOpenItem(before), `${what}: the doors`);
        assert.deepEqual(openItemActions(now), openItemActions(before), `${what}: the presses`);
        assert.equal(primaryAction(now), primaryAction(before), `${what}: the lead`);
      }
    }
  }
});

test('an out-of-date runner’s two sentences read as they do on a project branch, beside the new words', () => {
  const missing = {
    ...failure('ERROR', TASK_TITLE, TASK_BRANCH, 'CHECK_PROMOTION'),
    payload: {
      jobKind: 'CHECK_PROMOTION', errorCode: 'SOURCE_BRANCH_MISSING', errorDetail: { ref: 'refs/heads/orbit/backfill' },
      failureClass: 'ERROR', generation: 1, sourceKind: 'TASK_BRANCH',
    },
  };
  const outdated = { ...missing, payload: { ...missing.payload, outdatedRunner: 'DeskMac' } };
  for (const holder of HOLDERS) {
    assert.equal(nextStepOf(outdated, holder), 'Update runner DeskMac, then run this check again.', holder);
    assert.equal(nextStepOf(missing, holder), NEXT_STEPS.ERROR[holder].replaceAll('develop', 'main'), `${holder}, a runner that is not out of date`);
  }
  const errorCode = 'The integration job ended with an error: SOURCE_BRANCH_MISSING.\n';
  assert.equal(openItemMessage(outdated), openItemMessage(missing).replace(errorCode, `${errorCode}Runner DeskMac does not declare `
    + 'integration-observe/v1, so it looked for this task\'s branch on the remote by name. That says nothing about whether '
    + 'the task has work to land. Update the runner, then run integration_retry on this candidate.\n'));
});

// ── byte for byte, on d5e899d33 ───────────────────────────────────────────────────────────────────

const PROJECT_NEXT_STEPS: Record<FailureClass, Record<(typeof HOLDERS)[number], string>> = {
  CONFLICT: {
    COORDINATOR: 'The project branch cannot reach main until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
    OWNER: 'The project branch cannot reach main until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
  },
  CHECK_FAILED: {
    COORDINATOR: 'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.',
    OWNER: 'Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.',
  },
  CHECK_TIMED_OUT: {
    COORDINATOR: 'The project branch cannot reach main until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
    OWNER: 'Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.',
  },
  ERROR: {
    COORDINATOR: 'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.',
    OWNER: 'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.',
  },
};

const OPENED = `An integration in project ${PROJECT_SHOWN} did not put the work on the integration line:\n`;

const YOURS = 'This item is yours. The platform does not by itself retry an integration that did not land, so no second job will appear on its own; '
  + 'what you have to judge is the next step.\n'
  + 'No task stands behind this item: it comes from the job of a promotion (merging the project branch into main), and such a job does no work for any single task.\n';

const ASK_OWNER_FIRST = 'If handling it runs into a trade-off only the account owner can decide (skipping or changing the merge check, for example), ask with ask_owner '
  + '(with a recommended option and your reason): the item stays with you, and the answer comes back to this session as a turn; once you have taken it up, the platform '
  + 'does not hand it to the account owner because time ran out. Only what the account owner must handle in person (their device, account or keys) is handed to them, '
  + `with open_item_hand_over (projectId: ${PROJECT_SHOWN}, itemId: ${ITEM_SHOWN}, note: why).\n`;

const NOTHING_TO_REPORT = 'You do not need to report back. Where the platform cannot close it by itself — the work is already on the target branch some other way, '
  + 'or you have dealt with it separately — close it with open_item_resolve, giving your reason: it is marked handled (HANDLED), and your session and reason stay on the item.\n\n'
  + `Item id: ${ITEM_SHOWN}. This is a notice, not an interruption: the turn you were running was not interrupted by it, and you are reading it only after that turn ended, `
  + 'so go by the database state you have just read yourself.';

const CLOSED_BY = 'When this candidate is superseded by a new landing, declined or merged, the platform closes this item itself. ';

/** What a class a rerun answers was told after its facts: all three said the same. */
const RERUN_BEFORE = `First work out whose red it is. If it is a code problem on the project branch, file a fix task with task_create and attach it to this item with fixesOpenItemId: ${ITEM_SHOWN}; `
  + 'once it lands, the platform opens a new candidate.\n'
  + 'If it is not the work’s problem — the merge check’s baseline was repaired since, the check timed out (go test hitting its default 10-minute limit, for example), the integration machinery failed — '
  + `rerun this candidate’s check once with integration_retry (projectId: ${PROJECT_SHOWN}, promotionId: ${CANDIDATE_SHOWN}, reason: why this time will be different). `
  + 'Once the check passes, the merge is still confirmed by the account owner on the card, or done automatically by the Automatic setting under its usual rule: '
  + 'this door only brings the candidate back to a state where it can be merged, and merges nothing for anybody.\n'
  + 'If the merge-check command or its time limit has to change, or there is another trade-off only the account owner can decide, ask with ask_owner, giving at least two options, '
  + 'with the reason in the recommended one.\n'
  + ASK_OWNER_FIRST
  + CLOSED_BY
  + 'After you rerun the check with integration_retry, this item shows as being handled and stays open until the rerun job has a result: if the check passes, it is marked handled (HANDLED) '
  + 'automatically, with your session and reason recorded; if it fails again, it is marked superseded (RETRIED), and the new failure opens an item of its own. '
  + NOTHING_TO_REPORT;

/** The coordinator's text on d5e899d33: everything after the title. */
const TOLD_BEFORE: Record<FailureClass, string> = {
  CONFLICT: `${OPENED}Merge conflict (REBASE); the target branch refs/heads/main did not move.\nConflicting files (1):\n- src/orders.ts\n`
    + 'Failure class: CONFLICT (both sides changed the same place, and git cannot merge them).\n\n'
    + YOURS
    + 'Only a project branch that changed can resolve a conflict: rerunning the check as it stands would conflict again. File a sync task with task_create that starts from the project branch tip '
    + `and merges the upstream tip into its source branch, resolving the conflict and committing it; attach it to this item with fixesOpenItemId: ${ITEM_SHOWN}. `
    + 'Once that task lands, the platform opens a new candidate for the new branch tip and checks it again, and closes this candidate and this item with it.\n'
    + ASK_OWNER_FIRST
    + CLOSED_BY
    + NOTHING_TO_REPORT,
  CHECK_FAILED: `${OPENED}Check MERGE_CHECK exited with code 1 (its declaration expects 0); the target branch did not move.\nIt ran: npm test\nThe end of its output:\nnot ok 1\n\n`
    + 'Failure class: CHECK_FAILED (the check ran to the end, and its exit code disagrees with its declaration).\n\n'
    + YOURS + RERUN_BEFORE,
  CHECK_TIMED_OUT: `${OPENED}Check TASK_ACCEPTANCE exited with code null (its declaration expects 0); the target branch did not move.\nIt ran: go test ./...\n`
    + 'Failure class: CHECK_TIMED_OUT (a check was still running when its time budget ran out, and the platform stopped it before it reached a verdict).\n\n'
    + YOURS + RERUN_BEFORE,
  ERROR: `${OPENED}The integration job ended with an error: FETCH_FAILED.\nError detail: {"detail":"the remote hung up"}\n`
    + 'Failure class: ERROR (the integration job itself went wrong; this is not a check’s verdict).\n\n'
    + YOURS + RERUN_BEFORE,
};

const toldBefore = (failureClass: FailureClass, title: string) =>
  `From Orbit · exception item: ${FAILURES[failureClass].opening}: ${title}\n\n${TOLD_BEFORE[failureClass]}`;

test('a project branch’s failure says what it said, byte for byte, in every class', () => {
  for (const failureClass of CLASSES) {
    const row = failure(failureClass, PROJECT_TITLE);
    assert.equal(openItemMessage(row), toldBefore(failureClass, PROJECT_TITLE), failureClass);
    for (const holder of HOLDERS) {
      assert.equal(nextStepOf(row, holder), PROJECT_NEXT_STEPS[failureClass][holder], `${failureClass} ${holder}`);
      assert.equal(nextStepOf(row, holder, 'develop'), PROJECT_NEXT_STEPS[failureClass][holder].replaceAll(' main ', ' develop '), `${failureClass} ${holder}, on develop`);
    }
  }
});

test('a task branch’s item with no source field replays what it said, whichever title it was opened with (G6)', () => {
  for (const failureClass of CLASSES) {
    for (const title of [PROJECT_TITLE, TASK_TITLE]) {
      const row = failure(failureClass, title);
      assert.equal(openItemMessage(row), toldBefore(failureClass, title), `${failureClass}, ${title}`);
      for (const holder of HOLDERS) {
        assert.equal(nextStepOf(row, holder), PROJECT_NEXT_STEPS[failureClass][holder], `${failureClass} ${holder}, ${title}`);
      }
    }
  }
});

test('a source field that does not say TASK_BRANCH changes nothing', () => {
  for (const sourceKind of ['PROJECT_BRANCH', '', null, 7]) {
    for (const failureClass of CLASSES) {
      const row = failure(failureClass, PROJECT_TITLE, { sourceKind });
      assert.equal(openItemMessage(row), toldBefore(failureClass, PROJECT_TITLE), `${failureClass}, ${String(sourceKind)}`);
      for (const holder of HOLDERS) {
        assert.equal(nextStepOf(row, holder), PROJECT_NEXT_STEPS[failureClass][holder], `${failureClass} ${holder}, ${String(sourceKind)}`);
      }
    }
  }
});
