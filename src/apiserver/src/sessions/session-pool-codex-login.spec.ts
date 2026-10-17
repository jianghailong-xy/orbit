import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { noSessionRequests } from '../test-support/prisma-transaction-double';

const NOW = new Date();
const ACCOUNT = 'acct-RawOpenAiId-XYZZ';
const POOL_SLUG = 'my-codex';

/** The pool's row for the account, in the columns `sessionPoolCodexLogin` reads — no token among them. */
function loginRow() {
  return {
    poolId: '44444444-4444-4444-8444-444444444444',
    accountId: ACCOUNT,
    userId: '55555555-5555-4555-8555-555555555555',
    email: 'jianghailong.rd@gmail.com',
    plan: 'plus',
    state: 'ACTIVE',
    lastError: null,
    expiresAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
    createdAt: new Date('2026-09-30T10:00:00.000Z'),
    usage: {
      provider: 'codex',
      primary: { utilization: 23, resetsAt: null, windowDurationMins: 300 },
      secondary: { utilization: 100, resetsAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(), windowDurationMins: 10080 },
    },
    spentUntil: null,
    pausedUntil: null,
  };
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: RunStatus.RUNNING,
    title: 'Pool session',
    createdAt: NOW,
    lastTurnAt: NOW,
    startedAt: NOW,
    numTurns: 1,
    costUsd: 0,
    error: null,
    endReason: null,
    cancelRequestedAt: NOW,
    runtimeSessionId: 'runtime-1',
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    source: 'user',
    // A Codex pool's session, on the engine it was recorded on (migration 0414).
    engine: 'codex',
    provider: POOL_SLUG,
    model: null,
    permissionMode: null,
    effort: null,
    lastAssistantText: null,
    lastToolUse: null,
    lastUserText: null,
    mergeStatus: null,
    pinnedAt: null,
    tags: [],
    tagLinks: [],
    runningBgCount: 0,
    runningBgShells: [],
    runningBgJobs: [],
    runningBgJobActivity: {},
    runningSubagentCount: 0,
    children: [],
    workspaceId: null,
    workspaceName: null,
    workspaceModel: null,
    workspace: null,
    runnerId: '22222222-2222-4222-8222-222222222222',
    runnerName: 'runner',
    runnerStatus: 'ONLINE',
    runnerLastHeartbeatAt: NOW,
    assignedRunnerId: '22222222-2222-4222-8222-222222222222',
    assignedRunner: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'runner',
      status: 'ONLINE',
      lastHeartbeatAt: NOW,
      capabilities: [] as string[],
    },
    taskId: null,
    taskTitle: null,
    projectId: null,
    projectTitle: null,
    poolCodexAccountId: null,
    poolMemberProviderId: null,
    poolKeyId: null,
    ...over,
  };
}

/** A SessionsService whose session read names the pool's account, and whose login read answers the
 *  way the database would — only for THIS session's account and pool, never for another's. */
function service(answer: ReturnType<typeof loginRow> | null, over: Record<string, unknown> = {}) {
  const prisma = {
    $queryRaw: async () => [{ projectMembership: null }],
    session: {
      findFirst: async () => sessionRow(over),
      findMany: async () => [],
    },
    poolCodexLogin: {
      findFirst: async (args: { where: { accountId: string; person: { pool: { slug: string } } } }) =>
        args.where.accountId === ACCOUNT && args.where.person.pool.slug === POOL_SLUG ? answer : null,
    },
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    task: { findMany: async () => [] },
    sessionRequest: noSessionRequests(),
    projectOpenItem: { findMany: async () => [] },
  } as never;
  return new SessionsService(prisma, {} as never, {} as never);
}

test('the session detail names the ChatGPT account it runs on, masked — never its id', async () => {
  const detail = await service(loginRow(), { poolCodexAccountId: ACCOUNT }).get('owner-1', '11111111-1111-4111-8111-111111111111');

  assert.deepEqual(detail.poolCodexLogin, {
    state: 'ACTIVE',
    pausedUntil: null,
    email: 'jianghailong.rd@gmail.com',
    plan: 'plus',
    // `…XYZZ`: the account's last four, the only form an id leaves in (codex-login.ts maskedAccount).
    fingerprint: '…XYZZ',
    lastError: null,
    expiresAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    linkedAt: '2026-09-30T10:00:00.000Z',
    userId: '55555555-5555-4555-8555-555555555555',
    usage: loginRow().usage,
    usageUnavailable: null,
    spentUntil: null,
  });
  // The raw id never leaves: not as a field, and not anywhere in the serialized payload.
  assert.equal('accountId' in (detail.poolCodexLogin ?? {}), false);
  assert.equal(JSON.stringify(detail).includes(ACCOUNT), false);
  // The raw column is still stripped, as it has always been.
  assert.equal('poolCodexAccountId' in detail, false);
});

test('a session that records no account carries none, and a session off the pool carries none', async () => {
  const without = await service(loginRow()).get('owner-1', '11111111-1111-4111-8111-111111111111');
  assert.equal(without.poolCodexLogin, null);

  // The account was taken out of the pool since: nothing is guessed, the next claim chooses again.
  const moved = await service(null, { poolCodexAccountId: ACCOUNT }).get('owner-1', '11111111-1111-4111-8111-111111111111');
  assert.equal(moved.poolCodexLogin, null);
});
