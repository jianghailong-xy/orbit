import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';

import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';
import { taskRunDesiredSessionId, taskRunRequestKey } from './task-run-identity';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const OWNER_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const WINNER_ID = '22222222-2222-4222-8222-222222222222';

/** The duplicate PostgreSQL raises on `session_task_execution_claim_idx`, as Prisma reports it. */
function claimConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: '7.9.1', meta: { target: ['task_id'] },
  });
}

/** The one the derived id put back in range: something already carries this row's id. */
function primaryKeyConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: '7.9.1', meta: { target: ['id'] },
  });
}

/**
 * The SAME two duplicates as Prisma 7 with `@prisma/adapter-pg` reports them — the shape this
 * deployment actually runs, captured off a real PostgreSQL. `meta.target` is ABSENT here: the
 * conflicting key is at `meta.driverAdapterError.cause`, and the classifier that read only
 * `meta.target` therefore said "not mine" to every lost execution claim and rethrew the P2002.
 */
function adapterConflict(constraint: string, fields: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'Session',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { fields },
        },
      },
    },
  });
}

type Row = {
  id: string;
  status: RunStatus;
  taskId?: string | null;
  ownerId?: string | null;
  workspaceId?: string;
  provider?: string;
  model?: string | null;
  startsTaskWork?: boolean;
  cancelRequestedAt?: Date | null;
};

/**
 * `execute` with the Session insert losing the execution claim, and every read the recovery makes
 * observable.
 *
 * The task carries no project, no schedule and an OPEN status, so the three post-commit steps are
 * no-ops and what the call returns is exactly what the recovery decided.
 */
function fixture(opts: {
  /** What the insert raises. Defaults to the claim index. */
  conflict?: Error;
  /** What names this request. Every caller of `execute` carries one; see `RunTaskDto.triggerId`. */
  requestToken?: string;
  /** The row sitting at the id this request derives, in whatever status. */
  atDesiredId?: Row | null;
  /** The row holding the claim, read by the index's own predicate. */
  holder?: Row | null;
  task?: { provider?: string | null; model?: string | null };
}) {
  const requestToken = opts.requestToken ?? 'press-1';
  const task = { provider: null as string | null, model: null as string | null, ...opts.task };
  const seen = { createdWith: [] as unknown[], findUnique: [] as any[] };
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async () => ({
        id: TASK_ID, title: 'Ship it', description: null, status: 'OPEN', runAt: null,
        projectId: null, listId: null, dispatchHold: false, dispatchAuthority: 'LEGACY',
        completionPolicy: 'MANUAL', children: [], supersededByTaskId: null, terminalReason: null,
        verifies: null, list: null, assignee: { id: WORKSPACE_ID, runnerId: 'runner-1' },
        ...task,
      }),
    },
    taskDependency: { findMany: async () => [] },
    // A dispatch copies the task's input files into the run it opens
    // (`copyTaskAttachments`); these fixtures attach none, so nothing is copied.
    attachment: { findMany: async () => [] },
    session: {
      findUnique: async (args: any) => {
        seen.findUnique.push(args);
        return opts.atDesiredId ?? null;
      },
      // The mid-flight dedup and the continue-a-paused-run read both come through here and both
      // find nothing: this fixture is the race, where every caller saw a free claim.
      findFirst: async ({ where }: any) =>
        (where?.status?.in?.length === 4 ? (opts.holder ?? null) : null),
    },
  } as never;
  const sessions = {
    create: async (_owner: string, _dto: unknown, createOpts: { id?: string }) => {
      seen.createdWith.push(createOpts.id);
      throw opts.conflict ?? claimConflict();
    },
  } as never;
  const service = new TasksService(prisma, sessions, { publishForUser: () => {} } as never);
  const desiredSessionId = taskRunDesiredSessionId(
    taskRunRequestKey({ taskId: TASK_ID, requestToken }),
  );
  return { service, seen, desiredSessionId, requestToken };
}

