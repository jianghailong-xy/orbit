import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPEN_ITEM_DOOR_TABLE,
  doorsForOpenItem,
  type OpenItemDoorCell,
} from './open-item-doors';
import {
  coordinatorUnreachable,
  openItemActions,
  openItemRequiredAction,
  ownerItemNeed,
  primaryAction,
  readCoordinatorReach,
  type SessionEnding,
} from './project-open-item';

/**
 * The sentence and its lead are a projection of the capability table, not a second table.  Keep
 * one representative row for every registered cell so adding a source/failure/assignee cell
 * cannot silently leave the card without words or a door.
 */
function rowFor(cell: OpenItemDoorCell) {
  const promotionSource = cell.sourceJob === 'CHECK_PROMOTION' || cell.sourceJob === 'LAND_PROMOTION';
  const taskKind = cell.todoType === 'TASK_FAILED'
    || cell.todoType.startsWith('INTEGRATION_')
    || cell.todoType === 'DELIVERY_REVIEW';
  return {
    kind: cell.todoType,
    assignee: cell.assignee,
    taskId: taskKind ? 'task-id' : null,
    promotionId: promotionSource || cell.todoType === 'PROMOTION_APPROVAL' ? 'promotion-id' : null,
    fuseEpisodeId: cell.todoType === 'FUSE_PAUSED' ? 'episode-id' : null,
    askable: true,
    sourceJob: cell.sourceJob,
    failureClass: cell.failureClass,
    payload: {
      jobKind: cell.sourceJob,
      phase: cell.sourceJob === 'MAIN_SYNC' ? 'MAIN_SYNC' : undefined,
      failureClass: cell.failureClass,
    },
    state: 'OPEN',
  } as const;
}

test('every open-item door cell has a required sentence and a backed primary action', () => {
  assert.ok(OPEN_ITEM_DOOR_TABLE.length > 0);
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const row = rowFor(cell);
    const sentence = openItemRequiredAction(row);
    assert.match(sentence, /\S+/, `empty requiredAction for ${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`);
    assert.match(sentence, /[.!?]$/, `requiredAction is not a sentence for ${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`);

    const action = primaryAction(row);
    const actionDoors = cell.doors.filter((door) => door.implemented && door.action !== undefined);
    if (action == null) {
      // START_REQUEST and DONE_REQUEST have dedicated request routes rather than an OpenItemAction
      // enum member; every other cell has a compact action.
      assert.equal(actionDoors.length, 0,
        `a cell with compact doors lost its primary action: ${JSON.stringify(cell)}`);
    } else {
      assert.ok(actionDoors.some((door) => door.action === action && door.holder === cell.assignee),
        `${action} is not a door held by ${cell.assignee}: ${JSON.stringify(cell)}`);
    }
  }
});

test('promotion check failure owned by the account owner keeps the approved copy', () => {
  assert.equal(openItemRequiredAction({
    kind: 'INTEGRATION_CHECK_FAILED',
    assignee: 'OWNER',
    taskId: null,
    promotionId: 'promotion-id',
    fuseEpisodeId: null,
    sourceJob: 'CHECK_PROMOTION',
    failureClass: 'CHECK_FAILED',
    state: 'OPEN',
  }), 'Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.');
});

/**
 * 2026-11-16: an owner card said "until this check passes" over a check marked "timed out after 4h".
 * A timed-out promotion check is the owner's timeout sentence too, on both promotion jobs and both
 * kinds of candidate, naming the coordinator only while Ask again is drawn; a failed one keeps the
 * approved copy.
 */
test('an owner’s timed-out promotion check says it must finish, and a failed one that it must pass', () => {
  for (const sourceJob of ['CHECK_PROMOTION', 'LAND_PROMOTION'] as const) {
    for (const taskBranch of [false, true]) {
      for (const askable of [true, false]) {
        const row = {
          kind: 'INTEGRATION_CHECK_FAILED',
          assignee: 'OWNER',
          taskId: null,
          promotionId: 'promotion-id',
          fuseEpisodeId: null,
          askable,
          state: 'OPEN',
          payload: { jobKind: sourceJob, ...(taskBranch ? { sourceKind: 'TASK_BRANCH' } : {}) },
        } as const;
        const where = `${sourceJob}${taskBranch ? '/TASK_BRANCH' : ''}${askable ? '' : '/no coordinator'}`;
        assert.equal(openItemActions(row).includes('ASK_COORDINATOR_AGAIN'), askable, `${where}: Ask again drawn`);
        const ask = askable ? ' or ask the coordinator to fix it' : '';
        assert.equal(
          openItemRequiredAction({ ...row, payload: { ...row.payload, failureClass: 'CHECK_TIMED_OUT' } }),
          `${taskBranch ? 'This task’s branch' : 'The project branch'} cannot reach main until this check finishes — `
            + `re-run it with a reason${ask}.`,
          `${where}: timed out`,
        );
        assert.equal(
          openItemRequiredAction({ ...row, payload: { ...row.payload, failureClass: 'CHECK_FAILED' } }),
          `Nothing on ${taskBranch ? 'this task’s branch' : 'the project branch'} reaches main until this check passes — `
            + `re-run it${ask}.`,
          `${where}: failed`,
        );
      }
    }
  }
});

