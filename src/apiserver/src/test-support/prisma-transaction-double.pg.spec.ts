/**
 * Whether a transaction double answers the way the real client answers.
 *
 * Types settle presence: a member the double stopped supplying is now a compile error. They settle
 * nothing about behaviour, and behaviour is where the more dangerous failure lives. A missing
 * method is loud — `X is not a function`, in the open. A double that quietly ignores `where`, or
 * reports a different `count`, or drops `take`, agrees with every assertion in the suite and lets
 * the build stay green while the predicate under test was never actually applied.
 *
 * So the three delegate methods whose answers decide something are run twice here, against a real
 * PostgreSQL and against the double, on identical input, and required to agree:
 *
 *   - `task.findMany` with a `where` predicate — the aggregation closure's scope read;
 *   - `task.findMany` with `orderBy` and `take` — the page bound the truncation verdict rests on;
 *   - `task.updateMany` — whose `count` is the whole of the compare-and-set's answer.
 *
 * And because a conformance harness that agreed with everything would satisfy all three, the last
 * test hands it a double that ignores `where` and requires it to say so.
 *
 * Destructive: it truncates, and refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { TransactionSurface } from '../common/prisma-transaction-surface';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { transactionDouble } from './prisma-transaction-double';

const URL = process.env.COORDINATOR_PG_URL;

/** Exactly the members compared below, named through the same helper production narrows with. */
type TaskSurface = TransactionSurface<{ task: ['findMany', 'updateMany'] }>;

interface TaskRow {
  id: string;
  title: string;
  status: string;
  ownerId: string;
  parentTaskId: string | null;
}

/**
 * A double that means to be faithful: it applies `where`, `orderBy` and `take` itself.
 *
 * This is the double the first three tests hold to the real client's answers. It is deliberately
 * an ordinary hand-written one — the point is not that some clever double is correct, it is that
 * an ordinary one can be checked.
 */
function faithfulTaskDouble(rows: readonly TaskRow[], options: { ignoreWhere?: boolean } = {}) {
  const table = rows.map((row) => ({ ...row }));
  const matches = (row: TaskRow, where: Record<string, any> | undefined): boolean => {
    if (!where || options.ignoreWhere) return true;
    if (where.ownerId != null && row.ownerId !== where.ownerId) return false;
    if (where.status != null && row.status !== where.status) return false;
    if (where.parentTaskId !== undefined && row.parentTaskId !== where.parentTaskId) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    return true;
  };
  return transactionDouble<TaskSurface>({
    task: {
      findMany: async (args) => {
        const query = args as Record<string, any> | undefined;
        let found = table.filter((row) => matches(row, query?.where));
        if (query?.orderBy?.id === 'asc') found = [...found].sort((a, b) => a.id.localeCompare(b.id));
        if (typeof query?.take === 'number') found = found.slice(0, query.take);
        return found.map((row) => ({ id: row.id, status: row.status, parentTaskId: row.parentTaskId }));
      },
      updateMany: async (args) => {
        const query = args as Record<string, any>;
        let count = 0;
        for (const row of table) {
          if (!matches(row, query?.where)) continue;
          if (query.data?.status != null) row.status = query.data.status;
          count += 1;
        }
        return { count };
      },
    },
  });
}

/** One comparable call, expressed once and run against whichever surface it is handed. */
interface ConformanceCase {
  name: string;
  run(surface: TaskSurface): Promise<unknown>;
}

/** Members whose double answer differs from the real client's, each with the reason it differs. */
type DeclaredDivergence = Record<string, string>;

/**
 * Run every case twice and report which ones disagreed.
 *
 * Returning the disagreements rather than asserting inside lets the negative control below assert
 * that a disagreement IS reported — a harness that silently passed everything would otherwise be
 * indistinguishable from a faithful double.
 */
async function compareSurfaces(
  real: TaskSurface,
  double: TaskSurface,
  cases: readonly ConformanceCase[],
): Promise<string[]> {
  const divergences: string[] = [];
  for (const item of cases) {
    const expected = await item.run(real);
    const actual = await item.run(double);
    try {
      assert.deepEqual(actual, expected);
    } catch {
      divergences.push(`${item.name}: double answered ${JSON.stringify(actual)}, real client answered ${JSON.stringify(expected)}`);
    }
  }
  return divergences;
}

