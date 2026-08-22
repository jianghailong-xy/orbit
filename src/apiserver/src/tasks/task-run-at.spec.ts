import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TaskStatus } from '@orbit/shared';
import {
  SCHEDULED_DISPATCH_MAX_PER_SWEEP,
  TasksService,
  autoDispatchStillValid,
} from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TASK_ID = '550e8400-e29b-41d4-a716-446655440001';

/** A fixed instant, so nothing here depends on how long the suite takes to run. */
const SCHEDULED = new Date('2026-09-01T09:00:00.000Z');

function serviceWith(prisma: unknown, sessions: unknown = {}, realtime: unknown = {}): TasksService {
  return new TasksService(prisma as never, sessions as never, realtime as never);
}

/** Renders the tagged template PostgreSQL would get, like task-labels.spec's recorder. */
function recordingQueryRaw(rows: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const $queryRaw = async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    const sql = Prisma.sql(strings, ...(bound as never[])).text;
    statements.push(sql);
    return rows(sql);
  };
  return { statements, $queryRaw };
}

// ---------------------------------------------------------------------------
// The field: how a schedule is set, kept, changed and cancelled.
// ---------------------------------------------------------------------------

test('create stores the scheduled instant, and omitting it leaves the task unscheduled', async () => {
  const created: any[] = [];
  const service = serviceWith({
    task: { create: async ({ data }: any) => (created.push(data), { id: TASK_ID, ...data }) },
    taskList: { findMany: async () => [] },
  });

  await service.create(OWNER_ID, { title: 'nightly ingest', runAt: SCHEDULED.toISOString() } as any);
  assert.deepEqual(created[0].runAt, SCHEDULED);

  // Omission is the unscheduled case, and it must leave the column out of the INSERT rather than
  // write a default — that is what makes every task created before this field behave unchanged.
  await service.create(OWNER_ID, { title: 'right now' } as any);
  assert.equal(created[1].runAt, undefined);
});

test('a due date is not a schedule: setting one starts nothing', async () => {
  const created: any[] = [];
  const service = serviceWith({
    task: { create: async ({ data }: any) => (created.push(data), { id: TASK_ID, ...data }) },
    taskList: { findMany: async () => [] },
  });

  await service.create(OWNER_ID, { title: 'ship', dueDate: SCHEDULED.toISOString() } as any);

  assert.deepEqual(created[0].dueDate, SCHEDULED);
  assert.equal(created[0].runAt, undefined);
});

test('update is three-state: omitted preserves, an instant reschedules, null cancels', async () => {
  const writes: any[] = [];
  const service = serviceWith({
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        ownerId: OWNER_ID,
        status: TaskStatus.OPEN,
        comments: [],
        sessions: [],
        dependsOn: [],
        dependedOnBy: [],
      }),
      update: async ({ data }: any) => (writes.push(data), { id: TASK_ID }),
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
  });

  await service.update(OWNER_ID, TASK_ID, { title: 'renamed' } as any);
  assert.equal(writes[0].runAt, undefined, 'omitted must preserve the existing schedule');

  await service.update(OWNER_ID, TASK_ID, { runAt: SCHEDULED.toISOString() } as any);
  assert.deepEqual(writes[1].runAt, SCHEDULED);

  await service.update(OWNER_ID, TASK_ID, { runAt: null } as any);
  assert.equal(writes[2].runAt, null, 'null must clear it, not be ignored as "no value"');
});

test('the DTOs accept an ISO instant and reject anything that is not one', async () => {
  const errors = async (cls: any, body: Record<string, unknown>) =>
    (await validate(plainToInstance(cls, body))).flatMap((e) => Object.keys(e.constraints ?? {}));

  assert.deepEqual(await errors(CreateTaskDto, { title: 't', runAt: SCHEDULED.toISOString() }), []);
  // A UTC instant, not a wall clock: "tomorrow at nine" is a question about a timezone, and the
  // column stores the answer rather than the question.
  assert.deepEqual(await errors(CreateTaskDto, { title: 't', runAt: 'tomorrow' }), ['isDateString']);
  // One-shot only. A cron expression is not a date and is refused as one — there is no
  // recurrence for it to configure.
  assert.deepEqual(await errors(CreateTaskDto, { title: 't', runAt: '0 9 * * *' }), ['isDateString']);

  assert.deepEqual(await errors(UpdateTaskDto, { runAt: SCHEDULED.toISOString() }), []);
  assert.deepEqual(await errors(UpdateTaskDto, { runAt: null }), [], 'null is the cancel');
  assert.deepEqual(await errors(UpdateTaskDto, { runAt: 'later' }), ['isDateString']);
});

