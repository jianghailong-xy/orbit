import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { RunStatus as SharedRunStatus, type RunFinalizeRequest } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import { noSessionRequests } from '../test-support/prisma-transaction-double';

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
  // Each read of the runner's row: the quota retry's, and the refused sign-in's look for another account.
  const runnerReads: number[] = [];
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
    sessionRequest: noSessionRequests(),
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
    runner: {
      findUnique: async () => {
        runnerReads.push(1);
        return { planUsage: quota.planUsage ?? null, engines: quota.engines ?? null };
      },
    },
    // Read for a Codex run's quota refusal: its workspace says which account the run spent.
    workspace: { findUnique: async () => quota.workspace ?? null },
    // The drain returns any item turn still queued on the conversation it is ending; this one has
    // none, so it writes nothing (contract §4.4 X-D5).
    projectOpenItemDelivery: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    projectOpenItem: { updateMany: async () => ({ count: 0 }) },
    // What a queued wake turn the drain answers carried (wake-turn-withdraw.ts). No fixture here files
    // one, so it settles nothing.
    backgroundJobWake: { deleteMany: async () => ({ count: 0 }) },
    sessionScheduledWakeup: { findMany: async () => [] },
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
    runnerReads,
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
        { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
        { id: work, name: 'Work', home: '/root/.orbit/codex-accounts/3fa91c2e', codexHome: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes' },
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

/**
 * The failure's kind on the session (docs/routing-account-health-design.md §5.1, §10 Mixed versions): a runner that
 * classifies its failure has the kind stored beside `error`, in the same write; an older runner sends no kind, and its
 * failure is stored with nulls and decided through the legacy markers exactly as before.
 */
const CURSOR_PAYMENT_ERROR =
  'Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.';

test('a new runner: the failure kind, its scope, the provider words and the admission flag are stored with the error', async () => {
  const h = makeController({ numTurns: 0 });

  await finalize(h.controller, {
    status: SharedRunStatus.FAILED,
    error: CURSOR_PAYMENT_ERROR,
    failure: { kind: 'ACCOUNT_ACTION_REQUIRED' as never, said: 'Add a payment method to continue' },
    admission: true,
  });

  assert.equal(h.updates[0].error, CURSOR_PAYMENT_ERROR);
  assert.equal(h.updates[0].failureKind, 'ACCOUNT_ACTION_REQUIRED');
  assert.equal(h.updates[0].failureScope, null, 'no scope is the whole account');
  assert.equal(h.updates[0].failureSaid, 'Add a payment method to continue');
  assert.equal(h.updates[0].admissionFailure, true);
  assert.equal(h.updates[0].retryAt, undefined, 'an account action is no quota wait');
});

test('an old runner: no kind is stored and a quota refusal is still read from its words', async () => {
  const h = makeController({ numTurns: 0 });

  await finalize(h.controller, { status: SharedRunStatus.FAILED, error: QUOTA_ERROR });

  assert.equal(h.updates[0].failureKind, null);
  assert.equal(h.updates[0].admissionFailure, null, 'an older runner did not say');
  assert.ok(h.updates[0].retryAt instanceof Date, 'the legacy marker still arms the quota retry');
});

test("the runner's kind decides over the words: a sign-in sentence classified as a dropped connection is no sign-in", async () => {
  const h = makeController({ numTurns: 0, provider: 'claude', workspaceId: 'workspace-1' });

  await finalize(h.controller, {
    status: SharedRunStatus.FAILED,
    error: SIGNED_OUT_ERROR,
    failure: { kind: 'TRANSPORT' as never },
    admission: true,
  });

  assert.equal(h.updates[0].failureKind, 'TRANSPORT');
  assert.equal(h.updates[0].retryAt, undefined);
});

test('a kind this server does not know is stored as none and read through the markers', async () => {
  const h = makeController({ numTurns: 0 });

  await finalize(h.controller, {
    status: SharedRunStatus.FAILED,
    error: QUOTA_ERROR,
    failure: { kind: 'A_NEWER_KIND' as never },
    admission: false,
  });

  assert.equal(h.updates[0].failureKind, null);
  assert.equal(h.updates[0].admissionFailure, false);
  assert.ok(h.updates[0].retryAt instanceof Date, 'the words still say a quota');
});

test('a run that did not fail stores no failure, whatever the runner sent', async () => {
  const h = makeController({ numTurns: 2 });

  await finalize(h.controller, {
    status: SharedRunStatus.SUCCEEDED,
    failure: { kind: 'CAPACITY' as never },
    admission: true,
  });

  assert.equal(h.updates[0].failureKind, null);
  assert.equal(h.updates[0].admissionFailure, null);
});

/**
 * The refused sign-in path keeps what it matched before the kinds (review of revision 1, point 3): with no kind it
 * is the runtime's "Failed to authenticate" alone (isAuthErrorText, the old `isAuthErrorText(dto.error)` here), so a
 * Codex "Not logged in" — which only the SubAgent move ever read as a sign-in — still takes no sign-in path. A
 * runner's CREDENTIAL_REFUSED takes it whatever the words.
 */
test('finalize reads a refused sign-in as it did: "Failed to authenticate" alone, unless the runner says so', async () => {
  const signInLookups = async (error: string, failure?: { kind: string }) => {
    const h = makeController({ numTurns: 0, provider: 'codex' });
    await finalize(h.controller, { status: SharedRunStatus.FAILED, error, ...(failure ? { failure: failure as never } : {}) });
    return h.runnerReads.length;
  };

  assert.equal(await signInLookups(SIGNED_OUT_ERROR), 1, "the runtime's sign-in failure looks for another account");
  assert.equal(await signInLookups('Not logged in. Run codex login.'), 0, 'an old runner\'s "Not logged in" is no sign-in here');
  assert.equal(await signInLookups('OAuth session expired'), 0, 'nor is an unwrapped "OAuth session expired"');
  assert.equal(await signInLookups('Not logged in. Run codex login.', { kind: 'CREDENTIAL_REFUSED' }), 1,
    "the runner's kind decides over the words");
  assert.equal(await signInLookups(SIGNED_OUT_ERROR, { kind: 'TRANSPORT' }), 0, 'a dropped connection is no sign-in');
});
