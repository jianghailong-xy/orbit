import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnersService } from './runners.service';

const RUNNER_ORDER = [
  { id: 'runner-1', position: 0 },
  { id: 'runner-2', position: 1 },
  { id: 'runner-3', position: 2 },
  { id: 'runner-4', position: 3 },
];

test('reorderRunners handles workspaceless runners, filters invalid ids, and appends omissions', async () => {
  const positions = new Map(RUNNER_ORDER.map(({ id, position }) => [id, position]));
  const findManyArgs: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; position: number }> = [];
  const prisma = {
    runner: {
      findMany: async (args: Record<string, unknown>) => {
        findManyArgs.push(args);
        const ordered = [...RUNNER_ORDER].sort(
          (a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0),
        );
        if ((args.select as Record<string, unknown>)?.name !== true) {
          return ordered.map(({ id }) => ({ id }));
        }
        return ordered.map(({ id }) => ({
          id,
          name: id,
          displayName: null,
          hostname: null,
          labels: [],
          status: 'OFFLINE',
          maxConcurrent: 1,
          version: null,
          lastHeartbeatAt: null,
          enrolledAt: new Date('2026-01-01T00:00:00.000Z'),
          position: positions.get(id),
          runsAsRoot: false,
          availableCommands: null,
          availableSkills: null,
          planUsage: null,
          modelCatalog: null,
          runtimeDefaultModels: null,
          engines: null,
          installStatus: null,
          installEngine: null,
          installCommand: null,
          installMessage: null,
          installMode: null,
        }));
      },
      update: async (args: { where: { id: string }; data: { position: number } }) => {
        updates.push({ id: args.where.id, position: args.data.position });
        positions.set(args.where.id, args.data.position);
        return { id: args.where.id, position: args.data.position };
      },
    },
    session: {
      groupBy: async () => [],
    },
    // Callback form: the reorder issues its updates one at a time, in id order, inside one
    // transaction — which is the property that keeps two opposite drags from deadlocking.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    // Deliberately no `workspace` mock: runner ordering must not depend on querying workspaces.
  } as unknown as PrismaService;
  const db = prisma;

  const result = await new RunnersService(prisma).reorderRunners('owner-1', [
    'foreign-runner',
    'runner-3',
    'runner-3',
    'stale-runner',
    'runner-1',
  ]);

  assert.deepEqual(updates, [
    { id: 'runner-1', position: 1 },
    { id: 'runner-2', position: 2 },
    { id: 'runner-3', position: 0 },
    { id: 'runner-4', position: 3 },
  ]);
  assert.deepEqual(
    updates.map(({ position }) => position).sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    result.map(({ id }) => id),
    ['runner-3', 'runner-1', 'runner-2', 'runner-4'],
  );
  assert.deepEqual(findManyArgs[0], {
    where: { ownerId: 'owner-1' },
    orderBy: [
      { position: { sort: 'asc', nulls: 'last' } },
      { enrolledAt: 'asc' },
      { id: 'asc' },
    ],
    select: { id: true },
  });
  assert.deepEqual(findManyArgs[1], {
    where: { ownerId: 'owner-1' },
    orderBy: [
      { position: { sort: 'asc', nulls: 'last' } },
      { enrolledAt: 'asc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      name: true,
      displayName: true,
      hostname: true,
      labels: true,
      status: true,
      maxConcurrent: true,
      version: true,
      lastHeartbeatAt: true,
      enrolledAt: true,
      position: true,
      runsAsRoot: true,
      availableCommands: true,
      availableSkills: true,
      planUsage: true,
      modelCatalog: true,
      runtimeDefaultModels: true,
      engines: true,
      installStatus: true,
      installEngine: true,
      installCommand: true,
      installMessage: true,
      installMode: true,
    },
  });
});