test('the schedule survives the API boundary as an ISO string in UTC', () => {
  // The column is a Date and every response is JSON.stringify'd by Nest, which is where the
  // instant becomes the string a client reads. Pinned because "9am" that arrives as a local
  // wall clock is the bug this whole field is easiest to get wrong in.
  assert.equal(JSON.parse(JSON.stringify({ runAt: SCHEDULED })).runAt, '2026-09-01T09:00:00.000Z');
});

// ---------------------------------------------------------------------------
// The trigger: a future schedule holds the task back, a due one lets it go.
// ---------------------------------------------------------------------------

test('the auto-run sweep will not start a task before its scheduled time', () => {
  // The predicate is SQL, so it is pinned as text: a stub cannot evaluate it, and this clause is
  // the only thing standing between "the last prerequisite landed on Friday" and a task the user
  // scheduled for Sunday starting on Friday.
  const { statements, $queryRaw } = recordingQueryRaw(() => []);
  const service = serviceWith({ $queryRaw });

  return (service as any).reconcileReadyTasks().then(() => {
    assert.match(statements[0], /\(t\.run_at IS NULL OR t\.run_at <= now\(\)\)/);
  });
});

test('a prerequisite finishing does not start a task scheduled for later', async () => {
  const executed: string[] = [];
  const future = new Date(Date.now() + 60 * 60_000);
  const service = serviceWith({
    taskDependency: { findMany: async () => [{ taskId: TASK_ID }, { taskId: OTHER_TASK_ID }] },
    task: {
      findMany: async () => [
        {
          id: TASK_ID,
          status: 'OPEN',
          autoRunWhenReady: true,
          runAt: future,
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
        {
          id: OTHER_TASK_ID,
          status: 'OPEN',
          autoRunWhenReady: true,
          runAt: null,
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
      ],
    },
  });
  (service as any).dependencyStatesFor = async () =>
    new Map([
      [TASK_ID, 'READY'],
      [OTHER_TASK_ID, 'READY'],
    ]);
  (service as any).execute = async (_o: string, id: string) => void executed.push(id);

  await (service as any).triggerDependents(OWNER_ID, 'done-task');

  // The unscheduled dependent runs the instant its prerequisite lands, exactly as before. The
  // scheduled one is held — and held, not dropped: its run_at is untouched, so the sweep starts
  // it when it comes due.
  assert.deepEqual(executed, [OTHER_TASK_ID]);
});

test('a dependent whose schedule has already passed is started by its prerequisite', async () => {
  const executed: string[] = [];
  const service = serviceWith({
    taskDependency: { findMany: async () => [{ taskId: TASK_ID }] },
    task: {
      findMany: async () => [
        {
          id: TASK_ID,
          status: 'OPEN',
          autoRunWhenReady: true,
          runAt: new Date(Date.now() - 60_000),
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
      ],
    },
  });
  (service as any).dependencyStatesFor = async () => new Map([[TASK_ID, 'READY']]);
  (service as any).execute = async (_o: string, id: string) => void executed.push(id);

  await (service as any).triggerDependents(OWNER_ID, 'done-task');

  // Both conditions are met — the time has come AND the prerequisites are finished — so whichever
  // of the two arrives last is the one that starts it.
  assert.deepEqual(executed, [TASK_ID]);
});

// ---------------------------------------------------------------------------
// The scheduled sweep.
// ---------------------------------------------------------------------------

/** Runs the scheduled sweep against a stub returning `due` from the candidate scan. */
function sweepFixture(
  due: { id: string; ownerId: string; runnerId: string; listId: string | null }[],
  options: { failExecuteFor?: string[]; budget?: Map<string, number> } = {},
) {
  const executed: string[] = [];
  let budgetReads = 0;
  const { statements, $queryRaw } = recordingQueryRaw(() => due);
  const service = serviceWith({ $queryRaw });
  (service as any).materialisationBudget = async () => {
    budgetReads += 1;
    return { runner: options.budget ?? new Map(), list: new Map() };
  };
  (service as any).execute = async (_o: string, id: string) => {
    if (options.failExecuteFor?.includes(id)) throw new Error(`cannot start ${id}`);
    executed.push(id);
  };
  return {
    executed,
    statements,
    budgetReads: () => budgetReads,
    sweep: () => (service as any).dispatchDueScheduledTasks() as Promise<void>,
  };
}

test('the sweep dispatches due tasks through the ordinary execute path', async () => {
  const f = sweepFixture([
    { id: TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: null },
    { id: OTHER_TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: 'list-1' },
  ]);

  await f.sweep();

  // execute(), not a second session-creation path: assignment, the provider/model pin, the
  // dependency check, the list's pause and the session dedup all stay where they already are.
  assert.deepEqual(f.executed, [TASK_ID, OTHER_TASK_ID]);
});

test('the scan asks only for tasks that are due AND actually runnable', async () => {
  const f = sweepFixture([]);

  await f.sweep();

  const sql = f.statements[0];
  // Due, and anchored on the column the partial index covers.
  assert.match(sql, /t\.run_at IS NOT NULL/);
  assert.match(sql, /t\.run_at <= now\(\)/);
  // The standing dispatch rules, each of which RETAINS the schedule by filtering the task out
  // here rather than letting execute() reject it (which would also log once a minute, forever).
  assert.match(sql, /t\.status = 'OPEN'::task_status/);
  assert.match(sql, /t\.dispatch_hold = false/, 'a paused list must hold a schedule back');
  assert.match(sql, /a\.runner_id IS NOT NULL/, 'no runner, no dispatch');
  assert.match(sql, /WITH RECURSIVE chain/, 'an unfinished prerequisite blocks — through its chain');
  assert.match(sql, /FROM session s/, 'nothing already occupying the task');
  // Deterministic and bounded: longest-overdue first, ties broken by id, capped per pass.
  assert.match(sql, /ORDER BY t\.run_at ASC, t\.id ASC/);
  assert.match(sql, /LIMIT \$\d+/);
  // A schedule is not an opt-in to dependency auto-run: a clock is its own trigger, and a task
  // with no prerequisites at all is the ordinary thing to schedule.
  assert.doesNotMatch(sql, /auto_run_when_ready/);
});

test('a sweep with nothing due costs one scan and no further work', async () => {
  const f = sweepFixture([]);

  await f.sweep();

  // The overwhelmingly common case on any real deployment: one partial-index scan that finds
  // nothing. It must not go on to price the fleet's spare capacity for an empty list of work.
  assert.equal(f.statements.length, 1);
  assert.equal(f.budgetReads(), 0);
  assert.equal(f.executed.length, 0);
});

test('a due task with no free slot keeps its schedule for a later sweep', async () => {
  const f = sweepFixture(
    [
      { id: TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: null },
      { id: OTHER_TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: null },
    ],
    { budget: new Map([['runner-1', 1]]) },
  );

  await f.sweep();

  // One materialised, one left alone. The one left is untouched — still OPEN, still carrying its
  // run_at — so it is still due, and the sweep that finds a free slot is the one that starts it.
  assert.deepEqual(f.executed, [TASK_ID]);
});

test('a dispatch that fails leaves the schedule in place rather than losing it', async () => {
  const f = sweepFixture(
    [
      { id: TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: null },
      { id: OTHER_TASK_ID, ownerId: OWNER_ID, runnerId: 'runner-1', listId: null },
    ],
    { failExecuteFor: [TASK_ID] },
  );

  // One task's failure must not take the sweep (or the rest of the due work) down with it. The
  // schedule is consumed inside execute(), after a run is away, so a throw here writes nothing.
  await f.sweep();

  assert.deepEqual(f.executed, [OTHER_TASK_ID]);
});

test('the per-sweep cap bounds the pass without capping the schedule', () => {
  // A bound on one pass, not a quota: what it leaves keeps its run_at and is taken next minute.
  assert.ok(SCHEDULED_DISPATCH_MAX_PER_SWEEP > 0);
  assert.ok(Number.isInteger(SCHEDULED_DISPATCH_MAX_PER_SWEEP));
});

// ---------------------------------------------------------------------------
// Consumption: exactly once, and never over somebody's newer schedule.
// ---------------------------------------------------------------------------

/** A task whose dispatch is stubbed out, so what these observe is the write that follows it. */
function executeFixture(runAt: Date | null, options: { cleared?: number } = {}) {
  const writes: any[] = [];
  const published: any[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        status: TaskStatus.OPEN,
        dispatchHold: false,
        runAt,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
      updateMany: async (args: any) => (writes.push(args), { count: options.cleared ?? 1 }),
    },
    taskDependency: { findMany: async () => [] },
    session: { findFirst: async () => null },
  };
  const sessions = { create: async () => ({ id: 'session-1' }) };
  const realtime = { publishForUser: (...args: any[]) => published.push(args) };
  return { service: serviceWith(prisma, sessions, realtime), writes, published };
}

test('a run that is actually accepted consumes the schedule exactly once', async () => {
  const f = executeFixture(SCHEDULED);

  const result = await f.service.execute(OWNER_ID, TASK_ID);

  assert.equal(result.sessionId, 'session-1');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.runAt, null);
  // One-shot: with run_at back to NULL the task has left the scheduled sweep's candidate set for
  // good, so it cannot be started by the clock a second time.
  assert.equal(f.writes[0].where.id, TASK_ID);
  assert.equal(f.writes[0].where.ownerId, OWNER_ID);
  assert.deepEqual(f.published[0].slice(1), ['task_changed', TASK_ID]);
});

test('the consumption is a compare-and-set on the instant the dispatch read', async () => {
  const f = executeFixture(SCHEDULED);

  await f.service.execute(OWNER_ID, TASK_ID);

  // Not a blind clear. A dispatch is several awaits long, and a user rescheduling inside that
  // window has stated an intention about a run that has not happened; matching on the old value
  // is what lets their write survive the one it raced.
  assert.deepEqual(f.writes[0].where.runAt, SCHEDULED);
});

test('a schedule that was changed mid-dispatch is left standing, and nothing is announced', async () => {
  // count: 0 is the concurrent reschedule — the row no longer carries the instant we read.
  const f = executeFixture(SCHEDULED, { cleared: 0 });

  await f.service.execute(OWNER_ID, TASK_ID);

  assert.equal(f.writes.length, 1, 'the CAS is attempted once and not retried over the new value');
  assert.equal(f.published.length, 0, 'nothing changed, so nothing is published');
});

test('running an unscheduled task writes nothing at all', async () => {
  const f = executeFixture(null);

  await f.service.execute(OWNER_ID, TASK_ID);

  // The overwhelming majority of tasks, and every task that predates the column: one comparison,
  // no query.
  assert.equal(f.writes.length, 0);
  assert.equal(f.published.length, 0);
});

test('Run Now supersedes a future schedule instead of being refused by it', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60_000);
  const f = executeFixture(future);

  const result = await f.service.execute(OWNER_ID, TASK_ID);

  // "Earliest automatic start" says nothing about a person deciding to start it now. The button
  // works, and the appointment it pre-empted is spent rather than left to fire again later.
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.runAt, null);
  assert.deepEqual(f.writes[0].where.runAt, future);
});

