import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import { EVERY_ACCOUNT, enabledAccountsOnly, ownerAccountDisabled, type ManagedRunnerEligibility } from './managed-runner-eligibility';

// The decision ManagedRunnerService asks: the rule, about an account an administrator has not
// disabled. A disabled account is never eligible, and the rule is not asked about it.

function users(rows: Record<string, { disabledAt: Date | null }>, reads: string[]) {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        reads.push(where.id);
        return rows[where.id] ?? null;
      },
    },
  } as unknown as Pick<PrismaService, 'user'>;
}

test('a disabled account is not eligible whatever the rule says, and the rule is not asked about it', async () => {
  const reads: string[] = [];
  const asked: string[] = [];
  const rule: ManagedRunnerEligibility = {
    eligible: async (ownerId) => {
      asked.push(ownerId);
      return true;
    },
  };
  const prisma = users({ enabled: { disabledAt: null }, disabled: { disabledAt: new Date('2026-10-09T08:00:00Z') } }, reads);
  const decision = enabledAccountsOnly(rule, prisma);
  assert.equal(await decision.eligible('enabled'), true);
  assert.equal(await decision.eligible('disabled'), false);
  assert.deepEqual(asked, ['enabled'], 'the rule was asked about the enabled account only');
  assert.deepEqual(reads, ['enabled', 'disabled'], 'one read of each owner');
  assert.equal(await ownerAccountDisabled(prisma, 'disabled'), true);
  assert.equal(await ownerAccountDisabled(prisma, 'enabled'), false);
  assert.equal(await ownerAccountDisabled(prisma, 'nobody'), false, 'an account that is not there is not a disabled one');
});

test('the shipped rule, every account, is asked at each call: a rule narrowed in place applies at once', async () => {
  const prisma = users({ a: { disabledAt: null }, b: { disabledAt: null } }, []);
  const decision = enabledAccountsOnly(EVERY_ACCOUNT, prisma);
  assert.equal(await decision.eligible('b'), true);
  const shipped = EVERY_ACCOUNT.eligible;
  EVERY_ACCOUNT.eligible = async (ownerId) => ownerId !== 'b';
  try {
    assert.equal(await decision.eligible('a'), true);
    assert.equal(await decision.eligible('b'), false);
  } finally {
    EVERY_ACCOUNT.eligible = shipped;
  }
});
