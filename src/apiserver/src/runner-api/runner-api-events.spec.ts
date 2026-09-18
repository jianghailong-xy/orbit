import 'reflect-metadata';
import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/** A row as it lands in `run_event`: the columns the events write path sets. */
type RunEventRow = {
  sessionId: string;
  seq: number;
  type: string;
  payload: unknown;
  turnId: string | null;
  createdAt: Date;
};

function makeController(
  status: RunStatus = RunStatus.AWAITING_INPUT,
  runtimeSessionId: string | null = 'runtime-1',
  // What the Session row already carries. The batch's single write is computed against these
  // (see the one-write invariant in common/lock-order.ts), so a test that wants to observe a set
  // being cleared has to start it non-empty — a write that would change nothing is not issued.
  stored: {
    runningBgShells?: string[];
    runningSubagents?: string[];
    turnContents?: Record<string, string | null>;
    coordinatorContextEpoch?: number;
  } = {},
  // An in-memory `run_event` for specs that read back what a batch actually stored. It keeps the
  // table's own key: a second row at the same (sessionId, seq) is silently skipped, which is what
  // `skipDuplicates: true` does and why a collision here loses a real event instead of failing.
  runEventTable?: RunEventRow[],
) {
  const calls = {
    createMany: [] as any[],
    updateMany: [] as any[],
    update: [] as any[],
    executeRaw: [] as string[],
    toolCreate: [] as any[],
    toolUpdate: [] as any[],
  };
  const publishedEvents: any[] = [];
  const tx = {
    $queryRaw: async () => [{ id: 'session-1', leaseOwnerMatches: true }],
    $executeRaw: async (...args: unknown[]) => {
      calls.executeRaw.push(renderRawQuery(args).text);
      return 1;
    },
    runEvent: {
      createMany: async (args: any) => {
        calls.createMany.push(args);
        if (!runEventTable) return { count: args.data.length };
        let count = 0;
        for (const row of args.data as RunEventRow[]) {
          if (runEventTable.some((r) => r.seq === row.seq)) continue;
          runEventTable.push(row);
          count += 1;
        }
        return { count };
      },
    },
    // Every tool_use is denormalized into tool_call on create, and its tool_result pairs back
    // via updateMany. Record both so a test can assert the id is stored and the outcome lands.
    toolCall: {
      createMany: async (args: any) => {
        calls.toolCreate.push(args);
        return { count: args.data.length };
      },
      updateMany: async (args: any) => {
        calls.toolUpdate.push(args);
        return { count: 1 };
      },
    },
    conversationTurn: {
      findMany: async (args: { where: { sessionId: string; id: { in: string[] } } }) =>
        Object.entries(stored.turnContents ?? {})
          .filter(([id]) => args.where.sessionId === 'session-1' && args.where.id.in.includes(id))
          .map(([id, content]) => ({ id, content })),
    },
    session: {
      findUniqueOrThrow: async () => ({
        status,
        runtimeSessionId,
        cancelRequestedAt: null,
        runningBgShells: stored.runningBgShells ?? [],
        runningSubagents: stored.runningSubagents ?? [],
        coordinatorContextEpoch: stored.coordinatorContextEpoch ?? 0,
      }),
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
      update: async (args: any) => {
        calls.update.push(args);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  };
  const realtime = { publish: (_sessionId: string, event: any) => publishedEvents.push(event) };
  return {
    calls,
    published: () => publishedEvents.length,
    publishedEvents: () => publishedEvents,
    controller: new RunnerApiController(prisma as never, {} as never, realtime as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
  };
}

test('a reclaimed session init is persisted without advancing lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'init', sessionId: 'runtime-1' },
      },
    ],
  });

  assert.equal(calls.createMany.length, 1, 'the runtime handshake remains durable');
  assert.equal(calls.updateMany.length, 0, 'the Session row is never written more than once');
  assert.ok(
    !calls.update.some((c: any) => 'lastTurnAt' in (c.data ?? {})),
    'the old activity time remains unchanged',
  );
});

