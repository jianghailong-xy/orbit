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

test('workspace scope, tag filter and page size narrow the query, and stay off it when unasked', async () => {
  const statements: string[] = [];
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      statements.push(query.sql);
      return [];
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);
  const ownerId = '00000000-0000-0000-0000-000000000001';

  await service.list(ownerId, {
    workspaceId: '00000000-0000-0000-0000-000000000002',
    tagId: '00000000-0000-0000-0000-000000000003',
    limit: 40,
  });
  // A client that asks for none of them (every native client) still gets the whole list.
  await service.list(ownerId, {});

  assert.match(statements[0], /AND s\.workspace_id = \?::uuid/);
  assert.match(statements[0], /stl\.tag_id = \?::uuid/);
  assert.match(statements[0], /LIMIT \?::int/);
  assert.doesNotMatch(statements[1], /AND s\.workspace_id/);
  // (the per-row tags aggregate mentions stl.tag_id too, hence matching on the filter's own form)
  assert.doesNotMatch(statements[1], /stl\.tag_id = \?::uuid/);
  assert.doesNotMatch(statements[1], /LIMIT/);
});