test('a dispatch that never happened leaves the schedule alone', async () => {
  // The task is held by its paused list, so execute() refuses before anything is dispatched.
  const writes: any[] = [];
  const service = serviceWith(
    {
      task: {
        findFirst: async () => ({
          id: TASK_ID,
          title: 'Ship it',
          status: TaskStatus.OPEN,
          dispatchHold: true,
          runAt: SCHEDULED,
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        }),
        updateMany: async (args: any) => (writes.push(args), { count: 1 }),
      },
      taskDependency: { findMany: async () => [] },
      session: { findFirst: async () => null },
    },
    { create: async () => ({ id: 'session-1' }) },
  );

  await assert.rejects(() => service.execute(OWNER_ID, TASK_ID), /paused/);

  // Missing the moment must not lose the appointment: resuming the list has to be enough to make
  // the task run, without the user having to notice the schedule was silently eaten.
  assert.equal(writes.length, 0);
});

test('a bulk run keeps the appointment the same way a single run does', async () => {
  const writes: any[] = [];
  const service = serviceWith(
    {
      task: {
        findMany: async () => [
          {
            id: TASK_ID,
            title: 'Ship it',
            description: null,
            provider: null,
            model: null,
            status: TaskStatus.OPEN,
            runAt: SCHEDULED,
            assignee: { id: 'workspace-1', runnerId: 'runner-1' },
          },
          {
            id: OTHER_TASK_ID,
            title: 'Also ship it',
            description: null,
            provider: null,
            model: null,
            status: TaskStatus.OPEN,
            runAt: null,
            assignee: { id: 'workspace-1', runnerId: 'runner-1' },
          },
        ],
        updateMany: async (args: any) => (writes.push(args), { count: 1 }),
      },
      taskDependency: { findMany: async () => [] },
      session: { findMany: async () => [] },
    },
    {},
    { publishForUser: () => {} },
  );
  (service as any).runWorkspaceOnTask = async () => 'session-1';

  const result = await service.batchExecute(OWNER_ID, [TASK_ID, OTHER_TASK_ID]);

  assert.equal(result.dispatched, 2);
  // One-shot means one run, not one run per way of starting it: without this the bulk-run task
  // would keep its schedule and be started again by the clock afterwards.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].where.id, TASK_ID);
  assert.deepEqual(writes[0].where.runAt, SCHEDULED);
  assert.equal(writes[0].data.runAt, null);
});

