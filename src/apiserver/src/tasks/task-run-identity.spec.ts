import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunStatus } from '@prisma/client';

import { dispatchDesiredSessionId } from '../projects/project-dispatch-identity';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import { TASK_RUN_TRIGGER, taskRunDesiredSessionId, taskRunRequestKey } from './task-run-identity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TASK = '550e8400-e29b-41d4-a716-446655440001';
const PRESS = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const idFor = (taskId: string, requestToken: string) =>
  taskRunDesiredSessionId(taskRunRequestKey({ taskId, requestToken }));

test('one token names one Session, in this process and in any other', () => {
  // The property the whole recovery rests on, and the reason the token is CARRIED: a caller that
  // never received its response, a process that restarted, or a redelivered tool call recomputes
  // this id rather than searching the database for the row.
  assert.equal(idFor(TASK, PRESS), idFor(TASK, PRESS));
  assert.match(idFor(TASK, PRESS), UUID);
});

test('a different token is a different request, and a different Session', () => {
  assert.notEqual(idFor(TASK, PRESS), idFor(TASK, 'a-second-press'));
});

test('the same token on another task names another Session', () => {
  // A client that reuses one id across two Run Now presses must not make the second press adopt
  // the first task's run.
  assert.notEqual(idFor(TASK, PRESS), idFor(OTHER_TASK, PRESS));
});

test('nothing else is part of the name — not the agent, not the pins, not the run history', () => {
  // Deliberate, and the whole correction this unit makes to its own first attempt: every one of
  // those moves between a request and its retry. A task re-pinned, reassigned, or given one more
  // Session by the very insert being recovered would make the replay compute a DIFFERENT name and
  // either be refused or start a second run.
  assert.equal(taskRunRequestKey({ taskId: TASK, requestToken: PRESS }), `task-run:v1:${TASK}:${PRESS}`);
});

test('the id is name-based in shape, so a reader can tell it was derived rather than drawn', () => {
  const [, , third, fourth] = idFor(TASK, PRESS).split('-');
  assert.equal(third[0], '5', 'RFC 9562 version nibble: name-based');
  assert.ok('89ab'.includes(fourth[0]), 'RFC 9562 variant: 10x');
});

test('the legacy door and the Coordinator door never mint the same id for the same key', () => {
  const key = taskRunRequestKey({ taskId: TASK, requestToken: PRESS });
  assert.notEqual(taskRunDesiredSessionId(key), dispatchDesiredSessionId(key));
});

test('an automatic door names the MOMENT it acted on, and each moment is its own request', () => {
  assert.equal(TASK_RUN_TRIGGER.scheduled(TASK, 7n), `sched:${TASK}:7`);
  assert.equal(TASK_RUN_TRIGGER.dependency(TASK, 4n), `dep:${TASK}:4`);
  assert.equal(TASK_RUN_TRIGGER.firstRun(TASK, 0n), `first-run:${TASK}:0`);
  // Whichever numeric shape the epoch arrives in — BigInt from Prisma, number or string from raw
  // SQL — it is the same moment, so it must be the same name.
  for (const kind of ['scheduled', 'dependency', 'firstRun'] as const) {
    assert.equal(TASK_RUN_TRIGGER[kind](TASK, 4), TASK_RUN_TRIGGER[kind](TASK, 4n));
    assert.equal(TASK_RUN_TRIGGER[kind](TASK, '4'), TASK_RUN_TRIGGER[kind](TASK, 4n));
    // Two passes over the same moment are one request; the next moment is a new name.
    assert.notEqual(TASK_RUN_TRIGGER[kind](TASK, 4n), TASK_RUN_TRIGGER[kind](TASK, 5n));
  }
  // The KIND is part of the name, so two doors acting at the same epoch are two requests rather
  // than one answered with the other's Session.
  assert.equal(
    new Set([
      TASK_RUN_TRIGGER.scheduled(TASK, 4n),
      TASK_RUN_TRIGGER.dependency(TASK, 4n),
      TASK_RUN_TRIGGER.firstRun(TASK, 4n),
    ]).size,
    3,
  );
  // One press of a bulk Run is one request per task inside it, never one for the whole press.
  assert.notEqual(TASK_RUN_TRIGGER.batch(PRESS, TASK), TASK_RUN_TRIGGER.batch(PRESS, OTHER_TASK));
  assert.notEqual(TASK_RUN_TRIGGER.batch(PRESS, TASK), TASK_RUN_TRIGGER.batch('other-press', TASK));
});

test('every automatic token is TASK-scoped, so two tasks of one owner never share a receipt', () => {
  // The receipt is keyed `(owner, door, token)`. A token that says only what happened — "the first
  // run", "epoch 4", "the appointment" — is a token two of one owner's tasks produce identically,
  // and the second task's dispatch would be answered with the first task's receipt.
  for (const kind of ['scheduled', 'dependency', 'firstRun'] as const) {
    assert.notEqual(TASK_RUN_TRIGGER[kind](TASK, 4n), TASK_RUN_TRIGGER[kind](OTHER_TASK, 4n));
    // ...and each is still stable for its own task, which is the half that makes it a name at all.
    assert.equal(TASK_RUN_TRIGGER[kind](TASK, 4n), TASK_RUN_TRIGGER[kind](TASK, 4n));
  }
});

test('TASK_OCCUPYING is still the execution claim index, character for character', () => {
  // `createTaskSessionOrReadWinner` reads the claim holder with this set because
  // `session_task_execution_claim_idx` (migration 0130) is defined over exactly these four
  // statuses. A reader narrower than the index it explains reports "nothing holds the claim" for
  // rows that do, which is the mistake this unit exists to remove — so the two are pinned together.
  assert.deepEqual([...TASK_OCCUPYING].sort(), [
    RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED, RunStatus.PENDING, RunStatus.RUNNING,
  ].sort());
});
