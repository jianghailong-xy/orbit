import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sessionCarriesTaskSql, taskCarriedSql } from '../sessions/task-work-carrier';
import { readProjectReadyToRun } from './project-ready-to-run';
import { ProjectsService } from './projects.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-000000000002';
const RUNNING_SESSION_ID = '00000000-0000-7000-8000-000000000051';
const QUEUED_SESSION_ID = '00000000-0000-7000-8000-000000000052';

function harness(rows: unknown[]) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (statement: Prisma.Sql) => {
      statements.push(statement);
      return rows;
    },
  } as unknown as PrismaService;
  return { prisma, statements };
}

test('the ready queue keeps zero-impact leaves and carries the exact manual-run gates', async () => {
  const { prisma, statements } = harness([
    {
      readyCount: 4,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000011',
      title: 'Root task',
      status: 'OPEN',
      runState: 'READY',
      activeSince: null,
      sessionId: null,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: 9,
    },
    {
      readyCount: 4,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000012',
      title: 'Runnable leaf',
      status: 'OPEN',
      runState: 'READY',
      activeSince: null,
      sessionId: null,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: 0,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.readyCount, 4, 'the total is not truncated to the two returned rows');
  assert.deepEqual(
    result.items.map(({ title, runState, downstreamBlocked }) => [
      title,
      runState,
      downstreamBlocked,
    ]),
    [
      ['Root task', 'READY', 9],
      ['Runnable leaf', 'READY', 0],
    ],
  );
  assert.equal(result.impactTruncated, null);

  assert.equal(statements.length, 1);
  const [{ text, values }] = statements;
  assert.ok(values.includes(OWNER_ID));
  assert.ok(values.includes(PROJECT_ID));
  assert.ok(values.includes(5));
  assert.match(text, /t\.status <> 'DONE'::task_status/);
  assert.match(text, /t\.dispatch_hold = false/);
  assert.match(text, /a\.runner_id IS NOT NULL/);
  assert.match(text, /a\.enabled = true/);
  // "No work session carries it", in the one spelling every reader shares — the same one the
  // active rows below are selected by, so no task can be both.
  assert.ok(text.includes(`NOT ${taskCarriedSql('t', 'runnable_carrier')}`));
  assert.match(text, /NOT EXISTS \(\s*SELECT 1 FROM task_dependency dep/);
  assert.match(text, /t\.completion_policy = 'MANUAL'::task_completion_policy/);
  assert.match(text, /aggregate_child\.parent_task_id = t\.id/);
  assert.match(text, /LEFT JOIN reach ON reach\.root = candidate\.id/);
  assert.match(text, /count\(DISTINCT reach\.node\)::int/);
  assert.match(text, /WHEN candidate\."runState" = 'READY' THEN 1/);
  assert.match(text, /"downstreamBlocked" DESC/);
});

test('queued and running work stays ahead of the remaining ready queue', async () => {
  const { prisma, statements } = harness([
    {
      readyCount: 3,
      queuedCount: 1,
      runningCount: 1,
      pausedCount: 0,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000031',
      title: 'Already running',
      status: 'OPEN',
      runState: 'RUNNING',
      activeSince: new Date('2026-08-25T00:00:00Z'),
      sessionId: RUNNING_SESSION_ID,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: 12,
    },
    {
      readyCount: 3,
      queuedCount: 1,
      runningCount: 1,
      pausedCount: 0,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000032',
      title: 'Waiting for a runner',
      status: 'OPEN',
      runState: 'QUEUED',
      activeSince: new Date('2026-08-24T23:59:00Z'),
      sessionId: QUEUED_SESSION_ID,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: 8,
    },
    {
      readyCount: 3,
      queuedCount: 1,
      runningCount: 1,
      pausedCount: 0,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000033',
      title: 'Still ready',
      status: 'OPEN',
      runState: 'READY',
      activeSince: null,
      sessionId: null,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: 20,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.runningCount, 1);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.readyCount, 3);
  assert.deepEqual(
    result.items.map(({ title, runState, sessionId }) => [title, runState, sessionId]),
    [
      ['Already running', 'RUNNING', RUNNING_SESSION_ID],
      ['Waiting for a runner', 'QUEUED', QUEUED_SESSION_ID],
      ['Still ready', 'READY', null],
    ],
  );

  const [{ text }] = statements;
  assert.match(text, /SELECT DISTINCT ON \(t\.id\)/);
  assert.ok(text.includes(sessionCarriesTaskSql('s')), 'active rows are the carried ones');
  assert.match(text, /s\.id AS "sessionId"/);
  // PENDING is still exactly QUEUED; everything else a session carries is RUNNING.
  assert.match(text, /WHEN 'PENDING'::run_status THEN 'QUEUED'\s+ELSE 'RUNNING'/);
  assert.match(text, /FROM candidates candidate/);
  assert.match(text, /candidate\."activeSince" DESC NULLS LAST/);
});

test('a running row says why it is running, and when the jobs it waits on went quiet', async () => {
  const base = {
    readyCount: 0,
    queuedCount: 0,
    runningCount: 3,
    pausedCount: 0,
    impactTruncated: false,
    status: 'OPEN',
    runState: 'RUNNING',
    activeSince: new Date('2026-10-02T00:00:00Z'),
    pausedListId: null,
    pausedListTitle: null,
    pausedListReadyCount: null,
    pausedListAutoRunReadyCount: null,
    downstreamBlocked: 0,
  };
  const now = Date.now();
  const { prisma, statements } = harness([
    {
      ...base,
      taskId: '00000000-0000-7000-8000-000000000061',
      title: 'Waiting on a moving job',
      sessionId: '00000000-0000-7000-8000-000000000071',
      runReason: 'BACKGROUND_JOB',
      runningBgJobs: ['bgj_moving'],
      runningBgJobActivity: { bgj_moving: now - 60_000 },
    },
    {
      ...base,
      taskId: '00000000-0000-7000-8000-000000000062',
      title: 'Waiting on a silent job',
      sessionId: '00000000-0000-7000-8000-000000000072',
      runReason: 'BACKGROUND_JOB',
      runningBgJobs: ['bgj_silent'],
      runningBgJobActivity: { bgj_silent: now - 11 * 60_000 },
    },
    {
      ...base,
      taskId: '00000000-0000-7000-8000-000000000063',
      title: 'Waiting on a watch',
      sessionId: '00000000-0000-7000-8000-000000000073',
      runReason: 'WAITING',
      runningBgJobs: [],
      runningBgJobActivity: {},
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.deepEqual(
    result.items.map(({ title, runState, runReason, runStalled }) =>
      [title, runState, runReason, runStalled]),
    [
      ['Waiting on a moving job', 'RUNNING', 'BACKGROUND_JOB', false],
      // Still RUNNING — a quiet job is still a process that will wake its session — but flagged.
      ['Waiting on a silent job', 'RUNNING', 'BACKGROUND_JOB', true],
      ['Waiting on a watch', 'RUNNING', 'WAITING', false],
    ],
  );
  // Read off the session the active row names, after the ranking, by the shared reason.
  const [{ text }] = statements;
  assert.match(text, /LEFT JOIN session run_session ON run_session\.id = ranked\."sessionId"/);
});

test('otherwise-ready tasks in a paused list remain visible with the list resume scope', async () => {
  const LIST_ID = '00000000-0000-7000-8000-000000000041';
  const { prisma, statements } = harness([
    {
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 6112,
      impactTruncated: true,
      taskId: '00000000-0000-7000-8000-000000000042',
      title: 'Download one parquet file',
      status: 'OPEN',
      runState: 'PAUSED',
      activeSince: null,
      sessionId: null,
      pausedListId: LIST_ID,
      pausedListTitle: 'FineWeb downloads',
      pausedListReadyCount: 6112,
      pausedListAutoRunReadyCount: 0,
      downstreamBlocked: null,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.readyCount, 0);
  assert.equal(result.pausedCount, 6112);
  assert.deepEqual(result.items, [
    {
      taskId: '00000000-0000-7000-8000-000000000042',
      title: 'Download one parquet file',
      status: 'OPEN',
      runState: 'PAUSED',
      sessionId: null,
      runReason: null,
      runStalled: false,
      pausedList: {
        id: LIST_ID,
        title: 'FineWeb downloads',
        readyCount: 6112,
        autoRunReadyCount: 0,
      },
      downstreamBlocked: null,
    },
  ]);

  const [{ text }] = statements;
  assert.match(text, /JOIN task_list l/);
  assert.match(text, /l\.paused = true/);
  assert.match(text, /t\.dispatch_hold = true/);
  assert.match(text, /'PAUSED'::text AS "runState"/);
  assert.match(text, /count\(\*\) OVER \(PARTITION BY l\.id\)/);
  assert.match(text, /count\(\*\) FILTER \(WHERE t\.auto_run_when_ready\)/);
});

test('an empty queue preserves its count row and returns no fake task', async () => {
  const { prisma } = harness([
    {
      readyCount: 0,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      impactTruncated: false,
      taskId: null,
      title: null,
      status: null,
      runState: null,
      activeSince: null,
      sessionId: null,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: null,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.deepEqual(result, {
    readyCount: 0,
    manualReady: null,
    queuedCount: 0,
    runningCount: 0,
    pausedCount: 0,
    // Absent from this fixture's row, because a double that predates the column answers what it
    // always answered: no task is waiting for a prerequisite to land.
    waitingForLanding: 0,
    items: [],
    impactTruncated: null,
  });
});

test('the manual-start summary names work outside the limited queue items', async () => {
  const { prisma } = harness([{
    readyCount: 8, manualReadyCount: 7, manualReadyTaskId: PROJECT_ID, manualReadyTitle: 'Manual task',
    taskId: null, title: null, status: null, runState: null,
  }]);
  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 1);
  assert.deepEqual(result.manualReady, { count: 7, taskId: PROJECT_ID, title: 'Manual task' });
  assert.deepEqual(result.items, []);
});

test('a truncated impact walk leaves ready rows runnable and reports why ranking is absent', async () => {
  const { prisma } = harness([
    {
      readyCount: 1,
      queuedCount: 0,
      runningCount: 0,
      pausedCount: 0,
      impactTruncated: true,
      taskId: '00000000-0000-7000-8000-000000000013',
      title: 'Still runnable',
      status: 'OPEN',
      runState: 'READY',
      activeSince: null,
      sessionId: null,
      pausedListId: null,
      pausedListTitle: null,
      pausedListReadyCount: null,
      pausedListAutoRunReadyCount: null,
      downstreamBlocked: null,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.items[0].title, 'Still runnable');
  assert.equal(result.items[0].downstreamBlocked, null);
  assert.deepEqual(result.impactTruncated, {
    reason: 'TOO_MANY_UNFINISHED_TASKS',
    maxTasks: 2000,
  });
});

test('the HTTP service keeps PostgreSQL JIT disabled only for the large ready query transaction', async () => {
  const settings: string[] = [];
  const statements: Prisma.Sql[] = [];
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      settings.push(sql);
      return 0;
    },
    $queryRaw: async (statement: Prisma.Sql) => {
      statements.push(statement);
      return [
        {
          readyCount: 0,
          queuedCount: 0,
          runningCount: 0,
          pausedCount: 0,
          impactTruncated: false,
          taskId: null,
          title: null,
          status: null,
          runState: null,
          activeSince: null,
          sessionId: null,
          pausedListId: null,
          pausedListTitle: null,
          pausedListReadyCount: null,
          pausedListAutoRunReadyCount: null,
          downstreamBlocked: null,
        },
      ];
    },
  };
  const prisma = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID }),
    },
    $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
  };
  const service = new ProjectsService(prisma as never, {} as never);

  const result = await service.panoramaReady(OWNER_ID, PROJECT_ID, { limit: '5' });

  assert.deepEqual(settings, ['SET LOCAL jit = off']);
  assert.equal(statements.length, 1);
  assert.deepEqual(result.items, []);
});
