import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import {
  legacySwitchPauseWrite,
  ownerPauseWrite,
  projectPauseSessionRefusal,
  projectPauseState,
  resumeWrite,
} from '../projects/project-pause';
import { automaticConfirmationRefusal, type AutomaticConfirmationFacts } from '../projects/project-promotion';
import { projectMoves, projectMovesForTaskSql, projectMovesSql } from './project-pause-dispatch';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

/**
 * A project moves by itself only while it is started and not paused (`project-pause-dispatch.ts`).
 *
 * The automatic scans are held to it in SQL and proved against PostgreSQL, door by door and each
 * with a twin that moves (`project-pause-dispatch.pg.spec.ts`). This is the run door itself: every
 * automatic scan funnels through it, and it is the answer for a scan that read the project before
 * the owner paused it — which PostgreSQL cannot be made to interleave on demand — as well as the
 * runner's `task_start`, and the owner's Run, which is not held.
 */

const uuid = (tag: string): string => `00000000-0000-4000-8000-${tag.padStart(12, '0')}`;
const OWNER = 'owner-1';
const TASK = uuid('1');
const PROJECT = uuid('2');
const STARTED_AT = new Date('2026-09-29T08:00:00.000Z');
const PAUSED_AT = new Date('2026-09-29T09:00:00.000Z');

interface ProjectRow {
  id: string;
  ownerId: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  startedAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT,
    ownerId: OWNER,
    title: 'FineWeb corpus',
    status: 'OPEN',
    startedAt: STARTED_AT,
    pausedAt: null,
    pausedReason: null,
    ...overrides,
  };
}

/** Every column a `where` names has to match, as it would in PostgreSQL — `{ not: null }` included. */
function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && 'not' in value) {
      return (value as { not: unknown }).not === null ? actual != null : actual !== (value as { not: unknown }).not;
    }
    return value === null ? actual == null : actual === value;
  });
}

function pick(row: Record<string, unknown>, select?: Record<string, unknown>) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

