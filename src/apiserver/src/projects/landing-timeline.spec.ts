import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HANDED_TO_SESSION_TEXT, fixedBySessionText, returnedToCoordinatorText } from './landing-timeline';

// Revision 42 (§12.7): the three lines the landing timeline draws for a failure handed to the task's own work session,
// in the contract's words.
test('the hand-off, the fix landing again and the hand-back are worded as §12.7 writes them', () => {
  assert.equal(HANDED_TO_SESSION_TEXT, "Handed to the task's session");
  assert.equal(fixedBySessionText('f'.repeat(40)), 'Fixed in fffffff · landing again');
  assert.equal(fixedBySessionText(null), 'Fixed · landing again', 'a fix whose commit is not known yet invents none');
  for (const [reason, words] of [
    ['NO_NEW_COMMIT', 'no new commit'],
    ['TURN_FAILED', 'its fix turn failed'],
    ['SESSION_ENDED', 'the session ended'],
    ['ROUNDS_EXHAUSTED', 'its rounds of fixes are used up'],
    ['TASK_MOVED_ON', 'the task moved on'],
  ] as const) {
    assert.equal(returnedToCoordinatorText(reason), `Returned to the coordinator: ${words}`);
  }
  assert.equal(returnedToCoordinatorText(null), 'Returned to the coordinator');
});
