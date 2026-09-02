import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * Interrupt-and-send as one transaction.
 *
 * Two requests cannot express this. Interrupting DELETES the follow-ups queued behind the
 * running turn, so "interrupt, then send" races its own delete and "send, then interrupt"
 * files the message as a steer — written into the very turn the person is stopping. The
 * order inside one transaction is the whole design, and it is what these pin: validate,
 * drop the queue, file the interrupt, and only then file the follow-up.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_TURN_ID = '44444444-4444-4444-8444-444444444444';

type Op = { op: string; kind?: unknown; clientTurnId?: unknown };

function makeService(opts?: {
  executableAfterDelete?: number;
  status?: RunStatus;
  /** clientTurnIds already on the session — how a retry is recognised. */
  existing?: Record<string, { id: string; seq: number; content?: string }>;
  /** Attachment ids the owner actually has; anything else is rejected. */
  attachments?: string[];
  trashed?: boolean;
}) {
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: opts?.status ?? RunStatus.RUNNING,
    cancelRequestedAt: null,
    deletedAt: opts?.trashed ? new Date() : null,
    prompt: 'opening prompt',
    numTurns: 1,
  };
  const ops: Op[] = [];
  const created: Record<string, unknown>[] = [];
  const existing = opts?.existing ?? {};
  let seq = 3;
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => {
        ops.push({ op: 'session.update' });
        return { ...session };
      },
    },
    conversationTurn: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => {
        ops.push({ op: 'deleteMany' });
        return { count: 2 };
      },
      count: async () => opts?.executableAfterDelete ?? 1,
      findUnique: async ({ where }: { where: { sessionId_clientTurnId: { clientTurnId: string } } }) => {
        const clientTurnId = where.sessionId_clientTurnId.clientTurnId;
        const row = existing[clientTurnId];
        if (!row) return null;
        return clientTurnId.startsWith('interrupt-') && row.content === undefined
          ? {
              ...row,
              content: JSON.stringify({
                content: 'stop — just rename the one file',
                attachmentIds: [],
              }),
            }
          : row;
      },
      findFirst: async () => ({ seq }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        ops.push({ op: 'create', kind: data.kind, clientTurnId: data.clientTurnId });
        created.push(data);
        const row = { id: `turn-${created.length}`, ...data, seq };
        existing[data.clientTurnId as string] = {
          id: row.id as string,
          seq,
          ...(typeof data.content === 'string' ? { content: data.content } : {}),
        };
        return row;
      },
    },
    attachment: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => (opts?.attachments ?? []).includes(id)).map((id) => ({ id })),
      updateMany: async () => {
        ops.push({ op: 'linkAttachments' });
        return { count: 1 };
      },
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  let queueWakes = 0;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => queueWakes++ } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, ops, created, queueWakes: () => queueWakes };
}

const interruptAndSend = (h: ReturnType<typeof makeService>, body?: Record<string, unknown>) =>
  h.service.interrupt(OWNER_ID, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'stop — just rename the one file',
    ...body,
  });

test('the follow-up is filed as an ordinary message, never a steer', async () => {
  const h = makeService();

  await interruptAndSend(h);

  const message = h.created.find((t) => t.kind === 'message');
  assert.ok(message, 'no follow-up message was filed');
  // A steer is written INTO the running turn. Someone who just pressed stop is asking for
  // the opposite, so the follow-up waits behind that turn's result like any other message.
  assert.equal(h.created.some((t) => t.kind === 'steer'), false);
  assert.equal(message.content, 'stop — just rename the one file');
  assert.equal(message.clientTurnId, CLIENT_TURN_ID);
  assert.equal(message.status, 'PENDING');
});

test('the follow-up is filed after the queue is dropped, and after the interrupt', async () => {
  const h = makeService();

  await interruptAndSend(h);

  const names = h.ops.map((o) => (o.op === 'create' ? `create:${o.kind}` : o.op));
  const dropped = names.indexOf('deleteMany');
  const interrupt = names.indexOf('create:interrupt');
  const followUp = names.indexOf('create:message');
  assert.ok(dropped >= 0 && interrupt >= 0 && followUp >= 0, `missing steps in ${names.join(' → ')}`);
  // Filed after the delete, so the message this request carries is never its own casualty —
  // the bug a client doing interrupt-then-send cannot avoid.
  assert.ok(dropped < followUp, `the follow-up was filed before the queue was dropped: ${names.join(' → ')}`);
  // And after the interrupt, so it takes a later seq and the inbox hands it over second.
  assert.ok(interrupt < followUp, `the follow-up was filed ahead of the interrupt: ${names.join(' → ')}`);
});

test('a retried request re-files neither the interrupt nor the message', async () => {
  const h = makeService({
    existing: { [`interrupt-${CLIENT_TURN_ID}`]: { id: 'turn-int', seq: 4 }, [CLIENT_TURN_ID]: { id: 'turn-msg', seq: 5 } },
  });

  const result = await interruptAndSend(h);

  assert.deepEqual(result, { ok: true, turnId: 'turn-msg', seq: 5 });
  assert.deepEqual(h.ops, [], 'a retry re-ran the operation');
});

