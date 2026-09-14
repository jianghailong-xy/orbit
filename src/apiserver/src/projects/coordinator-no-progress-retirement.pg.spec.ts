/**
 * 0266 RESOLVES THE COORDINATOR_NO_PROGRESS BLOCKERS THE RETIRED BREAKER LEFT OPEN, AND ONLY THOSE.
 *
 * The coordinator breaker that raised this kind is gone — the fuse counts what the agent spends, and
 * a wake raises nothing — so a row it raised has no condition left that could clear it and no code
 * that resolves it. An open one keeps its project under Needs you · Critical in the project list for
 * good: on 2026-09-13 production held 8, 6 of them on projects already DONE. 0266 resolves them once.
 *
 * WHAT THIS HOLDS THE MIGRATION TO
 * --------------------------------
 * The rows below are seeded on the database run-pg-spec.sh migrated, and then the migration's own
 * file is executed against them, not a transcription of its predicate.
 *
 *   (0) The migration is in the ledger. On a tree without it the pass below is empty, so that tree
 *       goes red on (1), the rows it leaves open, and not only on a missing path.
 *   (1) An open COORDINATOR_NO_PROGRESS blocker, on an OPEN project and on a DONE one, is resolved:
 *       `resolved_by` AUTO, `resolved_at` and `updated_at` the moment of the pass, every other column
 *       as it was.
 *   (2) What it must leave alone, each one resolvable but for the clause it stands against: the same
 *       project's earlier episode of that kind, already resolved by the coordinator, and an open
 *       blocker of another kind on the same project.
 *
 * (2) reads the same pass as (1), so no "exactly as it was" here can pass by the migration having
 * done nothing.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-no-progress-retirement.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the seeded rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PrismaClient, ProjectStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { COORDINATOR_NO_PROGRESS_KIND, noProgressDedupeKey } from './coordinator-convergence';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const UNIT = '0266_coordinator_no_progress_retirement';
const MIGRATION = path.resolve(__dirname, '../../prisma/migrations', UNIT, 'migration.sql');

/** When every seeded row was last written: long before the pass. */
const RAISED_AT = new Date('2026-09-07T08:01:35.576Z');

type Row = Record<string, unknown>;

async function project(db: PrismaClient, ownerId: string, status: ProjectStatus): Promise<string> {
  const id = randomUUID();
  await db.project.create({
    data: { id, ownerId, title: `a ${status} project the breaker once stopped`, goal: 'finish', status },
  });
  return id;
}

/** A blocker as the breaker raised one: the owner's to act on, CRITICAL, about the whole project. */
async function blocker(
  db: PrismaClient,
  projectId: string,
  opts: {
    kind: string;
    dedupeKey: string;
    generation: bigint;
    resolved?: { at: Date; by: 'USER' | 'COORDINATOR' };
  },
): Promise<string> {
  const id = randomUUID();
  await db.projectBlocker.create({
    data: {
      id,
      projectId,
      kind: opts.kind,
      owner: 'USER',
      recovery: 'HUMAN',
      severity: 'CRITICAL',
      requiredAction: 'look at why the project stopped moving',
      nextCheckAt: RAISED_AT,
      subjectType: 'PROJECT',
      subjectId: projectId,
      detail: { seededBy: 'coordinator-no-progress-retirement.pg.spec' },
      dedupeKey: opts.dedupeKey,
      lifecycleGeneration: opts.generation,
      conditionVersion: 'c'.repeat(64),
      firstSeenAt: RAISED_AT,
      lastSeenAt: RAISED_AT,
      resolvedAt: opts.resolved?.at ?? null,
      resolvedBy: opts.resolved?.by ?? null,
      updatedAt: opts.resolved?.at ?? RAISED_AT,
    },
  });
  return id;
}

