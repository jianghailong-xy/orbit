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
