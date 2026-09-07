import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider, RunEventType, type RunInboxResponse } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';

/**
 * Stage 2b, the half a returning agent sees. A runner-hosted background job now outlives the
 * engine that asked for it, which means an engine that comes back has no idea the job exists:
 * `claude --resume` restores the conversation, and the conversation is exactly what was written
 * before the job finished. The runner's durable `background_task` events are the only record, so
 * the delivery that wakes the replacement engine is where they have to be said.
 *
 * What is asserted here is the content actually handed to the runner by the inbox — not a helper
 * in isolation — because the failure this prevents is a block that exists and never rides along.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_GENERATION = '55555555-5555-4555-8555-555555555555';
const TURN_ID = '66666666-6666-4666-8666-666666666666';

const PREVIOUS_DELIVERY = new Date('2026-09-07T09:00:00.000Z');
const WHILE_AWAY = new Date('2026-09-07T09:30:00.000Z');
const LONG_AGO = new Date('2026-09-07T08:00:00.000Z');

const LIVE_PATH = '/root/.orbit/runs/abc/bgj_live.output';
const DONE_PATH = '/root/.orbit/runs/abc/bgj_done.output';
const FAILED_PATH = '/root/.orbit/runs/abc/bgj_failed.output';
const OLD_PATH = '/root/.orbit/runs/abc/bgj_old.output';

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
  acceptsSteer?: boolean,
  declaredCapabilities?: readonly string[],
) => Promise<RunInboxResponse | null>;

type EventRow = { seq: number; payload: Record<string, unknown>; createdAt: Date };

/** One `background_task` row as the runner writes it for a job it hosts itself. */
function jobEvent(
  seq: number,
  createdAt: Date,
  payload: Record<string, unknown>,
): EventRow {
  return { seq, payload, createdAt };
}

/** The launch half: emitted when the runner spawns the job, and the only carrier of its command. */
function launched(seq: number, id: string, command: string, outputPath: string): EventRow {
  return jobEvent(seq, LONG_AGO, {
    shellId: id,
    toolUseId: id,
    status: 'running',
    kind: 'job',
    command,
    outputPath,
  });
}

/** The terminal half, carrying the exit code the runner's own Wait returned. */
function finished(
  seq: number,
  at: Date,
  id: string,
  status: string,
  exitCode: number,
  outputPath: string,
): EventRow {
  return jobEvent(seq, at, {
    shellId: id,
    toolUseId: id,
    status,
    kind: 'job',
    exitCode,
    outputPath,
    summary: `Background job completed (exit code ${exitCode})`,
  });
}

function harness(options: {
  events?: EventRow[];
  /** Deliveries already made under THIS inbox lease generation, i.e. this engine process. */
  earlierDeliveriesThisGeneration?: number;
  previousDeliveryAt?: Date | null;
  leaseGeneration?: string | null;
  content?: string;
  /** Whether this turn already produced runtime output, i.e. it is a lease re-delivery. */
  runtimeStarted?: boolean;
}) {
  const content = options.content ?? '继续吧。';
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return [{
          id: SESSION_ID,
          inboxLeaseGeneration: options.leaseGeneration === undefined
            ? LEASE_GENERATION
            : options.leaseGeneration,
          inboxLeaseOwner: null,
          status: RunStatus.RUNNING,
          ownerId: OWNER_ID,
          provider: AgentProvider.CLAUDE,
          providerBuiltin: true,
        }];
      }
      if (/FROM "inbox_lease_generation"/.test(sql)) {
        return [{ generation: LEASE_GENERATION }];
      }
      if (/UPDATE "conversation_turn"/.test(sql)) {
        return [{
          id: TURN_ID,
          seq: 4,
          kind: 'message',
          content,
          clientTurnId: 'client-turn-1',
          coordinatorContextKey: null,
        }];
      }
      return [];
    },
    session: {
      findUnique: async () => ({
        ownerId: OWNER_ID,
        prompt: '把 CI 修绿。',
        titleBeforeProjectManagement: null,
        coordinatorContextEpoch: 0,
        coordinatorContextAckKey: null,
        coordinatorForProject: null,
      }),
    },
    conversationTurn: {
      count: async () => options.earlierDeliveriesThisGeneration ?? 0,
      findFirst: async () =>
        options.previousDeliveryAt === undefined
          ? { deliveredAt: PREVIOUS_DELIVERY }
          : options.previousDeliveryAt === null
            ? null
            : { deliveredAt: options.previousDeliveryAt },
      updateMany: async () => ({ count: 1 }),
    },
    runEvent: {
      findFirst: async () => (options.runtimeStarted ? { id: 'event-1' } : null),
      findMany: async () => options.events ?? [],
    },
    attachment: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, text?: string) => text } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, text?: string) => text } as never,
  );
  return {
    dequeue: (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.bind(controller),
    content,
  };
}

/** The fixture the two halves of the contract share: one live job, two that ended. */
function mixedJobs(): EventRow[] {
  return [
    launched(1, 'bgj_live', 'npm run build', LIVE_PATH),
    launched(2, 'bgj_done', 'go test ./...', DONE_PATH),
    launched(3, 'bgj_failed', 'npm run lint', FAILED_PATH),
    finished(4, WHILE_AWAY, 'bgj_done', 'completed', 0, DONE_PATH),
    finished(5, WHILE_AWAY, 'bgj_failed', 'failed', 7, FAILED_PATH),
  ];
}