test('status, live repair, and handover facts change the required sentence without a second read', () => {
  const base = {
    kind: 'INTEGRATION_ERROR',
    assignee: 'OWNER',
    taskId: 'task-id',
    promotionId: null,
    fuseEpisodeId: null,
    sourceJob: 'LAND_TASK',
    failureClass: 'ERROR',
  } as const;
  assert.match(openItemRequiredAction({ ...base, state: 'RESOLVED' }), /already settled/);
  assert.match(openItemRequiredAction({
    ...base,
    state: 'OPEN',
    handledBy: [{ taskId: 'fix', title: 'repair', state: 'IN_PROGRESS' }],
  }), /repair task is already handling/);
  assert.match(openItemRequiredAction({ ...base, state: 'OPEN', handover_note: 'please review the check' }), /please review the check/);
});

test('owner-item need uses the raw item kind, including escalated integration kinds', () => {
  assert.equal(ownerItemNeed('INTEGRATION_CHECK_FAILED'), 'Checks failed');
  assert.equal(ownerItemNeed('INTEGRATION_CONFLICT'), 'Merge conflict');
  assert.equal(ownerItemNeed('TASK_FAILED'), 'Task failed');
  assert.equal(ownerItemNeed('PROMOTION_APPROVAL'), 'Approve merge to main');
  assert.equal(ownerItemNeed('LANDING_LEASE_EXPIRED'), 'Runner stopped reporting');
});

/**
 * §4.6 X-E5's row, byte for byte: the contract spells its sentence, and its lead press is the
 * abandon door — the one door that changes anything while the runner is gone. The kind is not one
 * of the `INTEGRATION_*` family, so none of that family's sentence rules may claim it.
 */
test('X-E5’s lease item says the contract’s sentence and leads with ABANDON', () => {
  const cell = OPEN_ITEM_DOOR_TABLE.find((candidate) =>
    candidate.todoType === 'LANDING_LEASE_EXPIRED');
  assert.ok(cell, 'the door census lost X-E5’s cell');
  const row = rowFor(cell!);
  assert.equal(
    openItemRequiredAction(row),
    'The runner stopped reporting; abandon this landing, or wait for the runner to come back.',
  );
  assert.equal(primaryAction(row), 'ABANDON');
});

test('the primary action never escapes the resolved door list', () => {
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const row = rowFor(cell);
    const action = primaryAction(row);
    if (!action) continue;
    assert.ok(doorsForOpenItem(row).some((door) => door.implemented && door.action === action));
  }
});

/**
 * The landing door is appended, not inserted: a row that names the landing session its failure came
 * from still leads with the press it always led with, and says the same next step. Both are
 * byte-for-byte what the card approved (G6's sibling rule for the card's own fields).
 */