test('a compaction boundary advances the coordinator epoch in the batch one-write', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'context_compacted' },
      },
    ],
  });

  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].data.coordinatorContextEpoch, 42);
  assert.equal(calls.update[0].data.coordinatorContextAckKey, null);
});

test('replaying an already-observed compaction boundary does not advance the epoch', async () => {
  const { calls, controller } = makeController(
    RunStatus.AWAITING_INPUT,
    'runtime-1',
    { coordinatorContextEpoch: 42 },
  );

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'context_compacted' },
      },
    ],
  });

  assert.equal(calls.update.length, 1, 'the ordinary frontier update may still share this write');
  assert.equal('coordinatorContextEpoch' in calls.update[0].data, false);
  assert.equal('coordinatorContextAckKey' in calls.update[0].data, false);
});

test('an OpenCode init event persists the runtime id without counting as turn activity', async () => {
  const { calls, controller } = makeController(RunStatus.AWAITING_INPUT, null);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: {
          runtime: 'opencode-server',
          subtype: 'init',
          provider: 'opencode',
          sessionId: 'opencode-runtime-1',
        },
      },
    ],
  });

  assert.equal(calls.createMany.length, 1, 'the runtime handshake remains durable');
  // One write, carrying the runtime id and nothing that would count as turn activity. The
  // `runtimeSessionId IS NULL` guard this used to carry in its WHERE is the value read under the
  // row lock, which nothing can move while this transaction holds it.
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0].where, { id: 'session-1' });
  assert.equal(calls.update[0].data.runtimeSessionId, 'opencode-runtime-1');
  assert.equal('lastTurnAt' in calls.update[0].data, false);
});

test('a respawn handshake clears background work left by the previous process', async () => {
  const { calls, controller } = makeController(RunStatus.AWAITING_INPUT, 'runtime-1', {
    runningBgShells: ['toolu_prev'],
    runningSubagents: ['toolu_sub'],
  });

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'resumed', sessionId: 'runtime-1' },
      },
    ],
  });

  // The runner emits `resumed` itself when it restarts an engine in place, and the shells that
  // engine was running died with it — no terminal notification for any of them.
  assert.ok(
    calls.update.some(
      (c: any) =>
        c.data?.runningBgShells?.length === 0 && c.data?.runningSubagents?.length === 0,
    ),
    'the handshake resets both outliving-work sets',
  );
});

/**
 * Claude Code emits an `init` at the head of every query, including the self-driven turns it
 * starts for a background-task notification. Resetting on those erased the very background work
 * whose notification woke the workspace — a session watching a live Monitor reported none. The
 * crash-recovery case that `init` used to stand in for is covered by /takeover-leases, which
 * every claim and reclaim performs.
 */
test('an init does not clear background work, since every query emits one', async () => {
  const { calls, controller } = makeController(RunStatus.AWAITING_INPUT, 'runtime-1', {
    runningBgShells: ['toolu_prev'],
    runningSubagents: ['toolu_sub'],
  });

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'init', sessionId: 'runtime-1' },
      },
    ],
  });

  assert.ok(
    !calls.update.some(
      (c: any) =>
        c.data?.runningBgShells?.length === 0 && c.data?.runningSubagents?.length === 0,
    ),
    'a per-query init leaves the outliving-work sets alone',
  );
});

/** A Monitor is a background watcher with no run_in_background flag — backgrounding is all it
 *  does — and it reports in through the same terminal notification, so it is tracked alike. */
test('a Monitor launch joins the running background set', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.TOOL_USE,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { id: 'toolu_mon', name: 'Monitor', input: { command: 'until done; do :; done' } },
      },
    ],
  });

  assert.equal(calls.executeRaw.length, 0, 'the running sets ride the batch\'s one Session write');
  assert.deepEqual(
    calls.update[0].data.runningBgShells,
    ['toolu_mon'],
    'the Monitor launch is recorded as background work',
  );
  assert.equal(
    'runningSubagents' in calls.update[0].data,
    false,
    'the set it did not touch is left out of the write entirely',
  );
});

