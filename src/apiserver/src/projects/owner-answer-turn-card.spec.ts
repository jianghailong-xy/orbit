import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OwnerAnswerCard } from '@orbit/shared';

import { withOwnerAnswer } from '../runner-api/control-plane-note';
import { openItemTurnId, OWNER_ANSWER_TURN_PREFIX, ownerAnswerCardOfTurn, ownerAnswerTurnId } from './project-open-item';

/**
 * The owner's answer is read back off its turn's key (`ownerAnswerCardOfTurn`), and the card it reads
 * is stored beside the runner's echo by the control plane alone (`withOwnerAnswer`). The rows behind
 * the card are owner-answer-turn-card.pg.spec.ts's.
 */

const ITEM = '01a0d6a9-d763-70e1-b4cf-8793e971b511';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CARD: OwnerAnswerCard = {
  itemId: ITEM, kind: 'COORDINATOR_QUESTION', sessionId: SESSION, deliveredAt: '2026-10-09T00:29:36.828Z',
};

test('the key the answer is queued under gives the item and the conversation back', () => {
  assert.deepEqual(ownerAnswerCardOfTurn(ownerAnswerTurnId(ITEM, SESSION)), { itemId: ITEM, sessionId: SESSION });
});

test('any other key is no answer — and a key that is not two ids is not read by', () => {
  const others: Array<[string, string | null | undefined]> = [
    ['no key', undefined],
    ['a null key', null],
    ['an empty key', ''],
    ['a key somebody chose', '7d9f6c1e-4b8a-4f0e-9a51-0c3e1f2b4d6a'],
    ["an exception item's delivery", openItemTurnId(ITEM, new Date('2026-10-09T00:29:36.828Z'))],
    ['the prefix alone', OWNER_ANSWER_TURN_PREFIX],
    ['no conversation', `${OWNER_ANSWER_TURN_PREFIX}${ITEM}`],
    ['an empty conversation', `${OWNER_ANSWER_TURN_PREFIX}${ITEM}:`],
    ['an empty item', `${OWNER_ANSWER_TURN_PREFIX}:${SESSION}`],
    ['an item that is no id', `${OWNER_ANSWER_TURN_PREFIX}not-an-item:${SESSION}`],
    ['a conversation that is no id', `${OWNER_ANSWER_TURN_PREFIX}${ITEM}:nobody`],
    ['a third part', `${OWNER_ANSWER_TURN_PREFIX}${ITEM}:${SESSION}:${SESSION}`],
    ['the prefix not at the start', `x${ownerAnswerTurnId(ITEM, SESSION)}`],
  ];
  for (const [what, key] of others) assert.equal(ownerAnswerCardOfTurn(key), null, what);
});

test('the card is stored beside the echo, and only the control plane says what it is', () => {
  const echo = { text: 'From Orbit · owner answer: you asked "…".' };
  assert.deepEqual(withOwnerAnswer(echo, CARD), { ...echo, ownerAnswer: CARD });
  // A card the runner sent is dropped: replaced by the one read, or removed when the turn is none.
  const forged = { ...echo, ownerAnswer: { ...CARD, deliveredAt: '2000-01-01T00:00:00.000Z' } };
  assert.deepEqual(withOwnerAnswer(forged, CARD), { ...echo, ownerAnswer: CARD });
  assert.deepEqual(withOwnerAnswer(forged, null), echo);
  assert.equal('ownerAnswer' in withOwnerAnswer(echo, null), false, 'absent, not empty, on every other turn');
  // A payload with no text is no `user` echo this reads.
  const other = { subtype: 'init' };
  assert.equal(withOwnerAnswer(other, CARD), other);
});