// ---------------------------------------------------------------------------
// Boundaries: the other paths that start a task, and the card that describes them.
// ---------------------------------------------------------------------------

test('an @-mention answers the comment without cancelling the schedule', async () => {
  // The mention path shares runWorkspaceOnTask with Run Now but is NOT Run Now: it is a reply to
  // a comment, not a decision to start the work. Consumption therefore lives in execute() and
  // batchExecute() rather than in the shared dispatcher — if it ever moves down there, answering
  // a question in the comments would silently cancel a schedule nobody meant to touch.
  const writes: any[] = [];
  const resumed: string[] = [];
  const service = serviceWith(
    {
      task: {
        findFirst: async () => ({
          id: TASK_ID,
          title: 'Ship it',
          description: null,
          provider: null,
          model: null,
          runAt: SCHEDULED,
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        }),
        updateMany: async (args: any) => (writes.push(args), { count: 1 }),
      },
      session: { findFirst: async () => null },
    },
    { create: async () => (resumed.push('created'), { id: 'session-1' }) },
  );

  await (service as any).triggerMentionedWorkspace(
    OWNER_ID,
    { id: TASK_ID, title: 'Ship it', provider: null, model: null },
    { id: 'workspace-1', runnerId: 'runner-1' },
    'what is the status here?',
  );

  assert.deepEqual(resumed, ['created'], 'the mention still gets its run');
  assert.equal(writes.length, 0, 'and the appointment it did not keep is still standing');
});

