import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import {
  openItemMessage,
  openItemTurnId,
} from '../projects/project-open-item';

/**
 * What a reopened console can still see of a message sent mid-turn.
 *
 * A turn has no transcript event until the runner leases it, so GET /sessions/:id/turns is the
 * only thing a reload can rebuild the queue from. A steer is normally leased within a poll — but
 * "normally" is not "always" (an offline runner, a wedged engine), and until then it exists
 * nowhere else. Left off this list it would simply vanish on refresh, which is the one outcome
 * mid-turn sending must not produce.
 *
 * Listed is not the same as withdrawable: cancelQueuedTurn refuses a steer, because a message the
 * engine may already be reading cannot be taken back. `kind` is what keeps the two apart on the
 * clients, so it has to survive the mapping.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

// One exception item's delivery, for the tests at the foot of this file (§4.4 X-D2): the turn it
// was queued as, and the reading its card is drawn from.
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const TASK_TITLE = '回填历史 user 事件的 controlPlaneNote';
const ITEM_TITLE = `Task failed: ${TASK_TITLE}`;
const ASSIGNED_AT = new Date('2026-09-21T12:00:00.000Z');
const FAILURE = {
  how: 'ACCEPTANCE_EXIT_MISMATCH',
  exitCode: 1,
  expectedExitCode: 0,
  chain: { rootTaskId: TASK_ID, failuresInChain: 2, limit: 3 },
};
/** The item's own columns, as the delivery's card reads them. */
const ITEM_ROW = {
  id: ITEM_ID,
  kind: 'TASK_FAILED',
  title: ITEM_TITLE,
  payload: FAILURE,
  taskId: TASK_ID,
  sessionId: SESSION_ID,
  projectId: PROJECT_ID,
  assignee: 'COORDINATOR',
  promotionId: null,
  fuseEpisodeId: null,
};
/** The key `project-open-item.service` queues a delivery under — how a turn says it is one. */
const ITEM_TURN = openItemTurnId(ITEM_ID, ASSIGNED_AT);
/** The paragraph the agent is handed: the turn's content, and the prose the card folds away. */
const ITEM_MESSAGE = openItemMessage({
  id: ITEM_ID,
  kind: 'TASK_FAILED',
  title: ITEM_TITLE,
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  payload: FAILURE,
});
/** The paragraph above as fields — what a client draws instead of it, and what has to be identical
 *  to the card the runner's echo carries, or the delivery redraws itself as it lands. */
const ITEM_CARD = {
  itemId: ITEM_ID,
  kind: 'TASK_FAILED',
  title: ITEM_TITLE,
  task: { id: TASK_ID, title: TASK_TITLE, sessionId: SESSION_ID },
  files: [],
  targetRef: null,
  check: null,
  errorCode: null,
  failure: {
    how: 'ACCEPTANCE_EXIT_MISMATCH',
    exitCode: 1,
    expectedExitCode: 0,
    attempt: 2,
    limit: 3,
  },
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: {
    receipts: 0,
    state: 'NOT_KNOWN',
    upstream: 'main',
    integration: `project/${PROJECT_ID}`,
  },
};

