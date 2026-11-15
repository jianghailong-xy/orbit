/**
 * What a task-write card authorises, matched against the write that follows it
 * (`docs/orbit-agent-contract.md` §2.4; runner-go raises the cards, `task-write-approval.ts` reads
 * them). The server never takes "this session has an approved card" for an answer: it compares the
 * write to what the card stored, so the cases below are the ones a bypass would hide in — a
 * different body, a field spelled differently, the server's own enrichment, and the one field the
 * owner's answer may add.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import {
  TASK_WRITE_NEEDS_OWNER_CARD_ACTION,
  TASK_WRITE_NEEDS_OWNER_CARD_CODE,
  TASK_WRITE_NEEDS_SESSION_ACTION,
  cardCoversBatch,
  cardCoversCreate,
  cardCoversDag,
  taskWriteNeedsOwnerCardBody,
  taskWriteNeedsSessionBody,
} from './task-write-approval';

const projectId = randomUUID();
const assigneeId = randomUUID();
const listId = randomUUID();

/** The body runner-go sends on a single create, with the ids in the caller's base62 spelling. */
const createBody = () => ({
  title: 'Rotate the staging key',
  description: 'it has been in a screenshot',
  completionCriterion: 'EVIDENCE_JUDGMENT',
  acceptanceCriteria: 'the old key is revoked',
  projectId: uuidToBase62(projectId),
  assigneeId: uuidToBase62(assigneeId),
  labels: ['security', 'staging'],
  dependsOnTaskIds: [uuidToBase62(randomUUID())],
});

test('a create matches its card by body, with ids compared as the rows they name', () => {
  const body = createBody();
  const request = { ...body, projectId, assigneeId }; // the DTO's uuid spelling of the same rows
  // The card is stored with what the server added for the person reading it.
  const card = { input: { ...body, preview: { taskCount: 1 }, acceptsStartAfterCreate: true }, startAfterCreate: false };
  assert.equal(cardCoversCreate(card, request), true, 'same write, both id spellings');
  assert.equal(cardCoversCreate(card, { ...request, title: 'something else' }), false, 'a different body');
  assert.equal(cardCoversCreate(card, { ...request, labels: ['staging', 'security'] }), false, 'a different value');
  assert.equal(cardCoversCreate(card, { ...request, autoRunWhenReady: true }), false, 'a field the card never carried');
  assert.equal(cardCoversCreate(card, { ...request, description: undefined }), false, 'a field the card carried and the write does not');
});

test('absent and null are different writes', () => {
  const card = { input: { title: 'a', description: null }, startAfterCreate: false };
  assert.equal(cardCoversCreate(card, { title: 'a', description: null }), true);
  assert.equal(cardCoversCreate(card, { title: 'a' }), false, 'clearing a field is not leaving it alone');
});

test('"Create and start" is the one field a write may gain after the card', () => {
  const body = createBody();
  const schedule = '2026-11-13T13:00:00Z';
  const plain = { input: body, startAfterCreate: false };
  assert.equal(cardCoversCreate(plain, { ...body, runAt: schedule }), false, 'no answer asked for a start');

  const started = { input: body, startAfterCreate: true };
  assert.equal(cardCoversCreate(started, { ...body, runAt: schedule }), true, 'the owner chose to start it');
  // A schedule already proposed on the card is part of what was read, even when the answer started
  // the task: dropping runAt on both sides is about the answer, not about ignoring the field.
  const proposed = { input: { ...body, runAt: schedule }, startAfterCreate: true };
  assert.equal(cardCoversCreate(proposed, { ...body, runAt: schedule }), true);
});

test('a batch matches item for item', () => {
  const one = { title: 'first', completionCriterion: 'EVIDENCE_JUDGMENT', projectId: uuidToBase62(projectId) };
  const two = { ref: 's1', title: 'second', completionCriterion: 'EVIDENCE_JUDGMENT', dependsOnRefs: ['s0'] };
  const cardInput = { tasks: [one, two], preview: { taskCount: 2 } };
  const request = [
    { ...one, projectId },
    two,
  ];
  assert.equal(cardCoversBatch(cardInput, request), true);
  assert.equal(cardCoversBatch(cardInput, [request[0]]), false, 'a subset is not the batch the person read');
  assert.equal(cardCoversBatch(cardInput, [request[1], request[0]]), false, 'order is the plan');
  assert.equal(cardCoversBatch(cardInput, [{ ...request[0], projectId: uuidToBase62(projectId) }, two]), true, 'spellings');
  assert.equal(cardCoversBatch({ tasks: [one] }, [request[0], request[1]]), false, 'an item the card never carried');
  assert.equal(cardCoversBatch({}, request), false, 'no tasks at all');
});

test('a DAG change matches the list and the edges', () => {
  const ops = [{ op: 'add', taskId: uuidToBase62(randomUUID()), dependsOnTaskId: uuidToBase62(randomUUID()) }];
  const cardInput = { listId: uuidToBase62(listId), ops, preview: { effectiveCount: 1 } };
  const request = [{ op: 'add', taskId: ops[0].taskId, dependsOnTaskId: ops[0].dependsOnTaskId }];
  assert.equal(cardCoversDag(cardInput, listId, request), true);
  assert.equal(cardCoversDag(cardInput, randomUUID(), request), false, 'another list');
  assert.equal(cardCoversDag(cardInput, listId, [{ ...request[0], op: 'remove' }]), false, 'another edge');
  assert.equal(cardCoversDag({ ops }, listId, request), false, 'a card that names no list');
  assert.equal(cardCoversDag(cardInput, listId, [...request, ...request]), false, 'more writes than the card carried');
});

test('the refusal names the code, the action and the tool that asks', () => {
  assert.equal(TASK_WRITE_NEEDS_OWNER_CARD_CODE, 'TASK_WRITE_NEEDS_OWNER_CARD');
  assert.equal(TASK_WRITE_NEEDS_OWNER_CARD_ACTION, 'ASK_THROUGH_THE_SAME_TOOL');
  for (const [write, asking] of [
    [{ toolName: 'orbit_task_create' as const, create: {} }, 'task_create'],
    [{ toolName: 'orbit_task_batch' as const, tasks: [] }, 'task_create_batch'],
    [{ toolName: 'orbit_dag_change' as const, listId, ops: [] }, 'tasklist_propose_dag'],
  ] as const) {
    const body = taskWriteNeedsOwnerCardBody(write);
    assert.equal(body.code, TASK_WRITE_NEEDS_OWNER_CARD_CODE);
    assert.equal(body.kind, 'REFUSAL');
    assert.equal(body.requiredAction, TASK_WRITE_NEEDS_OWNER_CARD_ACTION);
    assert.match(body.message, new RegExp(asking));
    assert.match(body.message, /Nothing was written|nothing was\s+written/i);
  }
});

test('a write that names no usable session is the same code, with the headless way out', () => {
  assert.equal(TASK_WRITE_NEEDS_SESSION_ACTION, 'USE_A_PERSONAL_ACCESS_TOKEN');
  const body = taskWriteNeedsSessionBody();
  assert.equal(body.code, TASK_WRITE_NEEDS_OWNER_CARD_CODE);
  assert.equal(body.kind, 'REFUSAL');
  assert.equal(body.requiredAction, TASK_WRITE_NEEDS_SESSION_ACTION);
  assert.match(body.message, /must name the acting session/);
  assert.match(body.message, /ORBIT_USER_TOKEN/);
  assert.match(body.message, /orbit login/);
});