const suite = URL ? test : test.skip;

suite('transaction doubles answer as the real client does', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db: PrismaClient = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  await client.query('TRUNCATE "task", "user" RESTART IDENTITY CASCADE');
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `conformance-${ownerId}@pcc25c.invalid`, name: 'conformance', passwordHash: 'x' },
  });
  await db.user.create({
    data: { id: otherOwnerId, email: `other-${otherOwnerId}@pcc25c.invalid`, name: 'other', passwordHash: 'x' },
  });

  const parentId = '00000000-0000-7000-8000-0000000000a0';
  const rows: TaskRow[] = [
    { id: '00000000-0000-7000-8000-0000000000a0', title: 'parent', status: 'OPEN', ownerId, parentTaskId: null },
    { id: '00000000-0000-7000-8000-0000000000a1', title: 'child-open', status: 'OPEN', ownerId, parentTaskId: parentId },
    { id: '00000000-0000-7000-8000-0000000000a2', title: 'child-done', status: 'DONE', ownerId, parentTaskId: parentId },
    { id: '00000000-0000-7000-8000-0000000000a3', title: 'other-owner', status: 'OPEN', ownerId: otherOwnerId, parentTaskId: null },
  ];
  for (const row of rows) {
    await db.task.create({
      data: {
        id: row.id,
        title: row.title,
        status: row.status as never,
        ownerId: row.ownerId,
        creatorType: 'USER',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        creatorId: row.ownerId,
        parentTaskId: row.parentTaskId,
      },
    });
  }

  const real = db as unknown as TaskSurface;
  const select = { id: true, status: true, parentTaskId: true } satisfies Prisma.TaskSelect;

  const readCases: ConformanceCase[] = [
    {
      name: 'task.findMany applies where',
      run: (surface) => surface.task.findMany({ where: { ownerId, status: 'OPEN' }, select, orderBy: { id: 'asc' } }) as Promise<unknown>,
    },
    {
      name: 'task.findMany applies an id set',
      run: (surface) => surface.task.findMany({
        where: { ownerId, id: { in: [rows[1].id, rows[2].id] } }, select, orderBy: { id: 'asc' },
      }) as Promise<unknown>,
    },
    {
      name: 'task.findMany applies orderBy and take',
      run: (surface) => surface.task.findMany({ where: { ownerId }, select, orderBy: { id: 'asc' }, take: 2 }) as Promise<unknown>,
    },
  ];

  const declared: DeclaredDivergence = {};

  await t.test('the two reads and the write agree with the real client on identical input', async () => {
    const divergences = await compareSurfaces(real, faithfulTaskDouble(rows), readCases);
    assert.deepEqual(
      divergences.filter((entry) => !(entry.split(':')[0] in declared)),
      [],
      `undeclared divergence from real Prisma: ${divergences.join('; ')}`,
    );
  });

  await t.test('updateMany reports the same count the real client reports', async () => {
    const where = { ownerId, parentTaskId: parentId, status: 'OPEN' } as never;
    const data = { status: 'CANCELLED' } as never;
    const doubleResult = await faithfulTaskDouble(rows).task.updateMany({ where, data });
    const realResult = await real.task.updateMany({ where, data });
    assert.deepEqual(doubleResult, realResult);
    assert.equal(realResult.count, 1, 'the fixture must make the count decide something');
    // Put the row back so the reads above stay reproducible for a re-run against the same database.
    await real.task.updateMany({ where: { id: rows[1].id } as never, data: { status: 'OPEN' } as never });
  });

  await t.test('a double that ignores where is caught, not silently believed', async () => {
    const divergences = await compareSurfaces(real, faithfulTaskDouble(rows, { ignoreWhere: true }), readCases);
    assert.ok(
      divergences.length > 0,
      'a where-ignoring double agreed with the real client, so this harness proves nothing',
    );
    assert.match(divergences.join(' '), /task\.findMany applies where/);
    // The declaration mechanism is the only sanctioned way past this, and it must name the member.
    assert.deepEqual(Object.keys(declared), [], 'no divergence is currently declared for this double');
  });
});
