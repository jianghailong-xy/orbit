import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
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

function makeService(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown>[] = [];
  const deleteFilters: Record<string, unknown>[] = [];
  const session = { id: SESSION_ID, ownerId: OWNER_ID, status: RunStatus.RUNNING, cancelRequestedAt: null };
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
      count: async () => 1,
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    conversationTurn: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        filters.push(where);
        return rows;
      },
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, filters, deleteFilters };
}

const row = (id: string, kind: string, content: string) => ({
  id,
  kind,
  content,
  attachments: [],
});

test('a still-pending steer is listed, so a reload can still see it', async () => {
  const h = makeService([row('t1', 'steer', 'actually, call it gadget')]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].turnId, 't1');
  // Tagged, not silently folded in with the messages waiting behind the turn: the client shows
  // it as on its way rather than as waiting, and offers no withdraw for it.
  assert.equal(listed[0].kind, 'steer');
  assert.equal(listed[0].content, 'actually, call it gadget');
});

test('the queue query asks for exactly the three kinds a person can have sent', async () => {
  const h = makeService([]);

  await h.service.listQueuedTurns(OWNER_ID, SESSION_ID);

  const where = h.filters[0] as { kind: { in: string[] }; status: string };
  assert.deepEqual([...where.kind.in].sort(), ['message', 'shell', 'steer']);
  // Only what nothing has taken yet. A leased turn is in the transcript, and listing it here
  // would resurrect it below the conversation it already appears in.
  assert.equal(where.status, 'PENDING');
});

test('a queued message and a steer are told apart, not merged', async () => {
  const h = makeService([
    row('t1', 'steer', 'actually, call it gadget'),
    row('t2', 'message', 'and then deploy'),
    row('t3', 'shell', 'git status'),
  ]);

  const listed = await h.service.listQueuedTurns(OWNER_ID, SESSION_ID);

  assert.deepEqual(
    listed.map((t) => t.kind),
    ['steer', 'message', 'shell'],
  );
});

test('a steer is not withdrawable, however it got onto that list', async () => {
  // The mirror of listing it: cancelQueuedTurn deletes only message/shell, so a client that
  // offered Cancel on a steer would be offering a button that always fails. This is what makes
  // hiding that affordance correct rather than merely tidy.
  const h = makeService([]);

  await assert.rejects(
    h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, '33333333-3333-4333-8333-333333333333'),
    /message already started|not found/,
  );

  const where = h.deleteFilters[0] as { kind: { in: string[] } };
  assert.deepEqual([...where.kind.in].sort(), ['message', 'shell']);
});
