import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';
const SESSION_ID = '915d27d1-b92f-4cc6-819f-174ff5be13a9';
const PUBLIC_ID = '4QISUlGbd1LAaxJywzvT7x';

/** Capture the generated Prisma SQL without needing a database. The exact-id and prefix branches
 *  are deliberately part of the production query (not a second unscoped lookup), so inspecting
 *  its bound values pins both ID decoding and tenant scoping. */
const captureSearch = async (query: string): Promise<Prisma.Sql> => {
  let captured: Prisma.Sql | undefined;
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured = sql;
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  await service.search(OWNER_ID, query, 20);
  assert.ok(captured);
  return captured;
};

test('a Base62 public id is decoded and bound into the owner-scoped exact-id branch', async () => {
  const sql = await captureSearch(PUBLIC_ID);
  assert.match(sql.sql, /s\.owner_id = .*::uuid/);
  assert.match(sql.sql, /s\.id = .*::uuid/);
  assert.ok(sql.values.includes(OWNER_ID));
  assert.ok(sql.values.includes(SESSION_ID));
});

test('an abbreviated UUID is bound into the owner-scoped prefix branch', async () => {
  const sql = await captureSearch('915D27D1');
  assert.match(sql.sql, /replace\(s\.id::text, '-', ''\) LIKE/);
  assert.ok(sql.values.includes(OWNER_ID));
  assert.ok(sql.values.includes('915d27d1%'));
});