// A tool_use stores its id, and the tool_result pairs back to that row to fill the outcome —
// output/is_error/finished_at were dead columns until the id gave the result something to join to.
test('a tool_result fills the outcome of the tool_call its tool_use created', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 50,
        type: RunEventType.TOOL_USE,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { id: 'toolu_1', name: 'task_create', input: { title: 'x' } },
      },
      {
        seq: 51,
        type: RunEventType.TOOL_RESULT,
        ts: '2026-07-31T12:00:01.000Z',
        payload: { toolUseId: 'toolu_1', content: 'created task t_9', isError: false },
      },
    ],
  });

  assert.equal(calls.toolCreate[0].data[0].toolUseId, 'toolu_1', 'the tool_use id is stored');
  assert.equal(calls.toolUpdate.length, 1, 'the result pairs back to exactly one row');
  assert.deepEqual(calls.toolUpdate[0].where, { sessionId: 'session-1', toolUseId: 'toolu_1' });
  assert.equal(calls.toolUpdate[0].data.output, 'created task t_9');
  assert.equal(calls.toolUpdate[0].data.isError, false);
});

// A result whose runtime emitted no tool_use id must not run an update — { toolUseId: '' } would
// smear one outcome across every id-less row an old runtime produced.
test('a tool_result with no tool_use id updates nothing', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 52,
        type: RunEventType.TOOL_RESULT,
        ts: '2026-07-31T12:00:02.000Z',
        payload: { content: 'orphan output' },
      },
    ],
  });

  assert.equal(calls.toolUpdate.length, 0, 'an id-less result never issues an update');
});

test('a durable turn event still advances lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 43,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:01:00.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'status' },
      },
    ],
  });

  assert.equal(calls.updateMany.length, 0, 'the Session row is written once, not once per field');
  assert.equal(calls.update.length, 1);
  assert.ok(calls.update[0].data.lastTurnAt instanceof Date);
});

/**
 * The batch's Session write — which now carries the list-preview columns along with everything
 * else the batch changed, because a batch writes the row exactly once (common/lock-order.ts, I3).
 * The filter is kept so the assertion still names what it is reading.
 */
function previewUpdate(calls: { update: any[] }) {
  const hit = calls.update.filter((c: any) => 'lastToolUse' in (c.data ?? {}));
  assert.equal(hit.length, 1, 'exactly one Session write per batch');
  return hit[0].data;
}

/**
 * How full the context window is (Session.contextTokens) — the measurement a caller rotating a
 * long-lived session needs, denormalized off the turn_end event that already carries it for the
 * clients' gauge. The lifetime token sums cannot answer this: they only grow.
 */
test('the latest turn_end sets the session context size', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T01:22:21.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'success', numTurns: 1, contextTokens: 94_500, contextWindow: 1_000_000 },
      },
      {
        seq: 2,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T01:31:02.000Z',
        turnId: 'turn-2',
        payload: { subtype: 'success', numTurns: 2, contextTokens: 109_879, contextWindow: 1_000_000 },
      },
    ],
  });

  assert.equal(previewUpdate(calls).contextTokens, 109_879, 'the last one wins');
  assert.equal(previewUpdate(calls).contextWindow, 1_000_000);
});

/**
 * The two halves are one reading. A session that switches model mid-life reports a new pair; the
 * denominator must move with the numerator it arrived beside, not be reduced separately — a 1M
 * numerator under a 200k window (or the reverse) is a gauge reading over 100% or a session that
 * looks idle when it is nearly full.
 */
