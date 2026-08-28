import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

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

function makeService(
  rows: Array<Record<string, unknown>>,
  announcedTurnIds: string[] = [],
) {
  const filters: Record<string, unknown>[] = [];
  const orderings: Record<string, unknown>[] = [];
  const eventFilters: Record<string, unknown>[] = [];
  const deleteFilters: Record<string, unknown>[] = [];
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
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deleteFilters.push(where);
        return { count: 0 };
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
        const requested = new Set((where.turnId as { in: string[] }).in);
        return announcedTurnIds
          .filter((turnId) => requested.has(turnId))
          .map((turnId) => ({ turnId }));
      },
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, filters, orderings, eventFilters, deleteFilters };
}

const CREATED_AT = new Date('2026-08-26T12:34:56.000Z');
const row = (
  id: string,
  kind: string,
  content: string,
  opts: { seq?: number; status?: string; clientTurnId?: string } = {},
) => ({
    id,
    seq: opts.seq ?? 1,
    clientTurnId: opts.clientTurnId ?? `client-${id}`,
    kind,
    status: opts.status ?? 'PENDING',
    content,
    createdAt: CREATED_AT,
    attachments: [],
  });

test('a still-pending steer is listed, so a reload can still see it', async () => {
  const h = makeService([row('t1', 'steer', 'actually, call it gadget')]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  assert.equal(listed.length, 1);
  assert.equal(listed[0].turnId, 't1');
  // Tagged, not silently folded in with the messages waiting behind the turn: the client shows
  // it as on its way rather than as waiting, and offers no withdraw for it.
  assert.equal(listed[0].kind, 'steer');
  assert.equal(listed[0].placement, 'steer');
  assert.equal(listed[0].content, 'actually, call it gadget');
  assert.equal(listed[0].createdAt, CREATED_AT.toISOString());
});

test('one ordered snapshot asks for every active row needed to classify the queue', async () => {
  const h = makeService([]);

  await h.service.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');

  const where = h.filters[0] as {
    kind: { in: string[] };
    status: { in: string[] };
    clientTurnId?: unknown;
  };
  assert.deepEqual([...where.kind.in].sort(), ['message', 'shell', 'steer']);
  assert.deepEqual([...where.status.in].sort(), ['IN_FLIGHT', 'PENDING']);
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
      type: 'user',
      turnId: { in: ['initial', 'follow-up'] },
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
      type: 'user',
      turnId: { in: ['running', 'steer', 'next'] },
    },
  ]);
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
