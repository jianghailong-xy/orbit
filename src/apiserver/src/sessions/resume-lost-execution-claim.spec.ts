import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { SessionsService } from './sessions.service';

/**
 * "Retry now" on a failed run of a task that is already running somewhere else.
 *
 * A revive IS a live status written onto a terminal row, so it takes 0130's execution claim — and
 * `session_task_execution_claim_idx` allows exactly one live Session per task. When the task has
 * already been re-dispatched (Run Now, the sweeps, the auto-run the task list reconciles), the
 * revive loses the claim. Losing is correct; what the loss used to look like was not. The raw
 * `P2002` reached the API as a 500 with a PostgreSQL sentence in it, in front of somebody who
 * pressed a button, and said nothing about which session has the task.
 *
 * These cases pin the answer: the claim conflict becomes the same structured refusal the Run button
 * gets, named `TASK_ALREADY_RUNNING` and carrying the holder's public id. That the index really
 * answers this way — and that the shape of the duplicate is the one a live PostgreSQL produces — is
 * `task-run-winner-recovery.pg.spec.ts`'s half; a double can be told to raise anything.
 */

const OWNER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
/** The re-dispatched run that holds the claim. */
const SIBLING = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const TASK = '550e8400-e29b-41d4-a716-446655440000';
const now = new Date();

/**
 * The duplicate a real PostgreSQL raises on the claim index, as prisma 7.10 with `@prisma/adapter-pg`
 * reports it — the release this deployment runs, where `constraint.fields` is gone and the index's
 * NAME is all there is. A double is free to raise the friendlier 7.9 shape instead, and that is
 * exactly the double that would keep a classifier written against `meta.target` looking correct.
 */
function claimConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Session',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "session_task_execution_claim_idx"',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'session_task_execution_claim_idx' },
        },
      },
    },
  });
}

/** A duplicate on a key that is nobody's business here: the table's only other unique column. */
function foreignConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Session',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "session_share_token_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'session_share_token_key' },
        },
      },
    },
  });
}

function fixture(
  holder: Record<string, unknown> | null,
  failure: Prisma.PrismaClientKnownRequestError = claimConflict(),
) {
  // A terminal row that is otherwise perfectly resumable, so every refusal ahead of the claim is
  // passed rather than avoided: a test that stopped earlier would prove nothing about this one.
  const session = {
    id: SESSION,
    ownerId: OWNER,
    taskId: TASK,
    workspaceId: WORKSPACE,
    status: RunStatus.FAILED,
    startsTaskWork: true,
    startedAt: now,
    numTurns: 3,
    runtimeSessionId: 'runtime-1',
    assignedRunnerId: 'runner-1',
    cancelRequestedAt: null,
    archivedAt: null,
    deletedAt: null,
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: now },
    provider: 'claude',
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
  };
  const holderReads: Array<Record<string, unknown>> = [];
  const sessionDelegate = {
    // Told apart by what they ask for, not by the order they arrive in: the pre-read names the row,
    // the refusal names the task.
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      if (args?.where && 'taskId' in args.where) {
        holderReads.push(args.where);
        return holder;
      }
      return session;
    },
    findUniqueOrThrow: async () => session,
    update: async () => session,
  };
  const prisma = {
    session: sessionDelegate,
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'turn-1', ...data }),
    },
    // The task facts `taskWorkRefusalFor` reads: an ordinary leaf, so the aggregate gate and the
    // supersession gate both stand aside and the claim is what is left.
    $queryRaw: async () => [{
      terminalReason: null,
      supersededByTaskId: null,
      subjectTerminalReason: null,
      subjectSupersededByTaskId: null,
      completionPolicy: 'MANUAL',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      verifiesTaskId: null,
      hasDirectChildren: false,
    }],
    // The revive transaction fails on its own status flip, which is the write that reaches the
    // claim index. Raised by the runner so the case does not depend on how far into the closure a
    // double happens to get.
    $transaction: async () => {
      throw failure;
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  return { service, holderReads };
}

const retry = { clientTurnId: 'retry-1', content: 'go on' };

test('a revive that loses the execution claim is a 409 naming the session that holds it', async () => {
  const { service, holderReads } = fixture({
    id: SIBLING,
    status: RunStatus.RUNNING,
    workspaceId: WORKSPACE,
    startsTaskWork: true,
    cancelRequestedAt: null,
  });

  await assert.rejects(
    () => service.resume(OWNER, SESSION, retry as never),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a 409, not a raw constraint violation');
      const body = error.getResponse() as Record<string, unknown>;
      assert.equal(body.code, 'TASK_ALREADY_RUNNING');
      assert.equal(body.conflictingSessionId, uuidToBase62(SIBLING));
      assert.equal(body.conflictingSessionStatus, RunStatus.RUNNING);
      assert.equal(body.taskId, uuidToBase62(TASK));
      assert.match(String(body.message), new RegExp(uuidToBase62(SIBLING)));
      return true;
    },
  );
  // The predicate the read asks by has to be the index's own: the four statuses 0130 covers, and
  // no narrowing to the rows somebody guessed were the interesting ones.
  const where = holderReads[0] as {
    taskId: string; deletedAt: null; status: { in: RunStatus[] };
  };
  assert.equal(where.taskId, TASK);
  assert.equal(where.deletedAt, null);
  assert.deepEqual(where.status.in, [
    RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED,
  ]);
});

test('the refusal says which of the shapes the holder is', async () => {
  const onAnotherAgent = fixture({
    id: SIBLING,
    status: RunStatus.RUNNING,
    workspaceId: OTHER_WORKSPACE,
    startsTaskWork: true,
    cancelRequestedAt: null,
  });
  await assert.rejects(
    () => onAnotherAgent.service.resume(OWNER, SESSION, retry as never),
    (error: unknown) => {
      assert.match(String((error as Error).message), /on a different agent/);
      return true;
    },
  );

  const ending = fixture({
    id: SIBLING,
    status: RunStatus.RUNNING,
    workspaceId: WORKSPACE,
    startsTaskWork: true,
    cancelRequestedAt: now,
  });
  await assert.rejects(
    () => ending.service.resume(OWNER, SESSION, retry as never),
    (error: unknown) => {
      assert.match(String((error as Error).message), /and is ending/);
      return true;
    },
  );
});

test('a claim taken and released under the revive is a retry, not a raw P2002', async () => {
  // No holder to name: whoever the write lost to let go in between. Nothing of the revive landed,
  // so the honest answer is that a retry does not meet it — and it still may not be a 500.
  const { service } = fixture(null);
  await assert.rejects(
    () => service.resume(OWNER, SESSION, retry as never),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code?: string }).code, undefined);
      assert.match(String((error as Error).message), /nothing was changed; retry/);
      return true;
    },
  );
});

test('a duplicate on some other unique key is nobody\'s claim and stays as it was thrown', async () => {
  // The negative control. A classifier that answered "somebody else is running this task" to any
  // duplicate at all would be naming a row off an error that never mentioned one.
  const thrown = foreignConflict();
  const { service } = fixture(null, thrown);
  await assert.rejects(
    () => service.resume(OWNER, SESSION, retry as never),
    (error: unknown) => {
      assert.equal(error, thrown, 'the very error the database raised, untouched');
      assert.ok(!(error instanceof ConflictException));
      return true;
    },
  );
});