const holderRow = (over: Partial<Row> = {}): Row => ({
  id: OTHER_ID, status: RunStatus.RUNNING, workspaceId: WORKSPACE_ID, provider: 'claude',
  model: null, startsTaskWork: true, cancelRequestedAt: null, ...over,
});

test('the Session is created with the id this request derives, not a fresh one', async () => {
  // Nothing at that id yet, so the door actually attempts the write — which is the only state in
  // which "what id did it write with" is observable. (With a row already there it returns that row
  // and never calls create, which is the request-already-served path the tests below cover.)
  const f = fixture({ atDesiredId: null, holder: null });

  await assert.rejects(() => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken));

  assert.deepEqual(f.seen.createdWith, [f.desiredSessionId]);
});

// The repair, stated as the seven states a winner can be in. Each one used to be answered
// differently and three of them wrongly: PENDING/RUNNING were returned, AWAITING_INPUT/INTERRUPTED
// were reported to their own caller as somebody ELSE's live claim, and the three terminal ones fell
// out of the live-only read entirely and left the raw P2002 to reach the API as a 500.
for (const status of [
  RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED,
  RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED,
]) {
  test(`a winner at ${status} is returned as the winner`, async () => {
    const f = fixture({
      atDesiredId: { id: WINNER_ID, status, taskId: TASK_ID, ownerId: OWNER_ID },
      // ...even with a live claim held by something else. The row at this request's own id is the
      // answer, so the claim holder is never consulted.
      holder: holderRow(),
    });

    const result = await f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken);

    assert.deepEqual(result, { ok: true, sessionId: WINNER_ID });
  });
}

test('the winner is read by id alone — no status, no deleted_at, no ordering', async () => {
  const f = fixture({
    atDesiredId: { id: WINNER_ID, status: RunStatus.SUCCEEDED, taskId: TASK_ID, ownerId: OWNER_ID },
  });

  await f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken);

  assert.equal(f.seen.findUnique.length, 1);
  assert.deepEqual(f.seen.findUnique[0].where, { id: f.desiredSessionId });
});

test('a live claim belonging to a different request is named, never adopted and never a P2002', async () => {
  const f = fixture({ atDesiredId: null, holder: holderRow({ status: RunStatus.RUNNING }) });

  await assert.rejects(() => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken), (error: Error) => {
    assert.ok(error instanceof ConflictException, `409, not ${error.constructor.name}`);
    assert.match(error.message, /holds its execution claim/);
    return true;
  });
});

test('a paused holder is named as the holder it is, not as a run that finished', async () => {
  const f = fixture({ atDesiredId: null, holder: holderRow({ status: RunStatus.AWAITING_INPUT }) });

  await assert.rejects(
    () => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken),
    (error: Error) => /AWAITING_INPUT/.test(error.message),
  );
});

test('a holder on another agent still says so', async () => {
  const f = fixture({
    atDesiredId: null,
    holder: holderRow({ workspaceId: '7c9e6679-7425-40de-944b-e07fc1f90ae8' }),
  });

  await assert.rejects(
    () => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken),
    (error: Error) => /on a different agent/.test(error.message),
  );
});

test('a holder on another provider is refused by name, as it always was', async () => {
  const f = fixture({
    task: { provider: 'claude' }, atDesiredId: null, holder: holderRow({ provider: 'codex' }),
  });

  await assert.rejects(
    () => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken),
    (error: Error) => /pinned to claude/.test(error.message),
  );
});

test('a holder that is ending, or was never doing the work, is refused rather than reported as a start', async () => {
  const ending = fixture({ atDesiredId: null, holder: holderRow({ cancelRequestedAt: new Date() }) });
  await assert.rejects(
    () => ending.service.execute(OWNER_ID, TASK_ID, undefined, ending.requestToken),
    (error: Error) => /and is ending/.test(error.message),
  );

  const looking = fixture({ atDesiredId: null, holder: holderRow({ startsTaskWork: false }) });
  await assert.rejects(
    () => looking.service.execute(OWNER_ID, TASK_ID, undefined, looking.requestToken),
    (error: Error) => /not run it/.test(error.message),
  );
});

