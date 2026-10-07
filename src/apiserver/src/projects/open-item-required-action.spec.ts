import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPEN_ITEM_DOOR_TABLE,
  doorsForOpenItem,
  type OpenItemDoorCell,
} from './open-item-doors';
import {
  openItemRequiredAction,
  ownerItemNeed,
  primaryAction,
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
});

test('the primary action never escapes the resolved door list', () => {
  for (const cell of OPEN_ITEM_DOOR_TABLE) {
    const row = rowFor(cell);
    const action = primaryAction(row);
    if (!action) continue;
    assert.ok(doorsForOpenItem(row).some((door) => door.implemented && door.action === action));
  }
});
