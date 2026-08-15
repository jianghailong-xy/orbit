import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListEventsService } from './list-events.service';

const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CONSOLE_SESSION = '5ccdf9b9-6871-49a6-8595-839c6a1f79d2';
const OTHER_SESSION = '9f2a1c44-1111-4bbb-9ccc-0123456789ab';

interface Row {
  id: string;
  kind: string;
  detail: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  deliveredAt: Date | null;
}

const at = (iso: string) => new Date(iso);

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'e1',
    kind: 'quota_hold',
    detail: '12 个就绪任务被配额挡住，最早 2026-08-15T05:00:00.000Z 恢复',
    occurrences: 47,
    firstSeenAt: at('2026-08-15T03:11:00.000Z'),
    lastSeenAt: at('2026-08-15T04:07:00.000Z'),
    deliveredAt: null,
    ...over,
  };
}

/**
 * The stub honours the filters the service actually passes. A `findMany` that ignores its `where`
 * makes every scoping test pass with the scoping deleted — which is how three separate defects
 * survived their own tests earlier in this work.
 */
function makeTx(opts: { consoleOf?: string[]; rows?: Row[] } = {}) {
  const rows = opts.rows ?? [row()];
  const updates: Array<{ ids: string[]; deliveredAt: Date }> = [];
  const tx = {
    taskList: {
      // An absent filter must mean *every* row, the way Prisma behaves — not "no rows". Modelled
      // the other way, deleting the scoping makes the console test fail rather than the scoping
      // test, and the leak the scoping exists to prevent goes untested.
      findMany: async ({ where }: any) =>
        where?.ownerSessionId === undefined ||
        (opts.consoleOf ?? [CONSOLE_SESSION]).includes(where.ownerSessionId)
          ? [{ id: LIST_ID, title: 'FineWeb CC-MAIN-2025-26' }]
          : [],
    },
    taskListEvent: {
      findMany: async ({ where }: any) => (where.listId === LIST_ID ? rows : []),
      updateMany: async ({ where, data }: any) => {
        updates.push({ ids: where.id.in, deliveredAt: data.deliveredAt });
        for (const r of rows) if (where.id.in.includes(r.id)) r.deliveredAt = data.deliveredAt;
        return { count: where.id.in.length };
      },
    },
  } as any;
  return { tx, updates, rows };
}

const svc = () => new ListEventsService({} as any);

test('a list console gets the conditions appended to its next message', async () => {
  const { tx } = makeTx();

  const out = await svc().appendFor(tx, CONSOLE_SESSION, '这个列表现在什么情况？');

  assert.match(out!, /^这个列表现在什么情况？/);
  assert.match(out!, /<list-conditions list="6ba7b810-9dad-11d1-80b4-00c04fd430c8"/);
  assert.match(out!, /配额挡住派发/);
  assert.match(out!, /累计 47 次/);
});

test('an ordinary session is left completely alone', async () => {
  // Nearly every delivery in the deployment is this one. A condition board leaking into an
  // unrelated run would put another campaign's status into its prompt.
  const { tx } = makeTx();

  const out = await svc().appendFor(tx, OTHER_SESSION, '继续');

  assert.equal(out, '继续');
});

test('a condition already reported and not seen since is not repeated', async () => {
  // The one that matters: the sweep re-upserts every 60s, so "still true" must not mean
  // "announce again". Delivered after lastSeenAt == nothing new happened.
  const { tx } = makeTx({
    rows: [
      row({
        lastSeenAt: at('2026-08-15T04:07:00.000Z'),
        deliveredAt: at('2026-08-15T04:09:00.000Z'),
      }),
    ],
  });

  const out = await svc().appendFor(tx, CONSOLE_SESSION, '继续');

  assert.equal(out, '继续');
});

test('a condition seen again since it was reported is reported again', async () => {
  const { tx } = makeTx({
    rows: [
      row({
        deliveredAt: at('2026-08-15T04:00:00.000Z'),
        lastSeenAt: at('2026-08-15T04:30:00.000Z'),
      }),
    ],
  });

  const out = await svc().appendFor(tx, CONSOLE_SESSION, '继续');

  assert.match(out!, /配额挡住派发/);
});

test('reporting stamps exactly the rows it reported', async () => {
  // The stamp and the read share the delivery transaction; stamping a row that was not included
  // would silence a condition nobody was ever told about.
  const stale = row({ id: 'fresh' });
  const quiet = row({
    id: 'quiet',
    kind: 'disk_hold',
    deliveredAt: at('2026-08-15T09:00:00.000Z'),
    lastSeenAt: at('2026-08-15T04:00:00.000Z'),
  });
  const { tx, updates } = makeTx({ rows: [stale, quiet] });

  await svc().appendFor(tx, CONSOLE_SESSION, '继续');

  assert.deepEqual(updates.length, 1);
  assert.deepEqual(updates[0].ids, ['fresh']);
});

test('a board with nothing due leaves the message byte-identical', async () => {
  const { tx } = makeTx({ rows: [] });

  assert.equal(await svc().appendFor(tx, CONSOLE_SESSION, '继续'), '继续');
});

test('a failure to read the board costs the note, not the turn', async () => {
  // This rides on the delivery of a real message. A note for a human must never be able to stop
  // one from being handed out.
  const tx = {
    taskList: {
      findMany: async () => {
        throw new Error('deadlock detected');
      },
    },
  } as any;

  assert.equal(await svc().appendFor(tx, CONSOLE_SESSION, '继续'), '继续');
});
