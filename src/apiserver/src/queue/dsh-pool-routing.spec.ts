import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { QueueService } from './queue.service';

const OWNER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2030-01-01T00:00:00Z');
const RESUMES = new Date('2030-01-01T01:00:00Z');
const SESSION = {
  ownerId: OWNER,
  provider: AgentProvider.DSH,
  providerBuiltin: false,
  poolMemberProviderId: 'member-1',
  poolCodexAccountId: 'spent-account',
  poolKeyId: null,
};
const LOGINS = [{
  accountId: 'spent-account', email: null, state: 'ACTIVE', spentUntil: RESUMES, usage: null,
}];

function queueWith(overrides: Record<string, unknown> = {}) {
  const db = {
    poolApiKey: { findMany: async () => [] },
    poolUsage: { findMany: async () => [] },
  } as unknown as PrismaService;
  const queue = Object.assign(Object.create(QueueService.prototype), {
    prisma: db,
    planUsage: {},
    accountPool: async () => null,
    sharedPoolOf: async () => null,
    ...overrides,
  }) as QueueService;
  return { queue, db };
}

test('P1a colliding dsh account pool keeps manual pause and quota wakeup', async () => {
  const calls: string[] = [];
  const { queue } = queueWith({
    accountPool: async (_owner: string, slug: string) => {
      calls.push(slug);
      return {
        engine: AgentProvider.CLAUDE,
        candidates: [{
          row: { id: 'member-1', slug: 'anthropic-2' }, pausedUntil: RESUMES,
          usage: null, refused: false, usageUnreadable: false,
        }],
      };
    },
  });
  assert.deepEqual(await queue.accountPoolPausedUntil(OWNER, 'dsh', NOW), RESUMES);
  assert.deepEqual(await queue.accountPoolResumesAt(OWNER, 'dsh', NOW), RESUMES);
  assert.deepEqual(calls, ['dsh', 'dsh']);
});

test('P1a colliding dsh pool keeps the selected member pause', async () => {
  const calls: string[] = [];
  const db = {
    providerPool: { findFirst: async (args: { where: { slug: string } }) => {
      calls.push(args.where.slug);
      return { id: 'pool-1', engine: AgentProvider.CLAUDE };
    } },
    $queryRaw: async () => {
      calls.push('lock-member');
      return [{ pausedUntil: RESUMES }];
    },
  } as unknown as PrismaService;
  const { queue } = queueWith();
  assert.deepEqual(await queue.pausedPoolMemberUntil(OWNER, 'dsh', SESSION, NOW, db), RESUMES);
  assert.deepEqual(calls, ['dsh', 'lock-member']);
});

test('P1a colliding dsh pool keeps shared and login credential retries', async () => {
  const calls: string[] = [];
  const { queue, db } = queueWith({
    accountPool: async (_owner: string, slug: string) => {
      calls.push(`own:${slug}`);
      return { id: 'own-pool', engine: AgentProvider.CODEX, logins: LOGINS };
    },
    sharedPoolOf: async (_db: unknown, _owner: string, slug: string) => {
      calls.push(`shared:${slug}`);
      return { id: 'shared-pool', logins: LOGINS };
    },
  });
  assert.deepEqual(await queue.sharedPoolRetryAt(db, SESSION, NOW), RESUMES);
  assert.deepEqual(await queue.loginPoolRetryAt(db, SESSION, NOW), RESUMES);
  assert.deepEqual(calls, ['shared:dsh', 'own:dsh']);
});

test('P1a native dsh and other builtins avoid session pool reads', async () => {
  const failRead = async () => assert.fail('built-in session must not read a pool');
  const db = { providerPool: { findFirst: failRead } } as unknown as PrismaService;
  const { queue } = queueWith({ accountPool: failRead, sharedPoolOf: failRead });
  for (const provider of Object.values(AgentProvider)) {
    const session = { ...SESSION, provider, providerBuiltin: true };
    assert.equal(await queue.pausedPoolMemberUntil(OWNER, provider, session, NOW, db), null);
    assert.equal(await queue.sharedPoolRetryAt(db, session, NOW), null);
    assert.equal(await queue.loginPoolRetryAt(db, session, NOW), null);
    if (provider !== AgentProvider.DSH) {
      assert.equal(await queue.accountPoolPausedUntil(OWNER, provider, NOW), null);
      assert.equal(await queue.accountPoolResumesAt(OWNER, provider, NOW), null);
    }
  }
  // Slug-only callers still look up the reserved word, then find no historical pool.
  let reads = 0;
  const native = queueWith({ accountPool: async () => { reads++; return null; } });
  assert.equal(await native.queue.accountPoolPausedUntil(OWNER, 'dsh', NOW), null);
  assert.equal(await native.queue.accountPoolResumesAt(OWNER, 'dsh', NOW), null);
  assert.equal(reads, 2);
});

test('P1a runner quota retry uses the colliding dsh pool discriminator', async () => {
  const calls: string[] = [];
  const controller = Object.assign(Object.create(RunnerApiController.prototype), {
    queue: { accountPoolResumesAt: async (_owner: string, provider: string) => {
      calls.push(provider);
      return RESUMES;
    } },
  }) as { quotaRetryAt(...args: unknown[]): Promise<Date | null> };
  const tx = { runner: { findUnique: async () => ({ planUsage: null, engines: null }) } };
  const session = { ...SESSION, codexAccount: null };
  const retryAt = await controller.quotaRetryAt(tx, 'runner-1', session, '', null);
  assert.deepEqual(calls, ['dsh']);
  assert.ok(retryAt && retryAt >= RESUMES);
  calls.length = 0;
  assert.equal(await controller.quotaRetryAt(tx, 'runner-1', {
    ...session, providerBuiltin: true,
  }, '', null), null);
  assert.deepEqual(calls, []);
});