/** The batch-create preview's world: which workspaces have runners, which lists are paused. */
function previewService(world: { pausedLists?: string[]; runners?: Record<string, string | null> } = {}) {
  const runners = world.runners ?? { w1: 'runner-1' };
  const prisma = {
    workspace: {
      findMany: async ({ where }: any) =>
        (where?.id?.in ?? [])
          .filter((id: string) => id in runners)
          .map((id: string) => ({ id, name: id, runnerId: runners[id] })),
    },
    task: { findMany: async () => [] },
    taskList: {
      findMany: async ({ where }: any) =>
        (where?.id?.in ?? []).map((id: string) => ({
          id,
          title: 'L',
          paused: (world.pausedLists ?? []).includes(id),
        })),
    },
  };
  const service = serviceWith(prisma, {}, { publishForUser: () => undefined });
  for (const m of ['assertOwnedWorkspace', 'assertOwnedList', 'assertUsableProvider', 'assertOwnedTasks']) {
    (service as unknown as Record<string, unknown>)[m] = async () => undefined;
  }
  return service;
}

test('the batch card does not promise a run for an item scheduled for later', async () => {
  const later = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  const p = await previewService().previewCreateMany(OWNER_ID, {
    tasks: [
      { title: 'tonight', assigneeId: 'w1', runAt: later },
      { title: 'also tonight', assigneeId: 'w1', runAt: later },
    ],
  } as never);

  // The number the card leads with is how many begin immediately. These do not.
  assert.equal(p.startingNow, 0);
  assert.equal(p.scheduled, 2);
  // And they are not any of the things the other buckets claim: nothing has to finish first, and
  // nobody has to press anything.
  assert.equal(p.blocked, 0);
  assert.equal(p.needsManualStart, 0);
  assert.equal(p.notDispatchable, 0);
});

