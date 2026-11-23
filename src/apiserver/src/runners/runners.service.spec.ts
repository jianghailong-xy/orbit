import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { RunnersService } from './runners.service';

const RUNNER_ORDER = [
  { id: 'runner-1', position: 0 },
  { id: 'runner-2', position: 1 },
  { id: 'runner-3', position: 2 },
  { id: 'runner-4', position: 3 },
];

test('runner views hide the OpenCode no-key flag only when the owner can spend an Orbit key', async (t) => {
  const secretKey = process.env.PROVIDER_SECRET_KEY;
  process.env.PROVIDER_SECRET_KEY = 'test-master-key';
  t.after(() => {
    if (secretKey === undefined) delete process.env.PROVIDER_SECRET_KEY;
    else process.env.PROVIDER_SECRET_KEY = secretKey;
  });

  const openCode = { engine: 'opencode', installed: true, version: '1.19.6', auth: 'unknown' };
  const reported = { ...openCode, openCodeNoKey: true };
  const runners = RUNNER_ORDER.slice(0, 2).map(({ id }) => ({ id, status: 'OFFLINE', engines: [reported] }));
  const keys = [
    { runtime: 'claude', enabled: true, apiKeyEnc: encryptSecret('sk-ant-oat01-test') },
  ];
  const findKeys = t.mock.fn(async (args: unknown) => {
    assert.deepEqual(args, { where: { enabled: true, ownerId: 'owner-1' } });
    return keys;
  });
  const prisma = {
    runner: {
      findMany: async ({ where }: { where: { ownerId: string; id?: string } }) => {
        assert.equal(where.ownerId, 'owner-1');
        return runners.filter(({ id }) => !where.id || id === where.id);
      },
    },
    user: {
      findUnique: async (args: unknown) => {
        assert.deepEqual(args, { where: { id: 'owner-1' }, select: { role: true } });
        return { role: 'MEMBER' };
      },
    },
    modelProvider: { findMany: findKeys },
    session: { groupBy: async () => [] },
    $queryRaw: async () => [],
  } as unknown as PrismaService;
  const service = new RunnersService(prisma);

  assert.deepEqual((await service.listRunners('owner-1')).map(({ engines }) => engines), [[reported], [reported]]);
  assert.equal(findKeys.mock.callCount(), 1);

  keys.push({ runtime: 'claude', enabled: true, apiKeyEnc: encryptSecret('sk-deepseek-test') });
  assert.deepEqual((await service.listRunners('owner-1')).map(({ engines }) => engines), [[openCode], [openCode]]);
  assert.equal(findKeys.mock.callCount(), 2);
  assert.deepEqual((await service.getRunner('owner-1', 'runner-1')).engines, [openCode]);
  assert.equal(reported.openCodeNoKey, true);
});

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
          capabilities: [],
          heartbeatLeaseOwner: null,
          heartbeatDraining: null,
          availableCommands: null,
          availableSkills: null,
          planUsage: null,
          modelCatalog: null,
          runtimeDefaultModels: null,
          engines: null,
          accountNames: null,
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
    // Fix with an agent's workspace lookup (attention-fix.ts), which finds none here.
    $queryRaw: async () => [],
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
      burstConcurrent: true,
      version: true,
      lastHeartbeatAt: true,
      presence: { select: { lastBeatAt: true, backgroundJobSessionIds: true } },
      enrolledAt: true,
      position: true,
      runsAsRoot: true,
      // Why this machine is or isn't updating itself (runner-self-update.ts).
      selfUpdate: true,
      minFreeDiskMb: true,
      reposRoot: true,
      // Where `orbit register` ran (docs/first-workspace-contract.md §1).
      registerDir: true,
      capabilities: true,
      heartbeatLeaseOwner: true,
      heartbeatDraining: true,
      availableCommands: true,
      availableSkills: true,
      planUsage: true,
      modelCatalog: true,
      runtimeDefaultModels: true,
      engines: true,
      // The names its accounts were given in Orbit, laid over the report (namedRunnerEngines).
      accountNames: true,
      accountPauses: true,
      // The Defaults removed from Orbit, left out of the report (usedRunnerEngines).
      defaultRemoved: true,
      engineUpdateDismissals: true,
      attentionFixes: true,
      installStatus: true,
      installEngine: true,
      installCommand: true,
      installMessage: true,
      installMode: true,
      // The account-removal relay, beside the install one: the Providers page reads a machine's
      // refusal from here (RunnerCodexAccountRemoveState).
      accountRemoveEngine: true,
      codexAccountRemoveAccount: true,
      codexAccountRemoveStatus: true,
      codexAccountRemoveMessage: true,
      codexAccountRemoveSessions: true,
      claudeAccountSwapAccount: true,
      claudeAccountSwapStatus: true,
      claudeAccountSwapMessage: true,
      claudeAccountSwapWaiting: true,
      claudeAccountSwapForeign: true,
      // Where its Claude connection to Anthropic comes out (docs/claude-region-check-contract.md §6).
      region: true,
      // Whether it is the account's managed runner: `managed` on the row (Orbit Cloud on every client).
      managedRunner: { select: { id: true } },
    },
  });
});
