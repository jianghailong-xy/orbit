import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coordinatorDeliveryTurnId } from './coordinator-delivery.service';
import { turnTypedByOwner } from './task-run-stopped.producer';

test('a turn counts as the owner\'s only when a client minted its key and no session sent it', () => {
  const session = '01a19ef3-88ce-7789-a094-0f2cca249425';
  // What the web, iOS and Android composers send.
  assert.equal(turnTypedByOwner({ clientTurnId: '3f2b8a54-6d1e-4c7a-9b10-2e8f6a7c1d90', senderSessionId: null }), true);
  assert.equal(turnTypedByOwner({ clientTurnId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F', senderSessionId: null }), true);
  // Another session's message names its sender, whatever key it came under.
  assert.equal(turnTypedByOwner({ clientTurnId: '3f2b8a54-6d1e-4c7a-9b10-2e8f6a7c1d90', senderSessionId: session }), false);
  // Everything the platform writes: the run's brief, a wake, a watch, a key derived from a fact.
  for (const clientTurnId of [
    `initial-${session}`,
    `bg-wake:wakeup:${session}`,
    `watch:${session}:1`,
    coordinatorDeliveryTurnId('cw:v1:TASK_RUN_STOPPED:TASK:task:version'),
  ]) {
    assert.equal(turnTypedByOwner({ clientTurnId, senderSessionId: null }), false, clientTurnId);
  }
});
