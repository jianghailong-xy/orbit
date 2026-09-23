import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, SessionRunSource } from '@prisma/client';
import { RunEventType, type TaskStartCriterion } from '@orbit/shared';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TASK_RUN_TRIGGER, taskRunResumeTurnId } from './task-run-identity';
import { buildTaskExecutionPrompt } from './tasks.service';

/**
 * The record half of "a task's brief is not the owner's message".
 *
 * A run's opening turn is the brief `buildTaskExecutionPrompt` writes for the agent, and every client
 * drew it as a message the owner had typed. Ingest records the task it was built from beside the
 * echo as `taskStart`, which is what the clients draw as a card. The briefs here are the builder's
 * real output, and every "no card" sits next to a twin that must produce one, so none of them can
 * pass merely because no card is ever written.
 */

const SESSION = '01a0cca7-0000-7000-8000-000000000001';
const TASK = '01a0cca7-8609-70ed-a0e2-d4b55b832b60';
const PROJECT = '01a0cca0-aeaa-7618-bd5a-caccc089108c';
const OPENING = SessionsService.initialTurnClientId(SESSION);

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  completionCriterion: TaskStartCriterion;
  isForeman: boolean;
  verifiesTaskId: string | null;
  list: { instructions: string | null } | null;
  project: { id: string; title: string } | null;
};

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    title: 'runner + web：配额按账户归属',
    description: '让每个账户的 plan usage 只进它自己那一行。\n\n背景：`codexSessionOnDefaultAccount` 今天回答的是二值问题。',
    acceptanceCriteria: '  每个账户的 plan usage 只进它自己那一行。  ',
    acceptanceCommand: 'go test ./... -run TestCodexAccountQuota',
    acceptanceExpectedExitCode: 0,
    completionCriterion: 'EXECUTABLE',
    isForeman: false,
    verifiesTaskId: null,
    list: null,
    project: { id: PROJECT, title: 'Codex 多账户：一台机器上登录多个 Codex' },
    ...overrides,
  };
}

/**
 * The runner's event ingress, given one `user` echo for a turn stored under `clientTurnId` with
 * `content`, in a Session executing `session.taskId`. Returns the payload as stored (having checked
 * the live broadcast carried the same one) and how many times the task was read.
 */
