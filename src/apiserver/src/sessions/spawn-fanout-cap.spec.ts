import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

const OWNER = 'owner-1';
const PARENT = 'parent-1';

type Child = { status: RunStatus; deletedAt?: Date | null };

/**
 * SessionsService wired to a fake Prisma whose session.count applies the `where` the guard
 * builds against an in-memory child list — so these tests exercise the real filter, not a
 * recorded query shape. Everything spawnFromSession touches after the guard is stubbed out.
 */
function serviceWith(children: Child[]) {
  const prisma = {
    session: {
      // The parent lookup, then spawnDepth's walk (parent is a root: no parent of its own).
      findFirst: async () => ({ id: PARENT, batchId: null, agent: { enableOrchestration: true } }),
      findUnique: async () => ({ parentSessionId: null }),
      count: async ({ where }: any) => {
        assert.equal(where.ownerId, OWNER);
        assert.equal(where.parentSessionId, PARENT);
        return children.filter(
          (c) =>
            (where.deletedAt !== null || !c.deletedAt) &&
            (!where.status?.in || where.status.in.includes(c.status)),
        ).length;
      },
    },
  };
  const svc = new SessionsService(prisma as any, {} as any, {} as any);
  (svc as any).resolveDefaultEffort = async () => 'high';
  (svc as any).create = async () => ({
    id: 'child-1',
    status: RunStatus.PENDING,
    title: 'child',
    agentId: null,
    provider: 'claude',
  });
  return svc;
}

function spawn(svc: SessionsService) {
  return svc.spawnFromSession(OWNER, PARENT, { prompt: 'do a thing' });
}

const repeat = (n: number, status: RunStatus): Child[] => Array.from({ length: n }, () => ({ status }));

test('rejects once the cap of concurrent children is in flight', async () => {
  const svc = serviceWith(repeat(10, RunStatus.RUNNING));
  await assert.rejects(spawn(svc), /child-session limit \(10 concurrent\) reached/);
});

test('queued children count toward the cap', async () => {
  const svc = serviceWith(repeat(10, RunStatus.PENDING));
  await assert.rejects(spawn(svc), /child-session limit/);
});

test('finished children release their slot', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.PARKED]) {
    const svc = serviceWith(repeat(10, status));
    const created = await spawn(svc);
    assert.equal(created.id, 'child-1', `${status} children should not occupy the fan-out budget`);
  }
});

test('trashed children release their slot even while still marked running', async () => {
  const svc = serviceWith(repeat(10, RunStatus.RUNNING).map((c) => ({ ...c, deletedAt: new Date() })));
  const created = await spawn(svc);
  assert.equal(created.id, 'child-1');
});

test('a mix below the cap is allowed', async () => {
  const svc = serviceWith([...repeat(9, RunStatus.RUNNING), ...repeat(20, RunStatus.SUCCEEDED)]);
  const created = await spawn(svc);
  assert.equal(created.id, 'child-1');
});