test('the window is taken from the same event as the tokens it divides', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T02:00:00.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'success', numTurns: 1, contextTokens: 620_000, contextWindow: 1_000_000 },
      },
      {
        // Switched to a smaller-window model: the pair moves together.
        seq: 2,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T02:10:00.000Z',
        turnId: 'turn-2',
        payload: { subtype: 'success', numTurns: 2, contextTokens: 12_000, contextWindow: 200_000 },
      },
    ],
  });

  const data = previewUpdate(calls);
  assert.equal(data.contextTokens, 12_000);
  assert.equal(data.contextWindow, 200_000);
});

/**
 * A runner too old to report a window still reports tokens. Writing the numerator while leaving a
 * previously stored denominator in place is the lesser evil: it is stale by one release, whereas
 * blanking it would drop the reading entirely and re-open the guessing the column exists to end.
 */
test('a runner that reports no window still updates the token count', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T03:00:00.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'success', numTurns: 1, contextTokens: 94_500 },
      },
    ],
  });

  const data = previewUpdate(calls);
  assert.equal(data.contextTokens, 94_500);
  assert.equal('contextWindow' in data, false);
});

test('a runtime that reports no context size leaves the stored one standing', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 3,
        type: RunEventType.TURN_END,
        ts: '2026-08-09T01:40:00.000Z',
        turnId: 'turn-3',
        // Kimi (and any runner too old to report it) sends the turn end without the field; the
        // Codex/OpenCode payloads send 0 when their usage was missing. Neither means "empty".
        payload: { subtype: 'success', numTurns: 3, contextTokens: 0 },
      },
    ],
  });

  assert.equal('contextTokens' in previewUpdate(calls), false);
});

/**
 * A turn interrupted before the workspace said anything must keep the message you sent as the list's
 * preview. The interrupt and the turn end are frontier events but not *answers*, so they must not
 * write null over `lastUserText` — doing so left the row with no preview at all.
 */
test('an interrupt before any reply keeps the pending user message', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.USER,
        ts: '2026-08-04T01:21:58.000Z',
        turnId: 'turn-1',
        payload: { text: '设置按钮的底色很奇怪，请帮我 review' },
      },
      {
        seq: 2,
        type: RunEventType.SYSTEM,
        ts: '2026-08-04T01:22:05.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'init', sessionId: 'runtime-1' },
      },
      {
        seq: 3,
        type: RunEventType.INTERRUPT,
        ts: '2026-08-04T01:22:09.000Z',
        turnId: 'turn-1',
        payload: {},
      },
      {
        seq: 4,
        type: RunEventType.TURN_END,
        ts: '2026-08-04T01:22:09.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'error_during_execution' },
      },
    ],
  });

  // The init handshake in this batch also resets the outliving-work sets, so pick the preview
  // write rather than assuming it's the only one.
  const preview = previewUpdate(calls);
  assert.equal(preview.lastUserText, '设置按钮的底色很奇怪，请帮我 review');
  assert.equal(preview.lastToolUse, null, 'the turn ended, so no tool is in flight');
});

test('the pending preview uses authored turn text instead of delivery context', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING, 'runtime-1', {
    turnContents: { 'turn-1': 'review the button colour' },
  });

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [{
      seq: 1,
      type: RunEventType.USER,
      ts: '2026-08-04T01:21:58.000Z',
      turnId: 'turn-1',
      payload: {
        text: 'review the button colour\n\n<orbit_project_coordinator_context>\nrole\n</orbit_project_coordinator_context>',
      },
    }],
  });

  assert.equal(previewUpdate(calls).lastUserText, 'review the button colour');
});

test('an attachment-only coordinator turn never previews generated context as user text', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING, 'runtime-1', {
    turnContents: { 'turn-1': null },
  });

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [{
      seq: 1,
      type: RunEventType.USER,
      ts: '2026-08-04T01:21:58.000Z',
      turnId: 'turn-1',
      payload: {
        text: '\n\n<orbit_project_coordinator_context>\nrole\n</orbit_project_coordinator_context>',
      },
    }],
  });

  assert.equal(previewUpdate(calls).lastUserText, null);
});

