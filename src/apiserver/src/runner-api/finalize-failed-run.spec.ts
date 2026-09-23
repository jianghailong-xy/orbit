import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunStatus as SharedRunStatus, type RunFinalizeRequest } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * What finalize does with a run that failed: whether its checkout is worth keeping, and whether
 * the failure names a moment it could be re-sent. Both are decided from the locked snapshot plus
 * what the runner reports, so they live here rather than in the locking spec next door.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const QUOTA_ERROR = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";
const SIGNED_OUT_ERROR =
  'Failed to authenticate: Claude Code is installed on this runner but not signed in — sign in from here, or run `claude auth login` on that machine.';

function makeController(
  current: { numTurns: number; retryAt?: Date | null; provider?: string; workspaceId?: string },
  pendingCurrentWork = false,
  /** What the runner reports, and the session's workspace, for a refusal only the snapshot can time. */
  quota: { planUsage?: unknown; engines?: unknown; workspace?: { env: unknown; codexAccount: string | null } } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const turnUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    session: {
      findUniqueOrThrow: async () => ({
        id: SESSION_ID,
        assignedRunnerId: RUNNER_ID,
        status: RunStatus.RUNNING,
        taskId: null,
        cancelRequestedAt: null,
        endReason: null,
        completedAt: null,
        archivedAt: null,
        deletedAt: null,
        provider: current.provider ?? 'claude',
        workspaceId: current.workspaceId ?? null,
        retryAt: current.retryAt ?? null,
        numTurns: current.numTurns,
      }),
      // Read by the reaper, which needs to know which runner-hosted jobs are still up before it
      // decides whether a card raised by one can still be answered (`approval.background_job_id`).
      // This session has none: every card here is the turn's, and collected with it.
      findUnique: async () => ({ runningBgShells: [] }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
    },
    conversationTurn: { updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      turnUpdates.push(args);
      return { count: 1 };
    },
      findFirst: async () => null,
      findMany: async () => pendingCurrentWork
        ? [{ id: 'current-work-1', targetTurnId: 'target-1', status: 'IN_FLIGHT' }]
        : [],
    },
    // The reaper that runs at every boundary where a turn ends: a tool call whose asking turn is
    // over can never be answered, so it stops being a question there
    // (`sessions/abandoned-approvals.ts`). These fixtures raise no approvals, so it collects none.
    approval: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
    // Only read when the terminal message is a quota refusal; unless a test says otherwise this
    // runner reports no snapshot, so the reset moment has to come from the message itself.
    runner: { findUnique: async () => ({ planUsage: quota.planUsage ?? null, engines: quota.engines ?? null }) },
    // Read for a Codex run's quota refusal: its workspace says which account the run spent.
    workspace: { findUnique: async () => quota.workspace ?? null },
    // The drain returns any item turn still queued on the conversation it is ending; this one has
    // none, so it writes nothing (contract §4.4 X-D5).
    projectOpenItemDelivery: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    projectOpenItem: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    publish: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    updates,
    turnUpdates,
  };
}

function finalize(
  controller: RunnerApiController,
  dto: Partial<RunFinalizeRequest> & { status: SharedRunStatus },
) {
  return controller.finalize({ id: RUNNER_ID }, SESSION_ID, dto as RunFinalizeRequest);
}

test('a run that failed before its first turn releases its checkout', async () => {
  const h = makeController({ numTurns: 0 });

  const response = await finalize(h.controller, {
    status: SharedRunStatus.FAILED,
    error: SIGNED_OUT_ERROR,
    changedFiles: [],
  });

  // Nothing ran, so the branch holds only the fork point — the checkout is a second copy of the
  // repo standing in for no work at all. The branch survives, so a resume can re-create it.
  assert.equal(response.keepCheckout, false);
});

test('a failure that produced work keeps its checkout', async () => {
  const cases: Array<{ name: string; numTurns: number; dto: Partial<RunFinalizeRequest> }> = [
    { name: 'a later turn failed', numTurns: 4, dto: { changedFiles: [] } },
    {
      name: 'the first turn never completed but a shell changed files',
      numTurns: 0,
      dto: { changedFiles: [{ path: 'src/main.ts', additions: 3, deletions: 1, status: 'modified' }] },
    },
    { name: 'an older runner reported no diff at all', numTurns: 2, dto: {} },
  ];
  for (const { name, numTurns, dto } of cases) {
    const h = makeController({ numTurns });

    const response = await finalize(h.controller, { status: SharedRunStatus.FAILED, ...dto });

    assert.equal(response.keepCheckout, true, name);
  }
});

