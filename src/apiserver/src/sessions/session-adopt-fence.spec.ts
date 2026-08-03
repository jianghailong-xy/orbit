import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

function harness(overrides: Record<string, unknown>) {
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    isolationStatus: 'worktree',
    branch: 'orbit/old-branch',
    worktreeBranch: 'orbit/new-branch',
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    ...overrides,
  };
  const writes: unknown[] = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => session,
      update: async (args: unknown) => {
        writes.push(args);
        return session;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  return {
    service: new SessionsService(prisma, {} as never, {} as never),
    writes,
  };
}

for (const tc of [
  {
    name: 'merge',
    title: 'Adopt may supersede a modern unclaimed merge',
    overrides: {
      mergeStatus: 'pending',
      mergeOperationId: OPERATION_ID,
      mergeOperationOwner: null,
    },
    expected: {
      mergeStatus: null,
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
  },
  {
    name: 'commit',
    title: 'Adopt allows a modern unclaimed commit and preserves its receipt epoch',
    overrides: {
      commitStatus: 'pending',
      commitOperationId: OPERATION_ID,
      commitOperationOwner: null,
    },
    expected: {
      commitStatus: undefined,
      commitOperationId: undefined,
      commitOperationOwner: undefined,
    },
  },
  // An orphaned NULL/NULL row has no runner process behind it; blocking on one
  // leaves the session permanently unable to adopt its worktree branch.
  {
    name: 'merge',
    title: 'Adopt may supersede an orphaned NULL/NULL merge',
    overrides: {
      mergeStatus: 'pending',
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
    expected: {
      mergeStatus: null,
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
  },
  {
    name: 'commit',
    title: 'Adopt allows an orphaned NULL/NULL commit and preserves its receipt epoch',
    overrides: {
      commitStatus: 'pending',
      commitOperationId: null,
      commitOperationOwner: null,
    },
    expected: {
      commitStatus: undefined,
      commitOperationId: undefined,
      commitOperationOwner: undefined,
    },
  },
] as const) {
  test(tc.title, async () => {
    const h = harness(tc.overrides);

    assert.deepEqual(await h.service.adoptWorktreeBranch(OWNER_ID, SESSION_ID), {
      ok: true,
      branch: 'orbit/new-branch',
    });

    assert.equal(h.writes.length, 1);
    const data = (h.writes[0] as { data: Record<string, unknown> }).data;
    for (const [field, value] of Object.entries(tc.expected)) {
      assert.equal(data[field], value, `${field} changed unexpectedly`);
    }
  });
}
