import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { COORDINATOR_PAUSE_SELECT } from './coordinator-evidence-queue';
import { runItemFallbackCopy, runItemHold, type RunItemFacts } from './run-item-hold';

const url = process.env.COORDINATOR_PG_URL;

for (const kind of ['CONFIRMATION', 'QUESTION', 'NOTIFY'] as const) {
  test(`${kind}: F2 live hold, each fallback and F4 frozen deadline over committed rows`, { skip: !url }, async () => {
    assertCoordinatorPgUrlIsIsolated(url);
    const sql = new Client({ connectionString: url });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db = prismaClientFor(url);
    const ownerId = randomUUID();
    try {
      await db.user.create({ data: { id: ownerId, email: `${ownerId}@hold.invalid`, name: 'Hold spec', passwordHash: 'x' } });
      const coordinator = await db.session.create({ data: {
        ownerId, creatorId: ownerId, title: 'Coordinator', prompt: 'Coordinate', provider: 'codex', status: 'AWAITING_INPUT',
      } });
      const project = await db.project.create({ data: {
        ownerId, title: 'Hold project', goal: 'Bounded wait', coordinatorEnabled: true,
        coordinatorSessionId: coordinator.id, exceptionEscalationSeconds: 300,
      } });
      const task = await db.task.create({ data: {
        ownerId, creatorId: ownerId, creatorType: 'USER', title: 'Run item', projectId: project.id,
        completionCriterion: 'OWNER_CONFIRMED',
      } });
      const run = await db.session.create({ data: {
        ownerId, creatorId: ownerId, taskId: task.id, title: 'Run', prompt: 'Work', provider: 'codex',
      } });
      // Read in a separate transaction after fixture commits. Each path freezes this deadline
      // when its own item is created; F owns the pure decision, not those path-specific writes.
      const dueAt = new Date(run.createdAt.getTime() + project.exceptionEscalationSeconds * 1000);
      async function facts(taskId = task.id): Promise<RunItemFacts> {
        const row = await db.task.findUniqueOrThrow({ where: { id: taskId }, include: {
          project: { include: { coordinatorSession: { select: { id: true, ...COORDINATOR_PAUSE_SELECT } } } },
        } });
        return {
          kind, project: row.project ? { automatic: true, coordinatorEnabled: row.project.coordinatorEnabled } : null,
          coordinatorSessionId: row.project?.coordinatorSessionId ?? null,
          coordinatorSession: row.project?.coordinatorSession ?? null,
          answered: false, delivery: 'PENDING', deliveryRefusal: null, deliveredTurn: null,
          stoppedWithoutAnswer: false, dueAt,
        };
      }
      const before = new Date(dueAt.getTime() - 1);
      const initial = await facts();
      assert.deepEqual(runItemHold(initial, before), { place: 'HELD', coordinatorSessionId: coordinator.id, dueAt });
      const expectFallback = (input: RunItemFacts, reason: 'NO_COORDINATOR' | 'REVIEWER_ENDED' | 'TIMED_OUT') => {
        const hold = runItemHold(input, reason === 'TIMED_OUT' ? dueAt : before);
        assert.deepEqual(hold, { place: 'FALLBACK', reason });
        assert.equal(runItemFallbackCopy(reason, '5 minutes').label, 'Not reviewed by the coordinator');
      };
      expectFallback(initial, 'TIMED_OUT');
      await db.project.update({ where: { id: project.id }, data: { exceptionEscalationSeconds: 600 } });
      expectFallback(await facts(), 'TIMED_OUT');
      await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: null } });
      expectFallback(await facts(), 'NO_COORDINATOR');
      await db.project.update({ where: { id: project.id }, data: { coordinatorSessionId: coordinator.id } });
      await db.session.update({ where: { id: coordinator.id }, data: { completedAt: new Date() } });
      expectFallback(await facts(), 'REVIEWER_ENDED');
      assert.deepEqual(runItemHold({ ...await facts(), answered: true }, dueAt), { place: 'ANSWERED' });
      // Non-Automatic at creation is outside routing, not an unreviewed fallback.
      await db.project.update({ where: { id: project.id }, data: { coordinatorEnabled: false } });
      const manual = await facts();
      assert.equal(runItemHold({ ...manual, project: { automatic: false, coordinatorEnabled: false } }, before), null);
      const standalone = await db.task.create({ data: {
        ownerId, creatorId: ownerId, creatorType: 'USER', title: 'Outside project', completionCriterion: 'OWNER_CONFIRMED',
      } });
      assert.equal(runItemHold(await facts(standalone.id), before), null);
    } finally {
      await db.session.deleteMany({ where: { ownerId } });
      await db.task.deleteMany({ where: { ownerId } });
      await db.project.deleteMany({ where: { ownerId } });
      await db.user.deleteMany({ where: { id: ownerId } });
      await db.$disconnect();
      await sql.end();
    }
  });
}
