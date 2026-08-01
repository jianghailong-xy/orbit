import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

test('the removed system view stays empty for older clients', async () => {
  let sql = '';
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      sql = query.sql;
      return [];
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const sessions = await service.list('00000000-0000-0000-0000-000000000001', {
    view: 'system',
  });

  assert.deepEqual(sessions, []);
  assert.match(sql, /AND \(FALSE\)/);
});

test('canonical lifecycle views query completed_at while legacy names remain aliases', async () => {
  const statements: string[] = [];
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      statements.push(query.sql);
      return [];
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  const ownerId = '00000000-0000-0000-0000-000000000001';

  for (const view of ['open', 'completed', 'trash', 'active', 'archived', 'deleted'] as const) {
    await service.list(ownerId, { view });
  }

  assert.match(statements[0], /COALESCE\(s\.completed_at, s\.archived_at\) IS NULL/);
  assert.match(statements[1], /COALESCE\(s\.completed_at, s\.archived_at\) IS NOT NULL/);
  assert.match(statements[2], /s\.deleted_at IS NOT NULL/);
  assert.equal(statements[3], statements[0]);
  assert.equal(statements[4], statements[1]);
  assert.equal(statements[5], statements[2]);
});