/**
 * A tool is not an answer. While one is in flight the row shows it (`lastToolUse` outranks the
 * message), but between tools the workspace is still working on that message — and clearing there
 * dropped the row back to the PREVIOUS turn's reply for the rest of a tool-heavy turn, which is
 * exactly the "it already answered me" misreading the preview exists to prevent.
 */
test('a tool does not answer the pending message', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.USER,
        ts: '2026-08-04T01:21:58.000Z',
        turnId: 'turn-1',
        payload: { text: 'read png behaves differently on iOS and web' },
      },
      {
        seq: 2,
        type: RunEventType.TOOL_USE,
        ts: '2026-08-04T01:22:01.000Z',
        turnId: 'turn-1',
        payload: { id: 'tool-1', name: 'Bash', input: {} },
      },
      {
        seq: 3,
        type: RunEventType.TOOL_RESULT,
        ts: '2026-08-04T01:22:03.000Z',
        turnId: 'turn-1',
        payload: { toolUseId: 'tool-1', output: 'ok' },
      },
    ],
  });

  const preview = previewUpdate(calls);
  assert.equal(preview.lastUserText, 'read png behaves differently on iOS and web');
  assert.equal(preview.lastToolUse, null, 'the tool finished, so none is in flight');
});

test('a reply answers the pending message and clears it', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 1,
        type: RunEventType.USER,
        ts: '2026-08-04T01:21:58.000Z',
        turnId: 'turn-1',
        payload: { text: 'review the button colour' },
      },
      {
        seq: 2,
        type: RunEventType.ASSISTANT,
        ts: '2026-08-04T01:22:20.000Z',
        turnId: 'turn-1',
        payload: { text: 'Looks like a token mismatch.' },
      },
      {
        seq: 3,
        type: RunEventType.TURN_END,
        ts: '2026-08-04T01:22:21.000Z',
        turnId: 'turn-1',
        payload: {},
      },
    ],
  });

  const preview = previewUpdate(calls);
  assert.equal(preview.lastAssistantText, 'Looks like a token mismatch.');
  assert.equal(preview.lastUserText, null, 'the reply replaced the pending message');
});

/** A batch that neither asks nor answers must leave the stored message untouched. */
test('a batch with no user turn and no answer never writes lastUserText', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 9,
        type: RunEventType.SYSTEM,
        ts: '2026-08-04T01:23:00.000Z',
        turnId: 'turn-2',
        payload: { subtype: 'status' },
      },
    ],
  });

  assert.ok(
    !('lastUserText' in previewUpdate(calls)),
    'no event decided either way, so the column is left alone',
  );
});

test('terminal sessions reject durable events before any write or publish', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    const { calls, controller, published } = makeController(status);

    await assert.rejects(
      controller.events({ id: 'runner-1' }, 'session-1', {
        events: [
          {
            seq: 44,
            type: RunEventType.ASSISTANT,
            ts: '2026-07-31T12:02:00.000Z',
            turnId: 'turn-1',
            payload: { text: 'late zombie output' },
          },
        ],
      }),
      ConflictException,
    );

    assert.equal(calls.createMany.length, 0);
    assert.equal(calls.updateMany.length, 0);
    assert.equal(published(), 0);
  }
});

test('terminal sessions reject empty and streaming-only batches too', async () => {
  for (const events of [
    [],
    [
      {
        seq: 45,
        type: RunEventType.TEXT_DELTA,
        ts: '2026-07-31T12:03:00.000Z',
        payload: { text: 'late' },
      },
    ],
  ]) {
    const { calls, controller, published } = makeController(RunStatus.FAILED);
    await assert.rejects(
      controller.events({ id: 'runner-1' }, 'session-1', { events }),
      ConflictException,
    );
    assert.equal(calls.createMany.length, 0);
    assert.equal(calls.updateMany.length, 0);
    assert.equal(published(), 0);
  }
});

