import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { SessionsService } from './sessions.service';

const OWNER_ID = 'c111a556-1094-4e98-90d0-f5f7fa74544c';
const FOLDER_ID = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';

/** The SQL the search builds, captured without a database. */
const captureSearch = async (query: string, folderId?: string | null): Promise<Prisma.Sql> => {
  let captured: Prisma.Sql | undefined;
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      captured = sql;
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  await service.search(OWNER_ID, query, 20, folderId);
  assert.ok(captured);
  return captured;
};

test('a search from a folder is narrowed to the sessions filed in it', async () => {
  const sql = await captureSearch('status', FOLDER_ID);
  assert.match(sql.sql, /s\.folder_id = \?::uuid/);
  assert.ok(sql.values.includes(FOLDER_ID));
});

test('recents from a folder are that folder’s', async () => {
  const sql = await captureSearch('', FOLDER_ID);
  assert.match(sql.sql, /s\.folder_id = \?::uuid/);
  assert.ok(sql.values.includes(FOLDER_ID));
});

test('without a folder the search spans every folder, as before', async () => {
  const sql = await captureSearch('status');
  assert.doesNotMatch(sql.sql, /folder_id/);
  const recents = await captureSearch('');
  assert.doesNotMatch(recents.sql, /folder_id/);
});