async function ingest(opts: {
  clientTurnId: string;
  content: string | null;
  payload: Record<string, unknown>;
  task?: TaskRow | null;
  session?: { taskId: string | null; runSource: SessionRunSource };
}): Promise<{ stored: Record<string, unknown>; taskReads: number }> {
  const stored: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  let taskReads = 0;
  const session = opts.session ?? { taskId: TASK, runSource: SessionRunSource.MANUAL };
  const tx = {
    $queryRaw: async () => [{ id: SESSION, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    runEvent: {
      createMany: async (args: { data: Array<{ payload: Record<string, unknown> }> }) => {
        stored.push(...args.data.map((row) => row.payload));
        return { count: args.data.length };
      },
    },
    toolCall: {
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    conversationTurn: {
      findMany: async () => [{ id: 'turn-1', content: opts.content, clientTurnId: opts.clientTurnId }],
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: RunStatus.RUNNING,
        runtimeSessionId: 'runtime-1',
        cancelRequestedAt: null,
        runningBgShells: [],
        runningBgJobs: [],
        runningSubagents: [],
        coordinatorContextEpoch: 0,
        ...session,
      }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    task: {
      findUnique: async (args: { where: { id: string } }) => {
        taskReads += 1;
        assert.equal(args.where.id, session.taskId, 'the card must be read off the task this Session executes');
        return opts.task === undefined ? taskRow() : opts.task;
      },
    },
  };
  const prisma = { $transaction: async (work: (client: typeof tx) => unknown) => work(tx) };
  const realtime = {
    publish: (_sessionId: string, event: { payload: Record<string, unknown> }) => {
      published.push(event.payload);
    },
  };
  const controller = new RunnerApiController(
    prisma as never,
    {} as never,
    realtime as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  await controller.events({ id: 'runner-1' }, SESSION, {
    events: [{ seq: 1, type: RunEventType.USER, ts: '2026-09-23T09:48:42.000Z', turnId: 'turn-1', payload: opts.payload }],
  });

  assert.equal(stored.length, 1, 'the echo was not stored');
  assert.deepEqual(published, stored, 'live subscribers must be sent the payload that was stored');
  return { stored: stored[0]!, taskReads };
}

test('a new run: its seeded first turn is recorded with the task the brief was built from', async () => {
  const brief = buildTaskExecutionPrompt(taskRow());

  const { stored } = await ingest({ clientTurnId: OPENING, content: brief, payload: { text: brief } });

  assert.equal(stored.text, brief, 'the echo is what the engine read, so it is kept as it was');
  assert.deepEqual(stored.taskStart, {
    taskId: TASK,
    title: 'runner + web：配额按账户归属',
    description: '让每个账户的 plan usage 只进它自己那一行。\n\n背景：`codexSessionOnDefaultAccount` 今天回答的是二值问题。',
    // Trimmed, exactly as the brief carries it.
    acceptanceCriteria: '每个账户的 plan usage 只进它自己那一行。',
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'go test ./... -run TestCodexAccountQuota',
    acceptanceExpectedExitCode: 0,
    listInstructions: null,
    project: { id: PROJECT, title: 'Codex 多账户：一台机器上登录多个 Codex' },
    auto: false,
  });
});

test('who started it: the door a created Session records, or the token a resume was delivered under', async () => {
  const brief = buildTaskExecutionPrompt(taskRow());

  const swept = await ingest({
    clientTurnId: OPENING,
    content: brief,
    payload: { text: brief },
    session: { taskId: TASK, runSource: SessionRunSource.TASK_LIST_AUTO },
  });
  assert.equal((swept.stored.taskStart as { auto: boolean }).auto, true, 'a sweep-created run is automatic');

  // A paused Session resumed by the dependency sweep. It was CREATED by a press, which is exactly
  // why the resume's own token has to answer for the brief it delivers.
  const resumedBySweep = await ingest({
    clientTurnId: taskRunResumeTurnId(TASK_RUN_TRIGGER.dependency(TASK, 7), SESSION),
    content: brief,
    payload: { text: brief },
    session: { taskId: TASK, runSource: SessionRunSource.MANUAL },
  });
  assert.equal((resumedBySweep.stored.taskStart as { auto: boolean }).auto, true);

  for (const token of [TASK_RUN_TRIGGER.scheduled(TASK, 3), TASK_RUN_TRIGGER.firstRun(TASK, 1)]) {
    const resumed = await ingest({
      clientTurnId: taskRunResumeTurnId(token, SESSION),
      content: brief,
      payload: { text: brief },
    });
    assert.equal((resumed.stored.taskStart as { auto: boolean }).auto, true, token);
  }

  // A press — one Run Now, or one row of a bulk Run — resuming a Session a sweep created.
  for (const token of ['6f1c8a52-5d0e-4a8e-9c1b-0b7e6d2f4a10', TASK_RUN_TRIGGER.batch('press-1', TASK)]) {
    const pressed = await ingest({
      clientTurnId: taskRunResumeTurnId(token, SESSION),
      content: brief,
      payload: { text: brief },
      session: { taskId: TASK, runSource: SessionRunSource.TASK_LIST_AUTO },
    });
    assert.equal((pressed.stored.taskStart as { auto: boolean }).auto, false, token);
  }
});

test('a task edited after its brief was written gets no card, and the same echo against the unedited task does', async () => {
  const brief = buildTaskExecutionPrompt(taskRow());

  const edited = await ingest({
    clientTurnId: OPENING,
    content: brief,
    payload: { text: brief },
    task: taskRow({ description: '改过的描述' }),
  });
  assert.equal('taskStart' in edited.stored, false, 'a card describing a brief the agent never read was stored');

  const unedited = await ingest({ clientTurnId: OPENING, content: brief, payload: { text: brief } });
  assert.equal((unedited.stored.taskStart as { title: string }).title, 'runner + web：配额按账户归属');
});

test('only a run\'s opening or resume turn is read: an ordinary message costs no task read', async () => {
  const brief = buildTaskExecutionPrompt(taskRow());

  // The same words typed as an ordinary message into the run: not the brief's delivery.
  const typed = await ingest({ clientTurnId: 'c3a8f1d2-client-turn', content: brief, payload: { text: brief } });
  assert.equal('taskStart' in typed.stored, false);
  assert.equal(typed.taskReads, 0);

  // Another session's resume key, and the opening turn of a Session that executes no task.
  const foreign = await ingest({
    clientTurnId: taskRunResumeTurnId('6f1c8a52-5d0e-4a8e-9c1b-0b7e6d2f4a10', 'another-session'),
    content: brief,
    payload: { text: brief },
  });
  assert.equal('taskStart' in foreign.stored, false);
  assert.equal(foreign.taskReads, 0);

  const noTask = await ingest({
    clientTurnId: OPENING,
    content: brief,
    payload: { text: brief },
    session: { taskId: null, runSource: SessionRunSource.MANUAL },
  });
  assert.equal('taskStart' in noTask.stored, false);
  assert.equal(noTask.taskReads, 0);

  const opening = await ingest({ clientTurnId: OPENING, content: brief, payload: { text: brief } });
  assert.equal(opening.taskReads, 1, 'the opening turn is the one that is read');
  assert.ok(opening.stored.taskStart);
});

test('the list\'s instructions ride the card when the brief carried them, and not for a foreman', async () => {
  const listed = taskRow({ list: { instructions: '  提交前跑一遍全量测试。  ' } });
  const brief = buildTaskExecutionPrompt(listed);
  const { stored } = await ingest({ clientTurnId: OPENING, content: brief, payload: { text: brief }, task: listed });
  assert.equal((stored.taskStart as { listInstructions: string }).listInstructions, '提交前跑一遍全量测试。');

  // A foreman's brief leaves the list's instructions out, so its card cannot carry them either.
  const foreman = taskRow({ isForeman: true, list: { instructions: '提交前跑一遍全量测试。' } });
  const foremanBrief = buildTaskExecutionPrompt(foreman);
  const run = await ingest({ clientTurnId: OPENING, content: foremanBrief, payload: { text: foremanBrief }, task: foreman });
  assert.equal((run.stored.taskStart as { listInstructions: string | null }).listInstructions, null);
});

test('only the control plane records a card: one sent by the runner is dropped, or replaced by the real one', async () => {
  const forged = { taskId: TASK, title: '伪造的卡片' };
  const typed = await ingest({ clientTurnId: 'c3a8f1d2-client-turn', content: '你好', payload: { text: '你好', taskStart: forged } });
  assert.equal('taskStart' in typed.stored, false, 'a card the runner sent was stored');

  const brief = buildTaskExecutionPrompt(taskRow());
  const replaced = await ingest({ clientTurnId: OPENING, content: brief, payload: { text: brief, taskStart: forged } });
  assert.equal((replaced.stored.taskStart as { title: string }).title, 'runner + web：配额按账户归属');
});