test('tool_output is broadcast at live-only seq 0 but never persisted or treated as a tool result', async () => {
  const { calls, controller, published, publishedEvents } = makeController(RunStatus.RUNNING);
  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 46,
        type: RunEventType.TOOL_OUTPUT,
        ts: '2026-08-30T12:03:00.000Z',
        turnId: 'turn-1',
        payload: { toolUseId: 'shell-turn-1', content: 'still running' },
      },
    ],
  });
  assert.equal(calls.createMany.length, 0);
  assert.equal(calls.toolUpdate.length, 0, 'live output must not complete the tool_call row');
  assert.equal(calls.updateMany.length, 0, 'live output must not move session durable state');
  assert.equal(published(), 1);
  assert.equal(publishedEvents()[0].seq, 0, 'old clients must not advance their durable cursor');
  assert.equal(publishedEvents()[0].payload.content, 'still running');
  assert.equal(publishedEvents()[0].payload.snapshotSeq, 46, 'clients can order live snapshots separately');
});

/** A controller wired only for the read path: session ownership plus one raw query. */
function makeReaderController(rows: unknown[], assignedRunnerId = 'runner-1') {
  const prisma = {
    session: { findUnique: async () => ({ id: 'session-1', assignedRunnerId }) },
    $queryRaw: async () => rows,
  };
  return new RunnerApiController(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
}

test('the transcript read hands back whole payloads oldest-first', async () => {
  const controller = makeReaderController([
    { seq: 1, type: RunEventType.USER, payload: { text: 'hi' }, ts: new Date(0) },
    { seq: 2, type: RunEventType.ASSISTANT, payload: { text: 'x'.repeat(5000) }, ts: new Date(0) },
  ]);

  const out = await controller.sessionEvents({ id: 'runner-1' }, 'session-1', '0', '10');

  assert.equal(out.hasMore, false);
  assert.deepEqual(
    out.events.map((e) => e.seq),
    [1, 2],
  );
  // A rebuilt transcript assembled from preview-sized tool bodies would rewrite the workspace's
  // own history, so this path must never truncate the way the clients' /events/page does.
  assert.equal((out.events[1].payload as { text: string }).text.length, 5000);
});

test('the transcript read reports more without leaking the probe row', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    seq: i + 1,
    type: RunEventType.USER,
    payload: {},
    ts: new Date(0),
  }));
  const controller = makeReaderController(rows);

  const out = await controller.sessionEvents({ id: 'runner-1' }, 'session-1', '0', '2');

  assert.equal(out.hasMore, true, 'the extra row means older history remains');
  assert.equal(out.events.length, 2, 'the probe row itself is not returned');
});

test('another runner cannot read a session transcript', async () => {
  const controller = makeReaderController([], 'runner-2');

  await assert.rejects(
    controller.sessionEvents({ id: 'runner-1' }, 'session-1', undefined, undefined),
    ForbiddenException,
  );
});

test('a recent turn-attributed batch cannot bypass the terminal fence', async () => {
  const { calls, controller, published } = makeController(RunStatus.FAILED);

  await assert.rejects(
    controller.events({ id: 'runner-1' }, 'session-1', {
      events: [
        {
          seq: 46,
          type: RunEventType.ASSISTANT,
          ts: new Date().toISOString(),
          turnId: 'turn-1',
          payload: { text: 'late zombie output' },
        },
      ],
    }),
    ConflictException,
  );

  assert.equal(calls.createMany.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(published(), 0);
});

test('a backlogged batch inserts in bounded chunks so no single createMany can stall the loop', async () => {
  const { calls, controller } = makeController(RunStatus.RUNNING);

  const rows = 300;
  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: Array.from({ length: rows }, (_, i) => ({
      seq: i + 1,
      type: RunEventType.SYSTEM,
      ts: '2026-07-31T12:00:00.000Z',
      payload: { subtype: 'notice', text: `event ${i}` },
    })),
  });

  assert.equal(calls.createMany.length, 2, '300 rows split across two chunks');
  assert.equal(calls.createMany[0].data.length, 256);
  assert.equal(calls.createMany[1].data.length, 44);
  assert.equal(calls.createMany.every((c: any) => c.skipDuplicates === true), true);
});

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_OWNER = '22222222-2222-4222-8222-222222222222';

