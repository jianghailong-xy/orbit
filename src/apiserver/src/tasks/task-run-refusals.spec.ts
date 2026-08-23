import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import {
  TASK_RUN_ACTION,
  TASK_RUN_RETRY_AFTER_SECONDS,
  TASK_RUN_UNSETTLED_ATTEMPTS,
  taskAlreadyRunning,
  taskRunInProgress,
  taskRunTokenMismatch,
  taskRunUnreadableTarget,
  taskRunUnsettled,
  taskRunPinConflict,
} from './task-run-receipt';

/**
 * The refusals a run door can give, as WIRE shapes.
 *
 * Every one of these is read by something that is not a person: the web Run button deciding whether
 * to offer a retry, the runner deciding whether to ask again, a script deciding whether it reused
 * an id. They used to be sentences — `new ConflictException('task … could not be started: …')` —
 * so telling "wait for the run that is going" from "you sent this triggerId before" meant parsing
 * English, and the ids in them were raw UUIDs no caller could hand back.
 *
 * So each carries a stable `code`, public ids, and what to do about it. This pins that, because a
 * shape nothing asserts is a shape the next edit changes by accident.
 */
const TASK = '550e8400-e29b-41d4-a716-446655440000';
const SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const body = (error: { getResponse: () => unknown }) => error.getResponse() as Record<string, unknown>;

test('every refusal names itself with a stable code', () => {
  const codes = [
    taskAlreadyRunning({
      taskPublicId: uuidToBase62(TASK), sessionPublicId: uuidToBase62(SESSION),
      sessionStatus: 'RUNNING',
    }),
    taskRunPinConflict({
      taskPublicId: uuidToBase62(TASK), sessionPublicId: uuidToBase62(SESSION),
      field: 'provider', pinned: 'claude', running: 'codex',
    }),
    taskRunTokenMismatch(TASK_RUN_ACTION.execute, 'press-1'),
    taskRunInProgress(TASK_RUN_ACTION.execute, 'press-1'),
    taskRunUnreadableTarget(TASK_RUN_ACTION.execute, 'press-1'),
    taskRunUnsettled({
      actionKind: TASK_RUN_ACTION.batchExecute, requestToken: 'press-1',
      pendingTaskIds: [uuidToBase62(TASK)], attempt: 1,
    }),
  ].map((error) => body(error).code);

  assert.deepEqual(codes, [
    'TASK_ALREADY_RUNNING',
    'TASK_RUN_PIN_CONFLICT',
    'TASK_RUN_REQUEST_MISMATCH',
    'TASK_RUN_REQUEST_IN_PROGRESS',
    'TASK_RUN_REQUEST_UNREADABLE',
    'TASK_RUN_REQUEST_UNSETTLED',
  ]);
  assert.equal(new Set(codes).size, codes.length, 'and no two of them share one');
});

test('the run in the way is named as a public id, and no raw uuid escapes', () => {
  const refusal = body(taskAlreadyRunning({
    taskPublicId: uuidToBase62(TASK),
    sessionPublicId: uuidToBase62(SESSION),
    sessionStatus: 'AWAITING_INPUT',
  }));

  assert.equal(refusal.conflictingSessionId, uuidToBase62(SESSION));
  assert.equal(refusal.taskId, uuidToBase62(TASK));
  assert.equal(refusal.conflictingSessionStatus, 'AWAITING_INPUT');
  assert.equal(refusal.retryable, true);
  assert.match(String(refusal.requiredAction), /terminal status/);
  // `PublicIdInterceptor` rewrites response FIELDS; the inside of a body assembled by hand is the
  // one place a raw uuid would survive to a caller that cannot use it.
  assert.doesNotMatch(JSON.stringify(refusal), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
});

test('a pin conflict says which pin, because the remedy is not the same one', () => {
  // Waiting fixes "something else is running". A pin conflict is also fixed by clearing the pin,
  // and a client that cannot tell them apart can only ever offer the first.
  const refusal = body(taskRunPinConflict({
    taskPublicId: uuidToBase62(TASK), sessionPublicId: uuidToBase62(SESSION),
    field: 'model', pinned: 'claude-opus-5', running: 'claude-haiku-4-5',
  }));

  assert.equal(refusal.pinnedTo, 'claude-opus-5');
  assert.equal(refusal.runningOn, 'claude-haiku-4-5');
  assert.match(String(refusal.requiredAction), /clear the task's model pin/);
});

test('an unsettled request asks to be repeated — and stops asking once that is not working', () => {
  const early = body(taskRunUnsettled({
    actionKind: TASK_RUN_ACTION.batchExecute, requestToken: 'press-1',
    pendingTaskIds: [uuidToBase62(TASK)], attempt: 1,
  }));
  assert.equal(early.retryable, true);
  assert.equal(early.retryAfterSeconds, TASK_RUN_RETRY_AFTER_SECONDS);
  assert.equal(early.escalate, false);
  assert.deepEqual(early.pendingTaskIds, [uuidToBase62(TASK)]);
  assert.match(String(early.requiredAction), /same triggerId/);

  // BOUNDED. A request that keeps not settling is not one to keep asking about silently: past the
  // threshold it says so, and says whose runs need looking at.
  const late = body(taskRunUnsettled({
    actionKind: TASK_RUN_ACTION.batchExecute, requestToken: 'press-1',
    pendingTaskIds: [uuidToBase62(TASK)], attempt: TASK_RUN_UNSETTLED_ATTEMPTS,
  }));
  assert.equal(late.escalate, true);
  assert.equal(late.owner, 'SYSTEM');
  assert.match(String(late.requiredAction), /inspect the runs/);
});
