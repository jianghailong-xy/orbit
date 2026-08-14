import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

function makeController(
  status: RunStatus = RunStatus.AWAITING_INPUT,
  runtimeSessionId: string | null = 'runtime-1',
) {
  const calls = {
    createMany: [] as any[],
    updateMany: [] as any[],
    update: [] as any[],
    executeRaw: [] as string[],
    toolCreate: [] as any[],
    toolUpdate: [] as any[],
  };
  let published = 0;
  const tx = {
    $queryRaw: async () => [{ id: 'session-1', leaseOwnerMatches: true }],
    // The running-work sets are maintained with atomic array SQL rather than a read-modify-write;
    // record the statement so a test can assert which set a launch touched.
    $executeRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      calls.executeRaw.push(strings.join('?'));
      return 1;
    },
    runEvent: {
      createMany: async (args: any) => {
        calls.createMany.push(args);
        return { count: args.data.length };
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
    session: {
      findUniqueOrThrow: async () => ({
        status,
        runtimeSessionId,
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
  const realtime = { publish: () => published++ };
  return {
    calls,
    published: () => published,
    controller: new RunnerApiController(prisma as never, {} as never, realtime as never, {} as never, {} as never),
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
  assert.equal(calls.updateMany.length, 0, 'the old activity time remains unchanged');
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
  assert.deepEqual(calls.updateMany, [
    {
      where: { id: 'session-1', runtimeSessionId: null },
      data: { runtimeSessionId: 'opencode-runtime-1' },
    },
  ]);
});

test('a respawn handshake clears background work left by the previous process', async () => {
  const { calls, controller } = makeController();

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
 * whose notification woke the agent — a session watching a live Monitor reported none. The
 * crash-recovery case that `init` used to stand in for is covered by /takeover-leases, which
 * every claim and reclaim performs.
 */
test('an init does not clear background work, since every query emits one', async () => {
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

  assert.ok(
    calls.executeRaw.some((sql: string) => sql.includes('running_bg_shells')),
    'the Monitor launch is recorded as background work',
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

  assert.equal(calls.updateMany.length, 1);
  assert.ok(calls.updateMany[0].data.lastTurnAt instanceof Date);
});

/** The session write carrying the list-preview columns, which is not the batch's only update. */
function previewUpdate(calls: { update: any[] }) {
  const hit = calls.update.filter((c: any) => 'lastToolUse' in (c.data ?? {}));
  assert.equal(hit.length, 1, 'exactly one preview write per batch');
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
 * A turn interrupted before the agent said anything must keep the message you sent as the list's
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

/** A controller wired only for the read path: session ownership plus one raw query. */
function makeReaderController(rows: unknown[], assignedRunnerId = 'runner-1') {
  const prisma = {
    session: { findUnique: async () => ({ id: 'session-1', assignedRunnerId }) },
    $queryRaw: async () => rows,
  };
  return new RunnerApiController(prisma as never, {} as never, {} as never, {} as never, {} as never);
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
  // A rebuilt transcript assembled from preview-sized tool bodies would rewrite the agent's
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