test('a batch scheduled for now is counted as starting now, prerequisites or not', async () => {
  // The mirror error, and the dangerous direction: SCHEDULED_DUE_SQL asks for neither a
  // prerequisite nor autoRunWhenReady, so these fifty really do start within the minute. Reported
  // as "needs manual start" the card would have said nothing starts, and fifty runs would begin.
  const due = new Date(Date.now() - 60_000).toISOString();
  const tasks = Array.from({ length: 50 }, (_, i) => ({
    title: `t ${i}`,
    assigneeId: 'w1',
    runAt: due,
  }));

  const p = await previewService().previewCreateMany(OWNER_ID, { tasks } as never);

  assert.equal(p.startingNow, 50);
  assert.equal(p.needsManualStart, 0);
  assert.equal(p.scheduled, 0);
});

test('a schedule does not override the standing reasons a task cannot run', async () => {
  const due = new Date(Date.now() - 60_000).toISOString();

  const p = await previewService({ pausedLists: ['paused-list'] }).previewCreateMany(OWNER_ID, {
    tasks: [
      // `dependsOnRefs` may only name an EARLIER item, which is what keeps a batch acyclic.
      { title: 'a', ref: 'a', assigneeId: 'w1' },
      { title: 'paused', assigneeId: 'w1', listId: 'paused-list', runAt: due },
      { title: 'unassigned', runAt: due },
      { title: 'waits on the batch', assigneeId: 'w1', dependsOnRefs: ['a'], runAt: due },
    ],
  } as never);

  // A paused list and a missing assignee stop a scheduled task exactly as they stop any other —
  // and an unfinished prerequisite still vetoes, so the clock is a trigger, never an override.
  assert.equal(p.startingNow, 0);
  assert.equal(p.notDispatchable, 2);
  assert.equal(p.blocked, 1);
  assert.equal(p.needsManualStart, 1);
});

test('an unscheduled batch is described exactly as it was before schedules existed', async () => {
  // The regression guard on the restructured loop: with no runAt anywhere, every item must land
  // in the same bucket it always did.
  const chain = Array.from({ length: 50 }, (_, i) => ({
    title: `step ${i}`,
    ref: `s${i}`,
    assigneeId: 'w1',
    ...(i > 0 ? { dependsOnRefs: [`s${i - 1}`] } : {}),
  }));

  const p = await previewService().previewCreateMany(OWNER_ID, { tasks: chain } as never);

  assert.equal(p.startingNow, 0);
  assert.equal(p.blocked, 49);
  assert.equal(p.needsManualStart, 1);
  assert.equal(p.scheduled, 0);
});

test('a batch-created item stores its schedule, through the same helper a single create uses', async () => {
  // `taskCreateData` is shared by create and createMany precisely so a newly added field cannot
  // reach one write path and not the other. This is the assertion that keeps that true.
  const created: any[] = [];
  const service = previewService();
  (service as any).prisma = {
    $transaction: async (fn: any) =>
      fn({
        $queryRaw: async () => [{ id: 'owner' }],
        task: { create: async ({ data }: any) => (created.push(data), { id: TASK_ID, ...data }) },
        taskDependency: { createMany: async () => ({ count: 0 }) },
      }),
    taskList: { findMany: async () => [] },
  };

  await service.createMany(OWNER_ID, {
    tasks: [
      { title: 'tonight', assigneeId: 'w1', runAt: SCHEDULED.toISOString() },
      { title: 'whenever', assigneeId: 'w1' },
    ],
  } as never);

  assert.deepEqual(created[0].runAt, SCHEDULED);
  assert.equal(created[1].runAt, undefined);
});

// ---------------------------------------------------------------------------
// The reschedule race: a user moves the appointment while a sweep is acting on it.
//
// Every automatic trigger is a scan followed by a re-read, and a person changing the schedule in
// that window is not exotic — it is the likeliest moment for them to change their mind. These
// tests make the two reads disagree directly, so nothing here depends on timing.
// ---------------------------------------------------------------------------