test('a landing session on the row changes neither the primary action nor the required sentence', () => {
  const landingSessionId = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a74';
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const row = rowFor(cell);
    const withSession = { ...row, payload: { ...row.payload, landingSessionId } };
    const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}/${cell.assignee}`;
    assert.equal(primaryAction(withSession), primaryAction(row),
      `${where}: the lead press moved when the landing session was named`);
    assert.equal(openItemRequiredAction(withSession), openItemRequiredAction(row),
      `${where}: the required sentence moved when the landing session was named`);
  }
});

/**
 * 2026-11-15: an escalated merge conflict told the owner to "ask the coordinator to do it" on a card
 * that drew no Ask-again door and refused the chat. The owner's sentence names the coordinator only
 * while the row's own projection holds ASK_COORDINATOR_AGAIN.
 */
const ASKS_COORDINATOR = /ask the coordinator/i;

function ownerRowFor(cell: OpenItemDoorCell, askable: boolean, taskBranch: boolean) {
  const base = rowFor(cell);
  return { ...base, askable, payload: { ...base.payload, ...(taskBranch ? { sourceKind: 'TASK_BRANCH' } : {}) } };
}

test('an owner sentence offers the coordinator exactly when the ASK_COORDINATOR_AGAIN door is drawn, in every cell that words it', () => {
  let worded = 0;
  for (const cell of OPEN_ITEM_DOOR_TABLE.filter((candidate) => candidate.assignee === 'OWNER')) {
    for (const taskBranch of [false, true]) {
      const reachable = ownerRowFor(cell, true, taskBranch);
      const where = `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}${taskBranch ? '/TASK_BRANCH' : ''}`;
      if (!ASKS_COORDINATOR.test(openItemRequiredAction(reachable))) continue;
      worded += 1;
      assert.ok(openItemActions(reachable).includes('ASK_COORDINATOR_AGAIN'),
        `${where}: the sentence asks the coordinator but the door is not drawn`);

      const unreachable = ownerRowFor(cell, false, taskBranch);
      assert.ok(!openItemActions(unreachable).includes('ASK_COORDINATOR_AGAIN'), `${where}: door still drawn`);
      const sentence = openItemRequiredAction(unreachable);
      assert.doesNotMatch(sentence, ASKS_COORDINATOR, `${where}: ${sentence}`);
      assert.match(sentence, /[^\s—]\.$/, `${where}: not a finished sentence: ${sentence}`);
    }
  }
  // CONFLICT, CHECK_FAILED, CHECK_TIMED_OUT and ERROR on a task's landing, and the promotion cells.
  assert.ok(worded >= 6, `only ${worded} owner cells word the coordinator`);
});

test('the 2026-11-15 card: an escalated landing conflict with no coordinator to ask says only what the owner can do', () => {
  const row = {
    kind: 'INTEGRATION_CONFLICT',
    assignee: 'OWNER',
    taskId: 'task-id',
    promotionId: null,
    fuseEpisodeId: null,
    payload: { jobKind: 'LAND_TASK', phase: 'MERGE', failureClass: 'CONFLICT', nothingLanded: true },
    state: 'OPEN',
  } as const;
  assert.deepEqual(openItemActions({ ...row, askable: false }), ['OPEN_TASK_SESSION', 'CANCEL_TASK']);
  assert.equal(openItemRequiredAction({ ...row, askable: false }),
    'This task cannot reach the project branch until its merge conflict is repaired — fix the task branch.');
  assert.ok(openItemActions({ ...row, askable: true }).includes('ASK_COORDINATOR_AGAIN'));
  assert.equal(openItemRequiredAction({ ...row, askable: true }),
    'This task cannot reach the project branch until its merge conflict is repaired — fix the task branch or ask the coordinator to do it.');
});

test('a coordinator\'s own sentence is untouched by whether the owner could ask it', () => {
  for (const cell of OPEN_ITEM_DOOR_TABLE.filter((candidate) => candidate.assignee === 'COORDINATOR')) {
    assert.equal(openItemRequiredAction({ ...rowFor(cell), askable: false }), openItemRequiredAction(rowFor(cell)),
      `${cell.todoType}/${cell.sourceJob}/${cell.failureClass}`);
  }
});

test('readCoordinatorReach: Ask again can wait for recovery, and unreachable means neither action works', async () => {
  const live: SessionEnding = { turnState: null, finishedAt: null, lastTurnOutcome: 'ANSWERED', endReason: null, completedAt: null, archivedAt: null, deletedAt: null, cancelRequestedAt: null };
  const reaped: SessionEnding = { ...live, turnState: null, finishedAt: new Date(), lastTurnOutcome: 'FAILED', cancelRequestedAt: new Date() };
  const closed: SessionEnding = { ...live, turnState: null, finishedAt: new Date(), endReason: 'COMPLETED', completedAt: new Date() };
  const answering = (reason: string | null) => ({ receiveBlockedReasonFor: async () => reason });
  const project = (session: SessionEnding | null) => ({ coordinatorSessionId: session ? 'coordinator' : null, coordinatorSession: session });
  const read = async (reason: string | null, session: SessionEnding | null) => {
    const reach = await readCoordinatorReach(answering(reason), 'owner', project(session));
    return { askable: reach.askable, receiving: reach.coordinator?.receiving ?? false, unreachable: coordinatorUnreachable(reach) };
  };

  assert.deepEqual(await read(null, live), { askable: true, receiving: true, unreachable: false });
  // With the runner back, chat can send and Ask again can queue.
  assert.deepEqual(await read(null, reaped), { askable: true, receiving: true, unreachable: false });
  // Ask again can queue while the runner is away and chat cannot send.
  assert.deepEqual(await read('RUNNER_OFFLINE', reaped), { askable: true, receiving: false, unreachable: false });
  // A live run a message cannot reach (its run retired) is unreachable too.
  assert.deepEqual(await read('RUN_RETIRED', live), { askable: false, receiving: false, unreachable: true });
  assert.deepEqual(await read(null, null), { askable: false, receiving: false, unreachable: true });
  // Closed by the owner, its runner up: the chat may reopen it, Ask-again does not — and the
  // heading does not say it cannot take messages while the chat is live.
  assert.deepEqual(await read(null, closed), { askable: false, receiving: true, unreachable: false });
  // The heading marks the coordinator unreachable when both actions are unavailable.
  for (const reason of [null, 'RUNNER_OFFLINE', 'TRASHED', 'RUN_RETIRED', 'SESSION_GONE']) {
    for (const session of [live, reaped, closed, null]) {
      const reach = await read(reason, session);
      assert.equal(reach.unreachable, !reach.askable && !reach.receiving, `unreachable iff both actions are unavailable (${reason}, ${session?.turnState} ${session?.finishedAt ? 'released' : 'held'})`);
    }
  }
});
