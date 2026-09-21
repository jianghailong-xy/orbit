/**
 * Which door puts a list's runs past its own concurrency cap — the sweep, or the completion edge?
 *
 * A list doubles as the durable batch the claim reads (`batchActiveTurns(s) < s.batch_max_concurrent`,
 * queue.service.ts), and its `max_concurrent` is also spent as a MATERIALISATION budget by the two
 * sweeps: they ask "is there any point creating another session" and a PENDING row counts, because
 * it is already queued for the next free slot (a2cbd3543 — "create a session when there is a slot
 * for it, not when a task is released").
 *
 * On 2026-09-21 the list `01a00627-38a3-7752-aebf-7749e3a0ed7d` ("FineWeb 依赖的 Common Crawl WARC")
 * carried ten non-terminal sessions under a ceiling of 1 that had not moved since 2026-08-15. Its
 * rows split across two doors, and neither of them is the sweep:
 *
 *   * SIX, created ~4 minutes apart (17:22:18, 17:26:13, 17:30:45, 17:35:10, 17:39:01, 17:42:42), are
 *     the runtime of the FineWeb parquet task each WARC task depends on: every completion dispatched
 *     its WARC successor immediately. Their receipts carry the automatic dependency token
 *     `TASK_RUN_TRIGGER.dependency` (`dep:<task>:<epoch>`), each created 0.4–2.6s after its
 *     prerequisite's own DONE — five of the six while the list was already at its ceiling, so the
 *     sweep, which refuses at the ceiling, could not have been the one that wrote them.
 *     `dispatch_origin = LEGACY_SWEEP`, `run_source = TASK_LIST_AUTO`.
 *   * THREE (09-20 19:05:24, and 09-21 01:07:52 / 01:15:15) carry a bare `triggerId` and
 *     `dispatch_origin = USER`, `run_source = MANUAL`: a person or an agent pressing Run on a task
 *     whose previous run had FAILED and which was still OPEN. That door is deliberate — a press is
 *     respected, and the claim serialises it afterwards — and it is also what those three were left
 *     with: six rows were already queued, so the sweep's free count was negative and no automatic
 *     door would start them.
 *
 * Two doors carry the `dep:` token: `reconcileReadyTasks` (the sweep, which spends the ceiling as a
 * MATERIALISATION budget — "is there any point creating another session", counting PENDING because
 * it is already queued for the next free slot, a2cbd3543) and `dispatchDependentsAfterCompletion`
 * (the completion edge, which does not read the budget at all: `dispatchReadyTask` goes straight to
 * `execute`). This spec runs both of them, and the manual door besides, over one fixture.
 *
 * What is asserted, against a real PostgreSQL and by COUNTING SESSIONS rather than by watching a
 * call — "was it materialised" is the question, and the run that exists afterwards is its evidence:
 *
 *   (1) the SWEEP materialises one session and then refuses, at the cap: a second task that is
 *       genuinely READY, opted into auto-run and assigned is left OPEN with no session, and its
 *       receipt is never even opened;
 *   (2) the COMPLETION EDGE materialises the very run the sweep refused, with the list at its cap
 *       and no budget consulted — same world, same instant, the other door, and the count goes past
 *       the cap. That contrast is the whole answer, and the last case holds it to it: with the cap
 *       raised, the SWEEP dispatches the very tasks it refused in (1) and (2), so the cap is what
 *       held them;
 *   (3) the MANUAL door is not bounded by it either, and it says which door it was on the row it
 *       writes (`dispatch_origin = USER`, `run_source = MANUAL`) — the discriminator the incident's
 *       six automatic rows and three manual rows differ by;
 *   (4) the side effect of going over: once the batch is past its cap the sweep's free count is
 *       negative and it materialises nothing more, however READY the work is — a list that has gone
 *       over its own cap stops its own auto-run until enough sessions leave the non-terminal set,
 *       which is why the incident's last three rows are ones a person started by hand;
 *   (5) the claim is untouched by any of it: `claimSessionForRunner` still hands out exactly the cap
 *       — one row of the two queued — so the sessions past the cap queue, they do not run.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  queue: QueueService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    tasks: new TasksService(prisma, sessions, publishes),
    // The real claim, not a restatement of its WHERE clause: what is asserted is what the queue
    // offers out of a batch that is over its cap.
    queue: new QueueService(prisma, publishes),
  };
}

/** An owner with one online runner and one workspace bound to it, roomier than any list here. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${RUN}-${ids.ownerId}@beyond-cap.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      // The runner's own ceiling must not be what an assertion here measures: every case is about
      // the LIST's, and the runner has room for every task in the fixture.
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-agent`,
      enabled: true,
      workDir: '/tmp',
    },
  });
  return ids;
}

async function seedList(
  db: PrismaClient,
  ids: World,
  title: string,
  maxConcurrent: number,
): Promise<string> {
  const list = await db.taskList.create({
    data: { id: randomUUID(), ownerId: ids.ownerId, title: `${title}-${RUN}`, maxConcurrent },
    select: { id: true },
  });
  return list.id;
}

/**
 * One task of the list, opted into auto-run and assigned, optionally already DONE and optionally
 * waiting on prerequisites — the shape the incident's list was made of.
 *
 * `prerequisites` are ids that must already exist. Nothing is inferred from them: a task whose
 * prerequisites are all DONE is READY, which is what both doors below read off the database.
 */