test('an automatic trigger is fenced on exactly what it observed', () => {
  const t = new Date('2026-09-01T09:00:00.000Z');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  // Unchanged and due: act.
  assert.equal(autoDispatchStillValid(past, past), true);
  assert.equal(autoDispatchStillValid(new Date(t), new Date(t), t.getTime() + 1), true);
  // Unchanged and unscheduled: act. `null` is an assertion, not an absence of one.
  assert.equal(autoDispatchStillValid(null, null), true);

  // Rescheduled under us.
  assert.equal(autoDispatchStillValid(future, past), false);
  // Scheduled under us, having been picked up as an unscheduled task.
  assert.equal(autoDispatchStillValid(future, null), false);
  // Cancelled under us — the user withdrew the appointment this trigger was keeping.
  assert.equal(autoDispatchStillValid(null, past), false);
  // Moved earlier: still a different appointment, so stand down and let the next sweep take it.
  assert.equal(autoDispatchStillValid(new Date(1000), new Date(2000)), false);
  // Belt and braces: never start before the time, whatever a caller claims to have observed.
  assert.equal(autoDispatchStillValid(future, future), false);
});

/**
 * A task whose two reads disagree: the candidate scan saw `scanRunAt`, and by the time the
 * dispatch re-reads the row it says `readRunAt`. That IS the race, expressed as data.
 */
function raceFixture(scanRunAt: Date | null, readRunAt: Date | null) {
  const createdSessions: unknown[] = [];
  const writes: any[] = [];
  const prisma = {
    $queryRaw: async () => [
      {
        id: TASK_ID,
        ownerId: OWNER_ID,
        runnerId: 'runner-1',
        listId: null,
        runAt: scanRunAt,
        workspaceId: 'workspace-1',
        freeBytes: null,
        minFreeDiskMb: null,
      },
    ],
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        status: TaskStatus.OPEN,
        dispatchHold: false,
        runAt: readRunAt,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
      findMany: async () => [
        {
          id: TASK_ID,
          status: 'OPEN',
          autoRunWhenReady: true,
          runAt: scanRunAt,
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
      ],
      updateMany: async (args: any) => (writes.push(args), { count: 1 }),
    },
    taskDependency: {
      findMany: async () => [{ taskId: TASK_ID, dependsOnTaskId: OTHER_TASK_ID }],
    },
    session: { findFirst: async () => null },
  };
  const sessions = {
    create: async (...args: unknown[]) => (createdSessions.push(args), { id: 'session-1' }),
    resume: async () => ({ turnId: 't', seq: 1 }),
  };
  const service = serviceWith(prisma, sessions, { publishForUser: () => undefined });
  (service as any).materialisationBudget = async () => ({ runner: new Map(), list: new Map() });
  (service as any).dependencyStatesFor = async () => new Map([[TASK_ID, 'READY']]);
  return { service, createdSessions, writes };
}

test('the scheduled sweep stands down when the task was moved to a later time mid-sweep', async () => {
  const due = new Date(Date.now() - 60_000);
  const movedToNextWeek = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const f = raceFixture(due, movedToNextWeek);

  await (f.service as any).dispatchDueScheduledTasks();

  // Nothing started: the reason this pass had for starting the task has been replaced.
  assert.equal(f.createdSessions.length, 0);
  // And nothing consumed. Without the fence this is the damaging half — the sweep would have
  // cleared the appointment the user had just made, so the task would neither run now nor later.
  assert.equal(f.writes.length, 0);
});

test('the scheduled sweep still runs a task whose schedule did not move', async () => {
  const due = new Date(Date.now() - 60_000);
  const f = raceFixture(due, due);

  await (f.service as any).dispatchDueScheduledTasks();

  assert.equal(f.createdSessions.length, 1);
  // Kept, exactly once, and against the instant both reads agreed on.
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].where.runAt, due);
  assert.equal(f.writes[0].data.runAt, null);
});

test('a cancelled schedule stops the sweep that was already acting on it', async () => {
  const due = new Date(Date.now() - 60_000);
  const f = raceFixture(due, null);

  await (f.service as any).dispatchDueScheduledTasks();

  // The user withdrew the appointment. A sweep that started the task anyway would be running work
  // its owner had just called off.
  assert.equal(f.createdSessions.length, 0);
  assert.equal(f.writes.length, 0);
});

test('a prerequisite finishing does not start a task scheduled in the same window', async () => {
  // The dependent was unscheduled when triggerDependents selected it, and is scheduled for next
  // week by the time the dispatch reads it. `null` as the observed value is what catches this.
  const f = raceFixture(null, new Date(Date.now() + 7 * 24 * 60 * 60_000));

  await (f.service as any).triggerDependents(OWNER_ID, OTHER_TASK_ID);

  assert.equal(f.createdSessions.length, 0);
  assert.equal(f.writes.length, 0);
});

