import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { ListEventsService } from '../task-lists/list-events.service';
import { appendBackgroundJobsContext } from './background-jobs-context';
import { buildResumeContinuation } from './resume-continuation';
import { RunnerApiController } from './runner-api.controller';

/**
 * The record half of "a control-plane block is not signed by the user".
 *
 * The runner echoes what it was handed, so the `user` event of a delivery that carried a
 * `<background-jobs>` or `<list-conditions>` block holds the person's words and the block in one
 * string, and the clients drew all of it as the person's. Ingest holds what the person wrote — the
 * turn row — so it records the rest beside the echo as `controlPlaneNote`, which is what the
 * clients draw as the control plane's.
 *
 * The echoes here are the two injections' real output rather than fixtures shaped like it, so the
 * note is checked against exactly what delivery appended. Every "no note" has a twin in the same
 * test that must produce one, so none of them can pass merely because no note is ever written.
 */

const SESSION = 'session-1';
const TURN = 'turn-1';
const TYPED = '已经部署，请帮我测试';

/** `content` as appendBackgroundJobsContext hands it out, with a job that ended while nobody was here. */
async function withBackgroundJobs(content: string | null): Promise<string> {
  const outputPath = '/root/.orbit/runs/session-1/bgj_3a1af2b50428.output';
  const tx = {
    conversationTurn: {
      count: async () => 0,
      findFirst: async () => ({ deliveredAt: new Date('2026-09-10T12:00:00.000Z') }),
    },
    runEvent: {
      findMany: async () => [
        {
          seq: 1,
          createdAt: new Date('2026-09-10T11:00:00.000Z'),
          payload: { toolUseId: 'bgj_3a1af2b50428', status: 'running', kind: 'job', command: 'bash upgrade.sh', outputPath },
        },
        {
          seq: 2,
          createdAt: new Date('2026-09-10T12:20:00.000Z'),
          payload: { toolUseId: 'bgj_3a1af2b50428', status: 'completed', kind: 'job', exitCode: 0, outputPath },
        },
      ],
    },
  };
  const delivered = await appendBackgroundJobsContext(tx as never, SESSION, TURN, 'generation-1', content);
  assert.ok(delivered?.includes('</background-jobs>'), `no <background-jobs> block was appended to ${content}`);
  return delivered as string;
}

/** `content` as ListEventsService.appendFor hands it to a list console. */
async function withListConditions(content: string): Promise<string> {
  const tx = {
    taskList: {
      findMany: async () => [{ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', title: 'FineWeb CC-MAIN-2025-26' }],
    },
    taskListEvent: {
      findMany: async () => [{
        id: 'e1',
        kind: 'quota_hold',
        detail: '12 个就绪任务被配额挡住',
        occurrences: 47,
        firstSeenAt: new Date('2026-08-15T03:11:00.000Z'),
        lastSeenAt: new Date('2026-08-15T04:07:00.000Z'),
        deliveredAt: null,
      }],
      updateMany: async () => ({ count: 1 }),
    },
  };
  const delivered = await new ListEventsService({} as never).appendFor(tx as never, SESSION, content);
  assert.ok(delivered?.includes('</list-conditions>'), `no <list-conditions> block was appended to ${content}`);
  return delivered as string;
}

/**
 * The runner's event ingress, given one `user` echo for a turn whose row holds `authored`. Returns
 * the payload as it was stored, having checked that the live broadcast carried the same one.
 */
async function ingest(
  authored: string | null,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stored: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
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
      findMany: async (args: { where: { sessionId: string; id: { in: string[] } } }) =>
        args.where.sessionId === SESSION && args.where.id.in.includes(TURN)
          ? [{ id: TURN, content: authored }]
          : [],
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: RunStatus.RUNNING,
        runtimeSessionId: 'runtime-1',
        cancelRequestedAt: null,
        runningBgShells: [],
        runningSubagents: [],
        coordinatorContextEpoch: 0,
      }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
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
    events: [{ seq: 1, type: RunEventType.USER, ts: '2026-09-10T12:26:47.307Z', turnId: TURN, payload }],
  });

  assert.equal(stored.length, 1, 'the echo was not stored');
  assert.deepEqual(published, stored, 'live subscribers must be sent the payload that was stored');
  return stored[0];
}

test('the <background-jobs> block delivery appended is recorded as the note, and the echo is stored whole', async () => {
  const delivered = await withBackgroundJobs(TYPED);

  const stored = await ingest(TYPED, { text: delivered });

  assert.equal(stored.text, delivered, 'the echo is what the engine read, so it is kept as it was');
  assert.equal(stored.controlPlaneNote, delivered.slice(TYPED.length));
});

test('the <list-conditions> board is recorded the same way', async () => {
  const typed = '这个列表现在什么情况？';
  const delivered = await withListConditions(typed);

  const stored = await ingest(typed, { text: delivered });

  assert.equal(stored.text, delivered);
  assert.equal(stored.controlPlaneNote, delivered.slice(typed.length));
});

test('a block someone typed is theirs: no note for it, while one delivery appends after it still is', async () => {
  // Real blocks, pasted into the composer as the person's own message.
  const pasted = [
    `为什么我这里有这个？${await withBackgroundJobs('')}`,
    `这又是什么？${await withListConditions('')}`,
  ];
  for (const typed of pasted) {
    const alone = await ingest(typed, { text: typed });
    assert.equal(alone.text, typed);
    assert.equal('controlPlaneNote' in alone, false, `a note was recorded for words the person typed:\n${typed}`);

    const delivered = await withBackgroundJobs(typed);
    const appended = await ingest(typed, { text: delivered });
    assert.equal(
      appended.controlPlaneNote,
      delivered.slice(typed.length),
      'the delivery that did append a block recorded no note for it',
    );
  }
});

test('an interrupted turn handed out again: the continuation is the message, the block after it is the note', async () => {
  const continuation = buildResumeContinuation(TYPED);
  const delivered = await withBackgroundJobs(continuation);

  const stored = await ingest(TYPED, { text: delivered });

  assert.equal(stored.controlPlaneNote, delivered.slice(continuation.length));
});

test('a message of attachments alone: the whole echo is what delivery appended', async () => {
  const delivered = await withBackgroundJobs(null);

  const stored = await ingest(null, { text: delivered });

  assert.equal(stored.controlPlaneNote, delivered);
});

test('only the control plane says what it appended: a note from the runner is dropped, or replaced by the real one', async () => {
  // Kept, this one would take "请帮我测试" out of a bubble that nothing was ever appended to.
  const forged = await ingest(TYPED, { text: TYPED, controlPlaneNote: '请帮我测试' });
  assert.equal(forged.text, TYPED);
  assert.equal('controlPlaneNote' in forged, false, 'a note the runner sent was stored');

  const delivered = await withBackgroundJobs(TYPED);
  const replaced = await ingest(TYPED, { text: delivered, controlPlaneNote: '请帮我测试' });
  assert.equal(replaced.controlPlaneNote, delivered.slice(TYPED.length));
});

test('an echo that does not begin with what was written gets no note', async () => {
  // A note may only ever hold text the person provably did not write.
  const delivered = await withBackgroundJobs(TYPED);

  const unrelated = await ingest('另一条消息', { text: delivered });
  assert.equal('controlPlaneNote' in unrelated, false);

  const matching = await ingest(TYPED, { text: delivered });
  assert.equal(matching.controlPlaneNote, delivered.slice(TYPED.length), 'the same echo against the turn it came from');
});
