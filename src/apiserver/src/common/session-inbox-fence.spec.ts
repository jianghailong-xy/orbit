import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTerminalResumeHandoffOwner,
  newTerminalResumeHandoffOwner,
  retireSessionInboxGeneration,
} from './session-inbox-fence';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('terminal resume handoff owners are fresh v5-tagged epoch tokens', () => {
  const first = newTerminalResumeHandoffOwner();
  const second = newTerminalResumeHandoffOwner();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isTerminalResumeHandoffOwner(first), true);
  assert.equal(isTerminalResumeHandoffOwner('11111111-1111-4111-8111-111111111111'), false);
  assert.equal(isTerminalResumeHandoffOwner(null), false);
});

function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as readonly string[] | undefined) ?? []).join('?');
}

test('terminal fencing tombstones only the Session current concrete generation', async () => {
  const calls: unknown[][] = [];
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    },
  };

  await retireSessionInboxGeneration(tx as never, SESSION_ID);

  assert.equal(calls.length, 1);
  assert.match(sql(calls[0]), /UPDATE "inbox_lease_generation" AS generation/);
  assert.match(sql(calls[0]), /"retired_at" = COALESCE\(generation\."retired_at", now\(\)\)/);
  assert.match(sql(calls[0]), /session\.status IN \('SUCCEEDED', 'FAILED', 'CANCELLED'\)/);
  assert.match(sql(calls[0]), /generation\.generation = session\."inbox_lease_generation"/);
  assert.deepEqual(calls[0].slice(1), [SESSION_ID]);
});