async function seedTask(
  db: PrismaClient,
  ids: World,
  listId: string,
  title: string,
  opts: { prerequisites?: string[]; status?: TaskStatus } = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: ids.ownerId,
      listId,
      assigneeId: ids.workspaceId,
      title: `${title}-${RUN}`,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: opts.status ?? TaskStatus.OPEN,
      autoRunWhenReady: true,
      dispatchHold: false,
    },
    select: { id: true },
  });
  for (const prerequisite of opts.prerequisites ?? []) {
    await db.taskDependency.create({
      data: { taskId: id, dependsOnTaskId: prerequisite },
    });
  }
  return id;
}

/** The runs the batch is holding: what the materialisation budget and the claim both count. */
async function queued(
  db: PrismaClient,
  listId: string,
): Promise<Array<{ id: string; taskId: string | null; status: string; cap: number | null }>> {
  const rows = await db.session.findMany({
    where: { batchId: listId, status: { in: ['PENDING', 'RUNNING'] } },
    select: { id: true, taskId: true, status: true, batchMaxConcurrent: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    status: String(row.status),
    cap: row.batchMaxConcurrent,
  }));
}

/** Whether this task has a run at all — the receipt exists even for a refusal, so count rows. */
const sessionsOfTask = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId } });

/** The real auto-run sweep, as the timer runs it. */
const sweep = (stack: Stack) =>
  (stack.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const suite = URL ? test : test.skip;

suite('which door materialises a run past a list cap, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const { db, tasks, queue } = connect();
  t.after(async () => {
    await db.$disconnect();
  });

  /**
   * The fixture both cases are built from, at whatever cap the caller names.
   *
   * `p1` is already DONE, so `x` is READY from the start and is the sweep's first materialisation.
   * `p2` and `p3` are the prerequisites the case settles by hand to make `a` and `y` READY later,
   * and `b` waits on `a` — the FineWeb → {next FineWeb, WARC} fan-out the incident's list had, with
   * one dependent of each completion.
   */
  async function fixture(label: string, maxConcurrent: number) {
    const ids = await world(db, label);
    const listId = await seedList(db, ids, label, maxConcurrent);
    const p1 = await seedTask(db, ids, listId, 'p1', { status: TaskStatus.DONE });
    const p2 = await seedTask(db, ids, listId, 'p2');
    const p3 = await seedTask(db, ids, listId, 'p3');
    const x = await seedTask(db, ids, listId, 'x', { prerequisites: [p1] });
    const y = await seedTask(db, ids, listId, 'y', { prerequisites: [p3] });
    const a = await seedTask(db, ids, listId, 'a', { prerequisites: [p2] });
    const b = await seedTask(db, ids, listId, 'b', { prerequisites: [a] });
    return { ids, listId, p2, p3, x, y, a, b };
  }

  await t.test('the sweep materialises up to the cap and refuses past it', async () => {
    const f = await fixture('sweep-refuses', 1);

    // Only `x` is a candidate: `p1` is DONE so `x` is READY, and `y`/`a`/`b` are still waiting on
    // prerequisites of their own. The cap allows one, so one is what exists afterwards.
    await sweep({ db, tasks, queue });
    assert.deepEqual(
      (await queued(db, f.listId)).map((row) => row.taskId),
      [f.x],
      'the sweep did not materialise the one READY task the cap allows',
    );

    // The control on the OTHER half of the predicate: the same fixture, one genuinely READY task
    // more, and the sweep still materialises nothing. Without this, "no session for `a`" would be
    // indistinguishable from a predicate that never selected `a` in the first place.
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p2, 'p2');
    await sweep({ db, tasks, queue });
    assert.equal(
      await sessionsOfTask(db, f.a),
      0,
      'the sweep materialised a second run for a list whose cap is one',
    );
    assert.equal(
      await db.taskRunRequest.count({ where: { fingerprint: `task:${f.a}` } }),
      0,
      'the sweep reached the run door for a task the list had no room for',
    );
    assert.equal((await queued(db, f.listId)).length, 1, 'the batch grew without a free slot');

    // Two sweeps in a row leave the same one row: the budget is what stopped it, not a pass that
    // did not get round to it.
    await sweep({ db, tasks, queue });
    assert.equal((await queued(db, f.listId)).length, 1, 'a later sweep materialised past the cap');
  });

  await t.test('the completion edge materialises past the cap, and the sweep then cannot', async () => {
    const f = await fixture('completion-edge', 1);

    await sweep({ db, tasks, queue });
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p2, 'p2');
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.a, 'a');
    // `a` is DONE now, so `b` is READY. The list is still at its cap, so the sweep refuses it —
    // this is the state the completion edge is about to act in, asserted first so the two doors
    // are measured against the same world rather than two worlds an assertion apart.
    await sweep({ db, tasks, queue });
    assert.equal(await sessionsOfTask(db, f.b), 0, 'the sweep materialised `b` at a full cap');

    // The completion edge, as the doors call it (`runner-api`, `update`, the evidence judgment and
    // the owner's confirmation all reach this one method).
    await tasks.dispatchDependentsAfterCompletion(f.ids.ownerId, f.a);

    const after = await queued(db, f.listId);
    assert.deepEqual(
      after.map((row) => row.taskId).sort(),
      [f.b, f.x].sort(),
      'the completion edge did not materialise the dependent it unblocked',
    );
    assert.equal(after.length, 2, 'the run the completion edge materialised is not the second one');
    // The row it created is a normal batch row: it carries the list and the ceiling in force, so
    // the claim below is the gate it is queued behind and not the runner's.
    const created = after.find((row) => row.taskId === f.b)!;
    assert.equal(created.cap, 1, 'the run it materialised does not carry the list ceiling');
    assert.equal(created.status, 'PENDING');

    // (3) The side effect, as a property of this same batch: `free = 1 - 2` is negative, so the
    // sweep materialises nothing more however READY the work is. `p3` is settled here to give it a
    // genuine candidate to refuse.
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p3, 'p3');
    await sweep({ db, tasks, queue });
    assert.equal(
      await sessionsOfTask(db, f.y),
      0,
      'the sweep materialised into a batch that is already over its cap',
    );
    assert.equal(
      (await queued(db, f.listId)).length,
      2,
      'the batch grew while it was over its own cap',
    );

    // (4) And the cap still holds where it is authoritative: the claim. Two rows are queued under a
    // ceiling of one, and the claim hands out one of them — the second asks again and is answered
    // null, because the first is now RUNNING and `batchActiveTurns` counts it.
    const runner = { id: f.ids.runnerId, supportedProviders: [] };
    const first = await queue.claimSessionForRunner(runner, 0);
    assert.ok(first, 'the claim offered nothing from a batch with two queued runs');
    assert.ok(
      after.some((row) => row.id === first!.sessionId),
      'the claim handed out a session that is not one of this batch',
    );
    assert.equal(
      await queue.claimSessionForRunner(runner, 0),
      null,
      'the claim handed out a second run under a ceiling of one — the cap was not compressed',
    );
    const claimed = await queued(db, f.listId);
    assert.equal(
      claimed.filter((row) => row.status === 'RUNNING').length,
      1,
      'more than one run of the batch is RUNNING',
    );
    assert.equal(claimed.length, 2, 'claiming changed how many runs the batch holds');
  });

  await t.test('the manual door is not bounded by the cap either, and says so on the row', async () => {
    // The other entrance the incident's rows name, and the one that is deliberate: a person or an
    // agent pressing Run on a task is respected, and the claim serialises it afterwards. Asserted
    // here so that "the count went past the cap" is not read as one door's fault when two doors do
    // it — and because the two are told apart by what they write, not by the count.
    const f = await fixture('manual-door', 1);
    await sweep({ db, tasks, queue });
    assert.equal((await queued(db, f.listId)).length, 1);

    // `y` has to be genuinely runnable: the manual door is not a way round the dependency gate, and
    // it throws rather than skipping when its prerequisites are open.
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p3, 'p3');
    await tasks.execute(f.ids.ownerId, f.y);

    const after = await queued(db, f.listId);
    assert.deepEqual(
      after.map((row) => row.taskId).sort(),
      [f.x, f.y].sort(),
      'the manual press did not materialise the run it named',
    );
    const manual = await db.session.findFirstOrThrow({
      where: { batchId: f.listId, taskId: f.y },
      select: { dispatchOrigin: true, runSource: true, status: true, batchMaxConcurrent: true },
    });
    assert.equal(manual.dispatchOrigin, 'USER', 'the manual run is not attributed to its door');
    assert.equal(manual.runSource, 'MANUAL');
    assert.equal(manual.status, 'PENDING', 'the run past the cap is not waiting for a slot');
    assert.equal(manual.batchMaxConcurrent, 1, 'the manual run does not carry the list ceiling');

    // And the automatic rows are distinguishable from it by the same columns, which is how the
    // incident's six were told from its three.
    const automatic = await db.session.findFirstOrThrow({
      where: { batchId: f.listId, taskId: f.x },
      select: { dispatchOrigin: true, runSource: true },
    });
    assert.equal(automatic.dispatchOrigin, 'LEGACY_SWEEP');
    assert.equal(automatic.runSource, 'TASK_LIST_AUTO');

    // Neither door's overshoot reaches the gate: the claim still hands out the cap, not the count.
    const runner = { id: f.ids.runnerId, supportedProviders: [] };
    assert.ok(await queue.claimSessionForRunner(runner, 0), 'the claim offered nothing');
    assert.equal(
      await queue.claimSessionForRunner(runner, 0),
      null,
      'the claim handed out a second run under a ceiling of one',
    );
  });

  await t.test('the control: with room, the sweep materialises the very tasks it refused', async () => {
    // One column away from both cases above — the same fixture, a cap with room — so that "the
    // sweep left it OPEN" is answered by the cap and not by the candidate predicate.
    const f = await fixture('cap-with-room', 8);
    await sweep({ db, tasks, queue });
    assert.deepEqual(
      (await queued(db, f.listId)).map((row) => row.taskId),
      [f.x],
      'the sweep did not materialise the READY task',
    );

    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p2, 'p2');
    await sweep({ db, tasks, queue });
    assert.equal(
      await sessionsOfTask(db, f.a),
      1,
      'the sweep did not materialise a READY task a cap with room allows — so the refusals above '
        + 'were not measuring the cap',
    );

    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.p3, 'p3');
    await sweep({ db, tasks, queue });
    assert.equal(await sessionsOfTask(db, f.y), 1, 'the second READY task was not materialised');

    assert.equal(
      (await queued(db, f.listId)).length,
      3,
      'the batch is not holding the three sweeps materialised under a cap of eight',
    );
  });
});