/** Every column of these blockers, by id, as stored: what "exactly as it was" is measured on. */
async function snapshot(sql: Client, ids: string[]): Promise<Map<string, Row>> {
  const { rows } = await sql.query<{ id: string; row: Row }>(
    `SELECT b."id"::text AS "id", to_jsonb(b) AS "row"
       FROM "project_blocker" b
      WHERE b."id" = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map(({ id, row }) => [id, row]));
}

test('0266 resolves the COORDINATOR_NO_PROGRESS blockers the retired breaker left open, and only those', {
  skip, concurrency: 1, timeout: 120_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `no-progress-${ownerId}@retirement.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const openProject = await project(db, ownerId, ProjectStatus.OPEN);
  const doneProject = await project(db, ownerId, ProjectStatus.DONE);

  // What 0266 is for.
  const openOnOpenProject = await blocker(db, openProject, {
    kind: COORDINATOR_NO_PROGRESS_KIND, dedupeKey: noProgressDedupeKey(openProject), generation: 2n,
  });
  const openOnDoneProject = await blocker(db, doneProject, {
    kind: COORDINATOR_NO_PROGRESS_KIND, dedupeKey: noProgressDedupeKey(doneProject), generation: 1n,
  });

  // What it must leave alone.
  const resolvedEarlier = await blocker(db, openProject, {
    kind: COORDINATOR_NO_PROGRESS_KIND,
    dedupeKey: noProgressDedupeKey(openProject),
    generation: 1n,
    resolved: { at: new Date('2026-09-08T10:00:00.000Z'), by: 'COORDINATOR' },
  });
  const otherKind = await blocker(db, openProject, {
    kind: 'MERGE_CONFLICT', dedupeKey: `MERGE_CONFLICT:PROJECT:${openProject}`, generation: 1n,
  });

  const ids = [openOnOpenProject, openOnDoneProject, resolvedEarlier, otherKind];
  const seeded = await snapshot(sql, ids);
  assert.equal(seeded.size, ids.length, 'every seeded blocker is on record');

  // The migration's own file, executed the way `prisma migrate deploy` runs it.
  const migration = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';
  const before = (await sql.query<{ at: string }>('SELECT localtimestamp::text AS "at"')).rows[0].at;
  if (migration) await sql.query(migration);
  const after = await snapshot(sql, ids);

  await t.test(`(0) ${UNIT} is in the migration ledger`, () => {
    assert.ok(migration, `there is no ${UNIT}/migration.sql, so nothing resolves these blockers`);
  });

  const resolved: Array<[string, string]> = [
    ['an open COORDINATOR_NO_PROGRESS blocker on an OPEN project', openOnOpenProject],
    ['an open COORDINATOR_NO_PROGRESS blocker on a DONE project', openOnDoneProject],
  ];
  for (const [name, id] of resolved) {
    await t.test(`(1) it resolves ${name}, as AUTO, and moves nothing else`, async () => {
      const now = after.get(id)!;
      assert.equal(now.resolved_by, 'AUTO', `${name} is resolved, and the resolution names AUTO`);
      // Compared inside PostgreSQL, on the connection that ran the pass: both sides of every
      // comparison are wall-clock timestamps in that session's time zone.
      const { rows: [moment] } = await sql.query<{ resolvedDuringPass: boolean; sameMoment: boolean }>(
        `SELECT "resolved_at" >= date_trunc('milliseconds', $2::timestamp)
                  AND "resolved_at" <= localtimestamp(3) AS "resolvedDuringPass",
                "updated_at" = "resolved_at" AS "sameMoment"
           FROM "project_blocker"
          WHERE "id" = $1::uuid`,
        [id, before],
      );
      assert.equal(moment.resolvedDuringPass, true, `${name} was resolved at the moment of the pass`);
      assert.equal(moment.sameMoment, true, `${name} records that same moment as its last update`);
      assert.deepEqual(
        now,
        { ...seeded.get(id)!, resolved_at: now.resolved_at, resolved_by: 'AUTO', updated_at: now.updated_at },
        `${name} keeps every other column`,
      );
    });
  }

  const untouched: Array<[string, string, string]> = [
    ['a COORDINATOR_NO_PROGRESS blocker the coordinator already resolved', resolvedEarlier,
      'a resolution is terminal and names who made it'],
    ['an open blocker of another kind on the same project', otherKind,
      'only the retired breaker’s kind lost its condition; every other open blocker still stands for something'],
  ];
  for (const [name, id, why] of untouched) {
    await t.test(`(2) it leaves alone ${name}`, () => {
      assert.deepEqual(after.get(id), seeded.get(id), `${name} is exactly as it was: ${why}`);
    });
  }
});
