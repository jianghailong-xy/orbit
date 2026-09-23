import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';

const PROJECT = randomUUID();

/** One stated criterion as the producer's own query reads it back. */
interface StatedCriterion {
  text: string;
  /** The status of each task serving it; empty means nobody filed work against it. */
  servingStatuses: string[];
  /** Whether that work carries a merge receipt into the default branch. */
  landed: boolean;
}

function producerFixture(
  statuses: string[],
  coordinatorEnabled = true,
  criteria: StatedCriterion[] = [],
  options: { tallyMissesOpenWork?: boolean } = {},
) {
  const order: string[] = [];
  const facts: Array<{ event: string; projectId: string; detail?: unknown }> = [];
  const prisma = {
    // The 0282 tally, as the triggers maintain it: whatever the statuses say, unless the fixture
    // is asked for the one shape the producer has to survive — a tally that has fallen behind.
    projectTaskStatusCount: {
      findFirst: async (args: { where: { status: { notIn: string[] } } }) => {
        order.push('tally-read');
        if (options.tallyMissesOpenWork) return null;
        const open = statuses.find((status) => !args.where.status.notIn.includes(status));
        return open ? { status: open } : null;
      },
    },
    task: {
      // Honors the filter it is handed rather than re-deciding which statuses are terminal: the
      // producer's own `SETTLED_TASK_STATUSES` is what the probe must be asking about.
      findFirst: async (args: { where: { status: { notIn: string[] } } }) => {
        order.push('unsettled-probe');
        const unsettled = statuses.find((status) => !args.where.status.notIn.includes(status));
        return unsettled ? { id: randomUUID() } : null;
      },
      findMany: async () => {
        order.push('tasks-read');
        return statuses.map((status, index) => ({ id: randomUUID(), status }));
      },
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async () => {
        order.push('criteria-read');
        return criteria.map((criterion) => ({
          id: randomUUID(),
          text: criterion.text,
          servingTasks: criterion.servingStatuses.map((status, index) => ({
            id: randomUUID(),
            title: `serving ${index + 1}`,
            status,
            codeless: false,
            mergeReceipts: criterion.landed
              ? [{ result: 'MERGED', targetBranch: 'main' }]
              : [],
            // Every task here ran a branch and the line has no answer about any of them: what this
            // fixture is about is the receipts, and the landing fold reads an empty record of the
            // line's own as "nothing said", not as "nothing to land".
            integrationJobs: [],
          })),
        }));
      },
    },
    // The landing lane asks a project for its binding, which says which branches its receipts have
    // to name. This fixture binds no repository, so it reads as a project without one — main or
    // master, which is what the receipts above already name.
    projectCodebase: { findFirst: async () => null },
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
  /** The other terminal, recording what it was handed rather than writing to a conversation. */
  const carded: typeof facts = [];
  const deliveries = {
    deliver: async (fact: (typeof facts)[number], authorize: (
      fact: (typeof facts)[number],
      claim: { wakeId: string; idempotencyKey: string },
    ) => Promise<{ allowed: boolean; refusalCode?: string }>) => {
      order.push('card-claimed');
      carded.push(fact);
      const decision = await authorize(fact, { wakeId: randomUUID(), idempotencyKey: 'key' });
      order.push('authorized');
      return decision.allowed
        ? {
            outcome: 'DELIVERED', wakeId: randomUUID(), idempotencyKey: 'key',
            sessionId: randomUUID(), clientTurnId: randomUUID(),
          }
        : {
            outcome: 'REFUSED', wakeId: randomUUID(), idempotencyKey: 'key',
            refusalCode: decision.refusalCode!,
          };
    },
  };
  return {
    producer: new ProjectTasksSettledProducer(
      prisma as never,
      judgments as never,
      convergence as never,
      deliveries as never,
    ),
    facts,
    carded,
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

test('one unfinished row answers the roster question, so the whole project is not read', async () => {
  // The project that pays for this is the one with 109,874 rows in it, and the read it must not
  // make is the one scoped to the whole project. `DONE, OPEN, DONE` is the common shape: the
  // probe finds an unfinished row without walking the settled ones around it.
  const fixture = producerFixture(['DONE', 'OPEN', 'DONE']);

  assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
    { projectId: PROJECT, outcome: 'NOT_SETTLED' },
  ]);
  assert.deepEqual(
    fixture.order,
    ['tally-read', 'unsettled-probe'],
    'the roster read and the criteria read are both behind the probe, and neither is reached',
  );
});

test('a tally that has fallen behind cannot decide: the rows are still read', async () => {
  // The one way a derived gate can be wrong in the direction that loses a wake. It cannot lose
  // one here: a tally with no open work in it is not an answer, it is a reason not to ask the
  // cheap question — the roster read below still runs and still sets the answer.
  const fixture = producerFixture(['DONE', 'OPEN'], true, [], { tallyMissesOpenWork: true });

  assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
    { projectId: PROJECT, outcome: 'NOT_SETTLED' },
  ]);
  assert.deepEqual(
    fixture.order,
    ['tally-read', 'tasks-read', 'criteria-read'],
    'the probe is skipped on the tally\'s word, and the rows decide instead',
  );
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
    ['tally-read', 'tasks-read', 'criteria-read', 'wake-claimed', 'authorization-read',
      'convergence', 'authorized'],
    'T2 requires claim before authorization, and the criteria read is not an authorization',
  );
});