test('a zero-turn cancel keeps its checkout — only failures release one', async () => {
  const h = makeController({ numTurns: 0 });

  const response = await finalize(h.controller, {
    status: SharedRunStatus.CANCELLED,
    changedFiles: [],
  });

  assert.equal(response.keepCheckout, true);
});

/**
 * A quota refusal at startup is the CLI's last words, not an assistant reply, so the event path
 * that arms the auto-retry never sees it. Without this the only record of when the work could
 * resume is prose inside `error`, and a caller wanting to back off to that moment has to parse it
 * back out of the sentence.
 */
test('a run the quota killed at startup arms the retry from its terminal message', async () => {
  const h = makeController({ numTurns: 0 });

  await finalize(h.controller, { status: SharedRunStatus.FAILED, error: QUOTA_ERROR });

  const armed = h.updates[0].retryAt as Date;
  assert.ok(armed instanceof Date, 'the reset moment is armed on the session');
  assert.ok(armed.getTime() > Date.now(), 'and it is in the future');
});

test('an ordinary failure arms nothing', async () => {
  const h = makeController({ numTurns: 0 });

  await finalize(h.controller, { status: SharedRunStatus.FAILED, error: SIGNED_OUT_ERROR });

  assert.equal(h.updates[0].retryAt, undefined, 'signing in is a human action, not a wait');
});

test('a retry armed while the session was running is never overwritten at the end', async () => {
  const armedAtIngestion = new Date(Date.now() + 3_600_000);
  const h = makeController({ numTurns: 3, retryAt: armedAtIngestion });

  await finalize(h.controller, { status: SharedRunStatus.FAILED, error: QUOTA_ERROR });

  assert.equal(h.updates[0].retryAt, undefined, 'ingestion knew more than the last words do');
});

test("a Codex run the quota killed at startup is armed by the quota of the account its workspace picked", async () => {
  // Codex's refusal names no moment, so the runner's snapshot is all there is to arm by: Default's
  // and Work's, one runner with both accounts.
  const work = '3fa91c2e';
  const engines = [
    {
      engine: 'codex',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', codexHome: '/root/.codex', auth: 'yes' },
        { id: work, name: 'Work', codexHome: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes' },
      ],
    },
  ];
  const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const spent = { utilization: 100, resetsAt };
  const room = { utilization: 8, resetsAt };
  const armed = async (planUsage: unknown, codexAccount: string | null) => {
    const h = makeController({ numTurns: 0, provider: 'codex', workspaceId: 'workspace-1' }, false, {
      planUsage,
      engines,
      workspace: { env: null, codexAccount },
    });
    await finalize(h.controller, {
      status: SharedRunStatus.FAILED,
      error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    });
    return h.updates[0].retryAt;
  };

  const defaultSpent = { provider: 'codex', primary: spent, accounts: { [work]: { provider: 'codex', primary: room } } };
  assert.equal(await armed(defaultSpent, work), undefined, "Default's spent quota names no moment for a run on Work");
  assert.ok((await armed(defaultSpent, null)) instanceof Date, 'a run on Default is armed for Default’s reset');
  const workSpent = { provider: 'codex', primary: room, accounts: { [work]: { provider: 'codex', primary: spent } } };
  assert.ok((await armed(workSpent, work)) instanceof Date, 'a run on Work is armed for Work’s reset');
});

test('runner-loss finalize writes an IN_FLIGHT CURRENT_WORK UNCONFIRMED receipt before blanket drain', async () => {
  const h = makeController({ numTurns: 1 }, true);

  await finalize(h.controller, { status: SharedRunStatus.FAILED, error: 'provider process died' });

  const receipt = h.turnUpdates.find((write) => write.data.deliveryStatus === 'UNCONFIRMED');
  assert.equal(receipt?.data.deliveryFailureCode, 'CURRENT_WORK_SESSION_FINALIZED');
  assert.equal(receipt?.data.status, 'ANSWERED');
  assert.match(String(receipt?.data.deliveryFailureReason), /could not be confirmed/i);
  assert.deepEqual((receipt?.where.status as { in: string[] }).in, ['PENDING', 'IN_FLIGHT']);
  assert.ok(
    h.turnUpdates.findIndex((write) => write === receipt)
      < h.turnUpdates.findIndex((write) => write.data.deliveryStatus === undefined),
    'the durable receipt must be written before the blanket ANSWERED drain',
  );
});