/** A service whose only real behaviour is the run door; the dispatch itself is stubbed. */
function serviceFor(row: ProjectRow | null) {
  const started: string[] = [];
  const task: Record<string, unknown> = {
    id: TASK,
    title: 'shard 000',
    description: null,
    projectId: row ? PROJECT : null,
    provider: null,
    model: null,
    status: 'OPEN',
    listId: null,
    isForeman: false,
    verifiesTaskId: null,
    dispatchHold: false,
    runAt: null,
    supersededByTaskId: null,
    terminalReason: null,
    completionPolicy: 'MANUAL',
    completionCriterion: 'EVIDENCE_JUDGMENT',
    children: [],
    verifies: null,
    list: null,
    assignee: { id: 'workspace-1', runnerId: 'runner-1' },
  };
  const prisma = {
    ...fakeReceiptStore(),
    task: {
      findFirst: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) =>
        where.id === TASK ? pick(task, select) : null,
      findMany: async () => [],
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
    conversationTurn: { findUnique: async () => null },
    session: { findUnique: async () => null, findMany: async () => [] },
    project: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
        row && matches(row, where) ? pick(row as unknown as Record<string, unknown>, select) : null,
    },
    // The start check `task_start` also asks (`projectAwaitingStart`): one criterion, so an unstarted
    // project is waiting on its owner's start card.
    projectAcceptanceCriterionDefinition: { findFirst: async () => ({ id: uuid('c') }) },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  const stub = service as unknown as Record<string, unknown>;
  stub.planWorkspaceRun = async (_o: string, t: { id: string }) =>
    ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${t.id}` });
  stub.applyWorkspaceRun = async (...args: unknown[]) => {
    const taskId = (args[1] as { id: string }).id;
    started.push(taskId);
    return `session-${taskId}`;
  };
  stub.buildExecutePrompt = () => 'prompt';
  return { service, started };
}

/** An automatic door, as the sweeps and the completion edge call it: the moment it read, named. */
const automatic = (service: TasksService) =>
  service.execute(OWNER, TASK, { observedEpoch: 0n }, `dep:${TASK}:0`);
/** `task_start`, as `RunnerTasksController.executeTask` calls it. */
const taskStart = (service: TasksService, trigger: string) =>
  service.execute(OWNER, TASK, undefined, trigger, 'session-1', true);
/** The owner's Run, as `TasksController.execute` calls it. */
const ownerRun = (service: TasksService, trigger: string) => service.execute(OWNER, TASK, undefined, trigger);

test('an automatic door stands down for a task whose project is paused, or was never started', async () => {
  for (const [row, skipped] of [
    [project({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' }), 'project-paused'],
    [project({ pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF' }), 'project-paused'],
    [project({ startedAt: null }), 'project-not-started'],
  ] as const) {
    const { service, started } = serviceFor(row);
    assert.deepEqual(await automatic(service), { ok: false, skipped }, `${skipped}: a quiet stand-down`);
    assert.deepEqual(started, [], `${skipped}: and no Session is started`);
  }
});

// NEGATIVE CONTROL: the same door starts it in a project that moves, and a task in no project is
// not asked about projects at all.
test('the same automatic door starts it in a project that moves, or in none', async () => {
  for (const [name, row] of [['a started, unpaused project', project()], ['no project', null]] as const) {
    const { service, started } = serviceFor(row);
    const answer = await automatic(service);
    assert.equal(answer.ok, true, `${name}: ${JSON.stringify(answer)}`);
    assert.deepEqual(started, [TASK], `${name}: the automatic door must start it`);
  }
});

test('the stand-down is released, not frozen: resumed, the same moment starts the task', async () => {
  const row = project({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' });
  const { service, started } = serviceFor(row);
  assert.deepEqual(await automatic(service), { ok: false, skipped: 'project-paused' });
  row.pausedAt = null;
  row.pausedReason = null;
  assert.equal((await automatic(service)).ok, true);
  assert.deepEqual(started, [TASK]);
});

test('task_start is refused 409 PROJECT_PAUSED with the reason, and the owner\'s Run is not held', async () => {
  const row = project({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' });
  const { service, started } = serviceFor(row);
  await assert.rejects(() => taskStart(service, 'trigger-1'), (error: unknown) => {
    assert.ok(error instanceof ConflictException, 'a readable 409, not a dispatched Session');
    const body = error.getResponse() as { code: string; message: string };
    assert.equal(body.code, 'PROJECT_PAUSED');
    assert.match(body.message, /is paused/);
    assert.match(body.message, /Pause project/);
    assert.match(body.message, /Resume project/);
    assert.match(body.message, new RegExp(uuidToBase62(TASK)));
    assert.match(body.message, new RegExp(uuidToBase62(PROJECT)));
    assert.ok(body.message.includes(PAUSED_AT.toISOString()));
    return true;
  });
  assert.deepEqual(started, []);
  await ownerRun(service, 'press-1');
  assert.deepEqual(started, [TASK], 'the owner\'s Run on a paused project must start it');
});

test('the older switch\'s pause is named as what it is', async () => {
  const { service } = serviceFor(project({ pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF' }));
  await assert.rejects(() => taskStart(service, 'trigger-1'), (error: unknown) => {
    const body = (error as ConflictException).getResponse() as { code: string; message: string };
    assert.equal(body.code, 'PROJECT_PAUSED');
    assert.match(body.message, /switched Automatic off/);
    return true;
  });
});

test('task_start on a started, unpaused project starts it: the refusal is about the pause alone', async () => {
  const { service, started } = serviceFor(project());
  await taskStart(service, 'trigger-1');
  assert.deepEqual(started, [TASK]);
});

// ── the pause rules, as the doors apply them ─────────────────────────────────────────────────────

const row = (overrides: Partial<{ startedAt: Date | null; pausedAt: Date | null; pausedReason: string | null }> = {}) => ({
  startedAt: STARTED_AT, pausedAt: null, pausedReason: null, ...overrides,
});
const NOW = new Date('2026-09-29T10:00:00.000Z');

test('the older switch: off pauses a started project, on lifts only the pause its off wrote', () => {
  assert.deepEqual(legacySwitchPauseWrite(false, row(), NOW),
    { pausedAt: NOW, pausedReason: 'LEGACY_AUTOMATIC_OFF' });
  assert.equal(legacySwitchPauseWrite(false, row({ startedAt: null }), NOW), null,
    'a project nobody started has nothing to pause');
  assert.equal(legacySwitchPauseWrite(false, row({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' }), NOW), null,
    'an owner\'s pause is not rewritten');
  assert.equal(legacySwitchPauseWrite(false, row({ pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF' }), NOW),
    null, 'already paused, it keeps the instant it stopped');
  assert.deepEqual(legacySwitchPauseWrite(true, row({ pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF' }), NOW),
    { pausedAt: null, pausedReason: null });
  assert.equal(legacySwitchPauseWrite(true, row({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' }), NOW), null,
    'the older switch lifted the owner\'s own pause');
  assert.equal(legacySwitchPauseWrite(true, row(), NOW), null);
  assert.equal(legacySwitchPauseWrite(undefined, row(), NOW), null, 'a write without the switch touched the pause');
});

test('the owner\'s pause and resume', () => {
  assert.equal(ownerPauseWrite(row({ startedAt: null }), NOW), 'NOT_STARTED');
  assert.deepEqual(ownerPauseWrite(row(), NOW), { pausedAt: NOW, pausedReason: 'OWNER' });
  assert.equal(ownerPauseWrite(row({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' }), NOW), null);
  assert.deepEqual(ownerPauseWrite(row({ pausedAt: PAUSED_AT, pausedReason: 'LEGACY_AUTOMATIC_OFF' }), NOW),
    { pausedAt: PAUSED_AT, pausedReason: 'OWNER' }, 'the older switch\'s pause becomes the owner\'s, same instant');
  assert.equal(resumeWrite(row()), null);
  for (const reason of ['OWNER', 'LEGACY_AUTOMATIC_OFF']) {
    assert.deepEqual(resumeWrite(row({ pausedAt: PAUSED_AT, pausedReason: reason })), { pausedAt: null, pausedReason: null });
  }
  assert.deepEqual(projectPauseState(PROJECT, row({ pausedAt: PAUSED_AT, pausedReason: 'OWNER' })), {
    projectId: PROJECT, startedAt: STARTED_AT.toISOString(), pausedAt: PAUSED_AT.toISOString(), pausedReason: 'OWNER',
  });
});

test('only a request with no acting session may pause or resume', () => {
  assert.equal(projectPauseSessionRefusal(undefined), null);
  assert.equal(projectPauseSessionRefusal('  '), null);
  const refusal = projectPauseSessionRefusal('session-9');
  assert.equal(refusal?.code, 'PROJECT_PAUSE_OWNER_ONLY');
  assert.match(refusal?.message ?? '', /session-9/);
});

test('what moves, as the SQL and the reads both say it', () => {
  assert.equal(projectMovesSql('p'), 'p.started_at IS NOT NULL AND p.paused_at IS NULL');
  assert.match(projectMovesForTaskSql('t'), /t\.project_id IS NULL OR EXISTS/);
  assert.equal(projectMoves({ startedAt: STARTED_AT, pausedAt: null }), true);
  assert.equal(projectMoves({ startedAt: STARTED_AT, pausedAt: PAUSED_AT }), false);
  assert.equal(projectMoves({ startedAt: null, pausedAt: null }), false);
  assert.equal(projectMoves(null), false, 'a project that could not be read does not move');
});

test('a paused project is not merged into main by Automatic', () => {
  const clean: AutomaticConfirmationFacts = {
    sourceKind: 'PROJECT_BRANCH',
    line: 'PROJECT_BRANCH',
    coordinatorEnabled: true,
    projectPaused: false,
    conflicts: [],
    checks: [],
    upstreamShaChecked: 'f'.repeat(40),
    mergeTreeSha: '3'.repeat(40),
    openIntegrationItems: 0,
    runnerHandsBackMovedUpstream: true,
  };
  assert.equal(automaticConfirmationRefusal(clean), null);
  assert.match(automaticConfirmationRefusal({ ...clean, projectPaused: true }) ?? '', /paused/);
});
