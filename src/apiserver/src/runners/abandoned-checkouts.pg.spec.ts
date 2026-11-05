/**
 * A FINISHED SESSION'S UNCOMMITTED CHECKOUT IS SOMETHING SOMEBODY CAN SEE AND SETTLE.
 *
 * `removeWorktree` refuses a checkout whose `git status --porcelain` is non-empty — the work
 * exists on no branch, so removing it would destroy the only copy — and nothing else could act on
 * one. On 2026-11-05 there were 47 such checkouts on the production host, from September, carried
 * past every cap. The runner now reports the whole set (`/runner/abandoned-checkouts`), the
 * runner page lists the finished ones with their diff, and the owner commits or discards each.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/abandoned-checkouts.pg.spec.ts
 *
 * What this holds the doors to:
 *   (1) The list is the FINISHED sessions' checkouts — a parked session can be dirty between
 *       turns, and is not abandoned. Ingesting both stores one.
 *   (2) The inventory REPLACES: a checkout a later report no longer names stops being listed.
 *   (3) Discard rides the commit relay: queued with an operation id and the action, handed only
 *       to a runner that declared abandoned-checkout-v1 (an older one would commit the work
 *       instead — the opposite of what was pressed), and the outcome clears the entry exactly as
 *       a commit does.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const FINISHED = 'finished-checkout';
const PARKED = 'parked-checkout';

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  runners: RunnersService;
  sessions: SessionsService;
  /** The real one, built by hand: drainCommitRequests is the door the discard rides. */
  realtime: RealtimeService;
}

/** The production wiring, over one client and with no seam in the paths under test. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new RealtimeService(prisma, {} as never);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    realtime,
    runners: new RunnersService(prisma),
    sessions: new SessionsService(prisma, queue, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  finishedSessionId: string;
  parkedSessionId: string;
}

/** One owner, one runner that can discard, and two sessions of it: one finished with the work
 *  still in its checkout, one at rest that is dirty between turns. */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const finishedSessionId = randomUUID();
  const parkedSessionId = randomUUID();
  const common = (title: string) => ({
    ownerId,
    creatorId: ownerId,
    workspaceId,
    assignedRunnerId: runnerId,
    title,
    prompt: title,
    provider: 'claude',
    dispatchOrigin: SessionDispatchOrigin.USER,
    startedAt: new Date(),
    runtimeSessionId: randomUUID(),
    isolationStatus: 'worktree',
    worktreeDirty: true,
  });
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@abandoned.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: ['abandoned-checkout-v1'],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: finishedSessionId,
      ...common('A session that ended with its work in the checkout'),
      status: RunStatus.SUCCEEDED,
      branch: `orbit/${FINISHED}`,
      completedAt: new Date(),
    },
  });
  await db.session.create({
    data: {
      id: parkedSessionId,
      ...common('A session at rest between turns'),
      status: RunStatus.AWAITING_INPUT,
      branch: `orbit/${PARKED}`,
    },
  });
  return { ownerId, runnerId, workspaceId, finishedSessionId, parkedSessionId };
}

const FILES = [
  { path: 'src/runner-go/worktree.go', additions: 12, deletions: 3, status: 'M' },
  { path: 'notes/next-steps.md', additions: 4, deletions: 0, status: 'A' },
];
const PATCHES = [
  {
    path: 'src/runner-go/worktree.go',
    patch: 'diff --git a/src/runner-go/worktree.go b/src/runner-go/worktree.go\n+// the work nobody committed\n',
  },
];

test('a finished session’s dirty checkout is listed with its diff, and a parked one is not', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'listed');

  const answer = await stack.api.abandonedCheckouts(
    { id: f.runnerId, ownerId: f.ownerId },
    {
      checkouts: [
        { sessionId: f.finishedSessionId, files: FILES, patches: PATCHES },
        { sessionId: f.parkedSessionId, files: FILES, patches: PATCHES },
      ],
    },
  );
  // The parked session's checkout is dropped at the door: it is somebody's live work.
  assert.equal(answer.kept, 1);
  assert.equal(
    await db.abandonedCheckout.count({ where: { sessionId: f.parkedSessionId } }),
    0,
    'a parked session is not an abandoned checkout',
  );
  // And what the runner SAW is recorded where the commit door reads it.
  assert.equal(
    (await db.session.findUniqueOrThrow({ where: { id: f.finishedSessionId } })).worktreeDirty,
    true,
  );

  const listed = await stack.runners.abandonedCheckouts(f.ownerId, f.runnerId);
  assert.equal(listed.checkouts.length, 1);
  const [entry] = listed.checkouts;
  assert.equal(entry.sessionId, f.finishedSessionId);
  assert.equal(entry.title, 'A session that ended with its work in the checkout');
  assert.equal(entry.branch, `orbit/${FINISHED}`);
  assert.deepEqual(entry.files, FILES);
  assert.equal(entry.hasPatches, true);
  // The list does not carry the diff text; that is one checkout at a time.
  assert.equal('patches' in (entry as unknown as Record<string, unknown>), false);

  const diff = await stack.runners.abandonedCheckoutDiff(f.ownerId, f.runnerId, f.finishedSessionId);
  assert.deepEqual(diff.patches, PATCHES);
  assert.deepEqual(diff.files, FILES);

  // Another account cannot read it, whatever ids it knows.
  await assert.rejects(
    () => stack.runners.abandonedCheckouts(randomUUID(), f.runnerId),
    /runner not found/u,
  );
});