/**
 * The reclaim door, taking its high-water mark out of the same table the write path filled — the
 * production line the resume rests on (`maxSeq: agg._max.seq ?? 0` in RunnerApiController, and the
 * same `runEvent.aggregate({ _max: { seq } })` in queue.service.ts for a fresh claim).
 */
function makeReclaimController(runEventTable: RunEventRow[], sessionId: string) {
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: sessionId,
          ownerId: RUNNER_OWNER,
          status: RunStatus.AWAITING_INPUT,
          // Codex reclaims with the Orbit session id and starts a fresh thread, so this path does
          // not need a runtime id; anything but null is enough for a Job to be built at all.
          provider: 'codex',
          providerBuiltin: true,
          model: null,
          permissionMode: null,
          effort: null,
          title: 'idle session',
          runtimeSessionId: null,
          inboxLeaseOwner: '44444444-4444-4444-8444-444444444444',
          branch: null,
          mergeTarget: null,
          workspaceId: null,
          taskId: null,
          workspace: null,
          assignedRunner: {
            runtimeDefaultModels: { codex: 'gpt-runtime-default' },
            modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
          },
        },
      ],
    },
    user: { findUnique: async () => null },
    runEvent: {
      aggregate: async () => ({
        _max: { seq: runEventTable.reduce<number | null>((max, r) => (max === null || r.seq > max ? r.seq : max), null) },
      }),
    },
    $executeRaw: async () => 1,
  };
  return new RunnerApiController(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
}