test('a resumed delivery carries the jobs still running and the ones that ended while nobody was here', async () => {
  const { dequeue } = harness({ events: mixedJobs() });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn, 'the inbox handed back no turn at all');
  const text = turn.content ?? '';
  assert.match(text, /继续吧。/, 'the message the person actually sent must survive');

  // Still running: named, with the command and the file its output is being written to — the
  // three things an agent needs to pick the work back up rather than start it again.
  assert.match(text, /bgj_live/);
  assert.match(text, /npm run build/);
  assert.ok(text.includes(LIVE_PATH), `the live job's output path is missing from:\n${text}`);

  // Ended while the engine was gone: the exact exit code the runner's own Wait returned.
  assert.match(text, /bgj_done/);
  assert.ok(text.includes(DONE_PATH), `the finished job's output path is missing from:\n${text}`);
  assert.match(text, /bgj_failed/);
  assert.ok(text.includes(FAILED_PATH), `the failed job's output path is missing from:\n${text}`);
  assert.match(text, /7/, 'the failed job must report the exit code it actually had');
});

test('the block is said once per engine, not on every turn that engine then takes', async () => {
  const { dequeue, content } = harness({
    events: mixedJobs(),
    earlierDeliveriesThisGeneration: 1,
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  assert.equal(
    turn.content,
    content,
    'this engine was already told; repeating it every turn is noise it pays for',
  );
});

test('jobs that ended before the agent last had the floor are not re-announced', async () => {
  const { dequeue } = harness({
    events: [
      launched(1, 'bgj_live', 'npm run build', LIVE_PATH),
      launched(2, 'bgj_old', 'npm run olde2e', OLD_PATH),
      finished(3, LONG_AGO, 'bgj_old', 'completed', 0, OLD_PATH),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  const text = turn.content ?? '';
  // The positive half is what keeps this from passing on an empty block: the live job is here.
  assert.match(text, /bgj_live/, 'the live job must still be reported');
  assert.ok(
    !text.includes('bgj_old'),
    `a job that ended before the previous delivery was announced again:\n${text}`,
  );
});

test("an engine-owned shell is not offered as work the agent can pick back up", async () => {
  // No `kind`: this is Claude's own Bash(run_in_background) child, parsed out of a
  // <task-notification>. It died with the engine that spawned it, so listing it as running would
  // send the agent to read an output file nothing is still writing.
  const { dequeue, content } = harness({
    events: [
      jobEvent(1, LONG_AGO, {
        shellId: 'bash_1',
        toolUseId: 'bash_1',
        status: 'running',
        outputFile: '/tmp/bash_1.output',
      }),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  assert.equal(turn.content, content);
});

test('a session that never ran a background job is delivered exactly what was sent', async () => {
  const { dequeue, content } = harness({ events: [] });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  assert.equal(turn.content, content);
});

test('the block rides the continuation of an interrupted turn too', async () => {
  // A re-delivery replaces the person's text with buildResumeContinuation. That is the most
  // literal "the engine restarted" there is, so it is the last place the job list may be dropped.
  const { dequeue } = harness({ events: mixedJobs(), runtimeStarted: true });
  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  const text = turn.content ?? '';
  assert.match(text, /因所在 runner 重启而中断/, 'this must be the continuation path, not a fresh send');
  assert.match(text, /bgj_live/);
});

test('a legacy poller with no engine generation is left alone', async () => {
  // Without a generation there is no "this engine has already been told", so the block would be
  // appended to every single turn. Correctness-first, exactly like the coordinator block.
  const { dequeue, content } = harness({ events: mixedJobs(), leaseGeneration: null });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, null);

  assert.ok(turn);
  assert.equal(turn.content, content);
});

test('the runner is told about background_task events and nothing else', async () => {
  const seen: unknown[] = [];
  const events = mixedJobs();
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return [{
          id: SESSION_ID,
          inboxLeaseGeneration: LEASE_GENERATION,
          inboxLeaseOwner: null,
          status: RunStatus.RUNNING,
          ownerId: OWNER_ID,
          provider: AgentProvider.CLAUDE,
          providerBuiltin: true,
        }];
      }
      if (/FROM "inbox_lease_generation"/.test(sql)) return [{ generation: LEASE_GENERATION }];
      if (/UPDATE "conversation_turn"/.test(sql)) {
        return [{
          id: TURN_ID,
          seq: 4,
          kind: 'message',
          content: '继续吧。',
          clientTurnId: 'client-turn-1',
          coordinatorContextKey: null,
        }];
      }
      return [];
    },
    session: {
      findUnique: async () => ({
        ownerId: OWNER_ID,
        prompt: '把 CI 修绿。',
        titleBeforeProjectManagement: null,
        coordinatorContextEpoch: 0,
        coordinatorContextAckKey: null,
        coordinatorForProject: null,
      }),
    },
    conversationTurn: {
      count: async () => 0,
      findFirst: async () => ({ deliveredAt: PREVIOUS_DELIVERY }),
      updateMany: async () => ({ count: 1 }),
    },
    runEvent: {
      findFirst: async () => null,
      findMany: async (args: unknown) => {
        seen.push(args);
        return events;
      },
    },
    attachment: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, text?: string) => text } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, text?: string) => text } as never,
  );
  await (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.bind(controller)(
    SESSION_ID,
    RUNNER_ID,
    LEASE_GENERATION,
  );

  assert.equal(seen.length, 1, 'the job list costs exactly one indexed read of the event log');
  const where = (seen[0] as { where?: Record<string, unknown> }).where ?? {};
  assert.equal(where.sessionId, SESSION_ID);
  assert.equal(where.type, RunEventType.BACKGROUND_TASK);
});
