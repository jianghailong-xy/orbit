import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * 0369 writes every live workspace the place the runner-grouped sidebar gave it, so the clients can
 * read `workspace.position` alone without anyone's list (or ⌘1‒9) moving. The template database
 * applied it to empty tables; this seeds the shapes the old order had to reconcile and runs the
 * shipped file again — it reads only the current rows, so a second run is a run like the first.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const MIGRATION = readFileSync(
  path.join(__dirname, '../../prisma/migrations/0369_workspace_position_backfill/migration.sql'),
  'utf8',
);

test('0369 numbers each owner’s workspaces in the order the sidebar drew them', { skip: !PG_URL, timeout: 60_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(PG_URL) });
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const owners = [ownerId, otherId];
  t.after(async () => {
    try {
      await prisma.workspace.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.runner.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.user.deleteMany({ where: { id: { in: owners } } });
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });

  const applied = await sql.query(
    `SELECT finished_at IS NOT NULL AS finished FROM _prisma_migrations
      WHERE migration_name = '0369_workspace_position_backfill' AND rolled_back_at IS NULL`,
  );
  assert.deepEqual(applied.rows, [{ finished: true }], 'the template database applied 0369');

  for (const id of owners) {
    await prisma.user.create({
      data: { id, email: `position-backfill-${id}@example.invalid`, name: 'position backfill', passwordHash: 'h' },
    });
  }
  const at = (day: number) => new Date(Date.UTC(2026, 0, day));
  const runner = (name: string, owner: string, position: number | null, enrolledDay: number) =>
    prisma.runner.create({ data: { name, ownerId: owner, tokenHash: `token-${randomUUID()}`, position, enrolledAt: at(enrolledDay) } });
  // GET /runners order: the two arranged ones, then the never-arranged by enrolment.
  const wikova = await runner('wikova', ownerId, 0, 5);
  const workstation = await runner('workstation', ownerId, 1, 4);
  const mini = await runner('longdeMac-mini.local', ownerId, null, 1);
  const hpc = await runner('HPC', ownerId, null, 2);
  // A runner the owner's own list does not carry.
  const foreign = await runner('foreign', otherId, 0, 1);

  const workspace = (
    name: string,
    owner: string,
    runnerId: string | null,
    position: number | null,
    createdDay: number,
    deletedAt: Date | null = null,
  ) => prisma.workspace.create({ data: { name, ownerId: owner, runnerId, position, createdAt: at(createdDay), deletedAt } });
  await workspace('orbit', ownerId, wikova.id, null, 1);
  await workspace('wikova-develop', ownerId, wikova.id, null, 2);
  // A place left from the old drag: it leads its runner's group, and only that group.
  await workspace('wikova-prod', ownerId, wikova.id, 5, 3);
  await workspace('wikova-data', ownerId, workstation.id, 2, 4);
  await workspace('lfs', ownerId, workstation.id, null, 5);
  await workspace('orbit-mini', ownerId, mini.id, null, 6);
  await workspace('HPC', ownerId, hpc.id, 1, 7);
  await workspace('orbit-develop', ownerId, hpc.id, null, 8);
  // No runner: last, whatever its old place said.
  await workspace('shared', ownerId, null, 0, 9);
  await workspace('stale', ownerId, foreign.id, null, 10);
  await workspace('gone', ownerId, wikova.id, null, 11, at(12));
  await workspace('theirs', otherId, foreign.id, 7, 1);

  const positions = async () => {
    const rows = await prisma.workspace.findMany({
      where: { ownerId: { in: owners } },
      select: { name: true, position: true },
    });
    return Object.fromEntries(rows.map((row) => [row.name, row.position]));
  };
  const expected = {
    'wikova-prod': 0,
    orbit: 1,
    'wikova-develop': 2,
    'wikova-data': 3,
    lfs: 4,
    'orbit-mini': 5,
    HPC: 6,
    'orbit-develop': 7,
    stale: 8,
    shared: 9,
    gone: null,
    theirs: 0,
  };

  await sql.query(MIGRATION);
  assert.deepEqual(await positions(), expected);

  // GET /workspaces' own ORDER BY now returns that order with nothing else to apply.
  const listed = await prisma.workspace.findMany({
    where: { ownerId, deletedAt: null },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    select: { name: true },
  });
  assert.deepEqual(
    listed.map((row) => row.name),
    ['wikova-prod', 'orbit', 'wikova-develop', 'wikova-data', 'lfs', 'orbit-mini', 'HPC', 'orbit-develop', 'stale', 'shared'],
  );

  // On its own output the order it reads is the order it writes.
  await sql.query(MIGRATION);
  assert.deepEqual(await positions(), expected);
});
