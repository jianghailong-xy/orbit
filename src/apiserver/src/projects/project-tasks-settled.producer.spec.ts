import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';

const PROJECT = randomUUID();

function producerFixture(
  statuses: string[],
  coordinatorEnabled = true,
) {
  const order: string[] = [];
  const facts: Array<{ event: string; projectId: string; detail?: unknown }> = [];
  const prisma = {
    task: {
      findMany: async () => {
        order.push('tasks-read');
        return statuses.map((status, index) => ({ id: randomUUID(), status }));
      },
    },
    project: {
      findUnique: async () => {
        order.push('authorization-read');
        return { coordinatorEnabled };
      },
    },
  };
  const judgments = {
    wake: async (fact: (typeof facts)[number], authorize: (
      fact: (typeof facts)[number],
      claim: { wakeId: string; idempotencyKey: string },
    ) => Promise<{
      allowed: boolean;
      refusalCode?: string;
    }>) => {
      order.push('wake-claimed');
      facts.push(fact);
      const decision = await authorize(fact, { wakeId: randomUUID(), idempotencyKey: 'key' });
      order.push('authorized');
      return decision.allowed
        ? { outcome: 'OPENED', wakeId: randomUUID(), idempotencyKey: 'key', sessionId: randomUUID() }
        : {
            outcome: 'REFUSED', wakeId: randomUUID(), idempotencyKey: 'key',
            refusalCode: decision.refusalCode!,
          };
    },
  };
  const convergence = {
    authorizeWake: async () => {
      order.push('convergence');
      return { allowed: true as const };
    },
  };
  return {
    producer: new ProjectTasksSettledProducer(
      prisma as never,
      judgments as never,
      convergence as never,
    ),
    facts,
    order,
  };
}

test('an unfinished or empty task set emits no PROJECT_TASKS_SETTLED wake', async () => {
  for (const statuses of [[], ['DONE', 'OPEN']]) {
    const fixture = producerFixture(statuses);
    assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
      { projectId: PROJECT, outcome: 'NOT_SETTLED' },
    ]);
    assert.equal(fixture.facts.length, 0);
  }
});

test('committed terminal rows deliver one project fact and authorize only after the claim', async () => {
  const fixture = producerFixture(['DONE', 'CANCELLED']);

  const deliveries = await fixture.producer.afterCommit([PROJECT, PROJECT, null]);

  assert.deepEqual(deliveries, [{ projectId: PROJECT, outcome: 'OPENED' }]);
  assert.equal(fixture.facts.length, 1, 'duplicate project ids are one delivery attempt');
  assert.equal(fixture.facts[0].event, 'PROJECT_TASKS_SETTLED');
  assert.equal(fixture.facts[0].projectId, PROJECT);
  assert.deepEqual(
    fixture.order,
    ['tasks-read', 'wake-claimed', 'authorization-read', 'convergence', 'authorized'],
    'T2 requires claim before authorization',
  );
});

test('a disabled coordinator refuses after claim instead of opening a judgment', async () => {
  const fixture = producerFixture(['DONE'], false);

  assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
    { projectId: PROJECT, outcome: 'REFUSED' },
  ]);
  assert.deepEqual(fixture.order, [
    'tasks-read', 'wake-claimed', 'authorization-read', 'authorized',
  ]);
});