const at = (minute: number) => `2026-09-18T10:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * What ingress stores, and what it refuses to. The noise rows are the per-token `thinking_tokens`
 * pings — 97.8% of this table's rows on 2026-09-18, 98.3% of them from one provider — so this is
 * the write-side half of the retention change; the read paths still filter the same predicate
 * (notNoiseSql) for the rows already archived.
 */
test('ingress stores no system progress ping, and stores everything else whole', async () => {
  const table: RunEventRow[] = [];
  const { calls, controller } = makeController(RunStatus.RUNNING, 'runtime-1', {}, table);

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      { seq: 1, type: RunEventType.USER, ts: at(0), turnId: 'turn-1', payload: { text: '把 run_event 的入口收一下' } },
      // `init` is one of the two system subtypes with a real consumer (runtimeInitSessionId).
      { seq: 2, type: RunEventType.SYSTEM, ts: at(1), payload: { subtype: 'init', sessionId: 'runtime-1' } },
      // The row this exists to stop storing: `{model, subtype, sessionId}` and nothing else.
      { seq: 3, type: RunEventType.SYSTEM, ts: at(2), payload: { model: null, subtype: 'thinking_tokens', sessionId: 'runtime-1' } },
      { seq: 4, type: RunEventType.ASSISTANT, ts: at(3), turnId: 'turn-1', payload: { text: '改好了' } },
      { seq: 5, type: RunEventType.SYSTEM, ts: at(4), payload: { subtype: 'status' } },
      { seq: 6, type: RunEventType.SYSTEM, ts: at(5), payload: {} },
      // Codex streams stderr as a subtype-less system event, and it is the only record of why a
      // runtime failed to come up. The shape rule is what keeps it — a subtype blocklist would not.
      { seq: 7, type: RunEventType.SYSTEM, ts: at(6), payload: { content: 'No conversation found with session ID abc' } },
    ],
  });

  assert.deepEqual(table.map((r) => r.seq), [1, 2, 4, 7], 'the pings never reach run_event');
  assert.deepEqual(
    calls.createMany[0].data.map((r: { seq: number }) => r.seq),
    [1, 2, 4, 7],
    'nor are they handed to the insert to be dropped there',
  );
  assert.deepEqual(table[3].payload, { content: 'No conversation found with session ID abc' });
  assert.deepEqual(table[0].payload, { text: '把 run_event 的入口收一下' }, 'a user echo is stored as the engine read it');
  assert.deepEqual(
    {
      sessionId: table[2].sessionId,
      seq: table[2].seq,
      type: table[2].type,
      turnId: table[2].turnId,
      createdAt: table[2].createdAt,
    },
    { sessionId: 'session-1', seq: 4, type: RunEventType.ASSISTANT, turnId: 'turn-1', createdAt: new Date(at(3)) },
    'a surviving row keeps every column it had',
  );
});

/**
 * The invariant the drop rests on, end to end through the code that hands a runner its counter.
 *
 * Dropping pings at ingress puts the stored high-water mark BELOW what the dead process had counted
 * to. That is safe because the slots it fell behind by were never stored: a runner resuming at
 * max+1 re-uses free ones. What would NOT be safe is a stored row at or above the resume point —
 * `createMany({ skipDuplicates: true })` swallows a colliding event in silence, so a real one would
 * simply go missing. Both sites that rebuild the counter read `max(run_event.seq)`
 * (queue.service.ts for a claim, RunnerApiController.reclaim below), so the store here is the only
 * thing between them.
 */
test('a ping dropped at the tail of a batch is a free slot when a runner resumes', async () => {
  const table: RunEventRow[] = [];
  const { controller } = makeController(RunStatus.RUNNING, 'runtime-1', {}, table);

  // One incarnation of a runner, counting 1..10. The last two are the per-token pings it ends on.
  await controller.events({ id: RUNNER_ID }, 'session-1', {
    events: [
      ...Array.from({ length: 8 }, (_, i) => ({
        seq: i + 1,
        type: RunEventType.ASSISTANT,
        ts: at(i),
        turnId: 'turn-1',
        payload: { text: `chunk ${i + 1}` },
      })),
      { seq: 9, type: RunEventType.SYSTEM, ts: at(9), payload: { model: null, subtype: 'thinking_tokens', sessionId: 'runtime-1' } },
      { seq: 10, type: RunEventType.SYSTEM, ts: at(10), payload: { model: null, subtype: 'thinking_tokens', sessionId: 'runtime-1' } },
    ],
  });
  // It dies, the runner comes back and reclaims. The resume point is the STORED max — 8, two
  // behind the 10 that process had counted to, and that gap is the whole point: assert it before
  // anything else, so this spec fails on the invariant itself rather than on a symptom of it.
  const reclaimed = await makeReclaimController(table, 'session-1').reclaim({
    id: RUNNER_ID,
    ownerId: RUNNER_OWNER,
  });
  const resumePoint = reclaimed.sessions[0]!.maxSeq + 1;

  assert.equal(resumePoint, 9);
  assert.equal(
    table.some((r) => r.seq >= resumePoint),
    false,
    'nothing stored at or above the resume point, so skipDuplicates has nothing to swallow',
  );
  assert.deepEqual(table.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8], 'the two pings are what it fell behind by');

  // The new process starts its counter there (runner-go: `seq := job.MaxSeq + 1`) and so re-uses
  // 9 — the slot its predecessor burned on a ping. It is free, so the real event lands intact.
  await controller.events({ id: RUNNER_ID }, 'session-1', {
    events: [
      {
        seq: resumePoint,
        type: RunEventType.ASSISTANT,
        ts: at(20),
        turnId: 'turn-2',
        payload: { text: 'the reply after the restart' },
      },
    ],
  });

  assert.deepEqual(table.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(table[8].payload, { text: 'the reply after the restart' }, 'stored, not skipped as a duplicate');
});
