import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * The shape of the two rollup queries, asserted against the SQL they generate.
 *
 * `session-project-rollup.pg.spec.ts` proves what these statements ANSWER, but it needs a
 * disposable PostgreSQL and skips without one — so it is not what runs on every `npm test`. These
 * are the properties whose loss is silent rather than loud: an inner join still returns rows, a
 * reordered CASE still returns a role, and a tally that counts a blocked session twice still
 * returns a number. Same technique as the search specs above: the generated SQL, not a database.
 */

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';

/** Collapsed, so the assertions don't depend on how the template wraps. */
const flat = (sql: Prisma.Sql): string => sql.sql.replace(/\s+/g, ' ');

const capture = async (call: (service: SessionsService) => Promise<unknown>): Promise<string> => {
  let captured: Prisma.Sql | undefined;
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured = sql;
      return [];
    },
  };
  await call(new SessionsService(prisma as never, {} as never, {} as never));
  assert.ok(captured, 'no statement was issued');
  return flat(captured);
};

const listSql = () => capture((service) => service.list(OWNER_ID, { view: 'open' }));
const countsSql = () => capture((service) => service.projectSessionCounts(OWNER_ID));

test('a session that belongs to no project still appears on the list', async () => {
  const sql = await listSql();
  // The project joins are the two ways a session has a project — through its task, and by being
  // the project's coordinator. Both MUST be LEFT: an inner join here deletes every project-less
  // conversation from the user's own session list, which is most of it.
  assert.match(sql, /LEFT JOIN project p ON p\.id = t\.project_id/);
  assert.match(sql, /LEFT JOIN project cp ON cp\.coordinator_session_id = s\.id/);
});

test('the role branches stay in the order that decides identity', async () => {
  const sql = await listSql();
  // Coordinating is what a session IS, so it is tested before anything about its task: a
  // coordinator holding a verification task is still the coordinator. Reordering these compiles,
  // runs, and quietly relabels rows.
  assert.match(
    sql,
    /CASE WHEN cp\.id IS NOT NULL THEN 'coordinator' WHEN t\.verifies_task_id IS NOT NULL THEN 'verification' WHEN s\.dispatch_origin = 'PROJECT_COORDINATOR' THEN 'execution' ELSE 'user' END AS "role"/,
  );
});

test('the per-project tallies count each session once, and only where it is', async () => {
  const sql = await countsSql();
  // Running is the generating rows that are NOT waiting on the user. Drop the NOT and a project
  // with one blocked and one working session reads "1 needs you · 2 running" out of two.
  assert.match(sql, /AND NOT EXISTS \( SELECT 1 FROM approval ap/);
  // A trashed session is in no list, so it is in no bucket — `total` included.
  assert.match(sql, /AND s\.deleted_at IS NULL/);
  // Rows with no project are not a project: without this they group into one nameless bucket.
  assert.match(sql, /AND COALESCE\(cp\.id, t\.project_id\) IS NOT NULL GROUP BY 1/);
});

test('every row carries the waiting timestamp, including when nothing is generating', async () => {
  // The early return for "no session is generating" is a second place the answer is assembled,
  // and the one where a new field is forgotten: it used to be the only path that named
  // `pendingApprovals` on its own.
  const prisma = {
    $queryRaw: async () => [
      { id: 'a', status: 'SUCCEEDED', title: 't', tags: [], engineTurnActive: false },
    ],
    approval: {
      groupBy: async () => {
        throw new Error('a settled session cannot be holding a live approval');
      },
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  const [row] = (await service.list(OWNER_ID, { view: 'open' })) as any[];
  assert.equal(row.pendingApprovals, 0);
  assert.equal(row.oldestPendingApprovalAt, null);
});