test('a claim taken and released while this request was writing is a refusal, never a bare P2002', async () => {
  // The 500 this unit exists to remove: no row at the derived id and nothing holding the claim used
  // to rethrow the duplicate-key error, and a person who clicked Run Now got a PostgreSQL sentence.
  const f = fixture({ atDesiredId: null, holder: null });

  await assert.rejects(() => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken), (error: Error) => {
    assert.ok(error instanceof ConflictException, `409, not ${error.constructor.name}`);
    assert.ok(!(error instanceof Prisma.PrismaClientKnownRequestError));
    assert.match(error.message, /nothing of it is running/);
    return true;
  });
});

test('the row at the derived id has to be this task\'s and this owner\'s to be this request\'s run', async () => {
  // It cannot be either — the id is a function of the task, and the owner scopes the task — so this
  // is the "the derivation landed on something else" branch, and it refuses rather than handing the
  // caller a session that is not its run.
  const f = fixture({
    conflict: primaryKeyConflict(),
    atDesiredId: { id: WINNER_ID, status: RunStatus.RUNNING, taskId: OTHER_ID, ownerId: OWNER_ID },
    holder: null,
  });

  await assert.rejects(
    () => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken),
    (error: Error) => error instanceof ConflictException && /nothing of it is running/.test(error.message),
  );
});

test('a primary-key duplicate is classified too — the derived id is what put it in range', async () => {
  const f = fixture({
    conflict: primaryKeyConflict(),
    atDesiredId: { id: WINNER_ID, status: RunStatus.FAILED, taskId: TASK_ID, ownerId: OWNER_ID },
  });

  const result = await f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken);

  assert.deepEqual(result, { ok: true, sessionId: WINNER_ID });
});

test('a duplicate on a unique key this unit does not own still reaches the caller unchanged', async () => {
  const foreign = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: '7.9.1', meta: { target: ['share_token'] },
  });
  const f = fixture({ conflict: foreign, atDesiredId: null, holder: null });

  await assert.rejects(() => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken), (error: Error) => {
    assert.equal(error, foreign, 'classified, not swallowed into a sentence about running a task');
    return true;
  });
});

// The shape a real server produces, pinned. Without these three the unit suite is green against a
// driver this deployment does not use, and every lost claim leaks a 500 in production.
test('the execution claim as Prisma 7\'s pg adapter reports it is still classified', async () => {
  const f = fixture({
    conflict: adapterConflict('session_task_execution_claim_idx', ['task_id']),
    atDesiredId: { id: WINNER_ID, status: RunStatus.SUCCEEDED, taskId: TASK_ID, ownerId: OWNER_ID },
  });

  const result = await f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken);

  assert.deepEqual(result, { ok: true, sessionId: WINNER_ID });
});

test('the primary key as Prisma 7\'s pg adapter reports it is still classified', async () => {
  const f = fixture({
    conflict: adapterConflict('session_pkey', ['id']),
    atDesiredId: { id: WINNER_ID, status: RunStatus.CANCELLED, taskId: TASK_ID, ownerId: OWNER_ID },
  });

  const result = await f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken);

  assert.deepEqual(result, { ok: true, sessionId: WINNER_ID });
});

test('and a unique key this unit does not own is still not classified in that shape either', async () => {
  const foreign = adapterConflict('session_project_action_id_key', ['project_action_id']);
  const f = fixture({ conflict: foreign, atDesiredId: null, holder: null });

  await assert.rejects(() => f.service.execute(OWNER_ID, TASK_ID, undefined, f.requestToken), (error: Error) => {
    assert.equal(error, foreign);
    return true;
  });
});
