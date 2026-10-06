import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openItemActions, openItemChat, type OpenItemChatSource } from './project-open-item';

/**
 * "Chat about this" for an exception item (`openItemChat`, contract §4.8): the stage a card says
 * beside the press, the coordinator conversation the message goes to, and why it cannot be had when
 * it cannot. The read that serves it is `open-item-chat.pg.spec.ts`; this pins the derivation.
 */

const COORDINATOR = { sessionId: '0199c0de-0000-7000-8000-00000000c00d', receiving: true };

function chat(over: Partial<OpenItemChatSource> = {}) {
  return openItemChat({
    assignee: 'COORDINATOR',
    handling: false,
    resolution: null,
    coordinator: COORDINATOR,
    ...over,
  });
}

test('each stage the card can be in, and the conversation the chat goes to', () => {
  assert.deepEqual(chat(), {
    sessionId: COORDINATOR.sessionId,
    stage: 'WITH_COORDINATOR',
    refusal: null,
  });
  assert.equal(chat({ handling: true }).stage, 'HANDLING');
  assert.equal(chat({ assignee: 'OWNER' }).stage, 'WITH_OWNER');
  assert.equal(chat({ resolution: 'HANDLED' }).stage, 'HANDLED');
  assert.equal(chat({ resolution: 'RETRIED' }).stage, 'SUPERSEDED');
  // How it ended outranks who held it last: a settled row asks nobody anything.
  assert.equal(chat({ assignee: 'OWNER', resolution: 'HANDLED' }).stage, 'HANDLED');
});

test('offered whoever holds the item: handling, with the coordinator, with the owner, handled', () => {
  for (const over of [
    { handling: true },
    {},
    { assignee: 'OWNER' },
    { resolution: 'HANDLED' as const },
  ]) {
    const answer = chat(over);
    assert.equal(answer.refusal, null, `refused at ${answer.stage}`);
    assert.equal(answer.sessionId, COORDINATOR.sessionId);
  }
});

test('refused, with the reason, where the message has nowhere to go or is about the wrong item', () => {
  assert.deepEqual(chat({ coordinator: null }), {
    sessionId: null,
    stage: 'WITH_COORDINATOR',
    refusal: 'NO_COORDINATOR',
  });
  assert.deepEqual(chat({ assignee: 'OWNER', coordinator: { ...COORDINATOR, receiving: false } }), {
    sessionId: COORDINATOR.sessionId,
    stage: 'WITH_OWNER',
    refusal: 'COORDINATOR_UNAVAILABLE',
  });
  // A superseded item says so first, whatever the conversation can take: the chat belongs to the
  // item that replaced it.
  assert.equal(chat({ resolution: 'RETRIED' }).refusal, 'SUPERSEDED');
  assert.equal(chat({ resolution: 'RETRIED', coordinator: null }).refusal, 'SUPERSEDED');
});

test('the chat adds no door: what an item lets anybody press is still `openItemActions`', () => {
  // The owner's own presses on an escalated item — for the merge into main, the way back to the
  // coordinator, the reruns the door matrix gives the owner (`open-item-doors.ts`) and the merge
  // card (§4.7) — are what they were: a chat about either is a message, never a rerun, a merge or a
  // close.
  assert.deepEqual(
    openItemActions({
      kind: 'INTEGRATION_CHECK_FAILED',
      assignee: 'OWNER',
      taskId: null,
      promotionId: '0199c0de-0000-7000-8000-0000000000f1',
      fuseEpisodeId: null,
      askable: true,
    }),
    ['ASK_COORDINATOR_AGAIN', 'RETRY', 'REVIEW'],
  );
  assert.deepEqual(
    openItemActions({
      kind: 'TASK_FAILED',
      assignee: 'OWNER',
      taskId: '0199c0de-0000-7000-8000-0000000000a1',
      promotionId: null,
      fuseEpisodeId: null,
      askable: true,
    }),
    ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  );
});
