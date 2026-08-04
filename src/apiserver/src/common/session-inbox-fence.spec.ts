import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORKTREE_OPERATION_STALE_MS,
  isTerminalResumeHandoffOwner,
  newTerminalResumeHandoffOwner,
  pendingWorktreeOperationMayBeExecuting,
  retireSessionInboxGeneration,
} from './session-inbox-fence';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_OWNER = '33333333-3333-4333-8333-333333333333';

test('terminal resume handoff owners are fresh v5-tagged epoch tokens', () => {
  const first = newTerminalResumeHandoffOwner();
  const second = newTerminalResumeHandoffOwner();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isTerminalResumeHandoffOwner(first), true);
  assert.equal(isTerminalResumeHandoffOwner('11111111-1111-4111-8111-111111111111'), false);
  assert.equal(isTerminalResumeHandoffOwner(null), false);
});

test('only an owner-bearing pending operation can still be executing', () => {
  // The four documented rows of the fence truth table. An orphaned NULL/NULL row is
  // free: treating it as in-flight made takeover 409 forever, so the runner never
  // reached the claim loop.
  for (const [operationId, operationOwner, executing] of [
    [OPERATION_ID, OPERATION_OWNER, true], // modern, executing
    [null, OPERATION_OWNER, true], // legacy (pre-operation-id), executing
    [OPERATION_ID, null, false], // modern, completed or orphaned
    [null, null, false], // stale orphan
  ] as const) {
    assert.equal(
      pendingWorktreeOperationMayBeExecuting('pending', operationId, operationOwner),
      executing,
      `pending/${operationId ? 'id' : 'no id'}/${operationOwner ? 'owner' : 'no owner'}`,
    );
    // Only 'pending' fences anything; a settled or absent status never blocks.
    for (const status of [null, undefined, 'ok', 'error']) {
      assert.equal(
        pendingWorktreeOperationMayBeExecuting(status, operationId, operationOwner),
        false,
        `${status} must not fence`,
      );
    }
  }
});

test('a stale claimed operation stops fencing; a fresh or clock-less one keeps fencing', () => {
  const fresh = new Date(Date.now() - WORKTREE_OPERATION_STALE_MS / 2);
  const stale = new Date(Date.now() - WORKTREE_OPERATION_STALE_MS - 1);
  assert.equal(
    pendingWorktreeOperationMayBeExecuting('pending', OPERATION_ID, OPERATION_OWNER, fresh),
    true,
  );
  // The owner is a process epoch. One that stopped restamping the clock for the whole
  // staleness window died between claim and result; treating its row as executing made
  // takeover 409 forever and livelocked the runner's reclaim loop.
  assert.equal(
    pendingWorktreeOperationMayBeExecuting('pending', OPERATION_ID, OPERATION_OWNER, stale),
    false,
  );
  // Callers without the timestamp column keep the fail-closed behavior.
  for (const requestedAt of [null, undefined]) {
    assert.equal(
      pendingWorktreeOperationMayBeExecuting('pending', OPERATION_ID, OPERATION_OWNER, requestedAt),
      true,
    );
  }
  // Staleness never revives a row that already failed the owner/status gates.
  assert.equal(pendingWorktreeOperationMayBeExecuting('pending', OPERATION_ID, null, fresh), false);
  assert.equal(pendingWorktreeOperationMayBeExecuting('error', OPERATION_ID, OPERATION_OWNER, fresh), false);
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