test('interrupt follow-up charge and receipt are atomic and retry spends once', async () => {
  const h = makeService();
  let charges = 0;
  const request = () => h.service.interrupt(
    OWNER_ID,
    SESSION_ID,
    { clientTurnId: CLIENT_TURN_ID, content: 'stop — just rename the one file' },
    { participateFollowUpTransaction: async () => { charges++; } },
  );

  await request();
  await request(); // committed response could have been lost; same logical operation retries

  assert.equal(charges, 1);
  assert.equal(h.created.filter((turn) => turn.kind === 'interrupt').length, 1);
  assert.equal(h.created.filter((turn) => turn.kind === 'message').length, 1);
});

for (const boundary of [
  { name: 'terminal', opts: { status: RunStatus.FAILED } },
  { name: 'Trash', opts: { trashed: true } },
] as const) {
  test(`interrupt-and-send replays its committed receipt after the session became ${boundary.name}`, async () => {
    const h = makeService({
      ...boundary.opts,
      existing: {
        [`interrupt-${CLIENT_TURN_ID}`]: { id: 'turn-int', seq: 4 },
        [CLIENT_TURN_ID]: { id: 'turn-msg', seq: 5 },
      },
    });
    let charges = 0;
    const result = await h.service.interrupt(
      OWNER_ID,
      SESSION_ID,
      { clientTurnId: CLIENT_TURN_ID, content: 'stop — just rename the one file' },
      { participateFollowUpTransaction: async () => { charges++; } },
    );

    assert.deepEqual(result, { ok: true, turnId: 'turn-msg', seq: 5 });
    assert.equal(charges, 0);
    assert.deepEqual(h.ops, [], 'receipt replay performed lifecycle writes');
    assert.equal(h.queueWakes(), 0);

    await assert.rejects(
      h.service.interrupt(OWNER_ID, SESSION_ID, {
        clientTurnId: CLIENT_TURN_ID,
        content: 'different payload',
      }),
      /different interrupt follow-up payload/,
      'payload conflict must win over the later lifecycle refusal',
    );
  });
}

test('interrupt idempotency rejects a changed payload before charging or deleting', async () => {
  const h = makeService({
    existing: {
      [`interrupt-${CLIENT_TURN_ID}`]: {
        id: 'turn-int',
        seq: 4,
        content: JSON.stringify({ content: 'original', attachmentIds: [] }),
      },
    },
  });
  let charges = 0;
  await assert.rejects(
    h.service.interrupt(
      OWNER_ID,
      SESSION_ID,
      { clientTurnId: CLIENT_TURN_ID, content: 'changed' },
      { participateFollowUpTransaction: async () => { charges++; } },
    ),
    /different interrupt follow-up payload/,
  );
  assert.equal(charges, 0);
  assert.deepEqual(h.ops, []);
});

test('a retry is recognised by the interrupt, which no later interrupt can delete', async () => {
  // The follow-up itself is gone — a second interrupt dropped it. Keying idempotency on the
  // message would read that as "never happened" and file the whole thing again.
  const h = makeService({ existing: { [`interrupt-${CLIENT_TURN_ID}`]: { id: 'turn-int', seq: 4 } } });

  const result = await interruptAndSend(h);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.ops, []);
});

test('a bad attachment id is rejected before anything is dropped or filed', async () => {
  const h = makeService({ attachments: [] });

  await assert.rejects(
    interruptAndSend(h, { attachmentIds: ['99999999-9999-4999-8999-999999999999'] }),
    /attachments are unknown/,
  );
  assert.deepEqual(h.ops, [], 'a rejected request still touched the queue');
});

test('a follow-up without an idempotency key is refused rather than filed unkeyed', async () => {
  const h = makeService();

  await assert.rejects(
    h.service.interrupt(OWNER_ID, SESSION_ID, { content: 'stop and do this instead' }),
    /clientTurnId is required/,
  );
  assert.deepEqual(h.ops, []);
});

test('the completion-to-next-turn handoff still wins, and takes the follow-up down with it', async () => {
  const h = makeService({ executableAfterDelete: 0 });

  await assert.rejects(interruptAndSend(h), /already starting/);
  // Nothing half-applied: no interrupt, no message. The transaction is the atomicity.
  assert.equal(h.created.length, 0);
});

test('a trashed session can still be stopped, but nothing new queued onto it', async () => {
  const h = makeService({ trashed: true });

  await assert.rejects(interruptAndSend(h), /Trash/);
  assert.deepEqual(h.ops, []);
  // Stopping the work of a session someone has just thrown away is exactly what they want.
  assert.deepEqual(await h.service.interrupt(OWNER_ID, SESSION_ID), { ok: true });
});

test('a plain interrupt is exactly what it always was', async () => {
  const h = makeService();

  assert.deepEqual(await h.service.interrupt(OWNER_ID, SESSION_ID), { ok: true });

  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].kind, 'interrupt');
  assert.equal(h.created[0].content, undefined);
  assert.equal(h.queueWakes(), 0);
});

test('an interrupt-and-send on a parked session queues it for a runner slot', async () => {
  const h = makeService({ status: RunStatus.INTERRUPTED, executableAfterDelete: 0 });

  await interruptAndSend(h);

  // INTERRUPTED holds no slot, so the follow-up has to wake the queue rather than the
  // inbox — the executable-turn guard above applies only to a RUNNING session.
  assert.equal(h.queueWakes(), 1);
});
