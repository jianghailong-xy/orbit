import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerApiController } from './runner-api.controller';

/**
 * POST /runner/sessions/:id/naming — the title the engine running a session gave it, when its claim
 * asked for one. The runner that holds the session reports it against the title the claim carried;
 * it lands only while the session still reads exactly that, so a rename made since stands.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

function fixture(row: { title: string; titleManagedByProject?: boolean; assignedRunnerId?: string }) {
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const published: string[] = [];
  const prisma = {
    session: {
      findUnique: async () => ({ id: SESSION_ID, assignedRunnerId: row.assignedRunnerId ?? RUNNER_ID }),
      // The compare-and-set as Postgres would answer it against `row`.
      updateMany: async (args: { where: { title: string; titleManagedByProject: boolean }; data: { title: string } }) => {
        writes.push(args);
        if (args.where.title !== row.title || (row.titleManagedByProject ?? false) !== args.where.titleManagedByProject) {
          return { count: 0 };
        }
        row.title = args.data.title;
        return { count: 1 };
      },
    },
  };
  const realtime = { publishSessionUpdated: (id: string) => published.push(id) };
  const sessions = new SessionsService(prisma as never, {} as never, realtime as never);
  const controller = new RunnerApiController(
    prisma as never, {} as never, realtime as never, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, sessions,
  );
  const name = (replaces: string, title: string, runnerId = RUNNER_ID) =>
    controller.sessionNaming({ id: runnerId }, SESSION_ID, { replaces, title });
  return { row, writes, published, name };
}

test('the title lands while the session still carries the one its claim did', async () => {
  const f = fixture({ title: 'Fix the flaky login timeout on Safari' });
  assert.deepEqual(await f.name('Fix the flaky login timeout on Safari', 'Safari login timeout'), { applied: true });
  assert.deepEqual(f.writes, [
    {
      where: { id: SESSION_ID, title: 'Fix the flaky login timeout on Safari', titleManagedByProject: false },
      data: { title: 'Safari login timeout' },
    },
  ]);
  assert.equal(f.row.title, 'Safari login timeout');
  assert.deepEqual(f.published, [SESSION_ID]);
  // The same report again — a retry after a lost reply — matches nothing.
  assert.deepEqual(await f.name('Fix the flaky login timeout on Safari', 'Safari login timeout'), { applied: false });
  assert.deepEqual(f.published, [SESSION_ID]);
});

test('a rename made since, or a project that owns the title, stands', async () => {
  const renamed = fixture({ title: 'My own name' });
  assert.deepEqual(await renamed.name('Fix the flaky login timeout on Safari', 'Safari login timeout'), { applied: false });
  assert.equal(renamed.row.title, 'My own name');
  assert.deepEqual(renamed.published, []);

  const managed = fixture({ title: 'Fix the flaky login timeout on Safari', titleManagedByProject: true });
  assert.deepEqual(await managed.name('Fix the flaky login timeout on Safari', 'Safari login timeout'), { applied: false });
  assert.deepEqual(managed.published, []);
});

test("an engine's title is kept to one clean line, and no title is no write", async () => {
  const f = fixture({ title: 'fallback' });
  assert.deepEqual(await f.name('fallback', '  Safari\n login\u0000 timeout  '), { applied: true });
  assert.equal(f.row.title, 'Safari login timeout');

  const g = fixture({ title: 'fallback' });
  assert.deepEqual(await g.name('fallback', '   '), { applied: false });
  assert.deepEqual(await g.name('fallback', 'fallback'), { applied: false });
  assert.deepEqual(g.writes, []);
});

test("another runner's session is refused before anything is written", async () => {
  const f = fixture({ title: 'fallback', assignedRunnerId: '33333333-3333-4333-8333-333333333333' });
  await assert.rejects(f.name('fallback', 'Stolen title'), ForbiddenException);
  assert.deepEqual(f.writes, []);
  assert.equal(f.row.title, 'fallback');
});