function makeService(
  rows: Array<Record<string, unknown>>,
  announcedTurnIds: string[] = [],
  failedDeliveryTurnIds: string[] = [],
  /** What each successive deleteMany matches, in call order. Default: nothing, anywhere. */
  deleteCounts: number[] = [],
  /** The exception item one of those turns is a delivery of, when one of them is one. */
  openItem: Record<string, unknown> | null = null,
) {
  let deletes = 0;
  const filters: Record<string, unknown>[] = [];
  const orderings: Record<string, unknown>[] = [];
  const eventFilters: Record<string, unknown>[] = [];
  const deleteFilters: Record<string, unknown>[] = [];
  const itemReads: string[] = [];
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: RunStatus.RUNNING,
    cancelRequestedAt: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      // Nothing is queued here that a withdrawal has to settle before it deletes: no Watch wake with
      // a delivery to dead-letter, and no `bg-wake:` turn with a payload kept beside it.
      findMany: async () => [],
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deleteFilters.push(where);
        return { count: deleteCounts[deletes++] ?? 0 };
      },
      // What the delete matched nothing BECAUSE of: a steer row, or nothing at all.
      findFirst: async () => (rows.some((r) => r.kind === 'steer') ? { id: rows[0].id } : null),
      count: async () => 1,
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    conversationTurn: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
      }) => {
        filters.push(where);
        orderings.push(orderBy);
        return rows;
      },
    },
    runEvent: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        eventFilters.push(where);
        return [
          ...announcedTurnIds.map((turnId) => ({ type: 'user', turnId, payload: {} })),
          ...failedDeliveryTurnIds.map((turnId) => ({
            type: 'user_delivery',
            turnId: 'running-target',
            payload: { turnId, delivery: 'failed' },
          })),
        ];
      },
    },
    // What an exception item's delivery reads to become a card (project-open-item.ts
    // `readOpenItemDeliveryCard`): the item's own row, the task it is about with its merge receipts,
    // and the project's landing branches.
    projectOpenItem: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        itemReads.push(where.id);
        return openItem && openItem.id === where.id ? openItem : null;
      },
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        openItem && openItem.taskId === where.id
          ? { id: where.id, title: TASK_TITLE, mergeReceipts: [] }
          : null,
    },
    projectCodebase: {
      findFirst: async () => ({
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${PROJECT_ID}`,
      }),
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, filters, orderings, eventFilters, deleteFilters, itemReads };
}

const CREATED_AT = new Date('2026-08-26T12:34:56.000Z');
const row = (
  id: string,
  kind: string,
  content: string,
  opts: {
    seq?: number;
    status?: string;
    clientTurnId?: string;
    targetTurnId?: string;
    sendIntent?: string;
    deliveryStatus?: string;
    deliveryFailureCode?: string;
    deliveryFailureReason?: string;
  } = {},
) => ({
  id,
  seq: opts.seq ?? 1,
  clientTurnId: opts.clientTurnId ?? `client-${id}`,
  kind,
  targetTurnId: opts.targetTurnId ?? null,
  sendIntent: opts.sendIntent ?? null,
  deliveryStatus: opts.deliveryStatus ?? null,
  deliveryFailureCode: opts.deliveryFailureCode ?? null,
  deliveryFailureReason: opts.deliveryFailureReason ?? null,
  status: opts.status ?? 'PENDING',
  content,
  createdAt: CREATED_AT,
  attachments: [],
});

test('a still-pending steer is listed, so a reload can still see it', async () => {
  const h = makeService([
    row('t1', 'steer', 'actually, call it gadget', { targetTurnId: 'target-running' }),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.equal(listed.length, 1);
  assert.equal(listed[0].turnId, 't1');
  // Tagged, not silently folded in with the messages waiting behind the turn: the client shows
  // it as on its way rather than as waiting, and offers no withdraw for it.
  assert.equal(listed[0].kind, 'steer');
  assert.equal(listed[0].placement, 'steer');
  assert.equal(listed[0].targetTurnId, 'target-running');
  assert.equal(listed[0].content, 'actually, call it gadget');
  assert.equal(listed[0].createdAt, CREATED_AT.toISOString());
});

test('one ordered snapshot asks for every active row needed to classify the queue', async () => {
  const h = makeService([]);

  await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  const where = h.filters[0] as {
    kind: { in: string[] };
    OR: Array<{ status?: { in: string[] }; sendIntent?: string; deliveryStatus?: string }>;
    clientTurnId?: unknown;
  };
  assert.deepEqual([...where.kind.in].sort(), ['message', 'shell', 'steer']);
  assert.deepEqual([...where.OR[0].status!.in].sort(), ['IN_FLIGHT', 'PENDING']);
  assert.deepEqual(where.OR[1], {
    sendIntent: 'CURRENT_WORK',
    deliveryStatus: { in: ['FAILED', 'UNCONFIRMED'] },
  });
  assert.equal(
    where.clientTurnId,
    undefined,
    'the initial prompt must remain visible to head classification',
  );
  assert.deepEqual(h.orderings, [{ seq: 'asc' }]);
  assert.deepEqual(h.eventFilters, [], 'an empty active set needs no announcement probe');
});

test('a head message is accepted while later executables queue and steers stay distinct', async () => {
  const h = makeService([
    row('t1', 'steer', 'actually, call it gadget', { seq: 1 }),
    row('t2', 'message', 'and then deploy', { seq: 2 }),
    row('t3', 'shell', 'git status', { seq: 3 }),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(
    listed.map((t) => t.kind),
    ['steer', 'message', 'shell'],
  );
  assert.deepEqual(
    listed.map((t) => t.placement),
    ['steer', 'accepted', 'queued'],
  );
});

test('the hidden initial prompt remains the head and makes a follow-up queued', async () => {
  const h = makeService([
    row('initial', 'message', 'opening prompt', {
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(SESSION_ID),
    }),
    row('follow-up', 'message', 'one more thing', { seq: 2 }),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(
    listed.map((turn) => ({ id: turn.turnId, placement: turn.placement })),
    [{ id: 'follow-up', placement: 'queued' }],
  );
});

test('an announced hidden initial prompt remains the head and makes a follow-up queued', async () => {
  const h = makeService(
    [
      row('initial', 'message', 'opening prompt', {
        seq: 1,
        status: 'IN_FLIGHT',
        clientTurnId: SessionsService.initialTurnClientId(SESSION_ID),
      }),
      row('follow-up', 'message', 'one more thing', { seq: 2 }),
    ],
    ['initial'],
  );

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(
    listed.map((turn) => ({ id: turn.turnId, placement: turn.placement })),
    [{ id: 'follow-up', placement: 'queued' }],
  );
  assert.deepEqual(h.eventFilters, [
    {
      sessionId: SESSION_ID,
      OR: [
        { type: 'user', turnId: { in: ['initial', 'follow-up'] } },
        { type: 'user_delivery', payload: { path: ['delivery'], equals: 'failed' } },
      ],
    },
  ]);
});

test('active returns the accepted IN_FLIGHT head, steer, and queued successor', async () => {
  const h = makeService([
    row('running', 'message', 'working now', { seq: 1, status: 'IN_FLIGHT' }),
    row('steer', 'steer', 'adjust this', { seq: 2, status: 'IN_FLIGHT' }),
    row('next', 'shell', 'git status', { seq: 3 }),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(
    listed.map((turn) => ({ id: turn.turnId, placement: turn.placement })),
    [
      { id: 'running', placement: 'accepted' },
      { id: 'steer', placement: 'steer' },
      { id: 'next', placement: 'queued' },
    ],
  );
});

test('an announced IN_FLIGHT head is omitted without promoting its queued successor', async () => {
  const h = makeService(
    [
      row('running', 'message', '改', { seq: 9, status: 'IN_FLIGHT' }),
      row('steer', 'steer', 'adjust it', { seq: 10, status: 'IN_FLIGHT' }),
      row('next', 'message', 'follow up', { seq: 11 }),
    ],
    ['running', 'steer'],
  );

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(
    listed.map((turn) => ({ id: turn.turnId, placement: turn.placement })),
    [{ id: 'next', placement: 'queued' }],
  );
  assert.deepEqual(h.eventFilters, [
    {
      sessionId: SESSION_ID,
      OR: [
        { type: 'user', turnId: { in: ['running', 'steer', 'next'] } },
        { type: 'user_delivery', payload: { path: ['delivery'], equals: 'failed' } },
      ],
    },
  ]);
});

test('USER(enqueued) returns the durable CURRENT_WORK failure Web merges onto that bubble', async () => {
  const h = makeService(
    [
      row('current-work', 'steer', 'adjust it', {
        status: 'ANSWERED',
        targetTurnId: 'running-target',
        sendIntent: 'CURRENT_WORK',
        deliveryStatus: 'FAILED',
        deliveryFailureCode: 'CURRENT_WORK_TARGET_COMPLETED',
        deliveryFailureReason: 'The target completed before the engine acknowledged this message.',
      }),
    ],
    // The runner may have already emitted optimistic USER(enqueued/written). It is not an ACK.
    ['current-work'],
  );

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.deepEqual(listed, [{
    turnId: 'current-work',
    kind: 'steer',
    placement: 'steer',
    targetTurnId: 'running-target',
    delivery: 'failed',
    deliveryCode: 'CURRENT_WORK_TARGET_COMPLETED',
    deliveryReason: 'The target completed before the engine acknowledged this message.',
    content: 'adjust it',
    createdAt: CREATED_AT.toISOString(),
    attachments: [],
  }]);
});

test('runner-loss ambiguity remains visible as UNCONFIRMED even after USER(written)', async () => {
  const h = makeService(
    [
      row('current-work', 'steer', 'adjust it', {
        status: 'ANSWERED',
        targetTurnId: 'running-target',
        sendIntent: 'CURRENT_WORK',
        deliveryStatus: 'UNCONFIRMED',
        deliveryFailureCode: 'CURRENT_WORK_SESSION_REAPED',
        deliveryFailureReason: 'Delivery could not be confirmed after runner loss.',
      }),
    ],
    ['current-work'],
  );

  assert.deepEqual(await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'), [{
    turnId: 'current-work',
    kind: 'steer',
    placement: 'steer',
    targetTurnId: 'running-target',
    delivery: 'unconfirmed',
    deliveryCode: 'CURRENT_WORK_SESSION_REAPED',
    deliveryReason: 'Delivery could not be confirmed after runner loss.',
    content: 'adjust it',
    createdAt: CREATED_AT.toISOString(),
    attachments: [],
  }]);
});

test('runner USER_DELIVERY(failed) suppresses the duplicate durable failure overlay', async () => {
  const h = makeService(
    [
      row('current-work', 'steer', 'adjust it', {
        status: 'ANSWERED',
        targetTurnId: 'running-target',
        sendIntent: 'CURRENT_WORK',
        deliveryStatus: 'FAILED',
        deliveryFailureCode: 'CURRENT_WORK_RUNTIME_REJECTED',
        deliveryFailureReason: 'The runtime rejected the adjustment.',
      }),
    ],
    ['current-work'],
    ['current-work'],
  );

  assert.deepEqual(
    await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'),
    [],
    'the transcript owns the one terminal Not delivered bubble after reload',
  );
});

test('the default view excludes a PENDING accepted head old clients would mislabel as queued', async () => {
  const h = makeService([row('head', 'message', 'start now', { seq: 1 })]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID);

  assert.deepEqual(listed, []);
});

test('the default excludes IN_FLIGHT and keeps only truly queued PENDING rows and steers', async () => {
  const h = makeService([
    row('running', 'message', 'working now', { seq: 1, status: 'IN_FLIGHT' }),
    row('flight-steer', 'steer', 'already delivering', { seq: 2, status: 'IN_FLIGHT' }),
    row('pending-steer', 'steer', 'adjust next', { seq: 3 }),
    row('queued', 'shell', 'git status', { seq: 4 }),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID);

  // Exact legacy wire shape: no placement/createdAt fields an installed client does not know.
  assert.deepEqual(listed, [
    {
      turnId: 'pending-steer',
      kind: 'steer',
      content: 'adjust next',
      attachments: [],
    },
    { turnId: 'queued', kind: 'shell', content: 'git status', attachments: [] },
  ]);
});

test('the controller requires an exact active opt-in and defaults every other value to legacy', async () => {
  const calls: Array<'active' | undefined> = [];
  const controller = new SessionsController(
    {
      listQueuedTurns: async (_ownerId: string, _id: string, view?: 'active') => {
        calls.push(view);
        return [];
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const user = { userId: OWNER_ID } as never;

  await controller.queuedTurns(user, SESSION_ID, undefined);
  await controller.queuedTurns(user, SESSION_ID, 'active');
  await controller.queuedTurns(user, SESSION_ID, 'future-view');

  assert.deepEqual(calls, [undefined, 'active', undefined]);
});

test('a steer is not withdrawable, however it got onto that list', async () => {
  // The mirror of listing it: cancelQueuedTurn deletes only message/shell, so a client that
  // offered Cancel on a steer would be offering a button that always fails. This is what makes
  // hiding that affordance correct rather than merely tidy.
  const h = makeService([row('t1', 'steer', 'actually, call it gadget')]);

  await assert.rejects(
    h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, '33333333-3333-4333-8333-333333333333'),
    // And refused for the reason it is actually refused for: the message is not gone, it is
    // already on its way into the running turn (see turn-error-contract.spec.ts).
    /written into the running turn/,
  );

  const where = h.deleteFilters[0] as { kind: { in: string[] } };
  assert.deepEqual([...where.kind.in].sort(), ['message', 'shell']);
});

test('a message that settled undelivered can be discarded, unlike a steer in flight', async () => {
  // The exception that keeps "Not delivered" from being a dead end. Nothing read this message —
  // that is what the durable receipt says — so the reason a steer cannot be withdrawn does not
  // apply to it, and without this the only copy of what was typed sits under the conversation
  // for good. The withdraw door is asked first and matches nothing (the row is ANSWERED, not
  // PENDING); the settled-undelivered delete is what carries it.
  const h = makeService(
    [
      row('t1', 'steer', 'actually, call it gadget', {
        status: 'ANSWERED',
        sendIntent: 'CURRENT_WORK',
        deliveryStatus: 'FAILED',
        deliveryFailureCode: 'CURRENT_WORK_TARGET_COMPLETED',
        deliveryFailureReason: 'The target turn completed before CURRENT_WORK could be delivered.',
      }),
    ],
    [],
    [],
    [0, 1],
  );

  assert.deepEqual(
    await h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, '33333333-3333-4333-8333-333333333333'),
    { ok: true },
  );

  const where = h.deleteFilters[1] as {
    kind: string;
    sendIntent: string;
    deliveryStatus: { in: string[] };
  };
  assert.equal(where.kind, 'steer');
  assert.equal(where.sendIntent, 'CURRENT_WORK');
  // UNCONFIRMED too: "we cannot prove the engine read it" is still not a message the person can
  // reach any other way, and leaving it is the same dead end.
  assert.deepEqual([...where.deliveryStatus.in].sort(), ['FAILED', 'UNCONFIRMED']);
});

/**
 * An exception item's delivery, in the projection the tab paints it from before its `user` event
 * exists (§4.4 X-D1, X-D2).
 *
 * The delivery is queued as an ordinary turn, so GET /sessions/:id/turns?view=active is the only
 * thing a client can draw it from until a runner leases the turn and echoes it. A projection that
 * carried the words and not the card therefore made the delivery render as a message somebody
 * typed, and then redraw itself as a card in the same place a few seconds later — the flicker the
 * owner reported. The card itself is the reading the ingest path takes for that echo, by the same
 * function on the same rows; these assertions are about its FIELDS, because a second derivation of
 * them is exactly what would show up as the delivery changing shape as it lands.
 *
 * Read back as JSON rather than as the TypeScript type, because that is the client's copy: a field
 * the mapper drops on the way out is a field no client can draw, however it is spelled here.
 */
const asWire = (rows: unknown): Array<Record<string, unknown>> =>
  JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;

test("an exception item's delivery carries its card in the active projection", async () => {
  const h = makeService(
    [row('item-turn', 'message', ITEM_MESSAGE, { clientTurnId: ITEM_TURN })],
    [],
    [],
    [],
    ITEM_ROW,
  );

  const [wire] = asWire(await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'));

  // The turn is still the paragraph the agent is handed — the card is recorded BESIDE it, it does
  // not replace what the coordinator reads.
  assert.equal(wire.content, ITEM_MESSAGE);
  assert.equal(wire.placement, 'accepted');
  assert.deepEqual(wire.openItemDelivery, ITEM_CARD, 'the client has nothing to draw a card from');
  assert.deepEqual(h.itemReads, [ITEM_ID], 'read once, for the turn that is one');
});

test("a delivery still waiting behind a running turn carries its card too", async () => {
  const h = makeService(
    [
      row('running', 'message', 'working now', { seq: 1, status: 'IN_FLIGHT' }),
      row('item-turn', 'message', ITEM_MESSAGE, { seq: 2, clientTurnId: ITEM_TURN }),
    ],
    [],
    [],
    [],
    ITEM_ROW,
  );

  const listed = asWire(await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'));

  // The queued tail draws the same turn the transcript will: leaving this row text-only would move
  // the flicker to the moment it reaches the head rather than removing it.
  assert.deepEqual(
    listed.map((turn) => [turn.turnId, turn.placement]),
    [['running', 'accepted'], ['item-turn', 'queued']],
  );
  assert.deepEqual(listed[1].openItemDelivery, ITEM_CARD);
});

test('an ordinary queued turn carries no card and costs no read', async () => {
  const h = makeService(
    [
      row('running', 'message', 'working now', { seq: 1, status: 'IN_FLIGHT' }),
      row('typed', 'message', 'and then deploy', { seq: 2, clientTurnId: 'not-an-item-turn' }),
      // A turn id that merely CONTAINS the marker is not one: the prefix is the whole of what makes
      // a turn a delivery.
      row('embedded', 'message', 'and one more', { seq: 3, clientTurnId: `x${ITEM_TURN}` }),
    ],
    [],
    [],
    [],
    ITEM_ROW,
  );

  const listed = asWire(await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'));

  assert.deepEqual(Object.keys(listed[1]).sort(), [
    'attachments',
    'content',
    'createdAt',
    'kind',
    'placement',
    'turnId',
  ]);
  assert.deepEqual(Object.keys(listed[2]).sort(), Object.keys(listed[1]).sort());
  assert.deepEqual(h.itemReads, [], 'nothing is read for a turn that is not a delivery');
});