test('the reconcile sweep does not start a task scheduled in the same window', async () => {
  const f = raceFixture(null, new Date(Date.now() + 7 * 24 * 60 * 60_000));
  (f.service as any).quotaGate = async () => ({ blocked: new Map(), blind: new Set() });
  (f.service as any).autoRunHoldOff = async () => new Set();

  await (f.service as any).reconcileReadyTasks();

  assert.equal(f.createdSessions.length, 0);
  assert.equal(f.writes.length, 0);
});

test('an explicit Run Now carries no fence — it is the person, not the clock', async () => {
  // Same disagreement between the two reads, but this call came from a button. It must start the
  // task and spend the schedule it pre-empted, which is exactly what the fence must not prevent.
  const f = raceFixture(null, new Date(Date.now() + 7 * 24 * 60 * 60_000));

  const result = await f.service.execute(OWNER_ID, TASK_ID);

  assert.equal(result.ok, true);
  assert.equal(f.createdSessions.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.runAt, null);
});

test('a scheduled item that could not run anyway is not called scheduled', async () => {
  // `scheduled` is the strongest claim the card makes — nobody has to do anything, nothing has to
  // finish, the run arrives unattended. An item that is ALSO unassigned, on a runnerless
  // workspace, in a paused list, or waiting on a prerequisite does not meet that description, and
  // filing it there promises a run that never comes. Classify by what is actually in the way.
  const later = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  const p = await previewService({
    runners: { w1: 'runner-1', bare: null },
    pausedLists: ['paused-list'],
  }).previewCreateMany(OWNER_ID, {
    tasks: [
      { title: 'root', ref: 'root', assigneeId: 'w1' },
      // Scheduled, but nothing will be there to run it.
      { title: 'no assignee', runAt: later },
      { title: 'workspace has no runner', assigneeId: 'bare', runAt: later },
      { title: 'list is paused', assigneeId: 'w1', listId: 'paused-list', runAt: later },
      // Scheduled, but a prerequisite in this same batch has to finish first.
      { title: 'waits on the batch', assigneeId: 'w1', dependsOnRefs: ['root'], runAt: later },
      // The only one where the clock really is all that is left.
      { title: 'genuinely just waiting for the time', assigneeId: 'w1', runAt: later },
    ],
  } as never);

  assert.equal(p.scheduled, 1, 'only the item with nothing else in its way');
  assert.equal(p.startingNow, 0, 'and none of them starts now');
  assert.equal(p.notDispatchable, 3, 'no assignee, no runner, paused list');
  assert.equal(p.blocked, 1, 'the one waiting on its prerequisite');
  assert.equal(p.needsManualStart, 1, 'the unscheduled root');
});

test('a future schedule on a runnerless workspace stays notDispatchable, not scheduled', async () => {
  // The narrowest form of the same rule, kept separate because it is the one a reader is most
  // likely to reason about wrongly: the schedule is real and the time will come, but nothing will
  // pick the task up when it does — that is a person's job, which is what notDispatchable means.
  const later = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  const p = await previewService({ runners: { bare: null } }).previewCreateMany(OWNER_ID, {
    tasks: [{ title: 'tonight, in theory', assigneeId: 'bare', runAt: later }],
  } as never);

  assert.equal(p.scheduled, 0);
  assert.equal(p.startingNow, 0);
  assert.equal(p.notDispatchable, 1);
});

test('a due schedule is classified by the same conditions in the same order', async () => {
  // The due half of the rule: `blocked` before `notDispatchable` before the clock, so the two
  // halves of the branch cannot drift into disagreeing about what stops a task.
  const due = new Date(Date.now() - 60_000).toISOString();

  const p = await previewService({
    runners: { w1: 'runner-1', bare: null },
  }).previewCreateMany(OWNER_ID, {
    tasks: [
      { title: 'root', ref: 'root', assigneeId: 'w1' },
      { title: 'no runner', assigneeId: 'bare', runAt: due },
      { title: 'waits on the batch', assigneeId: 'w1', dependsOnRefs: ['root'], runAt: due },
      { title: 'ready and due', assigneeId: 'w1', runAt: due },
    ],
  } as never);

  assert.equal(p.startingNow, 1);
  assert.equal(p.notDispatchable, 1);
  assert.equal(p.blocked, 1);
  assert.equal(p.scheduled, 0);
});