test('a disabled coordinator refuses after claim instead of opening a judgment', async () => {
  const fixture = producerFixture(['DONE'], false);

  assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
    { projectId: PROJECT, outcome: 'REFUSED' },
  ]);
  assert.deepEqual(fixture.order, [
    'tally-read', 'tasks-read', 'criteria-read', 'wake-claimed', 'authorization-read',
    'authorized',
  ]);
});

test('a settled project whose criteria are all satisfied and landed is carded, not judged', async () => {
  const fixture = producerFixture(['DONE', 'CANCELLED'], true, [
    { text: '路由行为符合设计', servingStatuses: ['DONE'], landed: true },
    { text: '全量服务测试通过', servingStatuses: ['DONE', 'DONE'], landed: true },
  ]);

  assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
    { projectId: PROJECT, outcome: 'DELIVERED' },
  ]);
  assert.equal(fixture.facts.length, 0, 'the confirmation card opened a judgment session');
  assert.equal(fixture.carded.length, 1);
  assert.equal(
    fixture.carded[0].event, 'PROJECT_ACCEPTANCE_LANDED',
    'the card rode PROJECT_TASKS_SETTLED, whose key the judgment branch spends first when a '
    + 'criterion is still off the branch — so the receipt that arrives later finds it gone',
  );
  assert.deepEqual(
    (fixture.carded[0].detail as { criteria: Array<{ satisfied: boolean; landing: string }> })
      .criteria.map((criterion) => [criterion.satisfied, criterion.landing]),
    [[true, 'LANDED'], [true, 'LANDED']],
    'the card carries what it is asking about',
  );
  assert.deepEqual(
    fixture.order,
    ['tally-read', 'tasks-read', 'criteria-read', 'card-claimed', 'authorization-read',
      'convergence', 'authorized'],
    'the card is claimed before it is authorized, exactly as the judgment is',
  );
});

/**
 * The clause the settled fact alone cannot supply. Each case moves ONE dimension away from the
 * carded fixture above and asserts the fact goes back to the judgment branch — so "no card" is a
 * statement about that dimension rather than about a producer that never cards anything.
 */
for (const [why, criteria] of [
  ['a criterion whose work is still on a branch', [
    { text: '路由行为符合设计', servingStatuses: ['DONE'], landed: true },
    { text: '全量服务测试通过', servingStatuses: ['DONE'], landed: false },
  ]],
  ['a criterion no work serves', [
    { text: '路由行为符合设计', servingStatuses: ['DONE'], landed: true },
    { text: '全量服务测试通过', servingStatuses: [], landed: true },
  ]],
  ['a criterion whose serving work was cancelled rather than done', [
    { text: '路由行为符合设计', servingStatuses: ['DONE', 'CANCELLED'], landed: true },
  ]],
  ['a project that states no criteria at all', []],
] as Array<[string, StatedCriterion[]]>) {
  test(`${why} gets no card`, async () => {
    const fixture = producerFixture(['DONE', 'CANCELLED'], true, criteria);

    assert.deepEqual(await fixture.producer.afterCommit([PROJECT]), [
      { projectId: PROJECT, outcome: 'OPENED' },
    ]);
    assert.deepEqual(fixture.carded, [], 'the project was asked to confirm an unmet ruler');
    assert.equal(fixture.facts.length, 1, 'and the fact was not spent on the judgment either');
  });
}