test('a later report that no longer names a checkout drops it from the list', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'replaced');

  await stack.api.abandonedCheckouts(
    { id: f.runnerId, ownerId: f.ownerId },
    { checkouts: [{ sessionId: f.finishedSessionId, files: FILES, patches: PATCHES }] },
  );
  assert.equal((await stack.runners.abandonedCheckouts(f.ownerId, f.runnerId)).checkouts.length, 1);

  // Somebody committed the work by hand on the machine: the next scan finds nothing there.
  await stack.api.abandonedCheckouts({ id: f.runnerId, ownerId: f.ownerId }, { checkouts: [] });

  assert.equal((await stack.runners.abandonedCheckouts(f.ownerId, f.runnerId)).checkouts.length, 0);
  assert.equal(await db.abandonedCheckout.count({ where: { sessionId: f.finishedSessionId } }), 0);
});

test('discard is queued on the commit relay and handed only to a runner that can do it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'discard');
  await stack.api.abandonedCheckouts(
    { id: f.runnerId, ownerId: f.ownerId },
    { checkouts: [{ sessionId: f.finishedSessionId, files: FILES, patches: PATCHES }] },
  );

  await stack.sessions.discardCheckout(f.ownerId, f.finishedSessionId);
  const queued = await db.session.findUniqueOrThrow({
    where: { id: f.finishedSessionId },
    select: { commitStatus: true, commitAction: true, commitOperationId: true },
  });
  assert.equal(queued.commitStatus, 'pending');
  assert.equal(queued.commitAction, 'discard');
  assert.ok(queued.commitOperationId, 'the operation id is the ABA fence of the relay');

  // A runner that does not declare abandoned-checkout-v1 would ignore `discard` and COMMIT —
  // the opposite of what was pressed. It is handed nothing while the request stands.
  assert.deepEqual(
    await stack.realtime.drainCommitRequests(f.runnerId, randomUUID(), false),
    [],
  );
  const [command] = await stack.realtime.drainCommitRequests(f.runnerId, randomUUID(), true);
  assert.ok(command, 'a capable runner is handed the queued discard');
  assert.equal(command.sessionId, f.finishedSessionId);
  assert.equal(command.discard, true);
  assert.equal(command.operationId, queued.commitOperationId);
});

test('the runner’s discard outcome clears the checkout and the entry, as a commit does', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'discarded');
  await stack.api.abandonedCheckouts(
    { id: f.runnerId, ownerId: f.ownerId },
    { checkouts: [{ sessionId: f.finishedSessionId, files: FILES, patches: PATCHES }] },
  );
  await stack.sessions.discardCheckout(f.ownerId, f.finishedSessionId);
  const queueLease = randomUUID();
  const [command] = await stack.realtime.drainCommitRequests(f.runnerId, queueLease, true);

  // The runner object the guard hands over: `ownerId` is read from it at run time, while the
  // declared type is only the address.
  const callingRunner = { id: f.runnerId, ownerId: f.ownerId };
  await stack.api.commitResult(
    callingRunner,
    f.finishedSessionId,
    {
      operationId: command.operationId,
      leaseOwner: queueLease,
      status: 'discarded',
      message: 'Discarded. The work is kept at refs/orbit-discarded/… in this repository.',
    },
  );

  const after = await db.session.findUniqueOrThrow({
    where: { id: f.finishedSessionId },
    select: { worktreeDirty: true, commitStatus: true, commitAction: true, commitResultMessage: true },
  });
  assert.equal(after.worktreeDirty, false, 'nothing uncommitted is left in the checkout');
  assert.equal(after.commitStatus, 'discarded');
  assert.equal(after.commitAction, null);
  assert.match(after.commitResultMessage ?? '', /refs\/orbit-discarded/u);
  assert.equal(
    (await stack.runners.abandonedCheckouts(f.ownerId, f.runnerId)).checkouts.length,
    0,
    'the list drops the checkout as soon as its work is settled',
  );
});

test('a session still running, or a runner that cannot discard, is refused', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'refused');

  await assert.rejects(
    () => stack.sessions.discardCheckout(f.ownerId, f.parkedSessionId),
    (error: unknown) =>
      error instanceof ConflictException && /still running/u.test(error.message),
    'a live session is being worked in; discarding its checkout would race the turn',
  );

  await db.runner.update({
    where: { id: f.runnerId },
    data: { capabilities: [], capabilitiesReportedAt: new Date() },
  });
  await assert.rejects(
    () => stack.sessions.discardCheckout(f.ownerId, f.finishedSessionId),
    (error: unknown) =>
      error instanceof ConflictException && /does not support discarding/u.test(error.message),
  );
});
