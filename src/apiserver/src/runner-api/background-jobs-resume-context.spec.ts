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
const LOST_PATH = '/root/.orbit/runs/abc/bgj_lost.output';
const CUT_PATH = '/root/.orbit/runs/abc/bgj_cut.output';

/** The runner process that holds the session now, and the one whose place it took. */
const CURRENT_RUNNER = '77777777-7777-4777-8777-777777777777';
const REPLACED_RUNNER = '88888888-8888-4888-8888-888888888888';
/** When the replaced process retired its last inbox generation, and a delivery made after that. */
const RUNNER_REPLACED = new Date('2026-09-07T09:20:00.000Z');
const AFTER_REPLACEMENT = new Date('2026-09-07T09:40:00.000Z');

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
  acceptsSteer?: boolean,
  declaredCapabilities?: readonly string[],
) => Promise<RunInboxResponse | null>;

type EventRow = {
  seq: number;
  payload: Record<string, unknown>;
  createdAt: Date;
  ingestedUnderLeaseGeneration?: string | null;
};

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

/** The same row, as delivered by one particular runner process. */
function reportedBy(runner: string, row: EventRow): EventRow {
  return { ...row, ingestedUnderLeaseGeneration: runner };
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
  /** The runner process that holds the session now: `session.inbox_lease_owner`. */
  leaseOwner?: string | null;
  /** Inbox lease generations the session's earlier runner processes retired. */
  retiredGenerations?: Array<{ leaseOwner: string; retiredAt: Date }>;
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
          inboxLeaseOwner: options.leaseOwner ?? null,
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
    inboxLeaseGeneration: { findMany: async () => options.retiredGenerations ?? [] },
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

test('lists a Monitor that stopped with its engine', async () => {
  // A Claude Monitor runs inside the engine, so a recycled engine takes it along, and Claude writes
  // nothing about it. The runner's `killed` event is the only record; without it the resumed agent
  // goes on believing the wait it arranged will wake it.
  const { dequeue } = harness({
    events: [
      jobEvent(1, WHILE_AWAY, {
        shellId: 'b97q4j1iy',
        toolUseId: 'toolu_monitor',
        status: 'killed',
        tool: 'Monitor',
        timeoutMs: 2400000,
        summary: 'Monitor stopped with the session runtime that ran it; it will send no more events',
      }),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn, 'the inbox handed back no turn at all');
  const text = turn.content ?? '';
  assert.match(text, /继续吧。/, 'the message the person actually sent must survive');
  assert.ok(text.includes('b97q4j1iy'), `the stopped Monitor's task id is missing from:\n${text}`);
  assert.ok(text.includes('toolu_monitor'), `the stopped Monitor's tool_use id is missing from:\n${text}`);
  assert.match(text, /arrange the wait again/, 'the agent must be told to arrange the wait again');
  // Not a job: there is no output file to read and nothing to pick back up.
  assert.ok(!text.includes('mcp__orbit__bg_output'), `a stopped Monitor was offered as a job:\n${text}`);
});

/** The lines listed under one heading of the block, or '' when the block has no such heading. */
function listedUnder(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  ${heading}`));
  if (start < 0) return '';
  const listed: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    listed.push(line);
  }
  return listed.join('\n');
}

test('a job whose runner process was replaced before it reported an end is not offered as running', async () => {
  // 70d5bfef after the 0.1.155 restart: the runner process hosting the job stopped, the kill it
  // made never reached the control plane, and a new process took the session over. The job's last
  // row still says `running`, and the event log on its own says nothing else.
  const { dequeue } = harness({
    leaseOwner: CURRENT_RUNNER,
    retiredGenerations: [{ leaseOwner: REPLACED_RUNNER, retiredAt: RUNNER_REPLACED }],
    events: [
      reportedBy(REPLACED_RUNNER, launched(1, 'bgj_lost', 'npm run test:full', LOST_PATH)),
      reportedBy(CURRENT_RUNNER, launched(2, 'bgj_live', 'npm run build', LIVE_PATH)),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn, 'the inbox handed back no turn at all');
  const text = turn.content ?? '';
  const running = listedUnder(text, 'Still running');
  const endedWhileAway = listedUnder(text, 'Ended while you were away');
  // The positive half: the job the current process hosts is still said to be running.
  assert.match(running, /bgj_live/, `the live job must still be reported running:\n${text}`);
  assert.ok(!running.includes('bgj_lost'), `a job whose runner process is gone was offered as running:\n${text}`);
  assert.ok(
    endedWhileAway.includes('bgj_lost'),
    `the job the replaced runner process took with it is not reported as ended:\n${text}`,
  );
  assert.ok(endedWhileAway.includes(LOST_PATH), `its output file must still be named:\n${text}`);
  assert.match(endedWhileAway, /runner process/, `the agent must be told why it has no exit code:\n${text}`);
});

test('a job the stopping runner reported killed keeps the end it reported', async () => {
  // Where the runner's report did arrive, filed as runner_shutdown. Its own terminal row places it,
  // so this is the other half of the case above: whatever tells a replaced runner's unreported job
  // apart must not swallow the jobs that same runner did report.
  const { dequeue } = harness({
    leaseOwner: CURRENT_RUNNER,
    retiredGenerations: [{ leaseOwner: REPLACED_RUNNER, retiredAt: RUNNER_REPLACED }],
    events: [
      reportedBy(REPLACED_RUNNER, launched(1, 'bgj_cut', 'go test ./...', CUT_PATH)),
      reportedBy(REPLACED_RUNNER, jobEvent(2, RUNNER_REPLACED, {
        shellId: 'bgj_cut',
        toolUseId: 'bgj_cut',
        status: 'killed',
        kind: 'job',
        command: 'go test ./...',
        outputPath: CUT_PATH,
        reason: 'runner_shutdown',
        summary: 'Background job was killed',
      })),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  const text = turn.content ?? '';
  assert.ok(!listedUnder(text, 'Still running').includes('bgj_cut'), `a killed job was offered as running:\n${text}`);
  const line = listedUnder(text, 'Ended while you were away').split('\n').find((l) => l.includes('bgj_cut')) ?? '';
  assert.match(line, /killed｜reason runner_shutdown/, `the kill must be listed as the runner reported it:\n${text}`);
  assert.ok(!line.includes('no end reported'), `a reported end was replaced by a guess:\n${text}`);
});

test("a replaced runner process's job is announced once, not by every engine after it", async () => {
  const { dequeue } = harness({
    leaseOwner: CURRENT_RUNNER,
    retiredGenerations: [{ leaseOwner: REPLACED_RUNNER, retiredAt: RUNNER_REPLACED }],
    previousDeliveryAt: AFTER_REPLACEMENT,
    events: [
      reportedBy(REPLACED_RUNNER, launched(1, 'bgj_lost', 'npm run test:full', LOST_PATH)),
      reportedBy(CURRENT_RUNNER, launched(2, 'bgj_live', 'npm run build', LIVE_PATH)),
    ],
  });

  const turn = await dequeue(SESSION_ID, RUNNER_ID, LEASE_GENERATION);

  assert.ok(turn);
  const text = turn.content ?? '';
  assert.match(text, /bgj_live/, 'the live job must still be reported');
  assert.ok(!text.includes('bgj_lost'), `a job already announced since the takeover was announced again:\n${text}`);
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
